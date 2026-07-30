import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  OPERATIONS, PROVIDERS, defineRole, deterministicRole, listDeterministicRoles,
  listRoles, role, validateRolePayload,
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
  assert.throws(() => validateRolePayload("builder", { verdict: "patch", summary: "x", patch: { ...patch, files: [{ ...patch.files[0], path: "adw/core.mjs" }] } }), error => error?.code === "contract");
});

test("payload schema files exist for every family", async () => {
  for (const name of listRoles()) {
    const schema = JSON.parse(await readFile(role(name).payloadSchema, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(schema.oneOf.every(shape => shape.additionalProperties === false));
  }
});

test("explicit no-op is valid for every provider role", () => {
  for (const name of listRoles()) assert.deepEqual(validateRolePayload(name, { verdict: "noop", reason: "not applicable" }), { verdict: "noop", reason: "not applicable" });
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
