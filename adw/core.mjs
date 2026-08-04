import { createHash } from "node:crypto";

export class AdwError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdwError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new AdwError("contract", "sparse arrays are forbidden");
    return value.map(canonical);
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])]),
    );
  }
  throw new AdwError("contract", "value is outside the canonical JSON domain");
}

export const canonicalBytes = value => Buffer.from(JSON.stringify(canonical(value)));
export const digestBytes = bytes => createHash("sha256").update(bytes).digest("hex");
export const digestJson = value => digestBytes(canonicalBytes(value));

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EVENT_KINDS = new Set([
  "issue", "issue_comment", "pull_request", "pull_request_review",
  "pull_request_review_comment", "check", "workflow", "push", "schedule",
  "alert", "dispatch",
]);
const PROVIDERS = new Set(["claude", "codex"]);
const REST_ID = /^[1-9][0-9]*$/;

export const REPOSITORY_DISPATCH_WORKFLOWS = Object.freeze({
  retry_route: "adw-issues.yml",
  fallback_route: "adw-issues.yml",
  retry_pioneer: "adw-issues.yml",
  run_review: "adw-pulls.yml",
  run_obligation: "adw-operations.yml",
});
const REPOSITORY_DISPATCH_TYPES = new Set(Object.keys(REPOSITORY_DISPATCH_WORKFLOWS));
const ROUTE_PROVIDER_ROLES = Object.freeze({ claude: "builder", codex: "codex-builder" });
export const MERGE_OBLIGATION_PROVIDERS = Object.freeze({ "docs-writer": "codex" });
const OPERATIONAL_WORKFLOW_EVENTS = Object.freeze({
  ".github/workflows/adw-issues.yml": Object.freeze(["issue_comment", "issues"]),
  ".github/workflows/adw-operations.yml": Object.freeze(["push", "schedule", "workflow_dispatch"]),
  ".github/workflows/adw-pulls.yml": Object.freeze(["check_run", "check_suite", "pull_request_review", "pull_request_review_comment", "pull_request_target"]),
});
const OPERATIONAL_WORKFLOW_PATHS = new Set(Object.keys(OPERATIONAL_WORKFLOW_EVENTS));
const RETRYABLE_RUN_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "stale", "startup_failure", "timed_out"]);
const RERUNNABLE_JOB_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "stale", "startup_failure", "timed_out"]);

function fail(message) {
  throw new AdwError("contract", message);
}

function object(value, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${name} must be an object`);
  }
  return value;
}

function exact(value, keys, name) {
  object(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    fail(`${name} has invalid fields`);
  }
}

function string(value, name, max = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${name} must be a nonempty string`);
  return value;
}

function oneOf(value, values, name) {
  if (!values.has(value)) fail(`${name} is invalid`);
  return value;
}

function sha(value, name) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${name} must be a SHA`);
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${name} must be a digest`);
  return value;
}

function restId(value, name) {
  if (typeof value !== "string" || !REST_ID.test(value) || !Number.isSafeInteger(Number(value))) fail(`${name} must be a REST ID`);
  return value;
}

function array(value, name, max = 100) {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be an array`);
  return value;
}

function canonicalObject(value, name) {
  object(value, name);
  canonicalBytes(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function copy(value) {
  canonicalBytes(value);
  return deepFreeze(structuredClone(value));
}

export function validateRepositoryDispatchPayload(eventType, value, includeOperationDigest = false) {
  oneOf(eventType, REPOSITORY_DISPATCH_TYPES, "repository dispatch event type");
  if (typeof includeOperationDigest !== "boolean") fail("repository dispatch digest mode is invalid");
  const digestField = includeOperationDigest ? ["smith_operation_digest"] : [];
  if (eventType === "retry_route" || eventType === "fallback_route" || eventType === "retry_pioneer") {
    exact(value, ["repositoryId", "issueId", "sourceRevision", "role", "provider", ...digestField], "repository dispatch payload");
    string(value.repositoryId, "repository dispatch repository");
    restId(value.issueId, "repository dispatch issue");
    digest(value.sourceRevision, "repository dispatch source revision");
    oneOf(value.provider, PROVIDERS, "repository dispatch provider");
    if (eventType === "retry_pioneer") {
      if (value.role !== "pioneer" || value.provider !== "claude") fail("repository dispatch role/provider authority is invalid");
    } else if (ROUTE_PROVIDER_ROLES[value.provider] !== value.role) {
      fail("repository dispatch role/provider authority is invalid");
    }
  } else if (eventType === "run_review") {
    exact(value, ["repositoryId", "prId", "headSha", "role", "provider", ...digestField], "repository dispatch payload");
    string(value.repositoryId, "repository dispatch repository");
    restId(value.prId, "repository dispatch pull");
    sha(value.headSha, "repository dispatch head");
    oneOf(value.role, new Set(["reviewer", "security-reviewer"]), "repository dispatch review role");
    if (value.provider !== "claude") fail("repository dispatch role/provider authority is invalid");
  } else {
    exact(value, ["repositoryId", "prId", "mergeSha", "role", "provider", ...digestField], "repository dispatch payload");
    string(value.repositoryId, "repository dispatch repository");
    restId(value.prId, "repository dispatch pull");
    sha(value.mergeSha, "repository dispatch merge SHA");
    if (MERGE_OBLIGATION_PROVIDERS[value.role] !== value.provider) fail("repository dispatch role/provider authority is invalid");
  }
  if (includeOperationDigest) digest(value.smith_operation_digest, "repository dispatch operation digest");
  return copy(value);
}

function patchMetadata(value, name) {
  exact(value, ["baseSha", "digest", "size", "files"], name);
  sha(value.baseSha, `${name}.baseSha`);
  digest(value.digest, `${name}.digest`);
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > 1_048_576) fail(`${name}.size is invalid`);
  array(value.files, `${name}.files`);
  const paths = new Set();
  for (const [i, file] of value.files.entries()) {
    exact(file, ["path", "kind", "oldMode", "newMode"], `${name}.files[${i}]`);
    string(file.path, `${name}.files[${i}].path`);
    oneOf(file.kind, new Set(["regular", "binary", "symlink", "submodule", "device"]), `${name}.files[${i}].kind`);
    oneOf(file.oldMode, new Set(["absent", "100644", "100755"]), `${name}.files[${i}].oldMode`);
    oneOf(file.newMode, new Set(["absent", "100644", "100755"]), `${name}.files[${i}].newMode`);
    if (paths.has(file.path)) fail(`${name} contains duplicate paths`);
    paths.add(file.path);
  }
}

export function validateSnapshot(value) {
  exact(value, ["schemaVersion", "controlSha", "event", "repository", "revisions", "routing", "state"], "snapshot");
  if (value.schemaVersion !== 1) fail("snapshot schema version is invalid");
  sha(value.controlSha, "snapshot.controlSha");
  exact(value.event, ["kind", "action", "entityId"], "snapshot.event");
  oneOf(value.event.kind, EVENT_KINDS, "snapshot.event.kind");
  string(value.event.action, "snapshot.event.action");
  string(value.event.entityId, "snapshot.event.entityId");
  exact(value.repository, ["id", "owner", "name", "defaultBranch"], "snapshot.repository");
  for (const key of ["id", "owner", "name", "defaultBranch"]) string(value.repository[key], `snapshot.repository.${key}`);
  array(value.revisions, "snapshot.revisions");
  for (const [i, revision] of value.revisions.entries()) {
    exact(revision, ["resource", "kind", "token"], `snapshot.revisions[${i}]`);
    for (const key of ["resource", "kind", "token"]) string(revision[key], `snapshot.revisions[${i}].${key}`);
  }
  exact(value.routing, ["role", "mode", "primary"], "snapshot.routing");
  string(value.routing.role, "snapshot.routing.role");
  oneOf(value.routing.mode, new Set(["single", "quorum", "advisory"]), "snapshot.routing.mode");
  if (value.routing.primary !== null) oneOf(value.routing.primary, PROVIDERS, "snapshot.routing.primary");
  canonicalObject(value.state, "snapshot.state");
  if (canonicalBytes(value).length > 262_144) fail("snapshot is oversized");
  return copy(value);
}

export function validateAssessment(value) {
  exact(value, [
    "schemaVersion", "controlSha", "role", "provider", "model", "idempotencyKey",
    "snapshotDigest", "cliVersion", "run", "outcome", "payload", "payloadDigest",
    "patch", "startedAt", "completedAt",
  ], "assessment");
  if (value.schemaVersion !== 1) fail("assessment schema version is invalid");
  sha(value.controlSha, "assessment.controlSha");
  for (const key of ["role", "model", "idempotencyKey", "cliVersion", "startedAt", "completedAt"]) string(value[key], `assessment.${key}`);
  oneOf(value.provider, PROVIDERS, "assessment.provider");
  digest(value.snapshotDigest, "assessment.snapshotDigest");
  digest(value.payloadDigest, "assessment.payloadDigest");
  exact(value.run, ["id", "job", "attempt"], "assessment.run");
  string(value.run.id, "assessment.run.id");
  string(value.run.job, "assessment.run.job");
  if (!Number.isSafeInteger(value.run.attempt) || value.run.attempt < 1) fail("assessment.run.attempt is invalid");
  oneOf(value.outcome, new Set(["positive", "negative", "noop", "unable"]), "assessment.outcome");
  canonicalObject(value.payload, "assessment.payload");
  if (digestJson(value.payload) !== value.payloadDigest) fail("assessment payload digest does not match");
  if (value.patch !== null) patchMetadata(value.patch, "assessment.patch");
  if (canonicalBytes(value).length > 262_144) fail("assessment is oversized");
  return copy(value);
}

export function validateAssessmentArtifact({ assessment, patchBytes }) {
  const validated = validateAssessment(assessment);
  if (validated.patch === null) {
    if (patchBytes !== undefined && patchBytes !== null) fail("assessment has unexpected patch bytes");
    return validated;
  }
  if (!Buffer.isBuffer(patchBytes)) fail("assessment patch bytes are missing");
  if (patchBytes.length !== validated.patch.size || digestBytes(patchBytes) !== validated.patch.digest) {
    fail("assessment patch bytes do not match metadata");
  }
  return validated;
}

export function validateDecision(value) {
  exact(value, ["schemaVersion", "controlSha", "snapshotDigest", "assessmentDigests", "kind", "operations", "patch"], "decision");
  if (value.schemaVersion !== 1) fail("decision schema version is invalid");
  sha(value.controlSha, "decision.controlSha");
  digest(value.snapshotDigest, "decision.snapshotDigest");
  array(value.assessmentDigests, "decision.assessmentDigests", 2);
  const seen = new Set();
  for (const item of value.assessmentDigests) {
    digest(item, "decision.assessmentDigests[]");
    if (seen.has(item)) fail("decision assessment digests must be unique");
    seen.add(item);
  }
  oneOf(value.kind, new Set(["state", "patch", "terminal"]), "decision.kind");
  array(value.operations, "decision.operations");
  for (const operation of value.operations) validateOperationShape(operation);
  if (value.kind === "patch") patchMetadata(value.patch, "decision.patch");
  else if (value.patch !== null) fail("non-patch decision has patch metadata");
  if (canonicalBytes(value).length > 262_144) fail("decision is oversized");
  return copy(value);
}

export function qualifyAssessment({ snapshot, rolePolicy, provider, assessment, patchBytes }) {
  const input = snapshot.state.input ?? {};
  if (!input || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    return Object.freeze({ status: "terminal", reason: "contract" });
  }
  for (const flag of ["protected", "incomplete", "fork", "binary", "oversized"]) {
    if (Object.hasOwn(input, flag) && typeof input[flag] !== "boolean") {
      return Object.freeze({ status: "terminal", reason: "contract" });
    }
  }
  const fallbackProvider = rolePolicy.mode !== "quorum" && provider === rolePolicy.fallback;
  if (fallbackProvider) {
    for (const flag of ["protected", "incomplete", "fork", "binary", "oversized"]) {
      if (input[flag] === true && rolePolicy.fallbackAuthority[flag] !== true) {
        return Object.freeze({ status: "terminal", reason: "fallback_forbidden" });
      }
    }
  }
  if (assessment === null || assessment === undefined) return Object.freeze({ status: "fallback", reason: "missing_artifact" });
  let value;
  try {
    value = validateAssessmentArtifact({ assessment, patchBytes });
  } catch {
    return Object.freeze({ status: "fallback", reason: "malformed" });
  }
  if (
    value.controlSha !== snapshot.controlSha ||
    value.snapshotDigest !== digestJson(snapshot) ||
    value.role !== rolePolicy.name ||
    value.provider !== provider ||
    value.model !== rolePolicy.providerConfig[provider]?.model
  ) return Object.freeze({ status: "fallback", reason: "malformed" });
  if (!rolePolicy.payload.outcomes.includes(value.outcome)) return Object.freeze({ status: "fallback", reason: "malformed" });
  if (value.patch !== null) {
    try {
      validatePatchManifest(value.patch, rolePolicy);
    } catch {
      return Object.freeze({ status: "fallback", reason: "malformed" });
    }
  }
  if (value.outcome === "unable") return Object.freeze({ status: "fallback", reason: "unavailable" });
  if (rolePolicy.payload.requiredKeys.some(key => !Object.hasOwn(value.payload, key))) {
    return Object.freeze({ status: "fallback", reason: "missing_artifact" });
  }
  return deepFreeze({ status: "artifact", assessment: value });
}

function patchFrom(values) {
  const patches = values.map(value => value.patch).filter(Boolean);
  const metadata = new Set(patches.map(value => digestJson(value)));
  if (metadata.size > 1) return { conflict: true, patch: null };
  return { conflict: false, patch: patches[0] ?? null };
}

export function reduceAssessments({ snapshot, rolePolicy, assessments }) {
  validateSnapshot(snapshot);
  const byProvider = new Map();
  for (const entry of assessments) {
    const wrapped = entry?.assessment !== undefined;
    const assessment = wrapped ? entry.assessment : entry;
    const provider = assessment?.provider;
    if (!rolePolicy.providers.includes(provider) || byProvider.has(provider)) {
      return deepFreeze({ status: "terminal", reason: "contract" });
    }
    byProvider.set(provider, { assessment, patchBytes: wrapped ? entry.patchBytes : undefined });
  }
  const qualify = provider => {
    const artifact = byProvider.get(provider);
    return qualifyAssessment({
      snapshot,
      rolePolicy,
      provider,
      assessment: artifact?.assessment,
      patchBytes: artifact?.patchBytes,
    });
  };
  if (rolePolicy.mode === "single") {
    const primary = qualify(rolePolicy.primary);
    if (primary.status === "artifact") {
      return deepFreeze({ status: "artifact", authoritative: true, selected: [digestJson(primary.assessment)], patch: primary.assessment.patch });
    }
    if (primary.status === "terminal") return primary;
    if (!rolePolicy.fallback) return deepFreeze({ status: "terminal", reason: "provider_unavailable" });
    if (!byProvider.has(rolePolicy.fallback)) {
      return deepFreeze({ status: "fallback", provider: rolePolicy.fallback, reason: primary.reason });
    }
    const fallback = qualify(rolePolicy.fallback);
    if (fallback.status === "artifact") {
      return deepFreeze({ status: "artifact", authoritative: true, selected: [digestJson(fallback.assessment)], patch: fallback.assessment.patch });
    }
    if (fallback.status === "terminal") return fallback;
    return deepFreeze({ status: "terminal", reason: "providers_unavailable" });
  }
  if (rolePolicy.mode === "advisory") {
    for (const provider of [rolePolicy.primary, rolePolicy.fallback].filter(Boolean)) {
      const result = qualify(provider);
      if (result.status === "artifact") {
        return deepFreeze({ status: "artifact", authoritative: false, selected: [digestJson(result.assessment)], patch: result.assessment.patch });
      }
      if (result.status === "terminal") return result;
    }
    return deepFreeze({ status: "terminal", reason: "advisory_unavailable" });
  }
  const qualified = rolePolicy.providers.map(provider => [provider, qualify(provider)]);
  if (qualified.some(([, value]) => value.status !== "artifact")) {
    return deepFreeze({ status: "terminal", reason: "quorum_incomplete" });
  }
  const selected = qualified.map(([provider, value]) => ({ provider, assessment: value.assessment }));
  const patch = patchFrom(selected.map(value => value.assessment));
  if (patch.conflict) return deepFreeze({ status: "terminal", reason: "patch_conflict" });
  return deepFreeze({
    status: "artifact",
    authoritative: true,
    selected: selected.sort((a, b) => a.provider.localeCompare(b.provider)).map(value => digestJson(value.assessment)),
    patch: patch.patch,
  });
}

const HOLD_LABELS = new Set(["hold", "needs:owner", "needs:security", "risk:high", "blocked", "changes-requested", "needs:breakdown", "needs:info", "needs:spec", "needs:prototype"]);

export function holdReasons(labels) {
  array(labels, "labels");
  labels.forEach(label => string(label, "labels[]"));
  return Object.freeze([...new Set(labels.filter(label => HOLD_LABELS.has(label)))].sort());
}

function validateTrust(trust) {
  exact(trust, ["ownerIds", "appId"], "trust");
  array(trust.ownerIds, "trust.ownerIds");
  trust.ownerIds.forEach(id => string(id, "trust.ownerIds[]"));
  string(trust.appId, "trust.appId");
}

function validateEvidence(item) {
  exact(item, ["kind", "headSha", "conclusion", "actorId", "provider", "authoritative", "artifactDigest"], "review evidence");
  oneOf(item.kind, new Set(["correctness", "security"]), "review evidence kind");
  sha(item.headSha, "review evidence head");
  oneOf(item.conclusion, new Set(["approve", "reject"]), "review conclusion");
  string(item.actorId, "review actor");
  oneOf(item.provider, PROVIDERS, "review provider");
  if (typeof item.authoritative !== "boolean") fail("review authority must be boolean");
  digest(item.artifactDigest, "review artifact digest");
}

export function nextBuilderRoute(route, currentSourceRevision) {
  exact(route, ["sourceRevision", "headSha", "status", "primaryOutcome", "fallbackOutcome"], "builder route");
  string(route.sourceRevision, "builder route source");
  string(currentSourceRevision, "current source revision");
  sha(route.headSha, "builder route head");
  oneOf(route.status, new Set(["unarmed", "primary", "fallback", "complete", "blocked"]), "builder route status");
  for (const [name, value] of [["primary", route.primaryOutcome], ["fallback", route.fallbackOutcome]]) {
    if (value !== null) oneOf(value, new Set(["artifact", "provider_failure"]), `${name} outcome`);
  }
  if (route.sourceRevision !== currentSourceRevision) {
    return deepFreeze({ ...route, sourceRevision: currentSourceRevision, status: "unarmed", primaryOutcome: null, fallbackOutcome: null });
  }
  const validState =
    (route.status === "unarmed" && route.primaryOutcome === null && route.fallbackOutcome === null) ||
    (route.status === "primary" && route.fallbackOutcome === null) ||
    (route.status === "fallback" && route.primaryOutcome === "provider_failure") ||
    (route.status === "complete" && (route.primaryOutcome === "artifact" || (route.primaryOutcome === "provider_failure" && route.fallbackOutcome === "artifact"))) ||
    (route.status === "blocked" && route.primaryOutcome === "provider_failure" && route.fallbackOutcome === "provider_failure");
  if (!validState) fail("builder route state is inconsistent");
  if (route.status === "unarmed") return deepFreeze({ ...route, status: "primary" });
  if (route.status === "primary" && route.primaryOutcome === "artifact") return deepFreeze({ ...route, status: "complete" });
  if (route.status === "primary" && route.primaryOutcome === "provider_failure") return deepFreeze({ ...route, status: "fallback" });
  if (route.status === "fallback" && route.fallbackOutcome === "artifact") return deepFreeze({ ...route, status: "complete" });
  if (route.status === "fallback" && route.fallbackOutcome === "provider_failure") return deepFreeze({ ...route, status: "blocked" });
  return copy(route);
}

export function reduceReviews({ evidence, headSha, trust, protectedInput }) {
  array(evidence, "review evidence");
  sha(headSha, "review head");
  validateTrust(trust);
  if (typeof protectedInput !== "boolean") fail("protectedInput must be boolean");
  evidence.forEach(validateEvidence);
  const accepted = evidence.filter(item =>
    item.headSha === headSha &&
    item.actorId === trust.appId &&
    item.authoritative === true &&
    (!protectedInput || item.authoritative === true),
  );
  const result = {};
  const reasons = [];
  let conflict = false;
  for (const kind of ["correctness", "security"]) {
    const values = accepted.filter(item => item.kind === kind).map(item => item.conclusion);
    if (values.includes("reject")) {
      result[kind] = "reject";
      reasons.push(`${kind}_rejected`);
      conflict = true;
    } else if (values.includes("approve")) {
      result[kind] = "approve";
    } else {
      result[kind] = "missing";
      reasons.push(`${kind}_missing`);
    }
  }
  return deepFreeze({ correctness: result.correctness, security: result.security, conflict, reasons: reasons.sort() });
}

function validateTimeline(timeline) {
  array(timeline, "risk timeline");
  for (const item of timeline) {
    exact(item, ["id", "kind", "actorId", "createdAt", "label", "headSha"], "timeline event");
    for (const key of ["id", "kind", "actorId", "createdAt", "label"]) string(item[key], `timeline.${key}`);
    sha(item.headSha, "timeline head");
  }
}

export function reduceRisk({ marker, timeline, headSha, trust }) {
  exact(marker, ["headSha", "findingDigest", "status", "createdAt", "clearedAt"], "risk marker");
  sha(marker.headSha, "risk marker head");
  digest(marker.findingDigest, "risk finding digest");
  oneOf(marker.status, new Set(["open", "cleared"]), "risk marker status");
  string(marker.createdAt, "risk marker createdAt");
  if (marker.clearedAt !== null) string(marker.clearedAt, "risk marker clearedAt");
  validateTimeline(timeline);
  sha(headSha, "risk head");
  validateTrust(trust);
  if (marker.headSha !== headSha) return deepFreeze({ status: "open", marker: { ...marker, status: "open", clearedAt: null } });
  const event = timeline
    .filter(item =>
      item.kind === "label_removed" &&
      item.label === "risk:high" &&
      item.headSha === headSha &&
      trust.ownerIds.includes(item.actorId) &&
      item.createdAt > marker.createdAt,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!event) return deepFreeze({ status: "open", marker: { ...marker, status: "open", clearedAt: null } });
  return deepFreeze({ status: "cleared", marker: { ...marker, status: "cleared", clearedAt: event.createdAt } });
}

const REQUIRED_GATE_LABELS = Object.freeze(["reviewed", "security-cleared"]);

export function mergeEligibility(state) {
  exact(state, ["headSha", "labels", "checks", "reviews", "riskMarker", "timeline", "trust", "autoMergeAllowed"], "merge state");
  sha(state.headSha, "merge head");
  const reasons = [...holdReasons(state.labels)];
  for (const label of REQUIRED_GATE_LABELS) if (!state.labels.includes(label)) reasons.push(`${label}_missing`);
  array(state.checks, "merge checks");
  for (const item of state.checks) {
    exact(item, ["name", "headSha", "conclusion"], "merge check");
    string(item.name, "check name");
    sha(item.headSha, "check head");
    oneOf(item.conclusion, new Set(["success", "failure", "neutral"]), "check conclusion");
  }
  if (typeof state.autoMergeAllowed !== "boolean") fail("autoMergeAllowed must be boolean");
  validateTimeline(state.timeline);
  const checks = state.checks.filter(item => item.name === "check" && item.headSha === state.headSha);
  if (checks.length === 0) reasons.push("check_missing");
  else if (checks.some(item => item.conclusion !== "success")) reasons.push("check_failed");
  const reviews = reduceReviews({
    evidence: state.reviews,
    headSha: state.headSha,
    trust: state.trust,
    protectedInput: true,
  });
  reasons.push(...reviews.reasons);
  if (state.riskMarker !== null) {
    object(state.riskMarker, "risk marker");
    if (reduceRisk({ marker: state.riskMarker, timeline: state.timeline, headSha: state.headSha, trust: state.trust }).status !== "cleared") reasons.push("risk:high");
  }
  if (!state.autoMergeAllowed) reasons.push("auto_merge_forbidden");
  const unique = [...new Set(reasons)].sort();
  return deepFreeze({ eligible: unique.length === 0, reasons: unique });
}

export function planMergeGate({ prId, ...state }) {
  string(prId, "merge gate prId");
  const eligibility = mergeEligibility(state);
  const externalId = `merge-gate:${prId}:${state.headSha}:${digestJson(eligibility)}`;
  const operations = [{ type: "publish_check", headSha: state.headSha, name: "merge-gate", conclusion: eligibility.eligible ? "success" : "failure", summary: eligibility.eligible ? "eligible" : eligibility.reasons.join(","), externalId }];
  if (eligibility.eligible) operations.push({ type: "arm_auto_merge", prId, headSha: state.headSha, method: "squash" });
  operations.forEach(validateOperationShape);
  return deepFreeze({ eligibility, operations });
}

const OPERATION_FIELDS = Object.freeze({
  comment: { required: ["type", "entityId", "body", "marker"] },
  add_label: { required: ["type", "entityId", "label"] },
  remove_label: { required: ["type", "entityId", "label"] },
  create_issue: { required: ["type", "title", "body", "labels", "marker"] },
  update_issue: { required: ["type", "issueId"], optional: ["title", "body"] },
  close_issue: { required: ["type", "issueId", "reason"] },
  create_milestone: { required: ["type", "title", "description", "marker"], optional: ["dueOn"] },
  update_milestone: { required: ["type", "milestoneId"], optional: ["title", "description", "dueOn"] },
  close_milestone: { required: ["type", "milestoneId"] },
  assign_milestone: { required: ["type", "issueId", "milestoneId"] },
  link_sub_issue: { required: ["type", "parentId", "childId"] },
  create_branch: { required: ["type", "name", "baseSha", "treeSha"] },
  create_pr: { required: ["type", "head", "base", "title", "body", "marker"] },
  update_pr: { required: ["type", "prId"], optional: ["title", "body", "headSha"] },
  publish_check: { required: ["type", "headSha", "name", "conclusion", "summary", "externalId"] },
  rerun_check: { required: ["type", "runId", "attempt", "failedJobs"] },
  dispatch_repository: { required: ["type", "eventType", "clientPayload"] },
  arm_auto_merge: { required: ["type", "prId", "headSha", "method"] },
  sync_labels: { required: ["type", "definitionsDigest"] },
  report_drift: { required: ["type", "title", "body", "marker"] },
  noop: { required: ["type", "reason"] },
  terminal: { required: ["type", "reason"] },
});

function exactOptional(value, required, optional, name) {
  object(value, name);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${name}.${key} is required`);
  const allowed = new Set([...required, ...(optional ?? [])]);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(`${name} has invalid fields`);
}

const NOOP_REASONS = new Set(["already_complete", "not_applicable", "unchanged"]);
const TERMINAL_REASONS = new Set([
  "contract", "fallback_forbidden", "provider_unavailable", "providers_unavailable",
  "quorum_incomplete", "advisory_unavailable", "patch_conflict", "stale",
  "verification_failed", "held",
]);

function validateOperationShape(operation) {
  object(operation, "operation");
  const shape = OPERATION_FIELDS[operation.type];
  if (!shape) fail("operation type is not allowed");
  exactOptional(operation, shape.required, shape.optional, "operation");
  for (const [key, value] of Object.entries(operation)) {
    if (key === "type") continue;
    if (["labels"].includes(key)) {
      array(value, `operation.${key}`);
      value.forEach(item => string(item, `operation.${key}[]`));
    } else if (key === "failedJobs") {
      array(value, "operation.failedJobs", 100);
      if (value.length === 0) fail("operation.failedJobs is empty");
      const identities = new Set();
      let previous = 0;
      for (const job of value) {
        exact(job, ["id", "conclusion"], "operation failed job");
        restId(job.id, "operation failed job id");
        oneOf(job.conclusion, RERUNNABLE_JOB_CONCLUSIONS, "operation failed job conclusion");
        const id = Number(job.id);
        if (identities.has(job.id) || id <= previous) fail("operation.failedJobs is not canonical");
        identities.add(job.id);
        previous = id;
      }
    } else if (key === "clientPayload") {
      validateRepositoryDispatchPayload(operation.eventType, value);
    } else if (key === "attempt") {
      if (!Number.isSafeInteger(value) || value < 1) fail("operation.attempt is invalid");
    } else {
      string(value, `operation.${key}`);
    }
  }
  if (operation.type === "dispatch_repository") validateRepositoryDispatchPayload(operation.eventType, operation.clientPayload);
  for (const key of ["headSha", "baseSha", "treeSha"]) if (operation[key]) sha(operation[key], `operation.${key}`);
  if (operation.definitionsDigest) digest(operation.definitionsDigest, "operation.definitionsDigest");
  if (operation.method && operation.method !== "squash") fail("auto-merge method must be squash");
  if (operation.conclusion && !new Set(["success", "failure", "neutral"]).has(operation.conclusion)) fail("check conclusion is invalid");
  if (operation.type === "close_issue" && !new Set(["completed", "not_planned"]).has(operation.reason)) fail("close reason is invalid");
  if (operation.type === "noop" && !NOOP_REASONS.has(operation.reason)) fail("no-op reason is invalid");
  if (operation.type === "terminal" && !TERMINAL_REASONS.has(operation.reason)) fail("terminal reason is invalid");
  return copy(operation);
}

export function validateOperation(operation, rolePolicy) {
  if (!rolePolicy.operations.includes(operation?.type)) fail("operation type is not allowed by role");
  return validateOperationShape(operation);
}

export function idempotencyKey(kind, fields) {
  let semantic;
  if (kind === "issue_route") {
    semantic = { issueId: string(fields.issueId, "issueId"), route: string(fields.route, "route"), sourceRevision: string(fields.sourceRevision, "sourceRevision") };
  } else if (kind === "pr_review") {
    semantic = { prId: string(fields.prId, "prId"), headSha: sha(fields.headSha, "headSha"), reviewKind: string(fields.reviewKind, "reviewKind") };
  } else if (kind === "milestone") {
    semantic = { title: string(fields.title, "title"), specDigest: digest(fields.specDigest, "specDigest") };
  } else if (kind === "alert") {
    semantic = { alertId: string(fields.alertId, "alertId"), state: string(fields.state, "state") };
  } else {
    fail("idempotency key kind is invalid");
  }
  return `${kind}:${digestJson(semantic)}`;
}

const GLOBAL_DENIED_PATHS = [
  "docs/SPEC.md", "docs/PROJECT-INVARIANTS.md", ".github/CODEOWNERS",
  ".claude/settings.json", ".github/workflows/adw-issues.yml",
  ".github/workflows/adw-pulls.yml", ".github/workflows/adw-operations.yml",
];
const GLOBAL_DENIED_PREFIXES = [".agents/", ".claude/", ".github/", ".pi/", "adw/"];

function matchesRule(path, rule) {
  return rule.endsWith("/**") ? path.startsWith(rule.slice(0, -2)) : path === rule;
}

function safePatchPath(path) {
  if (path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.length > 0 && parts.every(part => part && part !== "." && part !== ".." && part !== ".git");
}

export function validatePatchManifest(manifest, rolePolicy) {
  if (!rolePolicy.patch) fail("role does not permit patches");
  patchMetadata(manifest, "patch");
  if (manifest.size > rolePolicy.patch.maxBytes || manifest.files.length > rolePolicy.patch.maxFiles) fail("patch exceeds role bounds");
  for (const file of manifest.files) {
    if (file.kind !== "regular") fail("patch contains unsupported file kind");
    if (!safePatchPath(file.path) || file.path === ".gitmodules") fail("patch path is unsafe");
    if (GLOBAL_DENIED_PATHS.includes(file.path) || GLOBAL_DENIED_PREFIXES.some(prefix => file.path.startsWith(prefix)) || ["AGENTS.md", "CLAUDE.md"].includes(file.path.split("/").at(-1))) fail("patch path is globally denied");
    if (rolePolicy.patch.deniedPaths.some(rule => matchesRule(file.path, rule))) fail("patch path is denied by role");
    if (!rolePolicy.patch.allowedPrefixes.some(prefix => prefix.endsWith("/") ? file.path.startsWith(prefix) : file.path === prefix)) fail("patch path is outside role prefixes");
  }
  return copy(manifest);
}

function canonicalInstant(value, name) {
  string(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) fail(`${name} must be a canonical UTC instant`);
  return value;
}

function numericRestCommentId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) fail("marker comment.id must be a REST ID");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail("marker comment.id must be a REST ID");
  return number;
}

function markerRecord(comment, kind, key, value) {
  numericRestCommentId(comment.id);
  return { kind, key, commentId: comment.id, createdAt: comment.createdAt, value };
}

const APPLY_MARKER = /^<!-- smith:apply\/v1 role=([a-z][a-z0-9-]*) decision=([0-9a-f]{64}) operation=(0|[1-9][0-9]*) digest=([0-9a-f]{64}) phase=complete -->$/;

function semanticMarkerBody(comment) {
  const lines = comment.body.split("\n");
  if (lines.length !== 2 || !lines[0].startsWith("<!-- smith:")) return { body: comment.body, pairedRole: null };
  const apply = APPLY_MARKER.exec(lines[1]);
  if (apply === null) return null;
  const operationDigest = digestJson({ type: "comment", entityId: comment.entityId, body: lines[0], marker: lines[0] });
  if (apply[4] !== operationDigest || !Number.isSafeInteger(Number(apply[3]))) return null;
  return { body: lines[0], pairedRole: apply[1] };
}

function latestMarkers(records) {
  const groups = new Map();
  for (const record of records) {
    const id = `${record.kind}:${record.key}`;
    const previous = groups.get(id);
    const commentNumber = numericRestCommentId(record.commentId);
    const previousNumber = previous === undefined ? null : numericRestCommentId(previous.commentId);
    if (!previous || record.createdAt > previous.createdAt || (record.createdAt === previous.createdAt && commentNumber > previousNumber)) groups.set(id, record);
    if (previous && record.createdAt === previous.createdAt && commentNumber === previousNumber && digestJson(record.value) !== digestJson(previous.value)) fail("marker conflict at equal authority order");
  }
  return [...groups.values()].sort((a, b) => canonicalBytes(a).compare(canonicalBytes(b)));
}

export function parseLegacyMarkers({ comments, trust }) {
  array(comments, "marker comments", 1000);
  validateTrust(trust);
  const records = [];
  for (const input of comments) {
    object(input, "marker comment");
    const enveloped = Object.hasOwn(input, "updatedAt");
    exact(input, enveloped ? ["id", "actorId", "createdAt", "updatedAt", "body", "repositoryId", "entityId"] : ["id", "actorId", "createdAt", "body", "repositoryId", "entityId"], "marker comment");
    let body;
    if (enveloped) {
      const projected = Object.hasOwn(input.body, "truncated");
      exact(input.body, projected ? ["trust", "source", "bytes", "digest", "truncated", "data"] : ["trust", "source", "bytes", "digest", "data"], "marker comment body");
      if (typeof input.body.data !== "string") fail("marker comment body is invalid");
      const dataBytes = canonicalBytes(input.body.data).length;
      const full = input.body.truncated === false;
      if (input.body.trust !== "untrusted" || !Number.isSafeInteger(input.body.bytes) || input.body.bytes < dataBytes || !DIGEST.test(input.body.digest)
          || (projected && typeof input.body.truncated !== "boolean") || (projected && full && (input.body.bytes !== dataBytes || input.body.digest !== digestJson(input.body.data)))
          || (projected && input.body.truncated && input.body.bytes <= dataBytes) || (!projected && (input.body.bytes !== dataBytes || input.body.digest !== digestJson(input.body.data)))) fail("marker comment body is invalid");
      body = input.body.data;
      canonicalInstant(input.updatedAt, "marker comment.updatedAt");
    } else body = input.body;
    const comment = { ...input, body };
    delete comment.updatedAt;
    for (const key of ["id", "actorId", "body", "repositoryId", "entityId"]) string(comment[key], `marker comment.${key}`, key === "body" ? 65_536 : 4096);
    canonicalInstant(comment.createdAt, "marker comment.createdAt");
    if (comment.actorId !== trust.appId) continue;
    const semantic = semanticMarkerBody(comment);
    if (semantic === null) continue;
    let match;
    if ((match = /^<!-- smith:claude-attempt\/v1 issue=([1-9][0-9]*) branch=claude\/issue-\1 head=([0-9a-f]{40}) outcome=(success|failure|cancelled|skipped) -->$/.exec(semantic.body))) {
      records.push(markerRecord(comment, "attempt", match[1], { issueId: match[1], branch: `claude/issue-${match[1]}`, headSha: match[2], outcome: match[3] }));
    } else if ((match = /^<!-- smith:builder-route\/v1 issue=([1-9][0-9]*) id=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) source=claude\/issue-\1 target=codex\/issue-\1 phase=(prepared|armed|completed|cancelled) -->$/.exec(semantic.body))) {
      records.push(markerRecord(comment, "route", match[1], { issueId: match[1], routeId: match[2], source: `claude/issue-${match[1]}`, target: `codex/issue-${match[1]}`, phase: match[3] }));
    } else if ((match = /^(Review|Security review): ([0-9a-f]{40})\nVERDICT: (reviewed|changes-requested|security-cleared|risk-high)(?:\n|$)/.exec(semantic.body))) {
      const kind = match[1] === "Review" ? "correctness" : "security";
      const allowed = kind === "correctness" ? new Set(["reviewed", "changes-requested"]) : new Set(["security-cleared", "risk-high"]);
      if (allowed.has(match[3])) records.push(markerRecord(comment, "review", `${comment.repositoryId}:${comment.entityId}:${kind}:${match[2]}`, { repositoryId: comment.repositoryId, prId: comment.entityId, kind, headSha: match[2], conclusion: new Set(["reviewed", "security-cleared"]).has(match[3]) ? "approve" : "reject", actorId: trust.appId, provider: "claude", authoritative: true, artifactDigest: digestJson({ commentId: comment.id, body: comment.body }) }));
    } else if ((match = /^<!-- smith:review-evidence\/v1 kind=(correctness|security) head=([0-9a-f]{40}) conclusion=(approve|reject) provider=(claude|codex) authoritative=(true|false) artifact=([0-9a-f]{64}) -->$/.exec(semantic.body))) {
      records.push(markerRecord(comment, "review", `${comment.repositoryId}:${comment.entityId}:${match[1]}:${match[2]}`, { repositoryId: comment.repositoryId, prId: comment.entityId, kind: match[1], headSha: match[2], conclusion: match[3], actorId: trust.appId, provider: match[4], authoritative: match[5] === "true", artifactDigest: match[6] }));
    } else if ((match = /^<!-- smith:risk\/v1 head=([0-9a-f]{40}) finding=([0-9a-f]{64}) status=(open|cleared) created=([^ ]+) cleared=([^ ]+) -->$/.exec(semantic.body))) {
      if ((match[3] === "open" && match[5] !== "-") || (match[3] === "cleared" && match[5] === "-")) continue;
      try { canonicalInstant(match[4], "risk createdAt"); if (match[5] !== "-") canonicalInstant(match[5], "risk clearedAt"); } catch { continue; }
      records.push(markerRecord(comment, "risk", match[1], { headSha: match[1], findingDigest: match[2], status: match[3], createdAt: match[4], clearedAt: match[5] === "-" ? null : match[5] }));
    } else if ((match = /^<!-- smith:jam\/v1 entity=([^ ]+) head=([0-9a-f]{40}) status=(open|cleared) artifact=([0-9a-f]{64}) -->$/.exec(semantic.body))) {
      records.push(markerRecord(comment, "jam", `${match[1]}:${match[2]}`, { entityId: match[1], headSha: match[2], status: match[3], artifactDigest: match[4] }));
    } else if ((match = /^<!-- smith:merge-finalized\/v1 pr=([1-9][0-9]*) merge=([0-9a-f]{40}) role=([a-z][a-z0-9-]*) status=(complete|failed) artifact=([0-9a-f]{64}|-) -->$/.exec(semantic.body))) {
      if ((match[4] === "complete") !== (match[5] !== "-") || (semantic.pairedRole !== null && semantic.pairedRole !== match[3])) continue;
      records.push(markerRecord(comment, "finalization", `${comment.repositoryId}:${match[1]}:${match[3]}`, { repositoryId: comment.repositoryId, prId: match[1], mergeSha: match[2], role: match[3], status: match[4], artifactDigest: match[5] === "-" ? null : match[5] }));
    }
  }
  return deepFreeze(latestMarkers(records));
}

export function planReconciliation(request) {
  exactOptional(request, ["snapshot", "routes", "pulls", "labelSync", "comments", "trust", "reviews", "pioneers", "holds"], ["cancelledApplies"], "reconciliation");
  const { snapshot, routes, pulls, labelSync, comments, trust, reviews, pioneers, holds, cancelledApplies = [] } = request;
  const markers = parseLegacyMarkers({ comments, trust });
  validateSnapshot(snapshot);
  array(routes, "routes");
  array(pulls, "pulls");
  array(reviews, "reconciliation reviews");
  array(pioneers, "reconciliation pioneers");
  array(holds, "reconciliation holds");
  array(cancelledApplies, "cancelled applies", 20);
  const cancelledRunIds = new Set();
  for (const cancelled of cancelledApplies) {
    exact(cancelled, ["runId", "workflowPath", "event", "entityId", "headSha", "controlSha", "attempt", "runConclusion", "applyJobId", "failedJobs"], "cancelled apply");
    restId(cancelled.runId, "cancelled apply run"); restId(cancelled.applyJobId, "cancelled apply job");
    string(cancelled.workflowPath, "cancelled apply workflow");
    if (!OPERATIONAL_WORKFLOW_PATHS.has(cancelled.workflowPath)) fail("cancelled apply workflow is invalid");
    string(cancelled.event, "cancelled apply event"); string(cancelled.entityId, "cancelled apply entity");
    if (!OPERATIONAL_WORKFLOW_EVENTS[cancelled.workflowPath].includes(cancelled.event)) fail("cancelled apply event is invalid");
    sha(cancelled.headSha, "cancelled apply head"); sha(cancelled.controlSha, "cancelled apply control");
    if (cancelled.controlSha !== snapshot.controlSha || !RETRYABLE_RUN_CONCLUSIONS.has(cancelled.runConclusion)) fail("cancelled apply control or conclusion is invalid");
    if (!Number.isSafeInteger(cancelled.attempt) || cancelled.attempt < 1) fail("cancelled apply attempt is invalid");
    if (cancelledRunIds.has(cancelled.runId)) fail("duplicate cancelled apply");
    cancelledRunIds.add(cancelled.runId);
    const run = snapshot.state?.resources?.runs?.find(candidate => candidate?.id === cancelled.runId);
    const expectedTitle = cancelled.workflowPath.endsWith("adw-issues.yml") ? `ADW issue #${cancelled.entityId}` : cancelled.workflowPath.endsWith("adw-pulls.yml") ? `ADW pull #${cancelled.entityId}` : null;
    validateOperationShape({ type: "rerun_check", runId: cancelled.runId, attempt: cancelled.attempt, failedJobs: cancelled.failedJobs });
    if (!run || run.workflowPath !== cancelled.workflowPath || run.event !== cancelled.event || run.entityId !== cancelled.entityId || (expectedTitle !== null && run.displayTitle !== expectedTitle) || (cancelled.workflowPath.endsWith("adw-operations.yml") && cancelled.entityId !== snapshot.repository.id) || run.headSha !== cancelled.headSha || run.controlSha !== cancelled.controlSha || run.applyJobId !== cancelled.applyJobId || digestJson(run.failedJobs) !== digestJson(cancelled.failedJobs) || run.attempt !== cancelled.attempt || run.status !== "completed" || run.conclusion !== cancelled.runConclusion) fail("cancelled apply is not snapshot-bound");
  }
  const currentRevisions = snapshot.state.currentRevisions;
  if (!currentRevisions || Array.isArray(currentRevisions) || Object.getPrototypeOf(currentRevisions) !== Object.prototype) fail("snapshot current revisions are required");
  const intents = [];
  const held = new Map();
  for (const hold of holds) {
    exact(hold, ["entityId", "reasons"], "reconciliation hold");
    string(hold.entityId, "hold.entityId");
    if (held.has(hold.entityId)) fail("duplicate reconciliation hold");
    const reasons = holdReasons(hold.reasons);
    if (reasons.length === 0) fail("reconciliation hold has no reason");
    held.set(hold.entityId, reasons);
    intents.push({ kind: "held", entityId: hold.entityId, reasons });
  }
  if (!held.has("repository")) for (const cancelled of cancelledApplies) intents.push({ kind: "retry_cancelled_apply", ...cancelled });
  const routeIds = new Set();
  for (const route of routes) {
    exact(route, ["issueId", "sourceRevision", "status", "primary", "fallback", "primaryOutcome", "fallbackOutcome", "artifactDigest", "prId"], "route");
    string(route.issueId, "route.issueId");
    if (routeIds.has(route.issueId)) fail("duplicate route issue");
    routeIds.add(route.issueId);
    string(route.sourceRevision, "route.sourceRevision");
    oneOf(route.status, new Set(["unarmed", "primary", "fallback", "complete", "blocked"]), "route.status");
    oneOf(route.primary, PROVIDERS, "route.primary");
    if (route.fallback !== null) oneOf(route.fallback, PROVIDERS, "route.fallback");
    for (const [name, outcome] of [["primary", route.primaryOutcome], ["fallback", route.fallbackOutcome]]) if (outcome !== null) oneOf(outcome, new Set(["artifact", "provider_failure"]), `route.${name}Outcome`);
    if (route.artifactDigest !== null) digest(route.artifactDigest, "route.artifactDigest");
    if (route.prId !== null) string(route.prId, "route.prId");
    const routeValid =
      (route.status === "unarmed" && route.primaryOutcome === null && route.fallbackOutcome === null && route.artifactDigest === null && route.prId === null) ||
      (route.status === "primary" && route.fallbackOutcome === null && route.artifactDigest === null && route.prId === null && (route.primaryOutcome !== "provider_failure" || route.fallback !== null)) ||
      (route.status === "fallback" && route.fallback !== null && route.primaryOutcome === "provider_failure" && route.artifactDigest === null && route.prId === null) ||
      (route.status === "blocked" && route.fallback !== null && route.primaryOutcome === "provider_failure" && route.fallbackOutcome === "provider_failure" && route.artifactDigest === null && route.prId === null) ||
      (route.status === "complete" && route.artifactDigest !== null && route.prId !== null && (route.primaryOutcome === "artifact" || (route.primaryOutcome === "provider_failure" && route.fallbackOutcome === "artifact")));
    if (!routeValid) fail("route state is inconsistent");
    if (route.status === "complete") {
      const qualifying = pulls.find(pull => pull.prId === route.prId);
      if (!qualifying || qualifying.repositoryId !== snapshot.repository.id || qualifying.headRepositoryId !== snapshot.repository.id || qualifying.base !== snapshot.repository.defaultBranch || !Array.isArray(qualifying.closingIssues) || !qualifying.closingIssues.some(issue => issue.repositoryId === snapshot.repository.id && issue.issueId === route.issueId)) fail("completed route lacks qualifying pull request");
    }
    const current = currentRevisions[`issue:${route.issueId}`];
    string(current, "current revision");
    if (current !== route.sourceRevision && !held.has(`issue:${route.issueId}`) && !held.has("repository")) {
      intents.push({ kind: "retry_route", repositoryId: snapshot.repository.id, issueId: route.issueId, sourceRevision: current, role: ROUTE_PROVIDER_ROLES[route.primary], provider: route.primary });
    } else if (route.status === "primary" && route.primaryOutcome === "provider_failure" && !held.has(`issue:${route.issueId}`) && !held.has("repository")) {
      intents.push({ kind: "fallback_route", repositoryId: snapshot.repository.id, issueId: route.issueId, sourceRevision: current, role: ROUTE_PROVIDER_ROLES[route.fallback], provider: route.fallback });
    }
  }
  const pullIds = new Set();
  for (const pull of pulls) {
    exact(pull, ["prId", "repositoryId", "headRepositoryId", "base", "closingIssues", "headSha", "merged", "mergeSha", "obligations"], "pull");
    string(pull.prId, "pull.prId");
    if (pullIds.has(pull.prId)) fail("duplicate pull");
    pullIds.add(pull.prId);
    for (const key of ["repositoryId", "headRepositoryId", "base"]) string(pull[key], `pull.${key}`);
    if (pull.repositoryId !== snapshot.repository.id || pull.headRepositoryId !== snapshot.repository.id || pull.base !== snapshot.repository.defaultBranch) fail("pull is outside trusted repository route");
    array(pull.closingIssues, "pull.closingIssues");
    for (const issue of pull.closingIssues) { exact(issue, ["repositoryId", "issueId"], "closing issue"); string(issue.repositoryId, "closing issue.repositoryId"); string(issue.issueId, "closing issue.issueId"); }
    sha(pull.headSha, "pull.headSha");
    if (typeof pull.merged !== "boolean") fail("pull.merged must be boolean");
    if (pull.merged) sha(pull.mergeSha, "pull.mergeSha");
    else if (pull.mergeSha !== null) fail("unmerged pull has merge SHA");
    array(pull.obligations, "pull.obligations");
    if (!pull.merged) continue;
    const obligationRoles = new Set();
    for (const obligation of pull.obligations) {
      exact(obligation, ["role", "status", "artifactDigest", "expectedArtifactDigest"], "obligation");
      string(obligation.role, "obligation.role");
      const obligationProvider = MERGE_OBLIGATION_PROVIDERS[obligation.role];
      if (obligationProvider === undefined) fail("pull obligation role is unsupported");
      if (obligationRoles.has(obligation.role)) fail("duplicate pull obligation");
      obligationRoles.add(obligation.role);
      oneOf(obligation.status, new Set(["missing", "complete", "failed"]), "obligation.status");
      if (obligation.artifactDigest !== null) digest(obligation.artifactDigest, "obligation.artifactDigest");
      if (obligation.expectedArtifactDigest !== null) digest(obligation.expectedArtifactDigest, "obligation.expectedArtifactDigest");
      if (obligation.status === "complete" && (obligation.artifactDigest === null || (obligation.expectedArtifactDigest !== null && obligation.artifactDigest !== obligation.expectedArtifactDigest))) fail("completed obligation lacks expected artifact");
      if (obligation.status !== "complete" && obligation.artifactDigest !== null) fail("incomplete obligation has artifact");
      const imported = markers.some(marker => marker.kind === "finalization" && marker.value.repositoryId === snapshot.repository.id && marker.value.prId === pull.prId && marker.value.mergeSha === pull.mergeSha && marker.value.role === obligation.role && marker.value.status === "complete" && marker.value.artifactDigest !== null && (obligation.expectedArtifactDigest === null || marker.value.artifactDigest === obligation.expectedArtifactDigest));
      if ((obligation.status === "missing" || obligation.status === "failed") && !imported && !held.has(`pr:${pull.prId}`) && !held.has("repository")) intents.push({ kind: "run_obligation", repositoryId: snapshot.repository.id, prId: pull.prId, mergeSha: pull.mergeSha, role: obligation.role, provider: obligationProvider });
    }
  }
  for (const review of reviews) {
    exact(review, ["prId", "headSha", "evidence", "protectedInput"], "reconciliation review");
    string(review.prId, "review.prId"); sha(review.headSha, "review.headSha");
    array(review.evidence, "review.evidence");
    if (typeof review.protectedInput !== "boolean") fail("review.protectedInput must be boolean");
    const evidence = [...review.evidence, ...markers.filter(marker => marker.kind === "review" && marker.value.repositoryId === snapshot.repository.id && marker.value.prId === review.prId && marker.value.headSha === review.headSha).map(marker => ({ kind: marker.value.kind, headSha: marker.value.headSha, conclusion: marker.value.conclusion, actorId: marker.value.actorId, provider: marker.value.provider, authoritative: marker.value.authoritative, artifactDigest: marker.value.artifactDigest }))];
    const result = reduceReviews({ evidence, headSha: review.headSha, trust, protectedInput: review.protectedInput });
    if (!held.has(`pr:${review.prId}`) && !held.has("repository")) for (const reason of result.reasons.filter(reason => reason.endsWith("_missing"))) intents.push({ kind: "run_review", repositoryId: snapshot.repository.id, prId: review.prId, headSha: review.headSha, role: reason === "correctness_missing" ? "reviewer" : "security-reviewer", provider: "claude" });
  }
  const pioneerIds = new Set();
  for (const pioneer of pioneers) {
    exact(pioneer, ["issueId", "sourceRevision", "verdict", "artifactDigest", "closingPrId"], "reconciliation pioneer");
    string(pioneer.issueId, "pioneer.issueId"); string(pioneer.sourceRevision, "pioneer.sourceRevision");
    if (pioneerIds.has(pioneer.issueId)) fail("duplicate pioneer state");
    pioneerIds.add(pioneer.issueId);
    oneOf(pioneer.verdict, new Set(["missing", "proved", "disproved", "inconclusive"]), "pioneer.verdict");
    if (pioneer.artifactDigest !== null) digest(pioneer.artifactDigest, "pioneer.artifactDigest");
    if (pioneer.closingPrId !== null) string(pioneer.closingPrId, "pioneer.closingPrId");
    if ((pioneer.verdict === "proved" || pioneer.verdict === "disproved") !== (pioneer.artifactDigest !== null)) fail("pioneer artifact state is inconsistent");
    if (pioneer.verdict === "proved") {
      const qualifying = pulls.find(pull => pull.prId === pioneer.closingPrId);
      if (!qualifying || !qualifying.closingIssues.some(issue => issue.repositoryId === snapshot.repository.id && issue.issueId === pioneer.issueId)) fail("pioneer proof lacks qualifying closing pull request");
    } else if (pioneer.closingPrId !== null) fail("non-proof pioneer has closing pull request");
    const current = currentRevisions[`issue:${pioneer.issueId}`]; string(current, "pioneer current revision");
    if (current !== pioneer.sourceRevision && !held.has(`issue:${pioneer.issueId}`) && !held.has("repository")) intents.push({ kind: "retry_pioneer", repositoryId: snapshot.repository.id, issueId: pioneer.issueId, sourceRevision: current, role: "pioneer", provider: "claude" });
    else if (pioneer.verdict === "disproved" && !held.has(`issue:${pioneer.issueId}`) && !held.has("repository")) intents.push({ kind: "hold_spec", issueId: pioneer.issueId, artifactDigest: pioneer.artifactDigest });
    else if ((pioneer.verdict === "missing" || pioneer.verdict === "inconclusive") && !held.has(`issue:${pioneer.issueId}`) && !held.has("repository")) intents.push({ kind: "retry_pioneer", repositoryId: snapshot.repository.id, issueId: pioneer.issueId, sourceRevision: current, role: "pioneer", provider: "claude" });
  }
  exact(labelSync, ["wantedDigest", "liveDigest"], "labelSync");
  digest(labelSync.wantedDigest, "labelSync.wantedDigest");
  digest(labelSync.liveDigest, "labelSync.liveDigest");
  if (labelSync.wantedDigest !== labelSync.liveDigest && !held.has("repository")) intents.push({ kind: "sync_labels", definitionsDigest: labelSync.wantedDigest });
  const runs = snapshot.state?.resources?.runs ?? [];
  const recovered = intents.map(intent => {
    if (!REPOSITORY_DISPATCH_TYPES.has(intent.kind)) return intent;
    const { kind: eventType, ...clientPayload } = intent;
    const operationDigest = digestJson({ type: "dispatch_repository", eventType, clientPayload });
    const workflowPath = `.github/workflows/${REPOSITORY_DISPATCH_WORKFLOWS[eventType]}`;
    const matches = runs.filter(run => run?.workflowPath === workflowPath && run.event === "repository_dispatch" && run.displayTitle === operationDigest
      && run.actorId === trust.appId && run.actorType === "Bot" && run.headBranch === snapshot.repository.defaultBranch && run.headSha === snapshot.controlSha);
    if (matches.length > 1) fail("conflicting repository dispatch child runs");
    const failedRun = matches.find(run => run.status === "completed" && RETRYABLE_RUN_CONCLUSIONS.has(run.conclusion));
    if (failedRun === undefined) return intent;
    restId(failedRun.id, "failed dispatch run");
    if (!Number.isSafeInteger(failedRun.attempt) || failedRun.attempt < 1) fail("failed dispatch attempt is invalid");
    validateOperationShape({ type: "rerun_check", runId: failedRun.id, attempt: failedRun.attempt, failedJobs: failedRun.failedJobs });
    return { kind: "retry_failed_dispatch", runId: failedRun.id, workflowPath, headSha: failedRun.headSha, attempt: failedRun.attempt, failedJobs: failedRun.failedJobs, operationDigest, eventType, clientPayload };
  });
  const unique = new Map(recovered.map(intent => [digestJson(intent), intent]));
  return deepFreeze([...unique.values()].sort((a, b) => canonicalBytes(a).compare(canonicalBytes(b))));
}

function validateReconciliationIntent(intent) {
  object(intent, "reconciliation intent");
  if (intent.kind === "held") {
    exact(intent, ["kind", "entityId", "reasons"], "reconciliation intent");
    string(intent.entityId, "reconciliation intent entity");
    const reasons = holdReasons(intent.reasons);
    if (reasons.length === 0 || digestJson(reasons) !== digestJson(intent.reasons)) fail("reconciliation hold reasons are not canonical");
  } else if (REPOSITORY_DISPATCH_TYPES.has(intent.kind)) {
    const { kind, ...clientPayload } = intent;
    validateRepositoryDispatchPayload(kind, clientPayload);
  } else if (intent.kind === "retry_cancelled_apply") {
    exact(intent, ["kind", "runId", "workflowPath", "event", "entityId", "headSha", "controlSha", "attempt", "runConclusion", "applyJobId", "failedJobs"], "reconciliation intent");
    restId(intent.runId, "reconciliation run"); restId(intent.applyJobId, "reconciliation apply job");
    sha(intent.headSha, "reconciliation run head"); sha(intent.controlSha, "reconciliation control");
    string(intent.workflowPath, "reconciliation run workflow"); string(intent.event, "reconciliation run event"); string(intent.entityId, "reconciliation run entity");
    if (!OPERATIONAL_WORKFLOW_PATHS.has(intent.workflowPath) || !OPERATIONAL_WORKFLOW_EVENTS[intent.workflowPath].includes(intent.event) || !RETRYABLE_RUN_CONCLUSIONS.has(intent.runConclusion) || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1) fail("reconciliation run attempt is invalid");
    validateOperationShape({ type: "rerun_check", runId: intent.runId, attempt: intent.attempt, failedJobs: intent.failedJobs });
  } else if (intent.kind === "retry_failed_dispatch") {
    exact(intent, ["kind", "runId", "workflowPath", "headSha", "attempt", "failedJobs", "operationDigest", "eventType", "clientPayload"], "reconciliation intent");
    restId(intent.runId, "reconciliation run"); sha(intent.headSha, "reconciliation run head"); digest(intent.operationDigest, "reconciliation parent operation");
    oneOf(intent.eventType, REPOSITORY_DISPATCH_TYPES, "reconciliation parent event"); validateRepositoryDispatchPayload(intent.eventType, intent.clientPayload);
    if (intent.workflowPath !== `.github/workflows/${REPOSITORY_DISPATCH_WORKFLOWS[intent.eventType]}` || intent.operationDigest !== digestJson({ type: "dispatch_repository", eventType: intent.eventType, clientPayload: intent.clientPayload }) || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1) fail("failed dispatch retry authority is invalid");
    validateOperationShape({ type: "rerun_check", runId: intent.runId, attempt: intent.attempt, failedJobs: intent.failedJobs });
  } else if (intent.kind === "hold_spec") {
    exact(intent, ["kind", "issueId", "artifactDigest"], "reconciliation intent");
    restId(intent.issueId, "reconciliation issue"); digest(intent.artifactDigest, "reconciliation artifact");
  } else if (intent.kind === "sync_labels") {
    exact(intent, ["kind", "definitionsDigest"], "reconciliation intent");
    digest(intent.definitionsDigest, "reconciliation label digest");
  } else fail("reconciliation intent kind is invalid");
  return copy(intent);
}

function validateDispatchRevision(snapshot, intent) {
  if (intent.repositoryId !== snapshot.repository.id) fail("reconciliation dispatch repository does not match");
  if (["retry_route", "fallback_route", "retry_pioneer"].includes(intent.kind)) {
    const current = snapshot.state?.currentRevisions?.[`issue:${intent.issueId}`];
    if (typeof current !== "string" || current !== intent.sourceRevision) fail("reconciliation dispatch source revision is not current");
    return;
  }
  const pulls = snapshot.state?.reconciliation?.pulls;
  if (!Array.isArray(pulls)) fail("reconciliation dispatch pulls are unavailable");
  const matches = pulls.filter(pull => pull?.prId === intent.prId && pull.repositoryId === snapshot.repository.id && pull.headRepositoryId === snapshot.repository.id && pull.base === snapshot.repository.defaultBranch);
  if (matches.length !== 1) fail("reconciliation dispatch pull is not current");
  const pull = matches[0];
  if (intent.kind === "run_review") {
    if (pull.merged !== false || pull.headSha !== intent.headSha) fail("reconciliation dispatch head is not current");
  } else if (pull.merged !== true || pull.mergeSha !== intent.mergeSha) {
    fail("reconciliation dispatch merge is not current");
  }
}

export function mapReconciliationIntents({ snapshot, intents }) {
  const trustedSnapshot = validateSnapshot(snapshot);
  if (trustedSnapshot.routing.role !== "reconciler" || trustedSnapshot.routing.mode !== "single" || trustedSnapshot.routing.primary !== null) fail("reconciliation control authority is invalid");
  array(intents, "reconciliation intents");
  const validated = intents.map(validateReconciliationIntent);
  const ordered = [...validated].sort((left, right) => canonicalBytes(left).compare(canonicalBytes(right)));
  if (new Set(ordered.map(digestJson)).size !== ordered.length) fail("reconciliation intents contain duplicates");
  const operations = [];
  for (const intent of ordered) {
    if (intent.kind === "held") continue;
    if (intent.kind === "retry_cancelled_apply") {
      const run = trustedSnapshot.state?.resources?.runs?.find(candidate => candidate?.id === intent.runId);
      const expectedTitle = intent.workflowPath.endsWith("adw-issues.yml") ? `ADW issue #${intent.entityId}` : intent.workflowPath.endsWith("adw-pulls.yml") ? `ADW pull #${intent.entityId}` : null;
      if (!run || run.workflowPath !== intent.workflowPath || run.event !== intent.event || run.entityId !== intent.entityId || (expectedTitle !== null && run.displayTitle !== expectedTitle) || (intent.workflowPath.endsWith("adw-operations.yml") && intent.entityId !== trustedSnapshot.repository.id) || run.headSha !== intent.headSha || run.controlSha !== intent.controlSha || intent.controlSha !== trustedSnapshot.controlSha || run.applyJobId !== intent.applyJobId || digestJson(run.failedJobs) !== digestJson(intent.failedJobs) || run.attempt !== intent.attempt || run.status !== "completed" || run.conclusion !== intent.runConclusion || !RETRYABLE_RUN_CONCLUSIONS.has(intent.runConclusion)) fail("cancelled apply retry is not current");
      operations.push({ type: "rerun_check", runId: intent.runId, attempt: intent.attempt, failedJobs: intent.failedJobs });
    } else if (intent.kind === "retry_failed_dispatch") {
      const run = trustedSnapshot.state?.resources?.runs?.find(candidate => candidate?.id === intent.runId);
      if (!run || run.workflowPath !== intent.workflowPath || run.displayTitle !== intent.operationDigest || run.event !== "repository_dispatch" || run.headSha !== intent.headSha || digestJson(run.failedJobs) !== digestJson(intent.failedJobs) || run.attempt !== intent.attempt || run.status !== "completed" || !RETRYABLE_RUN_CONCLUSIONS.has(run.conclusion) || run.actorId !== trustedSnapshot.state?.reconciliation?.trust?.appId) fail("failed dispatch retry is not current");
      operations.push({ type: "rerun_check", runId: intent.runId, attempt: intent.attempt, failedJobs: intent.failedJobs });
    } else if (intent.kind === "hold_spec") {
      operations.push({ type: "add_label", entityId: intent.issueId, label: "needs:spec" });
    } else if (intent.kind === "sync_labels") {
      operations.push({ type: "sync_labels", definitionsDigest: intent.definitionsDigest });
    } else {
      validateDispatchRevision(trustedSnapshot, intent);
      const { kind, ...clientPayload } = intent;
      operations.push({ type: "dispatch_repository", eventType: kind, clientPayload });
    }
  }
  if (operations.length === 0) operations.push({ type: "noop", reason: "unchanged" });
  const unique = new Map(operations.map(operation => [digestJson(operation), validateOperationShape(operation)]));
  const priority = operation => operation.type === "dispatch_repository" ? 2 : operation.type === "rerun_check" ? 1 : 0;
  const orderedOperations = [...unique.values()].sort((left, right) => priority(left) - priority(right));
  let asynchronous = false;
  return deepFreeze(orderedOperations.filter(operation => {
    if (operation.type !== "rerun_check" && operation.type !== "dispatch_repository") return true;
    if (asynchronous) return false;
    asynchronous = true;
    return true;
  }));
}

export function validateVerification(value) {
  exact(value, ["schemaVersion", "controlSha", "decisionDigest", "kind", "preconditionDigest", "patch", "resultTree"], "verification");
  if (value.schemaVersion !== 1) fail("verification schema version is invalid");
  sha(value.controlSha, "verification.controlSha");
  digest(value.decisionDigest, "verification.decisionDigest");
  digest(value.preconditionDigest, "verification.preconditionDigest");
  oneOf(value.kind, new Set(["state", "patch"]), "verification.kind");
  if (value.kind === "patch") {
    patchMetadata(value.patch, "verification.patch");
    sha(value.resultTree, "verification.resultTree");
  } else if (value.patch !== null || value.resultTree !== null) {
    fail("state verification has patch fields");
  }
  if (canonicalBytes(value).length > 262_144) fail("verification is oversized");
  return copy(value);
}
