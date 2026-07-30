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
  baseSha,
  patchBytes,
  manifest,
  rolePolicy,
  controlSha,
  decisionDigest,
  preconditionDigest,
  run = runProcess,
}) {
  if (![executable, repository, temporaryDirectory].every(value => typeof value === "string" && isAbsolute(value))) verification("path");
  if (!Buffer.isBuffer(patchBytes)) verification("patch");
  let repo;
  let temporary;
  try {
    repo = await realpath(repository);
    temporary = await realpath(temporaryDirectory);
  } catch {
    verification("path");
  }
  if (!outside(repo, temporary)) verification("path");
  if (baseSha !== manifest?.baseSha || patchBytes.length !== manifest?.size || digestBytes(patchBytes) !== manifest?.digest) verification("digest");
  if (patchBytes.includes(Buffer.from("GIT binary patch")) || patchBytes.includes(Buffer.from("Binary files "))) verification("binary");
  try {
    validatePatchManifest(manifest, rolePolicy);
  } catch {
    verification("manifest");
  }

  const id = randomUUID();
  const worktree = join(temporary, `worktree-${id}`);
  const patchPath = join(temporary, `patch-${id}.diff`);
  const env = {
    PATH: dirname(executable),
    HOME: temporary,
    LANG: "C.UTF-8",
    TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never"];
  const command = async (cwd, args) => {
    try {
      return await run({
        file: executable,
        args: [...prefix, "-C", cwd, ...args],
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

  let added = false;
  try {
    await writeFile(patchPath, patchBytes, { mode: 0o600 });
    await command(repo, ["worktree", "add", "--detach", worktree, baseSha]);
    added = true;
    const head = (await command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== baseSha) verification("base");
    await command(worktree, ["apply", "--check", "--index", patchPath]);
    await command(worktree, ["apply", "--index", patchPath]);
    const raw = await command(worktree, ["diff", "--cached", "--raw", "-z", "--no-renames"]);
    const actual = parseRaw(raw.stdout);
    const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
    if (!canonicalBytes(actual).equals(canonicalBytes(expected))) verification("manifest");
    const status = (await command(worktree, ["status", "--porcelain=v1", "-z"])).stdout.split("\0").filter(Boolean);
    if (status.some(entry => entry.length < 3 || entry[1] !== " ")) verification("dirty");
    const resultTree = (await command(worktree, ["write-tree"])).stdout.trim();
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
    if (added) {
      try { await command(repo, ["worktree", "remove", "--force", worktree]); } catch { cleanupFailed = true; }
    }
    try { await rm(patchPath, { force: true }); } catch { cleanupFailed = true; }
    try { await rm(worktree, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) verification("cleanup");
  }
}
