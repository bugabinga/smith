import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { canonicalBytes, digestBytes, digestJson } from "../core.mjs";
import { run } from "../main.mjs";
import { role as productionRole } from "../roles.mjs";

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = { id: "1", owner: "bugabinga", name: "smith", defaultBranch: "main" };
const exec = promisify(execFile);
const charterPath = ".claude/agents/reviewer.md";
const schemaPath = "adw/schemas/role-payloads/review.schema.json";
const trusted = (source, data) => ({ trust: "trusted", source, bytes: canonicalBytes(data).length, digest: digestJson(data), data });
const snapshot = {
  schemaVersion: 1,
  controlSha,
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository,
  revisions: [
    { resource: "pull:42", kind: "pull", token: headSha },
    { resource: `trusted:${charterPath}`, kind: "control", token: "1".repeat(40) },
    { resource: `trusted:${schemaPath}`, kind: "control", token: "3".repeat(40) },
  ],
  routing: { role: "reviewer", mode: "single", primary: "claude" },
  state: { entityId: "42", headSha, labels: [], resources: { [`trusted:${charterPath}`]: trusted(charterPath, "Review safely.\n"), [`trusted:${schemaPath}`]: trusted(schemaPath, "{}\n") } },
};
const payload = { verdict: "approve", risk: "none", findings: [] };
const assessment = provider => ({
  schemaVersion: 1,
  controlSha,
  role: "reviewer",
  provider,
  model: provider === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol",
  idempotencyKey: "pull:42:reviewer",
  snapshotDigest: digestJson(snapshot),
  cliVersion: provider === "claude" ? "2.1.220" : "0.145.0",
  run: { id: "123", job: provider, attempt: 1 },
  outcome: "positive",
  payload,
  payloadDigest: digestJson(payload),
  patch: null,
  startedAt: "2026-07-31T00:00:00.000Z",
  completedAt: "2026-07-31T00:00:01.000Z",
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = join(root, "control-checkout");
  const target = join(root, "target-checkout");
  const artifacts = join(root, "artifacts");
  const runner = join(root, "runner");
  await mkdir(join(control, "adw", "schemas", "role-payloads"), { recursive: true });
  await mkdir(join(control, ".claude", "agents"), { recursive: true });
  await mkdir(target);
  await mkdir(artifacts);
  await mkdir(runner);
  await writeFile(join(control, "adw", "main.mjs"), "export {};\n");
  await writeFile(join(control, "adw", "schemas", "role-payloads", "review.schema.json"), "{}\n");
  await writeFile(join(control, ".claude", "agents", "reviewer.md"), "Review safely.\n");
  await writeFile(join(target, "README.md"), "target\n");
  const eventPath = join(root, "event.json");
  await writeFile(eventPath, JSON.stringify({
    action: "synchronize",
    repository: { id: 1, name: "smith", default_branch: "main", owner: { id: 7, login: "bugabinga" } },
    sender: { id: 7, login: "bugabinga", type: "User" },
    pull_request: { number: 42, head: { sha: headSha, repo: { full_name: "bugabinga/smith" } }, base: { ref: "main" }, updated_at: "2026-07-31T00:00:00Z" },
  }));
  const source = join(artifacts, "adw-source");
  const snapshotArtifact = join(artifacts, "adw-snapshot");
  const claudeArtifact = join(artifacts, "adw-assessment-claude");
  const codexArtifact = join(artifacts, "adw-assessment-codex");
  const decisionArtifact = join(artifacts, "adw-decision");
  const verificationArtifact = join(artifacts, "adw-verification");
  return { root, control, target, artifacts, runner, eventPath, source, snapshotArtifact, claudeArtifact, codexArtifact, decisionArtifact, verificationArtifact };
}

async function invoke(argv, env, adapters = {}, executablePath = env.ADW_SOURCE_ARTIFACT ? join(env.ADW_SOURCE_ARTIFACT, "control", "adw", "main.mjs") : undefined) {
  let out = "";
  let err = "";
  const code = await run({
    argv,
    env,
    executablePath,
    stdin: "",
    stdout: { write: value => { out += value; } },
    stderr: { write: value => { err += value; } },
    readFixture: async () => "",
    adapters,
  });
  return { code, out, err };
}

function prepareEnvironment(value) {
  return {
    ADW_CONTROL_CHECKOUT: value.control,
    ADW_TARGET_CHECKOUT: value.target,
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_EVENT_PATH: value.eventPath,
    ADW_EVENT_NAME: "pull_request",
    ADW_REPOSITORY: "bugabinga/smith",
    ADW_ROLE: "reviewer",
    ADW_CONTROL_SHA: controlSha,
    ADW_APP_ID: "A_smith",
  };
}

function prepareAdapters(observed = {}) {
  return {
    githubFactory: name => {
      assert.equal(name, "bugabinga/smith");
      return {
        readRoleSnapshot: async (event, policy, trust) => {
          observed.event = event;
          observed.policy = policy;
          observed.trust = trust;
          return snapshot;
        },
      };
    },
    vcs: {
      head: async path => path.endsWith("control-checkout") ? controlSha : headSha,
      readControl: async request => {
        observed.control = request;
        const values = [
          [".claude/agents/reviewer.md", "Review safely.\n"],
          ["adw/main.mjs", "export {};\n"],
          ["adw/schemas/role-payloads/review.schema.json", "{}\n"],
        ];
        return { paths: values.map(([path, text], index) => ({ path, tree: "e".repeat(40), blob: String(index + 1).repeat(40), bytes: Buffer.from(text) })) };
      },
      createBundle: async request => {
        observed.bundle = request;
        if (request.allowedShas.length === 0) return { bytes: Buffer.from("# v2 git bundle\n\n"), repository, refs: [], shas: [], paths: [] };
        const [targetSha] = request.allowedShas;
        return {
          bytes: Buffer.from("bundle-v1"),
          repository,
          refs: [{ name: "refs/heads/main", sha: targetSha }],
          shas: [targetSha],
          paths: [{ path: "README.md", tree: "c".repeat(40), blob: "d".repeat(40), digest: digestBytes(Buffer.from("target\n")), size: 7 }],
        };
      },
    },
  };
}

async function prepare(t) {
  const value = await fixture(t);
  const observed = {};
  const result = await invoke(["prepare"], prepareEnvironment(value), prepareAdapters(observed));
  assert.equal(result.code, 0, result.err);
  return { ...value, observed, result };
}

test("prepare writes exact source and snapshot trees from canonical adapters", async t => {
  const value = await prepare(t);
  assert.deepEqual(await readdir(value.snapshotArtifact), ["snapshot.json", "snapshot.sha256"]);
  assert.deepEqual((await readdir(value.source)).sort(), ["control", "manifest.json", "manifest.sha256", "target.bundle"]);
  assert.deepEqual(JSON.parse(await readFile(join(value.snapshotArtifact, "snapshot.json"))), snapshot);
  const manifestBytes = await readFile(join(value.source, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.controlSha, controlSha);
  assert.deepEqual(manifest.repository, repository);
  assert.equal(manifest.target.bundle.digest, digestBytes(Buffer.from("# v2 git bundle\n\n")));
  assert.deepEqual(manifest.target.refs, []);
  assert.ok(manifest.control.paths.some(entry => entry.path === "adw/main.mjs"));
  assert.ok(manifest.control.paths.some(entry => entry.path === ".claude/agents/reviewer.md"));
  assert.ok(manifest.control.paths.every(entry => /^[0-9a-f]{40}$/.test(entry.tree) && /^[0-9a-f]{40}$/.test(entry.blob)));
  assert.equal(value.observed.control.controlSha, controlSha);
  assert.equal(await readFile(join(value.source, "manifest.sha256"), "utf8"), `${digestBytes(manifestBytes)}\n`);
  assert.equal(value.observed.policy.name, "reviewer");
  assert.deepEqual(value.observed.trust, { controlSha, appId: "A_smith" });
  assert.equal(value.observed.bundle.hardening.fileProtocol, false);
  assert.deepEqual(value.observed.bundle.allowedShas, []);
});

test("prepare selects only the canonical patch base and reviser current head", async t => {
  const value = await fixture(t);
  const patchBase = "1".repeat(40);
  const unrelated = "f".repeat(40);
  const makeSnapshot = (roleName, revisions, state) => {
    const policy = productionRole(roleName);
    const charter = "Patch safely.\n";
    const schema = "{}\n";
    return {
      ...snapshot,
      revisions: [
        ...revisions,
        { resource: `trusted:${policy.charter}`, kind: "control", token: "2".repeat(40) },
        { resource: `trusted:${policy.payloadSchema}`, kind: "control", token: "3".repeat(40) },
      ],
      routing: { role: roleName, mode: policy.mode, primary: policy.primary },
      state: { ...state, resources: { [`trusted:${policy.charter}`]: trusted(policy.charter, charter), [`trusted:${policy.payloadSchema}`]: trusted(policy.payloadSchema, schema) } },
    };
  };
  const runCase = async (roleName, roleSnapshot, expected) => {
    const policy = productionRole(roleName);
    const observed = {};
    const adapters = prepareAdapters(observed);
    adapters.githubFactory = () => ({ readRoleSnapshot: async () => roleSnapshot });
    adapters.vcs.readControl = async () => ({ paths: [
      { path: policy.charter, tree: "e".repeat(40), blob: "2".repeat(40), bytes: Buffer.from("Patch safely.\n") },
      { path: "adw/main.mjs", tree: "e".repeat(40), blob: "1".repeat(40), bytes: Buffer.from("export {};\n") },
      { path: policy.payloadSchema, tree: "e".repeat(40), blob: "3".repeat(40), bytes: Buffer.from("{}\n") },
    ] });
    const source = join(value.artifacts, `source-${roleName}`);
    const snapshotArtifact = join(value.artifacts, `snapshot-${roleName}`);
    const result = await invoke(["prepare"], { ...prepareEnvironment(value), ADW_SOURCE_ARTIFACT: source, ADW_SNAPSHOT_ARTIFACT: snapshotArtifact, ADW_ROLE: roleName }, adapters);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(observed.bundle.allowedShas, [expected]);
  };
  await runCase("builder", makeSnapshot("builder", [
    { resource: "patch-base:main", kind: "git_ref", token: patchBase },
    { resource: "pull:42", kind: "pull", token: unrelated },
    { resource: "ref:z-conflict", kind: "git_ref", token: unrelated },
  ], { entityId: "42", labels: [] }), patchBase);
  await runCase("reviser", makeSnapshot("reviser", [
    { resource: "pull:42", kind: "pull", token: headSha },
    { resource: "ref:a-lexical-head", kind: "git_ref", token: patchBase },
  ], { entityId: "42", headSha, changedPaths: ["README.md"], labels: [] }), headSha);
});

test("prepare rejects a patch role without its one canonical base", async t => {
  const value = await fixture(t);
  const policy = productionRole("builder");
  const invalid = {
    ...snapshot,
    revisions: [
      { resource: "ref:main", kind: "git_ref", token: headSha },
      { resource: `trusted:${policy.charter}`, kind: "control", token: "2".repeat(40) },
      { resource: `trusted:${policy.payloadSchema}`, kind: "control", token: "3".repeat(40) },
    ],
    routing: { role: "builder", mode: policy.mode, primary: policy.primary },
    state: { entityId: "42", labels: [], resources: { [`trusted:${policy.charter}`]: trusted(policy.charter, "Patch safely.\n"), [`trusted:${policy.payloadSchema}`]: trusted(policy.payloadSchema, "{}\n") } },
  };
  const adapters = prepareAdapters();
  adapters.githubFactory = () => ({ readRoleSnapshot: async () => invalid });
  adapters.vcs.readControl = async () => ({ paths: [
    { path: policy.charter, tree: "e".repeat(40), blob: "2".repeat(40), bytes: Buffer.from("Patch safely.\n") },
    { path: "adw/main.mjs", tree: "e".repeat(40), blob: "1".repeat(40), bytes: Buffer.from("export {};\n") },
    { path: policy.payloadSchema, tree: "e".repeat(40), blob: "3".repeat(40), bytes: Buffer.from("{}\n") },
  ] });
  adapters.vcs.createBundle = async () => assert.fail("bundle must not be created without a patch base");
  const result = await invoke(["prepare"], { ...prepareEnvironment(value), ADW_ROLE: "builder" }, adapters);
  assert.equal(result.code, 2);
});

test("assess installs one pin, accepts one credential, and writes only its tree", async t => {
  const value = await prepare(t);
  const calls = [];
  const npmLink = join(value.root, "npm-link");
  await symlink(process.execPath, npmLink);
  const env = {
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_ASSESSMENT_ARTIFACT: value.claudeArtifact,
    ADW_TARGET_DIRECTORY: join(value.root, "provider-target"),
    ADW_RUNNER_TEMP: value.runner,
    ADW_NPM_PATH: npmLink,
    ADW_CONTROL_SHA: controlSha,
    ADW_PROVIDER_CREDENTIAL: "provider-secret",
    ADW_RUN_ID: "123",
    ADW_JOB_ID: "claude",
    ADW_RUN_ATTEMPT: "1",
    ADW_IDEMPOTENCY_KEY: "pull:42:reviewer",
    GH_TOKEN: "ignored-forge-secret",
    CODEX_AUTH_JSON: "ignored-opposite-secret",
  };
  const result = await invoke(["assess", "--provider", "claude"], env, {
    provider: {
      install: async request => { calls.push({ install: request }); return { executable: process.execPath, version: "2.1.220" }; },
      invoke: async request => { calls.push({ invoke: request }); return { assessment: assessment("claude"), patchBytes: null }; },
    },
    vcs: { materializeBundle: async () => assert.fail("state-only role must not materialize target") },
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(await readdir(value.claudeArtifact), ["envelope.json", "envelope.sha256"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].invoke.credential, { CLAUDE_CODE_OAUTH_TOKEN: "provider-secret" });
  assert.equal(JSON.stringify(calls).includes("ignored-forge-secret"), false);
  assert.equal(JSON.stringify(calls).includes("ignored-opposite-secret"), false);
  assert.equal(calls[0].install.prefix.startsWith(value.runner), true);
  assert.equal(calls[0].install.npmPath, npmLink);
  assert.ok(calls[0].install.baseEnv.PATH.split(delimiter).includes(dirname(process.execPath)));
});

test("reduce consumes canonical provider trees and verify emits bound state proof", async t => {
  const value = await prepare(t);
  const bytes = canonicalBytes(assessment("claude"));
  await mkdir(value.claudeArtifact);
  await writeFile(join(value.claudeArtifact, "envelope.json"), bytes);
  await writeFile(join(value.claudeArtifact, "envelope.sha256"), `${digestBytes(bytes)}\n`);
  const reduced = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact,
    ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact,
    ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(reduced.code, 0, reduced.err);
  assert.deepEqual(await readdir(value.decisionArtifact), ["decision.json", "decision.sha256"]);
  const decision = JSON.parse(await readFile(join(value.decisionArtifact, "decision.json")));
  assert.equal(decision.snapshotDigest, digestJson(snapshot));

  const verified = await invoke(["verify"], {
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact,
    ADW_VERIFICATION_ARTIFACT: value.verificationArtifact,
    ADW_TARGET_DIRECTORY: join(value.root, "verify-target"),
    ADW_TEMPORARY_DIRECTORY: value.runner,
    ADW_GIT_PATH: process.execPath,
    ADW_CONTROL_SHA: controlSha,
    GH_TOKEN: "ignored",
  }, { vcs: { materializeBundle: async () => assert.fail("state proof must not materialize target"), verifyPatch: async () => assert.fail("state proof must not invoke git") } });
  assert.equal(verified.code, 0, verified.err);
  const verification = JSON.parse(await readFile(join(value.verificationArtifact, "verification.json")));
  assert.equal(verification.decisionDigest, digestJson(decision));
  assert.equal(verification.preconditionDigest, digestJson(snapshot.revisions));
  assert.equal(verification.kind, "state");
  assert.equal(Object.hasOwn(verification, "credential"), false);
});

test("missing or semantically malformed primary reaches only canonical fallback", async t => {
  const value = await prepare(t);
  const missing = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact,
    ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact,
    ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(missing.code, 4, missing.err);
  assert.deepEqual(JSON.parse(missing.out), { status: "fallback", provider: "codex", reason: "missing_artifact" });

  await mkdir(value.claudeArtifact);
  const malformed = canonicalBytes({ provider: "claude" });
  await writeFile(join(value.claudeArtifact, "envelope.json"), malformed);
  await writeFile(join(value.claudeArtifact, "envelope.sha256"), `${digestBytes(malformed)}\n`);
  const result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source,
    ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact,
    ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact,
    ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 4, result.err);
  assert.equal(JSON.parse(result.out).provider, "codex");
});

test("transport rejects extras, symlinks, digest mismatch, bounds, and control drift", async t => {
  const extra = await prepare(t);
  await writeFile(join(extra.snapshotArtifact, "extra"), "x");
  let result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: extra.source, ADW_SNAPSHOT_ARTIFACT: extra.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: extra.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: extra.codexArtifact,
    ADW_DECISION_ARTIFACT: extra.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);

  const linked = await prepare(t);
  await rm(join(linked.snapshotArtifact, "snapshot.json"));
  await symlink(join(linked.root, "event.json"), join(linked.snapshotArtifact, "snapshot.json"));
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: linked.source, ADW_SNAPSHOT_ARTIFACT: linked.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: linked.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: linked.codexArtifact,
    ADW_DECISION_ARTIFACT: linked.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);

  const digest = await prepare(t);
  await writeFile(join(digest.snapshotArtifact, "snapshot.sha256"), `${"f".repeat(64)}\n`);
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: digest.source, ADW_SNAPSHOT_ARTIFACT: digest.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: digest.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: digest.codexArtifact,
    ADW_DECISION_ARTIFACT: digest.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);

  const oversized = await prepare(t);
  await writeFile(join(oversized.snapshotArtifact, "snapshot.json"), Buffer.alloc(262_145));
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: oversized.source, ADW_SNAPSHOT_ARTIFACT: oversized.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: oversized.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: oversized.codexArtifact,
    ADW_DECISION_ARTIFACT: oversized.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);

  const stale = await prepare(t);
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: stale.source, ADW_SNAPSHOT_ARTIFACT: stale.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: stale.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: stale.codexArtifact,
    ADW_DECISION_ARTIFACT: stale.decisionArtifact, ADW_CONTROL_SHA: "e".repeat(40),
  });
  assert.equal(result.code, 6);
});

test("downstream commands execute only from the transported control artifact", async t => {
  const value = await prepare(t);
  const result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  }, {}, import.meta.filename);
  assert.equal(result.code, 6);
  assert.match(JSON.parse(result.err).message, /trusted control artifact/);
});

test("prepare rejects artifact overlap with either checkout", async t => {
  const value = await fixture(t);
  const env = { ...prepareEnvironment(value), ADW_SOURCE_ARTIFACT: join(value.control, "output") };
  const result = await invoke(["prepare"], env, prepareAdapters());
  assert.equal(result.code, 2);
  assert.equal((await readdir(value.control)).includes("output"), false);
});

test("state roles without target SHAs still prepare a valid empty source bundle", async t => {
  const value = await fixture(t);
  const stateSnapshot = { ...snapshot, revisions: [...snapshot.revisions.filter(revision => revision.kind === "control"), { resource: "issue:42", kind: "issue", token: "revision-1" }] };
  const adapters = prepareAdapters();
  adapters.githubFactory = () => ({ readRoleSnapshot: async () => stateSnapshot });
  adapters.vcs.createBundle = async request => {
    assert.deepEqual(request.allowedShas, []);
    return { bytes: Buffer.from("# v2 git bundle\n\n"), repository, refs: [], shas: [], paths: [] };
  };
  const result = await invoke(["prepare"], prepareEnvironment(value), adapters);
  assert.equal(result.code, 0, result.err);
  const manifest = JSON.parse(await readFile(join(value.source, "manifest.json")));
  assert.deepEqual(manifest.target.refs, []);
  assert.deepEqual(manifest.target.shas, []);
  assert.equal(manifest.target.bundle.size, 17);
});

test("transport requires canonical JSON and validates patch siblings before malformed fallback", async t => {
  const value = await prepare(t);
  await writeFile(join(value.snapshotArtifact, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  const pretty = await readFile(join(value.snapshotArtifact, "snapshot.json"));
  await writeFile(join(value.snapshotArtifact, "snapshot.sha256"), `${digestBytes(pretty)}\n`);
  let result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);

  const malformed = await prepare(t);
  await mkdir(malformed.claudeArtifact);
  const bad = Buffer.from("{");
  await writeFile(join(malformed.claudeArtifact, "envelope.json"), bad);
  await writeFile(join(malformed.claudeArtifact, "envelope.sha256"), `${digestBytes(bad)}\n`);
  await writeFile(join(malformed.claudeArtifact, "change.patch"), "x");
  await writeFile(join(malformed.claudeArtifact, "change.patch.sha256"), `${"f".repeat(64)}\n`);
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: malformed.source, ADW_SNAPSHOT_ARTIFACT: malformed.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: malformed.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: malformed.codexArtifact,
    ADW_DECISION_ARTIFACT: malformed.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);
  assert.equal(result.out, "");
});

test("role-semantic malformed primary yields exactly one valid fallback", async t => {
  const value = await prepare(t);
  const malformed = assessment("claude");
  malformed.payload = { verdict: "approve" };
  malformed.payloadDigest = digestJson(malformed.payload);
  for (const [directory, artifact] of [[value.claudeArtifact, malformed], [value.codexArtifact, assessment("codex")]]) {
    await mkdir(directory);
    const bytes = canonicalBytes(artifact);
    await writeFile(join(directory, "envelope.json"), bytes);
    await writeFile(join(directory, "envelope.sha256"), `${digestBytes(bytes)}\n`);
  }
  const result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 0, result.err);
  const decision = JSON.parse(result.out);
  assert.deepEqual(decision.assessmentDigests, [digestJson(assessment("codex"))]);
});

test("prepare detects a claimed source-directory symlink swap", async t => {
  const value = await fixture(t);
  const outside = join(value.root, "outside");
  await mkdir(outside);
  const adapters = prepareAdapters();
  adapters.vcs.readControl = async () => {
    await rm(value.source, { recursive: true });
    await symlink(outside, value.source);
    return { paths: [
      { path: charterPath, tree: "e".repeat(40), blob: "1".repeat(40), bytes: Buffer.from("Review safely.\n") },
      { path: "adw/main.mjs", tree: "e".repeat(40), blob: "2".repeat(40), bytes: Buffer.from("export {};\n") },
      { path: schemaPath, tree: "e".repeat(40), blob: "3".repeat(40), bytes: Buffer.from("{}\n") },
    ] };
  };
  const result = await invoke(["prepare"], prepareEnvironment(value), adapters);
  assert.equal(result.code, 2);
  assert.deepEqual(await readdir(outside), []);
});

test("operational paths reject tool/temp overlap and symlinked runner parents", async t => {
  const value = await prepare(t);
  const common = {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_TARGET_DIRECTORY: join(value.root, "provider-target"),
    ADW_RUNNER_TEMP: value.runner, ADW_NPM_PATH: process.execPath, ADW_CONTROL_SHA: controlSha,
    ADW_PROVIDER_CREDENTIAL: "secret", ADW_RUN_ID: "1", ADW_JOB_ID: "claude", ADW_RUN_ATTEMPT: "1", ADW_IDEMPOTENCY_KEY: "key",
  };
  let result = await invoke(["assess", "--provider", "claude"], { ...common, ADW_ASSESSMENT_ARTIFACT: join(value.runner, "output") }, {});
  assert.equal(result.code, 6);
  const linkedRunner = join(value.root, "linked-runner");
  await symlink(value.runner, linkedRunner);
  result = await invoke(["assess", "--provider", "claude"], { ...common, ADW_RUNNER_TEMP: linkedRunner }, {});
  assert.equal(result.code, 6);
  const npmTarget = join(value.runner, "npm-target");
  await writeFile(npmTarget, "#!/usr/bin/env node\n", { mode: 0o700 });
  await chmod(npmTarget, 0o700);
  const overlappingNpm = join(value.root, "overlapping-npm");
  await symlink(npmTarget, overlappingNpm);
  result = await invoke(["assess", "--provider", "claude"], { ...common, ADW_NPM_PATH: overlappingNpm }, {
    provider: { install: async () => assert.fail("resolved npm overlap must stop install"), invoke: async () => assert.fail("resolved npm overlap must stop invoke") },
  });
  assert.equal(result.code, 6);
});

test("default prepare reads committed control objects, never mutable worktree bytes", async t => {
  const value = await fixture(t);
  const { stdout } = await exec("sh", ["-c", "command -v git"]);
  const git = stdout.trim();
  for (const repositoryPath of [value.control, value.target]) {
    await exec(git, ["-C", repositoryPath, "init", "-q"]);
    await exec(git, ["-C", repositoryPath, "config", "user.name", "Smith"]);
    await exec(git, ["-C", repositoryPath, "config", "user.email", "smith@example.invalid"]);
    await exec(git, ["-C", repositoryPath, "add", "."]);
    await exec(git, ["-C", repositoryPath, "commit", "-qm", "source"]);
  }
  const exactControlSha = (await exec(git, ["-C", value.control, "rev-parse", "HEAD"])).stdout.trim();
  const exactTargetSha = (await exec(git, ["-C", value.target, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(value.control, "adw", "main.mjs"), "MUTABLE WORKTREE\n");
  const charterBlob = (await exec(git, ["-C", value.control, "rev-parse", `${exactControlSha}:${charterPath}`])).stdout.trim();
  const schemaBlob = (await exec(git, ["-C", value.control, "rev-parse", `${exactControlSha}:${schemaPath}`])).stdout.trim();
  const exactSnapshot = {
    ...snapshot,
    controlSha: exactControlSha,
    revisions: [
      { resource: "pull:42", kind: "pull", token: exactTargetSha },
      { resource: `trusted:${charterPath}`, kind: "control", token: charterBlob },
      { resource: `trusted:${schemaPath}`, kind: "control", token: schemaBlob },
    ],
  };
  const result = await invoke(["prepare"], { ...prepareEnvironment(value), ADW_CONTROL_SHA: exactControlSha, ADW_GIT_PATH: git }, {
    githubFactory: () => ({ readRoleSnapshot: async () => exactSnapshot }),
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(await readFile(join(value.source, "control", "adw", "main.mjs"), "utf8"), "export {};\n");
  const manifestBytes = await readFile(join(value.source, "manifest.json"));
  assert.deepEqual(manifestBytes, canonicalBytes(JSON.parse(manifestBytes)));
});

test("patch sidecars require exact siblings, digest, and one-MiB bound", async t => {
  const value = await prepare(t);
  await mkdir(value.claudeArtifact);
  const patched = assessment("claude");
  patched.patch = { baseSha: headSha, digest: digestBytes(Buffer.from("x")), size: 1, files: [] };
  const envelope = canonicalBytes(patched);
  await writeFile(join(value.claudeArtifact, "envelope.json"), envelope);
  await writeFile(join(value.claudeArtifact, "envelope.sha256"), `${digestBytes(envelope)}\n`);
  let result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);
  await writeFile(join(value.claudeArtifact, "change.patch"), Buffer.alloc(1_048_577));
  await writeFile(join(value.claudeArtifact, "change.patch.sha256"), `${patched.patch.digest}\n`);
  result = await invoke(["reduce"], {
    ADW_SOURCE_ARTIFACT: value.source, ADW_SNAPSHOT_ARTIFACT: value.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: value.claudeArtifact, ADW_FALLBACK_ASSESSMENT_ARTIFACT: value.codexArtifact,
    ADW_DECISION_ARTIFACT: value.decisionArtifact, ADW_CONTROL_SHA: controlSha,
  });
  assert.equal(result.code, 6);
});
