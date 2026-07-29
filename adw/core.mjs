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
  array(value.assessmentDigests, "decision.assessmentDigests");
  const seen = new Set();
  for (const item of value.assessmentDigests) {
    digest(item, "decision.assessmentDigests[]");
    if (seen.has(item)) fail("decision assessment digests must be unique");
    seen.add(item);
  }
  oneOf(value.kind, new Set(["state", "patch", "terminal"]), "decision.kind");
  array(value.operations, "decision.operations");
  for (const operation of value.operations) canonicalObject(operation, "decision.operation");
  if (value.kind === "patch") patchMetadata(value.patch, "decision.patch");
  else if (value.patch !== null) fail("non-patch decision has patch metadata");
  return copy(value);
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
  return copy(value);
}
