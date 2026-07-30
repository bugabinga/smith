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

const sorted = values => [...values].sort();
const fallbackAuthority = Object.freeze({ protected: false, incomplete: false, fork: false, binary: false, oversized: false });
const noFallbackLimits = Object.freeze({ protected: true, incomplete: true, fork: true, binary: true, oversized: true });
const deniedPaths = Object.freeze(["adw/**", "docs/SPEC.md"]);
const broadPrefixes = Object.freeze(sorted([
  ".claude/", ".github/", "Cargo.lock", "book/", "docs/", "prototypes/", "site/",
  "smith-ai/", "smith-cli/", "smith-core/", "smith-harness/", "smith-tui/", "smith/", "xtask/",
]));
const stateOperations = sorted(["add_label", "comment", "create_issue", "create_milestone", "update_issue", "assign_milestone", "link_sub_issue", "publish_check", "remove_label", "report_drift", "rerun_check", "sync_labels", "terminal", "noop"]);
const changeOperations = sorted(["add_label", "comment", "create_branch", "create_pr", "publish_check", "remove_label", "terminal", "noop", "update_pr"]);

function config({ name, charter, mode = "single", primary, fallback, claude, codex, capabilities, fields, operations, patch = null, limits = noFallbackLimits }) {
  const providers = sorted([primary, fallback].filter(Boolean));
  const providerConfig = {};
  if (providers.includes("claude")) providerConfig.claude = { model: claude.model, effort: claude.effort, timeoutSeconds: 300 };
  if (providers.includes("codex")) providerConfig.codex = { model: codex.model, effort: codex.effort, timeoutSeconds: 300 };
  return defineRole({
    name, charter, mode, primary, fallback, providers, providerConfig,
    capabilities: sorted(capabilities),
    snapshot: { fields: sorted(fields), maxBytes: 262144 },
    payload: { outcomes: ["negative", "noop", "positive", "unable"], requiredKeys: ["verdict"] },
    operations: sorted(operations),
    fallbackAuthority: limits,
    patch,
  });
}

const opus = effort => ({ model: "claude-opus-4-8", effort });
const fable = effort => ({ model: "claude-fable-5", effort });
const luna = effort => ({ model: "gpt-5.6-luna", effort });
const sol = effort => ({ model: "gpt-5.6-sol", effort });
const terra = effort => ({ model: "gpt-5.6-terra", effort });
const patch = allowedPrefixes => ({ maxBytes: 1_048_576, maxFiles: 100, allowedPrefixes: sorted(allowedPrefixes), deniedPaths: [...deniedPaths] });

const ROLES = deepFreeze({
  "steerer": config({ name: "steerer", charter: ".claude/agents/steerer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["comments:read", "comments:write"], fields: ["comment", "entity", "owner"], operations: ["comment", "noop", "terminal"] }),
  "triager": config({ name: "triager", charter: ".claude/agents/triager.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: luna("medium"), capabilities: ["issues:read", "issues:write"], fields: ["issue", "labels", "milestones"], operations: stateOperations }),
  "planner": config({ name: "planner", charter: ".claude/agents/planner.md", primary: "claude", fallback: "codex", claude: fable("xhigh"), codex: sol("xhigh"), capabilities: ["issues:read", "issues:write", "milestones:write"], fields: ["issues", "milestones", "spec_change"], operations: stateOperations }),
  "surveyor": config({ name: "surveyor", charter: ".claude/agents/surveyor.md", primary: "claude", fallback: "codex", claude: fable("high"), codex: sol("high"), capabilities: ["issues:read", "issues:write"], fields: ["issues", "milestones", "repository"], operations: stateOperations }),
  "builder": config({ name: "builder", charter: ".claude/agents/builder.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: terra("high"), capabilities: ["contents:write", "issues:read", "pulls:write"], fields: ["issue", "repository", "route"], operations: changeOperations, patch: patch(broadPrefixes) }),
  "codex-builder": config({ name: "codex-builder", charter: ".claude/agents/builder.md", primary: "codex", fallback: null, codex: terra("high"), capabilities: ["contents:write", "issues:read", "pulls:write"], fields: ["issue", "repository", "route"], operations: changeOperations, patch: patch(broadPrefixes) }),
  "pioneer": config({ name: "pioneer", charter: ".claude/skills/pioneer/SKILL.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["contents:write", "issues:write", "pulls:write"], fields: ["claim", "issue", "spec"], operations: sorted([...changeOperations, "close_issue", "update_issue"]), patch: patch(["prototypes/"]) }),
  "reviewer": config({ name: "reviewer", charter: ".claude/agents/reviewer.md", primary: "claude", fallback: "codex", claude: opus("xhigh"), codex: sol("high"), capabilities: ["checks:write", "pulls:read"], fields: ["diff", "files", "pull", "reviews"], operations: ["add_label", "comment", "publish_check", "remove_label", "terminal", "noop"], limits: fallbackAuthority }),
  "security-reviewer": config({ name: "security-reviewer", charter: ".claude/agents/security-reviewer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["checks:write", "pulls:read"], fields: ["diff", "files", "pull", "security"], operations: ["add_label", "comment", "publish_check", "remove_label", "terminal", "noop"], limits: fallbackAuthority }),
  "reviser": config({ name: "reviser", charter: ".claude/agents/builder.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: terra("high"), capabilities: ["contents:write", "pulls:write"], fields: ["changed_paths", "findings", "pull"], operations: changeOperations, patch: patch(broadPrefixes) }),
  "sweeper": config({ name: "sweeper", charter: ".claude/agents/sweeper.md", primary: "codex", fallback: null, codex: luna("low"), capabilities: ["actions:write", "issues:write", "pulls:write"], fields: ["issues", "pulls", "routes", "runs"], operations: stateOperations }),
  "adw-doctor": config({ name: "adw-doctor", charter: ".claude/agents/adw-doctor.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: sol("xhigh"), capabilities: ["actions:read", "issues:write", "settings:read"], fields: ["config", "runs", "settings"], operations: ["create_issue", "noop", "report_drift", "terminal"] }),
  "docs-writer": config({ name: "docs-writer", charter: ".claude/agents/docs-writer.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: terra("medium"), capabilities: ["contents:write", "pulls:write"], fields: ["diff", "docs", "pull"], operations: changeOperations, patch: patch(["book/", "docs/", "site/", "smith/"]) }),
  "dependency-manager": config({ name: "dependency-manager", charter: ".claude/agents/dependency-manager.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: terra("medium"), capabilities: ["issues:write", "pulls:read"], fields: ["dependency", "diff", "pull"], operations: stateOperations }),
  "alert-triager": config({ name: "alert-triager", charter: ".claude/agents/security-reviewer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["alerts:read", "issues:write"], fields: ["alert", "issues", "pulls"], operations: stateOperations }),
});

const DETERMINISTIC_ROLES = deepFreeze({
  "jam-detector": { name: "jam-detector", payloadFamily: "jam", capabilities: ["actions:read", "issues:write", "pulls:read"], operations: ["comment", "noop", "terminal"] },
  "label-sync": { name: "label-sync", payloadFamily: "labels", capabilities: ["issues:write"], operations: ["noop", "sync_labels", "terminal"] },
  "settings-auditor": { name: "settings-auditor", payloadFamily: "drift", capabilities: ["settings:read"], operations: ["noop", "report_drift", "terminal"] },
});

export function role(name) {
  const value = ROLES[name];
  if (!value) throw new AdwError("role", `unknown role: ${name}`);
  return value;
}

export const listRoles = () => Object.freeze(Object.keys(ROLES).sort());

export function deterministicRole(name) {
  const value = DETERMINISTIC_ROLES[name];
  if (!value) throw new AdwError("role", `unknown deterministic role: ${name}`);
  return value;
}

export const listDeterministicRoles = () => Object.freeze(Object.keys(DETERMINISTIC_ROLES).sort());
