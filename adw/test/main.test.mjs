import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AdwError, canonicalBytes, digestBytes, digestJson } from "../core.mjs";
import { execute, operationPermissionOutputs, readBounded, readPreviousApplyResult, run, writeTransportArtifact } from "../main.mjs";

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const snapshot = {
  schemaVersion: 1,
  controlSha,
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [{ resource: "pull:42", kind: "pull", token: headSha }],
  routing: { role: "reviewer", mode: "single", primary: "claude" },
  state: { entityId: "42", headSha, labels: [] },
};
const payload = { verdict: "approve", risk: "none", findings: [] };
const assessment = {
  schemaVersion: 1,
  controlSha,
  role: "reviewer",
  provider: "claude",
  model: "claude-opus-4-8",
  idempotencyKey: "pr:42:head:review",
  snapshotDigest: digestJson(snapshot),
  cliVersion: "1.0.0",
  run: { id: "run", job: "claude", attempt: 1 },
  outcome: "positive",
  payload,
  payloadDigest: digestJson(payload),
  patch: null,
  startedAt: "2026-07-28T10:00:00.000Z",
  completedAt: "2026-07-28T10:00:01.000Z",
};

async function invoke(argv, input, fixtures = {}, env = {}, extra = {}) {
  let out = "";
  let err = "";
  const code = await run({
    argv,
    env,
    stdin: input,
    stdout: { write: value => { out += value; } },
    stderr: { write: value => { err += value; } },
    readFixture: async name => {
      if (!Object.hasOwn(fixtures, name)) throw new Error("fixture not found");
      return fixtures[name];
    },
    ...extra,
  });
  return { code, out, err };
}

async function operationalFixture(t, value, trustedFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "adw-source");
  const control = join(source, "control");
  await mkdir(join(control, "adw"), { recursive: true });
  const files = { "adw/main.mjs": "export {};\n", ...trustedFiles };
  const controlPaths = [];
  let index = 1;
  for (const path of Object.keys(files).sort()) {
    const bytes = Buffer.from(files[path]);
    await mkdir(join(control, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(control, path), bytes);
    controlPaths.push({ path, tree: "e".repeat(40), blob: String(index++).repeat(40), digest: digestBytes(bytes), size: bytes.length });
  }
  const bundle = Buffer.from("# v2 git bundle\n\n");
  const manifest = {
    schemaVersion: 1, controlSha, repository: value.repository,
    control: { paths: controlPaths },
    target: { bundle: { digest: digestBytes(bundle), size: bundle.length }, refs: [], shas: [], paths: [] },
  };
  await writeFile(join(source, "target.bundle"), bundle);
  const manifestBytes = canonicalBytes(manifest);
  await writeFile(join(source, "manifest.json"), manifestBytes);
  await writeFile(join(source, "manifest.sha256"), `${digestBytes(manifestBytes)}\n`);
  return {
    root, source, executablePath: join(control, "adw", "main.mjs"),
    snapshotArtifact: join(root, "adw-snapshot"), decisionArtifact: join(root, "adw-decision"),
    verificationArtifact: join(root, "adw-verification"), resultArtifact: join(root, "adw-apply-result"),
  };
}

test("validate emits canonical JSON", async () => {
  const result = await invoke(["validate", "snapshot"], JSON.stringify(snapshot));
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.deepEqual(JSON.parse(result.out), snapshot);
  assert.ok(result.out.endsWith("\n"));
});

test("reduce derives canonical policy from the stamped role", async () => {
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment] }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).kind, "state");
  assert.ok(JSON.parse(result.out).operations.some(value => value.type === "publish_check"));
  const unknown = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment], surprise: true }));
  assert.equal(unknown.code, 6);
});

test("reduce binds patch sidecar bytes before emitting patch decision", async () => {
  const bytes = Buffer.from("x");
  const patch = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const envelope = data => ({ trust: "untrusted", source: "fixture", bytes: canonicalBytes(data).length, digest: digestJson(data), data });
  const buildSnapshot = { ...snapshot, event: { kind: "issue", action: "labeled", entityId: "1" }, revisions: [{ resource: "base", kind: "git_ref", token: headSha }], routing: { role: "builder", mode: "single", primary: "claude" }, state: { entityId: "1", labels: [], input: {}, headBranch: "claude/issue-1", baseBranch: "main", title: envelope("Build"), body: envelope("Closes #1") } };
  const buildPayload = { verdict: "patch", summary: "Build", patch };
  const buildAssessment = { ...assessment, role: "builder", model: "claude-opus-4-8", snapshotDigest: digestJson(buildSnapshot), payload: buildPayload, payloadDigest: digestJson(buildPayload), patch };
  const request = { snapshot: buildSnapshot, assessments: [{ assessment: buildAssessment, patchBase64: bytes.toString("base64") }] };
  const result = await invoke(["reduce"], JSON.stringify(request));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out).kind, "patch");
  assert.equal((await invoke(["reduce"], JSON.stringify({ snapshot: buildSnapshot, assessments: [buildAssessment] }))).code, 6);
});

test("operation permission outputs are exact for the reduced decision", () => {
  const scopedSnapshot = {
    ...snapshot,
    revisions: [
      { resource: "repository", kind: "repository", token: "r1" },
      { resource: "trusted:.claude/agents/reviewer.md", kind: "control", token: "r2" },
      { resource: "pull:42:checks", kind: "checks", token: "r3" },
    ],
  };
  const decision = {
    schemaVersion: 1, controlSha, snapshotDigest: digestJson(scopedSnapshot), assessmentDigests: [], kind: "state", patch: null,
    operations: [
      { type: "publish_check", headSha, name: "reviewer", conclusion: "success", summary: "approved", externalId: "review" },
      { type: "add_label", entityId: "42", label: "reviewed" },
    ],
  };
  assert.deepEqual(operationPermissionOutputs(decision, scopedSnapshot), {
    applyClass: "checks:read+checks:write+contents:read+issues:write+pulls:read+repository:read",
    capabilities: ["checks:read", "checks:write", "contents:read", "issues:write", "pulls:read", "repository:read"],
    permissions: { checks: "write", contents: "read", issues: "write", metadata: "read", pull_requests: "read" },
  });
});

test("reconcile accepts normalized state", async () => {
  const scheduled = {
    ...snapshot,
    event: { kind: "schedule", action: "reconcile", entityId: "repository" },
    state: { currentRevisions: {} },
  };
  const result = await invoke(["reconcile"], JSON.stringify({
    snapshot: scheduled,
    routes: [],
    pulls: [],
    labelSync: { wantedDigest: "f".repeat(64), liveDigest: "f".repeat(64) },
    comments: [], trust: { ownerIds: ["U_owner"], appId: "A_smith" },
    reviews: [], pioneers: [], holds: [],
  }));
  assert.deepEqual(JSON.parse(result.out), []);
});

test("operational reduce closes after the one declared fallback attempt", async t => {
  const fixture = await operationalFixture(t, snapshot, {
    ".claude/agents/reviewer.md": "Review.\n",
    "adw/schemas/role-payloads/review.schema.json": "{}\n",
  });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, snapshot);
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact,
    ADW_PRIMARY_ASSESSMENT_ARTIFACT: join(fixture.root, "missing-primary"),
    ADW_FALLBACK_ASSESSMENT_ARTIFACT: join(fixture.root, "missing-fallback"),
    ADW_DECISION_ARTIFACT: fixture.decisionArtifact, ADW_CONTROL_SHA: controlSha,
    ADW_FALLBACK_ATTEMPTED: "true",
  };
  const result = await invoke(["reduce"], "", {}, env, { executablePath: fixture.executablePath });
  assert.equal(result.code, 4, result.err);
  assert.deepEqual(JSON.parse(result.out), { status: "terminal", provider: null, reason: "providers_unavailable" });
  const decision = JSON.parse(await readFile(join(fixture.decisionArtifact, "decision.json")));
  assert.equal(decision.operations[0].type, "publish_check");
  assert.equal(decision.operations[0].conclusion, "failure");
});

test("operational assess writes unable evidence before exit 4 while negative and noop remain successful", async t => {
  const fixture = await operationalFixture(t, snapshot, {
    ".claude/agents/reviewer.md": "Review.\n",
    "adw/schemas/role-payloads/review.schema.json": "{}\n",
  });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, snapshot);
  const runnerTemporary = join(fixture.root, "runner");
  await mkdir(runnerTemporary);
  const cases = [
    ["unable", payload, 4],
    ["negative", { verdict: "reject", risk: "high", findings: [] }, 0],
    ["noop", { verdict: "noop", reason: "nothing to do" }, 0],
  ];
  for (const [outcome, resultPayload, expectedCode] of cases) {
    const assessmentArtifact = join(fixture.root, `assessment-${outcome}`);
    const record = {
      ...assessment, outcome, payload: resultPayload, payloadDigest: digestJson(resultPayload), cliVersion: "2.1.220",
      run: { id: "run", job: "claude", attempt: 1 },
    };
    const env = {
      ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact,
      ADW_ASSESSMENT_ARTIFACT: assessmentArtifact, ADW_TARGET_DIRECTORY: join(fixture.root, `target-${outcome}`),
      ADW_RUNNER_TEMP: runnerTemporary, ADW_NPM_PATH: process.execPath, ADW_CONTROL_SHA: controlSha,
      ADW_PROVIDER_CREDENTIAL: "provider-secret", ADW_RUN_ID: "run", ADW_JOB_ID: "claude",
      ADW_RUN_ATTEMPT: "1", ADW_IDEMPOTENCY_KEY: assessment.idempotencyKey,
    };
    const provider = { install: async () => ({ executable: process.execPath, version: "2.1.220" }), invoke: async () => ({ assessment: record, patchBytes: null }) };
    const result = await invoke(["assess", "--provider", "claude"], "", {}, env, { executablePath: fixture.executablePath, adapters: { provider } });
    assert.equal(result.code, expectedCode, result.err);
    assert.equal(JSON.parse(await readFile(join(assessmentArtifact, "envelope.json"))).outcome, outcome);
  }
});

test("operational reconcile consumes only canonical snapshot/source and writes a decision", async t => {
  const authoritySnapshot = {
    schemaVersion: 1, controlSha,
    event: { kind: "schedule", action: "reconcile", entityId: "R_1" },
    repository: snapshot.repository,
    revisions: [], routing: { role: "reconciler", mode: "single", primary: null },
    state: { entityId: "R_1", currentRevisions: { "issue:7": "2".repeat(64) }, reconciliation: {
      routes: [{ issueId: "7", sourceRevision: "1".repeat(64), status: "primary", primary: "claude", fallback: "codex", primaryOutcome: null, fallbackOutcome: null, artifactDigest: null, prId: null }],
      pulls: [], labelSync: { wantedDigest: "1".repeat(64), liveDigest: "1".repeat(64) }, comments: [],
      trust: { ownerIds: ["7"], appId: "9" }, reviews: [], pioneers: [], holds: [], cancelledApplies: [],
    } },
  };
  const fixture = await operationalFixture(t, authoritySnapshot, { ".github/labels.yml": "" });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, authoritySnapshot);
  const githubOutput = join(fixture.root, "github-output");
  await writeFile(githubOutput, "");
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact,
    ADW_CONTROL_SHA: controlSha, ADW_EMIT_GITHUB_OUTPUT: "exact-permissions-v1", GITHUB_OUTPUT: githubOutput,
  };
  const result = await invoke(["reconcile"], "", {}, env, { executablePath: fixture.executablePath });
  assert.equal(result.code, 0, result.err);
  const decision = JSON.parse(await readFile(join(fixture.decisionArtifact, "decision.json")));
  assert.equal(decision.operations[0].type, "dispatch_repository");
  assert.equal(decision.operations[0].eventType, "retry_route");
  assert.equal(decision.operations[0].clientPayload.role, "builder");
  assert.equal(decision.assessmentDigests.length, 0);
  const outputs = await readFile(githubOutput, "utf8");
  assert.match(outputs, /^apply_class=contents:write\+repository:read$/m);
  assert.match(outputs, /^apply_capabilities=\["contents:write","repository:read"\]$/m);
  assert.match(outputs, /^apply_permissions=\{"contents":"write","metadata":"read"\}$/m);
  assert.match(outputs, /^permission_actions=$/m);
  assert.match(outputs, /^permission_checks=$/m);
  assert.match(outputs, /^permission_contents=write$/m);
  assert.match(outputs, /^permission_metadata=read$/m);
  assert.match(outputs, /^permission_issues=$/m);
});

test("operational audit consumes full settings/labels/rulesets state and writes only a decision", async t => {
  const ruleset = { name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [], bypass_actors: [] };
  const auditSnapshot = {
    schemaVersion: 1, controlSha,
    event: { kind: "schedule", action: "audit", entityId: "R_1" }, repository: snapshot.repository,
    revisions: [], routing: { role: "auditor", mode: "single", primary: null },
    state: { entityId: "R_1", trust: { ownerIds: ["7"], appId: "9" }, resources: {
      "trusted:.github/rulesets/main.json": { data: JSON.stringify(ruleset) }, "trusted:.github/labels.yml": { data: "" },
      rulesets: [ruleset], labels: [], pulls: [], settings: { allowAutoMerge: true, allowMergeCommit: false, allowRebaseMerge: false, allowSquashMerge: true, deleteBranchOnMerge: true },
    } },
  };
  const fixture = await operationalFixture(t, auditSnapshot, { ".github/labels.yml": "", ".github/rulesets/main.json": JSON.stringify(ruleset) });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, auditSnapshot);
  const env = { ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact, ADW_CONTROL_SHA: controlSha };
  const result = await invoke(["audit"], "", {}, env, { executablePath: fixture.executablePath });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).operations, [{ type: "noop", reason: "unchanged" }]);
});

test("operational apply consumes exact artifacts and emits canonical apply result", async t => {
  const value = {
    ...snapshot,
    event: { kind: "issue", action: "opened", entityId: "1" }, revisions: [],
    routing: { role: "triager", mode: "single", primary: "codex" }, state: { entityId: "1", labels: [] },
  };
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const canonicalDecision = { schemaVersion: 1, controlSha, snapshotDigest: digestJson(value), assessmentDigests: [], kind: "state", operations: [operation], patch: null };
  const proof = { schemaVersion: 1, controlSha, decisionDigest: digestJson(canonicalDecision), kind: "state", preconditionDigest: digestJson(value.revisions), patch: null, resultTree: null };
  const fixture = await operationalFixture(t, value, { ".claude/agents/triager.md": "Triage.\n", "adw/schemas/role-payloads/triage.schema.json": "{}\n" });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, value);
  await writeTransportArtifact("decision", fixture.decisionArtifact, canonicalDecision);
  await writeTransportArtifact("verification", fixture.verificationArtifact, proof);
  const raw = { operationDigest: digestJson(operation), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: "1".repeat(64), afterRevision: "1".repeat(64) };
  const github = { apply: async request => ({ decisionDigest: request.verification.decisionDigest, verificationDigest: digestJson(request.verification), operations: [raw] }) };
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact,
    ADW_VERIFICATION_ARTIFACT: fixture.verificationArtifact, ADW_APPLY_RESULT_ARTIFACT: fixture.resultArtifact,
    ADW_REPOSITORY: "bugabinga/smith", ADW_CONTROL_SHA: controlSha, ADW_GITHUB_TOKEN_EXPIRES_AT: "job-scoped",
  };
  const before = Date.now();
  const result = await invoke(["apply"], "", {}, env, { executablePath: fixture.executablePath, adapters: { github } });
  assert.equal(result.code, 0, result.err);
  const expiry = Date.parse(env.ADW_GITHUB_TOKEN_EXPIRES_AT);
  assert.ok(expiry >= before + 2_699_000 && expiry <= Date.now() + 2_700_000);
  const receipt = JSON.parse(await readFile(join(fixture.resultArtifact, "result.json")));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.operations[0].receipts[0].projection, "github_state");
  assert.equal(await readFile(join(fixture.resultArtifact, "result.sha256"), "utf8"), `${digestBytes(canonicalBytes(receipt))}\n`);
});

test("prior apply reader selects only the latest bounded canonical prior attempt", async t => {
  const root = await mkdtemp(join(tmpdir(), "smith-adw-prior-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = join(root, "receipts");
  await mkdir(receipts);
  await writeTransportArtifact("applyResult", join(receipts, "adw-apply-result-1"), { attempt: 1 });
  await writeTransportArtifact("applyResult", join(receipts, "adw-apply-result-2"), { attempt: 2 });
  assert.deepEqual(await readPreviousApplyResult(receipts, 3), { attempt: 2 });
  assert.equal(await readPreviousApplyResult(join(root, "missing"), 2), null);

  const invalid = join(root, "invalid");
  await mkdir(invalid);
  await mkdir(join(invalid, "adw-apply-result-latest"));
  await assert.rejects(() => readPreviousApplyResult(invalid, 2), error => error?.code === "input");

  const oversized = join(root, "oversized");
  await mkdir(oversized);
  await Promise.all(Array.from({ length: 101 }, (_, index) => mkdir(join(oversized, `adw-apply-result-${index + 1}`))));
  await assert.rejects(() => readPreviousApplyResult(oversized, 102), error => error?.code === "input");
});

test("operational apply always emits a sanitized partial-failure artifact", async t => {
  const value = {
    ...snapshot, event: { kind: "issue", action: "opened", entityId: "1" }, revisions: [],
    routing: { role: "triager", mode: "single", primary: "codex" }, state: { entityId: "1", labels: [] },
  };
  const operations = [{ type: "add_label", entityId: "1", label: "ready" }, { type: "add_label", entityId: "1", label: "blocked" }];
  const canonicalDecision = { schemaVersion: 1, controlSha, snapshotDigest: digestJson(value), assessmentDigests: [], kind: "state", operations, patch: null };
  const proof = { schemaVersion: 1, controlSha, decisionDigest: digestJson(canonicalDecision), kind: "state", preconditionDigest: digestJson(value.revisions), patch: null, resultTree: null };
  const fixture = await operationalFixture(t, value, { ".claude/agents/triager.md": "Triage.\n", "adw/schemas/role-payloads/triage.schema.json": "{}\n" });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, value);
  await writeTransportArtifact("decision", fixture.decisionArtifact, canonicalDecision);
  await writeTransportArtifact("verification", fixture.verificationArtifact, proof);
  const first = { operationDigest: digestJson(operations[0]), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: "1".repeat(64), afterRevision: "1".repeat(64) };
  const github = { apply: async () => { throw new AdwError("forge", "secret-token API body", { partialReceipt: { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [first] } }); } };
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact,
    ADW_VERIFICATION_ARTIFACT: fixture.verificationArtifact, ADW_APPLY_RESULT_ARTIFACT: fixture.resultArtifact,
    ADW_REPOSITORY: "bugabinga/smith", ADW_CONTROL_SHA: controlSha,
  };
  const result = await invoke(["apply"], "", {}, env, { executablePath: fixture.executablePath, adapters: { github } });
  assert.equal(result.code, 5);
  const receipt = JSON.parse(await readFile(join(fixture.resultArtifact, "result.json")));
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.failure.message, "forge operation failed");
  assert.equal(JSON.stringify(receipt).includes("secret-token"), false);
  assert.equal(result.err.includes("secret-token"), false);
});

test("operational dry-run runs exact artifacts with only writer replaced and ignores caller intents", async t => {
  const value = {
    ...snapshot, event: { kind: "issue", action: "opened", entityId: "1" }, revisions: [],
    routing: { role: "triager", mode: "single", primary: "codex" }, state: { entityId: "1", labels: [] },
  };
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const canonicalDecision = { schemaVersion: 1, controlSha, snapshotDigest: digestJson(value), assessmentDigests: [], kind: "state", operations: [operation], patch: null };
  const proof = { schemaVersion: 1, controlSha, decisionDigest: digestJson(canonicalDecision), kind: "state", preconditionDigest: digestJson(value.revisions), patch: null, resultTree: null };
  const fixture = await operationalFixture(t, value, { ".claude/agents/triager.md": "Triage.\n", "adw/schemas/role-payloads/triage.schema.json": "{}\n" });
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, value);
  await writeTransportArtifact("decision", fixture.decisionArtifact, canonicalDecision);
  await writeTransportArtifact("verification", fixture.verificationArtifact, proof);
  const dryRunArtifact = join(fixture.root, "adw-dry-run");
  let request;
  const github = { recordApply: async value => {
    request = value;
    const raw = { operationDigest: digestJson(operation), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: proof.preconditionDigest, afterRevision: proof.preconditionDigest };
    return { receipt: { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [raw] }, intents: [operation] };
  } };
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact,
    ADW_VERIFICATION_ARTIFACT: fixture.verificationArtifact, ADW_DRY_RUN_ARTIFACT: dryRunArtifact,
    ADW_REPOSITORY: "bugabinga/smith", ADW_CONTROL_SHA: controlSha,
  };
  const caller = { operations: [{ type: "comment", entityId: "1", body: "forged", marker: "forged" }] };
  const result = await invoke(["dry-run"], JSON.stringify(caller), {}, env, { executablePath: fixture.executablePath, adapters: { github } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(request.decision.operations, [operation]);
  const artifact = JSON.parse(await readFile(join(dryRunArtifact, "dry-run.json")));
  assert.deepEqual(artifact.intents.map(value => value.operation), [operation]);
  assert.equal(JSON.stringify(artifact).includes("forged"), false);
});

test("final patch dry-run performs and records the read-only VCS projection without credentials", async t => {
  const bytes = Buffer.from("patch");
  const manifest = { baseSha: headSha, digest: digestBytes(bytes), size: bytes.length, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const operation = { type: "create_pr", head: "claude/issue-1", base: "main", title: "Patch", body: "Body", marker: "patch" };
  const value = {
    ...snapshot, event: { kind: "issue", action: "opened", entityId: "1" },
    revisions: [{ resource: "patch-base:main", kind: "git_ref", token: headSha }],
    routing: { role: "builder", mode: "single", primary: "claude" }, state: { entityId: "1", labels: [] },
  };
  const canonicalDecision = { schemaVersion: 1, controlSha, snapshotDigest: digestJson(value), assessmentDigests: [], kind: "patch", operations: [operation], patch: manifest };
  const proof = { schemaVersion: 1, controlSha, decisionDigest: digestJson(canonicalDecision), kind: "patch", preconditionDigest: digestJson(value.revisions), patch: manifest, resultTree: "c".repeat(40) };
  const fixture = await operationalFixture(t, value, { ".claude/agents/builder.md": "Build.\n", "adw/schemas/role-payloads/change.schema.json": "{}\n" });
  const sourceManifestPath = join(fixture.source, "manifest.json");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath));
  sourceManifest.target.shas = [headSha];
  const sourceManifestBytes = canonicalBytes(sourceManifest);
  await writeFile(sourceManifestPath, sourceManifestBytes);
  await writeFile(join(fixture.source, "manifest.sha256"), `${digestBytes(sourceManifestBytes)}\n`);
  await writeTransportArtifact("snapshot", fixture.snapshotArtifact, value);
  await writeTransportArtifact("decision", fixture.decisionArtifact, canonicalDecision, bytes);
  await writeTransportArtifact("verification", fixture.verificationArtifact, proof, bytes);
  const targetDirectory = join(fixture.root, "target");
  const temporaryDirectory = join(fixture.root, "temporary");
  await mkdir(temporaryDirectory);
  const dryRunArtifact = join(fixture.root, "adw-dry-run");
  const projectedHead = "d".repeat(40);
  let projectionRequest;
  let recordRequest;
  const vcs = {
    materializeBundle: async () => ({ refs: [], shas: [headSha], paths: [] }),
    projectVerifiedPatch: async request => {
      projectionRequest = request;
      assert.equal(Object.hasOwn(request, "credential"), false);
      return { operationDigest: digestJson(operation), projection: "vcs_head", status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: "1".repeat(64), afterRevision: "1".repeat(64), headSha: projectedHead };
    },
  };
  const github = { recordApply: async request => {
    recordRequest = request;
    const raw = { operationDigest: digestJson(operation), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: proof.preconditionDigest, afterRevision: proof.preconditionDigest };
    return { receipt: { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [raw] }, intents: [operation] };
  } };
  const env = {
    ADW_SOURCE_ARTIFACT: fixture.source, ADW_SNAPSHOT_ARTIFACT: fixture.snapshotArtifact, ADW_DECISION_ARTIFACT: fixture.decisionArtifact,
    ADW_VERIFICATION_ARTIFACT: fixture.verificationArtifact, ADW_DRY_RUN_ARTIFACT: dryRunArtifact,
    ADW_REPOSITORY: "bugabinga/smith", ADW_CONTROL_SHA: controlSha, ADW_TARGET_DIRECTORY: targetDirectory,
    ADW_TEMPORARY_DIRECTORY: temporaryDirectory, ADW_GIT_PATH: process.execPath,
  };
  const result = await invoke(["dry-run"], "", {}, env, { executablePath: fixture.executablePath, adapters: { github, vcs, vcsAuthority: { expectedRemote: "https://github.com/bugabinga/smith.git" } } });
  assert.equal(result.code, 0, result.err);
  assert.equal(projectionRequest.expectedRemote, "https://github.com/bugabinga/smith.git");
  assert.deepEqual(recordRequest.vcsProjections, [{ operationDigest: digestJson(operation), headSha: projectedHead }]);
  const artifact = JSON.parse(await readFile(join(dryRunArtifact, "dry-run.json")));
  assert.equal(artifact.intents[0].vcsReceipt.headSha, projectedHead);
});

test("stdin fixture commands ignore operational and unknown environment", async () => {
  const result = await invoke(["validate", "snapshot"], JSON.stringify(snapshot), {}, { ADW_CONTROL_SHA: "f".repeat(40), GH_TOKEN: "ignored" });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), snapshot);
});

test("partial operational reduce environment never falls through to legacy stdin", async () => {
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [assessment] }), {}, { ADW_CONTROL_SHA: controlSha });
  assert.equal(result.code, 6);
  assert.equal(result.out, "");
  assert.match(JSON.parse(result.err).message, /ADW_SOURCE_ARTIFACT/);
});

test("fixture reads are basename-only", async () => {
  const good = await invoke(["validate", "snapshot", "--fixture", "snapshot.json"], "", { "snapshot.json": JSON.stringify(snapshot) });
  assert.equal(good.code, 0);
  const bad = await invoke(["validate", "snapshot", "--fixture", "../snapshot.json"], "", {});
  assert.equal(bad.code, 2);
});

test("errors use stable exit classes and sanitized JSON", async () => {
  const invalidSnapshot = await invoke(["validate", "snapshot"], "{}");
  assert.equal(invalidSnapshot.code, 2);
  assert.equal(JSON.parse(invalidSnapshot.err).error, "contract");
  const invalidAssessment = await invoke(["validate", "assessment"], "{}");
  assert.equal(invalidAssessment.code, 6);
  const unsupported = await invoke(["explode"], "{}");
  assert.equal(unsupported.code, 2);
  const unknownRecord = await invoke(["validate", "banana"], "{}");
  assert.equal(unknownRecord.code, 2);
  const malformedArtifact = await invoke(["reduce"], "{");
  assert.equal(malformedArtifact.code, 6);
});

test("provider failure and pending fallback use provider exit status", async () => {
  const unavailable = { ...assessment, outcome: "unable" };
  const result = await invoke(["reduce"], JSON.stringify({ snapshot, assessments: [unavailable] }));
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.out).status, "fallback");
});

test("executable path sanitizes oversized stdin", async () => {
  let err = "";
  const code = await execute({
    argv: ["validate", "snapshot"],
    stdin: Readable.from([Buffer.alloc(262145)]),
    stdout: { write() {} },
    stderr: { write: value => { err += value; } },
    readFixture: async () => "",
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(err).error, "input");

  err = "";
  const artifactCode = await execute({
    argv: ["reduce"],
    stdin: Readable.from([Buffer.alloc(262145)]),
    stdout: { write() {} },
    stderr: { write: value => { err += value; } },
    readFixture: async () => "",
  });
  assert.equal(artifactCode, 6);
});

test("stdin reader stops at the transport ceiling", async () => {
  await assert.rejects(
    () => readBounded(Readable.from([Buffer.alloc(262144), Buffer.from("x")])),
    error => error?.code === "input",
  );
  assert.equal(await readBounded(Readable.from(["{}"])), "{}");
});
