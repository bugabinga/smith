import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  digestJson,
  validateAssessment,
  validateAssessmentArtifact,
  validateDecision,
  validateSnapshot,
  validateVerification,
  qualifyAssessment,
  reduceAssessments,
  holdReasons,
  mergeEligibility,
  nextBuilderRoute,
  reduceReviews,
  reduceRisk,
  idempotencyKey,
  planReconciliation,
  validateOperation,
  validatePatchManifest,
} from "../core.mjs";
import { defineRole } from "../roles.mjs";

test("canonical JSON sorts object keys without sorting arrays", () => {
  assert.equal(
    canonicalBytes({ z: [2, 1], a: { y: true, x: null } }).toString(),
    '{"a":{"x":null,"y":true},"z":[2,1]}',
  );
  assert.equal(digestJson({ b: 2, a: 1 }), digestJson({ a: 1, b: 2 }));
  assert.notEqual(digestJson([1, 2]), digestJson([2, 1]));
  assert.equal(digestBytes(Buffer.from("smith")).length, 64);
});

test("canonical JSON rejects values outside the transport domain", () => {
  for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => canonicalBytes(value),
      error => error instanceof AdwError && error.code === "contract",
    );
  }
  assert.throws(() => canonicalBytes([, 1]), AdwError);
  assert.throws(() => canonicalBytes({ missing: undefined }), AdwError);
});

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);

const snapshot = {
  schemaVersion: 1,
  controlSha,
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [{ resource: "pull:42", kind: "pull", token: headSha }],
  routing: { role: "reviewer", mode: "quorum", primary: null },
  state: {},
};

const payload = { verdict: "approve", findings: [] };
const assessment = {
  schemaVersion: 1,
  controlSha,
  role: "reviewer",
  provider: "claude",
  model: "fixture-claude",
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

const decision = {
  schemaVersion: 1,
  controlSha,
  snapshotDigest: assessment.snapshotDigest,
  assessmentDigests: [digestJson(assessment)],
  kind: "state",
  operations: [{
    type: "publish_check",
    headSha,
    name: "merge-gate",
    conclusion: "success",
    summary: "approved",
    externalId: "review:42",
  }],
  patch: null,
};

const verification = {
  schemaVersion: 1,
  controlSha,
  decisionDigest: digestJson(decision),
  kind: "state",
  preconditionDigest: digestJson(snapshot.revisions),
  patch: null,
  resultTree: null,
};

test("transport validators freeze valid records", () => {
  for (const [validator, value] of [
    [validateSnapshot, snapshot],
    [validateAssessment, assessment],
    [validateDecision, decision],
    [validateVerification, verification],
  ]) {
    const validated = validator(structuredClone(value));
    assert.deepEqual(validated, value);
    assert.ok(Object.isFrozen(validated));
  }
});

test("transport validators reject missing and unknown fields", () => {
  for (const [validator, value] of [
    [validateSnapshot, snapshot],
    [validateAssessment, assessment],
    [validateDecision, decision],
    [validateVerification, verification],
  ]) {
    const missing = structuredClone(value);
    delete missing.controlSha;
    assert.throws(() => validator(missing), error => error?.code === "contract");
    assert.throws(() => validator({ ...value, surprise: true }), error => error?.code === "contract");
  }
});

test("assessment artifact binds exact patch bytes", () => {
  const bytes = Buffer.from("diff --git a/a b/a\n");
  const patch = {
    baseSha: headSha,
    digest: digestBytes(bytes),
    size: bytes.length,
    files: [{ path: "a", kind: "regular", oldMode: "100644", newMode: "100644" }],
  };
  const patched = { ...assessment, patch };
  assert.deepEqual(validateAssessmentArtifact({ assessment: patched, patchBytes: bytes }).patch, patch);
  assert.throws(
    () => validateAssessmentArtifact({ assessment: patched, patchBytes: Buffer.from("wrong") }),
    error => error?.code === "contract",
  );
  assert.throws(
    () => validateAssessmentArtifact({ assessment, patchBytes: bytes }),
    error => error?.code === "contract",
  );
});

test("transport schemas are strict draft 2020-12 JSON", async () => {
  for (const name of ["snapshot", "assessment", "decision", "verification"]) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url)));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    if (schema.$defs?.patch) assert.equal(schema.$defs.patch.properties.files.items.additionalProperties, false);
  }
  const decisionSchema = JSON.parse(await readFile(new URL("../schemas/decision.schema.json", import.meta.url)));
  assert.equal(decisionSchema.$defs.operation.oneOf.length, operationSamples.length);
  assert.ok(decisionSchema.$defs.operation.oneOf.every(shape => shape.additionalProperties === false));
  for (const type of ["close_issue", "noop", "terminal"]) {
    const shape = decisionSchema.$defs.operation.oneOf.find(item => item.properties.type.const === type);
    assert.ok(shape.properties.reason.enum.length > 0);
  }
});

test("decision and verification enforce the transport byte ceiling", () => {
  assert.throws(
    () => validateDecision({ ...decision, operations: [{ type: "comment", entityId: "I_1", body: "x".repeat(262144), marker: "m" }] }),
    error => error?.code === "contract",
  );
  const oversizedPatch = {
    baseSha: headSha,
    digest: "c".repeat(64),
    size: 1,
    files: Array.from({ length: 100 }, (_, i) => ({ path: `${i}-${"x".repeat(3000)}`, kind: "regular", oldMode: "100644", newMode: "100644" })),
  };
  assert.throws(
    () => validateVerification({ ...verification, kind: "patch", patch: oversizedPatch, resultTree: "d".repeat(40) }),
    error => error?.code === "contract",
  );
});

test("patch verification requires matching metadata and result tree", () => {
  const patch = { baseSha: headSha, digest: "c".repeat(64), size: 12, files: [] };
  assert.throws(() => validateVerification({ ...verification, kind: "patch", patch }), AdwError);
  const value = { ...verification, kind: "patch", patch, resultTree: "d".repeat(40) };
  assert.equal(validateVerification(value).resultTree, value.resultTree);
});

function policy(mode, primary = null, fallback = null) {
  return defineRole({
    name: "reviewer",
    charter: ".claude/agents/reviewer.md",
    mode,
    primary,
    fallback,
    providers: ["claude", "codex"],
    providerConfig: {
      claude: { model: "fixture-claude", effort: "high", timeoutSeconds: 300 },
      codex: { model: "fixture-codex", effort: "high", timeoutSeconds: 300 },
    },
    capabilities: ["pulls:read"],
    snapshot: { fields: ["pull"], maxBytes: 262144 },
    payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
    operations: ["publish_check", "terminal"],
    fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
    patch: null,
  });
}

function patchPolicy(rolePolicy) {
  return defineRole({
    ...structuredClone(rolePolicy),
    patch: {
      maxBytes: 1024,
      maxFiles: 10,
      allowedPrefixes: ["a", "docs/"],
      deniedPaths: ["adw/**", "docs/SPEC.md"],
    },
  });
}

function providerAssessment(provider, overrides = {}) {
  const nextPayload = overrides.payload ?? payload;
  return {
    ...assessment,
    provider,
    model: `fixture-${provider}`,
    run: { ...assessment.run, job: provider },
    payload: nextPayload,
    payloadDigest: digestJson(nextPayload),
    ...overrides,
  };
}

test("assessment qualification distinguishes artifacts from provider failure", () => {
  const single = policy("single", "claude", "codex");
  assert.equal(qualifyAssessment({ snapshot, rolePolicy: single, provider: "claude", assessment }).status, "artifact");
  assert.deepEqual(
    qualifyAssessment({ snapshot, rolePolicy: single, provider: "claude", assessment: providerAssessment("claude", { outcome: "unable" }) }),
    { status: "fallback", reason: "unavailable" },
  );
  assert.equal(qualifyAssessment({ snapshot, rolePolicy: single, provider: "claude", assessment: null }).status, "fallback");
  assert.equal(qualifyAssessment({ snapshot, rolePolicy: single, provider: "claude", assessment: { ...assessment, controlSha: "f".repeat(40) } }).status, "fallback");
  assert.equal(qualifyAssessment({ snapshot, rolePolicy: single, provider: "claude", assessment: { ...assessment, model: "wrong-model" } }).status, "fallback");
});

test("protected input refuses fallback authority", () => {
  const single = policy("single", "claude", "codex");
  const protectedSnapshot = { ...snapshot, state: { input: { protected: true } } };
  assert.deepEqual(
    qualifyAssessment({ snapshot: protectedSnapshot, rolePolicy: single, provider: "codex", assessment: providerAssessment("codex") }),
    { status: "terminal", reason: "fallback_forbidden" },
  );
  const malformed = { ...snapshot, state: { input: { protected: "yes" } } };
  assert.deepEqual(
    qualifyAssessment({ snapshot: malformed, rolePolicy: single, provider: "codex", assessment: providerAssessment("codex") }),
    { status: "terminal", reason: "contract" },
  );
});

test("single reduction is symmetric and valid primary skips fallback", () => {
  for (const [primary, fallback] of [["claude", "codex"], ["codex", "claude"]]) {
    const result = reduceAssessments({
      snapshot,
      rolePolicy: policy("single", primary, fallback),
      assessments: [providerAssessment(primary), providerAssessment(fallback)],
    });
    assert.equal(result.status, "artifact");
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0], digestJson(providerAssessment(primary)));
    assert.equal(result.authoritative, true);
  }
});

test("single reduction accepts fallback only after primary failure", () => {
  const result = reduceAssessments({
    snapshot,
    rolePolicy: policy("single", "claude", "codex"),
    assessments: [providerAssessment("claude", { outcome: "unable" }), providerAssessment("codex")],
  });
  assert.equal(result.status, "artifact");
  assert.deepEqual(result.selected, [digestJson(providerAssessment("codex"))]);
});

test("quorum selects both providers and rejects conflicting patches", () => {
  const quorum = policy("quorum");
  const result = reduceAssessments({ snapshot, rolePolicy: quorum, assessments: [providerAssessment("codex"), providerAssessment("claude")] });
  assert.equal(result.status, "artifact");
  assert.equal(result.selected.length, 2);
  assert.equal(result.authoritative, true);
  assert.equal(reduceAssessments({ snapshot, rolePolicy: quorum, assessments: [providerAssessment("claude")] }).reason, "quorum_incomplete");

  const bytesA = Buffer.from("a");
  const bytesB = Buffer.from("b");
  const patchA = { baseSha: headSha, digest: digestBytes(bytesA), size: 1, files: [] };
  const patchB = { baseSha: headSha, digest: digestBytes(bytesB), size: 1, files: [] };
  const conflict = reduceAssessments({
    snapshot,
    rolePolicy: patchPolicy(quorum),
    assessments: [
      { assessment: providerAssessment("claude", { patch: patchA }), patchBytes: bytesA },
      { assessment: providerAssessment("codex", { patch: patchB }), patchBytes: bytesB },
    ],
  });
  assert.equal(conflict.reason, "patch_conflict");
});

test("advisory reduction cannot become authoritative", () => {
  const result = reduceAssessments({
    snapshot,
    rolePolicy: policy("advisory", "codex", "claude"),
    assessments: [providerAssessment("codex")],
  });
  assert.equal(result.status, "artifact");
  assert.equal(result.authoritative, false);
});

test("hold reasons are closed, sorted, and unique", () => {
  assert.deepEqual(
    holdReasons(["bug", "risk:high", "hold", "needs:owner", "hold"]),
    ["hold", "needs:owner", "risk:high"],
  );
});

test("builder route follows one bounded fallback", () => {
  const route = {
    sourceRevision: "r1",
    headSha,
    status: "unarmed",
    primaryOutcome: null,
    fallbackOutcome: null,
  };
  assert.equal(nextBuilderRoute(route, "r1").status, "primary");
  assert.equal(nextBuilderRoute({ ...route, status: "primary", primaryOutcome: "artifact" }, "r1").status, "complete");
  assert.equal(nextBuilderRoute({ ...route, status: "primary", primaryOutcome: "provider_failure" }, "r1").status, "fallback");
  assert.equal(nextBuilderRoute({ ...route, status: "fallback", primaryOutcome: "provider_failure", fallbackOutcome: "provider_failure" }, "r1").status, "blocked");
  assert.throws(
    () => nextBuilderRoute({ ...route, status: "fallback", fallbackOutcome: "artifact" }, "r1"),
    error => error?.code === "contract",
  );
  assert.equal(nextBuilderRoute({ ...route, status: "complete" }, "r2").status, "unarmed");
});

const trust = { ownerIds: ["U_owner"], appId: "A_smith" };
const correctness = {
  kind: "correctness",
  headSha,
  conclusion: "approve",
  actorId: "A_smith",
  provider: "claude",
  authoritative: true,
  artifactDigest: "c".repeat(64),
};
const security = { ...correctness, kind: "security", provider: "codex", artifactDigest: "d".repeat(64) };

test("review reduction trusts only current-head App evidence", () => {
  assert.deepEqual(
    reduceReviews({ evidence: [correctness, security], headSha, trust, protectedInput: false }),
    { correctness: "approve", security: "approve", conflict: false, reasons: [] },
  );
  const stale = { ...security, headSha: "e".repeat(40) };
  assert.deepEqual(
    reduceReviews({ evidence: [correctness, stale], headSha, trust, protectedInput: false }).reasons,
    ["security_missing"],
  );
  const rejection = { ...security, conclusion: "reject" };
  assert.equal(reduceReviews({ evidence: [correctness, rejection], headSha, trust, protectedInput: false }).conflict, true);
  const fallback = { ...security, authoritative: false };
  assert.deepEqual(
    reduceReviews({ evidence: [correctness, fallback], headSha, trust, protectedInput: true }).reasons,
    ["security_missing"],
  );
});

test("risk clears only through later same-head owner evidence", () => {
  const marker = {
    headSha,
    findingDigest: "f".repeat(64),
    status: "open",
    createdAt: "2026-07-28T10:00:00.000Z",
    clearedAt: null,
  };
  const event = {
    id: "TE_1",
    kind: "label_removed",
    actorId: "U_owner",
    createdAt: "2026-07-28T10:01:00.000Z",
    label: "risk:high",
    headSha,
  };
  assert.equal(reduceRisk({ marker, timeline: [event], headSha, trust }).status, "cleared");
  assert.equal(reduceRisk({ marker, timeline: [{ ...event, actorId: "U_other" }], headSha, trust }).status, "open");
  assert.equal(reduceRisk({ marker, timeline: [event], headSha: "e".repeat(40), trust }).status, "open");
});

test("merge eligibility requires all current-head evidence", () => {
  const state = {
    headSha,
    labels: [],
    checks: [{ name: "check", headSha, conclusion: "success" }],
    reviews: [correctness, security],
    riskMarker: null,
    timeline: [],
    trust,
    autoMergeAllowed: true,
  };
  assert.deepEqual(mergeEligibility(state), { eligible: true, reasons: [] });
  assert.deepEqual(mergeEligibility({ ...state, labels: ["hold"] }), { eligible: false, reasons: ["hold"] });
  assert.deepEqual(mergeEligibility({ ...state, checks: [] }).reasons, ["check_missing"]);
  assert.deepEqual(mergeEligibility({ ...state, autoMergeAllowed: false }).reasons, ["auto_merge_forbidden"]);
});

const operationSamples = [
  { type: "comment", entityId: "I_1", body: "body", marker: "m1" },
  { type: "add_label", entityId: "I_1", label: "bug" },
  { type: "remove_label", entityId: "I_1", label: "hold" },
  { type: "create_issue", title: "title", body: "body", labels: ["bug"], marker: "m2" },
  { type: "update_issue", issueId: "I_1", title: "title" },
  { type: "close_issue", issueId: "I_1", reason: "completed" },
  { type: "create_milestone", title: "M1", description: "desc", marker: "m3" },
  { type: "update_milestone", milestoneId: "M_1", description: "next" },
  { type: "close_milestone", milestoneId: "M_1" },
  { type: "assign_milestone", issueId: "I_1", milestoneId: "M_1" },
  { type: "link_sub_issue", parentId: "I_1", childId: "I_2" },
  { type: "create_branch", name: "feature/x", baseSha: headSha, treeSha: "c".repeat(40) },
  { type: "create_pr", head: "feature/x", base: "main", title: "title", body: "body", marker: "m4" },
  { type: "update_pr", prId: "P_1", headSha },
  { type: "publish_check", headSha, name: "merge-gate", conclusion: "success", summary: "ok", externalId: "e1" },
  { type: "rerun_check", runId: "R_1" },
  { type: "dispatch_workflow", workflow: "check.yml", ref: "main", inputs: {} },
  { type: "arm_auto_merge", prId: "P_1", headSha, method: "squash" },
  { type: "sync_labels", definitionsDigest: "a".repeat(64) },
  { type: "report_drift", title: "drift", body: "body", marker: "m5" },
  { type: "noop", reason: "already_complete" },
  { type: "terminal", reason: "contract" },
];

test("closed operations accept exact fields only", () => {
  const allOperations = defineRole({
    ...structuredClone(policy("quorum")),
    operations: [...new Set(operationSamples.map(value => value.type))].sort(),
  });
  for (const operation of operationSamples) {
    assert.deepEqual(validateOperation(operation, allOperations), operation);
    assert.throws(() => validateOperation({ ...operation, surprise: true }, allOperations), error => error?.code === "contract");
  }
  assert.throws(() => validateOperation({ type: "publish_everything" }, allOperations), error => error?.code === "contract");
});

test("semantic idempotency keys ignore irrelevant ordering", () => {
  const route = { issueId: "1", route: "claude", sourceRevision: "r1" };
  assert.equal(idempotencyKey("issue_route", route), idempotencyKey("issue_route", { ...route }));
  assert.match(idempotencyKey("issue_route", route), /^issue_route:[0-9a-f]{64}$/);
  assert.match(idempotencyKey("pr_review", { prId: "2", headSha, reviewKind: "security" }), /^pr_review:[0-9a-f]{64}$/);
  assert.throws(() => idempotencyKey("unknown", {}), error => error?.code === "contract");
});

test("patch manifest enforces role and global boundaries", () => {
  const patchRole = defineRole({
    ...structuredClone(policy("quorum")),
    patch: {
      maxBytes: 1024,
      maxFiles: 2,
      allowedPrefixes: ["docs/", "smith-core/"],
      deniedPaths: ["adw/**", "docs/SPEC.md"],
    },
  });
  const manifest = {
    baseSha: headSha,
    digest: "a".repeat(64),
    size: 12,
    files: [{ path: "docs/guide.md", kind: "regular", oldMode: "100644", newMode: "100644" }],
  };
  assert.deepEqual(validatePatchManifest(manifest, patchRole), manifest);
  for (const path of ["../secret", "/tmp/x", ".git/config", ".gitmodules", "adw/core.mjs", "docs/SPEC.md", "site/index.html"]) {
    assert.throws(() => validatePatchManifest({ ...manifest, files: [{ ...manifest.files[0], path }] }, patchRole), error => error?.code === "contract");
  }
  assert.throws(() => validatePatchManifest({ ...manifest, files: [{ ...manifest.files[0], kind: "binary" }] }, patchRole), error => error?.code === "contract");
});

test("reconciliation emits only missing normalized obligations", () => {
  const request = {
    snapshot: { ...snapshot, state: { currentRevisions: { "issue:1": "r2" } } },
    routes: [{ issueId: "1", sourceRevision: "r1", status: "primary", primary: "claude", fallback: "codex", artifactDigest: null }],
    pulls: [
      { prId: "2", headSha, merged: true, mergeSha: "c".repeat(40), obligations: [{ role: "docs-writer", status: "missing", artifactDigest: null }] },
      { prId: "3", headSha, merged: true, mergeSha: "d".repeat(40), obligations: [{ role: "docs-writer", status: "complete", artifactDigest: "e".repeat(64) }] },
    ],
    labelSync: { wantedDigest: "f".repeat(64), liveDigest: "0".repeat(64) },
  };
  assert.deepEqual(planReconciliation(request), [
    { kind: "retry_route", issueId: "1", sourceRevision: "r2" },
    { kind: "run_obligation", prId: "2", mergeSha: "c".repeat(40), role: "docs-writer" },
    { kind: "sync_labels", definitionsDigest: "f".repeat(64) },
  ].sort((a, b) => canonicalBytes(a).compare(canonicalBytes(b))));
});

test("transition reducers reject malformed normalized evidence", () => {
  assert.throws(
    () => nextBuilderRoute({ sourceRevision: "r1", headSha, status: "unarmed", primaryOutcome: null, fallbackOutcome: null, extra: true }, "r1"),
    error => error?.code === "contract",
  );
  assert.throws(
    () => reduceReviews({ evidence: [{ ...correctness, actorId: {} }], headSha, trust, protectedInput: false }),
    error => error?.code === "contract",
  );
  assert.throws(
    () => mergeEligibility({ headSha, labels: "hold", checks: [], reviews: [], riskMarker: null, timeline: [], trust, autoMergeAllowed: true }),
    error => error?.code === "contract",
  );
  assert.throws(
    () => mergeEligibility({ headSha, labels: [], checks: [], reviews: [], riskMarker: false, timeline: [], trust, autoMergeAllowed: true }),
    error => error?.code === "contract",
  );
  assert.throws(
    () => mergeEligibility({ headSha, labels: [], checks: [], reviews: [], riskMarker: null, timeline: [{ surprise: true }], trust, autoMergeAllowed: true }),
    error => error?.code === "contract",
  );
});

test("conflicting current-head product checks fail closed", () => {
  const result = mergeEligibility({
    headSha,
    labels: [],
    checks: [
      { name: "check", headSha, conclusion: "success" },
      { name: "check", headSha, conclusion: "failure" },
    ],
    reviews: [correctness, security],
    riskMarker: null,
    timeline: [],
    trust,
    autoMergeAllowed: true,
  });
  assert.deepEqual(result.reasons, ["check_failed"]);
});

test("merge eligibility revalidates sticky risk against current-head owner timeline", () => {
  const marker = {
    headSha: "e".repeat(40),
    findingDigest: "f".repeat(64),
    status: "cleared",
    createdAt: "2026-07-28T10:00:00.000Z",
    clearedAt: "2026-07-28T10:01:00.000Z",
  };
  const result = mergeEligibility({
    headSha,
    labels: [],
    checks: [{ name: "check", headSha, conclusion: "success" }],
    reviews: [correctness, security],
    riskMarker: marker,
    timeline: [],
    trust,
    autoMergeAllowed: true,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("risk:high"));
});

test("patched assessment cannot reduce without bound sidecar bytes", () => {
  const bytes = Buffer.from("x");
  const patch = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [] };
  const result = reduceAssessments({
    snapshot,
    rolePolicy: policy("single", "claude", "codex"),
    assessments: [providerAssessment("claude", { patch })],
  });
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "malformed");
  const patchRole = defineRole({
    ...structuredClone(policy("single", "claude", "codex")),
    patch: null,
  });
  const forbidden = reduceAssessments({
    snapshot,
    rolePolicy: patchRole,
    assessments: [{ assessment: providerAssessment("claude", { patch }), patchBytes: bytes }],
  });
  assert.equal(forbidden.status, "fallback");
});

test("advisory fallback preserves a forbidden terminal", () => {
  const protectedSnapshot = { ...snapshot, state: { input: { protected: true } } };
  const advisory = policy("advisory", "claude", "codex");
  const unavailable = providerAssessment("claude", { outcome: "unable", snapshotDigest: digestJson(protectedSnapshot) });
  const fallback = providerAssessment("codex", { snapshotDigest: digestJson(protectedSnapshot) });
  assert.deepEqual(
    reduceAssessments({ snapshot: protectedSnapshot, rolePolicy: advisory, assessments: [unavailable, fallback] }),
    { status: "terminal", reason: "fallback_forbidden" },
  );
});

test("single reduction requests its configured fallback", () => {
  const result = reduceAssessments({
    snapshot,
    rolePolicy: policy("single", "claude", "codex"),
    assessments: [providerAssessment("claude", { outcome: "unable" })],
  });
  assert.deepEqual(result, { status: "fallback", provider: "codex", reason: "unavailable" });
});

test("decision transport rejects open operations and raw terminal reasons", () => {
  assert.throws(
    () => validateDecision({ ...decision, assessmentDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)] }),
    error => error?.code === "contract",
  );
  assert.throws(
    () => validateDecision({ ...decision, operations: [{ type: "publish_everything" }] }),
    error => error?.code === "contract",
  );
  const terminalRole = defineRole({ ...structuredClone(policy("quorum")), operations: ["terminal"] });
  assert.throws(
    () => validateOperation({ type: "terminal", reason: "token ghp_secret failed" }, terminalRole),
    error => error?.code === "contract",
  );
});

test("assessment qualification enforces role outcomes and provider membership", () => {
  const restricted = defineRole({
    ...structuredClone(policy("single", "claude", "codex")),
    payload: { outcomes: ["positive", "unable"], requiredKeys: ["verdict"] },
  });
  assert.equal(
    qualifyAssessment({ snapshot, rolePolicy: restricted, provider: "claude", assessment: providerAssessment("claude", { outcome: "negative" }) }).status,
    "fallback",
  );
  const routed = structuredClone(policy("single", "claude", "codex"));
  const claudeOnly = defineRole({
    ...routed,
    fallback: null,
    providers: ["claude"],
    providerConfig: { claude: routed.providerConfig.claude },
  });
  assert.equal(
    reduceAssessments({ snapshot, rolePolicy: claudeOnly, assessments: [providerAssessment("codex")] }).reason,
    "contract",
  );
});

test("quorum requires exact patch metadata agreement", () => {
  const bytes = Buffer.from("x");
  const base = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [] };
  const result = reduceAssessments({
    snapshot,
    rolePolicy: patchPolicy(policy("quorum")),
    assessments: [
      { assessment: providerAssessment("claude", { patch: base }), patchBytes: bytes },
      { assessment: providerAssessment("codex", { patch: { ...base, files: [{ path: "a", kind: "regular", oldMode: "100644", newMode: "100644" }] } }), patchBytes: bytes },
    ],
  });
  assert.equal(result.reason, "patch_conflict");
});

test("idempotency keys cannot collide through delimiters", () => {
  assert.notEqual(
    idempotencyKey("issue_route", { issueId: "a", route: "b", sourceRevision: "c:d" }),
    idempotencyKey("issue_route", { issueId: "a", route: "b:c", sourceRevision: "d" }),
  );
});

test("reconciliation rejects malformed forge state and retries stale completed artifacts", () => {
  const base = {
    snapshot: { ...snapshot, state: { currentRevisions: { "issue:1": "r2" } } },
    routes: [{ issueId: "1", sourceRevision: "r1", status: "complete", primary: "claude", fallback: "codex", artifactDigest: "a".repeat(64) }],
    pulls: [],
    labelSync: { wantedDigest: "f".repeat(64), liveDigest: "f".repeat(64) },
  };
  assert.deepEqual(planReconciliation(base), [{ kind: "retry_route", issueId: "1", sourceRevision: "r2" }]);
  assert.throws(() => planReconciliation({ ...base, snapshot: { ...base.snapshot, state: {} } }), error => error?.code === "contract");
  assert.throws(() => planReconciliation({ ...base, pulls: [{ prId: {}, headSha, merged: "false", mergeSha: null, obligations: [] }] }), error => error?.code === "contract");
  const failed = {
    ...base,
    routes: [],
    pulls: [{ prId: "2", headSha, merged: true, mergeSha: "c".repeat(40), obligations: [{ role: "docs-writer", status: "failed", artifactDigest: null }] }],
  };
  assert.deepEqual(planReconciliation(failed), [{ kind: "run_obligation", prId: "2", mergeSha: "c".repeat(40), role: "docs-writer" }]);
  assert.throws(() => planReconciliation({ ...base, routes: [base.routes[0], base.routes[0]] }), error => error?.code === "contract");
  assert.throws(() => planReconciliation({ ...base, routes: [{ ...base.routes[0], status: "complete", artifactDigest: null }] }), error => error?.code === "contract");
  assert.throws(() => planReconciliation({ ...failed, pulls: [failed.pulls[0], failed.pulls[0]] }), error => error?.code === "contract");
  assert.throws(
    () => planReconciliation({ ...failed, pulls: [{ ...failed.pulls[0], obligations: [failed.pulls[0].obligations[0], failed.pulls[0].obligations[0]] }] }),
    error => error?.code === "contract",
  );
});
