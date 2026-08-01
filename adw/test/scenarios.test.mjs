import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  digestBytes, digestJson, mapReconciliationIntents, mergeEligibility, parseLegacyMarkers, planMergeGate, planReconciliation,
  reduceAssessments,
} from "../core.mjs";
import { controlSnapshotPlan, roleSnapshotPlan } from "../github.mjs";
import { controlAuthority, deterministicRole, listRoles, planAudit, reduceControlArtifact, reduceDeterministicArtifact, reduceRoleArtifact, reduceStatusArtifact, role, validateRolePayload } from "../roles.mjs";

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const trust = { ownerIds: ["U_owner"], appId: "A_smith" };

function snapshotFor(name, state = {}) {
  const policy = role(name);
  return {
    schemaVersion: 1, controlSha,
    event: { kind: "issue", action: "labeled", entityId: "1" },
    repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    revisions: [{ resource: "issue:1", kind: "issue", token: "r1" }],
    routing: { role: name, mode: policy.mode, primary: policy.primary },
    state,
  };
}

function assessment(snapshot, policy, provider, outcome, payload) {
  const value = {
    schemaVersion: 1, controlSha, role: policy.name, provider,
    model: policy.providerConfig[provider].model, idempotencyKey: `${policy.name}:1`,
    snapshotDigest: digestJson(snapshot), cliVersion: "1.0.0", run: { id: "1", job: provider, attempt: 1 },
    outcome, payload, payloadDigest: digestJson(payload), patch: null,
    startedAt: "2026-07-28T00:00:00.000Z", completedAt: "2026-07-28T00:00:01.000Z",
  };
  return value;
}

const evidence = kind => ({
  kind, headSha, conclusion: "approve", actorId: trust.appId,
  provider: kind === "correctness" ? "claude" : "codex", authoritative: true,
  artifactDigest: (kind === "correctness" ? "c" : "d").repeat(64),
});

function mergeState(overrides = {}) {
  return {
    headSha, labels: ["reviewed", "security-cleared"],
    checks: [{ name: "check", headSha, conclusion: "success" }],
    reviews: [evidence("correctness"), evidence("security")], riskMarker: null,
    timeline: [], trust, autoMergeAllowed: true, ...overrides,
  };
}

function roleDecision(name, payload, state, patchBytes = null) {
  const policy = role(name);
  const patch = payload.patch ?? null;
  const snapshot = {
    schemaVersion: 1, controlSha,
    event: { kind: name.includes("reviewer") ? "pull_request" : "issue", action: "opened", entityId: state.entityId },
    repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    revisions: [{ resource: `entity:${state.entityId}`, kind: "entity", token: patch?.baseSha ?? state.headSha ?? "r1" }],
    routing: { role: name, mode: policy.mode, primary: policy.primary }, state,
  };
  const outcome = payload.verdict === "noop" ? "noop" : ["blocked", "disproved", "inconclusive", "reject", "risky"].includes(payload.verdict) ? "negative" : "positive";
  const artifact = assessment(snapshot, policy, policy.primary, outcome, payload);
  artifact.patch = patch;
  const entries = patch ? [{ assessment: artifact, patchBytes }] : [artifact];
  const reduction = reduceAssessments({ snapshot, rolePolicy: policy, assessments: entries });
  return reduceRoleArtifact({ snapshot, rolePolicy: policy, reduction, assessments: entries });
}

test("injected E2E: review/security evidence gates composed issue merge", () => {
  const triage = roleDecision("triager", { verdict: "accept", body: "Ready", labels: [] }, { entityId: "1", labels: [] });
  assert.ok(triage.operations.some(value => value.label === "ready"));
  const plan = roleDecision("planner", { verdict: "planned", summary: "Plan", issues: [{ title: "Slice", body: "Build", labels: ["planned"] }] }, { entityId: "1", labels: [] });
  assert.equal(plan.operations[0].type, "create_issue");

  const bytes = Buffer.from("x");
  const patch = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const envelope = data => ({ trust: "untrusted", source: "issue:1", bytes: Buffer.byteLength(JSON.stringify(data)), digest: digestJson(data), data });
  const build = roleDecision("builder", { verdict: "patch", summary: "Build", patch }, { entityId: "1", labels: [], headBranch: "claude/issue-1", baseBranch: "main", title: envelope("Build"), body: envelope("Closes #1") }, bytes);
  assert.equal(build.operations[0].type, "create_pr");

  const reviewState = { entityId: "2", labels: [], headSha };
  const correctness = roleDecision("reviewer", { verdict: "approve", risk: "none", findings: [] }, reviewState);
  const securityDecision = roleDecision("security-reviewer", { verdict: "approve", risk: "none", findings: [] }, reviewState);
  const comments = [...correctness.operations, ...securityDecision.operations]
    .filter(value => value.type === "comment")
    .map((value, index) => ({ id: String(index + 1), actorId: trust.appId, createdAt: `2026-07-28T00:00:0${index}.000Z`, body: value.body, repositoryId: "R_1", entityId: "2" }));
  const imported = parseLegacyMarkers({ comments, trust }).filter(value => value.kind === "review").map(({ value }) => ({ kind: value.kind, headSha: value.headSha, conclusion: value.conclusion, actorId: value.actorId, provider: value.provider, authoritative: value.authoritative, artifactDigest: value.artifactDigest }));
  const labels = [...correctness.operations, ...securityDecision.operations].filter(value => value.type === "add_label").map(value => value.label);
  const gate = planMergeGate({ prId: "2", ...mergeState({ labels, reviews: imported }) });
  assert.deepEqual(gate.operations.map(value => value.type), ["publish_check", "arm_auto_merge"]);
});

test("head refresh invalidates old evidence until both reviewers rerun", () => {
  const nextHead = "e".repeat(40);
  assert.equal(mergeEligibility({ ...mergeState(), headSha: nextHead, checks: [{ name: "check", headSha: nextHead, conclusion: "success" }] }).eligible, false);
  const state = { entityId: "2", labels: [], headSha: nextHead };
  const decisions = [
    roleDecision("reviewer", { verdict: "approve", risk: "none", findings: [] }, state),
    roleDecision("security-reviewer", { verdict: "approve", risk: "none", findings: [] }, state),
  ];
  const comments = decisions.flatMap(decision => decision.operations).filter(value => value.type === "comment").map((value, index) => ({ id: String(index + 1), actorId: trust.appId, createdAt: `2026-07-28T00:01:0${index}.000Z`, body: value.body, repositoryId: "R_1", entityId: "2" }));
  const reviews = parseLegacyMarkers({ comments, trust }).filter(value => value.kind === "review").map(({ value }) => ({ kind: value.kind, headSha: value.headSha, conclusion: value.conclusion, actorId: value.actorId, provider: value.provider, authoritative: value.authoritative, artifactDigest: value.artifactDigest }));
  const labels = decisions.flatMap(decision => decision.operations).filter(value => value.type === "add_label").map(value => value.label);
  assert.equal(mergeEligibility({ ...mergeState({ headSha: nextHead, labels, reviews, checks: [{ name: "check", headSha: nextHead, conclusion: "success" }] }) }).eligible, true);
});

test("every provider-role write respects a current hold", () => {
  const bytes = Buffer.from("x");
  const manifest = path => ({ baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [{ path, kind: "regular", oldMode: "100644", newMode: "100644" }] });
  const envelope = data => ({ trust: "untrusted", source: "fixture", bytes: Buffer.byteLength(JSON.stringify(data)), digest: digestJson(data), data });
  const patchState = (extra = {}) => ({ entityId: "1", labels: ["hold"], headBranch: "role/1", baseBranch: "main", title: envelope("Title"), body: envelope("Body"), ...extra });
  const cases = [
    ["steerer", { verdict: "comment", body: "Answer" }, { entityId: "1", labels: ["hold"], ownerAuthenticated: true }],
    ["triager", { verdict: "accept", body: "Ready", labels: [] }, { entityId: "1", labels: ["hold"] }],
    ["planner", { verdict: "planned", summary: "Plan", issues: [] }, { entityId: "1", labels: ["hold"] }],
    ["surveyor", { verdict: "proposal", summary: "Gap", issues: [] }, { entityId: "1", labels: ["hold"] }],
    ["builder", { verdict: "patch", summary: "Build", patch: manifest("smith/src/lib.rs") }, patchState(), bytes],
    ["codex-builder", { verdict: "patch", summary: "Build", patch: manifest("smith/src/lib.rs") }, patchState(), bytes],
    ["pioneer", { verdict: "proved", summary: "Proof", claim: "claim", patch: manifest("prototypes/p99/main.rs") }, patchState(), bytes],
    ["reviewer", { verdict: "approve", risk: "none", findings: [] }, { entityId: "2", labels: ["hold"], headSha }],
    ["security-reviewer", { verdict: "approve", risk: "none", findings: [] }, { entityId: "2", labels: ["hold"], headSha }],
    ["reviser", { verdict: "patch", summary: "Revise", patch: manifest("smith/src/lib.rs") }, { entityId: "2", labels: ["hold"], changedPaths: ["smith/src/lib.rs"] }, bytes],
    ["sweeper", { verdict: "action", summary: "Retry", actions: [{ kind: "retry", entityId: "run:1", reason: "failed" }] }, { entityId: "repository", labels: ["hold"], actionTargets: ["run:1"] }],
    ["adw-doctor", { verdict: "action", summary: "Drift", actions: [{ kind: "report", entityId: "repository", reason: "ruleset" }] }, { entityId: "repository", labels: ["hold"], actionTargets: ["repository"] }],
    ["docs-writer", { verdict: "patch", summary: "Docs", patch: manifest("docs/guide.md") }, patchState(), bytes],
    ["dependency-manager", { verdict: "safe", summary: "Safe", reason: "semver" }, { entityId: "2", labels: ["hold"] }],
    ["alert-triager", { verdict: "covered", summary: "Covered", issue: null }, { entityId: "3", labels: ["hold"] }],
  ];
  for (const [name, payload, state, patchBytes] of cases) assert.deepEqual(roleDecision(name, payload, state, patchBytes).operations, [{ type: "terminal", reason: "held" }], name);
});

test("issue route falls back once then reaches current-head squash intent", () => {
  const policy = role("builder");
  const snapshot = snapshotFor("builder", { input: { protected: false, incomplete: false, fork: false, binary: false, oversized: false } });
  const primary = assessment(snapshot, policy, "claude", "unable", { verdict: "noop", reason: "provider unavailable" });
  assert.deepEqual(reduceAssessments({ snapshot, rolePolicy: policy, assessments: [primary] }), { status: "fallback", provider: "codex", reason: "unavailable" });
  const fallback = assessment(snapshot, policy, "codex", "noop", { verdict: "noop", reason: "no patch required" });
  const reduced = reduceAssessments({ snapshot, rolePolicy: policy, assessments: [primary, fallback] });
  assert.equal(reduced.status, "artifact");
  assert.deepEqual(reduced.selected, [digestJson(fallback)]);

  const gate = planMergeGate({ prId: "2", ...mergeState() });
  assert.deepEqual(gate.operations.map(value => value.type), ["publish_check", "arm_auto_merge"]);
  assert.equal(gate.operations[1].method, "squash");

  const bothFail = assessment(snapshot, policy, "codex", "unable", { verdict: "noop", reason: "provider unavailable" });
  assert.equal(reduceAssessments({ snapshot, rolePolicy: policy, assessments: [primary, bothFail] }).reason, "providers_unavailable");
  const codexOnly = role("codex-builder");
  const codexSnapshot = snapshotFor("codex-builder", { input: {} });
  assert.equal(reduceAssessments({ snapshot: codexSnapshot, rolePolicy: codexOnly, assessments: [assessment(codexSnapshot, codexOnly, "codex", "unable", { verdict: "noop", reason: "provider unavailable" })] }).reason, "provider_unavailable");
});

test("gate fails closed on stale evidence, holds, disagreement, and sticky risk", () => {
  const stale = { ...evidence("security"), headSha: "e".repeat(40) };
  assert.ok(mergeEligibility(mergeState({ reviews: [evidence("correctness"), stale] })).reasons.includes("security_missing"));
  for (const blocker of ["risk:high", "blocked", "changes-requested", "needs:info", "needs:spec", "needs:prototype"]) {
    assert.ok(mergeEligibility(mergeState({ labels: ["reviewed", "security-cleared", blocker] })).reasons.includes(blocker));
  }
  const reject = { ...evidence("security"), conclusion: "reject" };
  assert.ok(mergeEligibility(mergeState({ reviews: [evidence("correctness"), reject] })).reasons.includes("security_rejected"));
  const marker = { headSha, findingDigest: "f".repeat(64), status: "open", createdAt: "2026-07-28T00:00:00.000Z", clearedAt: null };
  assert.ok(mergeEligibility(mergeState({ riskMarker: marker })).reasons.includes("risk:high"));
  const clear = { id: "1", kind: "label_removed", actorId: "U_owner", createdAt: "2026-07-28T00:01:00.000Z", label: "risk:high", headSha };
  assert.equal(mergeEligibility(mergeState({ riskMarker: marker, timeline: [clear] })).eligible, true);
});

test("all specialist artifact variants preserve closed outcomes", () => {
  const docsPatch = { baseSha: headSha, digest: "1".repeat(64), size: 1, files: [{ path: "docs/guide.md", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const samples = [
    ["pioneer", { verdict: "proved", summary: "True", claim: "claim", patch: null }],
    ["pioneer", { verdict: "disproved", summary: "False", claim: "claim", patch: null }],
    ["pioneer", { verdict: "inconclusive", summary: "Unknown", claim: "claim", patch: null }],
    ["dependency-manager", { verdict: "safe", summary: "Compatible", reason: "semver" }],
    ["dependency-manager", { verdict: "risky", summary: "Breaking", reason: "major" }],
    ["alert-triager", { verdict: "covered", summary: "Covered", issue: null }],
    ["alert-triager", { verdict: "issue", summary: "Uncovered", issue: { title: "Alert", body: "Fix", labels: ["security"] } }],
    ["docs-writer", { verdict: "noop", reason: "docs unchanged" }],
    ["docs-writer", { verdict: "patch", summary: "Document", patch: docsPatch }],
    ["sweeper", { verdict: "noop", reason: "queue healthy" }],
    ["adw-doctor", { verdict: "action", summary: "Drift", actions: [{ kind: "report", entityId: "repository", reason: "ruleset drift" }] }],
  ];
  for (const [name, payload] of samples) assert.deepEqual(validateRolePayload(name, payload), payload);
  assert.deepEqual(deterministicRole("settings-auditor").operations, ["noop", "report_drift", "terminal"]);
  assert.deepEqual(deterministicRole("jam-detector").operations, ["comment", "noop", "terminal"]);
  assert.deepEqual(deterministicRole("label-sync").operations, ["noop", "sync_labels", "terminal"]);
  assert.equal(reduceDeterministicArtifact("settings-auditor", { drifts: [{ title: "Ruleset drift", body: "check missing" }] })[0].type, "report_drift");
  assert.equal(reduceDeterministicArtifact("jam-detector", { entityId: "2", headSha, stalled: true, reason: "gate stale" })[0].type, "comment");
  assert.equal(reduceDeterministicArtifact("label-sync", { wantedDigest: "1".repeat(64), liveDigest: "2".repeat(64) })[0].type, "sync_labels");
  assert.equal(listRoles().includes("release-manager"), false);
});

test("specialist decisions map every verdict to bounded operations", () => {
  assert.equal(roleDecision("pioneer", { verdict: "proved", summary: "True", claim: "claim", patch: null }, { entityId: "1", labels: [], closingArtifactQualifies: true }).operations[0].type, "noop");
  assert.equal(roleDecision("pioneer", { verdict: "disproved", summary: "False", claim: "claim", patch: null }, { entityId: "1", labels: [] }).operations[0].label, "needs:spec");
  assert.equal(roleDecision("pioneer", { verdict: "inconclusive", summary: "Unknown", claim: "claim", patch: null }, { entityId: "1", labels: [] }).operations[0].type, "comment");
  assert.equal(roleDecision("dependency-manager", { verdict: "safe", summary: "Safe", reason: "semver" }, { entityId: "2", labels: [] }).operations.length, 1);
  assert.ok(roleDecision("dependency-manager", { verdict: "risky", summary: "Risky", reason: "major" }, { entityId: "2", labels: [] }).operations.some(value => value.label === "needs:spec"));
  assert.equal(roleDecision("alert-triager", { verdict: "issue", summary: "New", issue: { title: "Alert", body: "Fix", labels: ["security"] } }, { entityId: "3", labels: [] }).operations[0].type, "create_issue");
  assert.equal(roleDecision("alert-triager", { verdict: "covered", summary: "Covered", issue: null }, { entityId: "3", labels: [] }).operations[0].type, "comment");
  assert.equal(roleDecision("docs-writer", { verdict: "noop", reason: "unchanged" }, { entityId: "2", labels: [] }).operations[0].type, "noop");
  const bytes = Buffer.from("x");
  const docsPatch = { baseSha: headSha, digest: digestBytes(bytes), size: 1, files: [{ path: "docs/guide.md", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const envelope = data => ({ trust: "untrusted", source: "pull:2", bytes: Buffer.byteLength(JSON.stringify(data)), digest: digestJson(data), data });
  assert.equal(roleDecision("docs-writer", { verdict: "patch", summary: "Docs", patch: docsPatch }, { entityId: "2", labels: [], headBranch: "docs/pr-2", baseBranch: "main", title: envelope("Docs"), body: envelope("Body") }, bytes).operations[0].type, "create_pr");
  assert.equal(roleDecision("adw-doctor", { verdict: "action", summary: "Drift", actions: [{ kind: "report", entityId: "repository", reason: "ruleset" }] }, { entityId: "repository", labels: [], actionTargets: ["repository"] }).operations[0].type, "create_issue");
  assert.equal(roleDecision("sweeper", { verdict: "action", summary: "Retry", actions: [{ kind: "retry", entityId: "run:1", reason: "failed" }] }, { entityId: "repository", labels: [], actionTargets: ["run:1"] }).operations[0].type, "rerun_check");
});

test("missed post-merge work remains retryable while holds suppress writes", () => {
  const snapshot = {
    ...snapshotFor("sweeper"), event: { kind: "schedule", action: "reconcile", entityId: "repository" },
    state: { currentRevisions: {} },
  };
  const pull = {
    prId: "2", repositoryId: "R_1", headRepositoryId: "R_1", base: "main", closingIssues: [],
    headSha, merged: true, mergeSha: "e".repeat(40),
    obligations: [{ role: "docs-writer", status: "failed", artifactDigest: null, expectedArtifactDigest: null }],
  };
  const base = { snapshot, routes: [], pulls: [pull], labelSync: { wantedDigest: "1".repeat(64), liveDigest: "1".repeat(64) }, comments: [], trust, reviews: [], pioneers: [], holds: [] };
  assert.deepEqual(planReconciliation(base), [{ kind: "run_obligation", repositoryId: "R_1", prId: "2", mergeSha: "e".repeat(40), role: "docs-writer", provider: "codex" }]);
  assert.deepEqual(planReconciliation({ ...base, holds: [{ entityId: "pr:2", reasons: ["hold"] }] }), [{ kind: "held", entityId: "pr:2", reasons: ["hold"] }]);
});

test("review-comment and check routes have reconciliation authority but no assessment route", () => {
  for (const eventKind of ["pull_request_review_comment", "check"]) {
    assert.equal(controlSnapshotPlan("reconciler", eventKind).role, "reconciler");
    for (const roleName of listRoles()) assert.throws(() => roleSnapshotPlan(roleName, eventKind), error => error?.code === "contract");
  }
});

test("injected E2E: issue route maps reconciliation into provider-free closed repository dispatch authority", () => {
  const policy = controlAuthority("reconciler");
  const previousRevision = "1".repeat(64);
  const currentRevision = "2".repeat(64);
  const snapshot = {
    ...snapshotFor("sweeper"),
    repository: { id: "42", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    event: { kind: "schedule", action: "reconcile", entityId: "repository" },
    routing: { role: policy.name, mode: "single", primary: null },
    state: { currentRevisions: { "issue:7": currentRevision }, reconciliation: { pulls: [] } },
  };
  const request = {
    snapshot,
    routes: [{ issueId: "7", sourceRevision: previousRevision, status: "primary", primary: "claude", fallback: "codex", primaryOutcome: null, fallbackOutcome: null, artifactDigest: null, prId: null }],
    pulls: [], labelSync: { wantedDigest: "1".repeat(64), liveDigest: "1".repeat(64) },
    comments: [], trust, reviews: [], pioneers: [], holds: [],
  };
  const intents = planReconciliation(request);
  const operations = mapReconciliationIntents({ snapshot, intents });
  assert.deepEqual(operations, [{
    type: "dispatch_repository", eventType: "retry_route",
    clientPayload: { repositoryId: "42", issueId: "7", sourceRevision: currentRevision, role: "builder", provider: "claude" },
  }]);
  const decision = reduceControlArtifact({ name: "reconciler", snapshot, operations });
  assert.equal(decision.assessmentDigests.length, 0);
  assert.equal(role("sweeper").operations.includes("dispatch_repository"), false);
  assert.deepEqual(policy.operations, ["add_label", "dispatch_repository", "noop", "sync_labels"]);
});

test("injected E2E: post-merge obligation and review/check repairs map deterministically", () => {
  const policy = controlAuthority("reconciler");
  const mergeSha = "e".repeat(40);
  const snapshot = {
    ...snapshotFor("sweeper"),
    repository: { id: "42", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    event: { kind: "check", action: "completed", entityId: "90" },
    routing: { role: policy.name, mode: "single", primary: null },
    state: { currentRevisions: {}, reconciliation: { pulls: [
      { prId: "2", repositoryId: "42", headRepositoryId: "42", base: "main", closingIssues: [], headSha, merged: true, mergeSha, obligations: [] },
      { prId: "3", repositoryId: "42", headRepositoryId: "42", base: "main", closingIssues: [], headSha, merged: false, mergeSha: null, obligations: [] },
    ] } },
  };
  const intents = [
    { kind: "run_obligation", repositoryId: "42", prId: "2", mergeSha, role: "docs-writer", provider: "codex" },
    { kind: "run_review", repositoryId: "42", prId: "3", headSha, role: "security-reviewer", provider: "claude" },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(mapReconciliationIntents({ snapshot, intents }).map(value => [value.eventType, value.clientPayload.role, value.clientPayload.provider]), [
    ["run_review", "security-reviewer", "claude"],
    ["run_obligation", "docs-writer", "codex"],
  ]);
  assert.equal(controlSnapshotPlan("reconciler", "dispatch").role, "reconciler");
});

test("injected E2E: settings drift and labels use full provider-free audit state", () => {
  const authority = controlAuthority("auditor");
  const expectedRuleset = { name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "check" }, { context: "merge-gate" }] } }], bypass_actors: [] };
  const labelSource = '- name: "ready"\n  color: "00ff00"\n  description: "Ready"\n';
  const snapshot = {
    ...snapshotFor("sweeper"),
    event: { kind: "schedule", action: "audit", entityId: "repository" },
    routing: { role: authority.name, mode: "single", primary: null },
    state: { entityId: "repository", trust, resources: {
      "trusted:.github/rulesets/main.json": { data: JSON.stringify(expectedRuleset) },
      "trusted:.github/labels.yml": { data: labelSource },
      rulesets: [{ ...expectedRuleset, rules: [{ ...expectedRuleset.rules[0], parameters: { ...expectedRuleset.rules[0].parameters, strict_required_status_checks_policy: true } }] }],
      settings: { allowAutoMerge: true, allowMergeCommit: false, allowRebaseMerge: false, allowSquashMerge: true, deleteBranchOnMerge: true },
      labels: [], pulls: [],
    } },
  };
  const decision = planAudit(snapshot);
  assert.deepEqual(decision.operations.map(value => value.type), ["report_drift", "sync_labels"]);
  assert.match(decision.operations[0].body, /strict_required_status_checks_policy/);
  assert.equal(decision.assessmentDigests.length, 0);
});

test("injected E2E: green-but-blocked jam cannot arm merge", () => {
  const authority = controlAuthority("auditor");
  const expectedRuleset = { name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [], bypass_actors: [] };
  const snapshot = {
    ...snapshotFor("sweeper"),
    event: { kind: "schedule", action: "audit", entityId: "repository" },
    routing: { role: authority.name, mode: "single", primary: null },
    state: { entityId: "repository", trust, resources: {
      "trusted:.github/rulesets/main.json": { data: JSON.stringify(expectedRuleset) },
      "trusted:.github/labels.yml": { data: "" }, rulesets: [expectedRuleset], labels: [],
      settings: { allowAutoMerge: true, allowMergeCommit: false, allowRebaseMerge: false, allowSquashMerge: true, deleteBranchOnMerge: true },
      pulls: [{ number: "2", state: "open", merged: false, mergeState: "blocked", headSha, base: "main", headRepository: "bugabinga/smith", labels: ["reviewed", "security-cleared"],
        checks: [{ name: "check", headSha, status: "completed", conclusion: "success" }, { name: "merge-gate", headSha, status: "completed", conclusion: "success" }],
        evidence: [evidence("correctness"), evidence("security")], riskMarker: null, timeline: [] }],
    } },
  };
  const decision = planAudit(snapshot);
  assert.ok(decision.operations.some(value => value.type === "comment" && value.marker.includes("smith:jam/v1")));
  assert.ok(decision.operations.some(value => value.type === "publish_check" && value.name === "merge-gate" && value.conclusion === "failure"));
  assert.equal(decision.operations.some(value => value.type === "arm_auto_merge"), false);
});

test("injected E2E: merge arm follows current-head deterministic gate", () => {
  const authority = controlAuthority("auditor");
  const expectedRuleset = { name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [], bypass_actors: [] };
  const snapshot = {
    ...snapshotFor("sweeper"), event: { kind: "schedule", action: "audit", entityId: "repository" },
    routing: { role: authority.name, mode: "single", primary: null },
    state: { entityId: "repository", trust, resources: {
      "trusted:.github/rulesets/main.json": { data: JSON.stringify(expectedRuleset) }, "trusted:.github/labels.yml": { data: "" },
      rulesets: [expectedRuleset], labels: [], settings: { allowAutoMerge: true, allowMergeCommit: false, allowRebaseMerge: false, allowSquashMerge: true, deleteBranchOnMerge: true },
      pulls: [{ number: "2", state: "open", draft: false, merged: false, mergeState: "clean", headSha, base: "main", headRepository: "bugabinga/smith", labels: ["reviewed", "security-cleared"],
        checks: [{ name: "check", headSha, status: "completed", conclusion: "success" }], evidence: [evidence("correctness"), evidence("security")], riskMarker: null, timeline: [] }],
    } },
  };
  assert.deepEqual(planAudit(snapshot).operations.map(value => value.type), ["publish_check", "arm_auto_merge"]);
  for (const patch of [{ draft: true }, { mergeState: "unknown" }, { mergeState: "dirty" }]) {
    const blocked = structuredClone(snapshot);
    Object.assign(blocked.state.resources.pulls[0], patch);
    assert.equal(planAudit(blocked).operations.some(value => value.type === "arm_auto_merge"), false);
  }
});

test("terminal/fallback outcomes reduce to sanitized canonical publication operations", () => {
  const policy = role("reviewer");
  const value = {
    ...snapshotFor("reviewer", { entityId: "2", headSha, labels: [] }),
    event: { kind: "pull_request", action: "synchronize", entityId: "2" },
    revisions: [{ resource: "pull:2", kind: "pull", token: headSha }],
  };
  for (const reduction of [{ status: "fallback", reason: "malformed", provider: "codex" }, { status: "terminal", reason: "providers_unavailable" }]) {
    const decision = reduceStatusArtifact({ snapshot: value, rolePolicy: policy, reduction });
    assert.equal(decision.operations[0].type, "publish_check");
    assert.equal(decision.operations[0].summary.includes("malformed"), false);
    assert.match(decision.operations[0].summary, /^ADW reviewer (fallback|terminal): /);
  }
  assert.deepEqual(role("reviewer").operations, policy.operations);
});

test("captured legacy evidence imports semantically without Projects or release", async () => {
  const comments = [];
  for (const name of ["routes", "reviews", "jams"]) comments.push(...JSON.parse(await readFile(new URL(`fixtures/legacy/${name}.json`, import.meta.url))));
  const records = parseLegacyMarkers({ comments, trust });
  assert.equal(records.find(value => value.kind === "attempt").value.outcome, "failure");
  assert.equal(records.find(value => value.kind === "route").value.phase, "armed");
  assert.deepEqual(records.filter(value => value.kind === "review").map(value => value.value.conclusion), ["approve", "approve"]);
  assert.equal(records.find(value => value.kind === "jam").value.status, "open");
  assert.equal(records.find(value => value.kind === "finalization").value.status, "failed");
  assert.equal(records.some(value => /project|release/.test(value.kind)), false);

  const snapshot = { ...snapshotFor("sweeper"), event: { kind: "schedule", action: "reconcile", entityId: "repository" }, state: { currentRevisions: { "issue:7": "r1" } } };
  const intents = planReconciliation({
    snapshot,
    routes: [{ issueId: "7", sourceRevision: "r1", status: "primary", primary: "claude", fallback: "codex", primaryOutcome: "provider_failure", fallbackOutcome: null, artifactDigest: null, prId: null }],
    pulls: [{ prId: "9", repositoryId: "R_1", headRepositoryId: "R_1", base: "main", closingIssues: [], headSha, merged: true, mergeSha: "e".repeat(40), obligations: [{ role: "docs-writer", status: "failed", artifactDigest: null, expectedArtifactDigest: null }] }],
    labelSync: { wantedDigest: "1".repeat(64), liveDigest: "1".repeat(64) }, comments, trust,
    reviews: [{ prId: "2", headSha, evidence: [], protectedInput: false }], pioneers: [], holds: [],
  });
  assert.deepEqual(intents.map(value => value.kind).sort(), ["fallback_route", "run_obligation"]);
});
