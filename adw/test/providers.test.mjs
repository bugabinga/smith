import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestJson } from "../core.mjs";
import { defineRole } from "../roles.mjs";
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

test("provider pins install into an external temporary prefix", async t => {
  assert.deepEqual(PROVIDER_PINS, {
    claude: { package: "@anthropic-ai/claude-code", version: "2.1.220", executable: "claude" },
    codex: { package: "@openai/codex", version: "0.145.0", executable: "codex" },
  });
  const root = await mkdtemp(join(tmpdir(), "smith-adw-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "prefix");
  await mkdir(prefix);
  const calls = [];
  const fakeRun = async request => {
    calls.push(request);
    return { code: 0, signal: null, stdout: request.args.includes("--version") ? "codex-cli 0.145.0\n" : "", stderr: "" };
  };
  const result = await installProvider({ provider: "codex", prefix, npmPath: process.execPath, repository: process.cwd(), run: fakeRun, baseEnv: base.env });
  assert.equal(result.version, "0.145.0");
  assert.deepEqual(calls[0].args, ["install", "--prefix", prefix, "--no-save", "--package-lock=false", "@openai/codex@0.145.0"]);
  assert.ok(calls[1].file.endsWith("node_modules/.bin/codex"));
});

function role(provider) {
  const fallback = provider === "claude" ? "codex" : "claude";
  return defineRole({
    name: "reviewer",
    charter: ".claude/agents/reviewer.md",
    mode: "single",
    primary: provider,
    fallback,
    providers: ["claude", "codex"],
    providerConfig: {
      claude: { model: "claude-model", effort: "high", timeoutSeconds: 300 },
      codex: { model: "codex-model", effort: "high", timeoutSeconds: 300 },
    },
    capabilities: ["pulls:read"],
    snapshot: { fields: ["pull"], maxBytes: 262144 },
    payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
    operations: ["publish_check", "terminal"],
    fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
    patch: null,
  });
}

const snapshot = {
  schemaVersion: 1,
  controlSha: "a".repeat(40),
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [{ resource: "pull:42", kind: "pull", token: "b".repeat(40) }],
  routing: { role: "reviewer", mode: "single", primary: "claude" },
  state: {},
};

test("Claude invocation receives only Claude credential and stamps envelope", async t => {
  const home = await mkdtemp(join(tmpdir(), "smith-adw-claude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let call;
  const run = async request => {
    call = request;
    return { code: 0, signal: null, stdout: JSON.stringify({ structured_output: { outcome: "positive", payload: { verdict: "approve" }, patch: null } }), stderr: "" };
  };
  const result = await invokeProvider({
    provider: "claude", executable: process.execPath, cliVersion: "2.1.220", rolePolicy: role("claude"), snapshot,
    idempotencyKey: "review:42", prompt: "review", schemaPath: join(process.cwd(), "adw/schemas/assessment.schema.json"),
    home, repository: process.cwd(), credential: { CLAUDE_CODE_OAUTH_TOKEN: "claude-secret" },
    runIdentity: { id: "run", job: "claude", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z", run,
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.snapshotDigest, digestJson(snapshot));
  assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, "claude-secret");
  assert.equal(Object.hasOwn(call.env, "GH_TOKEN"), false);
  assert.equal(call.args.includes("--bare"), false);
  assert.ok(call.args.includes("--json-schema"));
});

test("Codex auth file is mode-0600 and removed in finally", async () => {
  const home = await mkdtemp(join(tmpdir(), "smith-adw-codex-"));
  let authMode;
  const run = async request => {
    const auth = join(home, ".codex", "auth.json");
    authMode = (await import("node:fs/promises")).stat(auth).then(value => value.mode & 0o777);
    const output = request.args[request.args.indexOf("--output-last-message") + 1];
    await writeFile(output, JSON.stringify({ outcome: "positive", payload: { verdict: "approve" }, patch: null }));
    return { code: 0, signal: null, stdout: "", stderr: "" };
  };
  const result = await invokeProvider({
    provider: "codex", executable: process.execPath, cliVersion: "0.145.0", rolePolicy: role("codex"), snapshot: { ...snapshot, routing: { ...snapshot.routing, primary: "codex" } },
    idempotencyKey: "review:42", prompt: "review", schemaPath: join(process.cwd(), "adw/schemas/assessment.schema.json"),
    home, repository: process.cwd(), credential: { CODEX_AUTH_JSON: "{\"token\":\"secret\"}" },
    runIdentity: { id: "run", job: "codex", attempt: 1 }, baseEnv: base.env, now: () => "2026-07-28T10:00:00.000Z", run,
  });
  assert.equal(result.provider, "codex");
  assert.equal(await authMode, 0o600);
  await assert.rejects(() => access(home));
});
