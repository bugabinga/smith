import { isAbsolute } from "node:path";
import { AdwError, digestJson, validateOperation } from "./core.mjs";
import { OPERATIONS } from "./roles.mjs";
import { runProcess } from "./providers.mjs";

const EVENTS = new Set([
  "issues", "issue_comment", "pull_request", "pull_request_review",
  "pull_request_review_comment", "check_suite", "check_run", "workflow_run",
  "push", "schedule", "dependabot_alert", "code_scanning_alert", "workflow_dispatch",
]);

function contract(condition, message) {
  if (!condition) throw new AdwError("contract", message);
}

function text(value, name) {
  contract(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

function id(value, name) {
  contract((typeof value === "string" && value.length > 0) || Number.isSafeInteger(value), `${name} is required`);
  return String(value);
}

function repositoryOf(payload) {
  const value = payload.repository;
  contract(value && value.owner, "repository is required");
  return Object.freeze({
    id: id(value.id ?? value.node_id, "repository id"),
    owner: text(value.owner.login, "repository owner"),
    name: text(value.name, "repository name"),
    defaultBranch: text(value.default_branch, "default branch"),
  });
}

function actorOf(payload) {
  const value = payload.sender;
  contract(value, "sender is required");
  return Object.freeze({ id: id(value.id ?? value.node_id, "actor id"), login: text(value.login, "actor login"), type: text(value.type, "actor type") });
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
    kind = "issue"; entityId = id(payload.issue?.number, "issue number"); revisionHints = { updatedAt: payload.issue.updated_at };
  } else if (name === "issue_comment") {
    kind = "issue_comment"; entityId = id(payload.issue?.number, "issue number"); revisionHints = { commentId: id(payload.comment?.id, "comment id"), updatedAt: payload.comment.updated_at };
  } else if (name === "pull_request") {
    kind = "pull_request"; entityId = id(payload.pull_request?.number, "pull number"); revisionHints = { headSha: payload.pull_request.head?.sha, baseRef: payload.pull_request.base?.ref, headRepository: payload.pull_request.head?.repo?.full_name, updatedAt: payload.pull_request.updated_at };
  } else if (name === "pull_request_review") {
    kind = "pull_request_review"; entityId = id(payload.pull_request?.number, "pull number"); revisionHints = { reviewId: id(payload.review?.id, "review id"), headSha: payload.review?.commit_id ?? payload.pull_request.head?.sha };
  } else if (name === "pull_request_review_comment") {
    kind = "pull_request_review_comment"; entityId = id(payload.pull_request?.number, "pull number"); revisionHints = { commentId: id(payload.comment?.id, "comment id"), headSha: payload.comment?.commit_id ?? payload.pull_request.head?.sha };
  } else if (name === "check_suite" || name === "check_run") {
    const check = payload.check_suite ?? payload.check_run;
    kind = "check"; entityId = id(check?.id, "check id"); revisionHints = { headSha: check?.head_sha, checkKind: name };
  } else if (name === "workflow_run") {
    kind = "workflow"; entityId = id(payload.workflow_run?.id, "workflow run id"); revisionHints = { headSha: payload.workflow_run?.head_sha };
  } else if (name === "push") {
    kind = "push"; entityId = text(payload.ref, "push ref"); action = "pushed"; revisionHints = { headSha: payload.after };
  } else if (name === "schedule") {
    kind = "schedule"; entityId = repository.id; action = "scheduled"; revisionHints = { schedule: payload.schedule };
  } else if (name === "dependabot_alert" || name === "code_scanning_alert") {
    const alert = payload.alert ?? payload.dependabot_alert ?? payload.code_scanning_alert;
    kind = "alert"; entityId = id(alert?.number, "alert number"); revisionHints = { alertKind: name, updatedAt: alert?.updated_at };
  } else {
    kind = "dispatch"; entityId = repository.id; action = "requested"; revisionHints = { inputs: payload.inputs ?? {} };
  }
  text(action, "event action");
  for (const [key, value] of Object.entries(revisionHints)) contract(value !== undefined && value !== null, `revision hint ${key} is required`);
  return Object.freeze({ kind, action, entityId, repository, actor, revisionHints: Object.freeze(revisionHints) });
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
    comments: (kind, number) => {
      contract(kind === "issues" || kind === "pulls", "comment kind is invalid");
      return request(`/repos/${owner}/${name}/${kind}/${positiveInteger(number)}/comments`, true);
    },
    runs: () => request(`/repos/${owner}/${name}/actions/runs`, "workflow_runs"),
  };
  const normalizeResource = value => {
    contract(value && typeof value === "object" && !Array.isArray(value), "resource is malformed");
    const resource = { id: id(value.node_id ?? value.id ?? value.number, "resource id") };
    if (value.updated_at) resource.updatedAt = value.updated_at;
    if (value.head_sha ?? value.head?.sha ?? value.commit_id) resource.headSha = value.head_sha ?? value.head?.sha ?? value.commit_id;
    if (value.state) resource.state = value.state;
    return Object.freeze(resource);
  };
  const api = {
    ...methods,
    async readSnapshot(event) {
      const repositoryValue = await methods.repository();
      const normalizedRepository = {
        id: id(repositoryValue.node_id ?? repositoryValue.id, "repository id"),
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
    record(operation) {
      const value = validateOperation(operation, policy);
      intentsByDigest.set(digestJson(value), value);
    },
    intents: () => Object.freeze([...intentsByDigest.values()].sort((a, b) => digestJson(a).localeCompare(digestJson(b)))),
    capabilities: () => Object.freeze(["actions:read", "checks:read", "issues:read", "pulls:read", "repository:read"]),
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
