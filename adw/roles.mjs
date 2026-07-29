import { AdwError } from "./core.mjs";

export const PROVIDERS = Object.freeze(["claude", "codex"]);
export const OPERATIONS = Object.freeze([
  "comment", "add_label", "remove_label", "create_issue", "update_issue",
  "close_issue", "create_milestone", "update_milestone", "close_milestone",
  "assign_milestone", "link_sub_issue", "create_branch", "create_pr",
  "update_pr", "publish_check", "rerun_check", "dispatch_workflow",
  "arm_auto_merge", "sync_labels", "report_drift", "noop", "terminal",
]);

const providerSet = new Set(PROVIDERS);
const operationSet = new Set(OPERATIONS);
const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const outcomes = new Set(["positive", "negative", "noop", "unable"]);
const requiredDenials = ["adw/**", "docs/SPEC.md"];

function fail(message) {
  throw new AdwError("role", message);
}

function exact(value, keys, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(`${name} has invalid fields`);
}

function text(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail(`${name} must be a nonempty string`);
}

function sortedUnique(value, name, allowed) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((item, i) => item !== sorted[i])) fail(`${name} must be sorted and unique`);
  for (const item of value) {
    text(item, `${name}[]`);
    if (allowed && !allowed.has(item)) fail(`${name} contains an unsupported value`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function defineRole(input) {
  exact(input, [
    "name", "charter", "mode", "primary", "fallback", "providers",
    "providerConfig", "capabilities", "snapshot", "payload", "operations",
    "fallbackAuthority", "patch",
  ], "role");
  text(input.name, "role.name");
  text(input.charter, "role.charter");
  if (!new Set(["single", "quorum", "advisory"]).has(input.mode)) fail("role.mode is invalid");
  sortedUnique(input.providers, "role.providers", providerSet);
  if (input.mode === "quorum") {
    if (input.primary !== null || input.fallback !== null || input.providers.length !== 2) fail("quorum role must use both providers without routing");
  } else {
    if (!providerSet.has(input.primary)) fail("routed role requires a primary provider");
    if (input.fallback !== null && !providerSet.has(input.fallback)) fail("role fallback is invalid");
    if (input.fallback === input.primary) fail("primary and fallback must differ");
    const routed = [input.primary, input.fallback].filter(Boolean).sort();
    if (routed.length !== input.providers.length || routed.some((provider, i) => provider !== input.providers[i])) fail("routed roles must declare exactly their routed providers");
  }
  exact(input.providerConfig, input.providers, "role.providerConfig");
  for (const provider of input.providers) {
    const config = input.providerConfig[provider];
    exact(config, ["model", "effort", "timeoutSeconds"], `role.providerConfig.${provider}`);
    text(config.model, `role.providerConfig.${provider}.model`);
    if (!efforts.has(config.effort)) fail("provider effort is invalid");
    if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1 || config.timeoutSeconds > 300) fail("provider timeout is invalid");
  }
  sortedUnique(input.capabilities, "role.capabilities");
  exact(input.snapshot, ["fields", "maxBytes"], "role.snapshot");
  sortedUnique(input.snapshot.fields, "role.snapshot.fields");
  if (!Number.isInteger(input.snapshot.maxBytes) || input.snapshot.maxBytes < 1 || input.snapshot.maxBytes > 262_144) fail("snapshot bound is invalid");
  exact(input.payload, ["outcomes", "requiredKeys"], "role.payload");
  sortedUnique(input.payload.outcomes, "role.payload.outcomes", outcomes);
  sortedUnique(input.payload.requiredKeys, "role.payload.requiredKeys");
  sortedUnique(input.operations, "role.operations", operationSet);
  exact(input.fallbackAuthority, ["protected", "incomplete", "fork", "binary", "oversized"], "role.fallbackAuthority");
  for (const value of Object.values(input.fallbackAuthority)) if (typeof value !== "boolean") fail("fallback authority must be boolean");
  if (input.patch !== null) {
    exact(input.patch, ["maxBytes", "maxFiles", "allowedPrefixes", "deniedPaths"], "role.patch");
    if (!Number.isInteger(input.patch.maxBytes) || input.patch.maxBytes < 1 || input.patch.maxBytes > 1_048_576) fail("patch byte bound is invalid");
    if (!Number.isInteger(input.patch.maxFiles) || input.patch.maxFiles < 1 || input.patch.maxFiles > 100) fail("patch file bound is invalid");
    sortedUnique(input.patch.allowedPrefixes, "role.patch.allowedPrefixes");
    sortedUnique(input.patch.deniedPaths, "role.patch.deniedPaths");
    for (const denial of requiredDenials) if (!input.patch.deniedPaths.includes(denial)) fail(`role.patch.deniedPaths must include ${denial}`);
  }
  return deepFreeze(structuredClone(input));
}
