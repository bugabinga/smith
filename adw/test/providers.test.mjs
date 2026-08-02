import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalBytes, digestJson } from "../core.mjs";
import { role as productionRole } from "../roles.mjs";
import { PROVIDER_PINS, installProvider, invokeProvider, runProcess } from "../providers.mjs";

const base = {
  file: process.execPath,
  args: ["-e", "process.stdin.pipe(process.stdout)"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "", HOME: "/tmp/adw-home", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  input: "smith",
  timeoutMs: 3000,
  maxOutputBytes: 1024,
};

test("process runner uses exact shell-free options and env", async () => {
  let observed;
  const result = await runProcess(base, (file, args, options) => {
    observed = { file, args, options };
    return spawn(file, args, options);
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: "smith", stderr: "" });
  assert.equal(observed.file, process.execPath);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(observed.options.env, base.env);
  assert.equal(Object.hasOwn(observed.options.env, "GH_TOKEN"), false);
});

test("process runner rejects unsafe requests", async () => {
  await assert.rejects(() => runProcess({ ...base, file: "node" }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, cwd: "relative" }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, timeoutMs: 0 }), error => error?.code === "provider");
  await assert.rejects(() => runProcess({ ...base, env: { OK: 1 } }), error => error?.code === "provider");
});

test("process runner extracts HTTP status without retaining failure output", async () => {
  for (const stderr of ["HTTP/2.0 404 Not Found", "gh: Not Found (HTTP 404)"]) {
    await assert.rejects(
      () => runProcess({ ...base, args: ["-e", `console.error(${JSON.stringify(stderr)});process.exit(1)`], input: "", captureHttpStatus: true }),
      error => error?.details?.httpStatus === 404 && !JSON.stringify(error).includes("Not Found") && !JSON.stringify(error).includes("gh:"),
    );
  }
});

test("process runner classifies exit without leaking stderr", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "console.error('secret');process.exit(7)"], input: "" }),
    error => error?.code === "provider" && error.message === "exit" && error.details.code === 7 && !JSON.stringify(error).includes("secret"),
  );
});

test("process runner bounds output", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "process.stdout.write('x'.repeat(20))"], input: "", maxOutputBytes: 10 }),
    error => error?.code === "provider" && error.message === "output",
  );
});

test("process runner terminates timeout", async () => {
  await assert.rejects(
    () => runProcess({ ...base, args: ["-e", "setTimeout(()=>{},10000)"], input: "", timeoutMs: 30 }),
    error => error?.code === "provider" && error.message === "timeout",
  );
});

test("provider install follows a validated absolute npm symlink and executes env-node shims", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-real-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  const links = join(root, "links");
  const prefix = join(root, "prefix");
  await mkdir(tools);
  await mkdir(links);
  const npmTarget = join(tools, "npm.mjs");
  await writeFile(npmTarget, `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
await writeFile(join(prefix, "node_modules", ".bin", "codex"), "#!/usr/bin/env node\\nconsole.log('codex-cli 0.145.0')\\n", { mode: 0o700 });
`, { mode: 0o700 });
  await chmod(npmTarget, 0o700);
  const npmLink = join(links, "npm");
  await symlink(npmTarget, npmLink);
  const result = await installProvider({
    provider: "codex", prefix, npmPath: npmLink, repository: process.cwd(), run: runProcess,
    baseEnv: { PATH: dirname(process.execPath), HOME: root, LANG: "C.UTF-8", TMPDIR: root },
  });
  assert.equal(result.executable, join(prefix, "node_modules", ".bin", "codex"));
  assert.equal(result.version, "0.145.0");
});

test("provider pins install into an external temporary prefix", async t => {
  assert.deepEqual(PROVIDER_PINS, {
    claude: { package: "@anthropic-ai/claude-code", version: "2.1.220", executable: "claude" },
    codex: { package: "@openai/codex", version: "0.145.0", executable: "codex" },
  });
  const root = await mkdtemp(join(tmpdir(), "smith-adw-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  const calls = [];
  const fakeRun = async request => {
    calls.push(request);
    if (request.args[0] === "install") {
      const executable = join(prefix, "node_modules", ".bin", "codex");
      await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
      await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    }
    return { code: 0, signal: null, stdout: request.args.includes("--version") ? "codex-cli 0.145.0\n" : "", stderr: "" };
  };
  const result = await installProvider({ provider: "codex", prefix, npmPath: process.execPath, repository: process.cwd(), run: fakeRun, baseEnv: base.env });
  assert.equal(result.version, "0.145.0");
  assert.deepEqual(calls[0].args, ["install", "--prefix", prefix, "--no-save", "--package-lock=false", "@openai/codex@0.145.0"]);
  assert.ok(calls[1].file.endsWith("node_modules/.bin/codex"));
  await assert.rejects(
    () => installProvider({ provider: "codex", prefix: process.cwd(), npmPath: process.execPath, repository: process.cwd(), run: fakeRun, baseEnv: base.env }),
    error => error?.code === "provider" && error.message === "path",
  );
});

const reviewSchema = await readFile(new URL("../schemas/role-payloads/review.schema.json", import.meta.url), "utf8");
const trusted = (source, data) => ({ trust: "trusted", source, bytes: canonicalBytes(data).length, digest: digestJson(data), data });
const snapshot = {
  schemaVersion: 1,
  controlSha: "a".repeat(40),
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [
    { resource: "pull:42", kind: "pull", token: "b".repeat(40) },
    { resource: "trusted:.claude/agents/reviewer.md", kind: "control", token: "c".repeat(40) },
    { resource: "trusted:adw/schemas/role-payloads/review.schema.json", kind: "control", token: "d".repeat(40) },
  ],
  routing: { role: "reviewer", mode: "single", primary: "claude" },
  state: { resources: {
    "trusted:.claude/agents/reviewer.md": trusted(".claude/agents/reviewer.md", "trusted review charter"),
    "trusted:adw/schemas/role-payloads/review.schema.json": trusted("adw/schemas/role-payloads/review.schema.json", reviewSchema),
  } },
};

test("Claude invocation receives only Claude credential and stamps envelope", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-claude-"));
  const home = join(root, "home");
  t.after(() => rm(root, { recursive: true, force: true }));
  let call;
  const run = async request => {
    call = request;
    return { code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "approve", risk: "none", findings: [] }, patch: null } }), stderr: "" };
  };
  const result = await invokeProvider({
    provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: productionRole("reviewer"), snapshot,
    idempotencyKey: "review:42",
    home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "claude-secret" },
    runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z", run,
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.snapshotDigest, digestJson(snapshot));
  assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, "claude-secret");
  assert.equal(Object.hasOwn(call.env, "GH_TOKEN"), false);
  assert.equal(call.args.includes("--bare"), false);
  assert.ok(call.args.includes("--json-schema"));
  assert.deepEqual(call.args.slice(call.args.indexOf("--effort"), call.args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.equal(call.args.includes("--permission-mode"), false);
  const providerPrompt = call.args[call.args.indexOf("-p") + 1];
  assert.match(providerPrompt, /Every other snapshot value/);
  assert.match(providerPrompt, /NORMALIZED SNAPSHOT/);
  assert.match(providerPrompt, /"entityId":"42"/);
});

test("provider-auth canaries remain transport-only and cannot become semantic comment bodies", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-provider-auth-canary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = productionRole("steerer");
  const schema = await readFile(policy.payloadSchema, "utf8");
  const canary = "provider-auth-canary-do-not-publish-7d64f0b8";
  const steeringSnapshot = {
    ...snapshot,
    event: { kind: "issue_comment", action: "created", entityId: "42" },
    routing: { role: policy.name, mode: policy.mode, primary: policy.primary },
    revisions: [
      { resource: `trusted:${policy.charter}`, kind: "control", token: "c".repeat(40) },
      { resource: `trusted:${policy.payloadSchema}`, kind: "control", token: "d".repeat(40) },
    ],
    state: { resources: {
      [`trusted:${policy.charter}`]: trusted(policy.charter, "trusted steering charter"),
      [`trusted:${policy.payloadSchema}`]: trusted(policy.payloadSchema, schema),
    } },
  };
  await assert.rejects(
    () => invokeProvider({
      provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: policy, snapshot: steeringSnapshot,
      idempotencyKey: "steer:42", home: join(root, "home"), repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: canary },
      runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
      run: async () => ({ code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "comment", body: canary }, patch: null } }), stderr: "" }),
    }),
    error => error?.code === "provider" && error.message === "credential",
  );
});

test("provider invocation enforces role payload keys", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-payload-"));
  const home = join(root, "home");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => invokeProvider({
      provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: productionRole("reviewer"), snapshot,
      idempotencyKey: "review:42",
      home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
      run: async () => ({ code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: {}, patch: null } }), stderr: "" }),
    }),
    error => error?.code === "provider" && error.message === "malformed",
  );
});

test("provider cleanup failure cannot report success", async () => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-cleanup-"));
  const home = join(root, "home");
  await assert.rejects(
    () => invokeProvider({
      provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: productionRole("reviewer"), snapshot,
      idempotencyKey: "review:42",
      home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
      run: async () => ({ code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "approve", risk: "none", findings: [] }, patch: null } }), stderr: "" }),
      remove: async () => { throw new Error("denied"); },
    }),
    error => error?.code === "provider" && error.message === "cleanup",
  );
  await rm(root, { recursive: true, force: true });
});

test("provider prefix and home claims reject pre-existing or symlink paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-exclusive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  await mkdir(prefix);
  await assert.rejects(
    () => installProvider({ provider: "codex", prefix, npmPath: process.execPath, repository: process.cwd(), run: async () => assert.fail("npm must not run"), baseEnv: base.env }),
    error => error?.code === "provider" && error.message === "path",
  );
  const homeTarget = join(root, "target");
  const home = join(root, "home");
  await mkdir(homeTarget);
  await symlink(homeTarget, home);
  await assert.rejects(
    () => invokeProvider({
      provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: productionRole("reviewer"), snapshot,
      idempotencyKey: "review:42", home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
      run: async () => assert.fail("provider must not run"),
    }),
    error => error?.code === "provider" && error.message === "path",
  );
});

test("real provider patch flow captures exact repository bytes and checks declared metadata", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-provider-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = productionRole("builder");
  const charter = "trusted builder charter";
  const schema = await readFile(policy.payloadSchema, "utf8");
  const baseSha = "b".repeat(40);
  const patchBytes = Buffer.from("diff --git a/smith/src/lib.rs b/smith/src/lib.rs\n");
  const manifest = { baseSha, digest: (await import("../core.mjs")).digestBytes(patchBytes), size: patchBytes.length, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const buildSnapshot = {
    ...snapshot,
    routing: { role: "builder", mode: "single", primary: "claude" },
    revisions: [
      { resource: "base", kind: "git_ref", token: baseSha },
      { resource: `trusted:${policy.charter}`, kind: "control", token: "c".repeat(40) },
      { resource: `trusted:${policy.payloadSchema}`, kind: "control", token: "d".repeat(40) },
    ],
    state: { resources: { [`trusted:${policy.charter}`]: trusted(policy.charter, charter), [`trusted:${policy.payloadSchema}`]: trusted(policy.payloadSchema, schema) } },
  };
  let captured = 0;
  let call;
  const result = await invokeProvider({
    provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: policy, snapshot: buildSnapshot,
    idempotencyKey: "build:42", home: join(root, "home"), repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
    runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
    run: async request => { call = request; return { code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "patch", summary: "Build", patch: manifest }, patch: manifest } }), stderr: "" }; },
    capturePatch: async metadata => { captured++; assert.deepEqual(metadata, manifest); return { manifest, patchBytes }; },
  });
  assert.equal(captured, 1);
  assert.deepEqual(call.args.slice(call.args.indexOf("--permission-mode"), call.args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(call.args.slice(call.args.indexOf("--effort"), call.args.indexOf("--effort") + 2), ["--effort", "high"]);
  assert.deepEqual(result.patchBytes, patchBytes);
  assert.deepEqual(result.assessment.patch, manifest);
});

test("provider invocation detects a claimed-home directory swap", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-home-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const moved = join(root, "moved-home");
  const outside = join(root, "outside");
  await mkdir(outside);
  await assert.rejects(
    () => invokeProvider({
      provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: productionRole("reviewer"), snapshot,
      idempotencyKey: "review:42", home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z",
      run: async () => {
        await rename(home, moved);
        await symlink(outside, home);
        return { code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "approve", risk: "none", findings: [] }, patch: null } }), stderr: "" };
      },
    }),
    error => error?.code === "provider" && error.message === "path",
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
});

test("Codex auth file is mode-0600 and removed in finally", async () => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-codex-"));
  const home = join(root, "home");
  let authMode;
  let providerArgs;
  const run = async request => {
    providerArgs = request.args;
    const auth = join(home, ".codex", "auth.json");
    authMode = (await import("node:fs/promises")).stat(auth).then(value => value.mode & 0o777);
    const output = request.args[request.args.indexOf("--output-last-message") + 1];
    await writeFile(output, JSON.stringify({ outcome: "positive", payload: { verdict: "approve", risk: "none", findings: [] }, patch: null }));
    return { code: 0, signal: null, stdout: "", stderr: "" };
  };
  const result = await invokeProvider({
    provider: "codex", executable: process.execPath, cliVersion: "0.145.0", rolePolicy: productionRole("reviewer"), snapshot,
    idempotencyKey: "review:42",
    home, repository: process.cwd(), credential: { CODEX_AUTH_JSON: "{\"token\":\"secret\"}" },
    runIdentity: { id: "run", job: "codex", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z", run,
  });
  assert.equal(result.provider, "codex");
  assert.equal(await authMode, 0o600);
  assert.deepEqual(providerArgs.slice(providerArgs.indexOf("--sandbox"), providerArgs.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  await assert.rejects(() => access(home));
  await rm(root, { recursive: true, force: true });
});
