import { isAbsolute } from "node:path";
import { AdwError, canonicalBytes, digestJson, validateOperation, validateSnapshot } from "./core.mjs";
import { OPERATIONS, deterministicRole, role } from "./roles.mjs";
import { runProcess } from "./providers.mjs";

const EVENTS = new Set([
  "issues", "issue_comment", "pull_request", "pull_request_review",
  "pull_request_review_comment", "check_suite", "check_run", "workflow_run",
  "push", "schedule", "dependabot_alert", "code_scanning_alert", "workflow_dispatch",
]);

const ADAPTER_READ_CAPABILITIES = Object.freeze(["actions:read", "alerts:read", "checks:read", "issues:read", "pulls:read", "repository:read", "settings:read"]);
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
    kind = "pull_request"; entityId = restId(payload.pull_request?.number, "pull number"); revisionHints = { headSha: payload.pull_request.head?.sha, baseRef: payload.pull_request.base?.ref, headRepository: payload.pull_request.head?.repo?.full_name, updatedAt: payload.pull_request.updated_at };
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
  contract(typeof token === "string" || token === null, "token is invalid");
  contract(appIdentity && typeof appIdentity.id === "string" && typeof appIdentity.login === "string", "App identity is invalid");
  contract(typeof ghPath === "string" && isAbsolute(ghPath), "gh path is invalid");
  const [owner, name] = repository.split("/");
  const intentsByDigest = new Map();
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) if (typeof baseEnv?.[key] === "string") env[key] = baseEnv[key];
  if (token !== null) env.GH_TOKEN = token;
  env.GH_HOST = "github.com";
  env.NO_COLOR = "1";

  async function page(endpoint) {
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "--method", "GET", endpoint], cwd: process.cwd(), env, input: "", timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
    } catch (error) {
      throw new AdwError("forge", forgeReason(error?.details?.httpStatus ?? 0));
    }
    try { return JSON.parse(result.stdout); } catch { throw new AdwError("forge", "malformed"); }
  }

  const CLOSING_ISSUES_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{databaseId}} pageInfo{hasNextPage}}}}}";
  async function closingIssues(number) {
    let result;
    try {
      result = await run({ file: ghPath, args: ["api", "graphql", "-f", `query=${CLOSING_ISSUES_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${positiveInteger(number)}`], cwd: process.cwd(), env, input: "", timeoutMs: 120_000, maxOutputBytes: 1_048_576, captureHttpStatus: true });
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
      return request(`/repos/${owner}/${name}/commits/${headSha}/check-runs`, "check_runs");
    },
    rulesets: () => request(`/repos/${owner}/${name}/rulesets`, true),
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
  const normalizedContent = (value, source) => contentEnvelope(value ?? "", "untrusted", source);
  const normalizeLabels = value => {
    contract(Array.isArray(value), "labels are malformed");
    return value.map(label => text(typeof label === "string" ? label : label?.name, "label")).sort();
  };
  const normalizeIssue = value => {
    contract(value && Number.isSafeInteger(value.number) && value.number > 0, "issue is malformed");
    return Object.freeze({
      id: restId(value.id, "issue id"), number: String(value.number), state: text(value.state, "issue state"),
      updatedAt: text(value.updated_at, "issue updatedAt"), actorId: restId(value.user?.id, "issue actor"),
      title: normalizedContent(value.title, `issue:${value.number}:title`), body: normalizedContent(value.body ?? "", `issue:${value.number}:body`),
      labels: Object.freeze(normalizeLabels(value.labels ?? [])), milestoneId: value.milestone ? restId(value.milestone.id, "milestone id") : null,
    });
  };
  const normalizeComment = (value, entityId, repositoryId) => Object.freeze({
    id: restId(value.id, "comment id"), actorId: restId(value.user?.id, "comment actor"),
    createdAt: text(value.created_at, "comment createdAt"), updatedAt: text(value.updated_at ?? value.created_at, "comment updatedAt"),
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
      id: restId(value.id, "pull id"), number: String(value.number), state: text(value.state, "pull state"), merged: value.merged === true || typeof value.merged_at === "string",
      mergeSha,
      updatedAt: text(value.updated_at, "pull updatedAt"), headSha, base: text(value.base?.ref, "pull base"),
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
  const normalizeRun = value => Object.freeze({ id: restId(value.id, "run id"), name: text(value.name, "run name"), event: text(value.event, "run event"), status: text(value.status, "run status"), conclusion: value.conclusion === null ? null : text(value.conclusion, "run conclusion"), headSha: text(value.head_sha, "run head"), attempt: Number(value.run_attempt ?? 1) });
  const enrichPull = async (raw, files = null) => {
    const pull = normalizePull(raw);
    const rawFiles = files ?? await methods.pullFiles(Number(pull.number));
    const changedPaths = rawFiles.map(file => text(file.filename, "changed path")).sort();
    const closing = await methods.closingIssues(Number(pull.number));
    if (pull.merged && !pull.mergeSha) throw new AdwError("forge", "merged pull lacks merge SHA");
    const obligations = pull.merged ? ["linked-work", "docs-writer"].map(roleName => Object.freeze({ role: roleName, status: "missing", artifactDigest: null, expectedArtifactDigest: null })) : [];
    return Object.freeze({ ...pull, changedPaths: Object.freeze(changedPaths), closingIssues: Object.freeze(closing), obligations: Object.freeze(obligations) });
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
      if (deterministic) {
        const plan = deterministicSnapshotPlan(rolePolicy.name, event.kind);
        contract(digestJson(rolePolicy) === digestJson({ kind: "deterministic", name: rolePolicy.name, mode: "single", primary: null, patch: null, snapshot: { fields: plan.fields, maxBytes: 262144 } }), "deterministic role policy is not canonical");
      } else {
        const canonicalPolicy = role(rolePolicy?.name);
        roleSnapshotPlan(rolePolicy.name, event.kind);
        contract(digestJson(rolePolicy) === digestJson(canonicalPolicy), "role policy is not canonical");
      }
      contract(typeof controlSha === "string" && /^[0-9a-f]{40}$/.test(controlSha), "control SHA is invalid");
      contract(appId === appIdentity.id, "snapshot trust is invalid");
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
        : [rolePolicy.charter, rolePolicy.payloadSchema];
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
        put(`issue:${event.entityId}`, "issue", issueValue, issueValue.updatedAt);
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
          sourceComment = comments.find(comment => comment.id === event.revisionHints.commentId && comment.updatedAt === event.revisionHints.updatedAt) ?? null;
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
        for (const rawPull of rawPulls) pulls.push(await enrichPull(rawPull));
        put("pulls", "pulls", Object.freeze(pulls), digestJson(pulls));
        satisfied.add("pulls");
      }
      if (deterministic && rolePolicy.name === "label-sync") {
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
        if (event.revisionHints.baseRef && pullValue.base !== event.revisionHints.baseRef) throw new AdwError("forge", "stale");
        if (event.revisionHints.headRepository && pullValue.headRepository !== event.revisionHints.headRepository) throw new AdwError("forge", "stale");
        if (event.revisionHints.reviewId && !reviews.some(review => review.id === event.revisionHints.reviewId && review.headSha === event.revisionHints.headSha)) throw new AdwError("forge", "stale");
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
        const rulesets = (await methods.rulesets()).map(value => Object.freeze({ id: restId(value.id, "ruleset id"), name: text(value.name, "ruleset name"), enforcement: text(value.enforcement, "ruleset enforcement"), target: text(value.target, "ruleset target"), sourceType: text(value.source_type, "ruleset source type") }));
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
      const state = {
        entityId: event.entityId, labels, input: Object.freeze(input), resources: Object.freeze(resources),
        actionTargets: Object.freeze(resources.runs?.map(run => run.id) ?? []),
        ownerAuthenticated: event.kind === "issue_comment" && sourceComment !== null && /(^|\s)@smith\b/.test(sourceComment.body.data) && event.actor.type === "User" && event.actor.login === normalizedRepository.owner && event.actor.id === repositoryOwnerId,
        closingArtifactQualifies: qualifyingPioneerPulls.length > 0,
        trust: Object.freeze({ ownerIds: [repositoryOwnerId], appId }),
      };
      if (pullValue) { state.headSha = pullValue.headSha; state.changedPaths = pullValue.changedPaths; }
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
    record(operation) {
      const value = validateOperation(operation, policy);
      intentsByDigest.set(digestJson(value), value);
    },
    intents: () => Object.freeze([...intentsByDigest.values()].sort((a, b) => digestJson(a).localeCompare(digestJson(b)))),
    capabilities: () => ADAPTER_READ_CAPABILITIES,
  };
  return Object.freeze(api);
}

export function createDryRunGitHub(repository) {
  return createGitHub({
    repository,
    token: null,
    appIdentity: { id: "offline", login: "offline" },
    ghPath: "/nonexistent/gh",
    baseEnv: { PATH: "", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
}

export function createDefaultGitHub(repository) {
  const ghPath = process.env.ADW_GH_PATH;
  contract(typeof ghPath === "string" && isAbsolute(ghPath), "gh path is unavailable");
  const appId = process.env.ADW_APP_ID;
  const appLogin = process.env.ADW_APP_LOGIN;
  contract(typeof appId === "string" && typeof appLogin === "string", "App identity is unavailable");
  return createGitHub({
    repository,
    token: process.env.GH_TOKEN ?? null,
    appIdentity: { id: appId, login: appLogin },
    ghPath,
    baseEnv: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });
}
