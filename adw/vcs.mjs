import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  digestJson,
  validateDecision,
  validatePatchManifest,
  validateSnapshot,
  validateVerification,
} from "./core.mjs";
import { runProcess } from "./providers.mjs";

function verification(message) {
  throw new AdwError("verification", message);
}

function stale(message) {
  throw new AdwError("stale", message);
}

function terminal(message) {
  throw new AdwError("terminal", message);
}

function outside(repository, temporary) {
  return temporary !== repository && !temporary.startsWith(`${repository}${sep}`) && !repository.startsWith(`${temporary}${sep}`);
}

export async function readHead({ executable, repository, run = runProcess }) {
  if (typeof executable !== "string" || !isAbsolute(executable) || typeof repository !== "string" || !isAbsolute(repository)) verification("path");
  const repo = await canonicalExisting(repository, "directory");
  const tool = await canonicalExisting(executable, "file");
  try {
    const result = await run({
      file: tool,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-C", repo, "rev-parse", "HEAD"],
      cwd: repo,
      env: { PATH: dirname(tool), HOME: repo, LANG: "C.UTF-8", TMPDIR: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      input: "", timeoutMs: 30_000, maxOutputBytes: 4096,
    });
    const head = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head)) verification("head");
    return head;
  } catch (error) {
    if (error instanceof AdwError && error.code === "verification") throw error;
    verification("git");
  }
}

const SHA = /^[0-9a-f]{40}$/;
const HARDENING = Object.freeze({ hooks: false, filters: false, fsmonitor: false, credentials: false, fileProtocol: false });
const EMPTY_BUNDLE = Buffer.from("# v2 git bundle\n\n");
const PREFIX = [
  "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never",
  "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.attributesFile=/dev/null",
];

function exactHardening(value) {
  if (!value || !canonicalBytes(value).equals(canonicalBytes(HARDENING))) verification("hardening");
}

function safePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && !path.includes("\n") && path.split("/").every(part => part && part !== "." && part !== ".." && part !== ".git");
}

async function canonicalExisting(path, kind) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) verification("path");
  const value = await realpath(path).catch(() => verification("path"));
  if (value !== path) verification("path");
  const stat = await lstat(path).catch(() => verification("path"));
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) verification("path");
  return value;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directoryIdentity(path) {
  const before = await lstat(path).catch(() => verification("path"));
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(path).catch(() => verification("path")) !== path) verification("path");
  const after = await lstat(path).catch(() => verification("path"));
  if (!after.isDirectory() || after.isSymbolicLink() || !sameInode(before, after)) verification("path");
  return { path, stat: after };
}

async function assertDirectoryIdentity(claim) {
  const current = await directoryIdentity(claim.path);
  if (!sameInode(current.stat, claim.stat)) verification("path");
}

async function privateTemporary(prefix, boundaries) {
  const root = await directoryIdentity(await canonicalExisting(tmpdir(), "directory"));
  const directory = await mkdtemp(join(root.path, prefix));
  const claim = await directoryIdentity(await canonicalExisting(directory, "directory"));
  await assertDirectoryIdentity(root);
  if (boundaries.some(boundary => !outside(boundary, claim.path))) {
    await rm(claim.path, { recursive: true, force: true }).catch(() => {});
    verification("path");
  }
  return { ...claim, parentClaim: root };
}

async function claimDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) verification("path");
  const parentClaim = await directoryIdentity(await canonicalExisting(dirname(path), "directory"));
  const target = join(parentClaim.path, path.slice(dirname(path).length + 1));
  try { await mkdir(target, { mode: 0o700 }); } catch { verification("path"); }
  const claim = await directoryIdentity(target);
  await assertDirectoryIdentity(parentClaim);
  return { ...claim, parentClaim };
}

async function assertClaim(claim) {
  await assertDirectoryIdentity(claim.parentClaim);
  await assertDirectoryIdentity(claim);
}

async function createPrivateFile(claim, path, bytes, mode = 0o600) {
  await assertClaim(claim);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const before = await handle.stat();
    if (!before.isFile()) verification("path");
    await handle.writeFile(bytes);
    const after = await handle.stat();
    if (!after.isFile() || !sameInode(before, after)) verification("path");
  } catch (error) {
    if (error instanceof AdwError) throw error;
    verification("path");
  } finally { await handle?.close(); }
  await assertClaim(claim);
}

function gitEnvironment(executable, temporary, extra = {}) {
  return {
    PATH: dirname(executable), HOME: temporary, LANG: "C.UTF-8", TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", ...extra,
  };
}

async function gitRun({ executable, repository, args, run = runProcess, temporary = repository, extraEnv = {}, binaryStdout = false, maxOutputBytes = 1_048_576 }) {
  try {
    return await run({
      file: executable, args: [...PREFIX, "-C", repository, ...args], cwd: repository,
      env: gitEnvironment(executable, temporary, extraEnv), input: "", timeoutMs: 120_000, maxOutputBytes, binaryStdout,
    });
  } catch (error) {
    if (error instanceof AdwError && error.code === "verification") throw error;
    verification("git");
  }
}

async function blobBytes(executable, repository, blob, run, temporary = repository) {
  const result = await gitRun({ executable, repository, args: ["cat-file", "blob", blob], run, temporary, binaryStdout: true, maxOutputBytes: 1_073_741_824 });
  return Buffer.from(result.stdout);
}

function parseTree(buffer, tree, strict = false) {
  const raw = Buffer.from(buffer);
  const text = raw.toString("utf8");
  if (!Buffer.from(text).equals(raw)) verification("manifest");
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths = [];
  for (const field of fields) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(field);
    if (!match || !safePath(match[4])) verification("manifest");
    if (!new Set(["100644", "100755", "120000"]).has(match[1]) || match[2] !== "blob" || (strict && !new Set(["100644", "100755"]).has(match[1]))) {
      if (strict) verification("manifest");
      continue;
    }
    paths.push({ mode: match[1], blob: match[3], path: match[4], tree });
  }
  return paths.sort((a, b) => a.path.localeCompare(b.path));
}

async function treeEntries(executable, repository, revision, run, temporary = repository, pathspecs = [], strict = false) {
  const tree = (await gitRun({ executable, repository, args: ["rev-parse", `${revision}^{tree}`], run, temporary })).stdout.trim();
  if (!SHA.test(tree)) verification("manifest");
  const listed = await gitRun({ executable, repository, args: ["ls-tree", "-r", "-z", tree, ...(pathspecs.length ? ["--", ...pathspecs] : [])], run, temporary, binaryStdout: true });
  return parseTree(listed.stdout, tree, strict);
}

async function readControl({ executable, repository, controlSha, requiredPaths, hardening, run = runProcess }) {
  exactHardening(hardening);
  const repo = await canonicalExisting(repository, "directory");
  const tool = await canonicalExisting(executable, "file");
  if (!SHA.test(controlSha) || !Array.isArray(requiredPaths) || requiredPaths.some(path => !safePath(path))) verification("manifest");
  const selected = await treeEntries(tool, repo, controlSha, run, repo, ["adw", ...requiredPaths], true);
  if (!requiredPaths.every(path => selected.some(item => item.path === path)) || !selected.some(item => item.path === "adw/main.mjs")) verification("manifest");
  const paths = [];
  for (const item of selected) paths.push({ path: item.path, tree: item.tree, blob: item.blob, bytes: await blobBytes(tool, repo, item.blob, run) });
  return Object.freeze({ paths });
}

async function bundleFile(path) {
  const stat = await lstat(path).catch(() => verification("bundle"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1_073_741_824) verification("bundle");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) verification("bundle");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== current.size || after.dev !== current.dev || after.ino !== current.ino || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) verification("bundle");
    return bytes;
  } finally { await handle?.close(); }
}

async function createBundle({ executable, repository, snapshot, allowedShas, hardening, run = runProcess }) {
  exactHardening(hardening);
  const repo = await canonicalExisting(repository, "directory");
  const tool = await canonicalExisting(executable, "file");
  if (!snapshot?.repository || !Array.isArray(allowedShas) || allowedShas.length > 1 || allowedShas.some(sha => !SHA.test(sha)) || new Set(allowedShas).size !== allowedShas.length) verification("manifest");
  const shas = [...allowedShas];
  if (shas.length === 0) return Object.freeze({ bytes: EMPTY_BUNDLE, repository: snapshot.repository, refs: [], shas: [], paths: [] });
  const temporaryClaim = await privateTemporary("adw-vcs-bundle-", [repo, tool]);
  const temporary = temporaryClaim.path;
  try {
    const bareClaim = await claimDirectory(join(temporary, "objects.git"));
    const bare = bareClaim.path;
    await gitRun({ executable: tool, repository: bare, args: ["init", "--bare", "-q"], run, temporary });
    await assertClaim(bareClaim);
    const objectPath = (await gitRun({ executable: tool, repository: repo, args: ["rev-parse", "--git-path", "objects"], run })).stdout.trim();
    const objectDirectory = await realpath(isAbsolute(objectPath) ? objectPath : join(repo, objectPath)).catch(() => verification("git"));
    const sourceRefs = (await gitRun({ executable: tool, repository: repo, args: ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"], run })).stdout.trim().split("\n").filter(Boolean).map(line => {
      const match = /^(refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+) ([0-9a-f]{40})$/.exec(line);
      if (!match) verification("manifest");
      return { name: match[1], sha: match[2] };
    });
    const refs = [];
    for (const [index, sha] of shas.entries()) {
      await gitRun({ executable: tool, repository: repo, args: ["cat-file", "-e", `${sha}^{commit}`], run });
      const matching = sourceRefs.filter(ref => ref.sha === sha);
      if (matching.length === 0) matching.push({ name: `refs/heads/adw-source/${String(index).padStart(3, "0")}`, sha });
      for (const ref of matching) {
        await gitRun({ executable: tool, repository: bare, args: ["update-ref", ref.name, ref.sha], run, temporary, extraEnv: { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory } });
        refs.push(ref);
      }
    }
    refs.sort((a, b) => a.name.localeCompare(b.name));
    const path = join(temporary, "target.bundle");
    await gitRun({ executable: tool, repository: bare, args: ["bundle", "create", path, ...refs.map(item => item.name)], run, temporary, extraEnv: { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory } });
    const bytes = await bundleFile(path);
    const paths = [];
    const byPath = new Map();
    for (const sha of shas) {
      for (const item of await treeEntries(tool, repo, sha, run)) {
        const bytesForPath = await blobBytes(tool, repo, item.blob, run);
        const value = { path: item.path, tree: item.tree, blob: item.blob, digest: digestBytes(bytesForPath), size: bytesForPath.length };
        const prior = byPath.get(item.path);
        if (prior && !canonicalBytes(prior).equals(canonicalBytes(value))) verification("manifest");
        if (!prior) { byPath.set(item.path, value); paths.push(value); }
      }
    }
    await assertClaim(bareClaim);
    await assertClaim(temporaryClaim);
    return Object.freeze({ bytes, repository: snapshot.repository, refs, shas, paths: paths.sort((a, b) => a.path.localeCompare(b.path)) });
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => verification("cleanup"));
  }
}

async function materializeBundle({ executable, bundle, directory, manifest, allowedRefs, allowedShas, allowedPaths, hardening, run = runProcess }) {
  exactHardening(hardening);
  const tool = await canonicalExisting(executable, "file");
  if (!Buffer.isBuffer(bundle) || digestBytes(bundle) !== manifest?.target?.bundle?.digest || bundle.length !== manifest?.target?.bundle?.size) verification("bundle");
  if (![allowedRefs, allowedShas, allowedPaths].every(Array.isArray) || allowedShas.length > 1 || !canonicalBytes(allowedRefs).equals(canonicalBytes(manifest.target.refs)) || !canonicalBytes(allowedShas).equals(canonicalBytes(manifest.target.shas)) || !canonicalBytes(allowedPaths).equals(canonicalBytes(manifest.target.paths))) verification("manifest");
  const repoClaim = await claimDirectory(directory);
  const repo = repoClaim.path;
  const bundlePath = join(repo, ".source.bundle");
  try {
    await createPrivateFile(repoClaim, bundlePath, bundle);
    await gitRun({ executable: tool, repository: repo, args: ["init", "-q"], run, temporary: repo });
    await assertClaim(repoClaim);
    await gitRun({ executable: tool, repository: repo, args: ["bundle", "verify", bundlePath], run, temporary: repo });
    if (allowedShas.length > 0) await gitRun({ executable: tool, repository: repo, args: ["bundle", "unbundle", bundlePath], run, temporary: repo });
    const listed = allowedShas.length === 0 ? [] : (await gitRun({ executable: tool, repository: repo, args: ["bundle", "list-heads", bundlePath], run, temporary: repo })).stdout.trim().split("\n").filter(Boolean).map(line => {
      const match = /^([0-9a-f]{40}) (refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/.exec(line);
      if (!match) verification("manifest");
      return { name: match[2], sha: match[1] };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (!canonicalBytes(listed).equals(canonicalBytes(allowedRefs))) verification("manifest");
    for (const ref of allowedRefs) await gitRun({ executable: tool, repository: repo, args: ["update-ref", ref.name, ref.sha], run, temporary: repo });
    for (const sha of allowedShas) await gitRun({ executable: tool, repository: repo, args: ["cat-file", "-e", `${sha}^{commit}`], run, temporary: repo });
    if (allowedShas.length > 0) {
      const expectedObjects = (await gitRun({ executable: tool, repository: repo, args: ["rev-list", "--objects", "--no-object-names", ...allowedRefs.map(ref => ref.name)], run, temporary: repo })).stdout.trim().split("\n").filter(Boolean).sort();
      const actualObjects = (await gitRun({ executable: tool, repository: repo, args: ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], run, temporary: repo })).stdout.trim().split("\n").filter(Boolean).sort();
      if (!canonicalBytes(actualObjects).equals(canonicalBytes(expectedObjects))) verification("manifest");
      const liveRefs = (await gitRun({ executable: tool, repository: repo, args: ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"], run, temporary: repo })).stdout.trim().split("\n").filter(Boolean).map(line => {
        const match = /^(refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+) ([0-9a-f]{40})$/.exec(line);
        if (!match) verification("manifest");
        return { name: match[1], sha: match[2] };
      }).sort((a, b) => a.name.localeCompare(b.name));
      if (!canonicalBytes(liveRefs).equals(canonicalBytes(allowedRefs))) verification("manifest");
    }
    for (const item of allowedPaths) {
      if (!safePath(item.path)) verification("manifest");
      const entry = (await gitRun({ executable: tool, repository: repo, args: ["ls-tree", item.tree, "--", item.path], run, temporary: repo })).stdout.trim();
      const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match || match[2] !== item.blob || match[3] !== item.path) verification("manifest");
      const bytes = await blobBytes(tool, repo, item.blob, run, repo);
      if (bytes.length !== item.size || digestBytes(bytes) !== item.digest) verification("manifest");
      const output = join(repo, item.path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      if (match[1] === "120000") {
        const target = bytes.toString("utf8");
        const resolvedTarget = resolve(dirname(output), target);
        if (!Buffer.from(target).equals(bytes) || !target || isAbsolute(target) || resolvedTarget === join(repo, ".git") || resolvedTarget.startsWith(`${join(repo, ".git")}${sep}`) || (resolvedTarget !== repo && !resolvedTarget.startsWith(`${repo}${sep}`))) verification("manifest");
        await symlink(target, output);
      } else {
        await createPrivateFile(repoClaim, output, bytes, match[1] === "100755" ? 0o700 : 0o600);
      }
    }
    if (allowedShas.length > 0) await gitRun({ executable: tool, repository: repo, args: ["update-ref", "HEAD", allowedShas[0]], run, temporary: repo });
    await assertClaim(repoClaim);
    return Object.freeze({ refs: allowedRefs, shas: allowedShas, paths: allowedPaths });
  } catch (error) {
    if (error instanceof AdwError) throw error;
    verification("git");
  } finally {
    await rm(bundlePath, { force: true }).catch(() => verification("cleanup"));
  }
}

async function walkWorktree(root, prefix = "") {
  const directory = prefix ? join(root, prefix) : root;
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safePath(relative) || (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink())) verification("patch");
    if (entry.isDirectory()) result.push(...await walkWorktree(root, relative));
    else result.push({ path: relative, symlink: entry.isSymbolicLink() });
  }
  return result;
}

async function capturePatch({ executable, repository, baseSha, manifest, rolePolicy, hardening, run = runProcess }) {
  exactHardening(hardening);
  const repo = await canonicalExisting(repository, "directory");
  const tool = await canonicalExisting(executable, "file");
  if (!SHA.test(baseSha) || baseSha !== manifest?.baseSha || (await readHead({ executable: tool, repository: repo, run })) !== baseSha) verification("patch");
  const temporaryClaim = await privateTemporary("adw-vcs-capture-", [repo, tool]);
  const temporary = temporaryClaim.path;
  const index = join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitRun({ executable: tool, repository: repo, args: ["read-tree", baseSha], run, temporary, extraEnv: env });
    const base = await treeEntries(tool, repo, baseSha, run, temporary);
    const worktree = await walkWorktree(repo);
    const present = new Set(worktree.map(item => item.path));
    for (const item of base) if (!present.has(item.path)) await gitRun({ executable: tool, repository: repo, args: ["update-index", "--force-remove", "--", item.path], run, temporary, extraEnv: env });
    for (const worktreeItem of worktree) {
      const path = worktreeItem.path;
      const full = join(repo, path);
      if (worktreeItem.symlink) {
        const baseItem = base.find(item => item.path === path && item.mode === "120000");
        const target = await readlink(full).catch(() => verification("patch"));
        const bytes = Buffer.from(target);
        if (!baseItem || !bytes.equals(await blobBytes(tool, repo, baseItem.blob, run, temporary))) verification("patch");
        continue;
      }
      const stat = await lstat(full);
      if (!stat.isFile() || stat.size > 1_073_741_824) verification("patch");
      let handle;
      let bytes;
      try {
        handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) verification("patch");
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (after.size !== current.size || after.dev !== current.dev || after.ino !== current.ino || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) verification("patch");
      } finally { await handle?.close(); }
      const blob = (await run({ file: tool, args: [...PREFIX, "-C", repo, "hash-object", "-w", "--stdin"], cwd: repo, env: gitEnvironment(tool, temporary, env), input: bytes, timeoutMs: 120_000, maxOutputBytes: 4096 })).stdout.trim();
      if (!SHA.test(blob)) verification("git");
      await gitRun({ executable: tool, repository: repo, args: ["update-index", "--add", "--cacheinfo", `${stat.mode & 0o111 ? "100755" : "100644"},${blob},${path}`], run, temporary, extraEnv: env });
    }
    const patchBytes = Buffer.from((await gitRun({ executable: tool, repository: repo, args: ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--full-index", "--no-renames", baseSha], run, temporary, extraEnv: env, binaryStdout: true })).stdout);
    if (!Buffer.from(patchBytes.toString("utf8")).equals(patchBytes) || patchBytes.includes(0) || patchBytes.includes(Buffer.from("GIT binary patch")) || patchBytes.includes(Buffer.from("Binary files "))) verification("binary");
    const raw = await gitRun({ executable: tool, repository: repo, args: ["diff", "--cached", "--raw", "-z", "--no-renames", baseSha], run, temporary, extraEnv: env, binaryStdout: true });
    const rawBytes = Buffer.from(raw.stdout);
    const rawText = rawBytes.toString("utf8");
    if (!Buffer.from(rawText).equals(rawBytes)) verification("manifest");
    const actual = { baseSha, digest: digestBytes(patchBytes), size: patchBytes.length, files: parseRaw(rawText) };
    try { validatePatchManifest(actual, rolePolicy); } catch { verification("manifest"); }
    if (!canonicalBytes(actual).equals(canonicalBytes(manifest))) verification("digest");
    await assertClaim(temporaryClaim);
    return Object.freeze({ manifest: actual, patchBytes });
  } catch (error) {
    if (error instanceof AdwError && error.code === "verification") throw error;
    verification("git");
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => verification("cleanup"));
  }
}

export function createDefaultVcs(executable = process.env.ADW_GIT_PATH) {
  if (!executable || !isAbsolute(executable)) verification("git path");
  return Object.freeze({
    head: repository => readHead({ executable, repository }),
    readControl: request => readControl({ executable, ...request }),
    createBundle: request => createBundle({ executable, ...request }),
    materializeBundle: request => materializeBundle({ executable, ...request }),
    capturePatch: request => capturePatch({ executable, ...request }),
    verifyPatch: request => verifyPatch({ executable, ...request }),
    applyVerifiedPatch: request => applyVerifiedPatch({ executable, ...request }),
    projectVerifiedPatch: request => projectVerifiedPatch({ executable, ...request }),
  });
}

function parseRaw(text) {
  if (typeof text !== "string") verification("manifest");
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) verification("manifest");
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    const header = fields[i];
    const path = fields[i + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([MAD])$/.exec(header);
    if (!match || !safePath(path)) verification("manifest");
    files.push({
      path,
      kind: "regular",
      oldMode: match[1] === "000000" ? "absent" : match[1],
      newMode: match[2] === "000000" ? "absent" : match[2],
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyPatch({
  executable,
  repository,
  temporaryDirectory,
  controlDirectory = process.cwd(),
  baseSha,
  patchBytes,
  manifest,
  rolePolicy,
  controlSha,
  decisionDigest,
  preconditionDigest,
  run = runProcess,
}) {
  if (![executable, repository, temporaryDirectory, controlDirectory].every(value => typeof value === "string" && isAbsolute(value))) verification("path");
  if (!Buffer.isBuffer(patchBytes)) verification("patch");
  const tool = await canonicalExisting(executable, "file");
  const repo = await canonicalExisting(repository, "directory");
  const temporary = await canonicalExisting(temporaryDirectory, "directory");
  const control = await canonicalExisting(controlDirectory, "directory");
  if (!outside(repo, temporary) || !outside(control, temporary) || !outside(repo, control) || !outside(repo, tool) || !outside(control, tool)) verification("path");
  if (baseSha !== manifest?.baseSha || patchBytes.length !== manifest?.size || digestBytes(patchBytes) !== manifest?.digest) verification("digest");
  if (patchBytes.includes(0) || patchBytes.includes(Buffer.from("GIT binary patch")) || patchBytes.includes(Buffer.from("Binary files "))) verification("binary");
  try {
    validatePatchManifest(manifest, rolePolicy);
  } catch {
    verification("manifest");
  }

  const id = randomUUID();
  const runClaim = await claimDirectory(join(temporary, `verify-${id}`));
  const runDirectory = runClaim.path;
  const indexPath = join(runDirectory, "index");
  const patchPath = join(runDirectory, "patch.diff");
  const env = {
    PATH: dirname(tool),
    HOME: runDirectory,
    LANG: "C.UTF-8",
    TMPDIR: runDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_INDEX_FILE: indexPath,
  };
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never"];
  const command = async args => {
    try {
      return await run({
        file: tool,
        args: [...prefix, "-C", repo, ...args],
        cwd: repo,
        env,
        input: "",
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
      });
    } catch {
      verification("git");
    }
  };

  try {
    await createPrivateFile(runClaim, patchPath, patchBytes);
    await command(["read-tree", baseSha]);
    await assertClaim(runClaim);
    await command(["apply", "--check", "--cached", patchPath]);
    await command(["apply", "--cached", patchPath]);
    const raw = await command(["diff", "--cached", "--raw", "-z", "--no-renames", baseSha]);
    const actual = parseRaw(raw.stdout);
    const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
    if (!canonicalBytes(actual).equals(canonicalBytes(expected))) verification("manifest");
    const resultTree = (await command(["write-tree"])).stdout.trim();
    await assertClaim(runClaim);
    return validateVerification({
      schemaVersion: 1,
      controlSha,
      decisionDigest,
      kind: "patch",
      preconditionDigest,
      patch: manifest,
      resultTree,
    });
  } finally {
    try { await rm(runDirectory, { recursive: true, force: true }); }
    catch { verification("cleanup"); }
  }
}

function exactKeys(value, keys) {
  return value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function safeBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/")
    && !value.endsWith(".") && !value.includes("..") && !value.includes("//")
    && !value.includes("@{") && !/[\x00-\x20~^:?*[\\]/.test(value)
    && value.split("/").every(part => part && part !== "." && part !== ".." && !part.endsWith(".lock"));
}

function githubRemote(snapshot) {
  const { owner, name } = snapshot.repository;
  if (![owner, name].every(value => /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value))) verification("remote");
  return `https://github.com/${owner}/${name}.git`;
}

function configEnvironment(entries) {
  const env = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function signingConfiguration(signing, { repository, executable, claim }) {
  if (exactKeys(signing, ["mode"]) && signing.mode === "unsigned") return { mode: "unsigned", entries: [] };
  if (!exactKeys(signing, ["mode", "format", "signerPath", "keyPath", "principal", "publicKey"])
      || signing.mode !== "signed" || signing.format !== "ssh"
      || typeof signing.principal !== "string" || !/^[A-Za-z0-9_.@+-]{1,255}$/.test(signing.principal)
      || typeof signing.publicKey !== "string" || !/^ssh-(?:rsa|ed25519) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(signing.publicKey)) {
    verification("signing");
  }
  const signer = await canonicalExisting(signing.signerPath, "file");
  const key = await canonicalExisting(signing.keyPath, "file");
  if (![signer, key].every(path => outside(repository, path)) || signer === executable) verification("signing");
  const allowed = join(claim.path, "allowed-signers");
  await createPrivateFile(claim, allowed, Buffer.from(`${signing.principal} ${signing.publicKey}\n`));
  return {
    mode: "signed",
    entries: [
      ["gpg.format", "ssh"], ["gpg.ssh.program", signer], ["user.signingKey", key],
      ["gpg.ssh.allowedSignersFile", allowed],
    ],
  };
}

function commitState(text) {
  const separator = text.indexOf("\n\n");
  if (separator < 0) verification("commit");
  const headers = text.slice(0, separator).split("\n");
  const identity = kind => {
    const line = headers.find(header => header.startsWith(`${kind} `));
    const match = /^(?:author|committer) (.+) <([^<>\r\n]+)> [0-9]+ [+-][0-9]{4}$/.exec(line ?? "");
    return match ? { name: match[1], email: match[2] } : null;
  };
  return {
    tree: headers.find(line => line.startsWith("tree "))?.slice(5),
    parents: headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7)),
    author: identity("author"), committer: identity("committer"),
    message: text.slice(separator + 2),
    signed: headers.some(line => line.startsWith("gpgsig ")),
  };
}

function boundRevision(snapshot, resource, kind, token) {
  const matches = snapshot.revisions.filter(revision => revision.resource === resource);
  return matches.length === 1 && matches[0].kind === kind && matches[0].token === token;
}

function expectedCommit(state, { tree, parent, signed, message, metadata = false }) {
  if (state.tree !== tree || state.parents.length !== 1 || state.parents[0] !== parent || state.signed !== signed) return false;
  if (!metadata) return true;
  const identity = { name: "smith[bot]", email: "smith[bot]@users.noreply.github.com" };
  return canonicalBytes(state.author).equals(canonicalBytes(identity))
    && canonicalBytes(state.committer).equals(canonicalBytes(identity)) && state.message === message;
}

/**
 * Applies only a patch already bound by a canonical decision and verification.
 * The returned record is one operation subreceipt; Task 5 may order it before
 * the GitHub metadata subreceipt carrying the same operation digest.
 */
async function verifiedPatchProjection({
  executable,
  repository,
  temporaryDirectory,
  expectedRemote,
  snapshot,
  decision,
  verification: proof,
  patchBytes,
  operation,
  operationIndex,
  credential,
  signing,
  run = runProcess,
  now = () => Date.now(),
}, readOnly) {
  let trustedSnapshot;
  let trustedDecision;
  let trustedProof;
  try {
    trustedSnapshot = validateSnapshot(snapshot);
    trustedDecision = validateDecision(decision);
    trustedProof = validateVerification(proof);
  } catch {
    verification("binding");
  }
  const decisionDigest = digestJson(trustedDecision);
  if (trustedDecision.controlSha !== trustedSnapshot.controlSha
      || trustedDecision.snapshotDigest !== digestJson(trustedSnapshot)
      || trustedProof.controlSha !== trustedDecision.controlSha
      || trustedProof.decisionDigest !== decisionDigest
      || trustedProof.preconditionDigest !== digestJson(trustedSnapshot.revisions)) verification("binding");

  const inferred = trustedDecision.operations
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => trustedDecision.kind === "state" ? candidate.type === "noop" : ["create_branch", "create_pr", "update_pr"].includes(candidate.type));
  const index = operationIndex === undefined
    ? (operation === undefined
        ? (inferred.length === 1 ? inferred[0].candidateIndex : -1)
        : trustedDecision.operations.findIndex(candidate => canonicalBytes(candidate).equals(canonicalBytes(operation))))
    : operationIndex;
  if (!Number.isInteger(index) || index < 0 || index >= trustedDecision.operations.length) verification("operation");
  const selected = trustedDecision.operations[index];
  if (operation !== undefined && !canonicalBytes(selected).equals(canonicalBytes(operation))) verification("operation");
  const operationDigest = digestJson(selected);

  if (trustedDecision.kind === "state" && trustedProof.kind === "state") {
    if (selected.type !== "noop") verification("operation");
    return Object.freeze({
      operationDigest, projection: "state", status: "complete",
      beforeRevision: trustedProof.preconditionDigest,
      preparedRevision: trustedProof.preconditionDigest,
      afterRevision: trustedProof.preconditionDigest,
      headSha: null,
    });
  }
  if (trustedDecision.kind !== "patch" || trustedProof.kind !== "patch" || !Buffer.isBuffer(patchBytes)
      || !canonicalBytes(trustedDecision.patch).equals(canonicalBytes(trustedProof.patch))
      || patchBytes.length !== trustedDecision.patch.size || digestBytes(patchBytes) !== trustedDecision.patch.digest) verification("binding");

  if (![executable, repository, temporaryDirectory, expectedRemote].every(value => typeof value === "string")
      || ![executable, repository, temporaryDirectory].every(isAbsolute)) verification("path");
  const tool = await canonicalExisting(executable, "file");
  const repo = await canonicalExisting(repository, "directory");
  const temporary = await canonicalExisting(temporaryDirectory, "directory");
  if (!outside(repo, temporary) || !outside(repo, tool) || !outside(temporary, tool)) verification("path");
  const exactRemote = githubRemote(trustedSnapshot);
  if (expectedRemote !== exactRemote) verification("remote");
  if ((!readOnly && typeof credential !== "function") || typeof now !== "function") verification("credential");

  const manifest = trustedDecision.patch;
  const baseSha = manifest.baseSha;
  const resultTree = trustedProof.resultTree;
  let branch;
  let baseBranch = null;
  let requireExisting = false;
  if (selected.type === "create_branch") {
    branch = selected.name;
    baseBranch = trustedSnapshot.repository.defaultBranch;
    if (selected.baseSha !== baseSha || selected.treeSha !== resultTree) verification("operation");
  } else if (selected.type === "create_pr") {
    branch = selected.head;
    baseBranch = selected.base;
    if (selected.base !== trustedSnapshot.repository.defaultBranch) verification("operation");
  } else if (selected.type === "update_pr") {
    branch = trustedSnapshot.state.headBranch;
    requireExisting = true;
    const pullResource = `pull:${trustedSnapshot.event.entityId}`;
    const pull = trustedSnapshot.state.resources?.[pullResource];
    const repositoryName = `${trustedSnapshot.repository.owner}/${trustedSnapshot.repository.name}`;
    if (!["pull_request", "pull_request_review", "pull_request_review_comment"].includes(trustedSnapshot.event.kind) || selected.prId !== trustedSnapshot.event.entityId
        || pull?.headRepository !== repositoryName || trustedSnapshot.state.headRepository !== repositoryName) verification("fork");
    if (pull.headBranch !== branch || pull.headSha !== trustedSnapshot.state.headSha
        || trustedSnapshot.state.headSha !== baseSha || (selected.headSha !== undefined && selected.headSha !== baseSha)
        || !boundRevision(trustedSnapshot, pullResource, "pull", baseSha)
        || !boundRevision(trustedSnapshot, `ref:${branch}`, "git_ref", baseSha)) verification("operation");
  } else {
    verification("operation");
  }
  if (!safeBranch(branch) || (baseBranch !== null && !safeBranch(baseBranch)) || branch === baseBranch) verification("ref");
  if (baseBranch !== null && !boundRevision(trustedSnapshot, `patch-base:${baseBranch}`, "git_ref", baseSha)) verification("operation");

  const gitClaim = await directoryIdentity(join(repo, ".git"));
  const sourceObjects = await directoryIdentity(join(gitClaim.path, "objects"));
  const runClaim = await claimDirectory(join(temporary, `apply-${randomUUID()}`));
  const runDirectory = runClaim.path;
  const indexPath = join(runDirectory, "index");
  const patchPath = join(runDirectory, "patch.diff");
  let receipt;
  try {
    const signingConfig = await signingConfiguration(signing, { repository: repo, executable: tool, claim: runClaim });
    const localEntries = [["commit.gpgSign", "false"], ...signingConfig.entries];
    const localEnv = {
      ...configEnvironment(localEntries), GIT_INDEX_FILE: indexPath,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects.path,
      GIT_AUTHOR_NAME: "smith[bot]", GIT_AUTHOR_EMAIL: "smith[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "smith[bot]", GIT_COMMITTER_EMAIL: "smith[bot]@users.noreply.github.com",
    };
    const sandbox = join(runDirectory, "repository.git");
    const command = async (args, { input = "", extraEnv = {}, remoteFailure = false, directory = sandbox } = {}) => {
      try {
        return await run({
          file: tool, args: [...PREFIX, "-C", directory, ...args], cwd: runDirectory,
          env: { ...gitEnvironment(tool, runDirectory), ...localEnv, ...extraEnv }, input,
          timeoutMs: 120_000, maxOutputBytes: 1_048_576,
        });
      } catch (error) {
        if (remoteFailure) stale("non-fast-forward");
        if (error instanceof AdwError && ["verification", "stale", "terminal"].includes(error.code)) throw error;
        verification("git");
      }
    };

    await command(["init", "--bare", "--template=", sandbox], { directory: runDirectory });
    await createPrivateFile(runClaim, patchPath, patchBytes);
    await command(["cat-file", "-e", `${baseSha}^{commit}`]);
    await command(["read-tree", baseSha]);
    await command(["apply", "--check", "--cached", patchPath]);
    await command(["apply", "--cached", patchPath]);
    const actual = parseRaw((await command(["diff", "--cached", "--raw", "-z", "--no-renames", baseSha])).stdout);
    if (!canonicalBytes(actual).equals(canonicalBytes([...manifest.files].sort((a, b) => a.path.localeCompare(b.path))))) verification("manifest");
    const writtenTree = (await command(["write-tree"])).stdout.trim();
    if (writtenTree !== resultTree || !SHA.test(writtenTree)) verification("tree");

    let remoteCommand = (args, options = {}) => command(args, options);
    if (!readOnly) {
      let minted;
      try { minted = await credential({ repository: `${trustedSnapshot.repository.owner}/${trustedSnapshot.repository.name}`, operationDigest, remote: exactRemote }); }
      catch { throw new AdwError("forge", "auth"); }
      const expiry = Date.parse(minted?.expiresAt);
      const instant = now();
      if (typeof minted?.value !== "string" || minted.value.length < 1 || minted.value.length > 4096 || /[\r\n\0]/.test(minted.value)
          || !Number.isFinite(expiry) || !Number.isFinite(instant) || expiry <= instant || expiry > instant + 3_600_000
          || (minted.operationDigest !== undefined && minted.operationDigest !== operationDigest)) throw new AdwError("forge", "auth");
      const authorization = Buffer.from(`x-access-token:${minted.value}`).toString("base64");
      minted = null;
      const credentialEnv = configEnvironment([
        ...localEntries, ["http.extraHeader", ""],
        [`http.${exactRemote}.extraHeader`, `Authorization: Basic ${authorization}`],
      ]);
      remoteCommand = (args, options = {}) => command(args, { ...options, extraEnv: credentialEnv });
    }
    const readRemote = async ref => {
      const output = (await remoteCommand(["ls-remote", "--refs", exactRemote, ref])).stdout.trim();
      if (output === "") return null;
      const match = /^([0-9a-f]{40})\t(refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(output);
      if (!match || match[2] !== ref) verification("remote");
      return match[1];
    };

    const ref = `refs/heads/${branch}`;
    const existing = await readRemote(ref);
    if (requireExisting && existing === null) stale("head changed");
    if (existing !== null && existing !== baseSha) {
      await remoteCommand(["fetch", "--no-tags", "--no-write-fetch-head", exactRemote, existing]);
      const state = commitState((await command(["cat-file", "commit", existing])).stdout);
      if (!expectedCommit(state, { tree: resultTree, parent: baseSha, signed: signingConfig.mode === "signed" })) stale("head changed");
      if (state.signed) await command(["verify-commit", "--raw", existing]);
      const durable = digestJson({ parent: baseSha, tree: resultTree, signing: signingConfig.mode });
      receipt = Object.freeze({
        operationDigest, projection: "vcs_head", status: "complete",
        beforeRevision: trustedProof.preconditionDigest, preparedRevision: durable, afterRevision: durable,
        headSha: existing,
      });
      return receipt;
    }
    if (existing !== null && !requireExisting) stale("head changed");
    if (existing !== baseSha && requireExisting) stale("head changed");
    if (baseBranch !== null) {
      const remoteBase = await readRemote(`refs/heads/${baseBranch}`);
      if (remoteBase !== baseSha) stale("base changed");
    }

    const message = `ADW verified patch\n\nDecision: ${decisionDigest}\nOperation: ${operationDigest}\n`;
    const commitArgs = ["commit-tree", ...(signingConfig.mode === "signed" ? ["-S"] : []), resultTree, "-p", baseSha];
    const commit = (await command(commitArgs, { input: message })).stdout.trim();
    if (!SHA.test(commit)) verification("commit");
    const created = commitState((await command(["cat-file", "commit", commit])).stdout);
    if (!expectedCommit(created, { tree: resultTree, parent: baseSha, signed: signingConfig.mode === "signed", message, metadata: true })) verification("commit");
    if (created.signed) await command(["verify-commit", "--raw", commit]);

    const durable = digestJson({ parent: baseSha, tree: resultTree, signing: signingConfig.mode });
    if (readOnly) return Object.freeze({
      operationDigest, projection: "vcs_head", status: "complete",
      beforeRevision: trustedProof.preconditionDigest, preparedRevision: durable, afterRevision: durable,
      headSha: commit,
    });
    const push = baseBranch === null
      ? ["push", "--porcelain", exactRemote, `${commit}:${ref}`]
      : ["push", "--atomic", `--force-with-lease=refs/heads/${baseBranch}:${baseSha}`, "--porcelain", exactRemote, `${commit}:${ref}`, `${baseSha}:refs/heads/${baseBranch}`];
    await remoteCommand(push, { remoteFailure: true });
    if (await readRemote(ref) !== commit) stale("head changed");
    receipt = Object.freeze({
      operationDigest, projection: "vcs_head", status: "complete",
      beforeRevision: trustedProof.preconditionDigest, preparedRevision: durable, afterRevision: durable,
      headSha: commit,
    });
    return receipt;
  } finally {
    try { await rm(runDirectory, { recursive: true, force: true }); }
    catch { terminal("cleanup"); }
  }
}

export async function applyVerifiedPatch(request) {
  return verifiedPatchProjection(request, false);
}

export async function projectVerifiedPatch(request) {
  return verifiedPatchProjection(request, true);
}
