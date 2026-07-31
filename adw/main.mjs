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
  planReconciliation,
  reduceAssessments,
  validateAssessment,
  validateAssessmentArtifact,
  validateDecision,
  validateSnapshot,
  validateVerification,
} from "./core.mjs";
import { createDefaultGitHub, createDryRunGitHub, normalizeEvent } from "./github.mjs";
import { installProvider, invokeProvider, PROVIDER_PINS } from "./providers.mjs";
import { reduceRoleArtifact, role, validateRolePayload } from "./roles.mjs";
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
  const output = await outputDirectory(directory);
  if (typeof controlAdapter !== "function" || typeof bundleAdapter !== "function") inputError("source adapters are unavailable");
  const controlResult = await controlAdapter({ repository: controlCheckout, controlSha, requiredPaths: [rolePolicy.charter, rolePolicy.payloadSchema], hardening: HARDENING });
  exactObject(controlResult, ["paths"], "control result");
  if (!Array.isArray(controlResult.paths) || controlResult.paths.length === 0) inputError("control result is invalid");
  const controlPaths = [];
  for (const item of [...controlResult.paths].sort((a, b) => a.path.localeCompare(b.path))) {
    exactObject(item, ["path", "tree", "blob", "bytes"], "control result path");
    if (!safeRelativePath(item.path) || !SHA.test(item.tree) || !SHA.test(item.blob) || !Buffer.isBuffer(item.bytes)) inputError("control result path is invalid");
    await createArtifactFile(output, `control/${item.path}`, item.bytes, 0o400);
    controlPaths.push({ path: item.path, tree: item.tree, blob: item.blob, digest: digestBytes(item.bytes), size: item.bytes.length });
  }
  if (!controlPaths.some(item => item.path === "adw/main.mjs") || !controlPaths.some(item => item.path === rolePolicy.charter) || !controlPaths.some(item => item.path === rolePolicy.payloadSchema)) inputError("control result is incomplete");
  for (const path of [rolePolicy.charter, rolePolicy.payloadSchema]) {
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
  if (!expectedPaths.includes("adw/main.mjs") || (rolePolicy && (!expectedPaths.includes(rolePolicy.charter) || !expectedPaths.includes(rolePolicy.payloadSchema)))) inputError("source control files are missing");
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

async function prepareCommand(env, adapters) {
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
  const rolePolicy = role(roleName);
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
  const snapshot = validateSnapshot(await github.readRoleSnapshot(event, rolePolicy, { controlSha, appId }));
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
      return decision;
    }
    if (rolePolicy.fallback) {
      const fallback = await optionalAssessment(fallbackDirectory, rolePolicy.fallback);
      if (fallback) records.push(fallback);
    }
  }
  const assessments = records.map(record => record.patchBytes === undefined ? record.value : { assessment: record.value, patchBytes: record.patchBytes });
  const reduction = reduceAssessments({ snapshot, rolePolicy, assessments });
  if (reduction.status !== "artifact") return reduction;
  const decision = reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments });
  let patchBytes;
  if (decision.patch) {
    const selected = records.find(record => reduction.selected.includes(digestJson(record.value)));
    patchBytes = selected?.patchBytes;
    if (!Buffer.isBuffer(patchBytes)) inputError("selected patch sidecar is missing");
  }
  await writeTransportArtifact("decision", decisionDirectory, decision, patchBytes);
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
  const rolePolicy = role(snapshot.routing.role);
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

const REDUCE_ENV = new Set(["ADW_SOURCE_ARTIFACT", "ADW_SNAPSHOT_ARTIFACT", "ADW_PRIMARY_ASSESSMENT_ARTIFACT", "ADW_FALLBACK_ASSESSMENT_ARTIFACT", "ADW_DECISION_ARTIFACT", "ADW_CONTROL_SHA"]);

function operationalCommand(argv, env) {
  if (argv[0] === "prepare") return argv.length === 1 ? "prepare" : "invalid";
  if (argv[0] === "assess") return argv.length === 3 && argv[1] === "--provider" ? "assess" : "invalid";
  if (argv[0] === "verify") return argv.length === 1 ? "verify" : "invalid";
  if (argv[0] === "reduce" && Object.keys(env ?? {}).some(name => REDUCE_ENV.has(name))) return argv.length === 1 ? "reduce" : "invalid";
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
      else operationalResult = await verifyCommand(env, adapters, executablePath);
      stdout.write(`${canonicalBytes(operationalResult).toString()}\n`);
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
