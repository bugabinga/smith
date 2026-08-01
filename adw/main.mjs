#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  digestJson,
  mapReconciliationIntents,
  planReconciliation,
  reduceAssessments,
  validateAssessment,
  validateAssessmentArtifact,
  validateDecision,
  validateOperation,
  validateSnapshot,
  validateVerification,
} from "./core.mjs";
import { createApplyReceipt, createDefaultGitHub, createDryRunGitHub, normalizeEvent, operationCapabilities } from "./github.mjs";
import { installProvider, invokeProvider, PROVIDER_PINS } from "./providers.mjs";
import { controlAuthority, planAudit, reduceControlArtifact, reduceRoleArtifact, reduceStatusArtifact, resolveAuthority, role, validateRolePayload } from "./roles.mjs";
import { createDefaultVcs, verifyPatch } from "./vcs.mjs";

const MAX_INPUT = 262_144;
const MAX_PATCH = 1_048_576;
const MAX_BUNDLE = 1_073_741_824;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_.:/-]+$/;
const HARDENING = Object.freeze({ hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false });

export const ARTIFACT_LAYOUT = Object.freeze({
  snapshot: Object.freeze(["snapshot.json", "snapshot.sha256"]),
  assessment: Object.freeze(["envelope.json", "envelope.sha256", "change.patch?", "change.patch.sha256?"]),
  decision: Object.freeze(["decision.json", "decision.sha256", "change.patch?", "change.patch.sha256?"]),
  verification: Object.freeze(["verification.json", "verification.sha256", "change.patch?", "change.patch.sha256?"]),
  applyResult: Object.freeze(["result.json", "result.sha256"]),
  source: Object.freeze(["control/**", "target.bundle", "manifest.json", "manifest.sha256"]),
});

export async function readBounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT) throw new AdwError("input", "input is oversized");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString();
}

function inputError(message) {
  throw new AdwError("input", message);
}

function parse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT) inputError("input is missing or oversized");
  try {
    return JSON.parse(text);
  } catch {
    inputError("input is not JSON");
  }
}

function exactObject(value, keys, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) inputError(`${name} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) inputError(`${name} has invalid fields`);
}

function environmentPath(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) inputError(`${name} is invalid`);
  return value;
}

function environmentId(env, name, pattern = ID) {
  const value = env?.[name];
  if (typeof value !== "string" || !pattern.test(value)) inputError(`${name} is invalid`);
  return value;
}

async function pathIdentity(path, missing = false) {
  const lexicalParent = dirname(path);
  const parent = await realpath(lexicalParent).catch(() => inputError("artifact parent is invalid"));
  if (parent !== lexicalParent) inputError("artifact parent is a symlink");
  const candidate = resolve(parent, basename(path));
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) inputError("artifact path is a symlink");
    const identity = await realpath(path);
    if (identity !== path) inputError("artifact path is not canonical");
    return identity;
  } catch (error) {
    if (error instanceof AdwError) throw error;
    if (!missing || error?.code !== "ENOENT") inputError("artifact path is invalid");
    return candidate;
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directoryIdentity(path, message = "artifact directory is invalid") {
  const before = await lstat(path).catch(() => inputError(message));
  if (!before.isDirectory() || before.isSymbolicLink()) inputError(message);
  const identity = await realpath(path).catch(() => inputError(message));
  if (identity !== path) inputError(message);
  const after = await lstat(path).catch(() => inputError(message));
  if (!after.isDirectory() || after.isSymbolicLink() || !sameInode(before, after)) inputError("artifact directory changed");
  return { path, stat: after };
}

async function assertDirectoryIdentity(claim) {
  const current = await directoryIdentity(claim.path);
  if (!sameInode(current.stat, claim.stat)) inputError("artifact directory changed");
}

async function executableIdentity(path, name) {
  if (!isAbsolute(path) || resolve(path) !== path) inputError(`${name} is invalid`);
  const parent = await directoryIdentity(dirname(path), `${name} parent is invalid`);
  const target = await realpath(path).catch(() => inputError(`${name} is invalid`));
  const before = await lstat(target).catch(() => inputError(`${name} is invalid`));
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o111) === 0) inputError(`${name} is invalid`);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || !sameInode(before, current)) inputError(`${name} changed`);
  } catch (error) {
    if (error instanceof AdwError) throw error;
    inputError(`${name} is invalid`);
  } finally { await handle?.close(); }
  await assertDirectoryIdentity(parent);
  return target;
}

async function separated(paths, boundaries = []) {
  const resolvedPaths = [];
  for (const path of paths) resolvedPaths.push(await pathIdentity(path, true));
  const resolvedBoundaries = [];
  for (const path of boundaries) resolvedBoundaries.push(await pathIdentity(path));
  for (let i = 0; i < resolvedPaths.length; i++) {
    for (let j = i + 1; j < resolvedPaths.length; j++) if (pathsOverlap(resolvedPaths[i], resolvedPaths[j])) inputError("artifact paths overlap");
    for (const boundary of resolvedBoundaries) if (pathsOverlap(resolvedPaths[i], boundary)) inputError("artifact path overlaps checkout");
  }
}

async function readRegular(path, maximum, missing = false) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) inputError("artifact member is not a regular file");
    if (before.size > maximum) inputError("artifact member is oversized");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || current.size !== before.size || current.dev !== before.dev || current.ino !== before.ino) inputError("artifact member changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maximum) inputError("artifact member is oversized");
    if (after.size !== current.size || after.dev !== current.dev || after.ino !== current.ino || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) inputError("artifact member changed");
    return bytes;
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    if (error instanceof AdwError) throw error;
    inputError("artifact member cannot be read");
  } finally {
    await handle?.close();
  }
}

async function exactDirectory(directory, alternatives, existingClaim = null) {
  const claim = existingClaim ?? await directoryIdentity(directory);
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true })).map(entry => {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) inputError("artifact contains an invalid member");
      return entry.name;
    }).sort();
  } catch (error) {
    if (error instanceof AdwError) throw error;
    inputError("artifact directory cannot be read");
  }
  await assertDirectoryIdentity(claim);
  if (!alternatives.some(expected => entries.length === expected.length && entries.every((name, index) => name === [...expected].sort()[index]))) inputError("artifact tree is not exact");
  return entries;
}

async function digestDocument(directory, file, hashFile) {
  const bytes = await readRegular(join(directory, file), MAX_INPUT);
  const hashBytes = await readRegular(join(directory, hashFile), 65);
  const hash = hashBytes.toString("utf8");
  if (!DIGEST.test(hash.trim()) || hash !== `${hash.trim()}\n` || digestBytes(bytes) !== hash.trim()) inputError("artifact digest does not match");
  return bytes;
}

function documentNames(type) {
  return { snapshot: "snapshot", assessment: "envelope", decision: "decision", verification: "verification", applyResult: "result" }[type];
}

export async function readTransportArtifact(type, directory, { allowMalformed = false } = {}) {
  const document = documentNames(type);
  if (!document || !isAbsolute(directory)) inputError("artifact type or path is invalid");
  const directoryClaim = await directoryIdentity(directory);
  const base = [`${document}.json`, `${document}.sha256`];
  const patched = [...base, "change.patch", "change.patch.sha256"];
  const entries = await exactDirectory(directory, type === "snapshot" || type === "applyResult" ? [base] : [base, patched], directoryClaim);
  const bytes = await digestDocument(directory, `${document}.json`, `${document}.sha256`);
  let patchBytes;
  if (entries.includes("change.patch")) {
    patchBytes = await readRegular(join(directory, "change.patch"), MAX_PATCH);
    const patchHash = (await readRegular(join(directory, "change.patch.sha256"), 65)).toString("utf8");
    if (!DIGEST.test(patchHash.trim()) || patchHash !== `${patchHash.trim()}\n` || digestBytes(patchBytes) !== patchHash.trim()) inputError("patch digest does not match");
  }
  let value;
  try {
    value = parse(bytes.toString("utf8"));
    if (!canonicalBytes(value).equals(bytes)) inputError("artifact JSON is not canonical");
  } catch (error) {
    if (allowMalformed && error instanceof AdwError) {
      await assertDirectoryIdentity(directoryClaim);
      return Object.freeze({ malformed: true });
    }
    throw error;
  }
  try {
    if (type === "snapshot") value = validateSnapshot(value);
    else if (type === "assessment") {
      if (value && Object.hasOwn(value, "patch") && (value.patch === null) !== (patchBytes === undefined)) inputError("assessment patch sidecar is invalid");
      value = validateAssessmentArtifact({ assessment: value, patchBytes });
    }
    else if (type === "decision") {
      value = validateDecision(value);
      if ((value.patch === null) !== (patchBytes === undefined)) inputError("decision patch sidecar is invalid");
      if (value.patch && (value.patch.size !== patchBytes.length || value.patch.digest !== digestBytes(patchBytes))) inputError("decision patch sidecar does not match");
    } else if (type === "verification") {
      value = validateVerification(value);
      if ((value.patch === null) !== (patchBytes === undefined)) inputError("verification patch sidecar is invalid");
      if (value.patch && (value.patch.size !== patchBytes.length || value.patch.digest !== digestBytes(patchBytes))) inputError("verification patch sidecar does not match");
    }
  } catch (error) {
    if (allowMalformed && error instanceof AdwError && !String(error.message).includes("sidecar")) {
      await assertDirectoryIdentity(directoryClaim);
      return Object.freeze({ malformed: true });
    }
    throw error;
  }
  await assertDirectoryIdentity(directoryClaim);
  return Object.freeze({ value, bytes, patchBytes });
}

async function outputDirectory(directory) {
  const identity = await pathIdentity(directory, true);
  const parentClaim = await directoryIdentity(dirname(identity), "artifact parent is invalid");
  try {
    await mkdir(identity, { mode: 0o700 });
  } catch {
    inputError("artifact output already exists");
  }
  const claim = await directoryIdentity(identity, "artifact output is invalid");
  await assertDirectoryIdentity(parentClaim);
  return { ...claim, parentClaim };
}

async function assertOutputDirectory(claim) {
  await assertDirectoryIdentity(claim.parentClaim);
  await assertDirectoryIdentity(claim);
}

async function createArtifactFile(claim, relative, bytes, mode = 0o600) {
  if (!safeRelativePath(relative)) inputError("artifact member path is invalid");
  await assertOutputDirectory(claim);
  let current = claim.path;
  const parentParts = dirname(relative) === "." ? [] : dirname(relative).split("/");
  for (const part of parentParts) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") inputError("artifact member parent cannot be created"); }
    await directoryIdentity(current, "artifact member parent is invalid");
  }
  const path = join(claim.path, relative);
  const parent = await directoryIdentity(dirname(path), "artifact member parent is invalid");
  if (parent.path !== claim.path && !parent.path.startsWith(`${claim.path}${sep}`)) inputError("artifact member escaped output");
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const before = await handle.stat();
    if (!before.isFile()) inputError("artifact member is not a regular file");
    await handle.writeFile(bytes);
    const after = await handle.stat();
    if (!after.isFile() || !sameInode(before, after)) inputError("artifact member changed");
  } catch (error) {
    if (error instanceof AdwError) throw error;
    inputError("artifact member cannot be created");
  } finally { await handle?.close(); }
  await assertDirectoryIdentity(parent);
  await assertOutputDirectory(claim);
}

const MAX_PRIOR_APPLY_RESULTS = 100;

export async function readPreviousApplyResult(root, currentAttempt) {
  if (!isAbsolute(root) || resolve(root) !== root || !Number.isSafeInteger(currentAttempt) || currentAttempt < 1) inputError("prior apply result request is invalid");
  let info;
  try { info = await lstat(root); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    inputError("prior apply results root is invalid");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) inputError("prior apply results root is invalid");
  const claim = await directoryIdentity(root, "prior apply results root is invalid");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => inputError("prior apply results root cannot be read"));
  if (entries.length > MAX_PRIOR_APPLY_RESULTS) inputError("prior apply results are oversized");
  const candidates = [];
  for (const entry of entries) {
    const match = /^adw-apply-result-([1-9][0-9]*)$/.exec(entry.name);
    const attempt = match ? Number(match[1]) : NaN;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !Number.isSafeInteger(attempt) || attempt >= currentAttempt) inputError("prior apply result entry is invalid");
    candidates.push({ attempt, directory: join(root, entry.name) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.attempt - left.attempt);
  const result = (await readTransportArtifact("applyResult", candidates[0].directory)).value;
  await assertDirectoryIdentity(claim);
  return result;
}

export async function writeTransportArtifact(type, directory, value, patchBytes) {
  const document = documentNames(type);
  if (!document || type === "source") inputError("artifact type is invalid");
  if (type === "snapshot") value = validateSnapshot(value);
  else if (type === "assessment") value = validateAssessmentArtifact({ assessment: value, patchBytes });
  else if (type === "decision") value = validateDecision(value);
  else if (type === "verification") value = validateVerification(value);
  const bytes = canonicalBytes(value);
  if (bytes.length > MAX_INPUT) inputError("artifact document is oversized");
  if (patchBytes !== undefined && patchBytes !== null) {
    if (!Buffer.isBuffer(patchBytes) || patchBytes.length > MAX_PATCH) inputError("artifact patch is oversized");
    if (!value.patch || value.patch.size !== patchBytes.length || value.patch.digest !== digestBytes(patchBytes)) inputError("artifact patch does not match");
  } else if (value.patch) inputError("artifact patch is missing");
  const output = await outputDirectory(directory);
  await createArtifactFile(output, `${document}.json`, bytes);
  await createArtifactFile(output, `${document}.sha256`, `${digestBytes(bytes)}\n`);
  if (Buffer.isBuffer(patchBytes)) {
    await createArtifactFile(output, "change.patch", patchBytes);
    await createArtifactFile(output, "change.patch.sha256", `${digestBytes(patchBytes)}\n`);
  }
  await assertOutputDirectory(output);
  return bytes;
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && resolve("/", value) === `/${value}` && !value.split("/").includes("..");
}

async function walkRegular(root, prefix = "") {
  const directory = prefix ? join(root, prefix) : root;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => inputError("control tree cannot be read"));
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) inputError("control tree contains an invalid member");
    if (entry.isDirectory()) files.push(...await walkRegular(root, relative));
    else files.push(relative);
  }
  return files;
}

function validateRepository(value) {
  exactObject(value, ["id", "owner", "name", "defaultBranch"], "source repository");
  for (const key of ["id", "owner", "name", "defaultBranch"]) if (typeof value[key] !== "string" || value[key].length === 0) inputError("source repository is invalid");
  return value;
}

function sortedUnique(values, compare = (a, b) => String(a).localeCompare(String(b))) {
  const sorted = [...values].sort(compare);
  return values.length === sorted.length && values.every((value, index) => canonicalBytes(value).equals(canonicalBytes(sorted[index]))) && new Set(values.map(value => canonicalBytes(value).toString("hex"))).size === values.length;
}

function validateTarget(target, expectedRepository, allowedShas) {
  exactObject(target, ["bundle", "refs", "shas", "paths"], "source target");
  exactObject(target.bundle, ["digest", "size"], "source bundle");
  if (!DIGEST.test(target.bundle.digest) || !Number.isSafeInteger(target.bundle.size) || target.bundle.size < 1 || target.bundle.size > MAX_BUNDLE) inputError("source bundle is invalid");
  if (!Array.isArray(target.refs) || !sortedUnique(target.refs, (a, b) => a.name.localeCompare(b.name)) || new Set(target.refs.map(ref => ref?.name)).size !== target.refs.length) inputError("source refs are invalid");
  for (const ref of target.refs) {
    exactObject(ref, ["name", "sha"], "source ref");
    if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref.name) || !SHA.test(ref.sha)) inputError("source ref is invalid");
  }
  if (!Array.isArray(target.shas) || target.shas.length > 1 || !sortedUnique(target.shas) || target.shas.some(sha => !SHA.test(sha))) inputError("source SHAs are invalid");
  if (target.refs.some(ref => !target.shas.includes(ref.sha))) inputError("source ref is outside objects");
  if (allowedShas && (target.shas.length !== allowedShas.length || target.shas.some((sha, index) => sha !== allowedShas[index]))) inputError("source objects do not match snapshot");
  if (!Array.isArray(target.paths) || !sortedUnique(target.paths, (a, b) => a.path.localeCompare(b.path)) || new Set(target.paths.map(item => item?.path)).size !== target.paths.length) inputError("source paths are invalid");
  for (const item of target.paths) {
    exactObject(item, ["path", "tree", "blob", "digest", "size"], "source path");
    if (!safeRelativePath(item.path) || !SHA.test(item.tree) || !SHA.test(item.blob) || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.size) || item.size < 0) inputError("source path is invalid");
  }
  validateRepository(expectedRepository);
  return target;
}

function validateManifest(value) {
  exactObject(value, ["schemaVersion", "controlSha", "repository", "control", "target"], "source manifest");
  if (value.schemaVersion !== 1 || !SHA.test(value.controlSha)) inputError("source manifest is invalid");
  validateRepository(value.repository);
  exactObject(value.control, ["paths"], "source control");
  if (!Array.isArray(value.control.paths) || value.control.paths.length === 0 || !sortedUnique(value.control.paths, (a, b) => a.path.localeCompare(b.path)) || new Set(value.control.paths.map(item => item?.path)).size !== value.control.paths.length) inputError("source control paths are invalid");
  for (const item of value.control.paths) {
    exactObject(item, ["path", "tree", "blob", "digest", "size"], "source control path");
    if (!safeRelativePath(item.path) || !SHA.test(item.tree) || !SHA.test(item.blob) || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.size) || item.size < 0) inputError("source control path is invalid");
  }
  validateTarget(value.target, value.repository);
  return value;
}

function authorityRequiredPaths(authority) {
  if (Array.isArray(authority?.trustedPaths)) return [...authority.trustedPaths];
  if (typeof authority?.charter === "string" && typeof authority?.payloadSchema === "string") return [authority.charter, authority.payloadSchema];
  inputError("control authority is invalid");
}

function sourceTargetShas(snapshot, rolePolicy) {
  if (rolePolicy.patch === null) return [];
  if (rolePolicy.name === "reviser") {
    const head = snapshot.state?.headSha;
    const pull = snapshot.revisions.filter(revision => revision.resource === `pull:${snapshot.event.entityId}` && revision.kind === "pull");
    if (!SHA.test(head) || pull.length !== 1 || pull[0].token !== head) inputError("reviser patch head is invalid");
    return [head];
  }
  const resource = `patch-base:${snapshot.repository.defaultBranch}`;
  const bases = snapshot.revisions.filter(revision => revision.resource === resource && revision.kind === "git_ref");
  if (bases.length !== 1 || !SHA.test(bases[0].token)) inputError("patch base is invalid");
  return [bases[0].token];
}

async function writeSourceArtifact({ directory, controlCheckout, targetCheckout, rolePolicy, controlSha, snapshot, controlAdapter, bundleAdapter }) {
  const allowedShas = sourceTargetShas(snapshot, rolePolicy);
  const requiredPaths = authorityRequiredPaths(rolePolicy);
  const output = await outputDirectory(directory);
  if (typeof controlAdapter !== "function" || typeof bundleAdapter !== "function") inputError("source adapters are unavailable");
  const controlResult = await controlAdapter({ repository: controlCheckout, controlSha, requiredPaths, hardening: HARDENING });
  exactObject(controlResult, ["paths"], "control result");
  if (!Array.isArray(controlResult.paths) || controlResult.paths.length === 0) inputError("control result is invalid");
  const controlPaths = [];
  for (const item of [...controlResult.paths].sort((a, b) => a.path.localeCompare(b.path))) {
    exactObject(item, ["path", "tree", "blob", "bytes"], "control result path");
    if (!safeRelativePath(item.path) || !SHA.test(item.tree) || !SHA.test(item.blob) || !Buffer.isBuffer(item.bytes)) inputError("control result path is invalid");
    await createArtifactFile(output, `control/${item.path}`, item.bytes, 0o400);
    controlPaths.push({ path: item.path, tree: item.tree, blob: item.blob, digest: digestBytes(item.bytes), size: item.bytes.length });
  }
  if (!controlPaths.some(item => item.path === "adw/main.mjs") || requiredPaths.some(path => !controlPaths.some(item => item.path === path))) inputError("control result is incomplete");
  for (const path of requiredPaths) {
    const item = controlResult.paths.find(candidate => candidate.path === path);
    const trusted = snapshot.state?.resources?.[`trusted:${path}`];
    const revision = snapshot.revisions.find(candidate => candidate.resource === `trusted:${path}` && candidate.kind === "control");
    if (!trusted || Object.keys(trusted).sort().join(",") !== "bytes,data,digest,source,trust" || trusted.trust !== "trusted" || trusted.source !== path || typeof trusted.data !== "string" || trusted.bytes !== canonicalBytes(trusted.data).length || trusted.digest !== digestJson(trusted.data) || !Buffer.from(trusted.data, "utf8").equals(item.bytes) || revision?.token !== item.blob) inputError("snapshot control binding is invalid");
  }
  await assertOutputDirectory(output);
  const result = await bundleAdapter({ repository: targetCheckout, snapshot, allowedShas, hardening: HARDENING });
  exactObject(result, ["bytes", "repository", "refs", "shas", "paths"], "bundle result");
  if (!Buffer.isBuffer(result.bytes) || result.bytes.length < 1 || result.bytes.length > MAX_BUNDLE) inputError("bundle result is invalid");
  if (!canonicalBytes(result.repository).equals(canonicalBytes(snapshot.repository))) inputError("bundle repository does not match snapshot");
  const target = validateTarget({
    bundle: { digest: digestBytes(result.bytes), size: result.bytes.length },
    refs: result.refs,
    shas: result.shas,
    paths: result.paths,
  }, result.repository, allowedShas);
  const manifest = validateManifest({ schemaVersion: 1, controlSha, repository: snapshot.repository, control: { paths: controlPaths }, target });
  const manifestBytes = canonicalBytes(manifest);
  if (manifestBytes.length > MAX_INPUT) inputError("source manifest is oversized");
  await createArtifactFile(output, "target.bundle", result.bytes, 0o400);
  await createArtifactFile(output, "manifest.json", manifestBytes, 0o400);
  await createArtifactFile(output, "manifest.sha256", `${digestBytes(manifestBytes)}\n`, 0o400);
  await assertOutputDirectory(output);
  return manifest;
}

async function readSourceArtifact(directory, rolePolicy, snapshot) {
  const directoryClaim = await directoryIdentity(directory);
  await exactDirectory(directory, [["control", "manifest.json", "manifest.sha256", "target.bundle"]], directoryClaim);
  const manifestBytes = await digestDocument(directory, "manifest.json", "manifest.sha256");
  const parsedManifest = parse(manifestBytes.toString("utf8"));
  if (!canonicalBytes(parsedManifest).equals(manifestBytes)) inputError("source manifest is not canonical");
  const manifest = validateManifest(parsedManifest);
  if (!snapshot || !canonicalBytes(manifest.target.shas).equals(canonicalBytes(sourceTargetShas(snapshot, rolePolicy)))) inputError("source target does not match snapshot");
  const bundle = await readRegular(join(directory, "target.bundle"), MAX_BUNDLE);
  if (bundle.length !== manifest.target.bundle.size || digestBytes(bundle) !== manifest.target.bundle.digest) inputError("source bundle digest does not match");
  const actualPaths = await walkRegular(join(directory, "control"));
  const expectedPaths = manifest.control.paths.map(item => item.path);
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) inputError("source control tree is not exact");
  for (const item of manifest.control.paths) {
    const bytes = await readRegular(join(directory, "control", item.path), MAX_BUNDLE);
    if (bytes.length !== item.size || digestBytes(bytes) !== item.digest) inputError("source control digest does not match");
  }
  if (!expectedPaths.includes("adw/main.mjs") || (rolePolicy && authorityRequiredPaths(rolePolicy).some(path => !expectedPaths.includes(path)))) inputError("source control files are missing");
  await assertDirectoryIdentity(directoryClaim);
  return Object.freeze({ manifest, bundle, controlDirectory: join(directory, "control") });
}

function isArtifactCommand(argv) {
  return Array.isArray(argv) && (new Set(["assess", "reduce", "verify"]).has(argv[0]) || (argv[0] === "validate" && new Set(["assessment", "decision", "verification"]).has(argv[1])));
}

function errorCode(error, artifactInput) {
  if (error instanceof AdwError) {
    if (error.code === "stale") return 3;
    if (error.code === "provider") return 4;
    if (error.code === "forge") return 5;
    if (error.code === "verification") return 7;
    if (artifactInput && (error.code === "contract" || error.code === "input" || error.code === "role")) return 6;
  }
  return 2;
}

function safeMessage(error) {
  if (!(error instanceof AdwError)) return "invalid input";
  return error.message.replace(/[\r\n\t]/g, " ").slice(0, 240);
}

async function source(argv, stdin, readFixture) {
  const index = argv.indexOf("--fixture");
  if (index === -1) return stdin;
  if (index !== argv.length - 2) inputError("fixture arguments are invalid");
  const name = argv[index + 1];
  if (!name || basename(name) !== name || !/^[A-Za-z0-9._-]+\.json$/.test(name)) inputError("fixture name is invalid");
  try {
    return await readFixture(name);
  } catch {
    inputError("fixture cannot be read");
  }
}

function canonicalAuthority(snapshot) {
  const authority = resolveAuthority(snapshot.routing.role);
  const expected = authority.kind === "control" || !Object.hasOwn(authority, "mode")
    ? { role: authority.name, mode: "single", primary: null }
    : { role: authority.name, mode: authority.mode, primary: authority.primary };
  if (digestJson(snapshot.routing) !== digestJson(expected)) inputError("snapshot role authority is not canonical");
  return authority;
}

function sortedCapabilities(values, name = "capabilities") {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !/^[a-z]+:[a-z]+$/.test(value))) inputError(`${name} are invalid`);
  const result = [...new Set(values)].sort();
  if (result.length !== values.length || result.some((value, index) => value !== values[index])) inputError(`${name} are not canonical`);
  return Object.freeze(result);
}

function validateAuthorityCapabilities(authority, capabilities) {
  if (authority.kind !== "control") return;
  const declared = new Set(authority.capabilities);
  for (const capability of capabilities) {
    const writeEquivalent = capability.endsWith(":read") ? capability.replace(/:read$/, ":write") : null;
    if (!declared.has(capability) && (writeEquivalent === null || !declared.has(writeEquivalent))) inputError("operation exceeds control authority capabilities");
  }
}

function applyCapabilities(decision, snapshot) {
  const github = new Set();
  let vcs = false;
  for (const operation of decision.operations) {
    if (operation.type === "create_branch") { vcs = true; continue; }
    for (const capability of operationCapabilities(operation, snapshot)) github.add(capability);
  }
  if (decision.kind === "patch") vcs = true;
  const githubOperationCapabilities = Object.freeze([...github].sort());
  const capabilities = Object.freeze([...new Set([...githubOperationCapabilities, ...(vcs ? ["contents:write"] : [])])].sort());
  return Object.freeze({ github: capabilities, all: capabilities });
}

const APP_PERMISSION_FOR_CAPABILITY = Object.freeze({
  actions: Object.freeze(["actions"]),
  alerts: Object.freeze(["security_events", "vulnerability_alerts"]),
  checks: Object.freeze(["checks"]),
  contents: Object.freeze(["contents"]),
  issues: Object.freeze(["issues"]),
  pulls: Object.freeze(["pull_requests"]),
  repository: Object.freeze(["metadata"]),
  settings: Object.freeze(["administration"]),
});
const APP_PERMISSION_OUTPUTS = Object.freeze([
  "actions", "administration", "checks", "contents", "issues", "metadata",
  "pull_requests", "security_events", "vulnerability_alerts",
]);

export function operationPermissionOutputs(decision, snapshot) {
  const trustedSnapshot = validateSnapshot(snapshot);
  const canonicalDecision = validateDecision(decision);
  if (canonicalDecision.controlSha !== trustedSnapshot.controlSha || canonicalDecision.snapshotDigest !== digestJson(trustedSnapshot)) inputError("permission output binding is invalid");
  const authority = canonicalAuthority(trustedSnapshot);
  for (const operation of canonicalDecision.operations) validateOperation(operation, authority);
  const capabilities = applyCapabilities(canonicalDecision, trustedSnapshot).all;
  validateAuthorityCapabilities(authority, capabilities);
  const rank = { read: 1, write: 2 };
  const permissions = {};
  for (const capability of capabilities) {
    const [name, level] = capability.split(":");
    const mapped = APP_PERMISSION_FOR_CAPABILITY[name];
    if (!mapped || !Object.hasOwn(rank, level)) inputError("operation capability has no App permission");
    for (const permission of mapped) if (!permissions[permission] || rank[level] > rank[permissions[permission]]) permissions[permission] = level;
  }
  const ordered = Object.freeze(Object.fromEntries(Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right))));
  return Object.freeze({ applyClass: capabilities.length === 0 ? "none" : capabilities.join("+"), capabilities, permissions: ordered });
}

async function emitOperationPermissionOutputs(env, decision, snapshot) {
  if (env?.ADW_EMIT_GITHUB_OUTPUT === undefined) return;
  if (env.ADW_EMIT_GITHUB_OUTPUT !== "exact-permissions-v1") inputError("permission output mode is invalid");
  const path = environmentPath(env, "GITHUB_OUTPUT");
  const output = operationPermissionOutputs(decision, snapshot);
  const values = {
    apply_class: output.applyClass,
    apply_capabilities: canonicalBytes(output.capabilities).toString("utf8"),
    apply_permissions: canonicalBytes(output.permissions).toString("utf8"),
    ...Object.fromEntries(APP_PERMISSION_OUTPUTS.map(name => [`permission_${name}`, output.permissions[name] ?? ""])),
  };
  const bytes = Buffer.from(`${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INPUT) inputError("permission output file is invalid");
    handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || !sameInode(before, current)) inputError("permission output file changed");
    await handle.writeFile(bytes);
    const after = await handle.stat();
    if (!sameInode(current, after) || after.size !== current.size + bytes.length || after.size > MAX_INPUT) inputError("permission output file changed");
  } catch (error) {
    if (error instanceof AdwError) throw error;
    inputError("permission output file is invalid");
  } finally { await handle?.close(); }
}

function applyReceipt(raw, projection, operationDigest) {
  if (!raw || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) inputError("apply subreceipt is invalid");
  const vcs = projection === "vcs_head";
  const allowed = vcs
    ? ["operationDigest", "projection", "status", "beforeRevision", "preparedRevision", "afterRevision", "headSha"]
    : ["operationDigest", "status", "beforeRevision", "preparedRevision", "afterRevision"];
  exactObject(raw, allowed, "apply subreceipt");
  if (raw.operationDigest !== operationDigest || raw.status !== "complete" || ![raw.beforeRevision, raw.preparedRevision, raw.afterRevision].every(value => typeof value === "string" && DIGEST.test(value))) inputError("apply subreceipt binding is invalid");
  if (vcs && (raw.projection !== "vcs_head" || typeof raw.headSha !== "string" || !SHA.test(raw.headSha))) inputError("VCS subreceipt is invalid");
  return vcs
    ? Object.freeze({ operationDigest, projection, status: "complete", beforeRevision: raw.beforeRevision, preparedRevision: raw.preparedRevision, afterRevision: raw.afterRevision, headSha: raw.headSha })
    : Object.freeze({ operationDigest, projection, status: "complete", beforeRevision: raw.beforeRevision, preparedRevision: raw.preparedRevision, afterRevision: raw.afterRevision });
}

function expectedProjections(decision, index) {
  const operation = decision.operations[index];
  if (decision.kind === "patch" && ["create_branch", "create_pr", "update_pr"].includes(operation.type)) {
    return operation.type === "create_branch" ? ["vcs_head"] : ["vcs_head", "github_metadata"];
  }
  return ["github_state"];
}

const APPLY_FAILURE_MESSAGES = Object.freeze({
  contract: "artifact contract failed", input: "artifact contract failed", role: "role authority failed",
  stale: "precondition changed", provider: "provider unavailable", forge: "forge operation failed",
  verification: "verification failed", terminal: "terminal operation failed",
});

export function validateApplyResult(value, { sourceDigest, snapshot, decision, verification, authority, capabilities } = {}) {
  exactObject(value, ["schemaVersion", "controlSha", "sourceDigest", "snapshotDigest", "decisionDigest", "verificationDigest", "authority", "status", "operations", "failure"], "apply result");
  if (value.schemaVersion !== 1 || !SHA.test(value.controlSha) || !DIGEST.test(value.sourceDigest) || !DIGEST.test(value.snapshotDigest) || !DIGEST.test(value.decisionDigest) || !DIGEST.test(value.verificationDigest) || !new Set(["complete", "partial", "failed"]).has(value.status)) inputError("apply result is invalid");
  exactObject(value.authority, ["name", "digest", "capabilities"], "apply authority");
  if (typeof value.authority.name !== "string" || !DIGEST.test(value.authority.digest)) inputError("apply authority is invalid");
  sortedCapabilities(value.authority.capabilities, "apply capabilities");
  if (!Array.isArray(value.operations) || value.operations.length > 100) inputError("apply result operations are invalid");
  let failed = 0;
  let pending = false;
  for (const [index, entry] of value.operations.entries()) {
    exactObject(entry, ["index", "operationDigest", "status", "receipts"], "apply result operation");
    if (entry.index !== index || !DIGEST.test(entry.operationDigest) || !new Set(["complete", "failed", "pending"]).has(entry.status) || !Array.isArray(entry.receipts)) inputError("apply result operation is invalid");
    const projections = new Set();
    for (const receipt of entry.receipts) {
      if (!receipt || typeof receipt.projection !== "string" || projections.has(receipt.projection)) inputError("apply result receipt order is invalid");
      projections.add(receipt.projection);
      const raw = receipt.projection === "vcs_head" ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "projection"));
      applyReceipt(raw, receipt.projection, entry.operationDigest);
    }
    if (entry.status === "failed") failed++;
    if (entry.status === "pending") pending = true;
  }
  if (value.failure === null) {
    if (value.status !== "complete" || failed !== 0 || pending) inputError("apply result completion is invalid");
  } else {
    exactObject(value.failure, ["operationIndex", "projection", "code", "message"], "apply failure");
    if (!Number.isSafeInteger(value.failure.operationIndex) || value.failure.operationIndex < 0 || value.failure.operationIndex >= value.operations.length || !new Set(["vcs_head", "github_metadata", "github_state"]).has(value.failure.projection) || !Object.hasOwn(APPLY_FAILURE_MESSAGES, value.failure.code) || value.failure.message !== APPLY_FAILURE_MESSAGES[value.failure.code] || failed !== 1 || value.operations[value.failure.operationIndex].status !== "failed" || value.status === "complete") inputError("apply failure is invalid");
  }
  if (snapshot !== undefined) {
    const trustedSnapshot = validateSnapshot(snapshot);
    const canonicalDecision = validateDecision(decision);
    const proof = validateVerification(verification);
    if (value.controlSha !== trustedSnapshot.controlSha || value.sourceDigest !== sourceDigest || value.snapshotDigest !== digestJson(trustedSnapshot) || value.decisionDigest !== digestJson(canonicalDecision) || value.verificationDigest !== digestJson(proof) || value.authority.name !== authority.name || value.authority.digest !== digestJson(authority) || digestJson(value.authority.capabilities) !== digestJson(capabilities) || value.operations.length !== canonicalDecision.operations.length) inputError("apply result authority does not match");
    const githubReceipts = [];
    let githubGap = false;
    let statusGap = false;
    for (const [index, entry] of value.operations.entries()) {
      if (entry.operationDigest !== digestJson(canonicalDecision.operations[index])) inputError("apply result operation does not match");
      const expected = expectedProjections(canonicalDecision, index);
      if (entry.receipts.some((receipt, receiptIndex) => receipt.projection !== expected[receiptIndex]) || entry.receipts.length > expected.length || (entry.status === "complete" && entry.receipts.length !== expected.length) || (entry.status === "pending" && entry.receipts.length !== 0)) inputError("apply result projections do not match");
      const vcsReceipt = entry.receipts.find(receipt => receipt.projection === "vcs_head");
      if (vcsReceipt && (vcsReceipt.beforeRevision !== proof.preconditionDigest || vcsReceipt.preparedRevision !== vcsReceipt.afterRevision)) inputError("VCS apply receipt does not match");
      const forgeReceipt = entry.receipts.find(receipt => receipt.projection === "github_metadata" || receipt.projection === "github_state");
      if (forgeReceipt) {
        if (githubGap) inputError("apply result GitHub receipts are not a prefix");
        githubReceipts.push(githubReceipt(forgeReceipt));
      } else if (canonicalDecision.operations[index].type !== "create_branch") githubGap = true;
      if (entry.status === "complete") {
        if (statusGap) inputError("apply result completion is not a prefix");
      } else statusGap = true;
    }
    if (!canonicalDecision.operations.some(operation => operation.type === "create_branch")) createApplyReceipt({ decision: canonicalDecision, snapshot: trustedSnapshot, verification: proof, operations: githubReceipts });
  }
  return Object.freeze(structuredClone(value));
}

function githubReceipt(receipt) {
  const { projection, ...raw } = receipt;
  if (projection !== "github_metadata" && projection !== "github_state") inputError("GitHub subreceipt is invalid");
  return raw;
}

function sanitizedFailure(error, operationIndex, projection) {
  const code = error instanceof AdwError && new Set(["contract", "input", "role", "stale", "provider", "forge", "verification", "terminal"]).has(error.code) ? error.code : "forge";
  const message = APPLY_FAILURE_MESSAGES[code];
  return Object.freeze({ operationIndex, projection, code, message });
}

function applyResultBase({ sourceDigest, snapshot, decision, verification, authority, capabilities, previousReceipt }) {
  const operations = decision.operations.map((operation, index) => ({ index, operationDigest: digestJson(operation), status: "pending", receipts: [] }));
  if (previousReceipt !== null) {
    const previous = validateApplyResult(previousReceipt, { sourceDigest, snapshot, decision, verification, authority, capabilities });
    for (const [index, entry] of previous.operations.entries()) {
      operations[index].receipts = [...entry.receipts];
      operations[index].status = entry.status === "complete" ? "complete" : "pending";
    }
  }
  return operations;
}

function finishApplyResult({ sourceDigest, snapshot, decision, verification, authority, capabilities, operations, failure = null }) {
  if (failure === null) for (const entry of operations) entry.status = "complete";
  else {
    for (const entry of operations) {
      const expected = expectedProjections(decision, entry.index);
      if (entry.index < failure.operationIndex && entry.receipts.length === expected.length) entry.status = "complete";
      else if (entry.index === failure.operationIndex) entry.status = "failed";
      else entry.status = "pending";
    }
  }
  const completedReceipts = operations.reduce((total, entry) => total + entry.receipts.length, 0);
  return validateApplyResult({
    schemaVersion: 1,
    controlSha: snapshot.controlSha,
    sourceDigest,
    snapshotDigest: digestJson(snapshot),
    decisionDigest: digestJson(decision),
    verificationDigest: digestJson(verification),
    authority: { name: authority.name, digest: digestJson(authority), capabilities },
    status: failure === null ? "complete" : completedReceipts > 0 ? "partial" : "failed",
    operations,
    failure,
  }, { sourceDigest, snapshot, decision, verification, authority, capabilities });
}

export async function composeApply({ sourceDigest, snapshot, decision, verification, patchBytes, previousReceipt = null, github, vcs = null, vcsRequest = null }) {
  const trustedSnapshot = validateSnapshot(snapshot);
  const canonicalDecision = validateDecision(decision);
  const proof = validateVerification(verification);
  const authority = canonicalAuthority(trustedSnapshot);
  if (canonicalDecision.controlSha !== trustedSnapshot.controlSha || canonicalDecision.snapshotDigest !== digestJson(trustedSnapshot) || proof.controlSha !== trustedSnapshot.controlSha || proof.decisionDigest !== digestJson(canonicalDecision) || proof.preconditionDigest !== digestJson(trustedSnapshot.revisions) || proof.kind !== canonicalDecision.kind) inputError("apply artifact binding is invalid");
  for (const operation of canonicalDecision.operations) validateOperation(operation, authority);
  if ((canonicalDecision.patch === null) !== (patchBytes === undefined) || (proof.patch === null) !== (patchBytes === undefined) || (patchBytes !== undefined && (!Buffer.isBuffer(patchBytes) || canonicalDecision.patch.digest !== digestBytes(patchBytes) || digestJson(canonicalDecision.patch) !== digestJson(proof.patch)))) inputError("apply patch binding is invalid");
  if (!DIGEST.test(sourceDigest)) inputError("apply source digest is invalid");
  const boundCapabilities = applyCapabilities(canonicalDecision, trustedSnapshot);
  validateAuthorityCapabilities(authority, boundCapabilities.all);
  const operations = applyResultBase({ sourceDigest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, authority, capabilities: boundCapabilities.all, previousReceipt });
  const patchEntries = canonicalDecision.operations.map((operation, index) => ({ operation, index })).filter(({ operation }) => ["create_branch", "create_pr", "update_pr"].includes(operation.type));
  if (canonicalDecision.kind === "patch" && patchEntries.length !== 1) inputError("patch decision projection is invalid");
  if (canonicalDecision.kind === "state" && patchEntries.some(({ operation }) => operation.type === "create_branch")) inputError("state decision has a VCS projection");

  let vcsProjection = null;
  if (canonicalDecision.kind === "patch") {
    const carrier = patchEntries[0];
    try {
      if (!vcs || typeof vcs.applyVerifiedPatch !== "function" || !vcsRequest) inputError("VCS writer is unavailable");
      const raw = await vcs.applyVerifiedPatch({ ...vcsRequest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, patchBytes, operation: carrier.operation, operationIndex: carrier.index });
      const receipt = applyReceipt(raw, "vcs_head", digestJson(carrier.operation));
      vcsProjection = Object.freeze({ operationDigest: receipt.operationDigest, headSha: receipt.headSha });
      operations[carrier.index].receipts = [receipt, ...operations[carrier.index].receipts.filter(value => value.projection !== "vcs_head")];
    } catch (error) {
      const failure = sanitizedFailure(error, carrier.index, "vcs_head");
      return finishApplyResult({ sourceDigest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, authority, capabilities: boundCapabilities.all, operations, failure });
    }
  }

  const githubIndexes = canonicalDecision.operations.map((operation, index) => ({ operation, index })).filter(({ operation }) => operation.type !== "create_branch");
  if (githubIndexes.length !== canonicalDecision.operations.length) {
    if (githubIndexes.length !== 0) inputError("mixed VCS-only decisions are unsupported");
    return finishApplyResult({ sourceDigest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, authority, capabilities: boundCapabilities.all, operations });
  }
  if (!github || typeof github.apply !== "function") inputError("GitHub writer is unavailable");
  const prior = [];
  for (let index = 0; index < operations.length; index++) {
    const receipt = operations[index].receipts.find(value => value.projection === "github_metadata" || value.projection === "github_state");
    if (!receipt) break;
    prior.push(githubReceipt(receipt));
  }
  const previous = prior.length === 0 ? null : { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: prior };
  try {
    const vcsProjections = vcsProjection === null || canonicalDecision.operations[patchEntries[0].index].type === "create_branch" ? [] : [vcsProjection];
    const receipt = await github.apply({ decision: canonicalDecision, snapshot: trustedSnapshot, verification: proof, previousReceipt: previous, capabilities: boundCapabilities.github, vcsProjections });
    if (!receipt || receipt.decisionDigest !== proof.decisionDigest || receipt.verificationDigest !== digestJson(proof) || !Array.isArray(receipt.operations) || receipt.operations.length !== canonicalDecision.operations.length) inputError("GitHub receipt binding is invalid");
    for (const [index, raw] of receipt.operations.entries()) {
      const projection = canonicalDecision.kind === "patch" && patchEntries[0].index === index ? "github_metadata" : "github_state";
      const normalized = applyReceipt(raw, projection, digestJson(canonicalDecision.operations[index]));
      operations[index].receipts = [...operations[index].receipts.filter(value => value.projection === "vcs_head"), normalized];
    }
    return finishApplyResult({ sourceDigest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, authority, capabilities: boundCapabilities.all, operations });
  } catch (error) {
    const partial = error?.details?.partialReceipt;
    if (partial && partial.decisionDigest === proof.decisionDigest && partial.verificationDigest === digestJson(proof) && Array.isArray(partial.operations)) {
      for (const [index, raw] of partial.operations.entries()) {
        if (index >= canonicalDecision.operations.length) break;
        const projection = canonicalDecision.kind === "patch" && patchEntries[0].index === index ? "github_metadata" : "github_state";
        const normalized = applyReceipt(raw, projection, digestJson(canonicalDecision.operations[index]));
        operations[index].receipts = [...operations[index].receipts.filter(value => value.projection === "vcs_head"), normalized];
      }
    }
    const index = Math.min(partial?.operations?.length ?? prior.length, canonicalDecision.operations.length - 1);
    const projection = canonicalDecision.kind === "patch" && patchEntries[0]?.index === index ? "github_metadata" : "github_state";
    const failure = sanitizedFailure(error, Math.max(0, index), projection);
    return finishApplyResult({ sourceDigest, snapshot: trustedSnapshot, decision: canonicalDecision, verification: proof, authority, capabilities: boundCapabilities.all, operations, failure });
  }
}

function bindJobScopedTokenExpiry(env) {
  if (env?.ADW_GITHUB_TOKEN_EXPIRES_AT !== "job-scoped") return;
  env.ADW_GITHUB_TOKEN_EXPIRES_AT = new Date(Date.now() + 2_700_000).toISOString();
}

async function prepareCommand(env, adapters) {
  bindJobScopedTokenExpiry(env);
  const controlCheckout = environmentPath(env, "ADW_CONTROL_CHECKOUT");
  const targetCheckout = environmentPath(env, "ADW_TARGET_CHECKOUT");
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const eventPath = environmentPath(env, "ADW_EVENT_PATH");
  const eventName = environmentId(env, "ADW_EVENT_NAME", /^[a-z_]+$/);
  const repository = environmentId(env, "ADW_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const roleName = environmentId(env, "ADW_ROLE", /^[a-z][a-z0-9-]*$/);
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  const appId = environmentId(env, "ADW_APP_ID");
  await separated([sourceDirectory, snapshotDirectory, eventPath, controlCheckout, targetCheckout]);
  const rolePolicy = resolveAuthority(roleName);
  const active = adapters ?? {};
  const vcs = active.vcs ?? createDefaultVcs(environmentPath(env, "ADW_GIT_PATH"));
  if (typeof vcs.head !== "function" || typeof vcs.readControl !== "function" || typeof vcs.createBundle !== "function") inputError("prepare adapters are unavailable");
  if (await vcs.head(controlCheckout) !== controlSha) throw new AdwError("stale", "control SHA changed");
  const eventBytes = await readRegular(eventPath, MAX_INPUT);
  let eventPayload;
  try { eventPayload = parse(eventBytes.toString("utf8")); } catch { inputError("event is invalid"); }
  const event = normalizeEvent(eventName, eventPayload);
  if (`${event.repository.owner}/${event.repository.name}` !== repository) inputError("event repository does not match");
  const githubFactory = active.githubFactory ?? createDefaultGitHub;
  const github = githubFactory(repository);
  if (!github || typeof github.readRoleSnapshot !== "function") inputError("snapshot adapter is unavailable");
  const reader = rolePolicy.kind === "control" && typeof github.readControlSnapshot === "function"
    ? (normalizedEvent, policy, options) => github.readControlSnapshot(normalizedEvent, policy.name, options)
    : (normalizedEvent, policy, options) => github.readRoleSnapshot(normalizedEvent, policy, options);
  const snapshot = validateSnapshot(await reader(event, rolePolicy, { controlSha, appId }));
  if (snapshot.controlSha !== controlSha || snapshot.routing.role !== roleName || snapshot.routing.mode !== rolePolicy.mode || snapshot.routing.primary !== rolePolicy.primary) inputError("snapshot policy binding is invalid");
  if (`${snapshot.repository.owner}/${snapshot.repository.name}` !== repository || snapshot.repository.id !== event.repository.id) inputError("snapshot repository binding is invalid");
  await writeTransportArtifact("snapshot", snapshotDirectory, snapshot);
  await writeSourceArtifact({ directory: sourceDirectory, controlCheckout, targetCheckout, rolePolicy, controlSha, snapshot, controlAdapter: request => vcs.readControl(request), bundleAdapter: request => vcs.createBundle(request) });
  return snapshot;
}

async function materializeTarget(vcs, source, directory) {
  if (typeof vcs?.materializeBundle !== "function") inputError("bundle materializer is unavailable");
  const result = await vcs.materializeBundle({
    bundle: source.bundle,
    directory,
    manifest: source.manifest,
    allowedRefs: source.manifest.target.refs,
    allowedShas: source.manifest.target.shas,
    allowedPaths: source.manifest.target.paths,
    hardening: HARDENING,
  });
  if (result !== undefined) {
    exactObject(result, ["refs", "shas", "paths"], "materialized target");
    if (!canonicalBytes(result.refs).equals(canonicalBytes(source.manifest.target.refs)) || !canonicalBytes(result.shas).equals(canonicalBytes(source.manifest.target.shas)) || !canonicalBytes(result.paths).equals(canonicalBytes(source.manifest.target.paths))) inputError("materialized target does not match manifest");
  }
}

async function requireTransportExecutable(executablePath, sourceDirectory) {
  if (typeof executablePath !== "string" || !isAbsolute(executablePath)) inputError("transport executable is invalid");
  const actual = await realpath(executablePath).catch(() => inputError("transport executable is invalid"));
  const expected = await realpath(join(sourceDirectory, "control", "adw", "main.mjs")).catch(() => inputError("transport executable is invalid"));
  if (actual !== expected) inputError("transport executable is outside trusted control artifact");
}

async function assessCommand(provider, env, adapters, executablePath) {
  if (!Object.hasOwn(PROVIDER_PINS, provider)) inputError("provider is unsupported");
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const assessmentDirectory = environmentPath(env, "ADW_ASSESSMENT_ARTIFACT");
  const targetDirectory = environmentPath(env, "ADW_TARGET_DIRECTORY");
  const runnerTemporary = environmentPath(env, "ADW_RUNNER_TEMP");
  const npmPath = environmentPath(env, "ADW_NPM_PATH");
  const npmExecutable = await executableIdentity(npmPath, "ADW_NPM_PATH");
  const nodeExecutable = await executableIdentity(process.execPath, "Node executable");
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  const credentialValue = environmentId(env, "ADW_PROVIDER_CREDENTIAL", /^.{1,65536}$/s);
  const runId = environmentId(env, "ADW_RUN_ID");
  const job = environmentId(env, "ADW_JOB_ID");
  const attemptText = environmentId(env, "ADW_RUN_ATTEMPT", /^[1-9][0-9]*$/);
  const idempotencyKey = environmentId(env, "ADW_IDEMPOTENCY_KEY");
  const attempt = Number(attemptText);
  if (!Number.isSafeInteger(attempt)) inputError("run attempt is invalid");
  await separated([sourceDirectory, snapshotDirectory, assessmentDirectory, targetDirectory, runnerTemporary, npmExecutable]);
  const snapshotRecord = await readTransportArtifact("snapshot", snapshotDirectory);
  const snapshot = snapshotRecord.value;
  const rolePolicy = role(snapshot.routing.role);
  const source = await readSourceArtifact(sourceDirectory, rolePolicy, snapshot);
  if (snapshot.controlSha !== controlSha || source.manifest.controlSha !== controlSha || !canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository))) inputError("control or repository binding is invalid");
  if (!rolePolicy.providers.includes(provider)) inputError("provider is outside role policy");
  const vcs = adapters?.vcs ?? (rolePolicy.patch === null ? null : createDefaultVcs(environmentPath(env, "ADW_GIT_PATH")));
  let stateTargetClaim;
  if (rolePolicy.patch !== null) await materializeTarget(vcs, source, targetDirectory);
  else stateTargetClaim = await outputDirectory(targetDirectory);
  const providerAdapter = adapters?.provider ?? { install: installProvider, invoke: invokeProvider };
  if (typeof providerAdapter.install !== "function" || typeof providerAdapter.invoke !== "function") inputError("provider adapters are unavailable");
  const nonce = `${provider}-${randomUUID()}`;
  const runRoot = await outputDirectory(join(runnerTemporary, `adw-run-${nonce}`));
  const prefix = join(runRoot.path, "provider");
  const home = join(runRoot.path, "home");
  const baseEnv = { PATH: [...new Set([dirname(npmExecutable), dirname(nodeExecutable)])].join(delimiter), HOME: runRoot.path, LANG: "C.UTF-8", TMPDIR: runRoot.path };
  try {
    const installed = await providerAdapter.install({ provider, prefix, npmPath, repository: targetDirectory, baseEnv });
    await assertOutputDirectory(runRoot);
    exactObject(installed, ["executable", "version"], "installed provider");
    if (!isAbsolute(installed.executable) || installed.version !== PROVIDER_PINS[provider].version) throw new AdwError("provider", "version");
    await separated([installed.executable, sourceDirectory, snapshotDirectory, assessmentDirectory, targetDirectory]);
    const credential = provider === "claude" ? { CLAUDE_CODE_OAUTH_TOKEN: credentialValue } : { CODEX_AUTH_JSON: credentialValue };
    const invoked = await providerAdapter.invoke({
      provider,
      executable: installed.executable,
      cliVersion: installed.version,
      rolePolicy,
      snapshot,
      idempotencyKey,
      home,
      repository: targetDirectory,
      credential,
      runIdentity: { id: runId, job, attempt },
      baseEnv,
      now: adapters?.now ?? (() => new Date().toISOString()),
      capturePatch: rolePolicy.patch === null ? undefined : manifest => vcs.capturePatch({ repository: targetDirectory, baseSha: manifest.baseSha, manifest, rolePolicy, hardening: HARDENING }),
    });
    const assessment = invoked?.assessment ?? invoked;
    const patchBytes = invoked?.assessment ? invoked.patchBytes ?? undefined : undefined;
    validateAssessmentArtifact({ assessment, patchBytes });
    if (assessment.provider !== provider || assessment.controlSha !== controlSha || assessment.snapshotDigest !== digestJson(snapshot) || assessment.role !== rolePolicy.name || assessment.idempotencyKey !== idempotencyKey) throw new AdwError("provider", "binding");
    await assertOutputDirectory(runRoot);
    if (stateTargetClaim) await assertOutputDirectory(stateTargetClaim);
    await writeTransportArtifact("assessment", assessmentDirectory, assessment, patchBytes);
    return assessment;
  } finally {
    try { await rm(runRoot.path, { recursive: true, force: true }); }
    catch { throw new AdwError("provider", "cleanup"); }
  }
}

async function optionalAssessment(directory, provider = null) {
  try {
    const record = await readTransportArtifact("assessment", directory, { allowMalformed: true });
    if (record.malformed || (provider !== null && record.value.provider !== provider)) return null;
    try {
      validateRolePayload(record.value.role, record.value.payload);
      const verdict = record.value.payload.verdict;
      const expectedOutcome = verdict === "noop" ? "noop" : new Set(["blocked", "disproved", "inconclusive", "reject", "risky"]).has(verdict) ? "negative" : "positive";
      if (record.value.outcome !== "unable" && record.value.outcome !== expectedOutcome) return null;
      if (record.value.payload.patch !== undefined && digestJson(record.value.payload.patch) !== digestJson(record.value.patch)) return null;
    } catch { return null; }
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof AdwError && new Set(["artifact path is invalid", "artifact directory is invalid"]).has(error.message)) return null;
    throw error;
  }
}

async function reduceCommand(env, executablePath) {
  const fallbackAttempted = env?.ADW_FALLBACK_ATTEMPTED === undefined ? false
    : env.ADW_FALLBACK_ATTEMPTED === "true" ? true
      : env.ADW_FALLBACK_ATTEMPTED === "false" ? false
        : inputError("ADW_FALLBACK_ATTEMPTED is invalid");
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const primaryDirectory = environmentPath(env, "ADW_PRIMARY_ASSESSMENT_ARTIFACT");
  const fallbackDirectory = environmentPath(env, "ADW_FALLBACK_ASSESSMENT_ARTIFACT");
  const decisionDirectory = environmentPath(env, "ADW_DECISION_ARTIFACT");
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  await separated([sourceDirectory, snapshotDirectory, primaryDirectory, fallbackDirectory, decisionDirectory]);
  const snapshot = (await readTransportArtifact("snapshot", snapshotDirectory)).value;
  const rolePolicy = role(snapshot.routing.role);
  const source = await readSourceArtifact(sourceDirectory, rolePolicy, snapshot);
  if (snapshot.controlSha !== controlSha || source.manifest.controlSha !== controlSha || !canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository))) inputError("control or repository binding is invalid");
  const records = [];
  if (rolePolicy.mode === "quorum") {
    for (const directory of [primaryDirectory, fallbackDirectory]) {
      const record = await optionalAssessment(directory);
      if (record && rolePolicy.providers.includes(record.value.provider) && !records.some(item => item.value.provider === record.value.provider)) records.push(record);
    }
  } else {
    const primary = await optionalAssessment(primaryDirectory, rolePolicy.primary);
    if (primary) records.push(primary);
    const primaryAssessments = records.map(record => record.patchBytes === undefined ? record.value : { assessment: record.value, patchBytes: record.patchBytes });
    const primaryReduction = reduceAssessments({ snapshot, rolePolicy, assessments: primaryAssessments });
    if (primaryReduction.status === "artifact") {
      const decision = reduceRoleArtifact({ snapshot, rolePolicy, reduction: primaryReduction, assessments: primaryAssessments });
      await writeTransportArtifact("decision", decisionDirectory, decision, primary?.patchBytes);
      await emitOperationPermissionOutputs(env, decision, snapshot);
      return decision;
    }
    if (rolePolicy.fallback) {
      const fallback = await optionalAssessment(fallbackDirectory, rolePolicy.fallback);
      if (fallback) records.push(fallback);
    }
  }
  const assessments = records.map(record => record.patchBytes === undefined ? record.value : { assessment: record.value, patchBytes: record.patchBytes });
  let reduction = reduceAssessments({ snapshot, rolePolicy, assessments });
  if (reduction.status === "fallback" && fallbackAttempted) reduction = Object.freeze({ status: "terminal", provider: null, reason: "providers_unavailable" });
  if (reduction.status !== "artifact") {
    if (reduction.status === "terminal") {
      const decision = reduceStatusArtifact({ snapshot, rolePolicy, reduction, assessments });
      await writeTransportArtifact("decision", decisionDirectory, decision);
      await emitOperationPermissionOutputs(env, decision, snapshot);
    }
    return reduction;
  }
  const decision = reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments });
  let patchBytes;
  if (decision.patch) {
    const selected = records.find(record => reduction.selected.includes(digestJson(record.value)));
    patchBytes = selected?.patchBytes;
    if (!Buffer.isBuffer(patchBytes)) inputError("selected patch sidecar is missing");
  }
  await writeTransportArtifact("decision", decisionDirectory, decision, patchBytes);
  await emitOperationPermissionOutputs(env, decision, snapshot);
  return decision;
}

function reconciliationRequest(snapshot) {
  const value = snapshot.state?.reconciliation;
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) inputError("reconciliation snapshot state is missing");
  exactObject(value, ["routes", "pulls", "labelSync", "comments", "trust", "reviews", "pioneers", "holds", "cancelledApplies"], "reconciliation snapshot state");
  return { snapshot, ...value };
}

async function controlDecisionCommand(name, env, executablePath) {
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const decisionDirectory = environmentPath(env, "ADW_DECISION_ARTIFACT");
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  await separated([sourceDirectory, snapshotDirectory, decisionDirectory]);
  const snapshot = (await readTransportArtifact("snapshot", snapshotDirectory)).value;
  const authority = controlAuthority(name);
  if (snapshot.routing.role !== authority.name || snapshot.routing.mode !== "single" || snapshot.routing.primary !== null || snapshot.controlSha !== controlSha) inputError(`${name} authority binding is invalid`);
  const source = await readSourceArtifact(sourceDirectory, authority, snapshot);
  if (source.manifest.controlSha !== controlSha || !canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository))) inputError("control or repository binding is invalid");
  let decision;
  if (name === "reconciler") {
    const intents = planReconciliation(reconciliationRequest(snapshot));
    const operations = mapReconciliationIntents({ snapshot, intents });
    decision = reduceControlArtifact({ name, snapshot, operations });
  } else if (name === "auditor") {
    decision = planAudit(snapshot);
  } else inputError("control decision command is unsupported");
  await writeTransportArtifact("decision", decisionDirectory, decision);
  await emitOperationPermissionOutputs(env, decision, snapshot);
  return decision;
}

async function verifyCommand(env, adapters, executablePath) {
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const decisionDirectory = environmentPath(env, "ADW_DECISION_ARTIFACT");
  const verificationDirectory = environmentPath(env, "ADW_VERIFICATION_ARTIFACT");
  const targetDirectory = environmentPath(env, "ADW_TARGET_DIRECTORY");
  const temporaryDirectory = environmentPath(env, "ADW_TEMPORARY_DIRECTORY");
  const gitPath = environmentPath(env, "ADW_GIT_PATH");
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  await separated([sourceDirectory, snapshotDirectory, decisionDirectory, verificationDirectory, targetDirectory, temporaryDirectory, gitPath]);
  const snapshot = (await readTransportArtifact("snapshot", snapshotDirectory)).value;
  const rolePolicy = resolveAuthority(snapshot.routing.role);
  const source = await readSourceArtifact(sourceDirectory, rolePolicy, snapshot);
  const decisionRecord = await readTransportArtifact("decision", decisionDirectory);
  const decision = decisionRecord.value;
  if (snapshot.controlSha !== controlSha || source.manifest.controlSha !== controlSha || decision.controlSha !== controlSha) inputError("control SHA does not match");
  if (decision.snapshotDigest !== digestJson(snapshot)) inputError("decision snapshot digest does not match");
  if (!canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository))) inputError("repository binding does not match");
  const decisionDigest = digestJson(decision);
  const preconditionDigest = digestJson(snapshot.revisions);
  let verification;
  if (decision.kind === "patch") {
    if (rolePolicy.patch === null) throw new AdwError("verification", "role does not permit patches");
    const vcs = adapters?.vcs ?? createDefaultVcs(gitPath);
    await materializeTarget(vcs, source, targetDirectory);
    const verifier = vcs?.verifyPatch ?? verifyPatch;
    verification = await verifier({
      executable: gitPath,
      repository: targetDirectory,
      temporaryDirectory,
      controlDirectory: source.controlDirectory,
      baseSha: decision.patch.baseSha,
      patchBytes: decisionRecord.patchBytes,
      manifest: decision.patch,
      rolePolicy,
      controlSha,
      decisionDigest,
      preconditionDigest,
    });
  } else {
    if (decision.kind !== "state") throw new AdwError("verification", "terminal decision cannot be verified");
    verification = validateVerification({ schemaVersion: 1, controlSha, decisionDigest, kind: "state", preconditionDigest, patch: null, resultTree: null });
  }
  verification = validateVerification(verification);
  if (verification.controlSha !== controlSha || verification.decisionDigest !== decisionDigest || verification.preconditionDigest !== preconditionDigest || verification.kind !== decision.kind) throw new AdwError("verification", "verification binding does not match");
  await writeTransportArtifact("verification", verificationDirectory, verification, decisionRecord.patchBytes);
  return verification;
}

async function dryRunCommand(env, adapters, executablePath) {
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const decisionDirectory = environmentPath(env, "ADW_DECISION_ARTIFACT");
  const verificationDirectory = environmentPath(env, "ADW_VERIFICATION_ARTIFACT");
  const output = environmentPath(env, "ADW_DRY_RUN_ARTIFACT");
  const repositoryName = environmentId(env, "ADW_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  await separated([sourceDirectory, snapshotDirectory, decisionDirectory, verificationDirectory, output]);
  const snapshot = (await readTransportArtifact("snapshot", snapshotDirectory)).value;
  const authority = canonicalAuthority(snapshot);
  const source = await readSourceArtifact(sourceDirectory, authority, snapshot);
  const decisionRecord = await readTransportArtifact("decision", decisionDirectory);
  const verificationRecord = await readTransportArtifact("verification", verificationDirectory);
  const decision = decisionRecord.value;
  const verification = verificationRecord.value;
  if (snapshot.controlSha !== controlSha || source.manifest.controlSha !== controlSha || decision.controlSha !== controlSha || verification.controlSha !== controlSha || `${snapshot.repository.owner}/${snapshot.repository.name}` !== repositoryName || !canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository)) || decision.snapshotDigest !== digestJson(snapshot) || verification.decisionDigest !== digestJson(decision) || verification.preconditionDigest !== digestJson(snapshot.revisions)) inputError("dry-run artifact binding is invalid");
  if ((decisionRecord.patchBytes === undefined) !== (verificationRecord.patchBytes === undefined) || (decisionRecord.patchBytes && !decisionRecord.patchBytes.equals(verificationRecord.patchBytes))) inputError("dry-run patch artifacts do not match");
  for (const operation of decision.operations) validateOperation(operation, authority);
  const githubFactory = adapters?.githubFactory ?? createDefaultGitHub;
  const github = adapters?.github ?? githubFactory(repositoryName);
  if (!github || typeof github.recordApply !== "function") inputError("dry-run record writer is unavailable");
  const patchCarrier = decision.kind === "patch" ? decision.operations.findIndex(operation => ["create_branch", "create_pr", "update_pr"].includes(operation.type)) : -1;
  if (decision.kind === "patch" && patchCarrier < 0) inputError("dry-run patch projection is invalid");
  let vcsReceipt = null;
  if (patchCarrier >= 0) {
    const targetDirectory = environmentPath(env, "ADW_TARGET_DIRECTORY");
    const temporaryDirectory = environmentPath(env, "ADW_TEMPORARY_DIRECTORY");
    const gitPath = environmentPath(env, "ADW_GIT_PATH");
    await separated([sourceDirectory, snapshotDirectory, decisionDirectory, verificationDirectory, output, targetDirectory, temporaryDirectory, gitPath]);
    const vcs = adapters?.vcs ?? createDefaultVcs(gitPath);
    await materializeTarget(vcs, source, targetDirectory);
    if (typeof vcs?.projectVerifiedPatch !== "function") inputError("VCS read-only projection is unavailable");
    const projectionAuthority = adapters?.vcsAuthority ?? (typeof github.vcsProjectionAuthority === "function" ? github.vcsProjectionAuthority({ capabilities: applyCapabilities(decision, snapshot).all }) : null);
    if (!projectionAuthority || typeof projectionAuthority.expectedRemote !== "string") inputError("VCS projection authority is unavailable");
    const raw = await vcs.projectVerifiedPatch({
      repository: targetDirectory, temporaryDirectory, expectedRemote: projectionAuthority.expectedRemote,
      signing: adapters?.signing ?? { mode: "unsigned" }, snapshot, decision, verification,
      patchBytes: decisionRecord.patchBytes, operation: decision.operations[patchCarrier], operationIndex: patchCarrier,
    });
    vcsReceipt = applyReceipt(raw, "vcs_head", digestJson(decision.operations[patchCarrier]));
  }
  const vcsProjections = vcsReceipt === null || decision.operations[patchCarrier].type === "create_branch" ? [] : [{ operationDigest: vcsReceipt.operationDigest, headSha: vcsReceipt.headSha }];
  const recorded = await github.recordApply({ decision, snapshot, verification, previousReceipt: null, vcsProjections });
  if (!recorded || !Array.isArray(recorded.intents) || recorded.receipt?.decisionDigest !== verification.decisionDigest || recorded.receipt?.verificationDigest !== digestJson(verification)) inputError("dry-run record result is invalid");
  const githubIntents = new Set(recorded.intents.map(digestJson));
  const intents = [];
  if (patchCarrier >= 0) intents.push({ projection: "vcs_head", operationIndex: patchCarrier, operationDigest: digestJson(decision.operations[patchCarrier]), operation: decision.operations[patchCarrier], vcsReceipt });
  for (const [operationIndex, operation] of decision.operations.entries()) {
    if (operation.type === "create_branch" || !githubIntents.has(digestJson(operation))) continue;
    intents.push({ projection: operationIndex === patchCarrier ? "github_metadata" : "github_state", operationIndex, operationDigest: digestJson(operation), operation });
  }
  const capabilities = applyCapabilities(decision, snapshot);
  validateAuthorityCapabilities(authority, capabilities.all);
  const result = Object.freeze({
    schemaVersion: 1, controlSha, sourceDigest: digestJson(source.manifest), snapshotDigest: digestJson(snapshot),
    decisionDigest: digestJson(decision), verificationDigest: digestJson(verification), preconditionDigest: verification.preconditionDigest,
    authority: Object.freeze({ name: authority.name, digest: digestJson(authority), capabilities: capabilities.all }),
    operations: Object.freeze(decision.operations.map((operation, index) => Object.freeze({ index, operationDigest: digestJson(operation), operation }))),
    intents: Object.freeze(intents),
  });
  const bytes = canonicalBytes(result);
  await writeDryRunArtifact(output, bytes, digestBytes(bytes), sourceDirectory);
  return result;
}

async function applyCommand(env, adapters, executablePath) {
  bindJobScopedTokenExpiry(env);
  const sourceDirectory = environmentPath(env, "ADW_SOURCE_ARTIFACT");
  await requireTransportExecutable(executablePath, sourceDirectory);
  const snapshotDirectory = environmentPath(env, "ADW_SNAPSHOT_ARTIFACT");
  const decisionDirectory = environmentPath(env, "ADW_DECISION_ARTIFACT");
  const verificationDirectory = environmentPath(env, "ADW_VERIFICATION_ARTIFACT");
  const resultDirectory = environmentPath(env, "ADW_APPLY_RESULT_ARTIFACT");
  const hasPreviousRoot = env.ADW_PREVIOUS_APPLY_RESULTS_ROOT !== undefined;
  const hasRunAttempt = env.ADW_RUN_ATTEMPT !== undefined;
  if (hasPreviousRoot !== hasRunAttempt) inputError("prior apply result environment is incomplete");
  const previousRoot = hasPreviousRoot ? environmentPath(env, "ADW_PREVIOUS_APPLY_RESULTS_ROOT") : null;
  const runAttempt = hasRunAttempt ? Number(environmentId(env, "ADW_RUN_ATTEMPT", /^[1-9][0-9]*$/)) : 1;
  if (!Number.isSafeInteger(runAttempt)) inputError("run attempt is invalid");
  const repositoryName = environmentId(env, "ADW_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const controlSha = environmentId(env, "ADW_CONTROL_SHA", SHA);
  const paths = [sourceDirectory, snapshotDirectory, decisionDirectory, verificationDirectory, resultDirectory, ...(previousRoot ? [previousRoot] : [])];
  await separated(paths);

  const snapshot = (await readTransportArtifact("snapshot", snapshotDirectory)).value;
  const authority = canonicalAuthority(snapshot);
  const source = await readSourceArtifact(sourceDirectory, authority, snapshot);
  const decisionRecord = await readTransportArtifact("decision", decisionDirectory);
  const verificationRecord = await readTransportArtifact("verification", verificationDirectory);
  const decision = decisionRecord.value;
  const verification = verificationRecord.value;
  if (snapshot.controlSha !== controlSha || decision.controlSha !== controlSha || verification.controlSha !== controlSha || source.manifest.controlSha !== controlSha || `${snapshot.repository.owner}/${snapshot.repository.name}` !== repositoryName || !canonicalBytes(source.manifest.repository).equals(canonicalBytes(snapshot.repository))) inputError("apply control or repository binding is invalid");
  if (decision.snapshotDigest !== digestJson(snapshot) || verification.decisionDigest !== digestJson(decision) || verification.preconditionDigest !== digestJson(snapshot.revisions)) inputError("apply digest binding is invalid");
  const patchBytes = decisionRecord.patchBytes;
  if ((patchBytes === undefined) !== (verificationRecord.patchBytes === undefined) || (patchBytes && !patchBytes.equals(verificationRecord.patchBytes))) inputError("apply patch artifacts do not match");
  const capabilities = applyCapabilities(decision, snapshot);
  const previousReceipt = previousRoot === null ? null : await readPreviousApplyResult(previousRoot, runAttempt);
  const githubFactory = adapters?.githubFactory ?? createDefaultGitHub;
  const github = adapters?.github ?? githubFactory(repositoryName);
  if (!github || typeof github.apply !== "function") inputError("GitHub writer is unavailable");
  const declared = github.operationTokenCapabilities?.() ?? adapters?.githubCapabilities ?? null;
  if (declared !== null && digestJson(sortedCapabilities(declared, "declared GitHub capabilities")) !== digestJson(capabilities.github)) inputError("operation-scoped GitHub capabilities do not match decision");
  if (declared === null && !adapters && capabilities.github.length > 0) inputError("operation-scoped GitHub capabilities are missing");

  let vcs = null;
  let vcsRequest = null;
  if (decision.kind === "patch") {
    const targetDirectory = environmentPath(env, "ADW_TARGET_DIRECTORY");
    const temporaryDirectory = environmentPath(env, "ADW_TEMPORARY_DIRECTORY");
    const gitPath = environmentPath(env, "ADW_GIT_PATH");
    await separated([...paths, targetDirectory, temporaryDirectory, gitPath]);
    vcs = adapters?.vcs ?? createDefaultVcs(gitPath);
    await materializeTarget(vcs, source, targetDirectory);
    const projectionAuthority = adapters?.vcsAuthority ?? (typeof github.vcsProjectionAuthority === "function" ? github.vcsProjectionAuthority({ capabilities: capabilities.all }) : null);
    if (!projectionAuthority || typeof projectionAuthority.expectedRemote !== "string" || typeof projectionAuthority.credential !== "function") inputError("VCS projection authority is unavailable");
    vcsRequest = {
      repository: targetDirectory,
      temporaryDirectory,
      expectedRemote: projectionAuthority.expectedRemote,
      credential: adapters?.vcsCredential ?? projectionAuthority.credential,
      signing: adapters?.signing ?? { mode: "unsigned" },
    };
  }
  const sourceDigest = digestJson(source.manifest);
  const result = await composeApply({ sourceDigest, snapshot, decision, verification, patchBytes, previousReceipt, github, vcs, vcsRequest });
  await writeTransportArtifact("applyResult", resultDirectory, result);
  if (result.failure !== null) throw new AdwError(result.failure.code, result.failure.message, { partialReceipt: result });
  return result;
}

const REDUCE_ENV = new Set(["ADW_SOURCE_ARTIFACT", "ADW_SNAPSHOT_ARTIFACT", "ADW_PRIMARY_ASSESSMENT_ARTIFACT", "ADW_FALLBACK_ASSESSMENT_ARTIFACT", "ADW_DECISION_ARTIFACT", "ADW_CONTROL_SHA"]);

function operationalCommand(argv, env) {
  if (argv[0] === "prepare") return argv.length === 1 ? "prepare" : "invalid";
  if (argv[0] === "assess") return argv.length === 3 && argv[1] === "--provider" ? "assess" : "invalid";
  if (argv[0] === "verify") return argv.length === 1 ? "verify" : "invalid";
  if (argv[0] === "apply") return argv.length === 1 ? "apply" : "invalid";
  if (argv[0] === "dry-run" && Object.hasOwn(env ?? {}, "ADW_SOURCE_ARTIFACT")) return argv.length === 1 ? "dry-run" : "invalid";
  if (argv[0] === "reduce" && Object.keys(env ?? {}).some(name => REDUCE_ENV.has(name))) return argv.length === 1 ? "reduce" : "invalid";
  if ((argv[0] === "reconcile" || argv[0] === "audit") && Object.hasOwn(env ?? {}, "ADW_SOURCE_ARTIFACT")) return argv.length === 1 ? argv[0] : "invalid";
  return null;
}

export async function run({ argv, env = {}, stdin, stdout, stderr, readFixture, adapters, writeArtifact, executablePath }) {
  let artifactInput = false;
  try {
    if (!Array.isArray(argv) || argv.length === 0) inputError("command is required");
    const operation = operationalCommand(argv, env);
    if (operation === "invalid") inputError("operational arguments are invalid");
    if (operation !== null) {
      artifactInput = operation !== "prepare";
      let operationalResult;
      if (operation === "prepare") operationalResult = await prepareCommand(env, adapters);
      else if (operation === "assess") operationalResult = await assessCommand(argv[2], env, adapters, executablePath);
      else if (operation === "reduce") operationalResult = await reduceCommand(env, executablePath);
      else if (operation === "reconcile") operationalResult = await controlDecisionCommand("reconciler", env, executablePath);
      else if (operation === "audit") operationalResult = await controlDecisionCommand("auditor", env, executablePath);
      else if (operation === "apply") operationalResult = await applyCommand(env, adapters, executablePath);
      else if (operation === "dry-run") operationalResult = await dryRunCommand(env, adapters, executablePath);
      else operationalResult = await verifyCommand(env, adapters, executablePath);
      stdout.write(`${canonicalBytes(operationalResult).toString()}\n`);
      if (operation === "assess" && operationalResult?.outcome === "unable") return 4;
      if (operationalResult?.status === "fallback") return 4;
      if (operationalResult?.status === "terminal") return new Set(["provider_unavailable", "providers_unavailable", "quorum_incomplete", "advisory_unavailable"]).has(operationalResult.reason) ? 4 : 6;
      return 0;
    }
    const fixtureIndex = argv.indexOf("--fixture");
    const withoutFixture = fixtureIndex === -1 ? [...argv] : argv.slice(0, fixtureIndex);
    const outputIndex = withoutFixture.indexOf("--output");
    const outputDirectory = outputIndex === -1 ? null : withoutFixture[outputIndex + 1];
    const args = outputIndex === -1 ? withoutFixture : [...withoutFixture.slice(0, outputIndex), ...withoutFixture.slice(outputIndex + 2)];
    const recordTypes = new Set(["snapshot", "assessment", "decision", "verification"]);
    const supported =
      (args[0] === "validate" && args.length === 2 && recordTypes.has(args[1])) ||
      (args[0] === "reduce" && args.length === 1) ||
      (args[0] === "reconcile" && args.length === 1) ||
      (args[0] === "dry-run" && args.length === 1 && typeof outputDirectory === "string" && outputDirectory.startsWith("/"));
    if (!supported) inputError("command is unsupported");
    artifactInput = args[0] === "reduce" || (args[0] === "validate" && args[1] !== "snapshot");
    const text = await source(argv, stdin, readFixture);
    const value = parse(text);
    let result;
    if (args[0] === "validate" && args.length === 2) {
      const validators = {
        snapshot: validateSnapshot,
        assessment: validateAssessment,
        decision: validateDecision,
        verification: validateVerification,
      };
      const validator = validators[args[1]];
      if (!validator) inputError("record type is unsupported");
      artifactInput = args[1] !== "snapshot";
      result = validator(value);
    } else if (args[0] === "reduce" && args.length === 1) {
      artifactInput = true;
      if (!value || Array.isArray(value) || typeof value !== "object") inputError("reduce request must be an object");
      const keys = Object.keys(value).sort();
      if (keys.length !== 2 || keys.some((key, i) => key !== ["assessments", "snapshot"][i])) throw new AdwError("contract", "reduce request has invalid fields");
      if (!Array.isArray(value.assessments)) throw new AdwError("contract", "reduce assessments must be an array");
      const snapshot = validateSnapshot(value.snapshot);
      const rolePolicy = role(snapshot.routing.role);
      const assessments = value.assessments.map(entry => {
        const assessment = entry?.assessment ?? entry;
        if (assessment?.patch === null) return assessment;
        if (!entry || entry.assessment !== assessment || typeof entry.patchBase64 !== "string" || Object.keys(entry).sort().join(",") !== "assessment,patchBase64") throw new AdwError("contract", "patched assessment sidecar is missing");
        if (entry.patchBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.patchBase64)) throw new AdwError("contract", "patch sidecar encoding is invalid");
        const patchBytes = Buffer.from(entry.patchBase64, "base64");
        if (patchBytes.toString("base64") !== entry.patchBase64) throw new AdwError("contract", "patch sidecar encoding is invalid");
        return { assessment, patchBytes };
      });
      const reduction = reduceAssessments({ snapshot, rolePolicy, assessments });
      result = reduction.status === "artifact"
        ? reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments })
        : reduction;
    } else if (args[0] === "reconcile" && args.length === 1) {
      result = planReconciliation(value);
    } else if (args[0] === "dry-run") {
      if (!value || Array.isArray(value) || typeof value !== "object") inputError("dry-run request must be an object");
      const keys = Object.keys(value).sort();
      const expected = ["controlSha", "event", "eventName", "live", "operations", "repository", "repositoryPath", "schemaVersion"].sort();
      if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) inputError("dry-run request has invalid fields");
      if (value.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(value.controlSha) || typeof value.live !== "boolean" || !Array.isArray(value.operations)) inputError("dry-run request is invalid");
      const activeAdapters = adapters ?? { vcs: createDefaultVcs(), githubFactory: value.live ? createDefaultGitHub : createDryRunGitHub };
      const artifactWriter = writeArtifact ?? writeDryRunArtifact;
      if (!activeAdapters?.vcs?.head || !activeAdapters?.githubFactory || typeof artifactWriter !== "function") inputError("dry-run adapters are unavailable");
      const liveHead = await activeAdapters.vcs.head(value.repositoryPath);
      if (liveHead !== value.controlSha) throw new AdwError("stale", "control SHA changed");
      const event = normalizeEvent(value.eventName, value.event);
      if (`${event.repository.owner}/${event.repository.name}` !== value.repository) inputError("event repository does not match request");
      const github = activeAdapters.githubFactory(value.repository);
      for (const operation of value.operations) github.record(operation);
      let live = null;
      if (value.live) {
        if (typeof github.readSnapshot !== "function") inputError("live snapshot reader is unavailable");
        live = await github.readSnapshot(event);
      }
      result = { schemaVersion: 1, controlSha: value.controlSha, event, snapshot: { live }, intents: github.intents() };
      const bytes = canonicalBytes(result);
      await artifactWriter(outputDirectory, bytes, digestBytes(bytes), value.repositoryPath);
    } else {
      inputError("command is unsupported");
    }
    stdout.write(`${canonicalBytes(result).toString()}\n`);
    if (result?.status === "fallback") return 4;
    if (result?.status === "terminal") {
      return new Set(["provider_unavailable", "providers_unavailable", "quorum_incomplete", "advisory_unavailable"]).has(result.reason) ? 4 : 6;
    }
    return 0;
  } catch (error) {
    const code = errorCode(error, artifactInput);
    const category = error instanceof AdwError ? error.code : "input";
    stderr.write(`${canonicalBytes({ error: category, message: safeMessage(error) }).toString()}\n`);
    return code;
  }
}

async function localFixture(name) {
  return readFile(new URL(`./test/fixtures/${name}`, import.meta.url), "utf8");
}

export async function writeDryRunArtifact(directory, bytes, digest, repositoryPath) {
  if (!Buffer.isBuffer(bytes) || digest !== digestBytes(bytes)) inputError("artifact digest does not match");
  const value = parse(bytes.toString("utf8"));
  if (!canonicalBytes(value).equals(bytes)) inputError("artifact JSON is not canonical");
  await separated([directory], [repositoryPath]);
  const output = await outputDirectory(directory);
  await createArtifactFile(output, "dry-run.json", bytes);
  await createArtifactFile(output, "dry-run.sha256", `${digest}\n`);
  await assertOutputDirectory(output);
}

export async function execute({ argv, env = process.env, stdin, stdout, stderr, readFixture, adapters, writeArtifact, executablePath = process.argv[1] }) {
  try {
    return await run({ argv, env, stdin: await readBounded(stdin), stdout, stderr, readFixture, adapters, writeArtifact, executablePath });
  } catch (error) {
    const category = error instanceof AdwError ? error.code : "input";
    stderr.write(`${canonicalBytes({ error: category, message: safeMessage(error) }).toString()}\n`);
    return errorCode(error, isArtifactCommand(argv));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await execute({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    executablePath: process.argv[1],
    readFixture: localFixture,
  });
}
