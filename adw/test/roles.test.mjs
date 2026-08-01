import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalBytes, digestBytes, digestJson } from "../core.mjs";
import {
  OPERATIONS, PROVIDERS, defineRole, deriveDeterministicArtifacts, deterministicRole,
  listDeterministicRoles, listRoles, reduceDeterministicArtifact, reduceRoleArtifact, role, validateRolePayload,
} from "../roles.mjs";

const policy = {
  name: "fixture-reviewer",
  charter: ".claude/agents/reviewer.md",
  mode: "quorum",
  primary: null,
  fallback: null,
  providers: ["claude", "codex"],
  providerConfig: {
    claude: { model: "fixture-claude", effort: "high", timeoutSeconds: 300 },
    codex: { model: "fixture-codex", effort: "high", timeoutSeconds: 300 },
  },
  capabilities: ["checks:write", "pulls:read"],
  snapshot: { fields: ["diff", "pull", "reviews"], maxBytes: 262144 },
  payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
  operations: ["add_label", "publish_check", "remove_label", "terminal"],
  fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
  patch: null,
};

test("role policy is exact and deeply frozen", () => {
  const value = defineRole(structuredClone(policy));
  assert.deepEqual(value, policy);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.providerConfig.claude));
  assert.ok(Object.isFrozen(value.operations));
  assert.deepEqual(PROVIDERS, ["claude", "codex"]);
  assert.ok(OPERATIONS.includes("publish_check"));
});

test("single role requires distinct primary and fallback", () => {
  const single = {
    ...policy,
    mode: "single",
    primary: "codex",
    fallback: "claude",
  };
  assert.equal(defineRole(single).primary, "codex");
  assert.throws(() => defineRole({ ...single, fallback: "codex" }), error => error?.code === "role");
  assert.throws(() => defineRole({ ...single, fallback: null }), error => error?.code === "role");
});

test("role policy rejects implicit or unsorted authority", () => {
  assert.throws(() => defineRole({ ...policy, surprise: true }), error => error?.code === "role");
  assert.throws(() => defineRole({ ...policy, capabilities: ["pulls:read", "checks:write"] }), error => error?.code === "role");
  assert.throws(() => defineRole({ ...policy, operations: ["publish_everything"] }), error => error?.code === "role");
  assert.throws(() => defineRole({ ...policy, providerConfig: { ...policy.providerConfig, claude: { ...policy.providerConfig.claude, timeoutSeconds: 301 } } }), error => error?.code === "role");
});

test("patch policy is bounded and cannot erase global denials", () => {
  const patch = {
    maxBytes: 1048576,
    maxFiles: 100,
    allowedPrefixes: ["docs/", "smith-core/"],
    deniedPaths: ["adw/**", "docs/SPEC.md"],
  };
  assert.deepEqual(defineRole({ ...policy, patch }).patch, patch);
  assert.throws(() => defineRole({ ...policy, patch: { ...patch, maxFiles: 101 } }), error => error?.code === "role");
  assert.throws(() => defineRole({ ...policy, patch: { ...patch, deniedPaths: [] } }), error => error?.code === "role");
});

const productionRoles = [
  "adw-doctor", "alert-triager", "builder", "codex-builder", "dependency-manager",
  "docs-writer", "pioneer", "planner", "reviewer", "reviser", "security-reviewer",
  "steerer", "surveyor", "sweeper", "triager",
];

test("production role registry is complete and charter-backed", async () => {
  assert.deepEqual(listRoles(), productionRoles);
  for (const name of productionRoles) {
    const value = role(name);
    assert.equal(value.name, name);
    assert.ok(Object.isFrozen(value));
    await access(value.charter);
    assert.ok(value.providerConfig[value.primary]);
  }
  assert.throws(() => role("release-manager"), error => error?.code === "role");
});

test("production provider routes preserve current model assignments", () => {
  assert.deepEqual(role("planner").providerConfig.claude, { model: "claude-fable-5", effort: "xhigh", timeoutSeconds: 300 });
  assert.deepEqual(role("planner").providerConfig.codex, { model: "gpt-5.6-sol", effort: "xhigh", timeoutSeconds: 300 });
  assert.equal(role("codex-builder").fallback, null);
  assert.equal(role("reviewer").fallbackAuthority.protected, false);
  assert.deepEqual(role("sweeper").providers, ["codex"]);
  assert.equal(role("adw-doctor").patch, null);
  assert.deepEqual(role("pioneer").patch.allowedPrefixes, ["prototypes/"]);
});

test("provider roles expose only operations their reducers can emit", () => {
  const terminal = ["noop", "terminal"];
  const expected = {
    triager: ["comment", "add_label"],
    planner: ["create_issue"],
    surveyor: ["create_issue"],
    builder: ["create_pr", "comment", "add_label"],
    "codex-builder": ["create_pr", "comment", "add_label"],
    "docs-writer": ["create_pr", "comment", "add_label"],
    reviser: ["update_pr", "comment", "add_label"],
    pioneer: ["create_pr", "add_label", "comment"],
    sweeper: ["rerun_check", "create_issue"],
    "adw-doctor": ["create_issue", "report_drift"],
    "dependency-manager": ["comment", "add_label"],
    "alert-triager": ["create_issue"],
  };
  for (const [name, operations] of Object.entries(expected)) {
    assert.deepEqual(role(name).operations, [...operations, ...terminal].sort(), name);
  }
});

test("role payload families accept only exact semantic artifacts", () => {
  const patch = { baseSha: "a".repeat(40), digest: "b".repeat(64), size: 1, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const samples = {
    steerer: { verdict: "comment", body: "Use the planner." },
    triager: { verdict: "accept", body: "Ready", labels: ["ready"] },
    planner: { verdict: "planned", summary: "Plan", issues: [{ title: "Slice", body: "Body", labels: ["planned"] }] },
    surveyor: { verdict: "proposal", summary: "Gap", issues: [] },
    builder: { verdict: "patch", summary: "Change", patch },
    pioneer: { verdict: "disproved", summary: "False", claim: "claim", patch: null },
    reviewer: { verdict: "approve", risk: "none", findings: [] },
    sweeper: { verdict: "action", summary: "Retry", actions: [{ kind: "retry", entityId: "1", reason: "stale" }] },
    "dependency-manager": { verdict: "safe", summary: "Compatible", reason: "semver" },
    "alert-triager": { verdict: "covered", summary: "Existing PR", issue: null },
  };
  for (const [name, payload] of Object.entries(samples)) assert.deepEqual(validateRolePayload(name, payload), payload);
  assert.throws(() => validateRolePayload("reviewer", { verdict: "approve", risk: "none", findings: [], command: "merge" }), error => error?.code === "contract");
  for (const path of ["adw/core.mjs", ".claude/agents/builder.md", ".github/workflows/ci.yml"]) {
    assert.throws(() => validateRolePayload("builder", { verdict: "patch", summary: "x", patch: { ...patch, files: [{ ...patch.files[0], path }] } }), error => error?.code === "contract");
  }
});

test("payload schema files exist for every family", async () => {
  for (const name of listRoles()) {
    const schema = JSON.parse(await readFile(role(name).payloadSchema, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(schema.oneOf.every(shape => shape.additionalProperties === false));
  }
});

test("conditional schemas preserve reducer authority", async () => {
  const maintenance = JSON.parse(await readFile(role("sweeper").payloadSchema, "utf8"));
  const action = maintenance.oneOf.find(value => value.properties.actions).properties.actions.items;
  assert.ok(action.required.includes("kind"));
  assert.equal(Object.hasOwn(action.properties, "verdict"), false);
  const pioneer = JSON.parse(await readFile(role("pioneer").payloadSchema, "utf8"));
  const disproved = pioneer.oneOf.find(value => value.properties?.verdict?.enum?.includes("disproved"));
  assert.equal(disproved.properties.patch.type, "null");
  const alert = JSON.parse(await readFile(role("alert-triager").payloadSchema, "utf8"));
  const covered = alert.oneOf.find(value => value.properties?.verdict?.enum?.includes("covered"));
  assert.equal(covered.properties.issue.type, "null");
});

test("explicit no-op is valid for every provider role", () => {
  for (const name of listRoles()) assert.deepEqual(validateRolePayload(name, { verdict: "noop", reason: "not applicable" }), { verdict: "noop", reason: "not applicable" });
});

function roleCase(name, payload, state, patch = null, patchBytes = null) {
  const policy = role(name);
  state = { ...state };
  for (const key of ["title", "body"]) if (typeof state[key] === "string") state[key] = { trust: "untrusted", source: `fixture:${key}`, bytes: canonicalBytes(state[key]).length, digest: digestJson(state[key]), data: state[key] };
  const snapshot = {
    schemaVersion: 1,
    controlSha: "a".repeat(40),
    event: { kind: "issue", action: "opened", entityId: state.entityId },
    repository: { id: "R", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    revisions: [{ resource: `issue:${state.entityId}`, kind: "issue", token: patch?.baseSha ?? state.headSha ?? "r1" }],
    routing: { role: name, mode: policy.mode, primary: policy.primary },
    state,
  };
  const assessment = {
    schemaVersion: 1, controlSha: snapshot.controlSha, role: name, provider: policy.primary,
    model: policy.providerConfig[policy.primary].model, idempotencyKey: `${name}:1`,
    snapshotDigest: digestJson(snapshot), cliVersion: "1.0.0", run: { id: "1", job: name, attempt: 1 },
    outcome: payload.verdict === "noop" ? "noop" : ["blocked", "disproved", "inconclusive", "reject", "risky"].includes(payload.verdict) ? "negative" : "positive",
    payload, payloadDigest: digestJson(payload), patch,
    startedAt: "2026-07-28T00:00:00.000Z", completedAt: "2026-07-28T00:00:01.000Z",
  };
  const selected = digestJson(assessment);
  return { snapshot, rolePolicy: policy, reduction: { status: "artifact", authoritative: true, selected: [selected], patch }, assessments: patch ? [{ assessment, patchBytes }] : [assessment] };
}

test("role artifacts reduce into closed decisions", () => {
  const triage = reduceRoleArtifact(roleCase("triager", { verdict: "needs_info", body: "Clarify", labels: [] }, { entityId: "1", labels: [] }));
  assert.deepEqual(triage.operations.map(value => value.type), ["comment", "add_label"]);
  assert.equal(triage.operations[1].label, "needs:info");

  const review = reduceRoleArtifact(roleCase("security-reviewer", { verdict: "reject", risk: "high", findings: [] }, { entityId: "2", headSha: "b".repeat(40), labels: [] }));
  assert.equal(review.operations[0].conclusion, "failure");
  assert.ok(review.operations.some(value => value.label === "risk:high"));
  assert.ok(review.operations.some(value => value.type === "comment" && value.body.includes("smith:review-evidence/v1")));
  assert.ok(review.operations.some(value => value.type === "comment" && value.body.includes("smith:risk/v1")));

  const issue = { title: "Alert", body: "Fix", labels: ["security"] };
  const alert = reduceRoleArtifact(roleCase("alert-triager", { verdict: "issue", summary: "Uncovered", issue }, { entityId: "3", labels: [] }));
  assert.equal(alert.operations[0].type, "create_issue");

  const sweep = reduceRoleArtifact(roleCase("sweeper", { verdict: "action", summary: "Retry", actions: [{ kind: "retry", entityId: "1", reason: "stale" }] }, { entityId: "4", labels: [], actionTargets: ["1"], resources: { runs: [{ id: "1" }] } }));
  assert.deepEqual(sweep.operations, [{ type: "rerun_check", runId: "1" }]);
  assert.throws(
    () => reduceRoleArtifact(roleCase("sweeper", { verdict: "action", summary: "Retry", actions: [{ kind: "retry", entityId: "2", reason: "stale" }] }, { entityId: "4", labels: [], actionTargets: ["1"], resources: { runs: [{ id: "1" }] } })),
    error => error?.code === "contract",
  );
});

test("repository, ref, and workflow-run findings collapse without issue-endpoint confusion", () => {
  const planner = reduceRoleArtifact(roleCase("planner", { verdict: "blocked", summary: "Main ref cannot be planned", issues: [] }, { entityId: "refs/heads/main", labels: [] }));
  assert.deepEqual(planner.operations.map(operation => operation.type), ["create_issue"]);
  assert.deepEqual(planner.operations[0].labels, ["blocked"]);

  const surveyor = reduceRoleArtifact(roleCase("surveyor", { verdict: "proposal", summary: "No gaps", issues: [] }, { entityId: "42", labels: [] }));
  assert.deepEqual(surveyor.operations, [{ type: "noop", reason: "not_applicable" }]);

  const covered = reduceRoleArtifact(roleCase("alert-triager", { verdict: "covered", summary: "PR already covers alert", issue: null }, { entityId: "991", labels: [] }));
  assert.deepEqual(covered.operations, [{ type: "noop", reason: "already_complete" }]);

  const maintenance = reduceRoleArtifact(roleCase("sweeper", {
    verdict: "action", summary: "Maintenance findings", actions: [
      { kind: "hold", entityId: "30713498516", reason: "cancelled apply" },
      { kind: "report", entityId: "refs/heads/main", reason: "drift" },
    ],
  }, { entityId: "42", labels: [], actionTargets: ["30713498516", "refs/heads/main"] }));
  assert.deepEqual(maintenance.operations.map(operation => operation.type), ["create_issue"]);
  assert.match(maintenance.operations[0].body, /30713498516/);
  assert.equal(maintenance.operations.some(operation => ["add_label", "comment"].includes(operation.type)), false);

  const doctor = reduceRoleArtifact(roleCase("adw-doctor", { verdict: "action", summary: "Audit", actions: [{ kind: "report", entityId: "42", reason: "ruleset drift" }] }, { entityId: "42", labels: [], actionTargets: ["42"] }));
  assert.deepEqual(doctor.operations.map(operation => operation.type), ["report_drift"]);
});

test("patch role decisions bind assessment metadata", () => {
  const patchBytes = Buffer.from("x");
  const patch = { baseSha: "b".repeat(40), digest: digestBytes(patchBytes), size: 1, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const input = roleCase("builder", { verdict: "patch", summary: "Build", patch }, { entityId: "1", labels: [], headBranch: "adw/1", baseBranch: "main", title: "Build", body: "Body" }, patch, patchBytes);
  const decision = reduceRoleArtifact(input);
  assert.equal(decision.kind, "patch");
  assert.deepEqual(decision.patch, patch);
  assert.equal(decision.operations[0].type, "create_pr");
  assert.throws(() => reduceRoleArtifact({ ...input, reduction: { ...input.reduction, patch: null } }), error => error?.code === "contract");

  const reviser = roleCase("reviser", { verdict: "patch", summary: "Revise", patch }, { entityId: "2", labels: [], changedPaths: ["smith/src/lib.rs"] }, patch, patchBytes);
  assert.equal(reduceRoleArtifact(reviser).operations[0].type, "update_pr");
  const escaped = roleCase("reviser", { verdict: "patch", summary: "Revise", patch }, { entityId: "2", labels: [], changedPaths: ["docs/guide.md"] }, patch, patchBytes);
  assert.throws(() => reduceRoleArtifact(escaped), error => error?.code === "contract");
});

test("holds and unauthenticated steering fail closed", () => {
  const held = reduceRoleArtifact(roleCase("triager", { verdict: "accept", body: "Ready", labels: [] }, { entityId: "1", labels: ["needs:spec"] }));
  assert.equal(held.kind, "terminal");
  assert.deepEqual(held.operations, [{ type: "terminal", reason: "held" }]);
  assert.throws(
    () => reduceRoleArtifact(roleCase("steerer", { verdict: "comment", body: "Answer" }, { entityId: "1", labels: [], ownerAuthenticated: false })),
    error => error?.code === "contract",
  );
});

test("reduction rejects forged policy and event targets", () => {
  const input = roleCase("triager", { verdict: "accept", body: "Ready", labels: [] }, { entityId: "1", labels: [] });
  const forged = { ...input.rolePolicy, operations: [...input.rolePolicy.operations, "arm_auto_merge"].sort() };
  assert.throws(() => reduceRoleArtifact({ ...input, rolePolicy: forged }), error => error?.code === "contract");
  assert.throws(
    () => reduceRoleArtifact({ ...input, snapshot: { ...input.snapshot, event: { ...input.snapshot.event, entityId: "2" } } }),
    error => error?.code === "contract",
  );
});

test("pioneer verdicts preserve proof authority", () => {
  const disproved = reduceRoleArtifact(roleCase("pioneer", { verdict: "disproved", summary: "False", claim: "claim", patch: null }, { entityId: "1", labels: [] }));
  assert.equal(disproved.operations[0].label, "needs:spec");
  assert.match(disproved.operations[1].body, /Falsified claim: claim/);
  const proved = reduceRoleArtifact(roleCase("pioneer", { verdict: "proved", summary: "True", claim: "claim", patch: null }, { entityId: "1", labels: [], closingArtifactQualifies: true }));
  assert.deepEqual(proved.operations, [{ type: "noop", reason: "already_complete" }]);
});

test("deterministic snapshots expose settings drift and green blocked jams", () => {
  const expected = { name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "check" }, { context: "merge-gate" }] } }], bypass_actors: [] };
  const settings = value => ({ state: { resources: { "trusted:.github/rulesets/main.json": { data: JSON.stringify(expected) }, rulesets: [value] } } });
  assert.deepEqual(deriveDeterministicArtifacts("settings-auditor", settings(expected)), [{ drifts: [] }]);
  const live = structuredClone(expected);
  live.rules[0].parameters.strict_required_status_checks_policy = true;
  const drift = deriveDeterministicArtifacts("settings-auditor", settings(live));
  assert.equal(drift.length, 1);
  assert.equal(drift[0].drifts.length, 1);
  assert.match(drift[0].drifts[0].body, /strict_required_status_checks_policy/);

  const jamHead = "b".repeat(40);
  const jams = deriveDeterministicArtifacts("jam-detector", { state: { resources: { pulls: [{ number: "2", state: "open", headSha: jamHead, merged: false, mergeState: "behind", labels: ["reviewed", "security-cleared"], evidence: [{ kind: "correctness", headSha: jamHead, conclusion: "approve" }, { kind: "security", headSha: jamHead, conclusion: "approve" }], checks: [{ name: "check", headSha: jamHead, status: "completed", conclusion: "success" }, { name: "merge-gate", headSha: jamHead, status: "completed", conclusion: "success" }] }] } } });
  assert.equal(jams.length, 1);
  assert.deepEqual(jams[0], { entityId: "2", headSha: "b".repeat(40), stalled: true, reason: "Current-head checks and reviews passed, but merge state is behind." });
});

test("deterministic jam reports require a valid pull issue endpoint", () => {
  for (const entityId of ["repository", "refs/heads/main", "run:30713498516", "9007199254740992"]) {
    assert.throws(() => reduceDeterministicArtifact("jam-detector", { entityId, headSha: "b".repeat(40), stalled: true, reason: "stalled" }), error => error?.code === "contract");
  }
});

test("deterministic roles remain provider-free", () => {
  assert.deepEqual(listDeterministicRoles(), ["jam-detector", "label-sync", "settings-auditor"]);
  for (const name of listDeterministicRoles()) {
    const value = deterministicRole(name);
    assert.equal(value.name, name);
    assert.ok(Object.isFrozen(value));
    assert.equal(Object.hasOwn(value, "providers"), false);
  }
  assert.throws(() => deterministicRole("release-manager"), error => error?.code === "role");
});
