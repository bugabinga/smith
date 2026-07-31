# ADW MJS Control-Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the inert, dependency-free MJS contracts and pure policy core required by later live adapters.

**Architecture:** `core.mjs` owns pure canonicalization, validation, reduction, and state transitions; `roles.mjs` owns frozen role policy data; `main.mjs` exposes fixture-only validation/reduction commands. Static JSON Schemas constrain provider-facing records while hand-written validators enforce semantic invariants without runtime dependencies.

**Tech Stack:** Node.js ESM, Node standard library, `node:test`, JSON Schema data files.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 1: Pure Control-Plane Foundation

---

## File map

- `adw/core.mjs`: pure errors, canonical bytes/digests, contract validators, provider reduction, holds, route/review/risk/merge transitions, reconciliation intents, and structural patch metadata checks.
- `adw/roles.mjs`: frozen role registry, provider modes, timeouts, capabilities, allowed operations, fallback restrictions, and patch policy.
- `adw/main.mjs`: fixture-only `validate`, `reduce`, and `reconcile` CLI; no live process, forge, VCS, or provider access.
- `adw/schemas/*.schema.json`: transport-level JSON Schemas for snapshot, assessment, decision, and verification records.
- `adw/test/core.test.mjs`: canonicalization, contract, reduction, hold, route, review, risk, merge, reconciliation, and patch-policy tests.
- `adw/test/roles.test.mjs`: role registry consistency and policy tests.
- `adw/test/main.test.mjs`: CLI fixture tests through injected streams/files.
- `adw/test/fixtures/*.json`: minimal normalized inputs and expected intents.
- `.github/workflows/adw-selftest.yml`: include `adw/**` changes and run Node tests; legacy shell tests remain.

### Task 1: Canonical values and typed failures

**Files:**

- Create: `adw/core.mjs`
- Test: `adw/test/core.test.mjs`

- [x] **Step 1: Write failing canonicalization tests**

Add tests importing `AdwError`, `canonicalBytes`, `digestBytes`, and `digestJson`. Assert that object key order does not change bytes/digest, array order does, and unsupported values throw `AdwError` with code `contract`.

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  AdwError,
  canonicalBytes,
  digestBytes,
  digestJson,
} from "../core.mjs";

test("canonical JSON sorts object keys without sorting arrays", () => {
  assert.equal(
    canonicalBytes({ z: [2, 1], a: { y: true, x: null } }).toString(),
    '{"a":{"x":null,"y":true},"z":[2,1]}',
  );
  assert.equal(digestJson({ b: 2, a: 1 }), digestJson({ a: 1, b: 2 }));
  assert.notEqual(digestJson([1, 2]), digestJson([2, 1]));
  assert.equal(digestBytes(Buffer.from("smith")).length, 64);
});

test("canonical JSON rejects values outside the transport domain", () => {
  for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => canonicalBytes(value),
      error => error instanceof AdwError && error.code === "contract",
    );
  }
});
```

- [x] **Step 2: Run the test and verify failure**

Run: `node --test adw/test/core.test.mjs`

Expected: FAIL because `adw/core.mjs` does not exist.

- [x] **Step 3: Implement canonicalization and failures**

Implement:

```js
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
  if (Array.isArray(value)) return value.map(canonical);
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])]),
    );
  }
  throw new AdwError("contract", "value is outside the canonical JSON domain");
}

export const canonicalBytes = value => Buffer.from(JSON.stringify(canonical(value)));
export const digestBytes = bytes => createHash("sha256").update(bytes).digest("hex");
export const digestJson = value => digestBytes(canonicalBytes(value));
```

Reject sparse arrays and object properties whose value is `undefined` before recursion so JSON cannot silently erase data.

- [x] **Step 4: Run the focused test**

Run: `node --test adw/test/core.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add adw/core.mjs adw/test/core.test.mjs
git commit -S -m "Add canonical ADW transport values"
```

### Task 2: Transport contracts and schemas

**Files:**

- Modify: `adw/core.mjs`
- Create: `adw/schemas/snapshot.schema.json`
- Create: `adw/schemas/assessment.schema.json`
- Create: `adw/schemas/decision.schema.json`
- Create: `adw/schemas/verification.schema.json`
- Modify: `adw/test/core.test.mjs`

- [x] **Step 1: Write failing contract tests**

Add table tests for `validateSnapshot`, `validateAssessment`, `validateAssessmentArtifact`, `validateDecision`, and `validateVerification`. Use these valid shapes and then delete each required field to prove fail-closed behavior:

```js
const snapshot = {
  schemaVersion: 1,
  controlSha: "a".repeat(40),
  event: { kind: "pull_request", action: "synchronize", entityId: "42" },
  repository: { id: "R_1", owner: "bugabinga", name: "smith", defaultBranch: "main" },
  revisions: [{ resource: "pull:42", kind: "pull", token: "b".repeat(40) }],
  routing: { role: "reviewer", mode: "quorum", primary: null },
  state: {},
};
const assessment = {
  schemaVersion: 1,
  controlSha: snapshot.controlSha,
  role: "reviewer",
  provider: "claude",
  model: "claude-opus-4-1",
  idempotencyKey: "pr:42:head:review",
  snapshotDigest: digestJson(snapshot),
  cliVersion: "1.0.0",
  run: { id: "run", job: "claude", attempt: 1 },
  outcome: "positive",
  payload: { verdict: "approve", findings: [] },
  payloadDigest: digestJson({ verdict: "approve", findings: [] }),
  patch: null,
  startedAt: "2026-07-28T10:00:00.000Z",
  completedAt: "2026-07-28T10:00:01.000Z",
};
const decision = {
  schemaVersion: 1,
  controlSha: snapshot.controlSha,
  snapshotDigest: assessment.snapshotDigest,
  assessmentDigests: [digestJson(assessment)],
  kind: "state",
  operations: [{ type: "publish_check", headSha: snapshot.revisions[0].token, conclusion: "success" }],
};
const verification = {
  schemaVersion: 1,
  controlSha: snapshot.controlSha,
  decisionDigest: digestJson(decision),
  kind: "state",
  preconditionDigest: digestJson(snapshot.revisions),
};
```

Assert unknown top-level keys, wrong schema versions, non-hex SHAs/digests, duplicate assessment digests, unknown outcomes, and patch verification without `patchDigest`/`resultTree` fail with code `contract`.

- [x] **Step 2: Run the test and verify failure**

Run: `node --test adw/test/core.test.mjs`

Expected: FAIL because validators are not exported.

- [x] **Step 3: Add exact object validators**

Implement small helpers `expectObject`, `expectExactKeys`, `expectString`, `expectEnum`, `expectArray`, `expectSha`, and `expectDigest`. Export the five validators. Each returns a deeply frozen copy and never mutates input. `validateAssessmentArtifact({ assessment, patchBytes })` requires no bytes when `patch` is null and otherwise checks exact byte length and SHA-256 before returning the validated envelope. Permit only:

- snapshot event kinds `issue`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check`, `workflow`, `push`, `schedule`, `alert`, `dispatch`;
- outcomes `positive`, `negative`, `noop`, `unable`;
- decision kinds `state`, `patch`, `terminal`;
- verification kinds `state`, `patch`.

Assessment `patch` is either `null` or `{ baseSha, digest, size, files }` and binds the optional `change.patch` sidecar before reduction. Require patch decisions to copy that metadata byte-for-byte; exact bytes travel only as the artifact sidecar. Require patch verification to carry the same digest plus `resultTree`; forbid patch fields on state records. Tests digest actual patch bytes and reject missing, substituted, oversized, or mismatched sidecars before verification.

- [x] **Step 4: Add matching static schemas**

Write draft-2020-12 schemas with `additionalProperties: false` at every control-plane object level, the exact required keys above, `schemaVersion: { "const": 1 }`, 40-hex SHA and 64-hex digest patterns, nonempty strings capped at 4 KiB, arrays capped at 100 entries, patch size capped at 1,048,576, patch files capped at 100 unique relative paths, and `if/then` branches for state versus patch. `snapshot.state` and `assessment.payload` are the two explicit opaque boundaries: they accept canonical JSON objects with role-specific keys and remain bounded by the 256 KiB whole-document check until Phase 3 supplies role schemas. Event, repository, revision, routing, run, patch, operation, and precondition records each receive `$defs`. Schemas constrain transport; semantic validators and canonical byte limits remain authoritative.

- [x] **Step 5: Run focused tests**

Run: `node --test adw/test/core.test.mjs`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add adw/core.mjs adw/schemas adw/test/core.test.mjs
git commit -S -m "Define fail-closed ADW transport contracts"
```

### Task 3: Role-policy contract

**Files:**

- Create: `adw/roles.mjs`
- Test: `adw/test/roles.test.mjs`

- [x] **Step 1: Write failing policy-contract tests**

Test `defineRole` with three local fixtures: Claude-primary single, Codex-primary single, and quorum. Exact input shape:

```js
const policy = {
  name: "fixture-reviewer",
  charter: ".claude/agents/reviewer.md",
  mode: "quorum",
  primary: null,
  fallback: null,
  providers: ["claude", "codex"],
  providerConfig: {
    claude: { model: "fixture-claude", effort: "high", timeoutSeconds: 300 },
    codex: { model: "fixture-codex", effort: "high", timeoutSeconds: 300 },
  },
  capabilities: ["pulls:read", "checks:write"],
  snapshot: { fields: ["pull", "diff", "reviews"], maxBytes: 262144 },
  payload: { outcomes: ["positive", "negative", "noop", "unable"], requiredKeys: ["verdict"] },
  operations: ["publish_check", "add_label", "remove_label", "terminal"],
  fallbackAuthority: { protected: false, incomplete: false, fork: false, binary: false, oversized: false },
  patch: null,
};
const patchPolicy = {
  maxBytes: 1048576,
  maxFiles: 100,
  allowedPrefixes: ["docs/", "smith-core/"],
  deniedPaths: ["adw/**", "docs/SPEC.md"],
};
```

`patch` is either `null` or the exact `patchPolicy` shape; prefixes/paths are sorted unique nonempty strings, and global core denials cannot be removed by this list. Assert deep freezing; exact keys; provider/mode consistency; 1–300 second timeouts; unique/sorted capabilities, fields, operations, outcomes, and required keys; operation allowlist; snapshot ≤256 KiB; patch ≤1 MiB/100 files; and rejection of unknown providers/operations. Do not define production role values in Phase 1: Phase 3 derives all canonical role records from current charters and parity fixtures rather than inventing policy here.

- [x] **Step 2: Run the test and verify failure**

Run: `node --test adw/test/roles.test.mjs`

Expected: FAIL because `adw/roles.mjs` does not exist.

- [x] **Step 3: Implement the role-policy boundary**

Export frozen `PROVIDERS`, `OPERATIONS`, and `defineRole(input)`. `defineRole` validates the exact fixture shape above with `AdwError("role", message)`, returns a deep-frozen copy, and rejects production registry lookup because the registry is Phase 3 scope. No classes, registration API, default model, or implicit capability exists.

- [x] **Step 4: Run role tests**

Run: `node --test adw/test/roles.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add adw/roles.mjs adw/test/roles.test.mjs
git commit -S -m "Define the ADW role-policy boundary"
```

### Task 4: Provider qualification and reduction

**Files:**

- Modify: `adw/core.mjs`
- Modify: `adw/test/core.test.mjs`

- [x] **Step 1: Write failing reduction tests**

Add `qualifyAssessment` and `reduceAssessments` tests for:

- valid positive, negative, and no-op artifacts ending a single route;
- unable, malformed, wrong-role, wrong-control-SHA, wrong-snapshot, wrong-provider, and missing required payload requesting fallback;
- protected/incomplete/fork/binary/oversized input refusing fallback authority;
- Claude-primary and Codex-primary symmetry;
- quorum with two valid artifacts, either ordering, one missing/unavailable provider, and both unavailable;
- advisory output marked non-authoritative.

Reduction is an intermediate, not a forge decision: `{ status: "artifact", authoritative, selected: [assessmentDigest], patch }`, `{ status: "fallback", provider, reason }`, or `{ status: "terminal", reason }`. Single selects exactly one valid primary/fallback digest. Quorum requires one valid artifact from each configured provider and selects both digests sorted by provider; it preserves outcomes/payloads for Phase 3 and does not pretend unlike reviewer payloads should hash equally. Advisory selects any one valid artifact with `authoritative: false`, otherwise returns terminal `advisory_unavailable`. `patch` is `null` or exact metadata copied from selected envelopes; zero/one distinct patch digest is accepted and two distinct patch digests are terminal `patch_conflict`. Phase 3 maps role payloads to decisions. Terminal reasons are sanitized enums and never copy provider stderr/auth text.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test --test-name-pattern='assessment|reduce' adw/test/core.test.mjs`

Expected: FAIL because reduction exports are missing.

- [x] **Step 3: Implement qualification and reduction**

Export `qualifyAssessment({ snapshot, rolePolicy, provider, assessment })` returning one of:

```js
{ status: "artifact", assessment }
{ status: "fallback", reason: "unavailable" | "malformed" | "missing_artifact" }
{ status: "terminal", reason: "fallback_forbidden" | "contract" }
```

Export `reduceAssessments({ snapshot, rolePolicy, assessments })`. Enforce exact provider membership and one envelope per provider, then apply the single/quorum/advisory selection rules from Step 1. No outcome conflict or operation is synthesized in Phase 1. Carry selected assessment digests and exact patch metadata into the intermediate reduction.

- [x] **Step 4: Run focused and full core tests**

Run: `node --test adw/test/core.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add adw/core.mjs adw/test/core.test.mjs
git commit -S -m "Reduce provider artifacts without widening trust"
```

### Task 5: Holds, routes, reviews, risk, and merge eligibility

**Files:**

- Modify: `adw/core.mjs`
- Modify: `adw/test/core.test.mjs`

- [x] **Step 1: Write failing transition-table tests**

Test pure exports with table-driven inputs:

- `holdReasons(labels)` recognizes `hold`, `needs:owner`, `needs:spec`, `needs:security`, and `risk:high`;
- `nextBuilderRoute(state)` transitions unarmed → primary, provider failure → fallback, valid artifact → complete, both failure → blocked, and stale head → reset;
- `reduceReviews(reviews)` requires current-head correctness and security evidence, rejection wins, stale evidence is ignored, and protected fallback evidence cannot approve;
- `reduceRisk(marker, timeline, headSha)` accepts only a later owner label-removal event on the same head and reopens on head change;
- `mergeEligibility(state)` requires no holds, current-head `check`, current-head App correctness/security verdicts, no review conflict, and permitted squash auto-merge.

Use exact normalized trust/evidence records:

```js
const trust = { ownerIds: ["U_owner"], appId: "A_smith" };
const timelineEvent = {
  id: "TE_1", kind: "label_removed", actorId: "U_owner",
  createdAt: "2026-07-28T10:01:00.000Z", label: "risk:high", headSha,
};
const reviewEvidence = {
  kind: "correctness", headSha, conclusion: "approve", actorId: "A_smith",
  provider: "claude", authoritative: true, artifactDigest: "c".repeat(64),
};
```

Pass `trust` explicitly to `reduceRisk`, `reduceReviews`, and `mergeEligibility`. Owner means actor ID membership in `ownerIds`; App evidence means exact `appId`. No login strings or forge associations are trusted in core.

Transition inputs are exact records: builder route `{ sourceRevision, headSha, status: "unarmed"|"primary"|"fallback"|"complete"|"blocked", primaryOutcome, fallbackOutcome }`; risk marker `{ headSha, findingDigest, status: "open"|"cleared", createdAt, clearedAt }`; merge state `{ headSha, labels, checks: [{ name, headSha, conclusion }], reviews: [reviewEvidence], riskMarker, timeline, trust, autoMergeAllowed }`. `nextBuilderRoute` returns the same route shape with one transition; `reduceReviews` returns `{ correctness, security, conflict, reasons }`; `mergeEligibility` returns `{ eligible, reasons }`. Every record rejects unknown keys.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test --test-name-pattern='hold|route|review|risk|merge' adw/test/core.test.mjs`

Expected: FAIL because transition exports are missing.

- [x] **Step 3: Implement minimal pure transition functions**

Use the exact trust/evidence records above, closed enum strings, and frozen outputs. `mergeEligibility` returns `{ eligible, reasons }` with sorted unique reason codes, never a bare boolean. `reduceRisk({ marker, timeline, headSha, trust })` returns `{ status: "open" | "cleared", marker }` and never treats label absence alone as owner clearance. `reduceReviews({ evidence, headSha, trust, protectedInput })` rejects stale/non-App/non-authoritative evidence before conflict reduction.

- [x] **Step 4: Run core tests**

Run: `node --test adw/test/core.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add adw/core.mjs adw/test/core.test.mjs
git commit -S -m "Make ADW gate transitions executable"
```

### Task 6: Operations, reconciliation, and patch policy

**Files:**

- Modify: `adw/core.mjs`
- Modify: `adw/test/core.test.mjs`
- Create: `adw/test/fixtures/reconcile.json`

- [x] **Step 1: Write failing operation/reconciliation tests**

Test `validateOperation`, `idempotencyKey`, `planReconciliation`, and `validatePatchManifest` against this exact field table (all records also require `type`):

```text
comment(entityId,body,marker)                    add_label/remove_label(entityId,label)
create_issue(title,body,labels,marker)           update_issue(issueId,title?,body?)
close_issue(issueId,reason)                      create_milestone(title,description,dueOn?,marker)
update_milestone(milestoneId,title?,description?,dueOn?)
close_milestone(milestoneId)                     assign_milestone(issueId,milestoneId)
link_sub_issue(parentId,childId)                 create_branch(name,baseSha,treeSha)
create_pr(head,base,title,body,marker)            update_pr(prId,title?,body?,headSha?)
publish_check(headSha,name,conclusion,summary,externalId)
rerun_check(runId)                               dispatch_workflow(workflow,ref,inputs)
arm_auto_merge(prId,headSha,method)              sync_labels(definitionsDigest)
report_drift(title,body,marker)                  noop(reason)
terminal(reason)
```

Question-mark fields may be omitted; all others are required. Every object rejects unlisted keys. `method` is exactly `squash`; check conclusions are `success|failure|neutral`; close reasons are `completed|not_planned`; terminal/no-op reasons are closed enums defined beside the validator.

- exact operation fields and unknown-operation rejection;
- stable semantic keys for issue route, PR review, milestone/spec digest, and alert state;
- stale armed route, merged PR missing docs/finalization obligation, dropped label sync, and already-complete no-op;
- patch manifest `{ baseSha, digest, size, files: [{ path, kind, oldMode, newMode }] }`, where accepted files require `kind: "regular"` and modes `absent|100644|100755`; `size` is exact sidecar byte length, not a sum of resulting files;
- patch file count/bytes, duplicate paths, absolute/parent paths, `.git`, `.gitmodules`, symlink/submodule/device/binary/mode rejection;
- global denial of `docs/SPEC.md`, `docs/PROJECT-INVARIANTS.md`, `.github/CODEOWNERS`, `.github/rulesets/**`, `.claude/settings.json`, `adw/**`, and the three wrapper files.

The reconciliation request is exactly `{ snapshot, routes, pulls, labelSync }`. Routes contain `{ issueId, sourceRevision, status, primary, fallback, artifactDigest }`. Pulls contain `{ prId, headSha, merged, mergeSha, obligations: [{ role, status, artifactDigest }] }`. `labelSync` is `{ wantedDigest, liveDigest }`. Output intents are exactly `{ kind: "retry_route", issueId, sourceRevision }`, `{ kind: "run_obligation", prId, mergeSha, role }`, or `{ kind: "sync_labels", definitionsDigest }`, sorted by canonical bytes and deduplicated. The fixture contains one stale route, one merged PR with one missing normalized obligation, and one complete PR; expected intents include only the first two plus label sync only when the two digests differ. Phase 3 derives obligations from changed paths; Phase 1 only plans already-normalized obligations.

- [x] **Step 2: Run the focused test and verify failure**

Run: `node --test --test-name-pattern='operation|idempotency|reconcile|patch' adw/test/core.test.mjs`

Expected: FAIL because exports are missing.

- [x] **Step 3: Implement the closed operation validators and planners**

`validateOperation(operation, rolePolicy)` checks exact fields and role allowlist. `idempotencyKey(kind, fields)` canonicalizes only the semantic fields named in the design. `planReconciliation(state)` is bounded by already-normalized input and emits sorted operation intents without I/O. `validatePatchManifest(manifest, rolePolicy)` validates metadata only; actual unified-diff apply belongs to Phase 2 `vcs.mjs`.

- [x] **Step 4: Run core tests**

Run: `node --test adw/test/core.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add adw/core.mjs adw/test/core.test.mjs adw/test/fixtures/reconcile.json
git commit -S -m "Plan retry-safe ADW reconciliation"
```

### Task 7: Fixture-only CLI

**Files:**

- Create: `adw/main.mjs`
- Test: `adw/test/main.test.mjs`
- Create: `adw/test/fixtures/reviewer-snapshot.json`
- Create: `adw/test/fixtures/reviewer-assessments.json`
- Create: `adw/test/fixtures/reviewer-policy.json`

- [x] **Step 1: Write failing CLI tests**

Import `run` and inject `{ argv, stdin, stdout, stderr, readFixture }`. Test:

```js
await run({ argv: ["validate", "snapshot"], stdin: snapshotJson, stdout, stderr, readFixture });
await run({ argv: ["reduce"], stdin: JSON.stringify({ snapshot, rolePolicy, assessments }), stdout, stderr, readFixture });
await run({ argv: ["reconcile"], stdin: JSON.stringify({ snapshot, routes, pulls, labelSync }), stdout, stderr, readFixture });
```

`run` returns the numeric exit code instead of assigning `process.exitCode`; the executable shim assigns it. Successful stdout is canonical JSON plus newline and stderr is empty. Error mapping is exact: unsupported command/record or invalid snapshot input → `2`; stale → `3`; provider unavailable → `4`; forge → `5`; invalid assessment/decision/verification/reduction artifact → `6`; verification → `7`. Emit `{ "error": code, "message": sanitizedMessage }` on stderr. No environment, network, subprocess, forge, or filesystem access exists except injected `readFixture(name)`, which accepts only a basename present under `adw/test/fixtures/`.

- [x] **Step 2: Run the CLI test and verify failure**

Run: `node --test adw/test/main.test.mjs`

Expected: FAIL because `adw/main.mjs` does not exist.

- [x] **Step 3: Implement the minimal CLI**

Export `run(io)` and execute it only when `process.argv[1]` exists and `import.meta.url === pathToFileURL(process.argv[1]).href`. Parse exactly `validate <snapshot|assessment|decision|verification>`, `reduce`, and `reconcile`; optional `--fixture <basename>` replaces stdin through injected/local fixture reading. Read at most 256 KiB, validate the exact request shapes above, map errors exactly as Step 1 defines, and emit one canonical sanitized error line.

- [x] **Step 4: Run CLI and all Node tests**

Run: `node --test adw/test/*.test.mjs`

Expected: PASS with no skipped tests.

- [x] **Step 5: Commit**

```bash
git add adw/main.mjs adw/test/main.test.mjs adw/test/fixtures
git commit -S -m "Expose offline ADW contract commands"
```

### Task 8: CI self-test integration and phase verification

**Files:**

- Modify: `.github/workflows/adw-selftest.yml`
- Modify: `docs/super/plans/2026-07-28-adw-mjs-control-plane-phase-1-foundation.md`

- [x] **Step 1: Extend self-test triggers and job**

Add `adw/**` to pull-request/push paths and add this step after checkout:

```yaml
      - name: MJS control-plane contracts
        run: node --test adw/test/*.test.mjs
```

Keep all three legacy shell tests unchanged because legacy remains authoritative.

- [x] **Step 2: Run phase checks**

Run:

```bash
node --test adw/test/*.test.mjs
bash .github/adw/gate-labels.test.sh
bash .github/adw/reconcile-builder-routes.test.sh
bash .github/adw/workflow-contract.test.sh
git diff --check
```

Expected: every test exits `0`; Node reports no skipped/cancelled/todo tests; `git diff --check` prints nothing.

- [x] **Step 3: Inspect phase boundary**

Run: `git grep -nE '(^|[^[:alnum:]_])(gh|git|claude|codex)( |$)' -- adw ':!adw/test'`

Expected: no output. Confirm no package manifest/lockfile exists under `adw/`, no workflow except self-test references `adw/main.mjs`, and `git status --short` lists only planned Phase 1 files.

- [x] **Step 4: Record execution evidence**

Mark completed checkboxes and append a short `## Result` section containing the exact test counts and commit range. Do not change roadmap scope or claim live-adapter parity.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/adw-selftest.yml docs/super/plans/2026-07-28-adw-mjs-control-plane-phase-1-foundation.md
git commit -S -m "Gate the inert MJS control-plane foundation"
```

## Result

Implemented in `01a27d3..13a3934` plus the post-review hardening commit. Offline MJS coverage: 46 tests, 46 passed, 0 failed/skipped/cancelled/todo. All three legacy ADW shell suites and `git diff --check` passed; live adapters and production authority remain deferred to Phase 2+.
