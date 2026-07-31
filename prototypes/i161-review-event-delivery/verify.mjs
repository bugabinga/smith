#!/usr/bin/env node
// i161 — prove `pull_request_review:submitted` and
// `pull_request_review_comment:created` through the Phase 4 wrappers and
// reconciler in a disposable repository (issue #161; roadmap Phase 4).
//
// This drives the REAL control plane (../../adw/github.mjs + core.mjs) with an
// injected fake `gh` process adapter, so the disposable repository is simulated
// entirely in-process with NO forge credentials. Each check prints a `PASS:` or
// `FAIL:` line; the script exits non-zero on the first failure.
//
// Verdict is EVIDENCE, not taste. The two events are NOT symmetric:
//   - pull_request_review:submitted  -> routes to the `reviser` role, produces
//     a bounded role snapshot, honours current-head (stale) rejection.
//   - pull_request_review_comment:created -> routes to NO role, so it CANNOT
//     become a bounded role snapshot. This contradicts acceptance criterion 1
//     ("Both events normalize into bounded role snapshots").

import assert from "node:assert/strict";
import { AdwError, canonicalBytes, planReconciliation } from "../../adw/core.mjs";
import { createGitHub, normalizeEvent, roleSnapshotPlan } from "../../adw/github.mjs";
import { role } from "../../adw/roles.mjs";

const HEAD = "a".repeat(40); // current head of the disposable PR
const STALE = "b".repeat(40); // an older head the event still points at
const CONTROL = "c".repeat(40);
const APP_ID = "A_1";
const ARTIFACT = "e".repeat(64);
const REPOSITORY = { id: 42, node_id: "R_1", name: "smith", full_name: "bugabinga/smith", default_branch: "main", owner: { id: 7, node_id: "U_7", login: "bugabinga" } };
const SENDER = { id: 7, node_id: "U_7", login: "bugabinga", type: "User" };

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS: ${label}`);
  } catch (error) {
    failures++;
    console.log(`FAIL: ${label} -- ${error?.message ?? error}`);
  }
}

// A fake `gh` for one disposable PR #7 whose live head is `pullHead`, carrying
// one approving review #555 at `reviewHead`. Everything else is empty.
function fakeGh({ pullHead = HEAD, reviewHead = HEAD } = {}) {
  const reply = value => ({ code: 0, signal: null, stdout: JSON.stringify(value), stderr: "" });
  return createGitHub({
    repository: "bugabinga/smith",
    token: "disposable-token",
    appIdentity: { id: APP_ID, login: "smith[bot]" },
    ghPath: process.execPath,
    baseEnv: { PATH: "/trusted/bin", HOME: "/tmp/home", LANG: "C.UTF-8", TMPDIR: "/tmp" },
    run: async request => {
      if (request.args[1] === "graphql") return reply({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
      const endpoint = request.args.at(-1);
      const base = endpoint.split("?")[0];
      if (base === "/repos/bugabinga/smith") return reply(REPOSITORY);
      if (base.startsWith("/repos/bugabinga/smith/contents/")) return reply({ encoding: "base64", content: Buffer.from("trusted control content").toString("base64"), sha: "d".repeat(40) });
      if (base === "/repos/bugabinga/smith/pulls/7") return reply({ id: 700, number: 7, state: "open", updated_at: "2026-07-30T00:00:00.000Z", merged: false, merge_commit_sha: null, head: { sha: pullHead, repo: { full_name: "bugabinga/smith" } }, base: { ref: "main" }, title: "Revision under review", body: "", labels: [] });
      if (base === "/repos/bugabinga/smith/pulls/7/files") return reply([{ filename: "src/lib.rs", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }]);
      if (base === "/repos/bugabinga/smith/pulls/7/reviews") return reply([{ id: 555, user: { id: 9 }, state: "approved", commit_id: reviewHead, submitted_at: "2026-07-30T00:00:00.000Z", body: "lgtm" }]);
      if (base === "/repos/bugabinga/smith/issues/7/comments") return reply([]);
      if (base === `/repos/bugabinga/smith/commits/${pullHead}/check-runs`) return reply({ check_runs: [] });
      throw new Error(`unexpected gh endpoint: ${endpoint}`);
    },
  });
}

function reviewEvent(headSha = HEAD) {
  return normalizeEvent("pull_request_review", { action: "submitted", repository: REPOSITORY, sender: SENDER, pull_request: { number: 7, head: { sha: headSha } }, review: { id: 555, commit_id: headSha } });
}

function reviewCommentEvent() {
  return normalizeEvent("pull_request_review_comment", { action: "created", repository: REPOSITORY, sender: SENDER, pull_request: { number: 7, head: { sha: HEAD } }, comment: { id: 8080, commit_id: HEAD } });
}

const reconSnapshot = {
  schemaVersion: 1,
  controlSha: CONTROL,
  event: { kind: "schedule", action: "scheduled", entityId: "42" },
  repository: { id: "42", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [],
  routing: { role: "sweeper", mode: "single", primary: null },
  state: { currentRevisions: { "issue:1": "rev-1" } },
};
const trust = { ownerIds: ["7"], appId: APP_ID };
const noiselessLabels = { wantedDigest: "0".repeat(64), liveDigest: "0".repeat(64) };

function reconcile({ reviews, comments = [] }) {
  return planReconciliation({ snapshot: reconSnapshot, routes: [], pulls: [], labelSync: noiselessLabels, comments, trust, reviews, pioneers: [], holds: [] });
}

function evidenceMarker(kind, headSha) {
  return { id: `100${kind === "correctness" ? 1 : 2}`, actorId: APP_ID, createdAt: "2026-07-30T00:00:00.000Z", repositoryId: "42", entityId: "7", body: `<!-- smith:review-evidence/v1 kind=${kind} head=${headSha} conclusion=approve provider=claude authoritative=true artifact=${ARTIFACT} -->` };
}

// ---------------------------------------------------------------------------
// 1. pull_request_review:submitted -> bounded role snapshot
// ---------------------------------------------------------------------------
await check("pull_request_review:submitted normalizes to the reviser role snapshot plan", () => {
  assert.deepEqual(roleSnapshotPlan("reviser", "pull_request_review").fields, ["changed_paths", "findings", "pull"]);
});

let reviewSnapshot;
await check("pull_request_review:submitted reads a bounded role snapshot from the disposable repo", async () => {
  reviewSnapshot = await fakeGh().readRoleSnapshot(reviewEvent(), role("reviser"), { controlSha: CONTROL, appId: APP_ID });
  assert.equal(reviewSnapshot.event.kind, "pull_request_review");
  assert.equal(reviewSnapshot.event.action, "submitted");
  assert.equal(reviewSnapshot.routing.role, "reviser");
  assert.equal(reviewSnapshot.state.headSha, HEAD, "snapshot pins the current head");
  assert.ok(reviewSnapshot.state.resources["pull:7"], "pull resource present");
  assert.ok(reviewSnapshot.state.resources["pull:7:reviews"], "reviews resource present");
  const bytes = canonicalBytes(reviewSnapshot).length;
  assert.ok(bytes <= role("reviser").snapshot.maxBytes, `snapshot ${bytes}B exceeds ${role("reviser").snapshot.maxBytes}B bound`);
});

await check("pull_request_review at a stale head is rejected before any snapshot is emitted", async () => {
  await assert.rejects(
    () => fakeGh({ pullHead: HEAD }).readRoleSnapshot(reviewEvent(STALE), role("reviser"), { controlSha: CONTROL, appId: APP_ID }),
    error => error instanceof AdwError && error.code === "forge" && error.message === "stale",
  );
});

// ---------------------------------------------------------------------------
// 2. pull_request_review_comment:created -> NO bounded role snapshot (disproof)
// ---------------------------------------------------------------------------
const ALL_ROLES = ["steerer", "triager", "planner", "surveyor", "builder", "codex-builder", "pioneer", "reviewer", "security-reviewer", "reviser", "sweeper", "adw-doctor", "docs-writer", "dependency-manager", "alert-triager"];
await check("pull_request_review_comment:created normalizes as an event", () => {
  const event = reviewCommentEvent();
  assert.equal(event.kind, "pull_request_review_comment");
  assert.equal(event.action, "created");
  assert.equal(event.entityId, "7");
});
await check("no ADW role accepts pull_request_review_comment (contradicts 'both normalize into bounded role snapshots')", () => {
  const accepting = ALL_ROLES.filter(name => {
    try { roleSnapshotPlan(name, "pull_request_review_comment"); return true; } catch { return false; }
  });
  assert.deepEqual(accepting, [], `expected no role to accept the event, got: ${accepting.join(", ")}`);
});
await check("reviser — the natural consumer — refuses to build a review-comment snapshot", async () => {
  await assert.rejects(
    () => fakeGh().readRoleSnapshot(reviewCommentEvent(), role("reviser"), { controlSha: CONTROL, appId: APP_ID }),
    error => error instanceof AdwError && error.code === "contract" && error.message === "role event is unsupported",
  );
});

// ---------------------------------------------------------------------------
// 3. Missed delivery recovered by reconciliation, without duplicate writes
// ---------------------------------------------------------------------------
await check("missed review delivery is recovered: reconciliation schedules run_review at the current head", () => {
  const intents = reconcile({ reviews: [{ prId: "7", headSha: HEAD, evidence: [], protectedInput: false }] });
  const runs = intents.filter(intent => intent.kind === "run_review");
  assert.equal(runs.length, 2, "expected correctness + security review re-runs");
  assert.deepEqual(runs.map(run => run.reviewKind).sort(), ["correctness", "security"]);
  for (const run of runs) { assert.equal(run.prId, "7"); assert.equal(run.headSha, HEAD); }
});

await check("reconciliation is idempotent: identical inputs yield an identical intent set (no duplicate writes)", () => {
  const request = { reviews: [{ prId: "7", headSha: HEAD, evidence: [], protectedInput: false }] };
  assert.deepEqual(reconcile(request), reconcile(request));
});

await check("posted review evidence suppresses re-run: reconciliation issues no duplicate review", () => {
  const comments = [evidenceMarker("correctness", HEAD), evidenceMarker("security", HEAD)];
  const intents = reconcile({ reviews: [{ prId: "7", headSha: HEAD, evidence: [], protectedInput: false }], comments });
  assert.equal(intents.filter(intent => intent.kind === "run_review").length, 0, "evidence at current head must stop re-scheduling");
});

// ---------------------------------------------------------------------------
// 4. Current-head semantics + retry: stale-head evidence does not count
// ---------------------------------------------------------------------------
await check("stale-head review evidence is ignored; reconciliation retries against the advanced head", () => {
  const comments = [evidenceMarker("correctness", STALE), evidenceMarker("security", STALE)];
  const intents = reconcile({ reviews: [{ prId: "7", headSha: HEAD, evidence: [], protectedInput: false }], comments });
  const runs = intents.filter(intent => intent.kind === "run_review");
  assert.equal(runs.length, 2, "evidence at an old head must not satisfy the current head");
  for (const run of runs) assert.equal(run.headSha, HEAD);
});

process.exitCode = failures === 0 ? 0 : 1;
if (failures === 0) console.log("\nALL PASS (i161-review-event-delivery)");
else console.log(`\n${failures} FAILED`);
