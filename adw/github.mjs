import { isAbsolute } from "node:path";
import { AdwError, canonicalBytes, digestJson, holdReasons, validateDecision, validateOperation, validateSnapshot, validateVerification } from "./core.mjs";
import { OPERATIONS, controlAuthority, deterministicRole, role } from "./roles.mjs";
import { runProcess } from "./providers.mjs";

const EVENTS = new Set([
  "issues", "issue_comment", "pull_request", "pull_request_review",
  "pull_request_review_comment", "check_suite", "check_run", "workflow_run",
  "push", "schedule", "dependabot_alert", "code_scanning_alert", "workflow_dispatch",
]);

const ADAPTER_READ_CAPABILITIES = Object.freeze(["actions:read", "alerts:read", "checks:read", "issues:read", "pulls:read", "repository:read", "settings:read"]);
const GITHUB_WRITE_OPERATIONS = new Set([
  "comment", "add_label", "remove_label", "create_issue", "update_issue", "close_issue",
  "create_milestone", "update_milestone", "close_milestone", "assign_milestone", "link_sub_issue",
  "create_pr", "update_pr", "publish_check", "rerun_check", "dispatch_workflow", "arm_auto_merge",
  "sync_labels", "report_drift", "noop", "terminal",
]);
const ISSUE_WRITES = new Set([
  "comment", "add_label", "remove_label", "create_issue", "update_issue", "close_issue",
  "create_milestone", "update_milestone", "close_milestone", "assign_milestone", "link_sub_issue", "report_drift",
]);
export const GITHUB_OPERATION_TRANSITIONS = Object.freeze(Object.fromEntries(
  [...GITHUB_WRITE_OPERATIONS].sort().map(type => [type, Object.freeze(["original", "prepared", "post"])]),
));

export function operationCapabilities(operation, snapshot = null) {
  const type = operation?.type;
  if (!GITHUB_WRITE_OPERATIONS.has(type)) throw new AdwError("contract", "operation is not GitHub-owned");
  const capabilities = new Set();
  if (ISSUE_WRITES.has(type)) capabilities.add("issues:write");
  else if (type === "create_pr" || type === "update_pr") capabilities.add("pulls:write");
  else if (type === "publish_check") capabilities.add("checks:write");
  else if (type === "rerun_check" || type === "dispatch_workflow") { capabilities.add("actions:write"); capabilities.add("checks:write"); }
  else if (type === "arm_auto_merge") { capabilities.add("checks:read"); capabilities.add("issues:read"); capabilities.add("pulls:write"); }
  else if (type === "sync_labels") { capabilities.add("contents:read"); capabilities.add("issues:write"); }
  const readCapability = resource => {
    if (resource === "repository") return "repository:read";
    if (resource.startsWith("trusted:") || resource.startsWith("patch-base:") || resource.startsWith("ref:")) return "contents:read";
    if (resource === "issues" || resource === "labels" || resource === "milestones" || resource.startsWith("issue:")) return "issues:read";
    if (resource === "pulls" || resource.startsWith("pull:")) return resource.endsWith(":checks") ? ["checks:read", "pulls:read"] : "pulls:read";
    if (resource === "runs") return "actions:read";
    if (resource === "alerts") return "alerts:read";
    if (resource === "rulesets" || resource === "settings") return "settings:read";
    return null;
  };
  if (snapshot !== null) contract(Array.isArray(snapshot?.revisions), "snapshot revisions are invalid");
  for (const revision of snapshot?.revisions ?? []) {
    contract(typeof revision?.resource === "string", "snapshot revision is invalid");
    const needed = readCapability(revision.resource);
    for (const capability of Array.isArray(needed) ? needed : [needed]) {
      if (capability !== null && !capabilities.has(capability.replace(":read", ":write"))) capabilities.add(capability);
    }
  }
  return Object.freeze([...capabilities].sort());
}

const REVISION_DIGEST = /^[0-9a-f]{64}$/;

function validateOperationReceipt(operation, entry, expectedBefore) {
  const transition = GITHUB_OPERATION_TRANSITIONS[operation.type];
  if (transition?.join("→") !== "original→prepared→post") throw new AdwError("contract", "operation transition is unavailable");
  if (!entry || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype || Object.keys(entry).sort().join(",") !== "afterRevision,beforeRevision,operationDigest,preparedRevision,status") throw new AdwError("contract", "apply operation receipt is invalid");
  const actionTransition = operation.type === "rerun_check" || operation.type === "dispatch_workflow";
  if (entry.operationDigest !== digestJson(operation) || entry.status !== "complete" || entry.beforeRevision !== expectedBefore || !REVISION_DIGEST.test(entry.preparedRevision) || !REVISION_DIGEST.test(entry.afterRevision) || (!actionTransition && entry.preparedRevision !== entry.afterRevision)) throw new AdwError("contract", "apply operation receipt is invalid");
  return Object.freeze({ operationDigest: entry.operationDigest, status: "complete", beforeRevision: entry.beforeRevision, preparedRevision: entry.preparedRevision, afterRevision: entry.afterRevision });
}

function unchangedReceipt(operation, revision) {
  return Object.freeze({ operationDigest: digestJson(operation), status: "complete", beforeRevision: revision, preparedRevision: revision, afterRevision: revision });
}

export function createApplyReceipt({ decision, snapshot, verification, operations }) {
  const trustedSnapshot = validateSnapshot(snapshot);
  const canonicalDecision = validateDecision(decision);
  const proof = validateVerification(verification);
  if (canonicalDecision.controlSha !== trustedSnapshot.controlSha || canonicalDecision.snapshotDigest !== digestJson(trustedSnapshot) || proof.controlSha !== trustedSnapshot.controlSha || proof.decisionDigest !== digestJson(canonicalDecision) || proof.preconditionDigest !== digestJson(trustedSnapshot.revisions)) throw new AdwError("contract", "apply receipt authority does not match");
  if (!Array.isArray(operations) || operations.length > canonicalDecision.operations.length) throw new AdwError("contract", "apply operations are invalid");
  let expectedBefore = proof.preconditionDigest;
  const entries = operations.map((entry, index) => {
    const canonical = validateOperationReceipt(canonicalDecision.operations[index], entry, expectedBefore);
    expectedBefore = canonical.afterRevision;
    return canonical;
  });
  return Object.freeze({ decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: Object.freeze(entries) });
}
const FIELD_CAPABILITY = Object.freeze({
  repository: "repository:read", issue: "issues:read", issues: "issues:read", claim: "issues:read", spec: "issues:read", spec_change: "issues:read", labels: "issues:read", milestones: "issues:read", comment: "issues:read", entity: "issues:read", owner: "issues:read", route: "issues:read",
  pull: "pulls:read", pulls: "pulls:read", diff: "pulls:read", files: "pulls:read", reviews: "pulls:read", security: "pulls:read", changed_paths: "pulls:read", findings: "pulls:read", docs: "pulls:read", dependency: "pulls:read",
  runs: "actions:read", routes: "actions:read", alert: "alerts:read", settings: "settings:read", config: "settings:read",
});
const ROLE_EVENTS = Object.freeze({
  "steerer": ["issue_comment"], "triager": ["issue"], "planner": ["issue", "push", "schedule"],
  "surveyor": ["schedule"], "builder": ["issue"], "codex-builder": ["issue"], "pioneer": ["issue"],
  "reviewer": ["pull_request"], "security-reviewer": ["pull_request"], "reviser": ["pull_request", "pull_request_review"],
  "sweeper": ["schedule"], "adw-doctor": ["schedule"], "docs-writer": ["pull_request"],
  "dependency-manager": ["pull_request"], "alert-triager": ["alert", "schedule"],
});

export function deterministicSnapshotPlan(roleName, eventKind) {
  contract(eventKind === "schedule", "deterministic role event is unsupported");
  const value = deterministicRole(roleName);
  const fields = { "jam-detector": ["pulls", "runs"], "label-sync": ["labels"], "settings-auditor": ["config", "settings"] }[roleName];
  contract(fields !== undefined, "deterministic role is unsupported");
  return Object.freeze({ role: value.name, eventKind, fields: Object.freeze(fields) });
}

export function controlSnapshotPlan(authorityName, eventKind) {
  const authority = controlAuthority(authorityName);
  contract(authority.eventKinds.includes(eventKind), "control authority event is unsupported");
  return Object.freeze({ role: authority.name, eventKind, fields: Object.freeze([...authority.snapshot.fields]) });
}

export function roleSnapshotPlan(roleName, eventKind) {
  const events = ROLE_EVENTS[roleName];
  contract(events?.includes(eventKind), "role event is unsupported");
  return Object.freeze({ role: roleName, eventKind, fields: Object.freeze([...role(roleName).snapshot.fields]) });
}

function contract(condition, message) {
  if (!condition) throw new AdwError("contract", message);
}

function text(value, name) {
  contract(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

function restId(value, name) {
  contract(Number.isSafeInteger(value) && value > 0, `${name} is required`);
  return String(value);
}

function githubIdentity(value) {
  contract(value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === "appId,botUserId,login,slug", "App identity is invalid");
  for (const key of ["appId", "botUserId"]) {
    contract(typeof value[key] === "string" && /^[1-9][0-9]*$/.test(value[key]) && Number.isSafeInteger(Number(value[key])), "App identity is invalid");
  }
  contract(typeof value.slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(value.slug), "App identity is invalid");
  contract(typeof value.login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/.test(value.login), "App identity is invalid");
  return value;
}

const APPLY_PAIR = /^<!-- smith:apply\/v1 role=([a-z][a-z0-9-]*) decision=([0-9a-f]{64}) operation=(0|[1-9][0-9]*) digest=([0-9a-f]{64}) phase=complete -->$/;
const REVIEW_MARKER = /^<!-- smith:review-evidence\/v1 kind=(correctness|security) head=([0-9a-f]{40}) conclusion=(approve|reject) provider=(claude|codex) authoritative=true artifact=([0-9a-f]{64}) -->$/;
const RISK_MARKER = /^<!-- smith:risk\/v1 head=([0-9a-f]{40}) finding=([0-9a-f]{64}) status=(open|cleared) created=([^ ]+) cleared=([^ ]+) -->$/;
const PIONEER_MARKER = /^<!-- smith:pioneer\/v1 issue=([1-9][0-9]*) source=([^\s\0]+) verdict=(proved|disproved|inconclusive) artifact=([0-9a-f]{64}|-) -->$/;
const GITHUB_ACTIONS_APP_ID = "15368";

function pairedSemanticMarker(comment, entityId) {
  if (typeof comment?.body !== "string") return null;
  const lines = comment.body.split("\n");
  if (lines.length !== 2) return null;
  const apply = APPLY_PAIR.exec(lines[1]);
  if (apply === null) return null;
  const operationDigest = digestJson({ type: "comment", entityId: String(entityId), body: lines[0], marker: lines[0] });
  const operationIndex = Number(apply[3]);
  if (apply[4] !== operationDigest || !Number.isSafeInteger(operationIndex)) return null;
  return Object.freeze({ semantic: lines[0], role: apply[1], decisionDigest: apply[2], operationIndex, operationDigest });
}

function parsedReviewMarker(comment, headSha, prId, identity) {
  const pair = pairedSemanticMarker(comment, prId);
  if (pair === null) return null;
  const marker = REVIEW_MARKER.exec(pair.semantic);
  if (marker === null || marker[2] !== headSha) return null;
  const expectedRole = marker[1] === "correctness" ? "reviewer" : "security-reviewer";
  const authored = String(comment.user?.id ?? "") === identity.botUserId && comment.user?.login === identity.login && comment.user?.type === "Bot";
  if (!authored || pair.role !== expectedRole) return null;
  return Object.freeze({ kind: marker[1], headSha, conclusion: marker[3], provider: marker[4], artifactDigest: marker[5] });
}

export function validateAutoMergeMarkers({ comments, headSha, prId, appIdentity, ownerIds, ownerLogin }) {
  const identity = githubIdentity(appIdentity);
  contract(Array.isArray(comments) && comments.length < 100, "auto-merge comments are invalid");
  contract(typeof headSha === "string" && /^[0-9a-f]{40}$/.test(headSha), "auto-merge head is invalid");
  contract(typeof prId === "string" && /^[1-9][0-9]*$/.test(prId), "auto-merge pull is invalid");
  contract(Array.isArray(ownerIds) && ownerIds.every(id => typeof id === "string" && /^[1-9][0-9]*$/.test(id)), "auto-merge owners are invalid");
  text(ownerLogin, "repository owner");
  const reviews = comments.map(comment => parsedReviewMarker(comment, headSha, prId, identity)).filter(Boolean);
  for (const kind of ["correctness", "security"]) {
    const matches = reviews.filter(review => review.kind === kind);
    if (matches.length !== 1 || matches[0].conclusion !== "approve") throw new AdwError("stale", "auto-merge evidence failed");
  }
  const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
  const ownerSet = new Set(ownerIds);
  const risks = comments.map(comment => {
    const pair = pairedSemanticMarker(comment, prId);
    if (pair === null) return null;
    const marker = RISK_MARKER.exec(pair.semantic);
    if (marker === null || marker[1] !== headSha) return null;
    return { comment, role: pair.role, finding: marker[2], status: marker[3], created: marker[4], cleared: marker[5] };
  }).filter(Boolean);
  for (const opened of risks.filter(risk => risk.status === "open")) {
    const appAuthored = String(opened.comment.user?.id ?? "") === identity.botUserId && opened.comment.user?.login === identity.login && opened.comment.user?.type === "Bot";
    if (!appAuthored) continue;
    if (opened.role !== "security-reviewer" || opened.cleared !== "-" || !validTime(opened.created) || !validTime(opened.comment.created_at) || Date.parse(opened.comment.created_at) < Date.parse(opened.created)) throw new AdwError("stale", "auto-merge sticky risk is not owner-cleared");
    const cleared = risks.some(risk => risk.status === "cleared" && risk.finding === opened.finding && risk.created === opened.created && validTime(risk.cleared) && validTime(risk.comment.created_at)
      && Date.parse(risk.cleared) >= Date.parse(opened.created) && Date.parse(risk.comment.created_at) >= Date.parse(opened.comment.created_at)
      && ownerSet.has(String(risk.comment.user?.id ?? "")) && risk.comment.user?.login === ownerLogin && risk.comment.user?.type === "User");
    if (!cleared) throw new AdwError("stale", "auto-merge sticky risk is not owner-cleared");
  }
  return Object.freeze({ correctness: "approve", security: "approve" });
}

function repositoryOf(payload) {
  const value = payload.repository;
  contract(value && value.owner, "repository is required");
  return Object.freeze({
    id: restId(value.id, "repository id"),
    owner: text(value.owner.login, "repository owner"),
    name: text(value.name, "repository name"),
    defaultBranch: text(value.default_branch, "default branch"),
  });
}

function actorOf(payload) {
  const value = payload.sender;
  contract(value, "sender is required");
  return Object.freeze({ id: restId(value.id, "actor id"), login: text(value.login, "actor login"), type: text(value.type, "actor type") });
}

export function normalizeEvent(name, payload) {
  contract(EVENTS.has(name), "event is unsupported");
  contract(payload && typeof payload === "object" && !Array.isArray(payload), "event payload is invalid");
  const repository = repositoryOf(payload);
  const actor = actorOf(payload);
  let kind;
  let entityId;
  let action = payload.action;
  let revisionHints = {};
  if (name === "issues") {
    kind = "issue"; entityId = restId(payload.issue?.number, "issue number"); revisionHints = { updatedAt: payload.issue.updated_at };
  } else if (name === "issue_comment") {
    kind = "issue_comment"; entityId = restId(payload.issue?.number, "issue number"); revisionHints = { commentId: restId(payload.comment?.id, "comment id"), updatedAt: payload.comment.updated_at };
  } else if (name === "pull_request") {
    kind = "pull_request"; entityId = restId(payload.pull_request?.number, "pull number"); revisionHints = { headSha: payload.pull_request.head?.sha, ...(payload.pull_request.head?.ref === undefined ? {} : { headBranch: payload.pull_request.head.ref }), baseRef: payload.pull_request.base?.ref, headRepository: payload.pull_request.head?.repo?.full_name, updatedAt: payload.pull_request.updated_at };
  } else if (name === "pull_request_review") {
    kind = "pull_request_review"; entityId = restId(payload.pull_request?.number, "pull number"); revisionHints = { reviewId: restId(payload.review?.id, "review id"), headSha: payload.review?.commit_id ?? payload.pull_request.head?.sha };
  } else if (name === "pull_request_review_comment") {
    kind = "pull_request_review_comment"; entityId = restId(payload.pull_request?.number, "pull number"); revisionHints = { commentId: restId(payload.comment?.id, "comment id"), headSha: payload.comment?.commit_id ?? payload.pull_request.head?.sha };
  } else if (name === "check_suite" || name === "check_run") {
    const check = payload.check_suite ?? payload.check_run;
    kind = "check"; entityId = restId(check?.id, "check id"); revisionHints = { headSha: check?.head_sha, checkKind: name };
  } else if (name === "workflow_run") {
    kind = "workflow"; entityId = restId(payload.workflow_run?.id, "workflow run id"); revisionHints = { headSha: payload.workflow_run?.head_sha };
  } else if (name === "push") {
    kind = "push"; entityId = text(payload.ref, "push ref"); action = "pushed"; revisionHints = { headSha: payload.after };
  } else if (name === "schedule") {
    kind = "schedule"; entityId = repository.id; action = "scheduled"; revisionHints = { schedule: payload.schedule };
  } else if (name === "dependabot_alert" || name === "code_scanning_alert") {
    const alert = payload.alert ?? payload.dependabot_alert ?? payload.code_scanning_alert;
    kind = "alert"; entityId = restId(alert?.number, "alert number"); revisionHints = { alertKind: name, updatedAt: alert?.updated_at };
  } else {
    kind = "dispatch"; entityId = repository.id; action = "requested"; revisionHints = { inputs: payload.inputs ?? {} };
  }
  text(action, "event action");
  for (const [key, value] of Object.entries(revisionHints)) contract(value !== undefined && value !== null, `revision hint ${key} is required`);
  return Object.freeze({ kind, action, entityId, repository, actor, revisionHints: Object.freeze(revisionHints) });
}

function contentEnvelope(data, trust, source) {
  contract(trust === "trusted" || trust === "untrusted", "content trust is invalid");
  text(source, "content source");
  const bytes = canonicalBytes(data);
  if (bytes.length > 65_536) throw new AdwError("forge", "overflow");
  return Object.freeze({ trust, source, bytes: bytes.length, digest: digestJson(data), data });
}

function forgeReason(status) {
  if (status === 404) return "not_found";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "api";
}

export function createGitHub({ repository, token, appIdentity, ghPath, run = runProcess, baseEnv }) {
  contract(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "repository is invalid");
  contract(repository.split("/").every(segment => segment !== "." && segment !== ".."), "repository is invalid");
  contract(typeof token === "string" || typeof token === "function" || (token && !Array.isArray(token) && Object.getPrototypeOf(token) === Object.prototype) || token === null, "token is invalid");
  appIdentity = Object.freeze({ ...githubIdentity(appIdentity) });
  contract(typeof ghPath === "string" && isAbsolute(ghPath), "gh path is invalid");
  const [owner, name] = repository.split("/");
  const intentsByDigest = new Map();
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) if (typeof baseEnv?.[key] === "string") env[key] = baseEnv[key];
  if (typeof token === "string") env.GH_TOKEN = token;
  else if (typeof token === "function" && typeof token.readValue === "string") env.GH_TOKEN = token.readValue;
  env.GH_HOST = "github.com";
  env.NO_COLOR = "1";
  let activeApplyToken = null;
  let applyActive = false;
  const requestEnv = () => activeApplyToken === null ? env : Object.freeze({ ...env, GH_TOKEN: activeApplyToken });

  async function page(endpoint) {
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "--method", "GET", endpoint], cwd: process.cwd(), env: requestEnv(), input: "", timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
    } catch (error) {
      throw new AdwError("forge", forgeReason(error?.details?.httpStatus ?? 0));
    }
    try { return JSON.parse(result.stdout); } catch { throw new AdwError("forge", "malformed"); }
  }

  async function mutate(method, endpoint, body) {
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "--method", method, endpoint, "--input", "-"], cwd: process.cwd(), env: requestEnv(), input: canonicalBytes(body).toString("utf8"), timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
    } catch (error) {
      throw new AdwError("forge", forgeReason(error?.details?.httpStatus ?? 0));
    }
    if (result.stdout === "" || result.stdout === undefined) return null;
    try { return JSON.parse(result.stdout); } catch { throw new AdwError("forge", "malformed"); }
  }

  const ENABLE_AUTO_MERGE_MUTATION = "mutation EnablePullRequestAutoMerge($pullRequestId:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:SQUASH}){pullRequest{id}}}";
  async function enablePullRequestAutoMerge(pullRequestId) {
    contract(typeof pullRequestId === "string" && /^[A-Za-z0-9_=-]+$/.test(pullRequestId), "pull node ID is invalid");
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "graphql", "--method", "POST", "--input", "-"], cwd: process.cwd(), env: requestEnv(), input: canonicalBytes({ query: ENABLE_AUTO_MERGE_MUTATION, variables: { pullRequestId } }).toString("utf8"), timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
    } catch (error) {
      throw new AdwError("forge", forgeReason(error?.details?.httpStatus ?? 0));
    }
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new AdwError("forge", "malformed"); }
    if (!response || !response.data?.enablePullRequestAutoMerge?.pullRequest || (Array.isArray(response.errors) && response.errors.length > 0)) throw new AdwError("forge", "api");
  }

  const CLOSING_ISSUES_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{databaseId}} pageInfo{hasNextPage}}}}}";
  async function closingIssues(number) {
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "graphql", "-f", `query=${CLOSING_ISSUES_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${positiveInteger(number)}`], cwd: process.cwd(), env: requestEnv(), input: "", timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
    } catch (error) { throw new AdwError("forge", forgeReason(error?.details?.httpStatus ?? 0)); }
    let value;
    try { value = JSON.parse(result.stdout)?.data?.repository?.pullRequest?.closingIssuesReferences; } catch { throw new AdwError("forge", "malformed"); }
    if (!value || !Array.isArray(value.nodes) || value.nodes.length > 100 || value.pageInfo?.hasNextPage !== false) throw new AdwError("forge", "overflow");
    return value.nodes.map(issue => Object.freeze({ repositoryId: restId(issue.repository?.databaseId, "closing issue repository"), issueId: restId(issue.number, "closing issue number") }));
  }

  async function optional(endpoint) {
    try { return await page(endpoint); } catch (error) { if (error?.code === "forge" && error.message === "not_found") return null; throw error; }
  }

  async function request(endpoint, collection = false) {
    if (!collection) return page(endpoint);
    const key = typeof collection === "string" ? collection : null;
    const records = [];
    let bytes = 0;
    for (let number = 1; number <= 100; number++) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await page(`${endpoint}${separator}per_page=100&page=${number}`);
      const value = key === null ? response : response?.[key];
      if (!Array.isArray(value)) throw new AdwError("forge", "malformed");
      bytes += Buffer.byteLength(JSON.stringify(value));
      records.push(...value);
      if (records.length > 10_000 || bytes > 1_048_576) throw new AdwError("forge", "overflow");
      if (value.length < 100) return records;
    }
    throw new AdwError("forge", "overflow");
  }

  const positiveInteger = value => {
    contract(Number.isSafeInteger(value) && value > 0, "number is invalid");
    return value;
  };
  const policy = { operations: OPERATIONS };
  const methods = {
    repository: () => request(`/repos/${owner}/${name}`),
    issue: number => request(`/repos/${owner}/${name}/issues/${positiveInteger(number)}`),
    pull: number => request(`/repos/${owner}/${name}/pulls/${positiveInteger(number)}`),
    issueComment: number => request(`/repos/${owner}/${name}/issues/comments/${positiveInteger(number)}`),
    review: (pull, review) => request(`/repos/${owner}/${name}/pulls/${positiveInteger(pull)}/reviews/${positiveInteger(review)}`),
    reviewComment: number => request(`/repos/${owner}/${name}/pulls/comments/${positiveInteger(number)}`),
    check: (kind, number) => {
      contract(kind === "check_suite" || kind === "check_run", "check kind is invalid");
      return request(`/repos/${owner}/${name}/${kind === "check_suite" ? "check-suites" : "check-runs"}/${positiveInteger(number)}`);
    },
    workflowRun: number => request(`/repos/${owner}/${name}/actions/runs/${positiveInteger(number)}`),
    alert: (kind, number) => {
      contract(kind === "dependabot_alert" || kind === "code_scanning_alert", "alert kind is invalid");
      return request(`/repos/${owner}/${name}/${kind === "dependabot_alert" ? "dependabot/alerts" : "code-scanning/alerts"}/${positiveInteger(number)}`);
    },
    alerts: kind => {
      contract(kind === "dependabot_alert" || kind === "code_scanning_alert", "alert kind is invalid");
      return request(`/repos/${owner}/${name}/${kind === "dependabot_alert" ? "dependabot/alerts" : "code-scanning/alerts"}?state=open`, true);
    },
    comments: (kind, number) => {
      contract(kind === "issues" || kind === "pulls", "comment kind is invalid");
      return request(`/repos/${owner}/${name}/${kind}/${positiveInteger(number)}/comments`, true);
    },
    issueTimeline: number => request(`/repos/${owner}/${name}/issues/${positiveInteger(number)}/timeline`, true),
    issueParent: number => optional(`/repos/${owner}/${name}/issues/${positiveInteger(number)}/parent`),
    subIssues: number => request(`/repos/${owner}/${name}/issues/${positiveInteger(number)}/sub_issues`, true),
    issues: () => request(`/repos/${owner}/${name}/issues?state=all`, true),
    pulls: () => request(`/repos/${owner}/${name}/pulls?state=all`, true),
    milestones: () => request(`/repos/${owner}/${name}/milestones?state=all`, true),
    labels: () => request(`/repos/${owner}/${name}/labels`, true),
    pullFiles: number => request(`/repos/${owner}/${name}/pulls/${positiveInteger(number)}/files`, true),
    pullReviews: number => request(`/repos/${owner}/${name}/pulls/${positiveInteger(number)}/reviews`, true),
    commitChecks: headSha => {
      contract(typeof headSha === "string" && /^[0-9a-f]{40}$/.test(headSha), "head SHA is invalid");
      return request(`/repos/${owner}/${name}/commits/${headSha}/check-runs?filter=latest`, "check_runs");
    },
    rulesets: () => request(`/repos/${owner}/${name}/rulesets`, true),
    ruleset: number => request(`/repos/${owner}/${name}/rulesets/${positiveInteger(number)}`),
    trustedFile: (path, ref) => {
      contract(typeof path === "string" && path.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".."), "trusted path is invalid");
      contract(typeof ref === "string" && /^[0-9a-f]{40}$/.test(ref), "trusted ref is invalid");
      return request(`/repos/${owner}/${name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`);
    },
    closingIssues,
    branchRef: branch => {
      contract(typeof branch === "string" && /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes(".."), "branch is invalid");
      return request(`/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    },
    runs: () => request(`/repos/${owner}/${name}/actions/runs`, "workflow_runs"),
  };
  const normalizeResource = value => {
    contract(value && typeof value === "object" && !Array.isArray(value), "resource is malformed");
    const resource = { id: restId(value.id ?? value.number, "resource id") };
    if (value.updated_at) resource.updatedAt = value.updated_at;
    if (value.head_sha ?? value.head?.sha ?? value.commit_id) resource.headSha = value.head_sha ?? value.head?.sha ?? value.commit_id;
    if (value.state) resource.state = value.state;
    return Object.freeze(resource);
  };
  const normalizeSettings = value => {
    const fields = ["allow_auto_merge", "allow_merge_commit", "allow_rebase_merge", "allow_squash_merge", "delete_branch_on_merge"];
    contract(value && fields.every(field => typeof value[field] === "boolean"), "repository settings are malformed");
    return Object.freeze({
      allowAutoMerge: value.allow_auto_merge,
      allowMergeCommit: value.allow_merge_commit,
      allowRebaseMerge: value.allow_rebase_merge,
      allowSquashMerge: value.allow_squash_merge,
      deleteBranchOnMerge: value.delete_branch_on_merge,
    });
  };
  const normalizedContent = (value, source) => contentEnvelope(value ?? "", "untrusted", source);
  const normalizeLabels = value => {
    contract(Array.isArray(value), "labels are malformed");
    return value.map(label => text(typeof label === "string" ? label : label?.name, "label")).sort();
  };
  const issueSourceRevision = value => {
    contract(value && typeof value === "object" && !Array.isArray(value), "issue is malformed");
    const milestoneId = value.milestone === null || value.milestone === undefined ? null : restId(value.milestone.id, "milestone id");
    return digestJson({
      body: typeof value.body === "string" ? value.body : "",
      labels: normalizeLabels(value.labels ?? []),
      milestoneId,
      state: text(value.state, "issue state"),
      title: text(value.title, "issue title"),
    });
  };
  const normalizeIssue = value => {
    contract(value && Number.isSafeInteger(value.number) && value.number > 0, "issue is malformed");
    const labels = normalizeLabels(value.labels ?? []);
    const milestoneId = value.milestone ? restId(value.milestone.id, "milestone id") : null;
    return Object.freeze({
      id: restId(value.id, "issue id"), number: String(value.number), state: text(value.state, "issue state"),
      updatedAt: text(value.updated_at, "issue updatedAt"), sourceRevision: issueSourceRevision(value), actorId: restId(value.user?.id, "issue actor"),
      title: normalizedContent(value.title, `issue:${value.number}:title`), body: normalizedContent(value.body ?? "", `issue:${value.number}:body`),
      labels: Object.freeze(labels), milestoneId,
    });
  };
  const canonicalInstant = (value, name) => {
    text(value, name);
    const instant = new Date(value);
    contract(Number.isFinite(instant.getTime()), `${name} is malformed`);
    return instant.toISOString();
  };
  const normalizeComment = (value, entityId, repositoryId) => Object.freeze({
    id: restId(value.id, "comment id"), actorId: restId(value.user?.id, "comment actor"),
    createdAt: canonicalInstant(value.created_at, "comment createdAt"), updatedAt: canonicalInstant(value.updated_at ?? value.created_at, "comment updatedAt"),
    entityId: String(entityId), repositoryId,
    body: normalizedContent(value.body ?? "", `comment:${value.id}:body`),
  });
  const normalizePull = value => {
    contract(value && Number.isSafeInteger(value.number) && value.number > 0, "pull is malformed");
    const headSha = text(value.head?.sha, "pull head SHA");
    contract(/^[0-9a-f]{40}$/.test(headSha), "pull head SHA is malformed");
    const mergeSha = value.merge_commit_sha === null || value.merge_commit_sha === undefined ? null : text(value.merge_commit_sha, "pull merge SHA");
    contract(mergeSha === null || /^[0-9a-f]{40}$/.test(mergeSha), "pull merge SHA is malformed");
    return Object.freeze({
      id: restId(value.id, "pull id"), number: String(value.number), state: text(value.state, "pull state"), draft: value.draft === true, merged: value.merged === true || typeof value.merged_at === "string",
      mergeSha, mergeState: value.mergeable_state === undefined || value.mergeable_state === null ? null : text(value.mergeable_state, "pull merge state").toLowerCase(),
      updatedAt: text(value.updated_at, "pull updatedAt"), headSha, headBranch: value.head?.ref === undefined ? null : text(value.head.ref, "pull head branch"), base: text(value.base?.ref, "pull base"),
      actorId: value.user ? restId(value.user.id, "pull actor") : null, actorLogin: value.user?.login ?? null, actorType: value.user?.type ?? null,
      headRepository: text(value.head?.repo?.full_name, "pull head repository"),
      title: normalizedContent(value.title, `pull:${value.number}:title`), body: normalizedContent(value.body ?? "", `pull:${value.number}:body`),
      labels: Object.freeze(normalizeLabels(value.labels ?? [])),
    });
  };
  const normalizeFile = (value, pull) => Object.freeze({
    path: text(value.filename, "file path"), previousPath: value.previous_filename ? text(value.previous_filename, "previous file path") : null,
    status: text(value.status, "file status"), additions: Number(value.additions ?? 0), deletions: Number(value.deletions ?? 0),
    patch: normalizedContent(value.patch ?? "", `pull:${pull}:file:${value.filename}`),
  });
  const normalizeReview = (value, pull) => Object.freeze({
    id: restId(value.id, "review id"), actorId: restId(value.user?.id, "review actor"), state: text(value.state, "review state"),
    headSha: text(value.commit_id, "review head"), submittedAt: text(value.submitted_at, "review submittedAt"), body: normalizedContent(value.body ?? "", `pull:${pull}:review:${value.id}`),
  });
  const normalizeCheck = value => Object.freeze({ id: restId(value.id, "check id"), name: text(value.name, "check name"), headSha: text(value.head_sha, "check head"), status: text(value.status, "check status"), conclusion: value.conclusion === null ? null : text(value.conclusion, "check conclusion") });
  const canonicalValue = (value, name) => {
    try { return JSON.parse(canonicalBytes(value).toString("utf8")); } catch { throw new AdwError("forge", `${name} is malformed`); }
  };
  const exactObject = (value, keys, name) => {
    contract(value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, `${name} is malformed`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    contract(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${name} is malformed`);
  };
  const plainObject = (value, name) => {
    contract(value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, `${name} is malformed`);
    return value;
  };
  const compareCanonical = (left, right) => canonicalBytes(left).compare(canonicalBytes(right));
  const boundedCanonical = (value, name, maxBytes = 65_536) => {
    const normalized = canonicalValue(value, name);
    contract(canonicalBytes(normalized).length <= maxBytes, `${name} is oversized`);
    return normalized;
  };
  const sortedCanonicalArray = (value, name, max = 100) => {
    contract(Array.isArray(value) && value.length <= max, `${name} is malformed`);
    return value.map(item => boundedCanonical(item, name)).sort(compareCanonical);
  };
  const normalizeRule = input => {
    const rule = boundedCanonical(plainObject(input, "ruleset rule"), "ruleset rule");
    text(rule.type, "ruleset rule type");
    if (Object.hasOwn(rule, "parameters")) plainObject(rule.parameters, "ruleset rule parameters");
    const parameters = rule.parameters === undefined ? undefined : { ...rule.parameters };
    if (rule.type === "required_status_checks" && parameters !== undefined) {
      if (Object.hasOwn(parameters, "strict_required_status_checks_policy")) contract(typeof parameters.strict_required_status_checks_policy === "boolean", "ruleset check parameters are malformed");
      if (Object.hasOwn(parameters, "do_not_enforce_on_create")) contract(typeof parameters.do_not_enforce_on_create === "boolean", "ruleset check parameters are malformed");
      if (Object.hasOwn(parameters, "required_status_checks")) {
        contract(Array.isArray(parameters.required_status_checks) && parameters.required_status_checks.length <= 100, "ruleset check parameters are malformed");
        const checks = parameters.required_status_checks.map(inputCheck => {
          const check = { ...plainObject(inputCheck, "ruleset required check") };
          text(check.context, "ruleset check context");
          contract(check.integration_id === undefined || check.integration_id === null || (Number.isSafeInteger(check.integration_id) && check.integration_id > 0), "ruleset check integration is malformed");
          if (check.integration_id === null) delete check.integration_id;
          return boundedCanonical(check, "ruleset required check", 4096);
        }).sort((left, right) => left.context.localeCompare(right.context) || (left.integration_id ?? 0) - (right.integration_id ?? 0) || compareCanonical(left, right));
        contract(new Set(checks.map(check => `${check.context}\0${check.integration_id ?? ""}`)).size === checks.length, "ruleset required checks contain duplicates");
        parameters.required_status_checks = checks;
      }
    }
    if (rule.type === "pull_request" && parameters !== undefined) {
      if (Object.hasOwn(parameters, "required_approving_review_count")) contract(Number.isSafeInteger(parameters.required_approving_review_count) && parameters.required_approving_review_count >= 0, "ruleset pull request parameters are malformed");
      for (const key of ["require_code_owner_review", "dismiss_stale_reviews_on_push", "require_last_push_approval", "required_review_thread_resolution", "automatic_copilot_code_review_enabled"]) if (Object.hasOwn(parameters, key)) contract(typeof parameters[key] === "boolean", "ruleset pull request parameters are malformed");
      for (const key of ["allowed_merge_methods", "required_reviewers"]) if (Object.hasOwn(parameters, key)) parameters[key] = sortedCanonicalArray(parameters[key], `ruleset ${key}`);
    }
    if (rule.type === "copilot_code_review" && parameters !== undefined) for (const key of ["review_on_push", "review_draft_pull_requests"]) if (Object.hasOwn(parameters, key)) contract(typeof parameters[key] === "boolean", "ruleset Copilot parameters are malformed");
    return boundedCanonical(parameters === undefined ? rule : { ...rule, parameters }, "ruleset rule");
  };
  const normalizeRuleset = (value, expectedId) => {
    contract(value && restId(value.id, "ruleset id") === expectedId, "ruleset is malformed");
    const conditions = { ...plainObject(value.conditions, "ruleset conditions") };
    const refName = { ...plainObject(conditions.ref_name, "ruleset ref conditions") };
    for (const key of ["include", "exclude"]) {
      contract(Array.isArray(refName[key]) && refName[key].length <= 1000, "ruleset ref conditions are malformed");
      refName[key] = refName[key].map(pattern => text(pattern, "ruleset ref pattern")).sort();
    }
    conditions.ref_name = refName;
    contract(Array.isArray(value.rules) && value.rules.length <= 100 && Array.isArray(value.bypass_actors) && value.bypass_actors.length <= 100, "ruleset is malformed");
    const rules = value.rules.map(normalizeRule).sort((left, right) => left.type.localeCompare(right.type) || compareCanonical(left, right));
    const bypass = value.bypass_actors.map(inputActor => {
      const actor = plainObject(inputActor, "ruleset bypass actor");
      contract(actor.actor_id === null || (Number.isSafeInteger(actor.actor_id) && actor.actor_id > 0), "ruleset bypass actor is malformed");
      text(actor.actor_type, "ruleset bypass actor type");
      text(actor.bypass_mode, "ruleset bypass mode");
      return boundedCanonical(actor, "ruleset bypass actor", 4096);
    }).sort(compareCanonical);
    return Object.freeze(boundedCanonical({
      name: text(value.name, "ruleset name"), target: text(value.target, "ruleset target"), enforcement: text(value.enforcement, "ruleset enforcement"),
      conditions, rules, bypass_actors: bypass,
    }, "ruleset"));
  };
  const normalizeRun = value => Object.freeze({ id: restId(value.id, "run id"), name: text(value.name, "run name"), event: text(value.event, "run event"), status: text(value.status, "run status"), conclusion: value.conclusion === null ? null : text(value.conclusion, "run conclusion"), headSha: text(value.head_sha, "run head"), attempt: Number(value.run_attempt ?? 1) });
  const reviewEvidence = (comments, headSha, prId) => comments
    .map(comment => parsedReviewMarker(comment, headSha, prId, appIdentity))
    .filter(Boolean)
    .map(marker => Object.freeze({ kind: marker.kind, headSha: marker.headSha, conclusion: marker.conclusion, actorId: appIdentity.botUserId, provider: marker.provider, authoritative: true, artifactDigest: marker.artifactDigest }));
  const numericId = (value, name) => {
    contract(typeof value === "string" && /^[1-9][0-9]*$/.test(value), `${name} is invalid`);
    const number = Number(value);
    contract(Number.isSafeInteger(number), `${name} is invalid`);
    return number;
  };
  const safeSegment = (value, name) => {
    contract(typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value), `${name} is invalid`);
    return value;
  };
  const markedBody = (body, marker) => body.includes(marker) ? body : `${body}\n\n${marker}`;
  const markerMatches = (records, marker, expected, field = "body") => {
    const matches = records.filter(record => typeof record?.[field] === "string" && record[field].includes(marker));
    if (matches.length > 1) throw new AdwError("stale", "conflicting forge marker");
    if (matches.length === 0) return false;
    if (!expected(matches[0])) throw new AdwError("stale", "conflicting forge marker");
    return true;
  };
  const labelValue = value => typeof value === "string" ? value : value?.name;
  const exactLiveLabels = value => Array.isArray(value?.labels) ? value.labels.map(labelValue) : [];
  const parseLabelDefinitions = data => {
    let definitions;
    try { definitions = JSON.parse(data); } catch {
      definitions = [];
      let current = null;
      const decode = raw => {
        const value = raw.trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          try { return JSON.parse(value); } catch { throw new AdwError("contract", "trusted label definitions are malformed"); }
        }
        return value;
      };
      for (const sourceLine of data.split(/\r?\n/)) {
        const line = sourceLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        let match = /^- name:\s*(.+)$/.exec(line);
        if (match) { current = { name: decode(match[1]) }; definitions.push(current); continue; }
        match = /^(color|description):\s*(.*)$/.exec(line);
        if (!match || current === null) throw new AdwError("contract", "trusted label definitions are malformed");
        current[match[1]] = decode(match[2]);
      }
    }
    contract(Array.isArray(definitions) && definitions.length <= 100, "trusted label definitions are malformed");
    const names = new Set();
    for (const definition of definitions) {
      exactObject(definition, ["name", "color", "description"], "label definition");
      contract(typeof definition.name === "string" && definition.name.length > 0 && definition.name.length <= 50, "label definition is malformed");
      contract(typeof definition.color === "string" && /^[0-9a-fA-F]{6}$/.test(definition.color), "label definition is malformed");
      contract(typeof definition.description === "string" && definition.description.length <= 4096, "label definition is malformed");
      contract(!names.has(definition.name), "label definitions contain duplicates");
      names.add(definition.name);
    }
    return definitions.map(value => Object.freeze({ name: value.name, color: value.color.toLowerCase(), description: value.description }));
  };
  const enrichPull = async (raw, files = null, maintenance = false, fullAudit = false) => {
    const initial = normalizePull(raw);
    const pull = maintenance && !initial.merged ? normalizePull(await methods.pull(Number(initial.number))) : initial;
    const rawFiles = files ?? await methods.pullFiles(Number(pull.number));
    const changedPaths = rawFiles.map(file => text(file.filename, "changed path")).sort();
    const closing = await methods.closingIssues(Number(pull.number));
    if (pull.merged && !pull.mergeSha) throw new AdwError("forge", "merged pull lacks merge SHA");
    const obligations = pull.merged ? ["linked-work", "docs-writer"].map(roleName => Object.freeze({ role: roleName, status: "missing", artifactDigest: null, expectedArtifactDigest: null })) : [];
    const checks = maintenance && !pull.merged ? (await methods.commitChecks(pull.headSha)).map(normalizeCheck) : [];
    const comments = maintenance && !pull.merged ? await methods.comments("issues", Number(pull.number)) : [];
    const evidence = reviewEvidence(comments, pull.headSha, pull.number);
    let riskMarker = null;
    let timeline = [];
    if (fullAudit && !pull.merged) {
      const risks = [];
      for (const comment of comments) {
        const pair = pairedSemanticMarker(comment, pull.number);
        const marker = pair === null ? null : RISK_MARKER.exec(pair.semantic);
        const authored = String(comment?.user?.id ?? "") === appIdentity.botUserId && comment?.user?.login === appIdentity.login && comment?.user?.type === "Bot";
        if (!marker || marker[1] !== pull.headSha || pair.role !== "security-reviewer" || !authored) continue;
        try {
          risks.push({
            commentId: restId(comment.id, "risk comment id"), observedAt: canonicalInstant(comment.created_at, "risk comment createdAt"),
            headSha: marker[1], findingDigest: marker[2], status: marker[3], createdAt: canonicalInstant(marker[4], "risk createdAt"),
            clearedAt: marker[5] === "-" ? null : canonicalInstant(marker[5], "risk clearedAt"),
          });
        } catch { continue; }
      }
      risks.sort((left, right) => left.observedAt.localeCompare(right.observedAt) || numericId(left.commentId, "risk comment id") - numericId(right.commentId, "risk comment id"));
      if (risks.length > 0) {
        const { commentId, observedAt, ...latest } = risks.at(-1);
        riskMarker = Object.freeze(latest);
      }
      timeline = (await methods.issueTimeline(Number(pull.number))).map(value => Object.freeze({
        id: restId(value.id, "timeline id"), kind: value.event === "unlabeled" ? "label_removed" : text(value.event, "timeline event"),
        actorId: value.actor ? restId(value.actor.id, "timeline actor") : "unknown", createdAt: text(value.created_at, "timeline createdAt"),
        label: text(value.label?.name ?? "none", "timeline label"), headSha: pull.headSha,
      }));
    }
    return Object.freeze({ ...pull, changedPaths: Object.freeze(changedPaths), closingIssues: Object.freeze(closing), obligations: Object.freeze(obligations), checks: Object.freeze(checks), evidence: Object.freeze(evidence), riskMarker, timeline: Object.freeze(timeline) });
  };
  const api = {
    async readSnapshot(event) {
      const repositoryValue = await methods.repository();
      const normalizedRepository = {
        id: restId(repositoryValue.id, "repository id"),
        owner: text(repositoryValue.owner?.login, "repository owner"),
        name: text(repositoryValue.name, "repository name"),
        defaultBranch: text(repositoryValue.default_branch, "default branch"),
      };
      let entity = null;
      if (event.kind === "issue") entity = await methods.issue(Number(event.entityId));
      else if (event.kind === "issue_comment") entity = await methods.issueComment(Number(event.revisionHints.commentId));
      else if (event.kind === "pull_request") entity = await methods.pull(Number(event.entityId));
      else if (event.kind === "pull_request_review") entity = await methods.review(Number(event.entityId), Number(event.revisionHints.reviewId));
      else if (event.kind === "pull_request_review_comment") entity = await methods.reviewComment(Number(event.revisionHints.commentId));
      else if (event.kind === "check") entity = await methods.check(event.revisionHints.checkKind, Number(event.entityId));
      else if (event.kind === "workflow") entity = await methods.workflowRun(Number(event.entityId));
      else if (event.kind === "alert") entity = await methods.alert(event.revisionHints.alertKind, Number(event.entityId));
      return Object.freeze({ repository: Object.freeze(normalizedRepository), entity: entity === null ? null : normalizeResource(entity) });
    },
    async readRoleSnapshot(event, rolePolicy, { controlSha, appId } = {}) {
      const deterministic = rolePolicy?.kind === "deterministic";
      const control = rolePolicy?.kind === "control";
      if (deterministic) {
        const plan = deterministicSnapshotPlan(rolePolicy.name, event.kind);
        contract(digestJson(rolePolicy) === digestJson({ kind: "deterministic", name: rolePolicy.name, mode: "single", primary: null, patch: null, snapshot: { fields: plan.fields, maxBytes: 262144 } }), "deterministic role policy is not canonical");
      } else if (control) {
        const canonicalPolicy = controlAuthority(rolePolicy?.name);
        controlSnapshotPlan(rolePolicy.name, event.kind);
        contract(digestJson(rolePolicy) === digestJson(canonicalPolicy), "control authority policy is not canonical");
      } else {
        const canonicalPolicy = role(rolePolicy?.name);
        roleSnapshotPlan(rolePolicy.name, event.kind);
        contract(digestJson(rolePolicy) === digestJson(canonicalPolicy), "role policy is not canonical");
      }
      contract(typeof controlSha === "string" && /^[0-9a-f]{40}$/.test(controlSha), "control SHA is invalid");
      contract(appId === appIdentity.appId, "snapshot trust is invalid");
      const repositoryValue = await methods.repository();
      const repositoryOwnerId = restId(repositoryValue.owner?.id, "repository owner id");
      const normalizedRepository = {
        id: restId(repositoryValue.id, "repository id"),
        owner: text(repositoryValue.owner?.login, "repository owner"),
        name: text(repositoryValue.name, "repository name"),
        defaultBranch: text(repositoryValue.default_branch, "default branch"),
      };
      contract(normalizedRepository.id === event.repository.id && normalizedRepository.owner === event.repository.owner && normalizedRepository.name === event.repository.name, "event repository drifted");
      const fields = new Set(rolePolicy.snapshot.fields);
      for (const field of fields) if (!ADAPTER_READ_CAPABILITIES.includes(FIELD_CAPABILITY[field])) throw new AdwError("forge", `unsupported capability for field: ${field}`);
      const satisfied = new Set(["repository"]);
      const resources = {};
      const revisions = [];
      const put = (key, kind, value, token) => {
        contract(!Object.hasOwn(resources, key), "duplicate snapshot resource");
        resources[key] = value;
        revisions.push({ resource: key, kind, token: String(token ?? digestJson(value)) });
      };
      put("repository", "repository", Object.freeze(normalizedRepository), digestJson(normalizedRepository));
      const trustedPaths = deterministic
        ? ({ "settings-auditor": [".github/rulesets/main.json"], "label-sync": [".github/labels.yml"], "jam-detector": [] }[rolePolicy.name])
        : control ? [...rolePolicy.trustedPaths] : [rolePolicy.charter, rolePolicy.payloadSchema];
      if (rolePolicy.snapshot.fields.includes("spec") || rolePolicy.snapshot.fields.includes("spec_change")) trustedPaths.push("docs/SPEC.md");
      for (const path of [...new Set(trustedPaths)]) {
        const input = await methods.trustedFile(path, controlSha);
        contract(input?.encoding === "base64" && typeof input.content === "string" && typeof input.sha === "string" && /^[0-9a-f]{40}$/.test(input.sha), "trusted content is malformed");
        const encoded = input.content.replace(/\n/g, "");
        contract(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), "trusted content encoding is malformed");
        const bytes = Buffer.from(encoded, "base64");
        contract(bytes.toString("base64") === encoded, "trusted content encoding is malformed");
        let data;
        try { data = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AdwError("forge", "trusted content is not UTF-8"); }
        contract(Buffer.byteLength(data) <= 65_536, "trusted content is oversized");
        put(`trusted:${path}`, "control", contentEnvelope(data, "trusted", path), input.sha);
      }
      const issueRelated = ["issue", "issue_comment"].includes(event.kind);
      const pullRelated = ["pull_request", "pull_request_review", "pull_request_review_comment"].includes(event.kind);
      let issueValue = null;
      let pullValue = null;
      let sourceComment = null;
      let qualifyingPioneerPulls = [];
      let fileValues = [];
      if (issueRelated && ["issue", "issues", "claim", "spec", "labels", "milestones", "comment", "entity", "owner"].some(field => fields.has(field))) {
        issueValue = normalizeIssue(await methods.issue(Number(event.entityId)));
        put(`issue:${event.entityId}`, "issue", issueValue, issueValue.sourceRevision);
        const comments = (await methods.comments("issues", Number(event.entityId))).map(value => normalizeComment(value, event.entityId, normalizedRepository.id));
        put(`issue:${event.entityId}:comments`, "comments", Object.freeze(comments), digestJson(comments));
        const timeline = (await methods.issueTimeline(Number(event.entityId))).map(value => Object.freeze({ id: restId(value.id, "timeline id"), event: text(value.event, "timeline event"), actorId: value.actor ? restId(value.actor.id, "timeline actor") : null, createdAt: text(value.created_at, "timeline createdAt"), label: value.label?.name ?? null, commitSha: value.commit_id ?? null }));
        put(`issue:${event.entityId}:timeline`, "timeline", Object.freeze(timeline), digestJson(timeline));
        const parentValue = await methods.issueParent(Number(event.entityId));
        const parent = parentValue === null ? null : normalizeIssue(parentValue);
        put(`issue:${event.entityId}:parent`, "parent_issue", parent, digestJson(parent));
        const children = (await methods.subIssues(Number(event.entityId))).map(normalizeIssue);
        put(`issue:${event.entityId}:children`, "sub_issues", Object.freeze(children), digestJson(children));
        for (const field of ["issue", "claim", "spec", "labels", "comment", "entity", "owner", "route"]) if (fields.has(field)) satisfied.add(field);
        if (event.kind === "issue" && event.revisionHints.updatedAt && issueValue.updatedAt !== event.revisionHints.updatedAt) throw new AdwError("forge", "stale");
        if (event.revisionHints.commentId) {
          sourceComment = comments.find(comment => comment.id === event.revisionHints.commentId && comment.updatedAt === canonicalInstant(event.revisionHints.updatedAt, "event comment updatedAt")) ?? null;
          if (sourceComment === null) throw new AdwError("forge", "stale");
        }
      }
      if (rolePolicy.name === "pioneer" && issueValue !== null) {
        const rawPulls = await methods.pulls();
        if (rawPulls.length > 100) throw new AdwError("forge", "overflow");
        for (const rawPull of rawPulls) {
          const candidate = normalizePull(rawPull);
          const closing = await methods.closingIssues(Number(candidate.number));
          if (candidate.base === normalizedRepository.defaultBranch && candidate.headRepository === `${owner}/${name}` && closing.some(issue => issue.repositoryId === normalizedRepository.id && issue.issueId === event.entityId)) qualifyingPioneerPulls.push(Object.freeze({ prId: candidate.number, headSha: candidate.headSha, merged: candidate.merged, mergeSha: candidate.mergeSha }));
        }
        put(`issue:${event.entityId}:qualifying-pulls`, "pulls", Object.freeze(qualifyingPioneerPulls), digestJson(qualifyingPioneerPulls));
      }
      if (fields.has("issues")) {
        const issues = (await methods.issues()).filter(value => !value.pull_request).map(normalizeIssue);
        put("issues", "issues", Object.freeze(issues), digestJson(issues));
        satisfied.add("issues");
      }
      if (fields.has("pulls")) {
        const rawPulls = await methods.pulls();
        if (rawPulls.length > 100) throw new AdwError("forge", "overflow");
        const pulls = [];
        for (const rawPull of rawPulls) pulls.push(await enrichPull(rawPull, null, true, control && rolePolicy.name === "auditor"));
        put("pulls", "pulls", Object.freeze(pulls), digestJson(pulls));
        satisfied.add("pulls");
      }
      if ((deterministic || control) && fields.has("labels")) {
        const labels = (await methods.labels()).map(value => Object.freeze({ id: restId(value.id, "label id"), name: normalizedContent(value.name, `label:${value.id}:name`), color: normalizedContent(value.color, `label:${value.id}:color`), description: normalizedContent(value.description ?? "", `label:${value.id}:description`) }));
        put("labels", "labels", Object.freeze(labels), digestJson(labels));
        satisfied.add("labels");
      }
      if (fields.has("milestones")) {
        const milestones = (await methods.milestones()).map(value => Object.freeze({ id: restId(value.id, "milestone id"), number: restId(value.number, "milestone number"), state: text(value.state, "milestone state"), dueOn: value.due_on ?? null, title: normalizedContent(value.title, `milestone:${value.number}:title`), description: normalizedContent(value.description ?? "", `milestone:${value.number}:description`) }));
        put("milestones", "milestones", Object.freeze(milestones), digestJson(milestones));
        satisfied.add("milestones");
      }
      if (["pull", "diff", "files", "reviews", "security", "changed_paths", "findings", "docs", "dependency"].some(field => fields.has(field)) && pullRelated) {
        const rawPull = await methods.pull(Number(event.entityId));
        const rawFiles = await methods.pullFiles(Number(event.entityId));
        pullValue = await enrichPull(rawPull, rawFiles);
        put(`pull:${event.entityId}`, "pull", pullValue, pullValue.headSha);
        fileValues = rawFiles.map(value => normalizeFile(value, event.entityId));
        put(`pull:${event.entityId}:files`, "files", Object.freeze(fileValues), digestJson(fileValues));
        const reviews = (await methods.pullReviews(Number(event.entityId))).map(value => normalizeReview(value, event.entityId));
        put(`pull:${event.entityId}:reviews`, "reviews", Object.freeze(reviews), digestJson(reviews));
        const comments = (await methods.comments("issues", Number(event.entityId))).map(value => normalizeComment(value, event.entityId, normalizedRepository.id));
        put(`pull:${event.entityId}:comments`, "comments", Object.freeze(comments), digestJson(comments));
        const checks = (await methods.commitChecks(pullValue.headSha)).map(normalizeCheck);
        put(`pull:${event.entityId}:checks`, "checks", Object.freeze(checks), digestJson(checks));
        for (const field of ["pull", "diff", "files", "reviews", "security", "changed_paths", "findings", "docs", "dependency"]) if (fields.has(field)) satisfied.add(field);
        if (event.revisionHints.headSha && pullValue.headSha !== event.revisionHints.headSha) throw new AdwError("forge", "stale");
        if (event.revisionHints.headBranch && pullValue.headBranch !== event.revisionHints.headBranch) throw new AdwError("forge", "stale");
        if (event.revisionHints.baseRef && pullValue.base !== event.revisionHints.baseRef) throw new AdwError("forge", "stale");
        if (event.revisionHints.headRepository && pullValue.headRepository !== event.revisionHints.headRepository) throw new AdwError("forge", "stale");
        if (event.revisionHints.reviewId && !reviews.some(review => review.id === event.revisionHints.reviewId && review.headSha === event.revisionHints.headSha)) throw new AdwError("forge", "stale");
        if (rolePolicy.name === "reviser") {
          if (pullValue.headRepository !== `${owner}/${name}` || pullValue.headBranch === null) throw new AdwError("forge", "stale");
          const ref = await methods.branchRef(pullValue.headBranch);
          const refHead = text(ref.object?.sha, "pull head ref");
          if (!/^[0-9a-f]{40}$/.test(refHead) || refHead !== pullValue.headSha) throw new AdwError("forge", "stale");
          put(`ref:${pullValue.headBranch}`, "git_ref", Object.freeze({ headSha: refHead }), refHead);
        }
      }
      if (fields.has("runs") || fields.has("routes")) {
        const runs = (await methods.runs()).map(normalizeRun);
        put("runs", "workflow_runs", Object.freeze(runs), digestJson(runs));
        if (fields.has("runs")) satisfied.add("runs");
        if (fields.has("routes")) satisfied.add("routes");
      }
      if (fields.has("alert")) {
        const alertValues = event.kind === "alert"
          ? [await methods.alert(event.revisionHints.alertKind, Number(event.entityId))]
          : [...await methods.alerts("dependabot_alert"), ...await methods.alerts("code_scanning_alert")];
        const alerts = alertValues.map(alert => Object.freeze({ id: restId(alert.number, "alert id"), state: text(alert.state, "alert state"), updatedAt: text(alert.updated_at, "alert updatedAt"), details: normalizedContent(alert, `alert:${alert.number}`) }));
        put("alerts", "alerts", Object.freeze(alerts), digestJson(alerts));
        satisfied.add("alert");
        if (event.kind === "alert" && !alerts.some(alert => alert.updatedAt === event.revisionHints.updatedAt)) throw new AdwError("forge", "stale");
      }
      if (fields.has("settings") || fields.has("config")) {
        if (control && rolePolicy.name === "auditor") {
          const settings = normalizeSettings(repositoryValue);
          put("settings", "settings", settings, digestJson(settings));
        }
        const summaries = await methods.rulesets();
        if (summaries.length > 100) throw new AdwError("forge", "overflow");
        const ids = summaries.map(summary => restId(summary.id, "ruleset id"));
        if (new Set(ids).size !== ids.length) throw new AdwError("forge", "duplicate ruleset id");
        const rulesets = [];
        for (const rulesetId of ids) rulesets.push(normalizeRuleset(await methods.ruleset(Number(rulesetId)), rulesetId));
        rulesets.sort((a, b) => a.name.localeCompare(b.name));
        put("rulesets", "settings", Object.freeze(rulesets), digestJson(rulesets));
        if (fields.has("settings")) satisfied.add("settings");
        if (fields.has("config")) satisfied.add("config");
      }
      if (fields.has("spec_change")) satisfied.add("spec_change");
      if (event.kind === "push") {
        const ref = await methods.branchRef(normalizedRepository.defaultBranch);
        const liveHead = text(ref.object?.sha, "branch head");
        if (liveHead !== event.revisionHints.headSha) throw new AdwError("forge", "stale");
        put(`ref:${normalizedRepository.defaultBranch}`, "git_ref", Object.freeze({ headSha: liveHead }), liveHead);
      }
      let patchBase = null;
      if (rolePolicy.patch !== null && rolePolicy.name !== "reviser") {
        const ref = await methods.branchRef(normalizedRepository.defaultBranch);
        patchBase = text(ref.object?.sha, "patch base head");
        contract(/^[0-9a-f]{40}$/.test(patchBase), "patch base head is malformed");
        put(`patch-base:${normalizedRepository.defaultBranch}`, "git_ref", Object.freeze({ headSha: patchBase }), patchBase);
      }
      for (const field of fields) if (!satisfied.has(field)) throw new AdwError("forge", `unsupported role field: ${field}`);
      const labels = issueValue?.labels ?? pullValue?.labels ?? [];
      const protectedPrefixes = ["adw/", ".agents/", ".claude/", ".github/", ".pi/"];
      const protectedFiles = ["docs/SPEC.md", "docs/PROJECT-INVARIANTS.md"];
      const protectedPath = path => protectedPrefixes.some(prefix => path.startsWith(prefix)) || protectedFiles.includes(path) || ["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1));
      const missingPatches = fileValues.filter(file => file.patch.data === "");
      const input = {
        protected: fileValues.some(file => [file.path, file.previousPath].some(path => path !== null && protectedPath(path))),
        incomplete: missingPatches.length > 0,
        fork: pullValue ? pullValue.headRepository !== `${owner}/${name}` : false,
        binary: missingPatches.length > 0,
        oversized: false,
      };
      let reconciliation = null;
      if (control && rolePolicy.name === "reconciler") {
        const markerComments = [];
        const issueComments = new Map();
        for (const issue of resources.issues ?? []) {
          const values = (await methods.comments("issues", Number(issue.number))).map(value => normalizeComment(value, issue.number, normalizedRepository.id));
          issueComments.set(issue.number, values);
          markerComments.push(...values);
        }
        for (const pull of resources.pulls ?? []) {
          const values = (await methods.comments("issues", Number(pull.number))).map(value => normalizeComment(value, pull.number, normalizedRepository.id));
          markerComments.push(...values);
        }
        if (markerComments.length > 1000) throw new AdwError("forge", "overflow");
        markerComments.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || numericId(left.id, "comment id") - numericId(right.id, "comment id"));
        const routes = [];
        for (const issue of resources.issues ?? []) {
          const byAuthorityOrder = (left, right) => left.comment.createdAt.localeCompare(right.comment.createdAt) || numericId(left.comment.id, "comment id") - numericId(right.comment.id, "comment id");
          const attempts = (issueComments.get(issue.number) ?? []).map(comment => {
            if (comment.actorId !== appIdentity.botUserId) return null;
            const match = new RegExp(`^<!-- smith:claude-attempt/v1 issue=${issue.number} branch=claude/issue-${issue.number} head=([0-9a-f]{40}) outcome=(success|failure|cancelled|skipped) -->$`).exec(comment.body.data);
            return match ? { comment, outcome: match[2] } : null;
          }).filter(Boolean).sort(byAuthorityOrder);
          if (attempts.length === 0 || attempts.at(-1).outcome === "success") continue;
          const routeMarkers = (issueComments.get(issue.number) ?? []).map(comment => {
            if (comment.actorId !== appIdentity.botUserId) return null;
            const match = new RegExp(`^<!-- smith:builder-route/v1 issue=${issue.number} id=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} source=claude/issue-${issue.number} target=codex/issue-${issue.number} phase=(prepared|armed|completed|cancelled) -->$`).exec(comment.body.data);
            return match ? { comment, phase: match[1] } : null;
          }).filter(Boolean).sort(byAuthorityOrder);
          const phase = routeMarkers.at(-1)?.phase ?? null;
          if (phase === "completed") continue;
          routes.push(Object.freeze({
            issueId: issue.number, sourceRevision: issue.sourceRevision,
            status: phase === "armed" ? "fallback" : phase === "cancelled" ? "blocked" : "primary",
            primary: "claude", fallback: "codex", primaryOutcome: "provider_failure",
            fallbackOutcome: phase === "cancelled" ? "provider_failure" : null, artifactDigest: null, prId: null,
          }));
        }
        const trustedPulls = (resources.pulls ?? []).filter(pull => pull.headRepository === `${owner}/${name}` && pull.base === normalizedRepository.defaultBranch).map(pull => Object.freeze({
          prId: pull.number, repositoryId: normalizedRepository.id, headRepositoryId: normalizedRepository.id, base: pull.base,
          closingIssues: pull.closingIssues, headSha: pull.headSha, merged: pull.merged, mergeSha: pull.mergeSha, obligations: pull.obligations,
        }));
        const pioneerEvidence = body => String(body ?? "").split(/\r?\n/).map(line => PIONEER_MARKER.exec(line)).filter(Boolean).map(match => ({ issueId: match[1], sourceRevision: match[2], verdict: match[3], artifactDigest: match[4] === "-" ? null : match[4] }));
        const pioneers = [];
        for (const issue of resources.issues ?? []) {
          const evidence = [];
          for (const comment of issueComments.get(issue.number) ?? []) {
            if (comment.actorId !== appIdentity.botUserId) continue;
            for (const marker of pioneerEvidence(comment.body.data)) if (marker.issueId === issue.number) evidence.push({ ...marker, observedAt: comment.createdAt, closingPrId: null });
          }
          for (const pull of resources.pulls ?? []) {
            if (pull.headRepository !== `${owner}/${name}` || pull.base !== normalizedRepository.defaultBranch || pull.actorId !== appIdentity.botUserId || pull.actorLogin !== appIdentity.login || pull.actorType !== "Bot") continue;
            for (const marker of pioneerEvidence(pull.body?.data)) {
              if (marker.issueId !== issue.number) continue;
              const closes = pull.closingIssues.some(candidate => candidate.repositoryId === normalizedRepository.id && candidate.issueId === issue.number);
              evidence.push({ ...marker, observedAt: pull.updatedAt, closingPrId: marker.verdict === "proved" && closes ? pull.number : null });
            }
          }
          evidence.sort((left, right) => left.observedAt.localeCompare(right.observedAt) || digestJson(left).localeCompare(digestJson(right)));
          const latest = evidence.at(-1) ?? null;
          if (latest === null && !issue.labels.includes("needs:prototype")) continue;
          let verdict = latest?.verdict ?? "missing";
          let artifactDigest = latest?.artifactDigest ?? null;
          let closingPrId = latest?.closingPrId ?? null;
          if (verdict === "proved" && closingPrId === null) { verdict = "missing"; artifactDigest = null; }
          if (verdict === "inconclusive") artifactDigest = null;
          pioneers.push(Object.freeze({ issueId: issue.number, sourceRevision: latest?.sourceRevision ?? issue.sourceRevision, verdict, artifactDigest, closingPrId }));
        }
        pioneers.sort((left, right) => left.issueId.localeCompare(right.issueId));
        const pioneerIds = new Set(pioneers.map(pioneer => pioneer.issueId));
        const reviews = (resources.pulls ?? []).filter(pull => !pull.merged && pull.headRepository === `${owner}/${name}` && pull.base === normalizedRepository.defaultBranch).map(pull => Object.freeze({ prId: pull.number, headSha: pull.headSha, evidence: pull.evidence, protectedInput: pull.changedPaths.some(path => path.startsWith("adw/") || path.startsWith(".github/") || path === "docs/SPEC.md") }));
        const holds = [];
        for (const issue of resources.issues ?? []) {
          const reasons = holdReasons(issue.labels).filter(reason => !(reason === "needs:prototype" && pioneerIds.has(issue.number)));
          if (reasons.length > 0) holds.push(Object.freeze({ entityId: `issue:${issue.number}`, reasons }));
        }
        for (const pull of resources.pulls ?? []) {
          const reasons = holdReasons(pull.labels);
          if (reasons.length > 0) holds.push(Object.freeze({ entityId: `pr:${pull.number}`, reasons }));
        }
        const definitionSource = resources["trusted:.github/labels.yml"]?.data;
        const definitions = parseLabelDefinitions(definitionSource);
        const liveByName = new Map((resources.labels ?? []).map(label => [label.name.data, { name: label.name.data, color: label.color.data.toLowerCase(), description: label.description.data }]));
        const projectedLabels = definitions.map(definition => liveByName.get(definition.name) ?? null);
        reconciliation = Object.freeze({
          routes: Object.freeze(routes), pulls: Object.freeze(trustedPulls),
          labelSync: Object.freeze({ wantedDigest: digestJson(definitions), liveDigest: digestJson(projectedLabels) }),
          comments: Object.freeze(markerComments), trust: Object.freeze({ ownerIds: [repositoryOwnerId], appId: appIdentity.botUserId }),
          reviews: Object.freeze(reviews), pioneers: Object.freeze(pioneers), holds: Object.freeze(holds),
        });
      }
      const state = {
        entityId: event.entityId, labels, input: Object.freeze(input), resources: Object.freeze(resources),
        actionTargets: Object.freeze(resources.runs?.map(run => run.id) ?? []),
        ownerAuthenticated: event.kind === "issue_comment" && sourceComment !== null && /(^|\s)@smith\b/.test(sourceComment.body.data) && event.actor.type === "User" && event.actor.login === normalizedRepository.owner && event.actor.id === repositoryOwnerId,
        closingArtifactQualifies: qualifyingPioneerPulls.length > 0,
        trust: Object.freeze({ ownerIds: [repositoryOwnerId], appId: appIdentity.botUserId }),
      };
      if (reconciliation !== null) {
        state.currentRevisions = Object.freeze(Object.fromEntries((resources.issues ?? []).map(issue => [`issue:${issue.number}`, issue.sourceRevision])));
        state.reconciliation = reconciliation;
      }
      if (pullValue) {
        state.headSha = pullValue.headSha;
        state.headBranch = pullValue.headBranch;
        state.headRepository = pullValue.headRepository;
        state.changedPaths = pullValue.changedPaths;
      }
      if (patchBase !== null) {
        const source = issueValue ?? pullValue;
        contract(source !== null, "patch role lacks source entity");
        state.baseBranch = normalizedRepository.defaultBranch;
        state.headBranch = rolePolicy.name === "docs-writer" ? `docs/pr-${event.entityId}` : rolePolicy.name === "pioneer" ? `pioneer/issue-${event.entityId}` : `${rolePolicy.primary}/issue-${event.entityId}`;
        state.title = source.title;
        state.body = issueValue && (rolePolicy.name === "builder" || rolePolicy.name === "codex-builder" || rolePolicy.name === "pioneer")
          ? normalizedContent(`${source.body.data}\n\nCloses #${event.entityId}`, `issue:${event.entityId}:pr-body`)
          : source.body;
      }
      let snapshot;
      try {
        snapshot = validateSnapshot({
          schemaVersion: 1, controlSha,
          event: { kind: event.kind, action: event.action, entityId: event.entityId },
          repository: normalizedRepository,
          revisions: revisions.sort((a, b) => a.resource.localeCompare(b.resource)),
          routing: { role: rolePolicy.name, mode: rolePolicy.mode, primary: rolePolicy.primary },
          state,
        });
      } catch (error) {
        if (error?.code === "contract" && error.message === "snapshot is oversized") throw new AdwError("forge", "overflow");
        throw error;
      }
      if (canonicalBytes(snapshot).length > rolePolicy.snapshot.maxBytes) throw new AdwError("forge", "overflow");
      return snapshot;
    },
    readDeterministicSnapshot(event, name, options) {
      const plan = deterministicSnapshotPlan(name, event.kind);
      return api.readRoleSnapshot(event, Object.freeze({ kind: "deterministic", name, mode: "single", primary: null, patch: null, snapshot: { fields: plan.fields, maxBytes: 262144 } }), options);
    },
    readControlSnapshot(event, name, options) {
      controlSnapshotPlan(name, event.kind);
      return api.readRoleSnapshot(event, controlAuthority(name), options);
    },
    async applyOperation({ operation, snapshot, verification, verifyOnly = false, recordOnly = false, binding = null }) {
      const value = validateOperation(operation, policy);
      operationCapabilities(value);
      if (value.type === "create_branch") throw new AdwError("contract", "operation is VCS-owned");
      if (value.type === "update_pr" && value.headSha !== undefined) throw new AdwError("contract", "pull head projection is VCS-owned");
      const trustedSnapshot = validateSnapshot(snapshot);
      const proof = validateVerification(verification);
      contract(proof.controlSha === trustedSnapshot.controlSha, "verification control SHA does not match");
      contract(proof.preconditionDigest === digestJson(trustedSnapshot.revisions), "verification precondition does not match");
      if (value.type === "noop") return Object.freeze({ state: "complete", revision: proof.preconditionDigest });
      if (value.type === "terminal") throw new AdwError("terminal", value.reason);
      if (token === null && !recordOnly) throw new AdwError("forge", "auth");

      const cache = new Map();
      const get = async endpoint => {
        if (!cache.has(endpoint)) cache.set(endpoint, page(endpoint));
        return cache.get(endpoint);
      };
      const optionalGet = async endpoint => {
        try { return await get(endpoint); }
        catch (error) { if (error?.code === "forge" && error.message === "not_found") return null; throw error; }
      };
      const list = async (endpoint, key = null) => {
        const records = [];
        for (let number = 1; number <= 10; number++) {
          const separator = endpoint.includes("?") ? "&" : "?";
          const response = await get(`${endpoint}${separator}per_page=100&page=${number}`);
          const values = key === null ? response : response?.[key];
          if (!Array.isArray(values)) throw new AdwError("forge", "malformed");
          records.push(...values);
          if (records.length > 1000) throw new AdwError("forge", "overflow");
          if (values.length < 100) return records;
        }
        throw new AdwError("forge", "overflow");
      };
      const issueAt = async id => {
        const issue = await get(`/repos/${owner}/${name}/issues/${numericId(id, "issue id")}`);
        if (String(issue?.number ?? "") !== id) throw new AdwError("forge", "malformed");
        return issue;
      };
      const pullAt = async id => {
        const pull = await get(`/repos/${owner}/${name}/pulls/${numericId(id, "pull id")}`);
        if (String(pull?.number ?? "") !== id) throw new AdwError("forge", "malformed");
        return pull;
      };
      const commentsAt = id => list(`/repos/${owner}/${name}/issues/${numericId(id, "entity id")}/comments`);
      const allIssues = () => list(`/repos/${owner}/${name}/issues?state=all`);
      const allPulls = () => list(`/repos/${owner}/${name}/pulls?state=all`);
      const allMilestones = () => list(`/repos/${owner}/${name}/milestones?state=all`);
      const milestoneById = async id => {
        numericId(id, "milestone id");
        const matches = (await allMilestones()).filter(milestone => String(milestone?.id ?? "") === id);
        if (matches.length !== 1 || !Number.isSafeInteger(matches[0].number) || matches[0].number < 1) throw new AdwError("forge", "malformed");
        return Object.freeze({ value: matches[0], number: matches[0].number });
      };
      const allLabels = () => list(`/repos/${owner}/${name}/labels`);
      const allRuns = () => list(`/repos/${owner}/${name}/actions/runs`, "workflow_runs");
      const appAuthored = record => String(record?.user?.id ?? "") === appIdentity.botUserId && record?.user?.login === appIdentity.login && record?.user?.type === "Bot";
      const appCheck = record => String(record?.app?.id ?? "") === appIdentity.appId && record?.app?.slug === appIdentity.slug;
      const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));

      let complete = false;
      let prepared = null;
      let preWrite = null;
      let syncTransition = null;
      if (value.type === "comment") {
        const expected = markedBody(value.body, value.marker);
        complete = markerMatches(await commentsAt(value.entityId), value.marker, record => appAuthored(record) && record.body === expected);
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.entityId, "entity id")}/comments`, body: { body: expected } };
      } else if (value.type === "add_label" || value.type === "remove_label") {
        const issue = await issueAt(value.entityId);
        const present = exactLiveLabels(issue).includes(value.label);
        complete = value.type === "add_label" ? present : !present;
        prepared = value.type === "add_label"
          ? { method: "POST", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.entityId, "entity id")}/labels`, body: { labels: [value.label] } }
          : { method: "DELETE", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.entityId, "entity id")}/labels/${encodeURIComponent(value.label)}`, body: {} };
      } else if (value.type === "create_issue" || value.type === "report_drift") {
        const labels = value.type === "create_issue" ? value.labels : [];
        const expected = markedBody(value.body, value.marker);
        complete = markerMatches((await allIssues()).filter(issue => !issue.pull_request), value.marker, issue => appAuthored(issue) && issue.title === value.title && issue.body === expected && canonicalBytes(exactLiveLabels(issue).sort()).equals(canonicalBytes([...labels].sort())));
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/issues`, body: { title: value.title, body: expected, labels } };
      } else if (value.type === "update_issue") {
        contract(value.title !== undefined || value.body !== undefined, "issue update is empty");
        const issue = await issueAt(value.issueId);
        const wanted = Object.fromEntries(["title", "body"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
        complete = Object.entries(wanted).every(([key, expected]) => issue?.[key] === expected);
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.issueId, "issue id")}`, body: wanted };
      } else if (value.type === "close_issue") {
        const issue = await issueAt(value.issueId);
        complete = issue?.state === "closed" && (issue.state_reason === undefined || issue.state_reason === value.reason);
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.issueId, "issue id")}`, body: { state: "closed", state_reason: value.reason } };
      } else if (value.type === "create_milestone") {
        const expected = markedBody(value.description, value.marker);
        complete = markerMatches(await allMilestones(), value.marker, milestone => String(milestone.creator?.id ?? "") === appIdentity.botUserId && milestone.creator?.login === appIdentity.login && milestone.creator?.type === "Bot" && milestone.title === value.title && milestone.description === expected && (value.dueOn === undefined || milestone.due_on === value.dueOn), "description");
        const body = { title: value.title, description: expected };
        if (value.dueOn !== undefined) body.due_on = value.dueOn;
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/milestones`, body };
      } else if (value.type === "update_milestone") {
        contract(value.title !== undefined || value.description !== undefined || value.dueOn !== undefined, "milestone update is empty");
        const milestone = await milestoneById(value.milestoneId);
        const body = {};
        if (value.title !== undefined) body.title = value.title;
        if (value.description !== undefined) body.description = value.description;
        if (value.dueOn !== undefined) body.due_on = value.dueOn;
        complete = Object.entries(body).every(([key, expected]) => milestone.value?.[key] === expected);
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/milestones/${milestone.number}`, body };
      } else if (value.type === "close_milestone") {
        const milestone = await milestoneById(value.milestoneId);
        complete = milestone.value?.state === "closed";
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/milestones/${milestone.number}`, body: { state: "closed" } };
      } else if (value.type === "assign_milestone") {
        const milestone = await milestoneById(value.milestoneId);
        const issue = await issueAt(value.issueId);
        complete = String(issue?.milestone?.id ?? "") === value.milestoneId && issue?.milestone?.number === milestone.number;
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.issueId, "issue number")}`, body: { milestone: milestone.number } };
      } else if (value.type === "link_sub_issue") {
        const child = await issueAt(value.childId);
        const childDatabaseId = positiveInteger(child.id);
        const children = await list(`/repos/${owner}/${name}/issues/${numericId(value.parentId, "parent number")}/sub_issues`);
        complete = children.some(candidate => candidate?.number === numericId(value.childId, "child number"));
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/issues/${numericId(value.parentId, "parent number")}/sub_issues`, body: { sub_issue_id: childDatabaseId } };
      } else if (value.type === "create_pr") {
        contract(/^[A-Za-z0-9._/-]+$/.test(value.head) && !value.head.includes("..") && /^[A-Za-z0-9._/-]+$/.test(value.base) && !value.base.includes(".."), "pull ref is invalid");
        const expected = markedBody(value.body, value.marker);
        complete = markerMatches(await allPulls(), value.marker, pull => appAuthored(pull) && pull.title === value.title && pull.body === expected && pull.head?.ref === value.head && pull.base?.ref === value.base);
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/pulls`, body: { head: value.head, base: value.base, title: value.title, body: expected } };
      } else if (value.type === "update_pr") {
        contract(value.title !== undefined || value.body !== undefined, "pull update is empty");
        const pull = await pullAt(value.prId);
        const body = Object.fromEntries(["title", "body"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
        complete = Object.entries(body).every(([key, expected]) => pull?.[key] === expected);
        prepared = { method: "PATCH", endpoint: `/repos/${owner}/${name}/pulls/${numericId(value.prId, "pull id")}`, body };
      } else if (value.type === "publish_check") {
        const checks = await list(`/repos/${owner}/${name}/commits/${value.headSha}/check-runs?filter=all`, "check_runs");
        const matches = checks.filter(check => check.external_id === value.externalId);
        if (matches.length > 1) throw new AdwError("stale", "conflicting external id");
        if (matches.length === 1) {
          const check = matches[0];
          if (!appCheck(check) || check.name !== value.name || check.head_sha !== value.headSha || check.status !== "completed" || check.conclusion !== value.conclusion || check.output?.title !== value.name || check.output?.summary !== value.summary) throw new AdwError("stale", "conflicting external id");
          complete = true;
        }
        prepared = { method: "POST", endpoint: `/repos/${owner}/${name}/check-runs`, body: { name: value.name, head_sha: value.headSha, status: "completed", conclusion: value.conclusion, output: { title: value.name, summary: value.summary }, external_id: value.externalId } };
      } else if (value.type === "rerun_check" || value.type === "dispatch_workflow") {
        contract(binding !== null, "action operation binding is missing");
        let action;
        let target;
        let delivered;
        let actionReady = true;
        if (value.type === "rerun_check") {
          const run = await get(`/repos/${owner}/${name}/actions/runs/${numericId(value.runId, "run number")}`);
          const original = trustedSnapshot.state.resources?.runs?.find(item => item.id === value.runId);
          contract(original && Number.isSafeInteger(original.attempt) && original.attempt > 0 && String(run?.id ?? "") === value.runId && original.headSha === run.head_sha && original.name === run.name && original.event === run.event, "rerun source does not match snapshot");
          actionReady = original.attempt === run.run_attempt;
          target = Object.freeze({ type: "rerun_check", runId: value.runId, name: original.name, event: original.event, headSha: original.headSha, attempt: original.attempt });
          action = { method: "POST", endpoint: `/repos/${owner}/${name}/actions/runs/${numericId(value.runId, "run number")}/rerun`, body: {} };
          delivered = async markerTime => {
            const fresh = await page(`/repos/${owner}/${name}/actions/runs/${numericId(value.runId, "run number")}`);
            return String(fresh?.id ?? "") === target.runId && fresh?.name === target.name && fresh?.event === target.event && fresh?.head_sha === target.headSha && fresh?.run_attempt === target.attempt + 1
              && String(fresh?.triggering_actor?.id ?? "") === appIdentity.botUserId && fresh?.triggering_actor?.login === appIdentity.login && fresh?.triggering_actor?.type === "Bot"
              && validTime(fresh?.updated_at) && Date.parse(fresh.updated_at) >= Date.parse(markerTime);
          };
        } else {
          const workflow = safeSegment(value.workflow, "workflow");
          contract(/^[A-Za-z0-9._/-]+$/.test(value.ref) && !value.ref.includes(".."), "workflow ref is invalid");
          contract(!Object.hasOwn(value.inputs, "smith_operation_digest"), "workflow inputs use reserved operation digest");
          const ref = await get(`/repos/${owner}/${name}/git/ref/heads/${value.ref.split("/").map(encodeURIComponent).join("/")}`);
          const headSha = text(ref.object?.sha, "dispatch head");
          const inputs = Object.freeze({ ...value.inputs, smith_operation_digest: binding.operationDigest });
          const path = `.github/workflows/${workflow}`;
          target = Object.freeze({ type: "dispatch_workflow", path, ref: value.ref, headSha, inputs });
          action = { method: "POST", endpoint: `/repos/${owner}/${name}/actions/workflows/${workflow}/dispatches`, body: { ref: value.ref, inputs } };
          delivered = async markerTime => {
            const response = await page(`/repos/${owner}/${name}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&page=1`);
            if (!Array.isArray(response?.workflow_runs) || response.workflow_runs.length >= 100) throw new AdwError("forge", "overflow");
            const matches = response.workflow_runs.filter(run => run?.path === target.path && run?.head_branch === target.ref && run?.head_sha === target.headSha && run?.event === "workflow_dispatch" && run?.display_title === binding.operationDigest
              && String(run?.triggering_actor?.id ?? "") === appIdentity.botUserId && run?.triggering_actor?.login === appIdentity.login && run?.triggering_actor?.type === "Bot"
              && validTime(run?.created_at) && Date.parse(run.created_at) >= Date.parse(markerTime));
            return matches.length === 1;
          };
        }
        const externalId = `smith-action:${binding.decisionDigest}:${binding.operationIndex}:${binding.operationDigest}`;
        const summary = canonicalBytes({ role: binding.role, decisionDigest: binding.decisionDigest, operationIndex: binding.operationIndex, operationDigest: binding.operationDigest, target }).toString("utf8");
        const markers = (await list(`/repos/${owner}/${name}/commits/${trustedSnapshot.controlSha}/check-runs?filter=all`, "check_runs")).filter(check => check.external_id === externalId);
        if (markers.length > 1) throw new AdwError("stale", "conflicting action markers");
        const verifyMarker = (marker, status) => appCheck(marker) && marker.name === "smith/apply-action" && marker.external_id === externalId && marker.head_sha === trustedSnapshot.controlSha && marker.status === status
          && marker.conclusion === (status === "completed" ? "success" : null) && marker.output?.title === "smith/apply-action" && marker.output?.summary === summary && validTime(marker.created_at);
        const completeMarker = async (markerId, markerTime) => {
          await mutate("PATCH", `/repos/${owner}/${name}/check-runs/${markerId}`, { status: "completed", conclusion: "success", output: { title: "smith/apply-action", summary } });
          const completed = await page(`/repos/${owner}/${name}/check-runs/${markerId}`);
          if (!verifyMarker(completed, "completed") || completed.created_at !== markerTime) throw new AdwError("stale", "completed action marker was not verified");
        };
        if (markers.length === 1) {
          const marker = markers[0];
          if (verifyMarker(marker, "completed")) complete = true;
          else if (verifyMarker(marker, "in_progress")) {
            if (!await delivered(marker.created_at)) throw new AdwError("terminal", "action delivery cannot be proven; refusing retry");
            const markerId = numericId(String(marker.id ?? ""), "action marker number");
            prepared = { execute: async observePrepared => { await observePrepared(); await completeMarker(markerId, marker.created_at); } };
          } else throw new AdwError("stale", "conflicting action marker");
        } else {
          contract(actionReady, "rerun source does not match snapshot");
          prepared = {
            execute: async observePrepared => {
              const marker = await mutate("POST", `/repos/${owner}/${name}/check-runs`, { name: "smith/apply-action", head_sha: trustedSnapshot.controlSha, status: "in_progress", output: { title: "smith/apply-action", summary }, external_id: externalId });
              const markerId = numericId(String(marker?.id ?? ""), "action marker number");
              const liveMarker = await page(`/repos/${owner}/${name}/check-runs/${markerId}`);
              if (!verifyMarker(liveMarker, "in_progress")) throw new AdwError("stale", "prepared action marker was not verified");
              await observePrepared();
              await mutate(action.method, action.endpoint, action.body);
              if (!await delivered(liveMarker.created_at)) throw new AdwError("terminal", "action delivery cannot be proven; refusing retry");
              await completeMarker(markerId, liveMarker.created_at);
            },
          };
        }
      } else if (value.type === "arm_auto_merge") {
        const assertMergeAuthority = async fresh => {
          const pull = fresh ? await page(`/repos/${owner}/${name}/pulls/${numericId(value.prId, "pull id")}`) : await pullAt(value.prId);
          if (pull?.state !== "open" || pull?.draft !== false || pull?.mergeable_state?.toLowerCase() !== "clean" || pull?.head?.sha !== value.headSha || holdReasons(exactLiveLabels(pull)).length !== 0) throw new AdwError("stale", "auto-merge precondition failed");
          const checkResponse = await page(`/repos/${owner}/${name}/commits/${value.headSha}/check-runs?filter=latest&per_page=100&page=1`);
          const checks = checkResponse?.check_runs;
          if (!Array.isArray(checks) || checks.length >= 100) throw new AdwError("forge", "overflow");
          const required = checks.filter(check => check.name === "check" && check.head_sha === value.headSha);
          if (required.length !== 1 || required[0].status !== "completed" || required[0].conclusion !== "success"
              || String(required[0].app?.id ?? "") !== GITHUB_ACTIONS_APP_ID || required[0].app?.slug !== "github-actions") throw new AdwError("stale", "auto-merge check failed");
          const commentResponse = await page(`/repos/${owner}/${name}/issues/${numericId(value.prId, "pull number")}/comments?per_page=100&page=1`);
          if (!Array.isArray(commentResponse) || commentResponse.length >= 100) throw new AdwError("forge", "overflow");
          validateAutoMergeMarkers({
            comments: commentResponse,
            headSha: value.headSha,
            prId: value.prId,
            appIdentity,
            ownerIds: trustedSnapshot.state.trust?.ownerIds ?? [],
            ownerLogin: trustedSnapshot.repository.owner,
          });
          return pull;
        };
        const pull = await pullAt(value.prId);
        if (pull?.auto_merge?.merge_method === "squash") complete = pull.head?.sha === value.headSha;
        if (!complete) await assertMergeAuthority(false);
        prepared = {
          execute: async observePrepared => {
            await observePrepared();
            const fresh = await assertMergeAuthority(true);
            const pullNodeId = text(fresh?.node_id, "pull node ID");
            await enablePullRequestAutoMerge(pullNodeId);
            const post = await page(`/repos/${owner}/${name}/pulls/${numericId(value.prId, "pull id")}`);
            if (post?.state !== "open" || post?.head?.sha !== value.headSha || post?.auto_merge?.merge_method !== "squash") throw new AdwError("stale", "auto-merge postcondition was not reached");
          },
        };
      } else if (value.type === "sync_labels") {
        const resource = trustedSnapshot.state.resources?.["trusted:.github/labels.yml"];
        contract(resource?.trust === "trusted" && resource.source === ".github/labels.yml" && typeof resource.data === "string" && resource.bytes === canonicalBytes(resource.data).length && resource.digest === digestJson(resource.data), "trusted label source is invalid");
        const control = await get(`/repos/${owner}/${name}/contents/.github/labels.yml?ref=${trustedSnapshot.controlSha}`);
        contract(control?.encoding === "base64" && typeof control.content === "string" && typeof control.sha === "string" && /^[0-9a-f]{40}$/.test(control.sha), "trusted label source is invalid");
        const encoded = control.content.replace(/\s/g, "");
        contract(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), "trusted label source encoding is invalid");
        const bytes = Buffer.from(encoded, "base64");
        contract(bytes.toString("base64") === encoded, "trusted label source encoding is invalid");
        let controlData;
        try { controlData = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AdwError("forge", "trusted content is not UTF-8"); }
        contract(controlData === resource.data && digestJson(controlData) === resource.digest, "trusted label source changed");
        const definitions = parseLabelDefinitions(controlData);
        if (digestJson(definitions) !== value.definitionsDigest) throw new AdwError("stale", "label definition digest changed");
        const live = await allLabels();
        syncTransition = Object.freeze({ definitions });
        const wanted = new Set(definitions.map(definition => definition.name));
        contract(wanted.size === definitions.length, "trusted label definitions are malformed");
        prepared = definitions.filter(definition => {
          const found = live.find(label => label.name === definition.name);
          return !found || found.color?.toLowerCase() !== definition.color || (found.description ?? "") !== definition.description;
        }).map(definition => {
          const exists = live.some(label => label.name === definition.name);
          return exists
            ? { method: "PATCH", endpoint: `/repos/${owner}/${name}/labels/${encodeURIComponent(definition.name)}`, body: { new_name: definition.name, color: definition.color, description: definition.description }, label: definition }
            : { method: "POST", endpoint: `/repos/${owner}/${name}/labels`, body: definition, label: definition };
        });
        complete = prepared.length === 0;
      }

      const revisionToken = async revision => {
        const resource = revision.resource;
        let match;
        if (resource === "repository") {
          const live = await get(`/repos/${owner}/${name}`);
          return digestJson({ id: restId(live.id, "repository id"), owner: text(live.owner?.login, "repository owner"), name: text(live.name, "repository name"), defaultBranch: text(live.default_branch, "default branch") });
        }
        if ((match = /^trusted:(.+)$/.exec(resource))) {
          const trusted = await get(`/repos/${owner}/${name}/contents/${match[1].split("/").map(encodeURIComponent).join("/")}?ref=${trustedSnapshot.controlSha}`);
          return text(trusted.sha, "trusted content SHA");
        }
        if ((match = /^issue:([1-9][0-9]*)$/.exec(resource))) return issueSourceRevision(await issueAt(match[1]));
        if ((match = /^pull:([1-9][0-9]*)$/.exec(resource))) return text((await pullAt(match[1])).head?.sha, "pull revision");
        if ((match = /^(?:patch-base:|ref:)(.+)$/.exec(resource))) {
          const branch = match[1];
          contract(/^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes(".."), "branch is invalid");
          return text((await get(`/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)).object?.sha, "ref revision");
        }
        if ((match = /^issue:([1-9][0-9]*):comments$/.exec(resource)) || (match = /^pull:([1-9][0-9]*):comments$/.exec(resource))) {
          const values = (await commentsAt(match[1])).map(item => normalizeComment(item, match[1], trustedSnapshot.repository.id));
          return digestJson(values);
        }
        if ((match = /^issue:([1-9][0-9]*):timeline$/.exec(resource))) {
          const values = (await list(`/repos/${owner}/${name}/issues/${match[1]}/timeline`)).map(item => Object.freeze({ id: restId(item.id, "timeline id"), event: text(item.event, "timeline event"), actorId: item.actor ? restId(item.actor.id, "timeline actor") : null, createdAt: text(item.created_at, "timeline createdAt"), label: item.label?.name ?? null, commitSha: item.commit_id ?? null }));
          return digestJson(values);
        }
        if ((match = /^issue:([1-9][0-9]*):parent$/.exec(resource))) {
          const parent = await optionalGet(`/repos/${owner}/${name}/issues/${match[1]}/parent`);
          return digestJson(parent === null ? null : normalizeIssue(parent));
        }
        if ((match = /^issue:([1-9][0-9]*):children$/.exec(resource))) return digestJson((await list(`/repos/${owner}/${name}/issues/${match[1]}/sub_issues`)).map(normalizeIssue));
        if ((match = /^issue:([1-9][0-9]*):qualifying-pulls$/.exec(resource))) {
          const values = [];
          for (const raw of await allPulls()) {
            const candidate = normalizePull(raw);
            const closing = await methods.closingIssues(Number(candidate.number));
            if (candidate.base === trustedSnapshot.repository.defaultBranch && candidate.headRepository === `${owner}/${name}` && closing.some(issue => issue.repositoryId === trustedSnapshot.repository.id && issue.issueId === match[1])) values.push(Object.freeze({ prId: candidate.number, headSha: candidate.headSha, merged: candidate.merged, mergeSha: candidate.mergeSha }));
          }
          return digestJson(values);
        }
        if (resource === "issues") return digestJson((await allIssues()).filter(item => !item.pull_request).map(normalizeIssue));
        if (resource === "pulls") {
          const values = [];
          for (const raw of await allPulls()) values.push(await enrichPull(raw, null, true, trustedSnapshot.routing.role === "auditor"));
          return digestJson(values);
        }
        if ((match = /^pull:([1-9][0-9]*):files$/.exec(resource))) return digestJson((await list(`/repos/${owner}/${name}/pulls/${match[1]}/files`)).map(item => normalizeFile(item, match[1])));
        if ((match = /^pull:([1-9][0-9]*):reviews$/.exec(resource))) return digestJson((await list(`/repos/${owner}/${name}/pulls/${match[1]}/reviews`)).map(item => normalizeReview(item, match[1])));
        if ((match = /^pull:([1-9][0-9]*):checks$/.exec(resource))) {
          const pull = await pullAt(match[1]);
          return digestJson((await list(`/repos/${owner}/${name}/commits/${text(pull.head?.sha, "pull head")}/check-runs?filter=latest`, "check_runs")).map(normalizeCheck));
        }
        if (resource === "labels") {
          const values = (await allLabels()).map(item => Object.freeze({ id: restId(item.id, "label id"), name: normalizedContent(item.name, `label:${item.id}:name`), color: normalizedContent(item.color, `label:${item.id}:color`), description: normalizedContent(item.description ?? "", `label:${item.id}:description`) }));
          return digestJson(values);
        }
        if (resource === "milestones") {
          const values = (await allMilestones()).map(item => Object.freeze({ id: restId(item.id, "milestone id"), number: restId(item.number, "milestone number"), state: text(item.state, "milestone state"), dueOn: item.due_on ?? null, title: normalizedContent(item.title, `milestone:${item.number}:title`), description: normalizedContent(item.description ?? "", `milestone:${item.number}:description`) }));
          return digestJson(values);
        }
        if (resource === "runs") return digestJson((await allRuns()).map(normalizeRun));
        if (resource === "alerts") {
          const expected = trustedSnapshot.state.resources?.alerts;
          contract(Array.isArray(expected), "alert revision is malformed");
          const values = [];
          for (const item of expected) {
            const rawExpected = item?.details?.data;
            const kind = rawExpected && (Object.hasOwn(rawExpected, "dependency") || Object.hasOwn(rawExpected, "security_advisory") || Object.hasOwn(rawExpected, "dismissed_reason")) ? "dependabot/alerts" : "code-scanning/alerts";
            const alert = await get(`/repos/${owner}/${name}/${kind}/${numericId(item.id, "alert id")}`);
            values.push(Object.freeze({ id: restId(alert.number, "alert id"), state: text(alert.state, "alert state"), updatedAt: text(alert.updated_at, "alert updatedAt"), details: normalizedContent(alert, `alert:${alert.number}`) }));
          }
          return digestJson(values);
        }
        if (resource === "settings") {
          const live = await get(`/repos/${owner}/${name}`);
          return digestJson(normalizeSettings(live));
        }
        if (resource === "rulesets") {
          const summaries = await list(`/repos/${owner}/${name}/rulesets`);
          if (summaries.length > 100) throw new AdwError("forge", "overflow");
          const ids = summaries.map(summary => restId(summary.id, "ruleset id"));
          if (new Set(ids).size !== ids.length) throw new AdwError("forge", "duplicate ruleset id");
          const values = [];
          for (const id of ids) values.push(normalizeRuleset(await get(`/repos/${owner}/${name}/rulesets/${numericId(id, "ruleset id")}`), id));
          values.sort((a, b) => a.name.localeCompare(b.name));
          return digestJson(values);
        }
        throw new AdwError("stale", "named revision is unsupported for apply");
      };
      const observeRevisions = async () => {
        cache.clear();
        const observed = [];
        for (const revision of trustedSnapshot.revisions) observed.push({ ...revision, token: await revisionToken(revision) });
        return Object.freeze({ revisions: Object.freeze(observed), digest: digestJson(observed) });
      };
      const syncTransitionAllowed = async observedRevisions => {
        if (syncTransition === null || binding?.priorOperations?.length !== 0 || !Array.isArray(trustedSnapshot.state.resources?.labels) || !observedRevisions.some(revision => revision.resource === "labels")) return false;
        for (let index = 0; index < observedRevisions.length; index++) {
          if (observedRevisions[index].resource !== "labels" && observedRevisions[index].token !== trustedSnapshot.revisions[index].token) return false;
        }
        const definitions = new Map(syncTransition.definitions.map(definition => [definition.name, definition]));
        const originals = new Map();
        for (const label of trustedSnapshot.state.resources.labels) {
          const original = { id: String(label?.id ?? ""), name: label?.name?.data, color: label?.color?.data?.toLowerCase(), description: label?.description?.data ?? "" };
          if (!/^[1-9][0-9]*$/.test(original.id) || typeof original.name !== "string" || typeof original.color !== "string" || originals.has(original.name)) return false;
          originals.set(original.name, original);
        }
        const current = await allLabels();
        const seen = new Set();
        for (const label of current) {
          if (!Number.isSafeInteger(label?.id) || label.id < 1 || typeof label.name !== "string" || typeof label.color !== "string" || seen.has(label.name)) return false;
          seen.add(label.name);
          const actual = { id: String(label.id), name: label.name, color: label.color.toLowerCase(), description: label.description ?? "" };
          const original = originals.get(label.name);
          const definition = definitions.get(label.name);
          if (definition === undefined) {
            if (original === undefined || digestJson(actual) !== digestJson(original)) return false;
            continue;
          }
          const desired = actual.name === definition.name && actual.color === definition.color && actual.description === definition.description && (original === undefined || actual.id === original.id);
          const unchanged = original !== undefined && digestJson(actual) === digestJson(original);
          if (!desired && !unchanged) return false;
        }
        return [...originals.keys()].every(name => seen.has(name));
      };

      const vcsTransitionAllowed = async observedRevisions => {
        const projection = binding?.vcsProjection;
        if (projection === null || projection === undefined || recordOnly) return false;
        const original = trustedSnapshot.revisions;
        if (original.length !== observedRevisions.length || projection.headSha === proof.patch?.baseSha) return false;
        if (value.type === "create_pr") {
          for (let index = 0; index < original.length; index++) if (original[index].resource !== observedRevisions[index].resource || original[index].kind !== observedRevisions[index].kind || original[index].token !== observedRevisions[index].token) return false;
          const ref = await get(`/repos/${owner}/${name}/git/ref/heads/${value.head.split("/").map(encodeURIComponent).join("/")}`);
          return ref?.object?.sha === projection.headSha;
        }
        if (value.type !== "update_pr") return false;
        const changed = new Set([`pull:${value.prId}`, `ref:${trustedSnapshot.state.headBranch}`]);
        if (changed.size !== 2 || ![...changed].every(resource => original.some(revision => revision.resource === resource && revision.token === proof.patch?.baseSha))) return false;
        for (let index = 0; index < original.length; index++) {
          if (original[index].resource !== observedRevisions[index].resource || original[index].kind !== observedRevisions[index].kind) return false;
          const expected = changed.has(original[index].resource) ? projection.headSha : original[index].token;
          if (observedRevisions[index].token !== expected) return false;
        }
        return true;
      };

      const observedBefore = await observeRevisions();
      if (complete && value.type !== "sync_labels" && value.type !== "comment" && binding?.vcsProjection == null) return Object.freeze({ state: "complete", revision: observedBefore.digest });
      const expectedBefore = binding?.expectedBefore ?? proof.preconditionDigest;
      const projectedAllowed = await vcsTransitionAllowed(observedBefore.revisions);
      const projectionMustBeObserved = binding?.vcsProjection != null && !recordOnly && !verifyOnly && expectedBefore === proof.preconditionDigest;
      if (projectionMustBeObserved && !projectedAllowed) throw new AdwError("stale", "precondition changed");
      const syncAllowed = value.type === "sync_labels" && await syncTransitionAllowed(observedBefore.revisions);
      if (!binding?.skipRevision && observedBefore.digest !== expectedBefore && !syncAllowed && !projectedAllowed) throw new AdwError("stale", "precondition changed");
      if (complete) return Object.freeze({ state: "complete", revision: observedBefore.digest });
      if (verifyOnly) throw new AdwError("stale", "operation postcondition was not reached");

      if (preWrite !== null) await preWrite();
      const confirmed = await observeRevisions();
      if (confirmed.digest !== observedBefore.digest) throw new AdwError("stale", "precondition changed");
      if (projectionMustBeObserved && !await vcsTransitionAllowed(confirmed.revisions)) throw new AdwError("stale", "precondition changed");
      if (recordOnly) {
        if (typeof binding?.recordIntent !== "function") throw new AdwError("contract", "record writer is unavailable");
        binding.recordIntent();
        return Object.freeze({ state: "complete", revision: confirmed.digest });
      }
      let currentRevision = confirmed.digest;
      let preparedRevision = null;
      if (Array.isArray(prepared)) {
        for (const mutation of prepared) {
          const latest = await observeRevisions();
          if (latest.digest !== currentRevision) throw new AdwError("stale", "precondition changed");
          await mutate(mutation.method, mutation.endpoint, mutation.body);
          if (mutation.label) {
            const live = await page(`/repos/${owner}/${name}/labels/${encodeURIComponent(mutation.label.name)}`);
            if (live?.name !== mutation.label.name || live?.color?.toLowerCase() !== mutation.label.color || (live?.description ?? "") !== mutation.label.description) throw new AdwError("stale", "label postcondition was not reached");
          }
          currentRevision = (await observeRevisions()).digest;
        }
        preparedRevision = currentRevision;
      } else {
        contract(prepared !== null, "operation writer is unavailable");
        if (typeof prepared.execute === "function") {
          await prepared.execute(async () => { preparedRevision = (await observeRevisions()).digest; });
        } else await mutate(prepared.method, prepared.endpoint, prepared.body);
        currentRevision = (await observeRevisions()).digest;
        if (preparedRevision === null) preparedRevision = currentRevision;
      }
      return Object.freeze({ state: "prepared", beforeRevision: expectedBefore, preparedRevision, currentRevision });
    },
    record(operation) {
      const value = validateOperation(operation, policy);
      intentsByDigest.set(digestJson(value), value);
    },
    intents: () => Object.freeze([...intentsByDigest.values()].sort((a, b) => digestJson(a).localeCompare(digestJson(b)))),
    capabilities: () => ADAPTER_READ_CAPABILITIES,
  };
  const rawApplyOperation = api.applyOperation.bind(api);
  const canonicalAuthority = trustedSnapshot => {
    let authority;
    let deterministic = false;
    try { authority = role(trustedSnapshot.routing.role); }
    catch (roleError) {
      try { authority = deterministicRole(trustedSnapshot.routing.role); deterministic = true; }
      catch {
        try { authority = controlAuthority(trustedSnapshot.routing.role); deterministic = true; }
        catch { throw new AdwError("contract", "snapshot role authority is not canonical"); }
      }
    }
    const expectedRouting = deterministic
      ? { role: authority.name, mode: "single", primary: null }
      : { role: authority.name, mode: authority.mode, primary: authority.primary };
    contract(digestJson(trustedSnapshot.routing) === digestJson(expectedRouting), "snapshot role authority is not canonical");
    return authority;
  };
  const credentialFor = async ({ permissions, operationDigest }) => {
    const request = Object.freeze({ repository, permissions, operationDigest });
    let credential;
    try { credential = typeof token === "function" ? await token(request) : token; }
    catch { throw new AdwError("forge", "auth"); }
    contract(credential && !Array.isArray(credential) && Object.getPrototypeOf(credential) === Object.prototype, "operation-scoped GitHub App token is required");
    exactObject(credential, ["value", "source", "repository", "permissions", "operationDigest"], "GitHub App token");
    contract(typeof credential.value === "string" && credential.value.length > 0, "GitHub App token is malformed");
    contract(credential.source === "github-app" && credential.repository === repository && credential.operationDigest === operationDigest, "GitHub App token authority does not match");
    contract(Array.isArray(credential.permissions) && digestJson(credential.permissions) === digestJson(permissions), "GitHub App token permissions do not match operation class");
    return credential;
  };
  const operationTokenCapabilities = () => {
    const permissions = typeof token === "function" ? token.permissions : null;
    return permissions === null || permissions === undefined ? null : Object.freeze([...permissions]);
  };
  const vcsProjectionAuthority = ({ capabilities }) => {
    contract(Array.isArray(capabilities) && capabilities.includes("contents:write") && capabilities.every((value, index) => typeof value === "string" && (index === 0 || capabilities[index - 1].localeCompare(value) < 0)), "VCS capability set is invalid");
    const expectedRemote = `https://github.com/${repository}.git`;
    return Object.freeze({
      expectedRemote,
      credential: async request => {
        exactObject(request, ["repository", "operationDigest", "remote"], "VCS credential request");
        contract(request.repository === repository && request.remote === expectedRemote, "VCS credential authority does not match");
        const credential = await credentialFor({ permissions: capabilities, operationDigest: request.operationDigest });
        const expiresAt = typeof token === "function" ? token.expiresAt : undefined;
        contract(typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)), "VCS credential expiry is unavailable");
        return Object.freeze({ value: credential.value, expiresAt, operationDigest: request.operationDigest });
      },
    });
  };
  const applyMarker = binding => `<!-- smith:apply/v1 role=${binding.role} decision=${binding.decisionDigest} operation=${binding.operationIndex} digest=${binding.operationDigest} phase=complete -->`;
  const effectiveOperation = (operation, binding) => {
    const marker = applyMarker(binding);
    if (operation.type === "comment" || operation.type === "create_issue" || operation.type === "create_pr" || operation.type === "report_drift") {
      const originalBody = markedBody(operation.body, operation.marker);
      const semantic = operation.type === "comment" && operation.body === operation.marker && (REVIEW_MARKER.test(operation.body) || RISK_MARKER.test(operation.body));
      return Object.freeze({ ...operation, body: semantic ? `${operation.body}\n${marker}` : markedBody(originalBody, marker), marker });
    }
    if (operation.type === "create_milestone") return Object.freeze({ ...operation, description: markedBody(markedBody(operation.description, operation.marker), marker), marker });
    if (operation.type === "publish_check") return Object.freeze({ ...operation, externalId: `smith:${binding.decisionDigest}:${binding.operationIndex}:${binding.operationDigest}` });
    return operation;
  };
  const operationNumberFields = Object.freeze({
    comment: ["entityId"], add_label: ["entityId"], remove_label: ["entityId"], update_issue: ["issueId"], close_issue: ["issueId"],
    update_milestone: ["milestoneId"], close_milestone: ["milestoneId"], assign_milestone: ["issueId", "milestoneId"], link_sub_issue: ["parentId", "childId"],
    update_pr: ["prId"], rerun_check: ["runId"], arm_auto_merge: ["prId"],
  });
  const validateOperationNumbers = operation => {
    for (const field of operationNumberFields[operation.type] ?? []) numericId(operation[field], `${field} number`);
  };
  const hardenedApplyOperation = async (request, internal = null) => {
    const context = internal && typeof internal === "object" ? internal : Object.freeze({ priorAuthorityVerified: internal === true });
    exactObject(request, ["operation", "operationIndex", "decision", "snapshot", "verification", "priorOperations"], "apply request");
    if (request.operation?.type === "create_branch" || (request.operation?.type === "update_pr" && request.operation.headSha !== undefined && context.vcsProjection == null)) throw new AdwError("contract", "operation is VCS-owned");
    const trustedSnapshot = validateSnapshot(request.snapshot);
    contract(trustedSnapshot.repository.owner === owner && trustedSnapshot.repository.name === name, "snapshot repository does not match writer");
    const resources = trustedSnapshot.revisions.map(revision => revision.resource);
    contract(new Set(resources).size === resources.length && resources.every((resource, index) => index === 0 || resources[index - 1].localeCompare(resource) < 0), "snapshot revisions are not canonical");
    const authority = canonicalAuthority(trustedSnapshot);
    const canonicalDecision = validateDecision(request.decision);
    const proof = validateVerification(request.verification);
    contract(canonicalDecision.controlSha === trustedSnapshot.controlSha && canonicalDecision.snapshotDigest === digestJson(trustedSnapshot), "decision does not bind snapshot");
    contract(proof.controlSha === trustedSnapshot.controlSha && proof.decisionDigest === digestJson(canonicalDecision), "verification does not bind canonical decision");
    contract(proof.preconditionDigest === digestJson(trustedSnapshot.revisions), "verification precondition does not bind snapshot revisions");
    contract(Number.isSafeInteger(request.operationIndex) && request.operationIndex >= 0 && request.operationIndex < canonicalDecision.operations.length, "operation order is invalid");
    const operation = validateOperation(request.operation, authority);
    contract(digestJson(operation) === digestJson(canonicalDecision.operations[request.operationIndex]), "operation digest or order does not match decision");
    validateOperationNumbers(operation);
    contract(Array.isArray(request.priorOperations) && request.priorOperations.length === request.operationIndex, "prior operation order is invalid");
    let expectedBefore = proof.preconditionDigest;
    const priorReceipts = request.priorOperations.map((entry, index) => {
      const canonical = validateOperationReceipt(canonicalDecision.operations[index], entry, expectedBefore);
      expectedBefore = canonical.afterRevision;
      return canonical;
    });
    contract(request.priorOperations.length === 0 || context.priorAuthorityVerified === true, "prior forge authority must be reconstructed by full apply");
    const expectedReceipt = context.expectedReceipt === undefined ? null : validateOperationReceipt(operation, context.expectedReceipt, expectedBefore);
    const operationDigest = digestJson(operation);
    const vcsProjection = context.vcsProjection ?? null;
    if (vcsProjection !== null) {
      exactObject(vcsProjection, ["operationDigest", "headSha"], "VCS projection");
      contract(vcsProjection.operationDigest === operationDigest && /^[0-9a-f]{40}$/.test(vcsProjection.headSha), "VCS projection authority does not match operation");
    }
    const binding = Object.freeze({ role: authority.name, decisionDigest: proof.decisionDigest, operationDigest, operationIndex: request.operationIndex, preconditionDigest: proof.preconditionDigest, expectedBefore: expectedReceipt?.afterRevision ?? expectedBefore, skipRevision: context.skipRevision === true, priorOperations: Object.freeze(priorReceipts), vcsProjection });
    if (operation.type === "noop") return expectedReceipt ?? unchangedReceipt(operation, expectedBefore);
    if (operation.type === "terminal") throw new AdwError("terminal", operation.reason);
    const operationPermissions = operationCapabilities(operation, trustedSnapshot);
    const permissions = context.credentialPermissions ?? operationPermissions;
    if (context.credentialPermissions !== undefined) {
      contract(Array.isArray(permissions) && permissions.every((value, index) => typeof value === "string" && (index === 0 || permissions[index - 1].localeCompare(value) < 0)), "apply capability set is not canonical");
      contract(operationPermissions.every(value => permissions.includes(value)), "apply capability set is insufficient");
    }
    const metadataOperation = vcsProjection !== null && operation.type === "update_pr"
      ? Object.freeze(Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "headSha")))
      : operation;
    const effective = effectiveOperation(metadataOperation, binding);
    if (context.recordOnly === true) {
      const recordedBinding = Object.freeze({ ...binding, recordIntent: context.recordIntent });
      const observed = await rawApplyOperation({ operation: effective, snapshot: trustedSnapshot, verification: proof, recordOnly: true, binding: recordedBinding });
      contract(observed.state === "complete", "recorded operation precondition failed");
      return unchangedReceipt(operation, expectedBefore);
    }
    const credential = await credentialFor({ permissions, operationDigest });
    contract(!applyActive, "concurrent apply is forbidden");
    applyActive = true;
    activeApplyToken = credential.value;
    try {
      if (expectedReceipt !== null) {
        const observed = await rawApplyOperation({ operation: effective, snapshot: trustedSnapshot, verification: proof, verifyOnly: true, binding });
        contract(observed.state === "complete", "resumed operation postcondition changed");
        return expectedReceipt;
      }
      const prepared = await rawApplyOperation({ operation: effective, snapshot: trustedSnapshot, verification: proof, binding });
      if (prepared.state === "complete") return Object.freeze({ operationDigest, status: "complete", beforeRevision: expectedBefore, preparedRevision: prepared.revision, afterRevision: prepared.revision });
      contract(prepared.state === "prepared", "operation transition was not prepared");
      const postBinding = Object.freeze({ ...binding, expectedBefore: prepared.currentRevision, skipRevision: false });
      const post = await rawApplyOperation({ operation: effective, snapshot: trustedSnapshot, verification: proof, verifyOnly: true, binding: postBinding });
      contract(post.state === "complete", "operation postcondition was not observed");
      return Object.freeze({ operationDigest, status: "complete", beforeRevision: prepared.beforeRevision, preparedRevision: prepared.preparedRevision, afterRevision: post.revision });
    } finally {
      activeApplyToken = null;
      applyActive = false;
    }
  };
  const projectionAuthorities = (request, decision, name) => {
    const allowed = new Set(["decision", "snapshot", "verification", "previousReceipt", "capabilities", "vcsProjections"]);
    contract(request && !Array.isArray(request) && Object.getPrototypeOf(request) === Object.prototype && ["decision", "snapshot", "verification", "previousReceipt"].every(key => Object.hasOwn(request, key)) && Object.keys(request).every(key => allowed.has(key)), `${name} has invalid fields`);
    const expected = decision.kind === "patch" ? decision.operations.filter(operation => ["create_pr", "update_pr"].includes(operation.type)).map(digestJson).sort() : [];
    const supplied = request.vcsProjections ?? [];
    contract(Array.isArray(supplied), "VCS projection authority does not match decision");
    const projections = supplied.map(value => {
      exactObject(value, ["operationDigest", "headSha"], "VCS projection");
      contract(REVISION_DIGEST.test(value.operationDigest) && /^[0-9a-f]{40}$/.test(value.headSha), "VCS projection authority does not match decision");
      return Object.freeze({ operationDigest: value.operationDigest, headSha: value.headSha });
    }).sort((left, right) => left.operationDigest.localeCompare(right.operationDigest));
    contract(new Set(projections.map(value => value.operationDigest)).size === projections.length && digestJson(projections.map(value => value.operationDigest)) === digestJson(expected), "VCS projection authority does not match decision");
    return new Map(projections.map(value => [value.operationDigest, value]));
  };
  const hardenedRecordApply = async request => {
    const canonicalDecision = validateDecision(request?.decision);
    const projections = projectionAuthorities(request, canonicalDecision, "record apply request");
    contract(request.previousReceipt === null, "dry-run cannot consume a write receipt");
    const completed = [];
    const intents = [];
    for (let index = 0; index < canonicalDecision.operations.length; index++) {
      const operation = canonicalDecision.operations[index];
      const receipt = await hardenedApplyOperation(
        { operation, operationIndex: index, decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, priorOperations: completed },
        { priorAuthorityVerified: true, recordOnly: true, vcsProjection: projections.get(digestJson(operation)) ?? null, recordIntent: () => { intents.push(operation); } },
      );
      completed.push(receipt);
    }
    return Object.freeze({ receipt: createApplyReceipt({ decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, operations: completed }), intents: Object.freeze(intents) });
  };
  const hardenedApply = async request => {
    const canonicalDecision = validateDecision(request?.decision);
    const projections = projectionAuthorities(request, canonicalDecision, "apply request");
    let credentialPermissions;
    if (Object.hasOwn(request, "capabilities")) {
      contract(Array.isArray(request.capabilities) && request.capabilities.every((value, index) => typeof value === "string" && /^[a-z]+:[a-z]+$/.test(value) && (index === 0 || request.capabilities[index - 1].localeCompare(value) < 0)), "apply capability set is not canonical");
      const expected = [...new Set([
        ...canonicalDecision.operations.filter(operation => operation.type !== "create_branch").flatMap(operation => operationCapabilities(operation, request.snapshot)),
        ...(canonicalDecision.kind === "patch" ? ["contents:write"] : []),
      ])].sort();
      contract(digestJson(request.capabilities) === digestJson(expected), "apply capability set does not match decision");
      credentialPermissions = Object.freeze([...request.capabilities]);
    }
    const completed = [];
    if (request.previousReceipt !== null) {
      exactObject(request.previousReceipt, ["decisionDigest", "verificationDigest", "operations"], "previous apply receipt");
      const previous = createApplyReceipt({ decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, operations: request.previousReceipt.operations });
      contract(digestJson(request.previousReceipt) === digestJson(previous), "previous apply receipt authority does not match");
      completed.push(...previous.operations);
    }
    try {
      let latestRevisionAuthority = -1;
      for (let index = 0; index < completed.length; index++) if (canonicalDecision.operations[index].type !== "noop") latestRevisionAuthority = index;
      for (let index = 0; index < completed.length; index++) {
        const observed = await hardenedApplyOperation(
          { operation: canonicalDecision.operations[index], operationIndex: index, decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, priorOperations: completed.slice(0, index) },
          { priorAuthorityVerified: true, expectedReceipt: completed[index], skipRevision: index !== latestRevisionAuthority, credentialPermissions, vcsProjection: projections.get(digestJson(canonicalDecision.operations[index])) ?? null },
        );
        contract(digestJson(observed) === digestJson(completed[index]), "resumed operation receipt changed");
      }
      for (let index = completed.length; index < canonicalDecision.operations.length; index++) {
        const observed = await hardenedApplyOperation(
          { operation: canonicalDecision.operations[index], operationIndex: index, decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, priorOperations: completed.slice(0, index) },
          { priorAuthorityVerified: true, credentialPermissions, vcsProjection: projections.get(digestJson(canonicalDecision.operations[index])) ?? null },
        );
        completed.push(observed);
      }
    } catch (error) {
      const partialReceipt = createApplyReceipt({ decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, operations: completed });
      throw new AdwError(error?.code ?? "forge", error?.message ?? "api", { partialReceipt });
    }
    return createApplyReceipt({ decision: canonicalDecision, snapshot: request.snapshot, verification: request.verification, operations: completed });
  };
  return Object.freeze({ ...api, applyOperation: hardenedApplyOperation, apply: hardenedApply, recordApply: hardenedRecordApply, operationTokenCapabilities, vcsProjectionAuthority });
}

export function createDryRunGitHub(repository) {
  return createGitHub({
    repository,
    token: null,
    appIdentity: { appId: "1", slug: "offline", botUserId: "1", login: "offline[bot]" },
    ghPath: "/nonexistent/gh",
    baseEnv: { PATH: "", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
}

export function createDefaultGitHub(repository) {
  const ghPath = process.env.ADW_GH_PATH;
  contract(typeof ghPath === "string" && isAbsolute(ghPath), "gh path is unavailable");
  const appId = process.env.ADW_APP_ID;
  const slug = process.env.ADW_APP_SLUG;
  const botUserId = process.env.ADW_BOT_USER_ID;
  const login = process.env.ADW_BOT_LOGIN;
  contract([appId, slug, botUserId, login].every(value => typeof value === "string"), "App identity is unavailable");
  const scopedToken = process.env.ADW_GITHUB_TOKEN;
  const scopedRepository = process.env.ADW_GITHUB_TOKEN_REPOSITORY;
  const scopedPermissions = process.env.ADW_GITHUB_TOKEN_PERMISSIONS;
  const scopedExpiresAt = process.env.ADW_GITHUB_TOKEN_EXPIRES_AT;
  let token = null;
  if (scopedToken !== undefined || scopedRepository !== undefined || scopedPermissions !== undefined || scopedExpiresAt !== undefined) {
    contract(typeof scopedToken === "string" && scopedToken.length > 0 && scopedRepository === repository && typeof scopedPermissions === "string" && typeof scopedExpiresAt === "string" && Number.isFinite(Date.parse(scopedExpiresAt)), "operation-scoped GitHub App token is unavailable");
    let permissions;
    try { permissions = JSON.parse(scopedPermissions); } catch { throw new AdwError("contract", "operation-scoped GitHub App permissions are invalid"); }
    contract(Array.isArray(permissions) && permissions.every(value => typeof value === "string") && new Set(permissions).size === permissions.length, "operation-scoped GitHub App permissions are invalid");
    const provider = async request => {
      contract(digestJson(request.permissions) === digestJson(permissions), "GitHub App token permissions do not match operation class");
      return { value: scopedToken, source: "github-app", repository, permissions, operationDigest: request.operationDigest };
    };
    Object.defineProperties(provider, {
      readValue: { value: scopedToken },
      permissions: { value: Object.freeze([...permissions]) },
      expiresAt: { value: scopedExpiresAt },
    });
    token = provider;
  }
  return createGitHub({
    repository,
    token,
    appIdentity: { appId, slug, botUserId, login },
    ghPath,
    baseEnv: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });
}
