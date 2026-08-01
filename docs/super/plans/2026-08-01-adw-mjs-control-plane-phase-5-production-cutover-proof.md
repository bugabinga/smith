# ADW MJS Production Cutover and Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically make the three MJS wrappers the sole production ADW writers and prove their positive behavior on production without destructive failure injection.

**Architecture:** The final protected PR carries the already-completed Phase 4 control plane, production-adapted byte-identical wrappers, assessment-only charters, and removal of every legacy writer. Before the squash merge, the owner seeds the existing App identity, disables and drains legacy workflows, and rehearses a signed rollback; after merge, all writes pass through operation-scoped App tokens and one `adw-write` concurrency group while production evidence is captured from positive runs only.

**Tech Stack:** Node.js ESM/`node:test`, GitHub Actions, pinned Actions, `gh`, `git`, `jq`, `yq`, exact-pinned Claude/Codex CLIs.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 5: Atomic Production Cutover

---

## Owner decision and supersession

The owner explicitly approved this production path on 2026-08-01 and authorized a quiet-window cutover. Phase 4 Tasks 1–6 remain completed prerequisite work. Phase 4 Tasks 7–8 remain unchecked and are **superseded**, not completed: no disposable repository will be created, no production secret will be rotated, and no live failure will be manufactured. Their failure/retry claims remain supported by the offline `node:test` evidence from Tasks 1–6; the positive write path is proved on production in this phase.

The owner also approved App-authenticated `repository_dispatch` for the five internal reconciliation intents. Those intents use a closed event-type/payload contract and the fixed repository-dispatch writer; `workflow_dispatch` is reserved exclusively for owner-invoked maintenance `audit` and `reconcile` lane choices. Internal authority is never represented as manual workflow inputs.

This is exactly one Phase 5. It ends only after the atomic cutover, positive production proof, and two consecutive scheduled reconciliation cycles. Phase 6 compatibility removal, operational-document cleanup, and unrelated backlog work remain out of scope.

On 2026-08-01, the owner approved the first offered authorization route: current `bugabinga` authentication may author the cutover PR. GitHub prohibits author self-approval, so an immutable exact-head owner approval comment bound by REST to numeric owner ID `876467` and login `bugabinga`, together with confirmed ruleset bypass, replaces the impossible review object. Administrative squash remains gated by the unchanged head, required checks, final legacy drain, and quiet-window controls.

## Locked safety boundaries

- Production repository is exactly `bugabinga/smith`; default branch is exactly `main`.
- Existing secret `APP_ID` is the App ID used by `actions/create-github-app-token`. `APP_CLIENT_ID` is absent and the private App client ID is unavailable; no task may add, infer, request, or substitute `APP_CLIENT_ID`.
- Existing secrets `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `CODEX_AUTH_JSON` are presence-checked only. Their values are never read, printed, copied, replaced, or rotated.
- Ephemeral non-secret variable `ADW_CUTOVER_HOLD=true` suppresses every operational MJS job from immediately before merge until the parent-correct signed rollback exists; it is then deleted before positive proof.
- Seed exact non-secret variables `APP_BOT_USER_ID=306488075` and `APP_BOT_LOGIN=agent-smith-bugabinga-adc[bot]` before cutover.
- Internal App intents use only `repository_dispatch` event types `retry_route`, `fallback_route`, `retry_pioneer`, `run_review`, and `run_obligation`; manual `workflow_dispatch` exposes only owner choices `audit` and `reconcile`.
- Production proof is positive-only. Never inject malformed artifacts, stale revisions, cancelled jobs, partial writes, invalid credentials, changed permissions, malformed events, provider outages, ruleset damage, or secret rotation.
- Existing organic `BLOCKED`/`BEHIND` state on PRs #150, #163, #165, and #166 is observed, never created or worsened for this proof.
- Settings/rulesets remain read-only. Audit may report their existing drift but may not mutate it. Label sync may repair only checked-in label definitions through the closed `sync_labels` operation.
- `pull_request_review_comment` and `check_run`/`check_suite` remain reconcile-only. Their proof runs contain no provider assessment artifact and no provider job execution.
- No legacy and MJS operational writer may be enabled simultaneously. `adw-selftest` is non-writing and remains enabled. `adw-release` is disabled and receives no replacement because release automation remains deferred.
- The owner keeps main otherwise quiet from the final head check until both scheduled cycles finish. Any unrelated main movement invalidates current-head evidence and pauses proof.
- Every branch commit is signed when the executor can sign. The protected PR still lands as one GitHub-verified squash commit, satisfying `docs/PROJECT-INVARIANTS.md` §7.

## Production baseline to revalidate, not manufacture

The 2026-08-01 planning snapshot is:

- `origin/main`: `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c`.
- Candidate tip after Phase 4 Task 6: `e29f484b475f353e1db897c74660fb5316f120a3`.
- Secrets present: `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`.
- Repository variables absent; therefore both exact App bot variables must be seeded.
- App bot identity already observed on forge records: numeric user ID `306488075`, login `agent-smith-bugabinga-adc[bot]`.
- Main ruleset ID `19155559`; squash-only and signed commits are active; required checks are `check` and `merge-gate`.
- Live ruleset has organic drift from `.github/rulesets/main.json`: live strict required checks are `true` and include `do_not_enforce_on_create:true`, while checked-in policy says strict `false` and omits that field.
- Live label `urgent` has organic color drift (`ededed` live versus `e03131` checked in).
- PR #150 head `146c5467cd6b87d1ae3ef10f116b075f5910a94e` is `BLOCKED`.
- PR #163 head `1b1891ee0000c817891fdcc963d778c030e5a74d` is `BEHIND`.
- PR #165 head `adf17c538ff655d8fb065a848bdc1f499622d482` is `BEHIND`.
- PR #166 head `9b3e822ef7eef3563fa22b57daa6ced68520f676` is `BEHIND`.
- All four PRs have current-head legacy App review evidence and are open; their pre-existing auto-merge state must not be interpreted as permission to merge while blocked/behind.

At execution, re-read every value. A changed SHA or merge state is not a reason to inject state. If one of the four PRs is no longer organically blocked/behind, stop that assertion and ask the owner for another naturally blocked/behind PR; do not make one.

## File map

### Control-plane production readiness

- `adw/core.mjs`: make every reconciliation dispatch carry enough canonical role/provider/entity authority for the target wrapper.
- `adw/github.mjs`: normalize owner `workflow_dispatch` controls and App-authenticated `repository_dispatch` intents into bounded issue/pull/control events; provide only the fixed repository-dispatch writer and reject spoofed or incomplete dispatches.
- `adw/roles.mjs`: permit owner-authenticated manual `dispatch` for the reconciler while preserving provider-free control authority.
- `adw/test/core.test.mjs`: dispatch intent authority and exact repository-dispatch payload tests.
- `adw/test/github.test.mjs`: owner/App dispatch authentication, entity/head binding, and stale rejection tests.
- `adw/test/scenarios.test.mjs`: full reconciliation-dispatch-to-role scenarios.
- `adw/test/wrappers.test.mjs`: production App input, event gating, dispatch grammar, exact promotion, sole-writer inventory, self-test, and charter boundaries.

### Wrappers and self-test

- `prototypes/p38-adw-disposable/wrappers/adw-issues.yml`: canonical issue/reusable/internal-dispatch wrapper; use `app-id`, gate label/comment events, and consume only the three closed issue `repository_dispatch` payloads.
- `prototypes/p38-adw-disposable/wrappers/adw-pulls.yml`: canonical pull/reconcile wrapper; provider-route only intended events and consume only App `run_review` repository dispatches.
- `prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml`: canonical maintenance wrapper; expose owner-only manual audit/reconcile choices, consume only App `run_obligation` repository dispatches, and snapshot alerts only from the existing `57 2 * * *` schedule; GitHub Actions has no alert webhook trigger here.
- `.github/workflows/adw-issues.yml`: byte-identical promoted issue wrapper.
- `.github/workflows/adw-pulls.yml`: byte-identical promoted pull wrapper.
- `.github/workflows/adw-maintenance.yml`: byte-identical promoted maintenance wrapper.
- `.github/workflows/adw-selftest.yml`: retained non-writer; pinned checkout and MJS tests only.

### Assessment-only charters

- `.claude/agents/adw-doctor.md`
- `.claude/agents/builder.md`
- `.claude/agents/dependency-manager.md`
- `.claude/agents/docs-writer.md`
- `.claude/agents/planner.md`
- `.claude/agents/reviewer.md`
- `.claude/agents/security-reviewer.md`
- `.claude/agents/steerer.md`
- `.claude/agents/surveyor.md`
- `.claude/agents/sweeper.md`
- `.claude/agents/triager.md`
- `.claude/skills/pioneer/SKILL.md`

`.claude/agents/release-manager.md` remains present but unused and unchanged; no role registry or wrapper may route to it.

### Superseded legacy files deleted in the atomic PR

- `.github/workflows/adw-alerts.yml`
- `.github/workflows/adw-automerge.yml`
- `.github/workflows/adw-build.yml`
- `.github/workflows/adw-codex-build.yml`
- `.github/workflows/adw-codex-review.yml`
- `.github/workflows/adw-comment.yml`
- `.github/workflows/adw-deps.yml`
- `.github/workflows/adw-docs.yml`
- `.github/workflows/adw-doctor.yml`
- `.github/workflows/adw-gate.yml`
- `.github/workflows/adw-intake.yml`
- `.github/workflows/adw-jam-detector.yml`
- `.github/workflows/adw-labels.yml`
- `.github/workflows/adw-pioneer.yml`
- `.github/workflows/adw-plan.yml`
- `.github/workflows/adw-release.yml`
- `.github/workflows/adw-review.yml`
- `.github/workflows/adw-revise.yml`
- `.github/workflows/adw-settings-audit.yml`
- `.github/workflows/adw-survey.yml`
- `.github/workflows/adw-sweep.yml`
- `.github/adw/gate-labels.sh`
- `.github/adw/gate-labels.test.sh`
- `.github/adw/reconcile-builder-routes.sh`
- `.github/adw/reconcile-builder-routes.test.sh`
- `.github/adw/workflow-contract.test.sh`

### Planning records

- `docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md`: mark only Tasks 7–8 owner-superseded; do not check them.
- `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`: record the owner-approved production-proof substitution and Phase 5 two-cycle gate.
- `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`: this executable plan; production evidence is posted to the cutover PR because evidence is known only after the atomic merge.

## Evidence artifact contract

Every accepted production run records its run ID and URL, event, head SHA, attempt, conclusion, job list, artifact IDs/names, and downloaded sidecar verification. Expected artifact sets are:

- Provider lane: `adw-source`, `adw-snapshot`, exactly one successful primary `adw-assessment-{claude|codex}`, `adw-decision`, `adw-verification`, `adw-apply-result-1`.
- Provider-free audit/reconcile lane: `adw-source`, `adw-snapshot`, `adw-decision`, `adw-verification`, `adw-apply-result-1`; no `adw-assessment-*`.
- Evidence job must succeed by downloading the same `adw-apply-result-1`.
- Every JSON/patch sidecar digest must match exact bytes.
- Every `result.json` must have `schemaVersion:1`, `status:"complete"`, `failure:null`, all operations `status:"complete"`, and only complete receipts.
- `snapshot.json.controlSha`, `decision.json.controlSha`, `verification.json.controlSha`, and `result.json.controlSha` must equal the run's trusted control SHA.
- Decision/snapshot/verification/result digest links must match the corresponding canonical artifact bytes, as additionally enforced by the runtime and offline tests.

Define this exact positive-run capture function once in the owner shell. Call it with a forge-derived run ID, lane (`provider-free`, `provider-claude`, or `provider-codex`), and trusted control SHA:

```bash
capture_run() (
  set -euo pipefail
  local run_id=$1 lane=$2 control_sha=$3 repo=bugabinga/smith
  [[ $run_id =~ ^[1-9][0-9]*$ ]]
  [[ $control_sha =~ ^[0-9a-f]{40}$ ]]
  local root="$HOME/adw-phase5-evidence/$run_id"
  rm -rf "$root"
  mkdir -p "$root/download"
  gh run view "$run_id" --repo "$repo" \
    --json databaseId,url,event,headSha,headBranch,attempt,status,conclusion,jobs \
    > "$root/run.json"
  gh api --paginate "repos/$repo/actions/runs/$run_id/artifacts?per_page=100" \
    --jq '.artifacts[] | {id,name,size_in_bytes,expired,archive_download_url}' \
    > "$root/artifacts.jsonl"
  test -s "$root/artifacts.jsonl"
  gh run download "$run_id" --repo "$repo" --dir "$root/download"

  local expected
  case "$lane" in
    provider-free) expected='adw-apply-result-1,adw-decision,adw-snapshot,adw-source,adw-verification' ;;
    provider-claude) expected='adw-apply-result-1,adw-assessment-claude,adw-decision,adw-snapshot,adw-source,adw-verification' ;;
    provider-codex) expected='adw-apply-result-1,adw-assessment-codex,adw-decision,adw-snapshot,adw-source,adw-verification' ;;
    *) return 2 ;;
  esac
  local actual
  actual=$(jq -sr 'map(.name) | sort | join(",")' "$root/artifacts.jsonl")
  test "$actual" = "$expected"
  test "$(find "$root/download" -type f -name '*.sha256' | wc -l)" -ge 5
  find "$root/download" -type f -name '*.sha256' -print0 |
  while IFS= read -r -d '' sidecar; do
    payload=${sidecar%.sha256}
    test -f "$payload"
    expected_digest=$(tr -d '\r\n' < "$sidecar")
    [[ $expected_digest =~ ^[0-9a-f]{64}$ ]]
    actual_digest=$(sha256sum "$payload" | cut -d' ' -f1)
    test "$actual_digest" = "$expected_digest"
  done

  local source="$root/download/adw-source/manifest.sha256"
  local snapshot="$root/download/adw-snapshot/snapshot.sha256"
  local decision="$root/download/adw-decision/decision.sha256"
  local verification="$root/download/adw-verification/verification.sha256"
  local receipt="$root/download/adw-apply-result-1/result.json"
  for file in "$source" "$snapshot" "$decision" "$verification" "$receipt"; do test -f "$file"; done
  local source_digest snapshot_digest decision_digest verification_digest
  source_digest=$(tr -d '\r\n' < "$source")
  snapshot_digest=$(tr -d '\r\n' < "$snapshot")
  decision_digest=$(tr -d '\r\n' < "$decision")
  verification_digest=$(tr -d '\r\n' < "$verification")
  jq -e --arg control "$control_sha" '.controlSha == $control' \
    "$root/download/adw-snapshot/snapshot.json" >/dev/null
  jq -e --arg control "$control_sha" --arg snapshot "$snapshot_digest" \
    '.controlSha == $control and .snapshotDigest == $snapshot' \
    "$root/download/adw-decision/decision.json" >/dev/null
  jq -e --arg control "$control_sha" --arg decision "$decision_digest" \
    '.controlSha == $control and .decisionDigest == $decision' \
    "$root/download/adw-verification/verification.json" >/dev/null
  jq -e --arg control "$control_sha" --arg source "$source_digest" \
    --arg snapshot "$snapshot_digest" --arg decision "$decision_digest" \
    --arg verification "$verification_digest" '
      .schemaVersion == 1 and .controlSha == $control and
      .sourceDigest == $source and .snapshotDigest == $snapshot and
      .decisionDigest == $decision and .verificationDigest == $verification and
      .status == "complete" and .failure == null and
      (.operations | length >= 1) and
      ([.operations[].status] | all(. == "complete")) and
      ([.operations[].receipts[]?.status] | all(. == "complete"))
    ' "$receipt" >/dev/null
  jq -e --argjson id "$run_id" --arg head "$control_sha" '
    .databaseId == $id and .headSha == $head and .attempt == 1 and
    .status == "completed" and .conclusion == "success" and
    ([.jobs[] | select((.name | test("(^| / )evidence$")) and .conclusion == "success")] | length == 1)
  ' "$root/run.json" >/dev/null
)
```

Expected: any API, download, sidecar, exact-set, receipt, binding, attempt, head, or evidence-job failure exits nonzero; zero files cannot pass vacuously.

### Task 1: Record the owner-approved Phase 4 supersession

**Files:**

- Modify: `docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md`
- Modify: `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

- [x] **Step 1: Add the exact Phase 4 supersession note without changing checkboxes**

Insert before Phase 4's external proof gate:

```markdown
> **Owner-approved supersession (2026-08-01):** Tasks 7–8 are superseded by the positive production proof in `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`. They remain unchecked and must not be reported complete. Tasks 1–6 retain the offline malformed/stale/partial/fallback evidence; the owner replaced disposable-repository proof with production testing and authorized a quiet-window cutover. Production execution must not rotate secrets or inject malformed artifacts, stale writes, cancellation, provider failure, or partial writes.
```

Expected: Task 7 and Task 8 checkboxes remain `[ ]`; Tasks 1–6 remain `[x]`.

- [x] **Step 2: Amend only the affected roadmap boundaries**

Add the same dated decision to Phase 4, change Phase 4 verification to offline wrapper/failure evidence plus Phase 5 production proof, and make Phase 5 require two consecutive scheduled reconciliation cycles. Preserve Phase 6 as later compatibility/documentation cleanup.

Expected: roadmap never claims the disposable matrix ran; Phase 5 remains one atomic phase.

- [x] **Step 3: Verify honest history wording**

Run:

```bash
rg -n 'Owner-approved supersession|Tasks 7–8|disposable|production proof|two consecutive' \
  docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md \
  docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md
```

Expected: one dated supersession in each file; no sentence says Phase 4 Tasks 7–8 completed.

- [x] **Step 4: Commit the planning decision**

```bash
git add \
  docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md \
  docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md \
  docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md
git commit -S \
  -m "Record production proof superseding disposable ADW tests" \
  -m "Production semantics must be exercised where authority will live; a disposable App was dropped because its unavailable identity blocked equivalent proof. Tasks 1–6 retain the offline failure matrix while the owner-authorized quiet window contains positive writes." \
  -m "Anchor: docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md records the supersession."
```

Expected: signed branch commit; plain imperative subject; no AI attribution.

### Task 2: Test production dispatch and event-loop safety

**Files:**

- Modify: `adw/test/core.test.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/test/scenarios.test.mjs`
- Modify: `adw/test/wrappers.test.mjs`

- [x] **Step 1: Write failing dispatch-authority tests**

Add table tests for these exact internal intents and targets:

```text
repository_dispatch retry_route     -> adw-issues.yml      -> {repositoryId,issueId,sourceRevision,role,provider} -> original route provider
repository_dispatch fallback_route  -> adw-issues.yml      -> {repositoryId,issueId,sourceRevision,role,provider} -> named fallback provider
repository_dispatch retry_pioneer   -> adw-issues.yml      -> {repositoryId,issueId,sourceRevision,role,provider} -> pioneer/claude
repository_dispatch run_review      -> adw-pulls.yml       -> {repositoryId,prId,headSha,role,provider} -> reviewer or security-reviewer/claude
repository_dispatch run_obligation  -> adw-maintenance.yml -> {repositoryId,prId,mergeSha,role,provider} -> docs-writer/codex
```

Require `mapReconciliationIntents` to emit only the closed `dispatch_repository(eventType,clientPayload)` operation and include the role/provider/entity/revision fields needed by its target, while reserving `smith_operation_digest` for `github.mjs`. Require owner manual `workflow_dispatch` with `lane=audit|reconcile` to bind the repository entity and owner identity. Require internal `repository_dispatch` to bind exact App bot numeric ID/login and reject owner/manual attempts to forge internal event types.

- [x] **Step 2: Write failing wrapper truth-table tests**

Assert all of the following:

```text
issues opened/reopened               -> triager, Codex primary, Claude fallback
issues labeled ready                 -> builder
issues labeled codex                 -> codex-builder
issues labeled needs:prototype       -> pioneer
issues labeled needs:breakdown       -> planner
issues labeled any other label       -> skipped
owner issue_comment                  -> steerer, Claude primary
App/non-owner issue_comment          -> skipped
pull opened/reopened/synchronize     -> reviewer
pull labeled changes-requested       -> reviser
pull labeled reviewed                -> security-reviewer
pull labeled any other label         -> reconcile-only
pull closed+merged                    -> docs-writer
pull closed+unmerged                 -> reconcile-only
pull_request_review submitted        -> reviser
pull_request_review_comment created  -> reconcile-only
check_run/check_suite completed      -> reconcile-only
manual maintenance audit/reconcile   -> provider-free owner control lane
scheduled maintenance 57 2 * * *     -> alert-triager snapshot; no alert webhook
internal run_review                  -> exact requested review role/current head
internal run_obligation              -> exact requested role/merge SHA
```

Also require internal run-name to equal `${{ github.event.client_payload.smith_operation_digest }}` so `github.mjs` can prove delivery. Require exact `client_payload` fields for each closed `repository_dispatch` event type and no internal `workflow_dispatch` input.

- [x] **Step 3: Write failing loop-prevention tests**

Assert triager-applied classification labels cannot start another triager, steerer App replies cannot start another steerer, and reviewer/security labels outside the two explicit handoff labels wake reconciliation rather than another provider. Assert every reconcile-only path has zero `assess` commands reachable. With `vars.ADW_CUTOVER_HOLD == 'true'`, every operational job across all three wrappers must skip, emit no artifact, and mint no token; self-test remains unaffected.

- [x] **Step 4: Run tests to verify the production gaps fail**

Run:

```bash
node --test \
  adw/test/core.test.mjs \
  adw/test/github.test.mjs \
  adw/test/scenarios.test.mjs \
  adw/test/wrappers.test.mjs
```

Expected: FAIL because dispatch intents lack complete target authority, manual reconcile does not accept `dispatch`, wrappers lack closed `repository_dispatch` grammar, and broad label/comment triggers can re-enter providers.

### Task 3: Implement bounded manual and internal dispatch

**Files:**

- Modify: `adw/core.mjs`
- Modify: `adw/github.mjs`
- Modify: `adw/roles.mjs`
- Modify: `adw/test/core.test.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/test/scenarios.test.mjs`

- [x] **Step 1: Bind complete dispatch authority in pure reconciliation**

Extend each intent with the minimum role/provider/entity revision required by the table in Task 2. Keep the closed event-type-to-workflow map and canonical sort/dedup. Emit only `dispatch_repository` with exact client payloads. Reject unknown roles, provider/role mismatches, missing current head/merge SHA, non-current source revisions, reserved payload names, and cross-repository entities.

Expected: no wrapper infers a role from arbitrary strings; it consumes validated closed values emitted by `core.mjs`.

- [x] **Step 2: Normalize owner manual dispatches**

Permit `reconciler.eventKinds` to include `dispatch`. In `github.mjs`, accept exactly owner-authenticated `workflow_dispatch` with `lane=audit` or `lane=reconcile`, repository entity, and no internal operation digest. Route to the provider-free auditor/reconciler authority.

Expected: non-owner manual dispatch fails before snapshot creation.

- [x] **Step 3: Normalize App internal dispatches**

Accept exactly the five `repository_dispatch` event types from Task 2 only when actor ID/login match `APP_BOT_USER_ID`/`APP_BOT_LOGIN`, `client_payload.smith_operation_digest` is a lowercase 64-hex digest, the remaining payload is exact, and entity revisions match live issue/PR state. Convert issue intents to bounded `issue` events and PR intents to bounded `pull_request` events so existing role snapshot plans remain authoritative. Never interpret a `workflow_dispatch` input as an internal intent.

Expected: a stale `run_review.headSha`, stale `run_obligation.mergeSha`, mismatched provider, unsupported obligation role, owner-forged operation digest, or bot identity mismatch fails closed before provider execution.

- [x] **Step 4: Keep dispatch reads and writes bounded**

Use only existing closed `github.mjs` methods. The only new writer permitted is fixed `POST /repos/bugabinga/smith/dispatches` with a closed event type and exact `client_payload`; it must add the operation digest, bind the App identity and current `main` head, validate entity/revision authority, and prove one matching workflow delivery before completing its receipt. Add no generic URL/method/GraphQL escape and no wrapper-side `gh`, `jq`, policy shell, or inline prompt.

- [x] **Step 5: Run focused tests**

```bash
node --test \
  adw/test/core.test.mjs \
  adw/test/github.test.mjs \
  adw/test/scenarios.test.mjs
```

Expected: PASS.

- [x] **Step 6: Commit the dispatch contract**

```bash
git add \
  adw/core.mjs adw/github.mjs adw/roles.mjs \
  adw/test/core.test.mjs adw/test/github.test.mjs adw/test/scenarios.test.mjs
git commit -S \
  -m "Bind ADW reconciliation dispatches to live entities" \
  -m "Reconciliation must carry enough authority for a target wrapper to reject spoofed or stale work; wrapper inference was dropped because five intent kinds cross issue and pull boundaries." \
  -m "Anchor: adw/{core,github,roles}.mjs owns dispatch authority."
```

### Task 4: Adapt exact wrappers to production identity and positive controls

**Files:**

- Modify: `prototypes/p38-adw-disposable/wrappers/adw-issues.yml`
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-pulls.yml`
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml`
- Modify: `adw/test/wrappers.test.mjs`

- [x] **Step 1: Change App minting from unavailable client ID to existing App ID**

In both token steps, replace:

```yaml
client-id: ${{ vars.APP_CLIENT_ID }}
```

with:

```yaml
app-id: ${{ secrets.APP_ID }}
```

Keep `private-key: ${{ secrets.APP_PRIVATE_KEY }}` and every exact `permission-*` expression unchanged. Update tests to require exactly two `app-id` inputs, zero `client-id` inputs, and zero `APP_CLIENT_ID` references.

- [x] **Step 2: Add exact dispatch schemas and run names**

Consume only the validated `repository_dispatch` `client_payload` fields from Task 3 plus writer-reserved `smith_operation_digest`; expose none of them through `workflow_dispatch`. Internal run-name must be exactly the digest. Owner maintenance `workflow_dispatch` exposes only `lane` with choices `audit` and `reconcile`; it does not expose provider, role, repository, ref, token, event type, entity, revision, or operation-digest inputs. Natural/manual run names are exact and entity-bound: `ADW issue #<number>`, `ADW pull #<number>`, `ADW maintenance audit`, `ADW maintenance reconcile`, or `ADW maintenance <cron|push>`.

- [x] **Step 3: Encode the event truth table**

Add job-level conditions and input expressions matching Task 2 exactly. Add the exact global `ADW_CUTOVER_HOLD != 'true'` guard to natural callers and every `always()` shared-graph path so no downstream verify/apply/evidence job runs when prepare is held. Preserve one reusable execution graph, one provider credential per provider job, tokenless reduce/verify, operation-scoped apply token, `adw-write`, and `cancel-in-progress:false`. Alert triage is schedule-only at `57 2 * * *`; do not declare unsupported `dependabot_alert` or `code_scanning_alert` webhook keys or infer alert events with `endsWith(...)`.

- [x] **Step 4: Prove internal dispatch delivery grammar**

Require each dispatched workflow to:

- run from `main` at the repository-dispatch head proven by `github.mjs`;
- use the exact natural/manual/internal run names above so evidence selection binds entity or operation rather than timestamp alone;
- derive control SHA from `github.sha`;
- bind issue ID/source revision or PR/head/merge SHA from validated `client_payload`;
- execute the requested role/provider only;
- never accept caller-supplied repository or arbitrary ref;
- emit exactly the same artifact graph as natural events.

- [x] **Step 5: Run wrapper tests**

```bash
node --test adw/test/wrappers.test.mjs
```

Expected: PASS; combined canonical operational YAML remains below 400 physical lines.

- [x] **Step 6: Commit production wrapper adaptation**

```bash
git add \
  prototypes/p38-adw-disposable/wrappers/adw-issues.yml \
  prototypes/p38-adw-disposable/wrappers/adw-pulls.yml \
  prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml \
  adw/test/wrappers.test.mjs
git commit -S \
  -m "Adapt MJS wrappers to the production App identity" \
  -m "Production exposes the App ID but not its private client ID, so token minting must use the supported existing identity. Broad event routing was dropped because provider-written labels and comments can re-enter providers." \
  -m "Anchor: prototypes/p38-adw-disposable/wrappers/ holds the three canonical wrappers."
```

### Task 5: Convert canonical provider instructions to assessment-only

**Files:**

- Modify: all assessment-only charter files listed in the file map
- Modify: `adw/test/wrappers.test.mjs`

- [x] **Step 1: Write the failing charter-boundary test**

Derive unique charter paths from `listRoles()`. Exclude unused `.claude/agents/release-manager.md`. Require every active charter to contain this exact section:

```markdown
## MJS assessment-only boundary

When `adw/main.mjs` invokes this charter, analyze only the normalized snapshot and return only JSON matching the supplied schema. Do not call GitHub, commit, push, open, close, label, comment on, dispatch, rerun, or merge forge objects, and do not claim those effects occurred. For patch roles, edits in the tokenless assessment checkout are proposed patch bytes only; tokenless verification and the serialized App-token apply job own all effects. Return `noop` when no canonical operation is warranted.
```

Require release-manager absent from `listRoles()` and all wrapper text.

- [x] **Step 2: Run the charter test to verify failure**

```bash
node --test --test-name-pattern='assessment-only|release-manager' adw/test/wrappers.test.mjs
```

Expected: FAIL on active charters that still describe direct effects.

- [x] **Step 3: Add the exact boundary and reconcile artifact wording**

Add the exact section to all active charters. Change direct-effect artifact wording to proposed assessment wording:

```text
adw-doctor          -> proposed health finding/issue or noop
builder/reviser     -> proposed patch manifest+bytes, summary, or blocked/noop
 dependency-manager -> proposed verdict/comment/label operations or noop
 docs-writer         -> proposed docs patch or noop
 planner             -> proposed issue/milestone operations or noop
 reviewer            -> structured approve/reject findings only
 security-reviewer   -> structured risk/findings only
 steerer              -> bounded comment recommendation or noop
 surveyor             -> proposed next work-order or noop
 sweeper              -> proposed maintenance operations or noop
 triager              -> structured triage body/labels or noop
 pioneer              -> proposed prototype patch and proof verdict or noop
```

Preserve domain policy; remove claims that the provider itself committed, pushed, opened, labeled, commented, dispatched, reran, or merged.

- [x] **Step 4: Run charter and provider tests**

```bash
node --test adw/test/{providers,roles,wrappers}.test.mjs
```

Expected: PASS; schema names and role paths remain unchanged.

- [x] **Step 5: Commit assessment-only charters**

```bash
git add \
  .claude/agents/adw-doctor.md \
  .claude/agents/builder.md \
  .claude/agents/dependency-manager.md \
  .claude/agents/docs-writer.md \
  .claude/agents/planner.md \
  .claude/agents/reviewer.md \
  .claude/agents/security-reviewer.md \
  .claude/agents/steerer.md \
  .claude/agents/surveyor.md \
  .claude/agents/sweeper.md \
  .claude/agents/triager.md \
  .claude/skills/pioneer/SKILL.md \
  adw/test/wrappers.test.mjs
git commit -S \
  -m "Make ADW charters assessment only" \
  -m "Providers must propose bounded artifacts after cutover rather than claim forge effects; dual semantic modes were dropped because legacy writers leave in the same atomic merge." \
  -m "Anchor: .claude/agents/ carries the active assessment boundary."
```

### Task 6: Promote wrappers and delete every legacy writer

**Files:**

- Create: `.github/workflows/adw-issues.yml`
- Create: `.github/workflows/adw-pulls.yml`
- Create: `.github/workflows/adw-maintenance.yml`
- Modify: `.github/workflows/adw-selftest.yml`
- Delete: all legacy workflow and `.github/adw/` files listed in the file map
- Modify: `adw/test/wrappers.test.mjs`

- [x] **Step 1: Write failing exact-promotion and sole-writer tests**

Require byte equality between each prototype candidate and production path. Require exact production ADW inventory:

```text
.github/workflows/adw-issues.yml
.github/workflows/adw-maintenance.yml
.github/workflows/adw-pulls.yml
.github/workflows/adw-selftest.yml
```

Require only the three operational wrappers to contain App token minting or `node adw/main.mjs apply`; require self-test to have no secrets, writes, provider command, or `adw-write` job.

- [x] **Step 2: Run the inventory test to verify failure**

```bash
node --test --test-name-pattern='production inventory|byte-identical|sole writer' \
  adw/test/wrappers.test.mjs
```

Expected: FAIL because candidates are inactive and legacy workflows still exist.

- [x] **Step 3: Promote exact bytes**

```bash
cp prototypes/p38-adw-disposable/wrappers/adw-issues.yml \
  .github/workflows/adw-issues.yml
cp prototypes/p38-adw-disposable/wrappers/adw-pulls.yml \
  .github/workflows/adw-pulls.yml
cp prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml \
  .github/workflows/adw-maintenance.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-issues.yml \
  .github/workflows/adw-issues.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-pulls.yml \
  .github/workflows/adw-pulls.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml \
  .github/workflows/adw-maintenance.yml
```

Expected: all `cmp` commands exit 0.

- [x] **Step 4: Reduce self-test to the retained non-writer**

Pin checkout to `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, keep `permissions: contents: read`, and run only:

```yaml
- name: MJS control-plane contracts
  run: node --test adw/test/*.test.mjs
```

Remove legacy shell-test steps and references to deleted `.github/adw/` files.

- [x] **Step 5: Delete superseded workflow and shell files**

```bash
git rm \
  .github/workflows/adw-alerts.yml \
  .github/workflows/adw-automerge.yml \
  .github/workflows/adw-build.yml \
  .github/workflows/adw-codex-build.yml \
  .github/workflows/adw-codex-review.yml \
  .github/workflows/adw-comment.yml \
  .github/workflows/adw-deps.yml \
  .github/workflows/adw-docs.yml \
  .github/workflows/adw-doctor.yml \
  .github/workflows/adw-gate.yml \
  .github/workflows/adw-intake.yml \
  .github/workflows/adw-jam-detector.yml \
  .github/workflows/adw-labels.yml \
  .github/workflows/adw-pioneer.yml \
  .github/workflows/adw-plan.yml \
  .github/workflows/adw-release.yml \
  .github/workflows/adw-review.yml \
  .github/workflows/adw-revise.yml \
  .github/workflows/adw-settings-audit.yml \
  .github/workflows/adw-survey.yml \
  .github/workflows/adw-sweep.yml \
  .github/adw/gate-labels.sh \
  .github/adw/gate-labels.test.sh \
  .github/adw/reconcile-builder-routes.sh \
  .github/adw/reconcile-builder-routes.test.sh \
  .github/adw/workflow-contract.test.sh
```

Expected: `adw-release.yml` is deleted with no replacement; release-manager remains deferred.

- [x] **Step 6: Run production inventory tests**

```bash
node --test adw/test/wrappers.test.mjs
find .github/workflows -maxdepth 1 -type f -name 'adw-*.yml' -print | sort
```

Expected: tests PASS and inventory is exactly the four paths above.

- [x] **Step 7: Commit the atomic tree transition**

```bash
git add .github/workflows adw/test/wrappers.test.mjs
git commit -S \
  -m "Make MJS the sole ADW writer" \
  -m "A partial handoff would permit competing writers, so all operational authority moves in one tree transition. Keeping release automation was dropped because its MJS replacement remains deferred." \
  -m "Anchor: .github/workflows/adw-*.yml reduces to three wrappers plus self-test."
```

### Task 7: Prove offline failures and final cutover tree

**Files:**

- Test: `adw/test/*.test.mjs`
- Test: workspace and workflow files

- [x] **Step 1: Run the complete offline MJS suite**

```bash
node --test adw/test/*.test.mjs
```

Expected: zero failures/cancellations/todos. This is the retained evidence for provider unavailable/fallback, malformed and oversized transport, stale preconditions, partial apply retry, disagreement, sticky risk, current-head evidence, blocked/behind jam, settings drift, label sync, and post-merge retry. Do not recreate those failures in production.

- [ ] **Step 2: Run project checks**

```bash
cargo run -p xtask -- check
git diff --check
```

Expected: PASS.

> **Execution blocker:** `cargo run -p xtask -- check` reached the `xtask pup` gate and returned the exact environment failure below. `git diff --check` passed independently; Step 2 remains unchecked.
>
> ```text
> error: no such command: `+nightly-2026-01-22`
>
> help: invoke `cargo` through `rustup` to handle `+toolchain` directives
> xtask pup: returned a non-zero status
> xtask check: pup gate returned a non-zero status
> ```

- [x] **Step 3: Parse exact YAML and verify boundaries**

```bash
for f in .github/workflows/adw-{issues,pulls,maintenance,selftest}.yml; do
  yq eval '.' "$f" >/dev/null
done
! rg -n 'APP_CLIENT_ID|client-id:' \
  prototypes/p38-adw-disposable/wrappers .github/workflows/adw-*.yml
! rg -n 'claude-code-action|(^|[[:space:]])(gh|git|jq|npm|cargo)[[:space:]]' \
  .github/workflows/adw-{issues,pulls,maintenance}.yml
! find . -maxdepth 2 -type f \( -name package.json -o -name package-lock.json \) | grep .
```

Expected: YAML parses; forbidden searches are empty; no package manifest/lockfile was introduced.

- [x] **Step 4: Verify signed branch commits and exact final paths**

```bash
BASE=$(git merge-base origin/main HEAD)
for commit in $(git rev-list "$BASE"..HEAD); do git verify-commit "$commit"; done
git diff --name-status "$BASE"..HEAD
```

Expected: every executor-created branch commit verifies; diff contains production wrappers, assessment-only charters, MJS/tests/planning records, legacy deletions, and no unrelated production code.

- [x] **Step 5: Require a committed, clean verification state**

If verification exposes a defect, return to its owning TDD task, add the failing regression, fix it, and repeat that task's exact signed commit command. Then run:

```bash
test -z "$(git status --porcelain)"
```

Expected: clean tree; no failing result or uncommitted fix is carried into review.

### Task 7A: Correct unsupported maintenance alert triggers

**Files:**

- Modify: `adw/test/wrappers.test.mjs`
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml`
- Modify: `.github/workflows/adw-maintenance.yml`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

Production run `30713498516` failed before job creation because GitHub Actions does not support `dependabot_alert` or `code_scanning_alert` as workflow `on` events. Alert snapshot collection remains a scheduled maintenance responsibility.

- [x] **Step 1: Add and run the failing wrapper regression**

Require maintenance triggers to reject both unsupported keys, reject `endsWith(github.event_name, '_alert')`, and select `alert-triager` only for `57 2 * * *`. The focused test failed on the first unsupported key with zero passes and one failure, recording RED before implementation.

- [x] **Step 2: Remove only unsupported alert routing and promote exact bytes**

Delete both unsupported trigger blocks and both `endsWith(..._alert)` branches from the canonical wrapper. Preserve the `57 2 * * *` schedule and its `alert-triager` role, then copy canonical bytes to production.

- [x] **Step 3: Verify the correction and record lint scope honestly**

The focused regression, all 18 wrapper tests, and all 224 Node tests pass. Exact actionlint v1.7.7 passes the four production ADW workflows and the known-clean `ci.yml` control; linting every production workflow no longer reports `adw-maintenance.yml` but still reports seven unrelated pre-existing findings in `ci-prototype.yml`, `devskim.yml`, `p35-adw-harness.yml`, `p37-codex-harness.yml`, and `prototypes.yml`. All production workflow YAML parses, all three promoted wrappers equal canonical bytes, canonical wrappers total 371 physical lines, and `git diff --check` passes.

### Task 8: Push the owner-authored protected PR and record owner approval on its exact head

**Files:** none

- [ ] **Step 1: Rebase only before approval, then rerun Task 7**

```bash
git fetch origin
BASE=$(git merge-base origin/main HEAD)
test "$BASE" = "$(git rev-parse origin/main)" || git -c commit.gpgsign=true rebase origin/main
node --test adw/test/*.test.mjs
cargo run -p xtask -- check
git diff --check
BASE=$(git merge-base origin/main HEAD)
for commit in $(git rev-list "$BASE"..HEAD); do git verify-commit "$commit"; done
```

Expected: final branch contains latest main and all checks pass. No rebase is permitted after the exact-head owner approval comment.

- [ ] **Step 2: Push the branch**

```bash
git push --set-upstream origin adw/mjs-phase4
```

Expected: branch push succeeds; branch name is retained because it already contains Phase 4 Tasks 1–6 and this atomic cutover.

- [ ] **Step 3: Open one cutover PR**

```bash
gh api user | jq -e '.id == 876467 and .login == "bugabinga"' >/dev/null
gh pr create --repo bugabinga/smith \
  --base main \
  --head adw/mjs-phase4 \
  --title "Cut over production ADW writes to MJS" \
  --body-file - <<'EOF'
## What forced this
Production authority cannot transfer while legacy and candidate writers can overlap, and the disposable App identity required for equivalent proof is unavailable.

## The call
Move all operational ADW writes to three MJS wrappers in one owner-controlled quiet-window squash.

## What we deliberately didn't do
No disposable repository or release replacement: the former cannot reproduce the production App boundary, and the latter remains deferred.

## Evidence
The retained Node failure matrix, workspace check, and wrapper contracts pass; positive production run URLs and receipts will be posted after cutover.

## Surface touched
The control-plane range is anchored at `adw/` and its workflow/charter boundaries.

## If this ages badly
Disable and drain MJS, then fast-forward the prepared signed rollback when any trigger in the Phase 5 plan fires.
EOF
PR=$(gh pr view --repo bugabinga/smith --json number --jq .number)
echo "$PR"
```

Expected: one PR authored with the approved current `bugabinga` authentication; do not open a separate Phase 5 PR. Owner authorship is permitted because the exact-head comment and confirmed ruleset bypass provide the authorized evidence route.

- [ ] **Step 4: Wait for required checks on the exact PR head**

```bash
PR=$(gh pr view --repo bugabinga/smith --json number --jq .number)
PR_HEAD=$(gh pr view "$PR" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
gh pr checks "$PR" --repo bugabinga/smith --watch --fail-fast
test "$PR_HEAD" = "$(gh pr view "$PR" --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
```

Expected: all required checks green; head unchanged.

- [ ] **Step 5: Record the exact-head owner approval marker**

From the authenticated owner shell, post exactly one approval comment and retain its immutable REST coordinates:

```bash
gh api user | jq -e '.id == 876467 and .login == "bugabinga"' >/dev/null
OWNER_APPROVAL_MARKER="Owner approval: quiet-window MJS production cutover and positive-only proof on exact head $PR_HEAD."
OWNER_APPROVAL_COMMENT_JSON=$(gh api --method POST \
  "repos/bugabinga/smith/issues/$PR/comments" \
  -f body="$OWNER_APPROVAL_MARKER")
OWNER_APPROVAL_COMMENT_ID=$(jq -er '.id' <<<"$OWNER_APPROVAL_COMMENT_JSON")
OWNER_APPROVAL_COMMENT_CREATED_AT=$(jq -er '.created_at' <<<"$OWNER_APPROVAL_COMMENT_JSON")
jq -e --arg body "$OWNER_APPROVAL_MARKER" --argjson pr "$PR" '
  .id > 0 and
  .user.id == 876467 and .user.login == "bugabinga" and
  .author_association == "OWNER" and .body == $body and
  .created_at == .updated_at and
  (.issue_url | endswith("/issues/" + ($pr | tostring)))
' <<<"$OWNER_APPROVAL_COMMENT_JSON" >/dev/null
printf 'owner_approval_comment_id=%s\nowner_approval_created_at=%s\nowner_approval_marker=%s\n' \
  "$OWNER_APPROVAL_COMMENT_ID" "$OWNER_APPROVAL_COMMENT_CREATED_AT" \
  "$OWNER_APPROVAL_MARKER"
```

Expected: the owner-authored comment has the exact marker containing `PR_HEAD`; its numeric comment ID and creation timestamp are retained. Any identity, body, issue binding, or creation-time mismatch stops cutover.

### Task 9: Seed production identity and prepare signed rollback

**Files:** none; rollback material stays outside the repository tree

- [ ] **Step 1: Presence-check secrets without reading values**

```bash
required='APP_ID APP_PRIVATE_KEY CLAUDE_CODE_OAUTH_TOKEN CODEX_AUTH_JSON'
actual=$(gh secret list --repo bugabinga/smith --json name --jq '.[].name' | sort)
for name in $required; do grep -qx "$name" <<<"$actual"; done
! grep -qx APP_CLIENT_ID <<<"$actual"
! grep -qx APP_CLIENT_ID <<<"$(gh variable list --repo bugabinga/smith --json name --jq '.[].name')"
```

Expected: four required names present; `APP_CLIENT_ID` secret and variable both absent. Do not run `gh secret set` or `gh secret delete`.

- [ ] **Step 2: Seed exact App bot variables**

```bash
gh variable set APP_BOT_USER_ID --repo bugabinga/smith --body '306488075'
gh variable set APP_BOT_LOGIN --repo bugabinga/smith --body 'agent-smith-bugabinga-adc[bot]'
gh variable list --repo bugabinga/smith --json name,value \
  --jq 'sort_by(.name) | map(select(.name == "APP_BOT_USER_ID" or .name == "APP_BOT_LOGIN"))'
```

Expected:

```json
[{"name":"APP_BOT_LOGIN","value":"agent-smith-bugabinga-adc[bot]"},{"name":"APP_BOT_USER_ID","value":"306488075"}]
```

- [ ] **Step 3: Freeze and recheck the owner-approved head**

```bash
test "$PR_HEAD" = "$(gh pr view "$PR" --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
test "$(git rev-parse origin/main)" = "$(gh api repos/bugabinga/smith/commits/main --jq .sha)"
```

Expected: owner-approved head and main baseline unchanged.

- [ ] **Step 4: Create an encrypted/private rollback workspace and reverse patch**

```bash
ROLLBACK_ROOT="$HOME/.local/state/smith-adw-phase5-rollback"
mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
CUTOVER_BASE=$(git merge-base origin/main "$PR_HEAD")
git diff --binary "$CUTOVER_BASE" "$PR_HEAD" > "$ROLLBACK_ROOT/cutover.patch"
git diff --binary -R "$CUTOVER_BASE" "$PR_HEAD" > "$ROLLBACK_ROOT/rollback.patch"
sha256sum "$ROLLBACK_ROOT"/*.patch > "$ROLLBACK_ROOT/SHA256SUMS"
```

Expected: rollback patch restores the exact pre-cutover tree; files contain no secret values.

- [ ] **Step 5: Rehearse and sign rollback before merge**

```bash
REHEARSAL_WT=$(mktemp -d "$ROLLBACK_ROOT/rehearsal.XXXXXX")
git worktree add --detach "$REHEARSAL_WT" "$PR_HEAD"
git -C "$REHEARSAL_WT" apply --index "$ROLLBACK_ROOT/rollback.patch"
git -C "$REHEARSAL_WT" commit -S \
  -m "Restore legacy ADW control plane" \
  -m "Cutover rollback must stop new MJS writes before restoring legacy authority; a force push was dropped because the prepared commit can remain a signed fast-forward child." \
  -m "Anchor: .github/workflows/adw-*.yml restores the pre-cutover authority boundary."
REHEARSAL_SHA=$(git -C "$REHEARSAL_WT" rev-parse HEAD)
git -C "$REHEARSAL_WT" verify-commit "$REHEARSAL_SHA"
test "$(git -C "$REHEARSAL_WT" rev-parse HEAD^{tree})" = \
  "$(git rev-parse "$CUTOVER_BASE^{tree}")"
git branch -f fix/rollback-adw-mjs-phase5-rehearsal "$REHEARSAL_SHA"
git bundle create "$ROLLBACK_ROOT/rehearsal.bundle" \
  refs/heads/fix/rollback-adw-mjs-phase5-rehearsal
git bundle verify "$ROLLBACK_ROOT/rehearsal.bundle"
git worktree remove --force "$REHEARSAL_WT"
```

Expected: signed rehearsal commit verifies and its tree equals the pre-cutover tree. It is rehearsal only because GitHub's future squash SHA cannot be known before merge.

### Task 10: Disable and drain every legacy writer in the quiet window

**Files:** none

- [ ] **Step 1: Enter the owner-announced quiet window**

Require owner confirmation in the cutover PR that no other main merge, label automation, or manual workflow dispatch will occur until Task 15 completes. Record UTC start time:

```bash
QUIET_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$QUIET_START"
```

- [ ] **Step 2: Disable exact legacy workflows, including deferred release**

```bash
set -euo pipefail
legacy=(
  adw-alerts.yml adw-automerge.yml adw-build.yml adw-codex-build.yml
  adw-codex-review.yml adw-comment.yml adw-deps.yml adw-docs.yml
  adw-doctor.yml adw-gate.yml adw-intake.yml adw-jam-detector.yml
  adw-labels.yml adw-pioneer.yml adw-plan.yml adw-release.yml
  adw-review.yml adw-revise.yml adw-settings-audit.yml adw-survey.yml
  adw-sweep.yml
)
for workflow in "${legacy[@]}"; do
  gh workflow disable "$workflow" --repo bugabinga/smith
done
```

Expected: all 21 operational legacy workflows are `disabled_manually`; `adw-selftest` remains `active`. `adw-release` is disabled and will not be replaced.

- [ ] **Step 3: Cancel every non-completed legacy run**

```bash
set -euo pipefail
for workflow in "${legacy[@]}"; do
  gh api --paginate \
    "repos/bugabinga/smith/actions/workflows/$workflow/runs?per_page=100" \
    --jq '.workflow_runs[] | select(.status != "completed") | .id'
done | sort -u > "$ROLLBACK_ROOT/legacy-active-runs"
while read -r run; do
  test -z "$run" || gh run cancel "$run" --repo bugabinga/smith
done < "$ROLLBACK_ROOT/legacy-active-runs"
```

Expected: every queued/in-progress/requested/waiting legacy run receives cancellation; completed historical runs remain untouched.

- [ ] **Step 4: Drain to zero and prove no dual writers**

```bash
set -euo pipefail
while :; do
  active=$(
    for workflow in "${legacy[@]}"; do
      gh api --paginate \
        "repos/bugabinga/smith/actions/workflows/$workflow/runs?per_page=100" \
        --jq '.workflow_runs[] | select(.status != "completed") | .id'
    done | sort -u
  )
  test -z "$active" && break
  sleep 15
done
workflow_states=$(gh workflow list --repo bugabinga/smith --all --json path,state)
for workflow in "${legacy[@]}"; do
  jq -e --arg path ".github/workflows/$workflow" '
    [.[] | select(.path == $path and .state == "disabled_manually")] | length == 1
  ' <<<"$workflow_states" >/dev/null
done
jq -e '
  [.[] | select(.path == ".github/workflows/adw-selftest.yml" and .state == "active")] | length == 1
' <<<"$workflow_states" >/dev/null
gh variable set ADW_CUTOVER_HOLD --repo bugabinga/smith --body true
test "$(gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith)" = true
```

Expected: zero active legacy runs, all legacy workflows disabled, self-test active, production MJS wrappers not yet present on main, and the non-secret global cutover hold armed. If any new legacy run appears, cancel it and restart the zero-active observation; do not merge until stable.

### Task 11: Atomically squash-merge and materialize parent-correct rollback

**Files:** none

- [ ] **Step 1: Revalidate exact head, checks, immutable owner comment, bypass, and drain immediately before merge**

```bash
set -euo pipefail
test "$PR_HEAD" = "$(gh pr view "$PR" --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
test "$CUTOVER_BASE" = "$(gh api repos/bugabinga/smith/commits/main --jq .sha)"
test "$CUTOVER_BASE" = "$(git rev-parse origin/main)"
test "$(gh pr view "$PR" --repo bugabinga/smith --json mergeable --jq .mergeable)" = MERGEABLE
gh pr checks "$PR" --repo bugabinga/smith --required
OWNER_APPROVAL_COMMENT_JSON=$(gh api \
  "repos/bugabinga/smith/issues/comments/$OWNER_APPROVAL_COMMENT_ID")
jq -e --argjson id "$OWNER_APPROVAL_COMMENT_ID" \
  --arg body "$OWNER_APPROVAL_MARKER" \
  --arg created "$OWNER_APPROVAL_COMMENT_CREATED_AT" \
  --arg head "$PR_HEAD" --argjson pr "$PR" '
    .id == $id and
    .user.id == 876467 and .user.login == "bugabinga" and
    .author_association == "OWNER" and .body == $body and
    .body == ("Owner approval: quiet-window MJS production cutover and positive-only proof on exact head " + $head + ".") and
    .created_at == $created and .updated_at == $created and
    (.issue_url | endswith("/issues/" + ($pr | tostring)))
  ' <<<"$OWNER_APPROVAL_COMMENT_JSON" >/dev/null
test "$(sha256sum "$ROLLBACK_ROOT/cutover.patch" "$ROLLBACK_ROOT/rollback.patch")" = \
  "$(cat "$ROLLBACK_ROOT/SHA256SUMS")"
test "$(gh api repos/bugabinga/smith/rulesets/19155559 --jq .current_user_can_bypass)" = always
test "$(gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith)" = true
workflow_states=$(gh workflow list --repo bugabinga/smith --all --json path,state)
for workflow in "${legacy[@]}"; do
  jq -e --arg path ".github/workflows/$workflow" '
    [.[] | select(.path == $path and .state == "disabled_manually")] | length == 1
  ' <<<"$workflow_states" >/dev/null
done
: > "$ROLLBACK_ROOT/legacy-active-runs.now"
for workflow in "${legacy[@]}"; do
  gh api --paginate \
    "repos/bugabinga/smith/actions/workflows/$workflow/runs?per_page=100" \
    --jq '.workflow_runs[] | select(.status != "completed") | .id'
done | sort -u > "$ROLLBACK_ROOT/legacy-active-runs.now"
test -f "$ROLLBACK_ROOT/legacy-active-runs.now"
test ! -s "$ROLLBACK_ROOT/legacy-active-runs.now"
```

Expected: exact owner-approved head and main base, mergeable PR, green required checks, immutable exact-head owner comment, unchanged rollback patch hashes, confirmed owner bypass, all legacy workflows disabled, and an explicitly created empty final-drain file.

- [ ] **Step 2: Perform the one atomic squash merge**

```bash
MERGE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr merge --admin --squash --delete-branch "$PR" --repo bugabinga/smith
MERGE_SHA=$(gh pr view "$PR" --repo bugabinga/smith --json mergeCommit --jq .mergeCommit.oid)
git fetch origin main
test "$MERGE_SHA" = "$(git rev-parse origin/main)"
```

Expected: confirmed ruleset bypass permits one administrative squash commit on main only after every preceding safeguard passes; no interval exists where both legacy and MJS writers are enabled.

- [ ] **Step 3: Verify GitHub signature and exact production inventory**

```bash
gh api "repos/bugabinga/smith/commits/$MERGE_SHA" \
  --jq '{sha:.sha,verified:.commit.verification.verified,reason:.commit.verification.reason}'
gh workflow list --repo bugabinga/smith --all --json path,state \
  --jq 'map(select(.state == "active" and (.path | startswith(".github/workflows/adw-")))) | sort_by(.path)'
```

Expected: `verified:true`; active paths are exactly `adw-issues.yml`, `adw-maintenance.yml`, `adw-pulls.yml`, and `adw-selftest.yml`. Removed `adw-release` has no active replacement.

- [ ] **Step 4: Materialize the parent-correct signed rollback before proof writes**

```bash
ROLLBACK_WT=$(mktemp -d "$ROLLBACK_ROOT/parent-correct.XXXXXX")
git worktree add --detach "$ROLLBACK_WT" "$MERGE_SHA"
git -C "$ROLLBACK_WT" apply --index "$ROLLBACK_ROOT/rollback.patch"
git -C "$ROLLBACK_WT" commit -S \
  -m "Restore legacy ADW control plane" \
  -m "Cutover rollback must stop new MJS writes before restoring legacy authority; a force push was dropped because the prepared commit can remain a signed fast-forward child." \
  -m "Anchor: .github/workflows/adw-*.yml restores the pre-cutover authority boundary."
ROLLBACK_SHA=$(git -C "$ROLLBACK_WT" rev-parse HEAD)
test "$(git -C "$ROLLBACK_WT" rev-parse HEAD^)" = "$MERGE_SHA"
test "$(git -C "$ROLLBACK_WT" rev-parse HEAD^{tree})" = \
  "$(git rev-parse "$CUTOVER_BASE^{tree}")"
git -C "$ROLLBACK_WT" verify-commit "$ROLLBACK_SHA"
test -z "$(git ls-remote --heads origin refs/heads/fix/rollback-adw-mjs-phase5)"
git branch -f fix/rollback-adw-mjs-phase5 "$ROLLBACK_SHA"
git push origin refs/heads/fix/rollback-adw-mjs-phase5
git bundle create "$ROLLBACK_ROOT/parent-correct.bundle" \
  refs/heads/fix/rollback-adw-mjs-phase5
git bundle verify "$ROLLBACK_ROOT/parent-correct.bundle"
git worktree remove --force "$ROLLBACK_WT"
HOLD_RELEASE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh variable delete ADW_CUTOVER_HOLD --repo bugabinga/smith
if gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith >/dev/null 2>&1; then false; fi
: > "$ROLLBACK_ROOT/held-mjs-runs"
for workflow in adw-issues.yml adw-pulls.yml adw-maintenance.yml; do
  gh run list --repo bugabinga/smith --workflow "$workflow" --limit 100 \
    --json databaseId,createdAt |
    jq -r --arg start "$MERGE_START" --arg end "$HOLD_RELEASE" \
      '.[] | select(.createdAt >= $start and .createdAt <= $end) | .databaseId'
done | sort -u > "$ROLLBACK_ROOT/held-mjs-runs"
test -s "$ROLLBACK_ROOT/held-mjs-runs"
while read -r run; do
  while test "$(gh run view "$run" --repo bugabinga/smith --json status --jq .status)" != completed; do sleep 5; done
  gh run view "$run" --repo bugabinga/smith --json jobs |
    jq -e '.jobs | length >= 1 and all(.[]; .conclusion == "skipped")' >/dev/null
  test "$(gh api "repos/bugabinga/smith/actions/runs/$run/artifacts" --jq .total_count)" = 0
done < "$ROLLBACK_ROOT/held-mjs-runs"
```

Expected: signed rollback is a direct child of the cutover squash, restores the exact pre-cutover tree, and is available at `fix/rollback-adw-mjs-phase5` plus the private bundle. Every MJS run created before rollback readiness has only skipped jobs and zero artifacts; the hold is deleted only afterward.

- [ ] **Step 5: Verify only MJS can write**

```bash
gh workflow list --repo bugabinga/smith --all --json path,state \
  --jq '.[] | select(.state == "active" and (.path | startswith(".github/workflows/adw-"))) | .path' \
  | sort
```

Expected exactly:

```text
.github/workflows/adw-issues.yml
.github/workflows/adw-maintenance.yml
.github/workflows/adw-pulls.yml
.github/workflows/adw-selftest.yml
```

### Task 12: Run manual audit and reconciliation positive proof

**Files:** none; evidence is downloaded outside the repository

- [ ] **Step 1: Revalidate organic proof state without mutation**

```bash
mkdir -p "$HOME/adw-phase5-evidence"
for pr in 150 163 165 166; do
  gh pr view "$pr" --repo bugabinga/smith \
    --json number,state,headRefOid,mergeStateStatus,autoMergeRequest,url
 done | jq -s '.' > "$HOME/adw-phase5-evidence/pre-audit-prs.json"
jq -e '
  (map(select(.number == 150 and .state == "OPEN" and .mergeStateStatus == "BLOCKED")) | length == 1) and
  (map(select((.number == 163 or .number == 165 or .number == 166) and .state == "OPEN" and .mergeStateStatus == "BEHIND")) | length == 3)
' "$HOME/adw-phase5-evidence/pre-audit-prs.json"
```

Capture immutable policy baselines before audit:

```bash
gh api repos/bugabinga/smith/rulesets/19155559 | jq -S . \
  > "$HOME/adw-phase5-evidence/ruleset.before.json"
gh api repos/bugabinga/smith | jq -S \
  '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}' \
  > "$HOME/adw-phase5-evidence/settings.before.json"
```

Expected: current organic PR states match. If not, pause; never force them back.

- [ ] **Step 2: Dispatch owner manual audit**

```bash
AUDIT_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run adw-maintenance.yml --repo bugabinga/smith --ref main \
  -f lane=audit
AUDIT_RUN=$(gh run list --repo bugabinga/smith --workflow adw-maintenance.yml \
  --event workflow_dispatch --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$AUDIT_START" '
    [.[] | select(.createdAt >= $start and .displayTitle == "ADW maintenance audit")]
    | sort_by(.createdAt) | last | .databaseId')
[[ $AUDIT_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$AUDIT_RUN" --repo bugabinga/smith --exit-status
```

Expected: success; auditor provider jobs skipped; existing label drift repaired only for checked-in labels; settings/ruleset drift reported through an owner-visible issue/comment; #150/#163/#165/#166 receive current-head `merge-gate` failure checks or deterministic jam reports and remain open.

- [ ] **Step 3: Capture and validate audit artifacts/receipt**

Run `capture_run "$AUDIT_RUN" provider-free "$MERGE_SHA"`. Then assert:

```bash
AUDIT_DIR="$HOME/adw-phase5-evidence/$AUDIT_RUN/download"
test -z "$(find "$AUDIT_DIR" -maxdepth 1 -type d -name 'adw-assessment-*' -print)"
jq -e '.authority.name == "auditor" and .status == "complete"' \
  "$AUDIT_DIR"/adw-apply-result-1/result.json >/dev/null
jq -e '
  [.operations[] | select(
    .type == "arm_auto_merge" and
    (.prId == "150" or .prId == "163" or
     .prId == "165" or .prId == "166"))] | length == 0
' "$AUDIT_DIR"/adw-decision/decision.json >/dev/null
gh api repos/bugabinga/smith/labels/urgent \
  --jq '.color == "e03131" and .description == "Time-critical (regression, security-adjacent, or blocking others) — the planner ranks it ahead of same/lower-priority work when ordering the backlog"'
gh api repos/bugabinga/smith/rulesets/19155559 | jq -S . \
  > "$HOME/adw-phase5-evidence/ruleset.after.json"
gh api repos/bugabinga/smith | jq -S \
  '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}' \
  > "$HOME/adw-phase5-evidence/settings.after.json"
cmp "$HOME/adw-phase5-evidence/ruleset.before.json" \
  "$HOME/adw-phase5-evidence/ruleset.after.json"
cmp "$HOME/adw-phase5-evidence/settings.before.json" \
  "$HOME/adw-phase5-evidence/settings.after.json"
DRIFT_TITLE=$(jq -er '[.operations[] | select(.type == "report_drift")] | first | .title' \
  "$AUDIT_DIR"/adw-decision/decision.json)
DRIFT_MARKER=$(jq -er '[.operations[] | select(.type == "report_drift")] | first | .marker' \
  "$AUDIT_DIR"/adw-decision/decision.json)
DRIFT_URL=$(gh api --paginate 'repos/bugabinga/smith/issues?state=all&per_page=100' |
  jq -er --arg title "$DRIFT_TITLE" --arg marker "$DRIFT_MARKER" '
    [.[] | select(.user.id == 306488075 and
                  .user.login == "agent-smith-bugabinga-adc[bot]" and
                  .title == $title and (.body | contains($marker)))]
    | sort_by(.created_at) | last | .html_url')
test -n "$DRIFT_URL"
```

Expected: no assessment artifacts; complete auditor receipt; no blocked/behind auto-merge operation; exact `urgent` repair; byte-equivalent live ruleset/settings snapshots; and an App-authored drift report URL.

- [ ] **Step 4: Prove current-head App checks and no auto-merge**

```bash
for pr in 150 163 165 166; do
  head=$(gh pr view "$pr" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
  gh api "repos/bugabinga/smith/commits/$head/check-runs?filter=latest&per_page=100" |
    jq -e --arg head "$head" '
      ([.check_runs[] |
        select(.name == "check" and .head_sha == $head and
               .app.slug == "github-actions" and .status == "completed" and
               .conclusion == "success")] | length >= 1) and
      ([.check_runs[] |
        select(.name == "merge-gate" and .head_sha == $head and
               .app.slug == "agent-smith-bugabinga-adc" and
               .app.id != null and .status == "completed" and
               .conclusion == "failure")] | length >= 1)
    ' >/dev/null
  test "$(gh pr view "$pr" --repo bugabinga/smith --json state --jq .state)" = OPEN
done
```

Expected: each blocked/behind PR has exact-current-head successful product `check`, failing `merge-gate` from the App, and remains open. Audit decision contains no `arm_auto_merge` operation for these PRs.

- [ ] **Step 5: Dispatch owner manual reconciliation**

```bash
RECONCILE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run adw-maintenance.yml --repo bugabinga/smith --ref main \
  -f lane=reconcile
RECONCILE_RUN=$(gh run list --repo bugabinga/smith --workflow adw-maintenance.yml \
  --event workflow_dispatch --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$RECONCILE_START" '
    [.[] | select(.createdAt >= $start and .displayTitle == "ADW maintenance reconcile")]
    | sort_by(.createdAt) | last | .databaseId')
[[ $RECONCILE_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$RECONCILE_RUN" --repo bugabinga/smith --exit-status
```

Expected: success; no provider job runs unless reconciliation positively dispatches a missing real obligation/review through the closed internal path. Such a child run is recorded, not induced.

- [ ] **Step 6: Capture reconciliation and any child runs**

Run `capture_run "$RECONCILE_RUN" provider-free "$MERGE_SHA"`. For each `dispatch_repository` receipt, find the exact `repository_dispatch` child run whose `display_title` is its operation digest, call `capture_run` with the intent's canonical provider lane and `MERGE_SHA`, and require bot actor ID/login `306488075`/`agent-smith-bugabinga-adc[bot]`.

Expected: parent receipt and every natural child receipt complete; no duplicate operation digest.

### Task 13: Prove Codex triager and Claude owner steerer

**Files:** none

- [ ] **Step 1: Create one benign no-change proof issue**

```bash
TRIAGE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PROOF_ISSUE_URL=$(gh issue create --repo bugabinga/smith \
  --title "ADW production proof: classify a no-change operational record" \
  --body "This is a production cutover evidence record. It requests no repository, settings, workflow, secret, or product change. Classify it or return a no-op; no builder work is warranted.")
PROOF_ISSUE=${PROOF_ISSUE_URL##*/}
```

Expected: one owner-created issue; only the `opened` event invokes triager. Labels added by triager do not recursively invoke triager unless they are an explicit route label; any route label is a rollback trigger because this issue requests no build.

- [ ] **Step 2: Find and watch the Codex triager run**

```bash
TRIAGE_RUN=$(gh run list --repo bugabinga/smith --workflow adw-issues.yml \
  --event issues --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$TRIAGE_START" --arg title "ADW issue #$PROOF_ISSUE" '
    [.[] | select(.createdAt >= $start and .displayTitle == $title)]
    | sort_by(.createdAt) | first | .databaseId')
[[ $TRIAGE_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$TRIAGE_RUN" --repo bugabinga/smith --exit-status
```

Expected: `primary-codex` succeeds; `primary-claude` and `fallback-claude` are skipped; no builder/pioneer/planner follow-up run starts.

- [ ] **Step 3: Capture Codex assessment and receipt**

Run `capture_run "$TRIAGE_RUN" provider-codex "$MERGE_SHA"`, then:

```bash
TRIAGE_DIR="$HOME/adw-phase5-evidence/$TRIAGE_RUN/download"
jq -e '.provider == "codex" and .role == "triager"' \
  "$TRIAGE_DIR"/adw-assessment-codex/envelope.json >/dev/null
jq -e '.authority.name == "triager" and .status == "complete"' \
  "$TRIAGE_DIR"/adw-apply-result-1/result.json >/dev/null
jq -e '
  ([.jobs[] | select((.name | test("(^| / )primary-codex$")) and .conclusion == "success")] | length == 1) and
  ([.jobs[] | select((.name | test("(^| / )(primary-claude|fallback-claude)$")) and .conclusion != "skipped")] | length == 0)
' "$HOME/adw-phase5-evidence/$TRIAGE_RUN/run.json" >/dev/null
labels=$(gh issue view "$PROOF_ISSUE" --repo bugabinga/smith --json labels --jq '[.labels[].name] | join(",")')
! grep -Eq '(^|,)(ready|codex|needs:prototype|needs:breakdown)(,|$)' <<<"$labels"
```

Expected: exact Codex triager assessment, exact provider job conclusions, complete receipt, and no route label that could launch builder/planner/pioneer work.

- [ ] **Step 4: Post one owner steering comment**

```bash
STEER_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment "$PROOF_ISSUE" --repo bugabinga/smith \
  --body "@smith Production cutover proof: identify the role that owns this no-change record and recommend no repository mutation."
STEER_RUN=$(gh run list --repo bugabinga/smith --workflow adw-issues.yml \
  --event issue_comment --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$STEER_START" --arg title "ADW issue #$PROOF_ISSUE" '
    [.[] | select(.createdAt >= $start and .displayTitle == $title)]
    | sort_by(.createdAt) | first | .databaseId')
[[ $STEER_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$STEER_RUN" --repo bugabinga/smith --exit-status
```

Expected: owner-authenticated `primary-claude` succeeds as steerer; Codex primary is skipped; the App's response comment does not start a second steerer run.

- [ ] **Step 5: Capture Claude assessment, App response, and receipt**

Run `capture_run "$STEER_RUN" provider-claude "$MERGE_SHA"`, then:

```bash
STEER_DIR="$HOME/adw-phase5-evidence/$STEER_RUN/download"
jq -e '.provider == "claude" and .role == "steerer"' \
  "$STEER_DIR"/adw-assessment-claude/envelope.json >/dev/null
jq -e '.authority.name == "steerer" and .status == "complete"' \
  "$STEER_DIR"/adw-apply-result-1/result.json >/dev/null
jq -e '
  ([.jobs[] | select((.name | test("(^| / )primary-claude$")) and .conclusion == "success")] | length == 1) and
  ([.jobs[] | select((.name | test("(^| / )(primary-codex|fallback-codex)$")) and .conclusion != "skipped")] | length == 0)
' "$HOME/adw-phase5-evidence/$STEER_RUN/run.json" >/dev/null
gh api "repos/bugabinga/smith/issues/$PROOF_ISSUE/comments?per_page=100" \
  --jq '[.[] | select(.user.id == 306488075 and .user.login == "agent-smith-bugabinga-adc[bot]")] | length >= 1'
for run in $(gh run list --repo bugabinga/smith --workflow adw-issues.yml \
  --event issue_comment --limit 20 --json databaseId,createdAt,displayTitle |
  jq -r --arg start "$STEER_START" --arg title "ADW issue #$PROOF_ISSUE" \
    '.[] | select(.createdAt >= $start and .displayTitle == $title) | .databaseId'); do
  if test "$run" != "$STEER_RUN"; then
    gh run view "$run" --repo bugabinga/smith --json jobs |
      jq -e '[.jobs[] | select((.name | test("primary-|fallback-")) and .conclusion != "skipped")] | length == 0' >/dev/null
  fi
done
```

Expected: exact Claude steerer assessment, exact provider job conclusions, complete receipt, App-authored response, and any workflow run caused by that App response has all provider jobs skipped.

- [ ] **Step 6: Close the proof issue without another provider route**

```bash
gh issue close "$PROOF_ISSUE" --repo bugabinga/smith \
  --comment "Positive MJS production proof recorded on the cutover PR."
```

Expected: issue closes; `closed` is not an issue-wrapper trigger.

### Task 14: Prove review-comment and check reconcile-only paths

**Files:** none

- [ ] **Step 1: Create one benign file-level review comment on #150's exact head**

```bash
PR_PROOF=150
REVIEW_HEAD=$(gh pr view "$PR_PROOF" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
REVIEW_FILE=$(gh api "repos/bugabinga/smith/pulls/$PR_PROOF/files?per_page=100" --jq '.[0].filename')
REVIEW_COMMENT_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh api --method POST "repos/bugabinga/smith/pulls/$PR_PROOF/comments" \
  -f body='MJS cutover positive proof: reconcile this exact current head; no provider revision is requested.' \
  -f commit_id="$REVIEW_HEAD" \
  -f path="$REVIEW_FILE" \
  -f subject_type='file' >/dev/null
```

Expected: one owner review comment on the current head; no code, label, secret, setting, or PR state changed.

- [ ] **Step 2: Capture review-comment reconcile-only run**

```bash
REVIEW_COMMENT_RUN=$(gh run list --repo bugabinga/smith --workflow adw-pulls.yml \
  --event pull_request_review_comment --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$REVIEW_COMMENT_START" --arg title "ADW pull #$PR_PROOF" '
    [.[] | select(.createdAt >= $start and .displayTitle == $title)]
    | sort_by(.createdAt) | first | .databaseId')
[[ $REVIEW_COMMENT_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$REVIEW_COMMENT_RUN" --repo bugabinga/smith --exit-status
```

Expected: prepare → reconcile → verify → serialized apply/evidence; all four provider jobs and reduce are skipped.

- [ ] **Step 3: Validate review-comment artifacts and receipt**

Run `capture_run "$REVIEW_COMMENT_RUN" provider-free "$MERGE_SHA"`, then:

```bash
jq -e '[.jobs[] | select((.name | test("primary-|fallback-| / reduce$")) and .conclusion != "skipped")] | length == 0' \
  "$HOME/adw-phase5-evidence/$REVIEW_COMMENT_RUN/run.json" >/dev/null
jq -e '.authority.name == "reconciler"' \
  "$HOME/adw-phase5-evidence/$REVIEW_COMMENT_RUN/download/adw-apply-result-1/result.json" >/dev/null
test "$(gh pr view 150 --repo bugabinga/smith --json state --jq .state)" = OPEN
test "$(gh pr view 150 --repo bugabinga/smith --json headRefOid --jq .headRefOid)" = "$REVIEW_HEAD"
```

Expected: all provider/reduce jobs skipped, reconciler receipt complete, and PR #150 unchanged.

- [ ] **Step 4: Identify the check-triggered reconcile-only run from audit's MJS check**

```bash
CHECK_RUN=$(gh run list --repo bugabinga/smith --workflow adw-pulls.yml \
  --event check_run --limit 50 --json databaseId,createdAt,headSha,displayTitle |
  jq -er --arg head "$MERGE_SHA" --arg title "ADW pull #$PR_PROOF" '
    [.[] | select(.headSha == $head and .displayTitle == $title)]
    | sort_by(.createdAt) | last | .databaseId')
[[ $CHECK_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$CHECK_RUN" --repo bugabinga/smith --exit-status
```

If GitHub emitted `check_suite` rather than `check_run`, select the matching `check_suite` run instead; do not create another check.

Run `capture_run "$CHECK_RUN" provider-free "$MERGE_SHA"`, then:

```bash
jq -e '[.jobs[] | select((.name | test("primary-|fallback-| / reduce$")) and .conclusion != "skipped")] | length == 0' \
  "$HOME/adw-phase5-evidence/$CHECK_RUN/run.json" >/dev/null
```

Expected: reconcile-only graph, all provider/reduce jobs skipped, no provider assessment, exact current head, complete receipt.

- [ ] **Step 5: Prove current-head App review evidence remains exact**

```bash
for pr in 150 163 165 166; do
  head=$(gh pr view "$pr" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
  gh api --paginate "repos/bugabinga/smith/issues/$pr/comments?per_page=100" |
    jq -e --arg head "$head" '
      [.[] | select(
        .user.id == 306488075 and
        .user.login == "agent-smith-bugabinga-adc[bot]" and
        ((.body | startswith("Review: " + $head + "\nVERDICT: reviewed")) or
         (.body | startswith("Security review: " + $head + "\nVERDICT: security-cleared")) or
         (.body | test("smith:review-evidence/v1 .*head=" + $head + ".*conclusion=approve"))))]
      | length >= 2' >/dev/null
done
```

Expected: each PR has two exact current-head App evidence records accepted by legacy import or native MJS format; stale-head evidence does not count.

### Task 15: Reconcile #150/#163/#165/#166 and observe two schedule cycles

**Files:** none

- [ ] **Step 1: Verify no blocked/behind PR auto-merged during proof**

```bash
for pr in 150 163 165 166; do
  gh pr view "$pr" --repo bugabinga/smith \
    --json number,state,mergedAt,headRefOid,mergeStateStatus,url
 done | jq -s '.' > "$HOME/adw-phase5-evidence/post-proof-prs.json"
jq -e 'all(.[]; .state == "OPEN" and .mergedAt == null)' \
  "$HOME/adw-phase5-evidence/post-proof-prs.json"
```

Expected: all four remain open; MJS reported their organic blocked/behind state and never auto-merged them.

- [ ] **Step 2: Wait for first natural six-hour reconciliation schedule**

Select the first `schedule` run of `adw-maintenance.yml` after `MERGE_SHA` whose run name/lane is `maintenance-reconcile` (`7 */6 * * *`). Do not use manual dispatch as a schedule substitute.

```bash
set -euo pipefail
CYCLE1_DEADLINE=$(( $(date -d "$QUIET_START" +%s) + 7 * 3600 ))
CYCLE1=
while test -z "$CYCLE1"; do
  test "$(gh api repos/bugabinga/smith/commits/main --jq .sha)" = "$MERGE_SHA"
  CYCLE1=$(gh run list --repo bugabinga/smith --workflow adw-maintenance.yml \
    --event schedule --limit 50 --json databaseId,createdAt,headSha,displayTitle |
    jq -er --arg start "$QUIET_START" '
      [.[] | select(.createdAt >= $start and .displayTitle == "ADW maintenance 7 */6 * * *")]
      | sort_by(.createdAt) | first | .databaseId // empty') || true
  test -n "$CYCLE1" && break
  test "$(date +%s)" -lt "$CYCLE1_DEADLINE"
  sleep 300
done
[[ $CYCLE1 =~ ^[1-9][0-9]*$ ]]
test "$(gh run view "$CYCLE1" --repo bugabinga/smith --json headSha --jq .headSha)" = "$MERGE_SHA"
gh run watch "$CYCLE1" --repo bugabinga/smith --exit-status
```

Expected: success at then-current main head; provider-free artifact set and complete receipt.

- [ ] **Step 3: Wait for the next consecutive six-hour reconciliation schedule**

```bash
set -euo pipefail
CYCLE1_CREATED=$(gh run view "$CYCLE1" --repo bugabinga/smith --json createdAt --jq .createdAt)
CYCLE2_DEADLINE=$(( $(date -d "$QUIET_START" +%s) + 13 * 3600 ))
CYCLE2=
while test -z "$CYCLE2"; do
  test "$(gh api repos/bugabinga/smith/commits/main --jq .sha)" = "$MERGE_SHA"
  CYCLE2=$(gh run list --repo bugabinga/smith --workflow adw-maintenance.yml \
    --event schedule --limit 50 --json databaseId,createdAt,headSha,displayTitle |
    jq -er --arg after "$CYCLE1_CREATED" '
      [.[] | select(.createdAt > $after and .displayTitle == "ADW maintenance 7 */6 * * *")]
      | sort_by(.createdAt) | first | .databaseId // empty') || true
  test -n "$CYCLE2" && break
  test "$(date +%s)" -lt "$CYCLE2_DEADLINE"
  sleep 300
done
[[ $CYCLE2 =~ ^[1-9][0-9]*$ ]]
test "$CYCLE2" != "$CYCLE1"
test "$(gh run view "$CYCLE2" --repo bugabinga/smith --json headSha --jq .headSha)" = "$MERGE_SHA"
gh run watch "$CYCLE2" --repo bugabinga/smith --exit-status
```

Expected: second consecutive natural cycle succeeds within 13 hours of quiet-window start; no intervening failed/cancelled reconciliation schedule and main remains exactly `MERGE_SHA`. Deadline or main-head failure triggers rollback rather than synthetic dispatch.

- [ ] **Step 4: Capture both cycles and recheck no dual writers**

Run `capture_run "$CYCLE1" provider-free "$MERGE_SHA"` and `capture_run "$CYCLE2" provider-free "$MERGE_SHA"`. Then:

```bash
for run in "$CYCLE1" "$CYCLE2"; do
  dir="$HOME/adw-phase5-evidence/$run/download"
  test -z "$(find "$dir" -maxdepth 1 -type d -name 'adw-assessment-*' -print)"
  jq -e '.authority.name == "reconciler" and .status == "complete"' \
    "$dir"/adw-apply-result-1/result.json >/dev/null
done
CYCLE2_CREATED=$(gh run view "$CYCLE2" --repo bugabinga/smith --json createdAt --jq .createdAt)
test "$(gh run list --repo bugabinga/smith --workflow adw-maintenance.yml \
  --event schedule --limit 50 --json databaseId,createdAt,displayTitle,conclusion |
  jq --arg first "$CYCLE1_CREATED" --arg second "$CYCLE2_CREATED" '
    [.[] | select(.createdAt >= $first and .createdAt <= $second and
                  .displayTitle == "ADW maintenance 7 */6 * * *" and
                  .conclusion != "success")] | length')" = 0
test "$(gh api repos/bugabinga/smith/commits/main --jq .sha)" = "$MERGE_SHA"
gh workflow list --repo bugabinga/smith --all --json path,state \
  --jq '.[] | select(.state == "active" and (.path | startswith(".github/workflows/adw-"))) | .path' \
  | sort
```

Expected: both cycles provider-free and complete; active inventory remains exactly the four MJS/self-test files.

- [ ] **Step 5: Final current-head and blocked/behind assertions**

Re-run Task 12 Step 4, Task 14 Step 5, and Task 15 Step 1. Expected: exact current-head App evidence/checks remain valid, all four PRs remain open, and no receipt contains an `arm_auto_merge` for a blocked/behind PR.

### Task 16: Publish evidence and close the quiet window

**Files:** none; post evidence to the already-merged cutover PR

- [ ] **Step 1: Build a redacted evidence manifest**

```bash
EVIDENCE_ROOT="$HOME/adw-phase5-evidence"
ACTIVE_ADW=$(gh workflow list --repo bugabinga/smith --all --json path,state |
  jq -r '.[] | select(.state == "active" and (.path | startswith(".github/workflows/adw-"))) | .path' | sort)
test "$ACTIVE_ADW" = $'.github/workflows/adw-issues.yml\n.github/workflows/adw-maintenance.yml\n.github/workflows/adw-pulls.yml\n.github/workflows/adw-selftest.yml'
mapfile -t decisions < <(find "$EVIDENCE_ROOT" -path '*/adw-decision/decision.json' -type f | sort)
test "${#decisions[@]}" -ge 8
for decision in "${decisions[@]}"; do
  jq -e '
    [.operations[] | select(
      .type == "arm_auto_merge" and
      (.prId == "150" or .prId == "163" or .prId == "165" or .prId == "166"))]
    | length == 0
  ' "$decision" >/dev/null
done
find "$EVIDENCE_ROOT" -mindepth 2 -maxdepth 2 -name run.json -print0 |
while IFS= read -r -d '' run; do
  jq -c '{databaseId,url,event,headSha,status,conclusion}' "$run"
done | jq -s 'sort_by(.databaseId)' > "$EVIDENCE_ROOT/runs.json"
rm -f "$EVIDENCE_ROOT/evidence.SHA256SUMS"
find "$EVIDENCE_ROOT" -type f ! -name evidence.SHA256SUMS -print0 |
  sort -z | xargs -0 sha256sum > "$EVIDENCE_ROOT/evidence.SHA256SUMS"
sha256sum --check "$EVIDENCE_ROOT/evidence.SHA256SUMS"
```

Expected: manifest contains only IDs, URLs, SHAs, outcomes, artifact metadata, and hashes—no secret values, provider credential content, or raw private logs.

- [ ] **Step 2: Post the exact proof summary to the cutover PR**

Post one owner comment containing:

```text
cutover squash SHA and Verified result
signed rollback SHA/branch and verify-commit result
legacy disabled/drained count (21 workflows, zero active runs)
active ADW inventory (three MJS wrappers plus self-test)
manual audit and reconcile run URLs
Codex triager and Claude steerer run URLs
review-comment and check reconcile-only run URLs
both natural schedule-cycle run URLs
artifact IDs/names and receipt status for every run
APP bot ID/login evidence
#150/#163/#165/#166 exact heads, merge states, App evidence/check IDs, and open status
label drift repair result and settings/ruleset drift report URL
statement that no secret was rotated and no malformed/stale/failure/partial production injection occurred
```

Use `gh pr comment "$PR" --repo bugabinga/smith --body-file <generated-redacted-summary>`.

- [ ] **Step 3: Close quiet window only after owner acceptance**

Owner comments acceptance on the evidence. Normal main merges may resume. Keep `fix/rollback-adw-mjs-phase5` until Phase 6 explicitly retires it.

Expected: Phase 5 complete; Phase 6 remains separate.

## Rollback triggers and exact procedure

Trigger rollback immediately on any of:

- any active legacy writer after MJS activation;
- any operational ADW writer outside the three MJS wrappers;
- App token mint failure from `APP_ID`/private key or unexpected minted permission;
- provider job with forge credential, apply job with provider credential, or secret in log/artifact;
- malformed/missing artifact, sidecar mismatch, incomplete/failed receipt, stale write reaching mutation, or duplicate operation digest;
- current-head `check`/`merge-gate` or App evidence bound to a different head/actor;
- review-comment/check path executing a provider;
- #150/#163/#165/#166 auto-merging while blocked/behind;
- settings/ruleset mutation;
- unbounded provider recursion from label/App comments;
- either required schedule cycle missing, failing, cancelling, or running on unexpected control SHA;
- any need to rotate a production secret or manufacture a failure to continue proof.

Rollback from the owner shell:

```bash
set -euo pipefail
for workflow in adw-issues.yml adw-pulls.yml adw-maintenance.yml; do
  gh workflow disable "$workflow" --repo bugabinga/smith
done
for workflow in adw-issues.yml adw-pulls.yml adw-maintenance.yml; do
  gh api --paginate \
    "repos/bugabinga/smith/actions/workflows/$workflow/runs?per_page=100" \
    --jq '.workflow_runs[] | select(.status != "completed") | .id'
done | sort -u |
while read -r run; do test -z "$run" || gh run cancel "$run" --repo bugabinga/smith; done
while gh run list --repo bugabinga/smith --limit 100 \
  --json workflowName,status \
  --jq '[.[] | select((.workflowName | startswith("ADW")) and .status != "completed")] | length' \
  | grep -qv '^0$'; do sleep 15; done
git fetch origin main fix/rollback-adw-mjs-phase5
ROLLBACK_SHA=$(git rev-parse origin/fix/rollback-adw-mjs-phase5)
test "$(git rev-parse "$ROLLBACK_SHA^")" = "$(git rev-parse origin/main)"
git verify-commit "$ROLLBACK_SHA"
git push origin "$ROLLBACK_SHA:refs/heads/main"
for workflow in \
  adw-alerts.yml adw-automerge.yml adw-build.yml adw-codex-build.yml \
  adw-codex-review.yml adw-comment.yml adw-deps.yml adw-docs.yml \
  adw-doctor.yml adw-gate.yml adw-intake.yml adw-jam-detector.yml \
  adw-labels.yml adw-pioneer.yml adw-plan.yml adw-review.yml \
  adw-revise.yml adw-settings-audit.yml adw-survey.yml adw-sweep.yml; do
  gh workflow enable "$workflow" --repo bugabinga/smith
done
gh workflow disable adw-release.yml --repo bugabinga/smith
```

Expected: signed fast-forward rollback lands directly through owner bypass; MJS is disabled/drained first; restored legacy writers are enabled only afterward; `adw-release` remains disabled because replacement is deferred. Record irreversible forge effects honestly; rollback prevents new MJS writes and legacy reconciliation repairs compatible state.

## Phase boundary

Phase 5 ends with one GitHub-verified squash decision on main, three MJS operational wrappers plus self-test, no legacy writer or shell reducer, release automation still deferred, signed rollback available, positive production receipts captured, #150/#163/#165/#166 still open while blocked/behind, and two consecutive scheduled reconciliation cycles green. Legacy marker compatibility, long-term docs, rollback-branch retirement, and backlog cleanup remain Phase 6.
