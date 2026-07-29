import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONS, PROVIDERS, defineRole } from "../roles.mjs";

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
