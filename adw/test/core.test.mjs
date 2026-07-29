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
  model: "claude-opus-4-1",
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
  }
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
});

test("protected input refuses fallback authority", () => {
  const single = policy("single", "claude", "codex");
  const protectedSnapshot = { ...snapshot, state: { input: { protected: true } } };
  assert.deepEqual(
    qualifyAssessment({ snapshot: protectedSnapshot, rolePolicy: single, provider: "codex", assessment: providerAssessment("codex") }),
    { status: "terminal", reason: "fallback_forbidden" },
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

  const patchA = { baseSha: headSha, digest: "c".repeat(64), size: 1, files: [] };
  const patchB = { baseSha: headSha, digest: "d".repeat(64), size: 1, files: [] };
  const conflict = reduceAssessments({
    snapshot,
    rolePolicy: quorum,
    assessments: [providerAssessment("claude", { patch: patchA }), providerAssessment("codex", { patch: patchB })],
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
