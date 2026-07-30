import {
  AdwError, canonicalBytes, digestJson, holdReasons, reduceAssessments, validateAssessment,
  validateDecision, validateOperation, validatePatchManifest, validateSnapshot,
} from "./core.mjs";

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

const BASE_ROLES = deepFreeze({
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
  if (state.entityId !== snapshot.event.entityId) payloadFail("snapshot entity does not match event");
  const marker = operationMarker(reduction.selected[0]);
  if (assessment.patch && !snapshot.revisions.some(revision => revision.token === assessment.patch.baseSha)) payloadFail("patch base is not a snapshot revision");
  let kind = assessment.patch ? "patch" : "state";
  let operations = [];
  if (payload.verdict === "noop") {
    operations = [{ type: "noop", reason: "not_applicable" }];
  } else if (holdReasons(state.labels ?? []).length > 0) {
    kind = "terminal";
    operations = [{ type: "terminal", reason: "held" }];
  } else if (rolePolicy.payloadFamily === "steering") {
    if (state.ownerAuthenticated !== true) payloadFail("steering actor is not owner-authenticated");
    operations = [{ type: "comment", entityId: state.entityId, body: payload.body, marker }];
  } else if (rolePolicy.payloadFamily === "triage") {
    const required = { accept: "ready", needs_info: "needs:info", needs_spec: "needs:spec" }[payload.verdict];
    operations = [
      { type: "comment", entityId: state.entityId, body: payload.body, marker },
      ...[...new Set([...payload.labels, required])].map(label => ({ type: "add_label", entityId: state.entityId, label })),
    ];
  } else if (rolePolicy.payloadFamily === "plan" || rolePolicy.payloadFamily === "survey") {
    operations = payload.issues.map(issue => ({ type: "create_issue", ...issue, marker }));
    if (payload.verdict === "blocked") operations.push({ type: "add_label", entityId: state.entityId, label: "blocked" });
    operations.push({ type: "comment", entityId: state.entityId, body: payload.summary, marker });
  } else if (rolePolicy.payloadFamily === "change") {
    if (payload.verdict === "blocked") {
      kind = "state";
      operations = [{ type: "comment", entityId: state.entityId, body: payload.reason, marker }, { type: "add_label", entityId: state.entityId, label: "blocked" }];
    } else if (rolePolicy.name === "reviser") {
      operations = [{ type: "update_pr", prId: state.entityId, body: payload.summary }];
    } else {
      for (const key of ["headBranch", "baseBranch", "title", "body"]) payloadText(state[key], `snapshot ${key}`);
      operations = [{ type: "create_pr", head: state.headBranch, base: state.baseBranch, title: state.title, body: state.body, marker }];
    }
  } else if (rolePolicy.payloadFamily === "pioneer") {
    if (payload.verdict === "proved") {
      if (state.closingArtifactQualifies === true) operations = [{ type: "close_issue", issueId: state.entityId, reason: "completed" }];
      else if (assessment.patch) {
        for (const key of ["headBranch", "baseBranch", "title", "body"]) payloadText(state[key], `snapshot ${key}`);
        operations = [{ type: "create_pr", head: state.headBranch, base: state.baseBranch, title: state.title, body: state.body, marker }];
      } else payloadFail("proof lacks a qualifying artifact");
    } else if (payload.verdict === "disproved") {
      operations = [{ type: "add_label", entityId: state.entityId, label: "needs:spec" }, { type: "comment", entityId: state.entityId, body: payload.summary, marker }];
    } else operations = [{ type: "comment", entityId: state.entityId, body: payload.summary, marker }];
  } else if (rolePolicy.payloadFamily === "review") {
    if (!snapshot.revisions.some(revision => revision.token === state.headSha)) payloadFail("review head is not a snapshot revision");
    const security = rolePolicy.name === "security-reviewer";
    const approval = security ? "security-cleared" : "reviewed";
    const rejected = payload.verdict === "reject" || payload.risk === "high";
    operations = [
      { type: "publish_check", headSha: state.headSha, name: rolePolicy.name, conclusion: rejected ? "failure" : "success", summary: rejected ? "rejected" : "approved", externalId: reduction.selected[0] },
      rejected ? { type: "add_label", entityId: state.entityId, label: "changes-requested" } : { type: "add_label", entityId: state.entityId, label: approval },
    ];
    if (payload.risk === "high") operations.push({ type: "add_label", entityId: state.entityId, label: "risk:high" });
    if (rejected) operations.push({ type: "remove_label", entityId: state.entityId, label: approval });
    else operations.push({ type: "remove_label", entityId: state.entityId, label: "changes-requested" });
  } else if (rolePolicy.payloadFamily === "maintenance") {
    if (!Array.isArray(state.actionTargets) || payload.actions.some(action => !state.actionTargets.includes(action.entityId))) payloadFail("maintenance target is outside snapshot");
    operations = payload.actions.map(action => action.kind === "retry"
      ? { type: "rerun_check", runId: action.entityId }
      : action.kind === "hold"
        ? { type: "add_label", entityId: action.entityId, label: "hold" }
        : { type: "create_issue", title: action.reason, body: payload.summary, labels: ["adw:drift"], marker });
  } else if (rolePolicy.payloadFamily === "dependency") {
    operations = [{ type: "comment", entityId: state.entityId, body: payload.summary, marker }];
    if (payload.verdict === "risky") operations.push({ type: "add_label", entityId: state.entityId, label: "needs:spec" });
  } else if (rolePolicy.payloadFamily === "alert") {
    operations = payload.verdict === "issue"
      ? [{ type: "create_issue", ...payload.issue, marker }]
      : [{ type: "comment", entityId: state.entityId, body: payload.summary, marker }];
  } else payloadFail("role payload family cannot be reduced");
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
