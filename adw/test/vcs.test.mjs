import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { digestBytes } from "../core.mjs";
import { defineRole } from "../roles.mjs";
import { runProcess } from "../providers.mjs";
import { verifyPatch } from "../vcs.mjs";

const exec = promisify(execFile);

async function gitPath() {
  const { stdout } = await exec("sh", ["-c", "command -v git"]);
  return realpath(stdout.trim());
}

async function git(file, args) {
  return exec(file, args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function role() {
  return defineRole({
    name: "builder",
    charter: ".claude/agents/builder.md",
    mode: "single",
    primary: "claude",
    fallback: "codex",
    providers: ["claude", "codex"],
    providerConfig: {
      claude: { model: "claude-model", effort: "high", timeoutSeconds: 300 },
      codex: { model: "codex-model", effort: "high", timeoutSeconds: 300 },
    },
    capabilities: ["pulls:write"],
    snapshot: { fields: ["issue"], maxBytes: 262144 },
    payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
    operations: ["create_pr", "terminal"],
    fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
    patch: { maxBytes: 4096, maxFiles: 2, allowedPrefixes: ["file.txt"], deniedPaths: ["adw/**", "docs/SPEC.md"] },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-vcs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const temporaryDirectory = join(root, "verification");
  await mkdir(repository);
  await mkdir(temporaryDirectory);
  const executable = await gitPath();
  await git(executable, ["-C", repository, "init", "-q"]);
  await git(executable, ["-C", repository, "config", "user.name", "Smith Test"]);
  await git(executable, ["-C", repository, "config", "user.email", "smith@example.invalid"]);
  await writeFile(join(repository, "file.txt"), "before\n");
  await git(executable, ["-C", repository, "add", "file.txt"]);
  await git(executable, ["-C", repository, "commit", "-qm", "base"]);
  const baseSha = (await git(executable, ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(repository, "file.txt"), "after\n");
  const patchBytes = Buffer.from((await git(executable, ["-C", repository, "diff", "--binary", "--", "file.txt"])).stdout);
  await git(executable, ["-C", repository, "checkout", "--", "file.txt"]);
  const manifest = {
    baseSha,
    digest: digestBytes(patchBytes),
    size: patchBytes.length,
    files: [{ path: "file.txt", kind: "regular", oldMode: "100644", newMode: "100644" }],
  };
  return { executable, repository, temporaryDirectory, baseSha, patchBytes, manifest };
}

test("patch verification attests exact resulting tree without target execution", async t => {
  const value = await fixture(t);
  const calls = [];
  const result = await verifyPatch({
    ...value,
    rolePolicy: role(),
    controlSha: "a".repeat(40),
    decisionDigest: "b".repeat(64),
    preconditionDigest: "c".repeat(64),
    run: async request => { calls.push(request); return runProcess(request); },
  });
  assert.equal(result.kind, "patch");
  assert.match(result.resultTree, /^[0-9a-f]{40}$/);
  assert.ok(calls.every(call => call.file === value.executable && call.args.includes("core.hooksPath=/dev/null")));
  assert.equal(calls.some(call => call.args.includes("worktree") || call.args.includes("status")), false);
  assert.ok(calls.some(call => call.args.includes("read-tree")));
  assert.ok(calls.filter(call => call.args.includes("apply")).every(call => call.args.includes("--cached")));
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
  assert.equal(await readFile(join(value.repository, "file.txt"), "utf8"), "before\n");
});

test("patch policy treats file prefixes as path boundaries", async t => {
  const value = await fixture(t);
  await assert.rejects(
    () => verifyPatch({
      ...value,
      manifest: { ...value.manifest, files: [{ ...value.manifest.files[0], path: "file.txt.evil" }] },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
    }),
    error => error?.code === "verification",
  );
});

test("patch verification rejects digest mismatch before git", async t => {
  const value = await fixture(t);
  let calls = 0;
  await assert.rejects(
    () => verifyPatch({
      ...value,
      manifest: { ...value.manifest, digest: "d".repeat(64) },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
      run: async request => { calls++; return runProcess(request); },
    }),
    error => error?.code === "verification",
  );
  assert.equal(calls, 0);
});

test("patch verification rejects NUL-bearing binary input before git", async t => {
  const value = await fixture(t);
  let calls = 0;
  const bytes = Buffer.from([0, 1, 2]);
  await assert.rejects(
    () => verifyPatch({
      ...value, patchBytes: bytes,
      manifest: { ...value.manifest, digest: digestBytes(bytes), size: bytes.length },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
      run: async request => { calls++; return runProcess(request); },
    }),
    error => error?.code === "verification" && error.message === "binary",
  );
  assert.equal(calls, 0);
});

test("patch verification cleans worktree after malformed diff", async t => {
  const value = await fixture(t);
  await assert.rejects(
    () => verifyPatch({
      ...value,
      patchBytes: Buffer.from("not a diff\n"),
      manifest: { ...value.manifest, digest: digestBytes(Buffer.from("not a diff\n")), size: 11 },
      rolePolicy: role(), controlSha: "a".repeat(40), decisionDigest: "b".repeat(64), preconditionDigest: "c".repeat(64),
    }),
    error => error?.code === "verification",
  );
  assert.deepEqual(await readdir(value.temporaryDirectory), []);
});
