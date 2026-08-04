import {
  AdwError, MERGE_OBLIGATION_PROVIDERS, canonicalBytes, digestJson, holdReasons, planMergeGate, reduceAssessments,
  validateAssessment, validateDecision, validateOperation, validatePatchManifest, validateSnapshot,
} from "./core.mjs";

export const PROVIDERS = Object.freeze(["claude", "codex"]);
export const OPERATIONS = Object.freeze([
  "comment", "add_label", "remove_label", "create_issue", "update_issue",
  "close_issue", "create_milestone", "update_milestone", "close_milestone",
  "assign_milestone", "link_sub_issue", "create_branch", "create_pr",
  "update_pr", "publish_check", "rerun_check", "dispatch_repository",
  "arm_auto_merge", "sync_labels", "report_drift", "noop", "terminal",
]);

const providerSet = new Set(PROVIDERS);
const operationSet = new Set(OPERATIONS);
const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const outcomes = new Set(["positive", "negative", "noop", "unable"]);
const ISSUE_ENDPOINT_EVENTS = new Set(["issue", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"]);
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

const BASE_ROLES = deepFreeze({
  "steerer": config({ name: "steerer", charter: ".claude/agents/steerer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["comments:read", "comments:write"], fields: ["comment", "entity", "owner"], operations: ["comment", "noop", "terminal"] }),
  "triager": config({ name: "triager", charter: ".claude/agents/triager.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: luna("medium"), capabilities: ["issues:read", "issues:write"], fields: ["issue", "labels", "milestones"], operations: ["add_label", "comment", "noop", "terminal"] }),
  "planner": config({ name: "planner", charter: ".claude/agents/planner.md", primary: "claude", fallback: "codex", claude: fable("xhigh"), codex: sol("xhigh"), capabilities: ["issues:read", "issues:write", "milestones:write"], fields: ["issues", "milestones", "spec_change"], operations: ["create_issue", "noop", "remove_label", "terminal"] }),
  "surveyor": config({ name: "surveyor", charter: ".claude/agents/surveyor.md", primary: "claude", fallback: "codex", claude: fable("high"), codex: sol("high"), capabilities: ["issues:read", "issues:write"], fields: ["issues", "milestones", "repository"], operations: ["create_issue", "noop", "terminal"] }),
  "builder": config({ name: "builder", charter: ".claude/agents/builder.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: terra("high"), capabilities: ["contents:write", "issues:read", "pulls:write"], fields: ["issue", "repository", "route"], operations: ["add_label", "comment", "create_pr", "noop", "terminal"], patch: patch(broadPrefixes) }),
  "codex-builder": config({ name: "codex-builder", charter: ".claude/agents/builder.md", primary: "codex", fallback: null, codex: terra("high"), capabilities: ["contents:write", "issues:read", "pulls:write"], fields: ["issue", "repository", "route"], operations: ["add_label", "comment", "create_pr", "noop", "terminal"], patch: patch(broadPrefixes) }),
  "pioneer": config({ name: "pioneer", charter: ".claude/skills/pioneer/SKILL.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["contents:write", "issues:write", "pulls:write"], fields: ["claim", "issue", "spec"], operations: ["add_label", "comment", "create_pr", "noop", "remove_label", "terminal"], patch: patch(["prototypes/"]) }),
  "reviewer": config({ name: "reviewer", charter: ".claude/agents/reviewer.md", primary: "claude", fallback: "codex", claude: opus("xhigh"), codex: sol("high"), capabilities: ["checks:write", "pulls:read"], fields: ["diff", "files", "pull", "reviews"], operations: ["add_label", "comment", "publish_check", "remove_label", "terminal", "noop"], limits: fallbackAuthority }),
  "security-reviewer": config({ name: "security-reviewer", charter: ".claude/agents/security-reviewer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["checks:write", "pulls:read"], fields: ["diff", "files", "pull", "security"], operations: ["add_label", "comment", "publish_check", "remove_label", "terminal", "noop"], limits: fallbackAuthority }),
  "reviser": config({ name: "reviser", charter: ".claude/agents/builder.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: terra("high"), capabilities: ["contents:write", "pulls:write"], fields: ["changed_paths", "findings", "pull"], operations: ["add_label", "comment", "noop", "terminal", "update_pr"], patch: patch(broadPrefixes) }),
  "sweeper": config({ name: "sweeper", charter: ".claude/agents/sweeper.md", primary: "codex", fallback: null, codex: luna("low"), capabilities: ["actions:write", "issues:write", "pulls:write"], fields: ["issues", "pulls", "routes", "runs"], operations: ["create_issue", "noop", "rerun_check", "terminal"] }),
  "adw-doctor": config({ name: "adw-doctor", charter: ".claude/agents/adw-doctor.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: sol("xhigh"), capabilities: ["actions:read", "issues:write", "settings:read"], fields: ["config", "runs", "settings"], operations: ["create_issue", "noop", "report_drift", "terminal"] }),
  "docs-writer": config({ name: "docs-writer", charter: ".claude/agents/docs-writer.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: terra("medium"), capabilities: ["contents:write", "pulls:write"], fields: ["diff", "docs", "pull"], operations: ["add_label", "comment", "create_pr", "noop", "terminal"], patch: patch(["book/", "docs/", "site/"]) }),
  "dependency-manager": config({ name: "dependency-manager", charter: ".claude/agents/dependency-manager.md", primary: "codex", fallback: "claude", claude: opus("high"), codex: terra("medium"), capabilities: ["issues:write", "pulls:read"], fields: ["dependency", "diff", "pull"], operations: ["add_label", "comment", "noop", "terminal"] }),
  "alert-triager": config({ name: "alert-triager", charter: ".claude/agents/security-reviewer.md", primary: "claude", fallback: "codex", claude: opus("high"), codex: sol("high"), capabilities: ["alerts:read", "issues:write"], fields: ["alert", "issues", "pulls"], operations: ["create_issue", "noop", "terminal"] }),
});

const ROLE_FAMILIES = Object.freeze({
  "steerer": "steering", "triager": "triage", "planner": "plan", "surveyor": "survey",
  "builder": "change", "codex-builder": "change", "pioneer": "pioneer", "reviewer": "review",
  "security-reviewer": "review", "reviser": "change", "sweeper": "maintenance",
  "adw-doctor": "maintenance", "docs-writer": "change", "dependency-manager": "dependency",
  "alert-triager": "alert",
});
const ROLES = deepFreeze(Object.fromEntries(Object.entries(BASE_ROLES).map(([name, value]) => [name, {
  ...value,
  payloadFamily: ROLE_FAMILIES[name],
  payloadSchema: `adw/schemas/role-payloads/${ROLE_FAMILIES[name]}.schema.json`,
}])));

const DETERMINISTIC_ROLES = deepFreeze({
  "jam-detector": { name: "jam-detector", payloadFamily: "jam", capabilities: ["actions:read", "issues:write", "pulls:read"], operations: ["comment", "noop", "terminal"] },
  "label-sync": { name: "label-sync", payloadFamily: "labels", capabilities: ["issues:write"], operations: ["noop", "sync_labels", "terminal"] },
  "settings-auditor": { name: "settings-auditor", payloadFamily: "drift", capabilities: ["settings:read"], operations: ["noop", "report_drift", "terminal"] },
});

// These authorities are control-plane reducers, not provider roles. Keeping them
// separate prevents reconciliation/audit writes from widening any model's role.
const CONTROL_AUTHORITIES = deepFreeze({
  reconciler: {
    name: "reconciler", kind: "control", mode: "single", primary: null, patch: null, capabilities: ["actions:read", "actions:write", "checks:read", "checks:write", "contents:write", "issues:write", "pulls:read", "repository:read"],
    operations: ["add_label", "dispatch_repository", "noop", "rerun_check", "sync_labels"],
    snapshot: { fields: ["issues", "labels", "pulls", "routes", "runs"], maxBytes: 262144 },
    trustedPaths: [".github/labels.yml"],
    eventKinds: ["check", "dispatch", "pull_request", "pull_request_review", "pull_request_review_comment", "push", "schedule", "workflow"],
  },
  auditor: {
    name: "auditor", kind: "control", mode: "single", primary: null, patch: null, capabilities: ["checks:read", "checks:write", "contents:read", "issues:read", "issues:write", "pulls:read", "pulls:write", "repository:read", "settings:read"],
    operations: ["arm_auto_merge", "comment", "noop", "publish_check", "report_drift", "sync_labels"],
    snapshot: { fields: ["config", "labels", "pulls", "settings"], maxBytes: 262144 },
    trustedPaths: [".github/labels.yml", ".github/rulesets/main.json"],
    eventKinds: ["dispatch", "push", "schedule"],
  },
});

function payloadFail(message) {
  throw new AdwError("contract", message);
}

function payloadObject(value, keys, name = "payload") {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) payloadFail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) payloadFail(`${name} has invalid fields`);
}

function payloadText(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) payloadFail(`${name} is invalid`);
}

function payloadRestId(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) payloadFail(`${name} is invalid`);
  return value;
}

function payloadArray(value, name, max = 100) {
  if (!Array.isArray(value) || value.length > max) payloadFail(`${name} is invalid`);
}

function validateFindings(findings) {
  payloadArray(findings, "findings");
  for (const finding of findings) {
    payloadObject(finding, ["severity", "path", "line", "message"], "finding");
    if (!new Set(["low", "medium", "high"]).has(finding.severity)) payloadFail("finding severity is invalid");
    payloadText(finding.path, "finding path");
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) payloadFail("finding line is invalid");
    payloadText(finding.message, "finding message");
  }
}

function validateNoop(value) {
  payloadObject(value, ["verdict", "reason"]);
  if (value.verdict !== "noop") payloadFail("no-op verdict is invalid");
  payloadText(value.reason, "reason");
}

function validateIssue(value) {
  payloadObject(value, ["title", "body", "labels"], "issue");
  payloadText(value.title, "issue title");
  payloadText(value.body, "issue body");
  payloadArray(value.labels, "issue labels", 20);
  value.labels.forEach(label => payloadText(label, "issue label"));
}

export function validateRolePayload(name, value) {
  const policy = role(name);
  const family = policy.payloadFamily;
  if (value?.verdict === "noop") {
    validateNoop(value);
  } else if (family === "steering") {
    payloadObject(value, ["verdict", "body"]);
    if (value.verdict !== "comment") payloadFail("steering verdict is invalid");
    payloadText(value.body, "body");
  } else if (family === "triage") {
    payloadObject(value, ["verdict", "body", "labels"]);
    if (!new Set(["accept", "needs_info", "needs_spec"]).has(value.verdict)) payloadFail("triage verdict is invalid");
    payloadText(value.body, "body");
    payloadArray(value.labels, "labels", 20);
    value.labels.forEach(label => payloadText(label, "label"));
  } else if (family === "plan" || family === "survey") {
    payloadObject(value, ["verdict", "summary", "issues"]);
    if (!new Set(family === "plan" ? ["planned", "blocked"] : ["proposal", "blocked"]).has(value.verdict)) payloadFail(`${family} verdict is invalid`);
    payloadText(value.summary, "summary");
    payloadArray(value.issues, "issues", 50);
    value.issues.forEach(validateIssue);
  } else if (family === "change") {
    if (value?.verdict === "blocked") {
      payloadObject(value, ["verdict", "reason"]); payloadText(value.reason, "reason");
    } else {
      payloadObject(value, ["verdict", "summary", "patch"]);
      if (value.verdict !== "patch") payloadFail("change verdict is invalid");
      payloadText(value.summary, "summary");
      try { validatePatchManifest(value.patch, policy); } catch { payloadFail("patch is invalid"); }
    }
  } else if (family === "pioneer") {
    payloadObject(value, ["verdict", "summary", "claim", "patch"]);
    if (!new Set(["proved", "disproved", "inconclusive"]).has(value.verdict)) payloadFail("pioneer verdict is invalid");
    payloadText(value.summary, "summary");
    payloadText(value.claim, "claim");
    if (value.verdict !== "proved" && value.patch !== null) payloadFail("only proved pioneer artifacts may patch");
    if (value.patch !== null) {
      try { validatePatchManifest(value.patch, policy); } catch { payloadFail("pioneer patch is invalid"); }
    }
  } else if (family === "review") {
    payloadObject(value, ["verdict", "risk", "findings"]);
    if (!new Set(["approve", "reject"]).has(value.verdict) || !new Set(["none", "high"]).has(value.risk)) payloadFail("review verdict is invalid");
    if (value.verdict === "approve" && value.risk === "high") payloadFail("high risk cannot approve");
    validateFindings(value.findings);
  } else if (family === "maintenance") {
    payloadObject(value, ["verdict", "summary", "actions"]);
    if (value.verdict !== "action") payloadFail("maintenance verdict is invalid");
    payloadText(value.summary, "summary");
    payloadArray(value.actions, "actions", 50);
    for (const action of value.actions) {
      payloadObject(action, ["kind", "entityId", "reason"], "action");
      if (!new Set(["retry", "hold", "report"]).has(action.kind)) payloadFail("action kind is invalid");
      payloadText(action.entityId, "action entity"); payloadText(action.reason, "action reason");
    }
  } else if (family === "dependency") {
    payloadObject(value, ["verdict", "summary", "reason"]);
    if (!new Set(["safe", "risky"]).has(value.verdict)) payloadFail("dependency verdict is invalid");
    payloadText(value.summary, "summary"); payloadText(value.reason, "reason");
  } else if (family === "alert") {
    payloadObject(value, ["verdict", "summary", "issue"]);
    if (!new Set(["covered", "issue"]).has(value.verdict)) payloadFail("alert verdict is invalid");
    payloadText(value.summary, "summary");
    if (value.verdict === "issue") validateIssue(value.issue);
    else if (value.issue !== null) payloadFail("covered alert cannot create issue");
  } else {
    payloadFail("payload family is unsupported");
  }
  if (canonicalBytes(value).length > 262_144) payloadFail("payload is oversized");
  return deepFreeze(structuredClone(value));
}

function operationMarker(assessmentDigest) {
  return `smith:adw-artifact/v1:${assessmentDigest}`;
}

function stateContent(value, name) {
  const keys = value && Object.keys(value).sort().join(",");
  const exact = keys === "bytes,data,digest,source,trust" || (keys === "bytes,data,digest,source,truncated,trust" && value.truncated === false);
  if (!exact || value.trust !== "untrusted" || typeof value.data !== "string" || value.bytes !== canonicalBytes(value.data).length || value.digest !== digestJson(value.data)) payloadFail(`${name} is not bound untrusted content`);
  payloadText(value.data, name);
  return value.data;
}

function reductionState(snapshot) {
  const state = snapshot.state;
  if (typeof state.entityId !== "string" || state.entityId.length === 0) payloadFail("snapshot entity is required");
  if (state.labels !== undefined && !Array.isArray(state.labels)) payloadFail("snapshot labels are invalid");
  return state;
}

function semanticOutcome(verdict) {
  if (verdict === "noop") return "noop";
  if (new Set(["blocked", "disproved", "inconclusive", "reject", "risky"]).has(verdict)) return "negative";
  return "positive";
}

const EXECUTION_ROUTE_LABELS = Object.freeze({
  planner: "needs:breakdown",
  pioneer: "needs:prototype",
  reviewer: "changes-requested",
  reviser: "changes-requested",
});

function executionHoldReasons(labels, roleName) {
  const routeLabel = EXECUTION_ROUTE_LABELS[roleName];
  return holdReasons(labels).filter(reason => reason !== routeLabel);
}

function boundedFindingReport(summary, actions) {
  const limit = 65_536;
  let safeSummary = "";
  let summaryBytes = 0;
  for (const character of summary) {
    const bytes = Buffer.byteLength(character);
    if (summaryBytes + bytes > 16_384) break;
    safeSummary += character;
    summaryBytes += bytes;
  }
  const prefix = `${safeSummary}\n\nFindings: ${actions.length}\nDigest: ${digestJson(actions)}`;
  let body = prefix;
  const omitted = `\n- ${actions.length} finding(s) are bound by the digest above; remaining text omitted.`;
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const line = `\n- ${action.kind} ${action.entityId}: ${action.reason}`;
    const reserve = index === actions.length - 1 ? "" : omitted;
    if (Buffer.byteLength(body) + Buffer.byteLength(line) + Buffer.byteLength(reserve) > limit) {
      body += omitted;
      break;
    }
    body += line;
  }
  if (Buffer.byteLength(body) > limit) payloadFail("maintenance report is oversized");
  return body;
}

export function reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments }) {
  validateSnapshot(snapshot);
  const canonicalPolicy = role(rolePolicy?.name);
  if (digestJson(rolePolicy) !== digestJson(canonicalPolicy)) payloadFail("role policy is not canonical");
  if (snapshot.routing.role !== rolePolicy.name || snapshot.routing.mode !== rolePolicy.mode || snapshot.routing.primary !== rolePolicy.primary) payloadFail("snapshot route does not match policy");
  if (!reduction || reduction.status !== "artifact" || reduction.authoritative !== true || !Array.isArray(reduction.selected) || reduction.selected.length === 0) payloadFail("reduction is not authoritative");
  if (!Array.isArray(assessments)) payloadFail("assessments are invalid");
  const qualified = reduceAssessments({ snapshot, rolePolicy, assessments });
  if (digestJson(qualified) !== digestJson(reduction)) payloadFail("reduction is not qualified from supplied artifacts");
  const indexed = new Map();
  for (const raw of assessments) {
    const assessment = validateAssessment(raw?.assessment ?? raw);
    indexed.set(digestJson(assessment), assessment);
  }
  const selected = reduction.selected.map(item => {
    const assessment = indexed.get(item);
    if (!assessment || assessment.controlSha !== snapshot.controlSha || assessment.snapshotDigest !== digestJson(snapshot) || assessment.role !== rolePolicy.name) payloadFail("selected assessment is invalid");
    return assessment;
  });
  const assessment = selected[0];
  const payload = validateRolePayload(rolePolicy.name, assessment.payload);
  if (assessment.outcome !== semanticOutcome(payload.verdict)) payloadFail("assessment outcome contradicts payload");
  if (rolePolicy.payloadFamily === "change" && (payload.verdict === "patch") !== (assessment.patch !== null)) payloadFail("change patch presence contradicts verdict");
  const patchVerdict = (rolePolicy.payloadFamily === "change" && payload.verdict === "patch") || (rolePolicy.payloadFamily === "pioneer" && payload.verdict === "proved" && payload.patch !== null);
  if ((assessment.patch !== null) !== patchVerdict) payloadFail("assessment patch contradicts payload");
  if (digestJson(assessment.patch) !== digestJson(reduction.patch)) payloadFail("reduction patch does not match assessment");
  if (payload.patch !== undefined && digestJson(payload.patch) !== digestJson(assessment.patch)) payloadFail("payload patch does not match assessment");
  const state = reductionState(snapshot);
  const issueEndpoint = ISSUE_ENDPOINT_EVENTS.has(snapshot.event.kind)
    && /^[1-9][0-9]*$/.test(state.entityId) && Number.isSafeInteger(Number(state.entityId));
  const requireIssueEndpoint = () => { if (!issueEndpoint) payloadFail("role operation target is not an issue endpoint"); };
  if (rolePolicy.name === "reviser" && assessment.patch && (!Array.isArray(state.changedPaths) || assessment.patch.files.some(file => !state.changedPaths.includes(file.path)))) payloadFail("revision patch escapes current pull paths");
  if (state.entityId !== snapshot.event.entityId) payloadFail("snapshot entity does not match event");
  const pioneerRevision = (snapshot.revisions.find(revision => revision.resource === `issue:${state.entityId}`) ?? (snapshot.revisions.length === 1 ? snapshot.revisions[0] : null))?.token;
  const marker = rolePolicy.payloadFamily === "pioneer"
    ? (() => {
        if (typeof pioneerRevision !== "string" || pioneerRevision.length === 0 || /[\s\0]/.test(pioneerRevision)) payloadFail("pioneer source revision is invalid");
        const artifact = payload.verdict === "inconclusive" ? "-" : reduction.selected[0];
        return `<!-- smith:pioneer/v1 issue=${state.entityId} source=${pioneerRevision} verdict=${payload.verdict} artifact=${artifact} -->`;
      })()
    : operationMarker(reduction.selected[0]);
  if (assessment.patch && !snapshot.revisions.some(revision => revision.token === assessment.patch.baseSha)) payloadFail("patch base is not a snapshot revision");
  let kind = assessment.patch ? "patch" : "state";
  let operations = [];
  if (payload.verdict === "noop") {
    operations = [{ type: "noop", reason: "not_applicable" }];
  } else if (executionHoldReasons(state.labels ?? [], rolePolicy.name).length > 0) {
    kind = "terminal";
    operations = [{ type: "terminal", reason: "held" }];
  } else if (rolePolicy.payloadFamily === "steering") {
    requireIssueEndpoint();
    if (state.ownerAuthenticated !== true) payloadFail("steering actor is not owner-authenticated");
    operations = [{ type: "comment", entityId: state.entityId, body: payload.body, marker }];
  } else if (rolePolicy.payloadFamily === "triage") {
    requireIssueEndpoint();
    const required = { accept: "ready", needs_info: "needs:info", needs_spec: "needs:spec" }[payload.verdict];
    operations = [
      { type: "comment", entityId: state.entityId, body: payload.body, marker },
      ...[...new Set([...payload.labels, required])].map(label => ({ type: "add_label", entityId: state.entityId, label })),
    ];
  } else if (rolePolicy.payloadFamily === "plan" || rolePolicy.payloadFamily === "survey") {
    operations = payload.issues.map(issue => ({
      type: "create_issue", ...issue,
      labels: payload.verdict === "blocked" ? [...new Set([...issue.labels, "blocked"])] : issue.labels,
      marker,
    }));
    if (operations.length === 0 && payload.verdict === "blocked") operations.push({ type: "create_issue", title: `ADW ${rolePolicy.name} blocked`, body: payload.summary, labels: ["blocked"], marker });
    if (rolePolicy.name === "planner" && payload.verdict === "planned" && state.labels?.includes("needs:breakdown")) {
      requireIssueEndpoint();
      operations.push({ type: "remove_label", entityId: state.entityId, label: "needs:breakdown" });
    }
    if (operations.length === 0) operations.push({ type: "noop", reason: "not_applicable" });
  } else if (rolePolicy.payloadFamily === "change") {
    if (payload.verdict === "blocked") {
      requireIssueEndpoint();
      kind = "state";
      operations = [{ type: "comment", entityId: state.entityId, body: payload.reason, marker }, { type: "add_label", entityId: state.entityId, label: "blocked" }];
    } else if (rolePolicy.name === "reviser") {
      operations = [{ type: "update_pr", prId: state.entityId, body: payload.summary }];
    } else {
      for (const key of ["headBranch", "baseBranch"]) payloadText(state[key], `snapshot ${key}`);
      operations = [{ type: "create_pr", head: state.headBranch, base: state.baseBranch, title: stateContent(state.title, "snapshot title"), body: stateContent(state.body, "snapshot body"), marker }];
    }
  } else if (rolePolicy.payloadFamily === "pioneer") {
    requireIssueEndpoint();
    if (payload.verdict === "proved") {
      if (state.closingArtifactQualifies === true) operations = [{ type: "noop", reason: "already_complete" }];
      else if (assessment.patch) {
        for (const key of ["headBranch", "baseBranch"]) payloadText(state[key], `snapshot ${key}`);
        operations = [{ type: "create_pr", head: state.headBranch, base: state.baseBranch, title: stateContent(state.title, "snapshot title"), body: stateContent(state.body, "snapshot body"), marker }];
      } else payloadFail("proof lacks a qualifying artifact");
    } else if (payload.verdict === "disproved") {
      operations = [{ type: "add_label", entityId: state.entityId, label: "needs:spec" }, { type: "comment", entityId: state.entityId, body: `${payload.summary}\n\nFalsified claim: ${payload.claim}`, marker }];
    } else operations = [{ type: "comment", entityId: state.entityId, body: payload.summary, marker }];
    if (state.labels?.includes("needs:prototype")) {
      if (operations.length === 1 && operations[0].type === "noop") operations = [];
      operations.push({ type: "remove_label", entityId: state.entityId, label: "needs:prototype" });
    }
  } else if (rolePolicy.payloadFamily === "review") {
    requireIssueEndpoint();
    if (!snapshot.revisions.some(revision => revision.token === state.headSha)) payloadFail("review head is not a snapshot revision");
    const security = rolePolicy.name === "security-reviewer";
    const reviewKind = security ? "security" : "correctness";
    const approval = security ? "security-cleared" : "reviewed";
    const rejected = payload.verdict === "reject" || payload.risk === "high";
    operations = [
      { type: "publish_check", headSha: state.headSha, name: rolePolicy.name, conclusion: rejected ? "failure" : "success", summary: rejected ? "rejected" : "approved", externalId: reduction.selected[0] },
      rejected ? { type: "add_label", entityId: state.entityId, label: "changes-requested" } : { type: "add_label", entityId: state.entityId, label: approval },
    ];
    const evidenceMarker = `<!-- smith:review-evidence/v1 kind=${reviewKind} head=${state.headSha} conclusion=${rejected ? "reject" : "approve"} provider=${assessment.provider} authoritative=true artifact=${reduction.selected[0]} -->`;
    operations.push({ type: "comment", entityId: state.entityId, body: evidenceMarker, marker: evidenceMarker });
    if (payload.risk === "high") {
      let createdAt;
      try { createdAt = new Date(assessment.completedAt).toISOString(); } catch { payloadFail("assessment completion time is invalid"); }
      if (createdAt !== assessment.completedAt) payloadFail("assessment completion time is not canonical");
      operations.push({ type: "add_label", entityId: state.entityId, label: "risk:high" });
      const riskMarker = `<!-- smith:risk/v1 head=${state.headSha} finding=${digestJson(payload.findings)} status=open created=${createdAt} cleared=- -->`;
      operations.push({ type: "comment", entityId: state.entityId, body: riskMarker, marker: riskMarker });
    }
    if (rejected) operations.push({ type: "remove_label", entityId: state.entityId, label: approval });
    else operations.push({ type: "remove_label", entityId: state.entityId, label: "changes-requested" });
  } else if (rolePolicy.payloadFamily === "maintenance") {
    if (!Array.isArray(state.actionTargets) || payload.actions.some(action => !state.actionTargets.includes(action.entityId))) payloadFail("maintenance target is outside snapshot");
    const runTargets = new Map((state.resources?.runs ?? []).filter(run => typeof run?.id === "string" && Number.isSafeInteger(run?.attempt) && run.attempt > 0 && Array.isArray(run.failedJobs) && run.failedJobs.length > 0).map(run => [run.id, run]));
    const retries = payload.actions.filter(action => action.kind === "retry");
    if ((retries.length > 0 && !rolePolicy.operations.includes("rerun_check")) || retries.some(action => !runTargets.has(action.entityId)) || new Set(retries.map(action => action.entityId)).size !== retries.length) payloadFail("maintenance retry target is not a workflow run");
    operations = retries.map(action => ({ type: "rerun_check", runId: action.entityId, attempt: runTargets.get(action.entityId).attempt, failedJobs: runTargets.get(action.entityId).failedJobs }));
    const findings = payload.actions.filter(action => action.kind !== "retry");
    if (findings.length > 0) {
      const report = { title: `ADW ${rolePolicy.name} findings`, body: boundedFindingReport(payload.summary, findings), marker };
      operations.push(rolePolicy.name === "adw-doctor" ? { type: "report_drift", ...report } : { type: "create_issue", ...report, labels: ["adw:drift"] });
    }
    if (operations.length === 0) operations.push({ type: "noop", reason: "not_applicable" });
  } else if (rolePolicy.payloadFamily === "dependency") {
    requireIssueEndpoint();
    operations = [{ type: "comment", entityId: state.entityId, body: payload.summary, marker }];
    if (payload.verdict === "risky") operations.push({ type: "add_label", entityId: state.entityId, label: "needs:spec" });
  } else if (rolePolicy.payloadFamily === "alert") {
    operations = payload.verdict === "issue"
      ? [{ type: "create_issue", ...payload.issue, marker }]
      : [{ type: "noop", reason: "already_complete" }];
  } else payloadFail("role payload family cannot be reduced");
  if (Object.hasOwn(MERGE_OBLIGATION_PROVIDERS, rolePolicy.name) && state.merged === true && (payload.verdict === "patch" || payload.verdict === "noop")) {
    if (snapshot.event.kind !== "pull_request" || !new Set(["closed", "run_obligation"]).has(snapshot.event.action) || typeof state.mergeSha !== "string" || !/^[0-9a-f]{40}$/.test(state.mergeSha)) payloadFail("merge obligation authority is invalid");
    const finalization = `<!-- smith:merge-finalized/v1 pr=${state.entityId} merge=${state.mergeSha} role=${rolePolicy.name} status=complete artifact=${reduction.selected[0]} -->`;
    operations.push({ type: "comment", entityId: state.entityId, body: finalization, marker: finalization });
  }
  operations = operations.map(operation => validateOperation(operation, rolePolicy));
  return validateDecision({
    schemaVersion: 1,
    controlSha: snapshot.controlSha,
    snapshotDigest: digestJson(snapshot),
    assessmentDigests: [...reduction.selected],
    kind,
    operations,
    patch: kind === "patch" ? assessment.patch : null,
  });
}

const EXPECTED_REPOSITORY_SETTINGS = deepFreeze({
  allowAutoMerge: true,
  allowMergeCommit: false,
  allowRebaseMerge: false,
  allowSquashMerge: true,
  deleteBranchOnMerge: true,
});

export function apiSafeLabelDefinition(value) {
  return typeof value?.name === "string" && [...value.name].length > 0 && [...value.name].length <= 50
    && typeof value.color === "string" && /^[0-9a-fA-F]{6}$/.test(value.color)
    && typeof value.description === "string" && [...value.description].length <= 100;
}

function labelDefinitions(source) {
  if (typeof source !== "string") payloadFail("trusted label definitions are invalid");
  const definitions = [];
  let current = null;
  const decode = value => {
    const text = value.trim();
    if (text.startsWith('"') && text.endsWith('"')) {
      try { return JSON.parse(text); } catch { payloadFail("trusted label definitions are invalid"); }
    }
    return text;
  };
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    let match = /^- name:\s*(.+)$/.exec(line);
    if (match) { current = { name: decode(match[1]) }; definitions.push(current); continue; }
    match = /^(color|description):\s*(.*)$/.exec(line);
    if (!match || current === null) payloadFail("trusted label definitions are invalid");
    current[match[1]] = decode(match[2]);
  }
  if (definitions.length > 100) payloadFail("trusted label definitions are invalid");
  const names = new Set();
  for (const definition of definitions) {
    payloadObject(definition, ["name", "color", "description"], "label definition");
    if (!apiSafeLabelDefinition(definition) || names.has(definition.name)) payloadFail("trusted label definitions are invalid");
    names.add(definition.name);
    definition.color = definition.color.toLowerCase();
  }
  return definitions;
}

function envelopeData(value, name) {
  if (typeof value === "string") return value;
  if (value && typeof value.data === "string") return value.data;
  payloadFail(`${name} is invalid`);
}

function canonicalRulesetComparison(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return value;
  const result = structuredClone(value);
  const canonicalOrder = (left, right) => canonicalBytes(left).compare(canonicalBytes(right));
  for (const key of ["include", "exclude"]) if (Array.isArray(result.conditions?.ref_name?.[key])) result.conditions.ref_name[key].sort();
  if (Array.isArray(result.rules)) {
    for (const rule of result.rules) {
      if (rule?.type === "required_status_checks" && Array.isArray(rule.parameters?.required_status_checks)) {
        rule.parameters.required_status_checks = rule.parameters.required_status_checks.map(check => {
          if (!check || Array.isArray(check) || typeof check !== "object") return check;
          const normalized = { ...check };
          if (normalized.integration_id === null) delete normalized.integration_id;
          return normalized;
        }).sort((left, right) => String(left?.context ?? "").localeCompare(String(right?.context ?? "")) || Number(left?.integration_id ?? 0) - Number(right?.integration_id ?? 0) || canonicalOrder(left, right));
      }
      if (rule?.type === "pull_request") for (const key of ["allowed_merge_methods", "required_reviewers"]) if (Array.isArray(rule.parameters?.[key])) rule.parameters[key].sort(canonicalOrder);
    }
    result.rules.sort((left, right) => String(left?.type ?? "").localeCompare(String(right?.type ?? "")) || canonicalOrder(left, right));
  }
  if (Array.isArray(result.bypass_actors)) result.bypass_actors.sort(canonicalOrder);
  return result;
}

function changedPaths(expected, live, path = "$", found = []) {
  if (found.length >= 20) return found;
  if (digestJson(expected) === digestJson(live)) return found;
  if (!expected || !live || typeof expected !== "object" || typeof live !== "object" || Array.isArray(expected) !== Array.isArray(live)) {
    found.push(path);
    return found;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== live.length) found.push(`${path}.length`);
    for (let index = 0; index < Math.min(expected.length, live.length); index++) changedPaths(expected[index], live[index], `${path}[${index}]`, found);
    return found;
  }
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(live)])].sort()) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(live, key)) found.push(`${path}.${key}`);
    else changedPaths(expected[key], live[key], `${path}.${key}`, found);
    if (found.length >= 20) break;
  }
  return found;
}

export function deriveDeterministicArtifacts(name, snapshot) {
  const resources = snapshot?.state?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object") payloadFail("deterministic snapshot is invalid");
  if (name === "settings-auditor") {
    let expected;
    try { expected = JSON.parse(resources["trusted:.github/rulesets/main.json"]?.data); } catch { payloadFail("trusted ruleset is invalid"); }
    const live = resources.rulesets;
    if (!Array.isArray(live)) payloadFail("live rulesets are invalid");
    const actual = live.find(value => value?.name === expected?.name) ?? null;
    const wanted = canonicalRulesetComparison(expected);
    const observed = canonicalRulesetComparison(actual);
    const rulePaths = changedPaths(wanted, observed);
    const bypassVisibility = Array.isArray(wanted?.bypass_actors) && observed?.bypass_actors === null
      ? `\nVisibility limitation: expected bypass actors ${canonicalBytes(wanted.bypass_actors).toString("utf8")}; live bypass actors are unobservable because the App response omitted bypass_actors.`
      : "";
    const drifts = rulePaths.length === 0 ? [] : [{ title: `Ruleset drift: ${expected.name}`, body: `Wanted digest: ${digestJson(wanted)}\nLive digest: ${digestJson(observed)}\nChanged fields: ${rulePaths.join(", ")}${bypassVisibility}` }];
    if (resources.settings !== undefined) {
      const settingPaths = changedPaths(EXPECTED_REPOSITORY_SETTINGS, resources.settings);
      if (settingPaths.length > 0) drifts.push({ title: "Repository settings drift", body: `Changed fields: ${settingPaths.join(", ")}` });
    }
    return deepFreeze([{ drifts }]);
  }
  if (name === "label-sync") {
    const wanted = labelDefinitions(resources["trusted:.github/labels.yml"]?.data);
    if (!Array.isArray(resources.labels)) payloadFail("live labels are invalid");
    const byName = new Map();
    for (const label of resources.labels) {
      const value = {
        name: envelopeData(label?.name, "label name"),
        color: envelopeData(label?.color, "label color").toLowerCase(),
        description: envelopeData(label?.description, "label description"),
      };
      if (byName.has(value.name)) payloadFail("live labels contain duplicates");
      byName.set(value.name, value);
    }
    const live = wanted.map(definition => byName.get(definition.name) ?? null);
    return deepFreeze([{ wantedDigest: digestJson(wanted), liveDigest: digestJson(live) }]);
  }
  if (name === "jam-detector") {
    if (!Array.isArray(resources.pulls)) payloadFail("live pulls are invalid");
    const requiredLabels = ["reviewed", "security-cleared"];
    const requiredChecks = ["check", "merge-gate"];
    const artifacts = [];
    for (const pull of resources.pulls) {
      if (pull?.state !== "open" || pull.merged !== false || !["behind", "blocked"].includes(pull.mergeState) || !requiredLabels.every(label => pull.labels?.includes(label))) continue;
      if (!requiredChecks.every(name => {
        const checks = pull.checks?.filter(check => check.name === name && check.headSha === pull.headSha) ?? [];
        return checks.length === 1 && checks[0].status === "completed" && checks[0].conclusion === "success";
      })) continue;
      if (!["correctness", "security"].every(kind => pull.evidence?.some(item => item.kind === kind && item.headSha === pull.headSha && item.conclusion === "approve"))) continue;
      artifacts.push({ entityId: String(pull.number), headSha: pull.headSha, stalled: true, reason: `Current-head checks and reviews passed, but merge state is ${pull.mergeState}.` });
    }
    return deepFreeze(artifacts);
  }
  payloadFail("deterministic role is unsupported");
}

export function reduceDeterministicArtifact(name, payload) {
  const policy = deterministicRole(name);
  let operations;
  if (name === "settings-auditor") {
    payloadObject(payload, ["drifts"]);
    payloadArray(payload.drifts, "drifts", 50);
    operations = payload.drifts.map(drift => {
      payloadObject(drift, ["title", "body"], "drift"); payloadText(drift.title, "drift title"); payloadText(drift.body, "drift body");
      return { type: "report_drift", title: drift.title, body: drift.body, marker: `smith:settings-drift/v1:${digestJson(drift)}` };
    });
  } else if (name === "jam-detector") {
    payloadObject(payload, ["entityId", "headSha", "stalled", "reason"]);
    payloadRestId(payload.entityId, "jam entity"); payloadText(payload.reason, "jam reason");
    if (!/^[0-9a-f]{40}$/.test(payload.headSha) || typeof payload.stalled !== "boolean") payloadFail("jam input is invalid");
    const marker = `<!-- smith:jam/v1 entity=${payload.entityId} head=${payload.headSha} status=open artifact=${digestJson(payload)} -->`;
    operations = payload.stalled ? [{ type: "comment", entityId: payload.entityId, body: payload.reason, marker }] : [];
  } else if (name === "label-sync") {
    payloadObject(payload, ["wantedDigest", "liveDigest"]);
    if (!/^[0-9a-f]{64}$/.test(payload.wantedDigest) || !/^[0-9a-f]{64}$/.test(payload.liveDigest)) payloadFail("label digests are invalid");
    operations = payload.wantedDigest === payload.liveDigest ? [] : [{ type: "sync_labels", definitionsDigest: payload.wantedDigest }];
  } else payloadFail("deterministic role is unsupported");
  if (operations.length === 0) operations = [{ type: "noop", reason: "unchanged" }];
  return deepFreeze(operations.map(operation => validateOperation(operation, policy)));
}

export function planAudit(snapshot) {
  const trustedSnapshot = validateSnapshot(snapshot);
  const authority = controlAuthority("auditor");
  if (trustedSnapshot.routing.role !== authority.name || trustedSnapshot.routing.mode !== "single" || trustedSnapshot.routing.primary !== null) payloadFail("snapshot audit authority is not canonical");
  const resources = trustedSnapshot.state?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object" || !Array.isArray(resources.rulesets) || !Array.isArray(resources.labels) || !Array.isArray(resources.pulls)) payloadFail("audit snapshot is incomplete");
  payloadObject(resources.settings, Object.keys(EXPECTED_REPOSITORY_SETTINGS), "repository settings");
  for (const value of Object.values(resources.settings)) if (typeof value !== "boolean") payloadFail("repository settings are invalid");

  const drift = [];
  for (const payload of deriveDeterministicArtifacts("settings-auditor", trustedSnapshot)) {
    for (const operation of reduceDeterministicArtifact("settings-auditor", payload)) if (operation.type !== "noop") drift.push(operation);
  }
  const sync = [];
  for (const payload of deriveDeterministicArtifacts("label-sync", trustedSnapshot)) {
    for (const operation of reduceDeterministicArtifact("label-sync", payload)) if (operation.type !== "noop") sync.push(operation);
  }
  const jams = [];
  for (const payload of deriveDeterministicArtifacts("jam-detector", trustedSnapshot)) {
    for (const operation of reduceDeterministicArtifact("jam-detector", payload)) if (operation.type !== "noop") jams.push(operation);
  }

  const checks = [];
  const merges = [];
  const repositoryName = `${trustedSnapshot.repository.owner}/${trustedSnapshot.repository.name}`;
  const pulls = [...resources.pulls].sort((left, right) => String(left?.number ?? left?.prId ?? "").localeCompare(String(right?.number ?? right?.prId ?? "")));
  for (const pull of pulls) {
    const prId = String(pull?.prId ?? pull?.number ?? "");
    if (!prId || pull?.state !== "open" || pull.merged !== false || pull.base !== trustedSnapshot.repository.defaultBranch || pull.headRepository !== repositoryName) continue;
    if (pull.draft === true || ["behind", "dirty"].includes(pull.mergeState)) {
      const mergeState = pull.draft === true ? "draft" : pull.mergeState;
      const finding = { prId, headSha: pull.headSha, mergeState };
      checks.push({ type: "publish_check", headSha: pull.headSha, name: "merge-gate", conclusion: "failure", summary: `merge_state_${mergeState}`, externalId: `merge-gate:${prId}:${pull.headSha}:${digestJson(finding)}` });
      continue;
    }
    const currentChecks = Array.isArray(pull.checks) ? pull.checks.filter(check => check?.headSha === pull.headSha && check.status === "completed" && ["success", "failure", "neutral"].includes(check.conclusion)).map(check => ({ name: check.name, headSha: check.headSha, conclusion: check.conclusion })) : [];
    const currentEvidence = Array.isArray(pull.evidence) ? pull.evidence.filter(item => item?.headSha === pull.headSha && typeof item.actorId === "string" && typeof item.provider === "string" && typeof item.authoritative === "boolean" && typeof item.artifactDigest === "string") : [];
    const gate = planMergeGate({
      prId,
      headSha: pull.headSha,
      labels: Array.isArray(pull.labels) ? pull.labels : [],
      checks: currentChecks,
      reviews: currentEvidence,
      riskMarker: pull.riskMarker ?? null,
      timeline: pull.timeline ?? [],
      trust: trustedSnapshot.state.trust,
      autoMergeAllowed: resources.settings.allowAutoMerge && resources.settings.allowSquashMerge && !resources.settings.allowMergeCommit && !resources.settings.allowRebaseMerge,
    });
    for (const operation of gate.operations) {
      if (operation.type !== "arm_auto_merge") checks.push(operation);
      else if (pull.autoMergeRequest === null || pull.autoMergeRequest === undefined) merges.push(operation);
    }
  }
  const ordered = [drift, sync, jams, checks, merges].flat().map(operation => validateOperation(operation, authority));
  if (ordered.length === 0) ordered.push(validateOperation({ type: "noop", reason: "unchanged" }, authority));
  return reduceControlArtifact({ name: authority.name, snapshot: trustedSnapshot, operations: ordered });
}

export function role(name) {
  const value = ROLES[name];
  if (!value) throw new AdwError("role", `unknown role: ${name}`);
  return value;
}

export const listRoles = () => Object.freeze(Object.keys(ROLES).sort());

export function controlAuthority(name) {
  const value = CONTROL_AUTHORITIES[name];
  if (!value) throw new AdwError("role", `unknown control authority: ${name}`);
  return value;
}

export function resolveAuthority(name) {
  try { return role(name); } catch {}
  try { return deterministicRole(name); } catch {}
  return controlAuthority(name);
}

export function reduceStatusArtifact({ snapshot, rolePolicy, reduction, assessments = [] }) {
  const trustedSnapshot = validateSnapshot(snapshot);
  const authority = role(rolePolicy?.name);
  if (digestJson(authority) !== digestJson(rolePolicy) || trustedSnapshot.routing.role !== authority.name || trustedSnapshot.routing.mode !== authority.mode || trustedSnapshot.routing.primary !== authority.primary || !reduction || !new Set(["fallback", "terminal"]).has(reduction.status) || typeof reduction.reason !== "string") payloadFail("status reduction authority is invalid");
  const status = reduction.status;
  const reason = new Set(["contract", "fallback_forbidden", "provider_unavailable", "providers_unavailable", "quorum_incomplete", "advisory_unavailable", "patch_conflict"]).has(reduction.reason) ? reduction.reason : status === "fallback" ? "provider_unavailable" : "providers_unavailable";
  const semantic = { role: authority.name, status, reason, snapshotDigest: digestJson(trustedSnapshot) };
  const marker = `smith:adw-status/v1:${digestJson(semantic)}`;
  const body = `ADW ${authority.name} ${status}: ${reason.replaceAll("_", " ")}.`;
  let operation;
  if (authority.operations.includes("publish_check") && /^[0-9a-f]{40}$/.test(trustedSnapshot.state?.headSha ?? "")) {
    operation = { type: "publish_check", headSha: trustedSnapshot.state.headSha, name: authority.name, conclusion: status === "fallback" ? "neutral" : "failure", summary: body, externalId: marker };
  } else if (authority.operations.includes("comment") && ISSUE_ENDPOINT_EVENTS.has(trustedSnapshot.event.kind) && /^[1-9][0-9]*$/.test(trustedSnapshot.state?.entityId ?? "") && Number.isSafeInteger(Number(trustedSnapshot.state.entityId))) {
    operation = { type: "comment", entityId: trustedSnapshot.state.entityId, body, marker };
  } else if (authority.operations.includes("create_issue")) {
    operation = { type: "create_issue", title: `ADW ${authority.name} ${status}`, body, labels: [], marker };
  } else {
    operation = { type: "terminal", reason };
  }
  const digests = [];
  for (const raw of assessments) {
    const value = validateAssessment(raw?.assessment ?? raw);
    if (value.controlSha !== trustedSnapshot.controlSha || value.snapshotDigest !== digestJson(trustedSnapshot) || value.role !== authority.name) payloadFail("status assessment binding is invalid");
    const digest = digestJson(value);
    if (!digests.includes(digest)) digests.push(digest);
  }
  if (digests.length > 2) payloadFail("status assessments are invalid");
  return validateDecision({
    schemaVersion: 1, controlSha: trustedSnapshot.controlSha, snapshotDigest: digestJson(trustedSnapshot),
    assessmentDigests: digests.sort(), kind: "state", operations: [validateOperation(operation, authority)], patch: null,
  });
}

export function reduceControlArtifact({ name, snapshot, operations }) {
  const authority = controlAuthority(name);
  const trustedSnapshot = validateSnapshot(snapshot);
  if (trustedSnapshot.routing.role !== authority.name || trustedSnapshot.routing.mode !== "single" || trustedSnapshot.routing.primary !== null) payloadFail("snapshot control authority is not canonical");
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) payloadFail("control operations are invalid");
  const seen = new Set();
  const validated = operations.map(operation => {
    const value = validateOperation(operation, authority);
    const key = digestJson(value);
    if (seen.has(key)) payloadFail("control operations contain duplicates");
    seen.add(key);
    return value;
  });
  return validateDecision({
    schemaVersion: 1,
    controlSha: trustedSnapshot.controlSha,
    snapshotDigest: digestJson(trustedSnapshot),
    assessmentDigests: [],
    kind: "state",
    operations: validated,
    patch: null,
  });
}

export function deterministicRole(name) {
  const value = DETERMINISTIC_ROLES[name];
  if (!value) throw new AdwError("role", `unknown deterministic role: ${name}`);
  return value;
}

export const listDeterministicRoles = () => Object.freeze(Object.keys(DETERMINISTIC_ROLES).sort());
