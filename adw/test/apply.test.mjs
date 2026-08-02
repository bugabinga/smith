import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AdwError, canonicalBytes, digestBytes, digestJson } from "../core.mjs";
import { composeApply, validateApplyResult } from "../main.mjs";
import * as githubAdapter from "../github.mjs";
import { createApplyReceipt, createGitHub, GITHUB_OPERATION_TRANSITIONS, operationCapabilities } from "../github.mjs";
import { role } from "../roles.mjs";
import { applyVerifiedPatch } from "../vcs.mjs";

const validateAutoMergeMarkers = request => githubAdapter.validateAutoMergeMarkers(request);

const controlSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = "bugabinga/smith";
const appIdentity = Object.freeze({ appId: "12345", slug: "smith", botUserId: "67890", login: "smith[bot]" });
const app = Object.freeze({ id: 12345, slug: "smith" });
const bot = Object.freeze({ id: 67890, login: "smith[bot]", type: "Bot" });
const reply = value => ({ code: 0, signal: null, stdout: JSON.stringify(value), stderr: "" });
const issueSourceRevision = issue => digestJson({
  body: issue.body ?? "",
  labels: (issue.labels ?? []).map(label => typeof label === "string" ? label : label.name).sort(),
  milestoneId: issue.milestone === null || issue.milestone === undefined ? null : String(issue.milestone.id),
  state: issue.state,
  title: issue.title,
});

function snapshot(revisions = [], resources = {}) {
  return {
    schemaVersion: 1,
    controlSha,
    event: { kind: "issue", action: "opened", entityId: "1" },
    repository: { id: "42", owner: "bugabinga", name: "smith", defaultBranch: "main" },
    revisions,
    routing: { role: "triager", mode: "single", primary: "claude" },
    state: { entityId: "1", resources },
  };
}

function decision(value, operations) {
  return {
    schemaVersion: 1,
    controlSha: value.controlSha,
    snapshotDigest: digestJson(value),
    assessmentDigests: [],
    kind: "state",
    operations,
    patch: null,
  };
}

function verification(value, canonicalDecision) {
  return {
    schemaVersion: 1,
    controlSha: value.controlSha,
    decisionDigest: digestJson(canonicalDecision),
    kind: "state",
    preconditionDigest: digestJson(value.revisions),
    patch: null,
    resultTree: null,
  };
}

function harness(handler, { permissions, sleep, now } = {}) {
  const calls = [];
  const mints = [];
  const github = createGitHub({
    repository,
    token: async request => {
      mints.push(request);
      return {
        value: "super-secret-token",
        source: "github-app",
        repository,
        permissions: permissions ?? request.permissions,
        operationDigest: request.operationDigest,
      };
    },
    appIdentity,
    ghPath: process.execPath,
    baseEnv: { PATH: "/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp" },
    run: async request => {
      calls.push(request);
      return handler(request, calls);
    },
    sleep,
    now,
  });
  return { github, calls, mints };
}

function routedSnapshot(operation, value = snapshot()) {
  const roleName = operation.type === "create_pr" ? "builder"
    : operation.type === "update_pr" ? "reviser"
      : operation.type === "create_issue" ? "planner"
        : operation.type === "publish_check" ? "reviewer"
          : operation.type === "dispatch_repository" ? "reconciler"
            : operation.type === "rerun_check" || operation.type === "arm_auto_merge" ? "sweeper"
              : operation.type === "sync_labels" ? "label-sync"
              : operation.type === "report_drift" ? "settings-auditor" : "triager";
  const routings = {
    builder: { role: "builder", mode: "single", primary: "claude" },
    reviser: { role: "reviser", mode: "single", primary: "claude" },
    planner: { role: "planner", mode: "single", primary: "claude" },
    reviewer: { role: "reviewer", mode: "single", primary: "claude" },
    sweeper: { role: "sweeper", mode: "single", primary: "codex" },
    reconciler: { role: "reconciler", mode: "single", primary: null },
    "label-sync": { role: "label-sync", mode: "single", primary: null },
    "settings-auditor": { role: "settings-auditor", mode: "single", primary: null },
    triager: { role: "triager", mode: "single", primary: "codex" },
  };
  return { ...value, routing: routings[roleName] };
}

function operationBinding(operation, value = snapshot(), operationIndex = 0, operations = [operation], preserveRouting = false) {
  const trustedSnapshot = preserveRouting ? value : routedSnapshot(operation, value);
  const canonicalDecision = decision(trustedSnapshot, operations);
  const operationDigest = digestJson(operation);
  const decisionDigest = digestJson(canonicalDecision);
  return {
    trustedSnapshot, canonicalDecision, operationDigest, decisionDigest,
    marker: `<!-- smith:apply/v1 role=${trustedSnapshot.routing.role} decision=${decisionDigest} operation=${operationIndex} digest=${operationDigest} phase=complete -->`,
  };
}

function actionMarker(operation, value, target) {
  const binding = operationBinding(operation, value);
  const externalId = `smith-action:${binding.decisionDigest}:0:${binding.operationDigest}`;
  const summary = canonicalBytes({ role: binding.trustedSnapshot.routing.role, decisionDigest: binding.decisionDigest, operationIndex: 0, operationDigest: binding.operationDigest, target }).toString("utf8");
  return { externalId, summary, operationDigest: binding.operationDigest };
}

function pairedMarker(roleName, semanticMarker, entityId = "3", operationIndex = 0) {
  const operationDigest = digestJson({ type: "comment", entityId, body: semanticMarker, marker: semanticMarker });
  return `${semanticMarker}\n<!-- smith:apply/v1 role=${roleName} decision=${"d".repeat(64)} operation=${operationIndex} digest=${operationDigest} phase=complete -->`;
}

async function apply(github, operation, value = snapshot(), options = {}) {
  value = options.routing === undefined ? routedSnapshot(operation, value) : { ...value, routing: options.routing };
  const canonicalDecision = options.decision ?? decision(value, options.operations ?? [operation]);
  const operationIndex = options.operationIndex ?? canonicalDecision.operations.findIndex(candidate => digestJson(candidate) === digestJson(operation));
  return github.applyOperation({ operation, operationIndex, decision: canonicalDecision, snapshot: value, verification: verification(value, canonicalDecision), priorOperations: options.priorOperations ?? [] });
}

function endpoint(request) {
  return request.args[3];
}

function body(request) {
  return JSON.parse(request.input);
}

const exactWrites = [
  [{ type: "comment", entityId: "1", body: "hello", marker: "marker-1" }, "POST", "/repos/bugabinga/smith/issues/1/comments", { body: "hello\n\nmarker-1" }],
  [{ type: "add_label", entityId: "1", label: "ready" }, "POST", "/repos/bugabinga/smith/issues/1/labels", { labels: ["ready"] }],
  [{ type: "create_issue", title: "T", body: "B", labels: ["ready"], marker: "issue-marker" }, "POST", "/repos/bugabinga/smith/issues", { title: "T", body: "B\n\nissue-marker", labels: ["ready"] }],
  [{ type: "create_pr", head: "feature", base: "main", title: "P", body: "PB", marker: "pr-marker" }, "POST", "/repos/bugabinga/smith/pulls", { head: "feature", base: "main", title: "P", body: "PB\n\npr-marker" }],
  [{ type: "update_pr", prId: "3", title: "P2", body: "PB2" }, "PATCH", "/repos/bugabinga/smith/pulls/3", { title: "P2", body: "PB2" }],
  [{ type: "publish_check", headSha, name: "check", conclusion: "success", summary: "ok", externalId: "check-ext" }, "POST", "/repos/bugabinga/smith/check-runs", { name: "check", head_sha: headSha, status: "completed", conclusion: "success", output: { title: "check", summary: "ok" }, external_id: "check-ext" }],
  [{ type: "report_drift", title: "Drift", body: "details", marker: `smith:settings-drift/v1:${"d".repeat(64)}` }, "POST", "/repos/bugabinga/smith/issues", { title: "Drift", body: `details\n\nsmith:settings-drift/v1:${"d".repeat(64)}`, labels: [] }],
];

test("every ordinary GitHub-owned operation uses one fixed method, endpoint, and JSON stdin", async () => {
  for (const [operation, method, wantedEndpoint, originalBody] of exactWrites) {
    const binding = operationBinding(operation);
    const wantedBody = structuredClone(originalBody);
    if (["comment", "create_issue", "create_pr"].includes(operation.type)) wantedBody.body += `\n\n${binding.marker}`;
    if (operation.type === "create_milestone") wantedBody.description += `\n\n${binding.marker}`;
    if (operation.type === "publish_check") wantedBody.external_id = `smith:${binding.decisionDigest}:0:${binding.operationDigest}`;
    let written = false;
    const { github, calls } = harness(request => {
      const path = endpoint(request);
      if (request.args[2] !== "GET") { written = true; return reply({ id: 99, number: 99 }); }
      if (path.includes("/comments?")) return reply(written ? [{ id: 9001, body: wantedBody.body, user: bot, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] : []);
      if (path.includes("/issues?")) return reply(written ? [{ id: 9001, number: 99, state: "open", title: wantedBody.title, body: wantedBody.body, labels: wantedBody.labels, user: bot, updated_at: "2026-01-01T00:00:00Z" }] : []);
      if (path.includes("/milestones?")) {
        if (operation.type === "assign_milestone") return reply([{ id: 2002, number: 2, state: "open", title: "M", description: "D", due_on: null, creator: bot }]);
        return reply(written ? [{ id: 2002, number: 2, state: "open", title: wantedBody.title, description: wantedBody.description, due_on: wantedBody.due_on, creator: bot }] : []);
      }
      if (path.includes("/pulls?")) return reply(written ? [{ id: 3003, number: 99, title: wantedBody.title, body: wantedBody.body, head: { ref: wantedBody.head }, base: { ref: wantedBody.base }, user: bot }] : []);
      if (path.includes("/check-runs?")) return reply({ check_runs: written ? [{ id: 9001, ...wantedBody, external_id: wantedBody.external_id, head_sha: wantedBody.head_sha, app }] : [] });
      if (path.endsWith("/issues/1")) {
        const issue = { id: 1001, number: 1, state: "open", title: "old", body: "old", labels: operation.type === "remove_label" ? [{ name: "hold" }] : [], milestone: null, updated_at: "2026-01-01T00:00:00Z" };
        if (written && operation.type === "add_label") issue.labels = [{ name: operation.label }];
        if (written && operation.type === "remove_label") issue.labels = [];
        if (written && operation.type === "update_issue") Object.assign(issue, wantedBody);
        if (written && operation.type === "close_issue") Object.assign(issue, { state: "closed", state_reason: operation.reason });
        if (written && operation.type === "assign_milestone") issue.milestone = { id: 2002, number: wantedBody.milestone };
        return reply(issue);
      }
      if (path.endsWith("/issues/2")) return reply({ id: 2002, number: 2, state: "open", title: "child", body: "", labels: [], milestone: null, updated_at: "2026-01-01T00:00:00Z" });
      if (path.endsWith("/pulls/3")) return reply({ id: 3003, number: 3, state: "open", title: written ? wantedBody.title : "old", body: written ? wantedBody.body : "old", head: { sha: headSha } });
      if (path.endsWith("/issues/1/sub_issues?per_page=100&page=1")) return reply(written ? [{ id: 2002, number: 2 }] : []);
      throw new Error(`unexpected read ${path}`);
    });
    const receipt = await apply(github, operation);
    assert.equal(receipt.status, "complete", operation.type);
    const writes = calls.filter(call => call.args[2] !== "GET");
    assert.equal(writes.length, 1, operation.type);
    assert.deepEqual(writes[0].args, ["api", "--method", method, wantedEndpoint, "--input", "-"], operation.type);
    assert.deepEqual(body(writes[0]), wantedBody, operation.type);
    assert.equal(writes[0].input.endsWith("\n"), false);
    assert.equal(writes[0].args.join(" ").includes("super-secret-token"), false);
    assert.equal(writes[0].env.GH_TOKEN, "super-secret-token");
    if (operation.type === "link_sub_issue") assert.ok(calls.some(call => endpoint(call) === "/repos/bugabinga/smith/issues/2"));
    if (operation.type === "assign_milestone") {
      assert.ok(calls.some(call => endpoint(call).startsWith("/repos/bugabinga/smith/milestones?state=all")));
      assert.equal(calls.some(call => endpoint(call).includes("/milestones/2002")), false);
    }
  }
});

test("state-only verified apply is a credential-free no-op subreceipt", async () => {
  const value = snapshot();
  const operation = { type: "noop", reason: "unchanged" };
  const canonicalDecision = decision(value, [operation]);
  let credentials = 0;
  let calls = 0;
  const receipt = await applyVerifiedPatch({
    snapshot: value, decision: canonicalDecision, verification: verification(value, canonicalDecision),
    operationIndex: 0, credential: async () => { credentials++; }, run: async () => { calls++; },
  });
  assert.deepEqual(receipt, {
    operationDigest: digestJson(operation), projection: "state", status: "complete",
    beforeRevision: digestJson(value.revisions), preparedRevision: digestJson(value.revisions), afterRevision: digestJson(value.revisions), headSha: null,
  });
  assert.equal(credentials, 0);
  assert.equal(calls, 0);
});

test("no-op is receipt-only and terminal fails without forge mutation", async () => {
  const { github, calls } = harness(() => assert.fail("must not invoke gh"));
  assert.equal((await apply(github, { type: "noop", reason: "unchanged" })).status, "complete");
  await assert.rejects(() => apply(github, { type: "terminal", reason: "held" }), error => error?.code === "terminal" && error.message === "held");
  assert.equal(calls.length, 0);
});

test("writer rejects VCS-owned branch and patch-head projection", async () => {
  const { github, calls } = harness(() => assert.fail("must not invoke gh"));
  await assert.rejects(() => apply(github, { type: "create_branch", name: "x", baseSha: controlSha, treeSha: headSha }), error => error?.code === "contract");
  await assert.rejects(() => apply(github, { type: "update_pr", prId: "3", headSha }), error => error?.code === "contract");
  assert.equal(calls.length, 0);
});

test("patch update metadata accepts only the exact observed VCS head transition", async () => {
  const bytes = Buffer.from("revision");
  const projectedHead = "d".repeat(40);
  const originalIssue = issueSourceRevision({ state: "open", title: "I", body: "", labels: [], milestone: null });
  const manifest = { baseSha: headSha, digest: digestBytes(bytes), size: bytes.length, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const operation = { type: "update_pr", prId: "3", body: "Revised", headSha };
  const envelope = (data, source) => ({ trust: "untrusted", source, bytes: canonicalBytes(data).length, digest: digestJson(data), truncated: false, data });
  const originalPull = {
    id: "3", number: "3", state: "open", draft: false, merged: false, mergeSha: null, mergeState: "clean", autoMergeRequest: null,
    updatedAt: "2026-01-01T00:00:00.000Z", headSha, headBranch: "feature", base: "main",
    actorId: "7", actorLogin: "bugabinga", actorType: "User", headRepository: repository,
    title: envelope("P", "pull:3:title"), body: envelope("Old", "pull:3:body"), labels: [],
  };
  const value = {
    ...snapshot([{ resource: "issue:9", kind: "issue", token: originalIssue }, { resource: "pull:3", kind: "pull", token: headSha }, { resource: "pull:3:metadata", kind: "pull_metadata", token: digestJson(originalPull) }, { resource: "ref:feature", kind: "git_ref", token: headSha }]),
    event: { kind: "pull_request", action: "synchronize", entityId: "3" }, routing: { role: "reviser", mode: "single", primary: "claude" },
    state: { entityId: "3", headSha, headBranch: "feature", resources: { "pull:3": originalPull } },
  };
  const canonicalDecision = { ...decision(value, [operation]), kind: "patch", patch: manifest };
  const proof = { ...verification(value, canonicalDecision), kind: "patch", patch: manifest, resultTree: "c".repeat(40) };
  let pullBody = "Old";
  let issueBody = "";
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.endsWith("/pulls/3")) return reply({
      id: 3, number: 3, state: "open", draft: false, merged: false, merged_at: null, merge_commit_sha: null, mergeable_state: "clean", auto_merge: null,
      updated_at: "2026-01-01T00:00:01.000Z", title: "P", body: pullBody, labels: [],
      head: { sha: projectedHead, ref: "feature", repo: { full_name: repository } }, base: { ref: "main" },
      user: { id: 7, login: "bugabinga", type: "User" },
    });
    if (request.args[2] === "GET" && path.endsWith("/git/ref/heads/feature")) return reply({ object: { sha: projectedHead } });
    if (request.args[2] === "GET" && path.endsWith("/issues/9")) return reply({ id: 9, number: 9, state: "open", title: "I", body: issueBody, labels: [], milestone: null, updated_at: "2026-01-01T00:00:00.000Z" });
    if (request.args[2] === "PATCH" && path.endsWith("/pulls/3")) { pullBody = body(request).body; return reply({ id: 3, number: 3, body: pullBody, head: { sha: projectedHead } }); }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  const capabilities = [...new Set([...operationCapabilities(operation, value), "contents:write"])].sort();
  const operationDigest = digestJson(operation);
  const vcsProjections = [{ operationDigest, headSha: projectedHead }];
  const receipt = await github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null, capabilities, vcsProjections });
  assert.equal(receipt.operations[0].operationDigest, operationDigest);
  assert.deepEqual(body(calls.find(call => call.args[2] === "PATCH")), { body: "Revised" });
  await assert.rejects(() => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null, capabilities, vcsProjections: [] }), error => error?.code === "contract");
  pullBody = "Old again";
  issueBody = "changed";
  await assert.rejects(
    () => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null, capabilities, vcsProjections }),
    error => error?.code === "stale" && error.message === "precondition changed",
  );
});

test("canonical role operations are never widened by the writer", async () => {
  const operations = [
    { type: "close_issue", issueId: "1", reason: "completed" },
    { type: "update_milestone", milestoneId: "2002", title: "M2" },
    { type: "close_milestone", milestoneId: "2002" },
    { type: "dispatch_workflow", workflow: "ci.yml", ref: "main", inputs: { mode: "audit" } },
    { type: "arm_auto_merge", prId: "3", headSha, method: "squash" },
  ];
  for (const operation of operations) {
    const { github, calls, mints } = harness(() => assert.fail("unauthorized operation must not invoke gh"));
    await assert.rejects(() => apply(github, operation), error => error?.code === "contract" && error.message.startsWith("operation type is not allowed"));
    assert.equal(calls.length, 0, operation.type);
    assert.equal(mints.length, 0, operation.type);
  }
});

test("opaque GitHub numbers fail contract before credentials or API calls", async () => {
  const operation = { type: "assign_milestone", issueId: "I_kwDOopaque", milestoneId: "M_kwDOopaque" };
  const { github, calls, mints } = harness(() => assert.fail("opaque IDs must not invoke gh"));
  await assert.rejects(() => apply(github, operation), error => error?.code === "contract");
  assert.equal(calls.length, 0);
  assert.equal(mints.length, 0);
});

test("named revisions are re-read before the first mutation and stale state fails closed", async () => {
  const original = { id: 1, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: "2026-01-01T00:00:00Z" };
  const value = snapshot([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(original) }]);
  const { github, calls } = harness(request => reply({ ...original, body: "changed", updated_at: "2026-01-02T00:00:00Z" }));
  await assert.rejects(() => apply(github, { type: "add_label", entityId: "1", label: "ready" }, value), error => error?.code === "stale" && error.message === "precondition changed");
  assert.deepEqual(calls.map(call => call.args.slice(1, 4)), [
    ["--method", "GET", "/repos/bugabinga/smith/issues/1"],
    ["--method", "GET", "/repos/bugabinga/smith/issues/1"],
  ]);
});

test("pull writes bind head plus mutable labels, comments, and updated metadata while preserving ordered transitions", async () => {
  const webhookRepository = { id: 42, name: "smith", full_name: repository, default_branch: "main", owner: { id: 7, login: "bugabinga" } };
  const webhookSender = { id: 7, login: "bugabinga", type: "User" };
  const initialUpdatedAt = "2026-08-01T00:00:00.000Z";
  const changedUpdatedAt = "2026-08-01T00:00:01.000Z";
  const make = async () => {
    const state = { labels: [], comments: [], checks: [], updatedAt: initialUpdatedAt, mutations: [], failCommentOnce: false };
    const rawPull = () => ({
      id: 3, number: 3, state: "open", draft: false, merged: false, merged_at: null, merge_commit_sha: null,
      mergeable_state: "clean", auto_merge: null, updated_at: state.updatedAt,
      head: { sha: headSha, ref: "feature/3", repo: { full_name: repository } }, base: { ref: "main" },
      user: { id: 7, login: "bugabinga", type: "User" }, title: "Pull", body: "Body", labels: state.labels.map(name => ({ name })),
    });
    const rawIssue = () => ({ id: 3, number: 3, state: "open", updated_at: state.updatedAt, user: { id: 7 }, title: "Pull", body: "Body", labels: state.labels.map(name => ({ name })), milestone: null, pull_request: {} });
    const { github, calls } = harness(request => {
      if (request.args[1] === "graphql") return reply({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
      const path = endpoint(request);
      const method = request.args[2];
      if (method !== "GET") {
        state.mutations.push({ method, path, body: body(request) });
        if (path === "/repos/bugabinga/smith/check-runs") {
          const input = body(request);
          state.checks.push({ id: 31, app, name: input.name, head_sha: input.head_sha, status: input.status, conclusion: input.conclusion, output: input.output, external_id: input.external_id });
          return reply(state.checks[0]);
        }
        if (path === "/repos/bugabinga/smith/issues/3/labels") {
          for (const label of body(request).labels) if (!state.labels.includes(label)) state.labels.push(label);
          state.updatedAt = changedUpdatedAt;
          return reply(state.labels.map(name => ({ name })));
        }
        if (path === "/repos/bugabinga/smith/issues/3/comments") {
          if (state.failCommentOnce) { state.failCommentOnce = false; throw new Error("injected marker failure"); }
          state.updatedAt = "2026-08-01T00:00:02.000Z";
          const comment = { id: 41, user: bot, created_at: state.updatedAt, updated_at: state.updatedAt, body: body(request).body };
          state.comments.push(comment);
          return reply(comment);
        }
        throw new Error(`unexpected mutation ${method} ${path}`);
      }
      if (path === "/repos/bugabinga/smith") return reply(webhookRepository);
      if (path.includes("/contents/.claude/agents/reviewer.md?ref=")) return reply({ encoding: "base64", content: Buffer.from("review").toString("base64"), sha: "c".repeat(40) });
      if (path.includes("/contents/adw/schemas/role-payloads/review.schema.json?ref=")) return reply({ encoding: "base64", content: Buffer.from("{}").toString("base64"), sha: "d".repeat(40) });
      if (path === "/repos/bugabinga/smith/pulls/3") return reply(rawPull());
      if (path === "/repos/bugabinga/smith/issues/3") return reply(rawIssue());
      if (path.startsWith("/repos/bugabinga/smith/pulls/3/files?")) return reply([]);
      if (path.startsWith("/repos/bugabinga/smith/pulls/3/reviews?")) return reply([]);
      if (path.startsWith("/repos/bugabinga/smith/issues/3/comments?")) return reply(state.comments);
      if (path.startsWith(`/repos/bugabinga/smith/commits/${headSha}/check-runs?`)) return reply({ check_runs: state.checks });
      if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
      if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-pulls.yml/runs?event=repository_dispatch")) return reply({ workflow_runs: [] });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const event = githubAdapter.normalizeEvent("pull_request", {
      action: "synchronize", repository: webhookRepository, sender: webhookSender,
      pull_request: { number: 3, updated_at: initialUpdatedAt, head: { sha: headSha, ref: "feature/3", repo: { full_name: repository } }, base: { ref: "main" } },
    });
    const value = await github.readRoleSnapshot(event, role("reviewer"), { controlSha, appId: appIdentity.appId });
    assert.ok(value.revisions.some(revision => revision.resource === "pull:3" && revision.token === headSha));
    assert.ok(value.revisions.some(revision => revision.resource === "pull:3:metadata" && revision.token !== headSha));
    assert.ok(value.revisions.some(revision => revision.resource === "pull:3:comments"));
    return { github, calls, state, value };
  };

  const publish = { type: "publish_check", headSha, name: "reviewer", conclusion: "success", summary: "approved", externalId: "review-3" };
  const comment = { type: "comment", entityId: "3", body: "reviewed", marker: "review-marker" };
  const dispatch = { type: "dispatch_repository", eventType: "run_review", clientPayload: { repositoryId: "42", prId: "3", headSha, role: "reviewer", provider: "claude" } };
  for (const [operation, routing] of [[publish, { role: "reviewer", mode: "single", primary: "claude" }], [comment, { role: "reviewer", mode: "single", primary: "claude" }], [dispatch, { role: "reconciler", mode: "single", primary: null }]]) {
    const fixture = await make();
    fixture.state.labels.push("hold");
    fixture.state.updatedAt = changedUpdatedAt;
    const value = { ...fixture.value, routing };
    await assert.rejects(
      () => apply(fixture.github, operation, value, { routing }),
      error => error?.code === "stale" && error.message === "precondition changed",
    );
    assert.equal(fixture.state.mutations.length, 0, operation.type);
  }

  const fixture = await make();
  const operations = [publish, { type: "add_label", entityId: "3", label: "reviewed" }, comment];
  const canonicalDecision = decision(fixture.value, operations);
  const proof = verification(fixture.value, canonicalDecision);
  const receipt = await fixture.github.apply({ decision: canonicalDecision, snapshot: fixture.value, verification: proof, previousReceipt: null, vcsProjections: [] });
  assert.equal(receipt.operations.length, 3);
  assert.equal(receipt.operations[0].beforeRevision, proof.preconditionDigest);
  for (let index = 1; index < receipt.operations.length; index++) assert.equal(receipt.operations[index].beforeRevision, receipt.operations[index - 1].afterRevision);
  assert.deepEqual(fixture.state.mutations.map(mutation => mutation.path), [
    "/repos/bugabinga/smith/check-runs", "/repos/bugabinga/smith/issues/3/labels", "/repos/bugabinga/smith/issues/3/comments",
  ]);

  const resumed = await make();
  const finalization = `<!-- smith:merge-finalized/v1 pr=3 merge=${"c".repeat(40)} role=docs-writer status=complete artifact=${"d".repeat(64)} -->`;
  const resumeOperations = [publish, { type: "add_label", entityId: "3", label: "reviewed" }, { type: "comment", entityId: "3", body: finalization, marker: finalization }];
  const resumeDecision = decision(resumed.value, resumeOperations);
  const resumeProof = verification(resumed.value, resumeDecision);
  resumed.state.failCommentOnce = true;
  let partial;
  await assert.rejects(
    () => resumed.github.apply({ decision: resumeDecision, snapshot: resumed.value, verification: resumeProof, previousReceipt: null, vcsProjections: [] }),
    error => { partial = error?.details?.partialReceipt; return error?.code === "forge" && partial?.operations?.length === 2; },
  );
  const complete = await resumed.github.apply({ decision: resumeDecision, snapshot: resumed.value, verification: resumeProof, previousReceipt: partial, vcsProjections: [] });
  assert.equal(complete.operations.length, 3);
  assert.equal(resumed.state.mutations.filter(mutation => mutation.path === "/repos/bugabinga/smith/check-runs").length, 1);
  assert.equal(resumed.state.mutations.filter(mutation => mutation.path === "/repos/bugabinga/smith/issues/3/labels").length, 1);
  assert.equal(resumed.state.comments.filter(entry => entry.body.startsWith(finalization)).length, 1);
});

test("natural post-state reconstructs a lost receipt without repeating the write", async () => {
  const original = "2026-01-01T00:00:00.000Z";
  const post = "2026-01-01T00:00:01.000Z";
  let issue = { id: 1, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: original };
  const value = snapshot([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }]);
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const { github, calls } = harness(request => {
    if (request.args[2] === "GET") return reply(issue);
    issue = { ...issue, labels: [{ name: "ready" }], updated_at: post };
    return reply(issue);
  });
  await apply(github, operation, value);
  const writes = calls.filter(call => call.args[2] !== "GET").length;
  const reconstructed = await apply(github, operation, value);
  assert.equal(reconstructed.afterRevision, digestJson([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }]));
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, writes);
});

test("lost later receipt cannot launder unrelated body or label drift through prior natural completion", async () => {
  const operations = [
    { type: "add_label", entityId: "1", label: "ready" },
    { type: "add_label", entityId: "1", label: "blocked" },
  ];
  const original = { id: 1, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: "2026-01-01T00:00:00.000Z" };
  const runCase = async drift => {
    let issue = structuredClone(original);
    const value = routedSnapshot(operations[0], snapshot([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }]));
    const canonicalDecision = decision(value, operations);
    const proof = verification(value, canonicalDecision);
    let loseSecondReceipt = true;
    let writes = 0;
    const { github } = harness(request => {
      if (request.args[2] === "GET") return reply(issue);
      writes++;
      const label = body(request).labels[0];
      issue = { ...issue, labels: [...issue.labels, { name: label }], updated_at: `2026-01-01T00:00:0${writes}.000Z` };
      if (label === "blocked" && loseSecondReceipt) {
        loseSecondReceipt = false;
        const error = new Error("receipt upload was interrupted");
        error.details = { httpStatus: 500 };
        throw error;
      }
      return reply(issue);
    });
    let partialReceipt;
    await assert.rejects(
      () => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null }),
      error => {
        partialReceipt = error?.details?.partialReceipt;
        return error?.code === "forge" && partialReceipt?.operations?.length === 1;
      },
    );
    assert.deepEqual(exactLiveLabelNames(issue), ["ready", "blocked"]);
    if (drift) issue = { ...issue, body: "unrelated edit", labels: [...issue.labels, { name: "external" }], updated_at: "2026-01-01T00:00:03.000Z" };
    const beforeRetryWrites = writes;
    if (drift) {
      await assert.rejects(
        () => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: partialReceipt }),
        error => error?.code === "stale" && error.message === "precondition changed",
      );
    } else {
      const recovered = await github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: partialReceipt });
      assert.equal(recovered.operations.length, 2);
    }
    assert.equal(writes, beforeRetryWrites);
  };
  await runCase(false);
  await runCase(true);
});

function exactLiveLabelNames(issue) {
  return issue.labels.map(label => label.name);
}

test("semantic review and risk markers remain anchored before the role-bound apply marker", async () => {
  const cases = [
    ["reviewer", `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${"1".repeat(64)} -->`],
    ["security-reviewer", `<!-- smith:risk/v1 head=${headSha} finding=${"f".repeat(64)} status=open created=2026-01-01T00:00:00.000Z cleared=- -->`],
  ];
  for (const [roleName, semanticMarker] of cases) {
    const operation = { type: "comment", entityId: "3", body: semanticMarker, marker: semanticMarker };
    const routing = { role: roleName, mode: "single", primary: "claude" };
    const value = { ...snapshot(), routing };
    const binding = operationBinding(operation, value, 0, [operation], true);
    let comment = null;
    const { github, calls } = harness(request => {
      if (request.args[2] === "GET") return reply(comment === null ? [] : [comment]);
      comment = { id: 9001, body: body(request).body, user: bot, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
      return reply(comment);
    });
    await apply(github, operation, value, { routing });
    const write = calls.find(call => call.args[2] === "POST");
    assert.equal(body(write).body, `${semanticMarker}\n${binding.marker}`);
  }
});

test("forge markers make create retries authoritative and conflicts fail closed", async () => {
  const operation = { type: "comment", entityId: "1", body: "hello", marker: "marker-1" };
  const binding = operationBinding(operation);
  let comments = [];
  const { github, calls } = harness(request => {
    if (request.args[2] === "GET") return reply(comments);
    comments = [{ id: 7001, body: body(request).body, user: bot, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
    return reply({ id: 7001 });
  });
  assert.equal((await apply(github, operation)).status, "complete");
  const writeCount = calls.filter(call => call.args[2] !== "GET").length;
  assert.equal((await apply(github, operation)).status, "complete");
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, writeCount);
  comments = [{ id: 7001, body: `different\n\n${binding.marker}`, user: bot, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
  await assert.rejects(() => apply(github, operation), error => error?.code === "stale" && error.message === "conflicting forge marker");
});

test("exact operation marker reconstructs a lost comment receipt but cannot absorb unrelated comment drift", async () => {
  const operation = { type: "comment", entityId: "1", body: "hello", marker: "marker-1" };
  const value = snapshot([{ resource: "issue:1:comments", kind: "comments", token: digestJson([]) }]);
  let comments = [];
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.includes("/issues/1/comments?")) return reply(comments);
    if (request.args[2] === "POST" && path.endsWith("/issues/1/comments")) {
      const comment = { id: 10, body: body(request).body, user: bot, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
      comments.push(comment);
      return reply(comment);
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await apply(github, operation, value);
  const writes = calls.filter(call => call.args[2] !== "GET").length;
  assert.equal((await apply(github, operation, value)).status, "complete");
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, writes);
  comments.push({ id: 11, body: "unrelated", user: { id: 7, login: "bugabinga", type: "User" }, created_at: "2026-01-01T00:00:01.000Z", updated_at: "2026-01-01T00:00:01.000Z" });
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "stale" && error.message === "precondition changed");
});

test("create marker recovery removes only its exact issue transition", async () => {
  const operation = { type: "create_issue", title: "Finding", body: "Details", labels: ["adw:drift"], marker: "finding-marker" };
  const value = snapshot([{ resource: "issues", kind: "issues", token: digestJson([]) }]);
  let issues = [];
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.includes("/issues?")) return reply(issues);
    if (request.args[2] === "POST" && path.endsWith("/issues")) {
      const input = body(request);
      const issue = { id: 10, number: 10, state: "open", title: input.title, body: input.body, labels: input.labels.map(name => ({ name })), milestone: null, user: bot, updated_at: "2026-01-01T00:00:00.000Z" };
      issues.push(issue);
      return reply(issue);
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await apply(github, operation, value);
  const writes = calls.filter(call => call.args[2] !== "GET").length;
  assert.equal((await apply(github, operation, value)).status, "complete");
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, writes);
  issues.push({ id: 11, number: 11, state: "open", title: "External", body: "Drift", labels: [], milestone: null, user: { id: 7, login: "bugabinga", type: "User" }, updated_at: "2026-01-01T00:00:01.000Z" });
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "stale" && error.message === "precondition changed");
});

test("report drift recognizes #169's validated apply suffix across retry and control SHA", async () => {
  const operation = {
    type: "report_drift",
    title: "Ruleset drift: main",
    body: "Wanted digest: wanted\nLive digest: live\nChanged fields: $.rules",
    marker: `smith:settings-drift/v1:${"a".repeat(64)}`,
  };
  const routing = { role: "auditor", mode: "single", primary: null };
  const original = { ...snapshot(), routing };
  const binding = operationBinding(operation, original, 0, [operation], true);
  const semanticBody = `${operation.body}\n\n${operation.marker}`;
  const issue = bodyValue => ({
    id: 169, number: 169, state: "open", title: operation.title, body: bodyValue,
    labels: [], milestone: null, user: bot, updated_at: "2026-08-02T23:30:00.000Z",
  });
  let issues = [issue(`${semanticBody}\n\n${binding.marker}`)];
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.includes("/issues?")) return reply(issues);
    if (request.args[2] === "POST" && path.endsWith("/issues")) {
      const input = body(request);
      issues.push(issue(input.body));
      return reply(issues.at(-1));
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });

  assert.equal((await apply(github, operation, original, { routing })).status, "complete");
  const next = { ...original, controlSha: "c".repeat(40) };
  assert.equal((await apply(github, operation, next, { routing })).status, "complete");
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, 0);

  issues = [issue(`Conflicting detail\n\n${operation.marker}\n\n${binding.marker}`)];
  await assert.rejects(
    () => apply(github, operation, next, { routing }),
    error => error?.code === "stale" && error.message === "conflicting forge marker",
  );

  const wrongDigest = binding.marker.replace(`digest=${binding.operationDigest}`, `digest=${"f".repeat(64)}`);
  issues = [issue(`${semanticBody}\n\n${wrongDigest}`)];
  await assert.rejects(
    () => apply(github, operation, next, { routing }),
    error => error?.code === "stale" && error.message === "conflicting forge marker",
  );
});

test("new drift reports persist only their semantic marker across retry and control SHA", async () => {
  const operation = {
    type: "report_drift", title: "Settings drift", body: "Semantic detail",
    marker: `smith:settings-drift/v1:${"b".repeat(64)}`,
  };
  const routing = { role: "auditor", mode: "single", primary: null };
  const original = { ...snapshot(), routing };
  let issues = [];
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.includes("/issues?")) return reply(issues);
    if (request.args[2] === "POST" && path.endsWith("/issues")) {
      const input = body(request);
      issues = [{ id: 170, number: 170, state: "open", title: input.title, body: input.body, labels: [], milestone: null, user: bot, updated_at: "2026-08-03T00:00:00.000Z" }];
      return reply(issues[0]);
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });

  await apply(github, operation, original, { routing });
  const writes = calls.filter(call => call.args[2] === "POST");
  assert.equal(writes.length, 1);
  assert.equal(body(writes[0]).body, `${operation.body}\n\n${operation.marker}`);
  assert.doesNotMatch(body(writes[0]).body, /<!-- smith:apply\/v1 /);

  await apply(github, operation, original, { routing });
  await apply(github, operation, { ...original, controlSha: "d".repeat(40) }, { routing });
  assert.equal(calls.filter(call => call.args[2] === "POST").length, 1);
});

test("auto-merge parses only exact role-bound review and risk marker pairs", () => {
  const correctness = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${"1".repeat(64)} -->`;
  const security = `<!-- smith:review-evidence/v1 kind=security head=${headSha} conclusion=approve provider=codex authoritative=true artifact=${"2".repeat(64)} -->`;
  const comments = [
    { id: 1, user: bot, body: pairedMarker("reviewer", correctness) },
    { id: 2, user: bot, body: pairedMarker("security-reviewer", security) },
  ];
  assert.doesNotThrow(() => validateAutoMergeMarkers({ comments, headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" }));
  const duplicateCorrectness = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=codex authoritative=true artifact=${"4".repeat(64)} -->`;
  assert.doesNotThrow(() => validateAutoMergeMarkers({ comments: [...comments, { id: 3, user: bot, body: pairedMarker("reviewer", duplicateCorrectness, "3", 2) }], headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" }));
  const legacy = [
    { id: 4, user: bot, body: `Review: ${headSha}\nVERDICT: reviewed\nLegacy detail` },
    { id: 5, user: bot, body: `Review: ${headSha}\nVERDICT: reviewed\nDuplicate` },
    { id: 6, user: bot, body: `Security review: ${headSha}\nVERDICT: security-cleared\nLegacy detail` },
  ];
  assert.doesNotThrow(() => validateAutoMergeMarkers({ comments: legacy, headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" }));
  for (const invalidLegacy of [
    [{ ...legacy[0], body: `Review: ${headSha}\nVERDICT: changes-requested` }, legacy[2]],
    [{ ...legacy[0], user: { id: 7, login: "bugabinga", type: "User" } }, legacy[2]],
    [{ ...legacy[0], body: `Review: ${"e".repeat(40)}\nVERDICT: reviewed` }, legacy[2]],
  ]) assert.throws(() => validateAutoMergeMarkers({ comments: invalidLegacy, headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" }), error => error?.code === "stale");
  const correctnessReject = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=reject provider=claude authoritative=true artifact=${"3".repeat(64)} -->`;
  const staleCorrectness = `<!-- smith:review-evidence/v1 kind=correctness head=${"e".repeat(40)} conclusion=approve provider=claude authoritative=true artifact=${"5".repeat(64)} -->`;
  for (const malformed of [
    [{ ...comments[0], body: correctness }, comments[1]],
    [{ ...comments[0], body: pairedMarker("security-reviewer", correctness) }, comments[1]],
    [{ ...comments[0], body: `${correctness}\n\n${pairedMarker("reviewer", correctness).split("\n")[1]}` }, comments[1]],
    [{ ...comments[0], user: { id: 7, login: "bugabinga", type: "User" } }, comments[1]],
    [{ ...comments[0], body: pairedMarker("reviewer", staleCorrectness) }, comments[1]],
    [{ ...comments[0], body: pairedMarker("reviewer", correctnessReject) }, comments[1]],
    [...comments, { id: 3, user: bot, body: pairedMarker("reviewer", correctnessReject, "3", 3) }],
  ]) {
    assert.throws(() => validateAutoMergeMarkers({ comments: malformed, headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" }), error => error?.code === "stale" && error.message === "auto-merge evidence failed");
  }
});

test("auto-merge accepts only App risk opens cleared by the authenticated owner", () => {
  const created = "2026-01-01T00:00:00.000Z";
  const cleared = "2026-01-01T00:00:01.000Z";
  const finding = "f".repeat(64);
  const correctness = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${"1".repeat(64)} -->`;
  const security = `<!-- smith:review-evidence/v1 kind=security head=${headSha} conclusion=approve provider=codex authoritative=true artifact=${"2".repeat(64)} -->`;
  const open = `<!-- smith:risk/v1 head=${headSha} finding=${finding} status=open created=${created} cleared=- -->`;
  const clear = `<!-- smith:risk/v1 head=${headSha} finding=${finding} status=cleared created=${created} cleared=${cleared} -->`;
  const evidence = [
    { id: 1, user: bot, body: pairedMarker("reviewer", correctness) },
    { id: 2, user: bot, body: pairedMarker("security-reviewer", security) },
  ];
  const openComment = { id: 3, user: bot, created_at: created, body: pairedMarker("security-reviewer", open, "3", 3) };
  const request = { headSha, prId: "3", appIdentity, ownerIds: ["7"], ownerLogin: "bugabinga" };
  assert.throws(() => validateAutoMergeMarkers({ ...request, comments: [...evidence, openComment] }), error => error?.code === "stale" && error.message === "auto-merge sticky risk is not owner-cleared");
  const ownerClear = { id: 4, user: { id: 7, login: "bugabinga", type: "User" }, created_at: cleared, body: pairedMarker("steerer", clear, "3", 4) };
  assert.doesNotThrow(() => validateAutoMergeMarkers({ ...request, comments: [...evidence, openComment, ownerClear] }));
  assert.doesNotThrow(() => validateAutoMergeMarkers({ ...request, comments: [...evidence, { ...openComment, user: { id: 7, login: "bugabinga", type: "User" } }, ownerClear] }));
  assert.throws(() => validateAutoMergeMarkers({ ...request, comments: [...evidence, openComment, { ...ownerClear, user: bot }] }), error => error?.code === "stale" && error.message === "auto-merge sticky risk is not owner-cleared");
});

test("rerun writes only the failed-jobs action bound to exact failed job evidence", async () => {
  const failedJobs = [{ id: "40", conclusion: "failure" }, { id: "41", conclusion: "cancelled" }];
  const operation = { type: "rerun_check", runId: "4", attempt: 1, failedJobs };
  const original = { id: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", status: "completed", conclusion: "failure", headSha, attempt: 1, failedJobs };
  const value = snapshot([], { runs: [original] });
  const authority = actionMarker(operation, value, { type: "rerun_check", runId: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", headSha, status: "completed", conclusion: "failure", attempt: 1, failedJobs });
  let markerBody = null;
  let markerStatus = null;
  let delivered = false;
  const { github, calls, mints } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.endsWith("/actions/runs/4")) return reply({ id: 4, name: "ci", event: "push", head_sha: headSha, run_attempt: delivered ? 2 : 1, status: delivered ? "queued" : "completed", conclusion: delivered ? null : "failure", triggering_actor: delivered ? bot : { id: 7, login: "bugabinga", type: "User" }, updated_at: delivered ? "2026-01-01T00:00:01.000Z" : "2025-12-31T00:00:00.000Z" });
    if (request.args[2] === "GET" && path.includes("/actions/runs/4/jobs?")) return reply({ jobs: failedJobs.map(job => ({ ...job, id: Number(job.id), run_attempt: 1, status: "completed", name: `job-${job.id}` })) });
    const liveMarker = () => ({ id: 10, ...markerBody, external_id: markerBody.external_id, head_sha: markerBody.head_sha, status: markerStatus, conclusion: markerStatus === "completed" ? "success" : null, output: markerBody.output, app, created_at: "2026-01-01T00:00:00.000Z" });
    if (request.args[2] === "GET" && path.startsWith(`/repos/bugabinga/smith/commits/${controlSha}/check-runs?`)) return reply({ check_runs: markerBody === null ? [] : [liveMarker()] });
    if (request.args[2] === "GET" && path.endsWith("/check-runs/10")) return reply(liveMarker());
    if (request.args[2] === "POST" && path.endsWith("/check-runs")) { markerBody = body(request); markerStatus = "in_progress"; return reply({ id: 10 }); }
    if (request.args[2] === "POST" && path.endsWith("/actions/runs/4/rerun-failed-jobs")) { assert.equal(delivered, false); delivered = true; return reply(null); }
    if (request.args[2] === "PATCH" && path.endsWith("/check-runs/10")) { markerStatus = "completed"; return reply(liveMarker()); }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  assert.equal((await apply(github, operation, value)).status, "complete");
  const writes = calls.filter(call => call.args[2] !== "GET");
  assert.deepEqual(writes.map(call => [call.args[2], endpoint(call)]), [["POST", "/repos/bugabinga/smith/check-runs"], ["POST", "/repos/bugabinga/smith/actions/runs/4/rerun-failed-jobs"], ["PATCH", "/repos/bugabinga/smith/check-runs/10"]]);
  assert.equal(writes.filter(call => endpoint(call).endsWith("/actions/runs/4/rerun-failed-jobs")).length, 1);
  assert.equal(writes.some(call => endpoint(call).endsWith("/actions/runs/4/rerun")), false);
  assert.deepEqual(mints.map(mint => mint.permissions), [["actions:write", "checks:write"]]);
  assert.deepEqual(body(writes[0]), { name: "smith/apply-action", head_sha: controlSha, status: "in_progress", output: { title: "smith/apply-action", summary: authority.summary }, external_id: authority.externalId });
  assert.deepEqual(body(writes[1]), {});
  assert.deepEqual(body(writes[2]), { status: "completed", conclusion: "success", output: { title: "smith/apply-action", summary: authority.summary } });
  const searches = calls.filter(call => endpoint(call).startsWith(`/repos/bugabinga/smith/commits/${controlSha}/check-runs?`));
  assert.ok(searches.length >= 1);
  assert.ok(searches.every(call => endpoint(call) === `/repos/bugabinga/smith/commits/${controlSha}/check-runs?filter=all&per_page=100&page=1`));
  assert.equal(calls.some(call => endpoint(call).startsWith("/repos/bugabinga/smith/check-runs?")), false);
});

test("an exact bot-triggered increased rerun completes an in-progress marker without duplicate delivery", async () => {
  const failedJobs = [{ id: "40", conclusion: "failure" }];
  const operation = { type: "rerun_check", runId: "4", attempt: 1, failedJobs };
  const value = snapshot([], { runs: [{ id: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", status: "completed", conclusion: "failure", headSha, attempt: 1, failedJobs }] });
  const authority = actionMarker(operation, value, { type: "rerun_check", runId: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", headSha, status: "completed", conclusion: "failure", attempt: 1, failedJobs });
  const marker = status => ({ id: 10, name: "smith/apply-action", head_sha: controlSha, status, conclusion: status === "completed" ? "success" : null, external_id: authority.externalId, output: { title: "smith/apply-action", summary: authority.summary }, app, created_at: "2026-01-01T00:00:00.000Z" });
  let markerValue = marker("in_progress");
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path.endsWith("/actions/runs/4")) return reply({ id: 4, name: "ci", event: "push", head_sha: headSha, run_attempt: 2, status: "queued", conclusion: null, triggering_actor: bot, updated_at: "2026-01-01T00:00:01.000Z" });
    if (path.includes("/actions/runs/4/jobs?")) return reply({ jobs: [
      { id: 40, name: "source-test", run_attempt: 1, status: "completed", conclusion: "failure" },
      { id: 50, name: "newer-test", run_attempt: 2, status: "completed", conclusion: "failure" },
    ] });
    if (path.startsWith(`/repos/bugabinga/smith/commits/${controlSha}/check-runs?`)) return reply({ check_runs: [markerValue] });
    if (request.args[2] === "PATCH" && path.endsWith("/check-runs/10")) { markerValue = marker("completed"); return reply(markerValue); }
    if (path.endsWith("/check-runs/10")) return reply(markerValue);
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  assert.equal((await apply(github, operation, value)).status, "complete");
  assert.equal(calls.filter(call => endpoint(call).endsWith("/actions/runs/4/rerun")).length, 0);
  assert.equal(calls.filter(call => call.args[2] === "PATCH" && endpoint(call).endsWith("/check-runs/10")).length, 1);

  assert.equal((await apply(github, operation, value)).status, "complete");
  assert.equal(calls.filter(call => endpoint(call).endsWith("/actions/runs/4/rerun")).length, 0);

  markerValue = { ...marker("completed"), output: { title: "smith/apply-action", summary: canonicalBytes({ target: { type: "dispatch_workflow" } }).toString("utf8") } };
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "stale" && error.message === "conflicting action marker");
});

test("in-progress rerun recovery rejects a non-exact attempt lineage", async () => {
  const failedJobs = [{ id: "40", conclusion: "failure" }];
  const operation = { type: "rerun_check", runId: "4", attempt: 1, failedJobs };
  const value = snapshot([], { runs: [{ id: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", status: "completed", conclusion: "failure", headSha, attempt: 1, failedJobs }] });
  const authority = actionMarker(operation, value, { type: "rerun_check", runId: "4", name: "ci", workflowPath: null, displayTitle: null, event: "push", headSha, status: "completed", conclusion: "failure", attempt: 1, failedJobs });
  const marker = { id: 10, name: "smith/apply-action", head_sha: controlSha, status: "in_progress", conclusion: null, external_id: authority.externalId, output: { title: "smith/apply-action", summary: authority.summary }, app, created_at: "2026-01-01T00:00:00.000Z" };
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path.endsWith("/actions/runs/4")) return reply({ id: 4, name: "ci", event: "push", head_sha: headSha, run_attempt: 3, status: "queued", conclusion: null, triggering_actor: bot, updated_at: "2026-01-01T00:00:01.000Z" });
    if (path.includes("/actions/runs/4/jobs?")) return reply({ jobs: [{ id: 40, name: "test", status: "completed", conclusion: "failure" }] });
    if (path.startsWith(`/repos/bugabinga/smith/commits/${controlSha}/check-runs?`)) return reply({ check_runs: [marker] });
    throw new Error(`unexpected ${path}`);
  });
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "contract" && error.message === "rerun source does not match snapshot");
  assert.equal(calls.some(call => call.args[2] !== "GET"), false);
});

function dispatchFixture() {
  const issue = { id: 1, number: 1, state: "open", title: "Route", body: "", labels: [], milestone: null, updated_at: "2026-01-01T00:00:00.000Z" };
  const sourceRevision = issueSourceRevision(issue);
  const operation = {
    type: "dispatch_repository",
    eventType: "retry_route",
    clientPayload: { repositoryId: "42", issueId: "1", sourceRevision, role: "builder", provider: "claude" },
  };
  const routing = { role: "reconciler", mode: "single", primary: null };
  const value = { ...snapshot(), routing, state: { currentRevisions: { "issue:1": sourceRevision }, reconciliation: { pulls: [] } } };
  const exactRun = {
    id: 20,
    path: ".github/workflows/adw-issues.yml",
    head_branch: "main",
    head_sha: controlSha,
    event: "repository_dispatch",
    display_title: digestJson(operation),
    status: "queued",
    conclusion: null,
    actor: bot,
    created_at: "2026-01-01T00:00:00.000Z",
    run_attempt: 1,
  };
  return { issue, operation, routing, value, exactRun };
}

test("repository dispatch rereads exact revisions and rejects drift before POST", async () => {
  const { issue, operation, routing, exactRun } = dispatchFixture();
  const originalRevision = issueSourceRevision(issue);
  const value = {
    ...snapshot([{ resource: "issue:1", kind: "issue", token: originalRevision }]),
    routing,
    state: { currentRevisions: { "issue:1": originalRevision }, reconciliation: { pulls: [] } },
  };
  let issueReads = 0;
  let dispatched = false;
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path === "/repos/bugabinga/smith/issues/1") {
      issueReads++;
      return reply(issueReads < 4 ? issue : { ...issue, body: "drifted immediately before dispatch" });
    }
    if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
    if (request.args[2] === "POST" && path === "/repos/bugabinga/smith/dispatches") { dispatched = true; return reply(null); }
    if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) return reply({ workflow_runs: dispatched ? [exactRun] : [] });
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  }, { now: () => "2026-01-01T00:00:00.000Z", sleep: async () => {} });
  await assert.rejects(
    () => apply(github, operation, value, { routing }),
    error => error?.code === "stale" && error.message === "precondition changed",
  );
  assert.ok(issueReads >= 2);
  assert.equal(calls.some(call => endpoint(call) === "/repos/bugabinga/smith/dispatches"), false);
});

test("an existing failed dispatch child proves delivery and is never redispatched", async () => {
  const { issue, operation, routing, value, exactRun } = dispatchFixture();
  const failed = { ...exactRun, status: "completed", conclusion: "failure", run_attempt: 2 };
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path === "/repos/bugabinga/smith/issues/1") return reply(issue);
    if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
    if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) return reply({ workflow_runs: [failed] });
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  assert.equal((await apply(github, operation, value, { routing })).status, "complete");
  assert.equal(calls.some(call => endpoint(call) === "/repos/bugabinga/smith/dispatches"), false);
});

test("repository dispatch uses contents write, then boundedly polls one exact App run", async () => {
  const { issue, operation, routing, value, exactRun } = dispatchFixture();
  let delivered = false;
  let deliveryReads = 0;
  const waits = [];
  const { github, calls, mints } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path === "/repos/bugabinga/smith/issues/1") return reply(issue);
    if (request.args[2] === "GET" && path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
    if (request.args[2] === "POST" && path === "/repos/bugabinga/smith/dispatches") { delivered = true; return reply(null); }
    if (request.args[2] === "GET" && path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) {
      if (!delivered) return reply({ workflow_runs: [] });
      deliveryReads++;
      return reply({ workflow_runs: deliveryReads < 3 ? [] : [exactRun] });
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  }, {
    now: () => "2026-01-01T00:00:00.999Z",
    sleep: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal((await apply(github, operation, value, { routing })).status, "complete");
  const delivery = calls.find(call => endpoint(call) === "/repos/bugabinga/smith/dispatches");
  assert.deepEqual(body(delivery), { event_type: "retry_route", client_payload: { ...operation.clientPayload, smith_operation_digest: digestJson(operation) } });
  assert.equal(calls.filter(call => endpoint(call) === "/repos/bugabinga/smith/dispatches").length, 1);
  assert.deepEqual(mints.map(mint => mint.permissions), [["contents:write", "repository:read"]]);
  assert.deepEqual(waits, [5000, 5000]);
  const searches = calls.filter(call => endpoint(call).startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?"));
  assert.equal(searches.length, 5);
  assert.ok(searches.every(call => endpoint(call).includes("event=repository_dispatch&per_page=20&page=1")));
  assert.equal(calls.some(call => endpoint(call).includes("check-runs")), false);
  assert.equal(calls.some(call => endpoint(call).includes("/actions/workflows/adw-issues.yml/dispatches")), false);
});

test("repository dispatch run proof binds every identity field and times out retryably", async () => {
  const { issue, operation, routing, value, exactRun } = dispatchFixture();
  const mismatches = [
    { event: "workflow_dispatch" },
    { path: ".github/workflows/adw-pulls.yml" },
    { display_title: "f".repeat(64) },
    { actor: { ...bot, id: 999 } },
    { head_branch: "feature" },
    { head_sha: headSha },
    { created_at: "2025-12-31T23:59:59.999Z" },
    { status: "completed", conclusion: null },
  ];
  for (const mismatch of mismatches) {
    let delivered = false;
    let writes = 0;
    const waits = [];
    const { github } = harness(request => {
      const path = endpoint(request);
      if (path === "/repos/bugabinga/smith/issues/1") return reply(issue);
      if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
      if (request.args[2] === "POST" && path === "/repos/bugabinga/smith/dispatches") { delivered = true; writes++; return reply(null); }
      if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) return reply({ workflow_runs: delivered ? [{ ...exactRun, ...mismatch }] : [] });
      throw new Error(`unexpected ${request.args[2]} ${path}`);
    }, { now: () => "2026-01-01T00:00:00.000Z", sleep: async milliseconds => { waits.push(milliseconds); } });
    await assert.rejects(
      () => apply(github, operation, value, { routing }),
      error => error?.code === "forge" && error.message === (Object.hasOwn(mismatch, "status") ? "malformed" : "repository dispatch delivery timed out"),
      JSON.stringify(mismatch),
    );
    assert.equal(writes, 1);
    assert.equal(waits.length, Object.hasOwn(mismatch, "status") ? 0 : 11);
    assert.ok(waits.every(milliseconds => milliseconds === 5000));
  }
});

test("repository dispatch timeout is recoverable without reposting, while duplicate exact runs fail closed", async () => {
  const { issue, operation, routing, value, exactRun } = dispatchFixture();
  let delivered = false;
  let visible = false;
  let writes = 0;
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path === "/repos/bugabinga/smith/issues/1") return reply(issue);
    if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
    if (request.args[2] === "POST" && path === "/repos/bugabinga/smith/dispatches") { delivered = true; writes++; return reply(null); }
    if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) return reply({ workflow_runs: delivered && visible ? [exactRun] : [] });
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  }, { now: () => "2026-01-01T00:00:00.000Z", sleep: async () => {} });
  await assert.rejects(
    () => apply(github, operation, value, { routing }),
    error => error?.code === "forge" && error.message === "repository dispatch delivery timed out",
  );
  assert.equal(writes, 1);
  visible = true;
  assert.equal((await apply(github, operation, value, { routing })).status, "complete");
  assert.equal(writes, 1);

  const duplicate = harness(request => {
    const path = endpoint(request);
    if (path === "/repos/bugabinga/smith/issues/1") return reply(issue);
    if (path === "/repos/bugabinga/smith/git/ref/heads/main") return reply({ object: { sha: controlSha } });
    if (path.startsWith("/repos/bugabinga/smith/actions/workflows/adw-issues.yml/runs?")) return reply({ workflow_runs: [exactRun, { ...exactRun, id: 21 }] });
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  }, { now: () => "2026-01-01T00:00:00.000Z", sleep: async () => {} });
  await assert.rejects(
    () => apply(duplicate.github, operation, value, { routing }),
    error => error?.code === "stale" && error.message === "conflicting repository dispatch runs",
  );
  assert.equal(duplicate.calls.some(call => call.args[2] !== "GET"), false);
  assert.equal(calls.filter(call => endpoint(call) === "/repos/bugabinga/smith/dispatches").length, 1);
});

test("auto-merge freshly enforces non-draft clean current-head authority immediately before GraphQL", async () => {
  const operation = { type: "arm_auto_merge", prId: "3", headSha, method: "squash" };
  const routing = { role: "auditor", mode: "single", primary: null };
  const value = {
    ...snapshot([{ resource: "pull:3", kind: "pull", token: headSha }]), routing,
    state: { entityId: "3", trust: { ownerIds: ["7"], appId: appIdentity.botUserId }, resources: {} },
  };
  const canonicalDecision = decision(value, [operation]);
  const correctness = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${"1".repeat(64)} -->`;
  const security = `<!-- smith:review-evidence/v1 kind=security head=${headSha} conclusion=approve provider=codex authoritative=true artifact=${"2".repeat(64)} -->`;
  const comments = [{ id: 1, user: bot, body: pairedMarker("reviewer", correctness) }, { id: 2, user: bot, body: pairedMarker("security-reviewer", security) }];
  let pullReads = 0;
  let graphqlCalls = 0;
  let checkApp = { id: 99, slug: "other" };
  const { github } = harness(request => {
    const path = endpoint(request);
    if (request.args[1] === "graphql") { graphqlCalls++; return reply({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "P_3" } } } }); }
    if (request.args[2] === "GET" && path.endsWith("/pulls/3")) {
      pullReads++;
      return reply({ id: 3, node_id: "P_3", number: 3, state: "open", draft: pullReads >= 4, mergeable_state: "clean", labels: [], head: { sha: headSha }, auto_merge: graphqlCalls ? { merge_method: "squash" } : null });
    }
    if (request.args[2] === "GET" && path.includes(`/commits/${headSha}/check-runs?`)) return reply({ check_runs: [{ id: 4, name: "check", head_sha: headSha, status: "completed", conclusion: "success", app: checkApp }] });
    if (request.args[2] === "GET" && path.includes("/issues/3/comments?")) return reply(comments);
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await assert.rejects(
    () => apply(github, operation, value, { routing, decision: canonicalDecision }),
    error => error?.code === "stale" && error.message === "auto-merge check failed",
  );
  checkApp = { id: 15368, slug: "github-actions" };
  pullReads = 0;
  await assert.rejects(
    () => apply(github, operation, value, { routing, decision: canonicalDecision }),
    error => error?.code === "stale" && error.message === "auto-merge precondition failed",
  );
  assert.equal(graphqlCalls, 0);
});

test("auto-merge may arm while GitHub reports blocked by its missing gate, but not when explicitly behind or dirty", async () => {
  const operation = { type: "arm_auto_merge", prId: "3", headSha, method: "squash" };
  const routing = { role: "auditor", mode: "single", primary: null };
  const value = {
    ...snapshot([{ resource: "pull:3", kind: "pull", token: headSha }]), routing,
    state: { entityId: "3", trust: { ownerIds: ["7"], appId: appIdentity.botUserId }, resources: {} },
  };
  const correctness = `<!-- smith:review-evidence/v1 kind=correctness head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${"1".repeat(64)} -->`;
  const security = `<!-- smith:review-evidence/v1 kind=security head=${headSha} conclusion=approve provider=codex authoritative=true artifact=${"2".repeat(64)} -->`;
  const comments = [{ id: 1, user: bot, body: pairedMarker("reviewer", correctness) }, { id: 2, user: bot, body: pairedMarker("security-reviewer", security) }];
  for (const mergeState of ["blocked", "behind", "dirty"]) {
    let armed = false;
    const { github } = harness(request => {
      const path = endpoint(request);
      if (request.args[1] === "graphql") { armed = true; return reply({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "P_3" } } } }); }
      if (path.endsWith("/pulls/3")) return reply({ id: 3, node_id: "P_3", number: 3, state: "open", draft: false, mergeable_state: mergeState, labels: [], head: { sha: headSha }, auto_merge: armed ? { merge_method: "squash" } : null });
      if (path.includes(`/commits/${headSha}/check-runs?`)) return reply({ check_runs: [{ id: 4, name: "check", head_sha: headSha, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" } }] });
      if (path.includes("/issues/3/comments?")) return reply(comments);
      throw new Error(`unexpected ${request.args[2]} ${path}`);
    });
    if (mergeState === "blocked") {
      assert.equal((await apply(github, operation, value, { routing })).status, "complete");
      assert.equal(armed, true);
    } else {
      await assert.rejects(() => apply(github, operation, value, { routing }), error => error?.code === "stale" && error.message === "auto-merge precondition failed");
      assert.equal(armed, false);
    }
  }
});

test("operation capabilities are exact, operation-scoped, and exclude settings writes", () => {
  assert.deepEqual(operationCapabilities({ type: "comment" }), ["issues:write"]);
  assert.deepEqual(operationCapabilities({ type: "publish_check" }), ["checks:write"]);
  assert.deepEqual(operationCapabilities({ type: "rerun_check", runId: "4", attempt: 1, failedJobs: [{ id: "40", conclusion: "failure" }] }), ["actions:write", "checks:write"]);
  assert.deepEqual(operationCapabilities({ type: "dispatch_repository" }), ["contents:write", "repository:read"]);
  const reconciliationSnapshot = snapshot([
    { resource: "issues", kind: "issues", token: "r" },
    { resource: "pulls", kind: "pulls", token: "r" },
    { resource: "runs", kind: "workflow_runs", token: "r" },
    { resource: "trusted:.github/labels.yml", kind: "control", token: controlSha },
    { resource: "repository", kind: "repository", token: "r" },
  ]);
  assert.deepEqual(operationCapabilities({ type: "dispatch_repository" }, reconciliationSnapshot), ["actions:read", "checks:read", "contents:write", "issues:read", "pulls:read", "repository:read"]);
  assert.deepEqual(operationCapabilities({ type: "add_label" }, reconciliationSnapshot), ["actions:read", "checks:read", "contents:read", "issues:write", "pulls:read", "repository:read"]);
  assert.deepEqual(operationCapabilities({ type: "create_pr" }), ["pulls:write"]);
  assert.deepEqual(operationCapabilities({ type: "arm_auto_merge" }), ["checks:read", "issues:read", "pulls:write"]);
  assert.deepEqual(operationCapabilities({ type: "sync_labels" }), ["contents:read", "issues:write"]);
  assert.deepEqual(operationCapabilities({ type: "create_pr" }, snapshot([
    { resource: "issue:1", kind: "issue", token: "r" },
    { resource: "patch-base:main", kind: "git_ref", token: headSha },
    { resource: "repository", kind: "repository", token: "r" },
    { resource: "trusted:.claude/agents/builder.md", kind: "control", token: controlSha },
  ])), ["contents:read", "issues:read", "pulls:write", "repository:read"]);
  assert.throws(() => operationCapabilities({ type: "settings" }), error => error?.code === "contract");
});

test("minted token declaration must match the exact operation permissions", async () => {
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const denied = harness(() => assert.fail("permission mismatch must prevent GitHub access"), { permissions: ["issues:read"] });
  await assert.rejects(() => apply(denied.github, operation), error => error?.code === "contract" && error.message === "GitHub App token permissions do not match operation class");
  assert.equal(denied.calls.length, 0);
});

test("sync_labels validates trusted control content digest and upserts only named definitions", async () => {
  const definitions = [{ name: "ready", color: "00ff00", description: "Ready" }, { name: "hold", color: "ff0000", description: "Held" }];
  const source = JSON.stringify(definitions);
  const trusted = { trust: "trusted", source: ".github/labels.yml", bytes: canonicalBytes(source).length, digest: digestJson(source), data: source };
  const value = snapshot([
    { resource: "labels", kind: "labels", token: digestJson([]) },
    { resource: "trusted:.github/labels.yml", kind: "control", token: "c".repeat(40) },
  ], { "trusted:.github/labels.yml": trusted, labels: [] });
  const operation = { type: "sync_labels", definitionsDigest: digestJson(definitions) };
  const live = new Map();
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path.includes("/contents/.github/labels.yml?ref=")) return reply({ encoding: "base64", content: Buffer.from(source).toString("base64"), sha: "c".repeat(40) });
    if (request.args[2] === "GET" && path.includes("/labels?")) return reply([...live.values()]);
    if (request.args[2] === "GET" && path.includes("/labels/")) return reply(live.get(decodeURIComponent(path.split("/").at(-1))));
    if (request.args[2] === "POST") { const label = { id: live.size + 1, ...body(request) }; live.set(label.name, label); return reply(label); }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  assert.equal((await apply(github, operation, value)).status, "complete");
  const writes = calls.filter(call => call.args[2] !== "GET");
  assert.deepEqual(writes.map(call => [call.args[2], endpoint(call), body(call)]), [
    ["POST", "/repos/bugabinga/smith/labels", definitions[0]],
    ["POST", "/repos/bugabinga/smith/labels", definitions[1]],
  ]);
  await assert.rejects(() => apply(github, { ...operation, definitionsDigest: "f".repeat(64) }, value), error => error?.code === "stale");
});

test("sync_labels resumes per label but rejects unrelated label drift", async () => {
  const definitions = [{ name: "ready", color: "00ff00", description: "Ready" }, { name: "hold", color: "ff0000", description: "Held" }];
  const source = JSON.stringify(definitions);
  const trusted = { trust: "trusted", source: ".github/labels.yml", bytes: canonicalBytes(source).length, digest: digestJson(source), data: source };
  const value = snapshot([
    { resource: "labels", kind: "labels", token: digestJson([]) },
    { resource: "trusted:.github/labels.yml", kind: "control", token: "c".repeat(40) },
  ], { "trusted:.github/labels.yml": trusted, labels: [] });
  const operation = { type: "sync_labels", definitionsDigest: digestJson(definitions) };
  const live = new Map();
  let failHold = true;
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path.includes("/contents/.github/labels.yml?ref=")) return reply({ encoding: "base64", content: Buffer.from(source).toString("base64"), sha: "c".repeat(40) });
    if (request.args[2] === "GET" && path.includes("/labels?")) return reply([...live.values()]);
    if (request.args[2] === "GET" && path.includes("/labels/")) return reply(live.get(decodeURIComponent(path.split("/").at(-1))));
    if (request.args[2] === "POST") {
      const input = body(request);
      if (input.name === "hold" && failHold) { const error = new Error("secret API failure"); error.details = { httpStatus: 500 }; throw error; }
      const label = { id: input.name === "ready" ? 101 : 102, ...input };
      live.set(label.name, label);
      return reply(label);
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "forge" && error.message === "server");
  assert.deepEqual([...live.keys()], ["ready"]);
  failHold = false;
  assert.equal((await apply(github, operation, value)).status, "complete");
  assert.equal(calls.filter(call => call.args[2] === "POST" && body(call).name === "ready").length, 1);
  live.set("unrelated", { id: 999, name: "unrelated", color: "ffffff", description: "drift" });
  const writesBeforeDrift = calls.filter(call => call.args[2] !== "GET").length;
  await assert.rejects(() => apply(github, operation, value), error => error?.code === "stale" && error.message === "precondition changed");
  assert.equal(calls.filter(call => call.args[2] !== "GET").length, writesBeforeDrift);
});

test("checked-in YAML label definitions are accepted without deleting unnamed labels", async () => {
  const source = await readFile(new URL("../../.github/labels.yml", import.meta.url), "utf8");
  const definitions = [];
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    let match = /^- name:\s*(.+)$/.exec(line);
    if (match) { definitions.push({ name: JSON.parse(match[1]) }); continue; }
    match = /^(color|description):\s*(.*)$/.exec(line);
    if (match) definitions.at(-1)[match[1]] = JSON.parse(match[2]);
  }
  const trusted = { trust: "trusted", source: ".github/labels.yml", bytes: canonicalBytes(source).length, digest: digestJson(source), data: source };
  const value = snapshot([
    { resource: "labels", kind: "labels", token: digestJson([]) },
    { resource: "trusted:.github/labels.yml", kind: "control", token: "c".repeat(40) },
  ], { "trusted:.github/labels.yml": trusted, labels: [] });
  const live = new Map();
  const { github, calls } = harness(request => {
    const path = endpoint(request);
    if (path.includes("/contents/")) return reply({ encoding: "base64", content: Buffer.from(source).toString("base64"), sha: "c".repeat(40) });
    if (request.args[2] === "GET" && path.includes("/labels?")) return reply([...live.values()]);
    if (request.args[2] === "GET" && path.includes("/labels/")) return reply(live.get(decodeURIComponent(path.split("/").at(-1))));
    if (request.args[2] === "POST") { const label = { id: live.size + 1, ...body(request) }; live.set(label.name, label); return reply(label); }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await apply(github, { type: "sync_labels", definitionsDigest: digestJson(definitions) }, value);
  assert.equal(calls.filter(call => call.args[2] === "POST").length, definitions.length);
  assert.equal(calls.some(call => call.args[2] === "DELETE"), false);
});

test("App identity and operation token failures cannot forge or leak write authority", async () => {
  assert.throws(() => createGitHub({ repository, token: null, appIdentity: { id: "12345", login: "smith[bot]" }, ghPath: process.execPath, baseEnv: {}, run: async () => {} }), error => error?.code === "contract");
  const operation = { type: "publish_check", headSha, name: "check", conclusion: "success", summary: "ok", externalId: "ignored" };
  const binding = operationBinding(operation);
  let { github, calls } = harness(request => endpoint(request).includes("/check-runs?")
    ? reply({ check_runs: [{ id: 1, name: "check", head_sha: headSha, status: "completed", conclusion: "success", output: { summary: "ok" }, external_id: `smith:${binding.decisionDigest}:0:${binding.operationDigest}`, app: { id: 99, slug: "other" } }] })
    : assert.fail("must not write"));
  await assert.rejects(() => apply(github, operation), error => error?.code === "stale" && error.message === "conflicting external id");
  assert.equal(calls.some(call => call.args[2] !== "GET"), false);

  github = createGitHub({
    repository,
    token: async () => { throw new Error("secret-provider leaked-token"); },
    appIdentity,
    ghPath: process.execPath,
    baseEnv: { PATH: "/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp" },
    run: async () => assert.fail("must not invoke gh"),
  });
  await assert.rejects(() => apply(github, { type: "add_label", entityId: "1", label: "ready" }), error => error?.code === "forge" && error.message === "auth" && !JSON.stringify(error).includes("secret-provider") && !JSON.stringify(error).includes("leaked-token"));
});

test("prior-operation receipts must match every bound transition", async () => {
  const operations = [{ type: "noop", reason: "unchanged" }, { type: "add_label", entityId: "1", label: "ready" }];
  const value = routedSnapshot(operations[1], snapshot());
  const canonicalDecision = decision(value, operations);
  const { github, calls } = harness(() => assert.fail("must reject before gh"));
  const first = await apply(github, operations[0], value, { decision: canonicalDecision, operationIndex: 0, operations });
  await assert.rejects(() => apply(github, operations[1], value, { decision: canonicalDecision, operationIndex: 1, operations, priorOperations: [{ ...first, afterRevision: "f".repeat(64) }] }), error => error?.code === "contract" && error.message === "apply operation receipt is invalid");
  await assert.rejects(() => apply(github, operations[1], value, { decision: canonicalDecision, operationIndex: 1, operations, priorOperations: [first] }), error => error?.code === "contract" && error.message === "prior forge authority must be reconstructed by full apply");
  assert.equal(calls.length, 0);
});

test("partial retries chain from the latest observed token and reject unrelated drift", async () => {
  const original = "2026-01-01T00:00:00.000Z";
  const firstPost = "2026-01-01T00:00:01.000Z";
  const unrelated = "2026-01-01T00:00:02.000Z";
  let issue = { id: 1001, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: original };
  const revisions = [{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }];
  const operations = [{ type: "add_label", entityId: "1", label: "ready" }, { type: "add_label", entityId: "1", label: "blocked" }];
  const value = routedSnapshot(operations[0], snapshot(revisions));
  const canonicalDecision = decision(value, operations);
  const proof = verification(value, canonicalDecision);
  let failSecond = true;
  let blockedWrites = 0;
  const { github } = harness(request => {
    if (request.args[2] === "GET") return reply(issue);
    const input = body(request);
    if (input.labels?.includes("blocked")) {
      blockedWrites++;
      if (failSecond) { const error = new Error("secret API failure"); error.details = { httpStatus: 500 }; throw error; }
    }
    issue = { ...issue, labels: [...issue.labels, { name: input.labels[0] }], updated_at: input.labels[0] === "ready" ? firstPost : "2026-01-01T00:00:03.000Z" };
    return reply(issue);
  });
  let partialReceipt;
  await assert.rejects(
    () => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null }),
    error => {
      partialReceipt = error?.details?.partialReceipt;
      return error?.code === "forge" && error.message === "server" && partialReceipt?.operations?.length === 1;
    },
  );
  assert.equal(partialReceipt.operations[0].afterRevision, digestJson([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }]));
  issue = { ...issue, labels: [...issue.labels, { name: "external" }], updated_at: unrelated };
  failSecond = false;
  const writesBeforeRetry = blockedWrites;
  await assert.rejects(
    () => github.apply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: partialReceipt }),
    error => error?.code === "stale" && error.message === "precondition changed",
  );
  assert.equal(blockedWrites, writesBeforeRetry);
  const brokenChain = {
    operationDigest: digestJson(operations[1]), status: "complete",
    beforeRevision: proof.preconditionDigest, preparedRevision: "e".repeat(64), afterRevision: "f".repeat(64),
  };
  assert.throws(() => createApplyReceipt({ decision: canonicalDecision, snapshot: value, verification: proof, operations: [partialReceipt.operations[0], brokenChain] }), error => error?.code === "contract");
});

test("injected E2E: patch PR applies VCS before GitHub metadata with bound subreceipts", async () => {
  const bytes = Buffer.from("patch");
  const manifest = { baseSha: headSha, digest: digestBytes(bytes), size: bytes.length, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const value = {
    ...routedSnapshot({ type: "create_pr" }, snapshot([{ resource: "patch-base:main", kind: "git_ref", token: headSha }])),
    routing: { role: "builder", mode: "single", primary: "claude" },
  };
  const operation = { type: "create_pr", head: "claude/issue-1", base: "main", title: "Patch", body: "Body", marker: "patch-marker" };
  const canonicalDecision = { ...decision(value, [operation]), kind: "patch", patch: manifest };
  const proof = { ...verification(value, canonicalDecision), kind: "patch", patch: manifest, resultTree: "c".repeat(40) };
  const order = [];
  const before = proof.preconditionDigest;
  const vcs = { applyVerifiedPatch: async request => {
    order.push("vcs");
    assert.equal(request.patchBytes, bytes);
    return { operationDigest: digestJson(operation), projection: "vcs_head", status: "complete", beforeRevision: before, preparedRevision: "1".repeat(64), afterRevision: "1".repeat(64), headSha: "d".repeat(40) };
  } };
  const github = { apply: async request => {
    order.push("github");
    assert.equal(request.previousReceipt, null);
    return { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [{ operationDigest: digestJson(operation), status: "complete", beforeRevision: before, preparedRevision: "2".repeat(64), afterRevision: "2".repeat(64) }] };
  } };
  const result = await composeApply({ sourceDigest: "3".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, patchBytes: bytes, github, vcs, vcsRequest: {} });
  assert.deepEqual(order, ["vcs", "github"]);
  assert.deepEqual(result.operations[0].receipts.map(receipt => receipt.projection), ["vcs_head", "github_metadata"]);
  assert.equal(result.status, "complete");
  assert.doesNotThrow(() => validateApplyResult(result, { sourceDigest: "3".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, authority: role("builder"), capabilities: result.authority.capabilities }));
});

test("injected E2E: patch update_pr decomposes VCS head and metadata under one operation digest", async () => {
  const bytes = Buffer.from("revision");
  const manifest = { baseSha: headSha, digest: digestBytes(bytes), size: bytes.length, files: [{ path: "smith/src/lib.rs", kind: "regular", oldMode: "100644", newMode: "100644" }] };
  const value = { ...snapshot([{ resource: "pull:3", kind: "pull", token: headSha }, { resource: "ref:feature", kind: "git_ref", token: headSha }]), event: { kind: "pull_request", action: "synchronize", entityId: "3" }, routing: { role: "reviser", mode: "single", primary: "claude" }, state: { entityId: "3", headSha, headBranch: "feature", resources: { "pull:3": { headRepository: repository, headBranch: "feature", headSha } } } };
  const operation = { type: "update_pr", prId: "3", body: "Revised", headSha };
  const canonicalDecision = { ...decision(value, [operation]), kind: "patch", patch: manifest };
  const proof = { ...verification(value, canonicalDecision), kind: "patch", patch: manifest, resultTree: "c".repeat(40) };
  const raw = revision => ({ operationDigest: digestJson(operation), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: revision, afterRevision: revision });
  const result = await composeApply({
    sourceDigest: "4".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, patchBytes: bytes,
    vcs: { applyVerifiedPatch: async () => ({ ...raw("5".repeat(64)), projection: "vcs_head", headSha: "e".repeat(40) }) }, vcsRequest: {},
    github: { apply: async request => {
      assert.deepEqual(request.vcsProjections, [{ operationDigest: digestJson(operation), headSha: "e".repeat(40) }]);
      return { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [raw("6".repeat(64))] };
    } },
  });
  assert.equal(new Set(result.operations[0].receipts.map(value => value.operationDigest)).size, 1);
  assert.deepEqual(result.operations[0].receipts.map(value => value.projection), ["vcs_head", "github_metadata"]);
});

test("injected E2E: partial retry binds previous receipt and resumes without caller authority", async () => {
  const operations = [{ type: "add_label", entityId: "1", label: "ready" }, { type: "comment", entityId: "1", body: "done", marker: "done-marker" }];
  const value = routedSnapshot(operations[0], snapshot());
  const canonicalDecision = decision(value, operations);
  const proof = verification(value, canonicalDecision);
  const first = { operationDigest: digestJson(operations[0]), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: "7".repeat(64), afterRevision: "7".repeat(64) };
  const failed = new AdwError("forge", "server", { partialReceipt: { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [first] } });
  const partial = await composeApply({ sourceDigest: "8".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, github: { apply: async () => { throw failed; } } });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.operations.map(value => value.status), ["complete", "failed"]);
  let supplied;
  const second = { operationDigest: digestJson(operations[1]), status: "complete", beforeRevision: first.afterRevision, preparedRevision: "9".repeat(64), afterRevision: "9".repeat(64) };
  const complete = await composeApply({
    sourceDigest: "8".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, previousReceipt: partial,
    github: { apply: async request => { supplied = request.previousReceipt; return { decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [first, second] }; } },
  });
  assert.deepEqual(supplied.operations, [first]);
  assert.equal(complete.status, "complete");
});

test("injected E2E: stale retry emits canonical sanitized failure", async () => {
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const value = routedSnapshot(operation, snapshot());
  const canonicalDecision = decision(value, [operation]);
  const proof = verification(value, canonicalDecision);
  const result = await composeApply({ sourceDigest: "a".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, github: { apply: async () => { throw new AdwError("stale", "precondition changed\nsecret"); } } });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.failure, { operationIndex: 0, projection: "github_state", code: "stale", message: "precondition changed" });
});

test("pioneer marker comments do not self-stale stable issue revisions, but content changes do", async () => {
  const issue = { id: 1, number: 1, state: "open", title: "Claim", body: "Prototype this", labels: [{ name: "needs:prototype" }], milestone: null, updated_at: "2026-01-01T00:00:00.000Z" };
  const revision = issueSourceRevision(issue);
  const operation = { type: "comment", entityId: "1", body: "Result", marker: `<!-- smith:pioneer/v1 issue=1 source=${revision} verdict=inconclusive artifact=- -->` };
  const value = { ...snapshot([{ resource: "issue:1", kind: "issue", token: revision }]), routing: { role: "pioneer", mode: "single", primary: "claude" } };
  let live = structuredClone(issue);
  let comments = [];
  const { github } = harness(request => {
    const path = endpoint(request);
    if (request.args[2] === "GET" && path.endsWith("/issues/1")) return reply(live);
    if (request.args[2] === "GET" && path.includes("/issues/1/comments")) return reply(comments);
    if (request.args[2] === "POST" && path.endsWith("/issues/1/comments")) {
      live.updated_at = "2026-01-01T00:00:01.000Z";
      const comment = { id: 10, body: body(request).body, user: bot, created_at: live.updated_at };
      comments = [comment];
      return reply(comment);
    }
    throw new Error(`unexpected ${request.args[2]} ${path}`);
  });
  await apply(github, operation, value, { routing: value.routing });
  live = { ...live, body: "Changed claim", updated_at: "2026-01-01T00:00:02.000Z" };
  await assert.rejects(() => apply(github, operation, value, { routing: value.routing }), error => error?.code === "stale" && error.message === "precondition changed");
});

test("dry-run record writer performs identical stale reads without mutation", async () => {
  const original = "2026-01-01T00:00:00.000Z";
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  let liveIssue = { id: 1, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: original };
  const value = routedSnapshot(operation, snapshot([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(liveIssue) }]));
  const canonicalDecision = decision(value, [operation]);
  const proof = verification(value, canonicalDecision);
  const calls = [];
  const github = createGitHub({
    repository, token: null, appIdentity, ghPath: process.execPath,
    baseEnv: { PATH: "/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp" },
    run: async request => {
      calls.push(request);
      assert.equal(request.args[2], "GET");
      return reply(liveIssue);
    },
  });
  const recorded = await github.recordApply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null });
  assert.deepEqual(recorded.intents, [operation]);
  assert.equal(calls.some(call => call.args[2] !== "GET"), false);
  liveIssue = { ...liveIssue, body: "changed", updated_at: "2026-01-01T00:00:01.000Z" };
  await assert.rejects(() => github.recordApply({ decision: canonicalDecision, snapshot: value, verification: proof, previousReceipt: null }), error => error?.code === "stale" && error.message === "precondition changed");
  assert.equal(calls.some(call => call.args[2] !== "GET"), false);
});

test("injected E2E: product-check rerun remains a canonical provider decision operation", async () => {
  const operation = { type: "rerun_check", runId: "4", attempt: 1, failedJobs: [{ id: "40", conclusion: "failure" }] };
  const value = { ...snapshot(), routing: { role: "sweeper", mode: "single", primary: "codex" } };
  const canonicalDecision = decision(value, [operation]);
  const proof = verification(value, canonicalDecision);
  const raw = { operationDigest: digestJson(operation), status: "complete", beforeRevision: proof.preconditionDigest, preparedRevision: "b".repeat(64), afterRevision: "c".repeat(64) };
  const result = await composeApply({ sourceDigest: "d".repeat(64), snapshot: value, decision: canonicalDecision, verification: proof, github: { apply: async () => ({ decisionDigest: proof.decisionDigest, verificationDigest: digestJson(proof), operations: [raw] }) } });
  assert.equal(result.operations[0].receipts[0].projection, "github_state");
});

test("receipts persist observed original-prepared-post revision transitions", async () => {
  const original = "2026-01-01T00:00:00.000Z";
  const post = "2026-01-01T00:00:01.000Z";
  let issue = { id: 1001, number: 1, state: "open", title: "T", body: "B", labels: [], milestone: null, updated_at: original };
  const revisions = [{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }];
  const operation = { type: "add_label", entityId: "1", label: "ready" };
  const value = routedSnapshot(operation, snapshot(revisions));
  const canonicalDecision = decision(value, [operation]);
  const proof = verification(value, canonicalDecision);
  const { github } = harness(request => {
    if (request.args[2] === "GET") return reply(issue);
    issue = { ...issue, labels: [{ name: body(request).labels[0] }], updated_at: post };
    return reply(issue);
  });
  const receipt = await apply(github, operation, value, { decision: canonicalDecision });
  const observedPost = digestJson([{ resource: "issue:1", kind: "issue", token: issueSourceRevision(issue) }]);
  assert.deepEqual(receipt, {
    operationDigest: digestJson(operation),
    status: "complete",
    beforeRevision: proof.preconditionDigest,
    preparedRevision: observedPost,
    afterRevision: observedPost,
  });
  assert.deepEqual(GITHUB_OPERATION_TRANSITIONS.add_label, ["original", "prepared", "post"]);
  assert.deepEqual(createApplyReceipt({ decision: canonicalDecision, snapshot: value, verification: proof, operations: [receipt] }), {
    decisionDigest: proof.decisionDigest,
    verificationDigest: digestJson(proof),
    operations: [receipt],
  });
  assert.throws(() => createApplyReceipt({ decision: canonicalDecision, snapshot: value, verification: proof, operations: [{ ...receipt, beforeRevision: "f".repeat(64) }] }), error => error?.code === "contract");
  assert.throws(() => createApplyReceipt({ decision: canonicalDecision, snapshot: value, verification: proof, operations: [{ ...receipt, afterRevision: "f".repeat(64) }] }), error => error?.code === "contract");
});
