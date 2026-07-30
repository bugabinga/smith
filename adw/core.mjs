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

const HOLD_LABELS = new Set(["hold", "needs:owner", "needs:spec", "needs:security", "risk:high"]);

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

export function mergeEligibility(state) {
  exact(state, ["headSha", "labels", "checks", "reviews", "riskMarker", "timeline", "trust", "autoMergeAllowed"], "merge state");
  sha(state.headSha, "merge head");
  const reasons = [...holdReasons(state.labels)];
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
  rerun_check: { required: ["type", "runId"] },
  dispatch_workflow: { required: ["type", "workflow", "ref", "inputs"] },
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
    } else if (key === "inputs") {
      canonicalObject(value, "operation.inputs");
    } else {
      string(value, `operation.${key}`);
    }
  }
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
  ".github/workflows/adw-pulls.yml", ".github/workflows/adw-maintenance.yml",
];
const GLOBAL_DENIED_PREFIXES = ["adw/", ".github/rulesets/"];

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
    if (GLOBAL_DENIED_PATHS.includes(file.path) || GLOBAL_DENIED_PREFIXES.some(prefix => file.path.startsWith(prefix))) fail("patch path is globally denied");
    if (rolePolicy.patch.deniedPaths.some(rule => matchesRule(file.path, rule))) fail("patch path is denied by role");
    if (!rolePolicy.patch.allowedPrefixes.some(prefix => prefix.endsWith("/") ? file.path.startsWith(prefix) : file.path === prefix)) fail("patch path is outside role prefixes");
  }
  return copy(manifest);
}

export function planReconciliation(request) {
  exact(request, ["snapshot", "routes", "pulls", "labelSync"], "reconciliation");
  const { snapshot, routes, pulls, labelSync } = request;
  validateSnapshot(snapshot);
  array(routes, "routes");
  array(pulls, "pulls");
  const currentRevisions = snapshot.state.currentRevisions;
  if (!currentRevisions || Array.isArray(currentRevisions) || Object.getPrototypeOf(currentRevisions) !== Object.prototype) fail("snapshot current revisions are required");
  const intents = [];
  const routeIds = new Set();
  for (const route of routes) {
    exact(route, ["issueId", "sourceRevision", "status", "primary", "fallback", "artifactDigest"], "route");
    string(route.issueId, "route.issueId");
    if (routeIds.has(route.issueId)) fail("duplicate route issue");
    routeIds.add(route.issueId);
    string(route.sourceRevision, "route.sourceRevision");
    oneOf(route.status, new Set(["unarmed", "primary", "fallback", "complete", "blocked"]), "route.status");
    oneOf(route.primary, PROVIDERS, "route.primary");
    if (route.fallback !== null) oneOf(route.fallback, PROVIDERS, "route.fallback");
    if (route.artifactDigest !== null) digest(route.artifactDigest, "route.artifactDigest");
    if (route.status === "complete" && route.artifactDigest === null) fail("completed route lacks artifact");
    if (route.status !== "complete" && route.artifactDigest !== null) fail("incomplete route has artifact");
    const current = currentRevisions[`issue:${route.issueId}`];
    string(current, "current revision");
    if (current !== route.sourceRevision) {
      intents.push({ kind: "retry_route", issueId: route.issueId, sourceRevision: current });
    }
  }
  const pullIds = new Set();
  for (const pull of pulls) {
    exact(pull, ["prId", "headSha", "merged", "mergeSha", "obligations"], "pull");
    string(pull.prId, "pull.prId");
    if (pullIds.has(pull.prId)) fail("duplicate pull");
    pullIds.add(pull.prId);
    sha(pull.headSha, "pull.headSha");
    if (typeof pull.merged !== "boolean") fail("pull.merged must be boolean");
    if (pull.merged) sha(pull.mergeSha, "pull.mergeSha");
    else if (pull.mergeSha !== null) fail("unmerged pull has merge SHA");
    array(pull.obligations, "pull.obligations");
    if (!pull.merged) continue;
    const obligationRoles = new Set();
    for (const obligation of pull.obligations) {
      exact(obligation, ["role", "status", "artifactDigest"], "obligation");
      string(obligation.role, "obligation.role");
      if (obligationRoles.has(obligation.role)) fail("duplicate pull obligation");
      obligationRoles.add(obligation.role);
      oneOf(obligation.status, new Set(["missing", "complete", "failed"]), "obligation.status");
      if (obligation.artifactDigest !== null) digest(obligation.artifactDigest, "obligation.artifactDigest");
      if (obligation.status === "complete" && obligation.artifactDigest === null) fail("completed obligation lacks artifact");
      if (obligation.status !== "complete" && obligation.artifactDigest !== null) fail("incomplete obligation has artifact");
      if (obligation.status === "missing" || obligation.status === "failed") intents.push({ kind: "run_obligation", prId: pull.prId, mergeSha: pull.mergeSha, role: obligation.role });
    }
  }
  exact(labelSync, ["wantedDigest", "liveDigest"], "labelSync");
  digest(labelSync.wantedDigest, "labelSync.wantedDigest");
  digest(labelSync.liveDigest, "labelSync.liveDigest");
  if (labelSync.wantedDigest !== labelSync.liveDigest) intents.push({ kind: "sync_labels", definitionsDigest: labelSync.wantedDigest });
  const unique = new Map(intents.map(intent => [digestJson(intent), intent]));
  return deepFreeze([...unique.values()].sort((a, b) => canonicalBytes(a).compare(canonicalBytes(b))));
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
