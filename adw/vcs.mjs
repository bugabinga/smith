import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  validatePatchManifest,
  validateVerification,
} from "./core.mjs";
import { runProcess } from "./providers.mjs";

function verification(message) {
  throw new AdwError("verification", message);
}

function outside(repository, temporary) {
  return temporary !== repository && !temporary.startsWith(`${repository}${sep}`) && !repository.startsWith(`${temporary}${sep}`);
}

export async function readHead({ executable, repository, run = runProcess }) {
  if (typeof executable !== "string" || !isAbsolute(executable) || typeof repository !== "string" || !isAbsolute(repository)) verification("path");
  const repo = await realpath(repository).catch(() => verification("path"));
  try {
    const result = await run({
      file: executable,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-C", repo, "rev-parse", "HEAD"],
      cwd: repo,
      env: { PATH: dirname(executable), HOME: repo, LANG: "C.UTF-8", TMPDIR: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
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

export function createDefaultVcs() {
  const executable = process.env.ADW_GIT_PATH;
  if (!executable || !isAbsolute(executable)) verification("git path");
  return Object.freeze({ head: repository => readHead({ executable, repository }) });
}

function parseRaw(text) {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) verification("manifest");
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    const header = fields[i];
    const path = fields[i + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([MAD])$/.exec(header);
    if (!match) verification("manifest");
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
  let tool;
  let repo;
  let temporary;
  let control;
  try {
    tool = await realpath(executable);
    repo = await realpath(repository);
    temporary = await realpath(temporaryDirectory);
    control = await realpath(controlDirectory);
  } catch {
    verification("path");
  }
  if (!outside(repo, temporary) || !outside(control, temporary) || !outside(repo, control) || !outside(repo, tool) || !outside(control, tool)) verification("path");
  if (baseSha !== manifest?.baseSha || patchBytes.length !== manifest?.size || digestBytes(patchBytes) !== manifest?.digest) verification("digest");
  if (patchBytes.includes(0) || patchBytes.includes(Buffer.from("GIT binary patch")) || patchBytes.includes(Buffer.from("Binary files "))) verification("binary");
  try {
    validatePatchManifest(manifest, rolePolicy);
  } catch {
    verification("manifest");
  }

  const id = randomUUID();
  const indexPath = join(temporary, `index-${id}`);
  const patchPath = join(temporary, `patch-${id}.diff`);
  const env = {
    PATH: dirname(tool),
    HOME: temporary,
    LANG: "C.UTF-8",
    TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
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
    await writeFile(patchPath, patchBytes, { mode: 0o600 });
    await command(["read-tree", baseSha]);
    await command(["apply", "--check", "--cached", patchPath]);
    await command(["apply", "--cached", patchPath]);
    const raw = await command(["diff", "--cached", "--raw", "-z", "--no-renames", baseSha]);
    const actual = parseRaw(raw.stdout);
    const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
    if (!canonicalBytes(actual).equals(canonicalBytes(expected))) verification("manifest");
    const resultTree = (await command(["write-tree"])).stdout.trim();
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
    let cleanupFailed = false;
    try { await rm(patchPath, { force: true }); } catch { cleanupFailed = true; }
    try { await rm(indexPath, { force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) verification("cleanup");
  }
}
