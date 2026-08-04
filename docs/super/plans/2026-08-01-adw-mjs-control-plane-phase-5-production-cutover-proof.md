# ADW MJS Production Cutover and Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically make the three MJS wrappers the sole production ADW writers and prove their positive behavior on production without destructive failure injection.

**Architecture:** The final protected PR carries the already-completed Phase 4 control plane, production-adapted byte-identical wrappers, assessment-only charters, and removal of every legacy writer. Before the squash merge, the owner seeds the existing App identity, disables and drains legacy workflows, and rehearses a signed rollback; after merge, all writes pass through operation-scoped App tokens and the `adw-write` repository-wide lock while production evidence is captured from positive runs only. The prepared rollback is usable only while `main` remains at the cutover SHA; rollback after later main movement creates a new signed child of current main by applying the exact reverse cutover patch without rewriting history. GitHub concurrency is not a FIFO queue, so cancelled pending apply is recovered by reconciliation and never treated as success.

**Tech Stack:** Node.js ESM/`node:test`, GitHub Actions, pinned Actions, `gh`, `git`, `jq`, `yq`, exact-pinned Claude/Codex CLIs.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 5: Atomic Production Cutover

---

## Owner decision and supersession

The owner explicitly approved this production path on 2026-08-01 and authorized a quiet-window cutover. Phase 4 Tasks 1–6 remain completed prerequisite work. Phase 4 Tasks 7–8 remain unchecked and are **superseded**, not completed: no disposable repository will be created, no production secret will be rotated, and no live failure will be manufactured. Their failure/retry claims remain supported by the offline `node:test` evidence from Tasks 1–6; the positive write path is proved on production in this phase.

The owner also approved App-authenticated `repository_dispatch` for the five internal reconciliation intents. Those intents use a closed event-type/payload contract and the fixed repository-dispatch writer; `workflow_dispatch` is reserved exclusively for owner-invoked maintenance `audit` and `reconcile` lane choices. Internal authority is never represented as manual workflow inputs.

This is exactly one Phase 5. It ends only after the atomic cutover, positive production proof, and two consecutive scheduled reconciliation cycles. Phase 6 compatibility removal, operational-document cleanup, and unrelated backlog work remain out of scope.

On 2026-08-01, the owner approved the first offered authorization route: current `bugabinga` authentication may author the cutover PR. GitHub prohibits author self-approval, so an immutable exact-head owner approval comment bound by REST to numeric owner ID `876467` and login `bugabinga`, together with confirmed ruleset bypass, replaces the impossible review object. Administrative squash remains gated by the unchanged head, required checks, final legacy drain, and quiet-window controls.

On 2026-08-02, the owner authorized administrative squash of PR #150 at exact head `146c5467cd6b87d1ae3ef10f116b075f5910a94e`. Owner `bugabinga` merged it at `2026-08-02T09:44:16Z` as GitHub-verified squash `d1be190b81abf9f5a874ca1e3ed8c1f310d96ec9` (`verification.reason: valid`). This is a pre-cutover product disposition: it advances the main baseline and cutover base, removes #150 from live proof targets, and neither starts the quiet-main interval nor satisfies the later PR #167 cutover merge.

## Locked safety boundaries

- Production repository is exactly `bugabinga/smith`; default branch is exactly `main`.
- Existing secret `APP_ID` is the App ID used by `actions/create-github-app-token`. `APP_CLIENT_ID` is absent and the private App client ID is unavailable; no task may add, infer, request, or substitute `APP_CLIENT_ID`.
- Existing secrets `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `CODEX_AUTH_JSON` are presence-checked only. Their values are never read, printed, copied, replaced, or rotated.
- `ADW_CUTOVER_HOLD=true` permanently contains orphaned workflows at the corrupted `.github/workflows/adw-maintenance.yml` identity. It is never deleted or set false. Current wrappers use only the independent exact barrier `ADW_MJS_CUTOVER_HOLD`; that variable must be armed before the first branch push exposing the renamed candidate records and remains armed through every corrective push and cutover until the parent-correct signed rollback exists.
- Seed exact non-secret variables `APP_BOT_USER_ID=306488075` and `APP_BOT_LOGIN=agent-smith-bugabinga-adc[bot]` before cutover.
- Internal App intents use only `repository_dispatch` event types `retry_route`, `fallback_route`, `retry_pioneer`, `run_review`, and `run_obligation`; manual `workflow_dispatch` exposes only owner choices `audit` and `reconcile`. `dispatch_repository` retains `contents:write` plus exact snapshot read permissions so every named precondition can be re-read immediately before delivery. Each reconciliation decision contains at most one asynchronous operation: a `rerun_check` has exact Actions/Checks write authority, while dispatch exposes no Actions mutation.
- Production proof is positive-only. Never inject malformed artifacts, stale revisions, cancelled jobs, partial writes, invalid credentials, changed permissions, malformed events, provider outages, ruleset damage, or secret rotation.
- Existing organic `BEHIND` state on still-open PRs #163, #165, and #166 is observed, never created or worsened for this proof. Only live explicit `BEHIND`/`DIRTY`, draft, ADW holds/evidence, or native protection may block merge.
- Settings/rulesets remain read-only. Audit may report their existing drift but may not mutate it. Label sync may repair only checked-in label definitions through the closed `sync_labels` operation.
- `pull_request_review_comment` and `check_run`/`check_suite` remain reconcile-only. Their proof runs contain no provider assessment artifact and no provider job execution.
- No legacy and MJS operational writer may be enabled simultaneously. `adw-selftest` is non-writing and remains enabled. `adw-release` is disabled and receives no replacement because release automation remains deferred.
- The owner keeps main otherwise quiet from the final head check until both scheduled cycles finish. For any further retry, the strict `main == MERGE_SHA` quiet-main invariant starts only when its new protected PR lands. The PR #167, PR #168, PR #170, PR #171, PR #172, PR #173, PR #175, PR #176, and PR #177 cutovers and rollbacks are historical evidence and do not satisfy or start another retry interval. Any subsequent unexpected main movement invalidates current-head evidence, stops proof, and triggers rollback from the new current main; it never authorizes force-push or reset.
- Every branch commit is signed when the executor can sign. The protected PR still lands as one GitHub-verified squash commit, satisfying `docs/PROJECT-INVARIANTS.md` §7.

## First-attempt production baseline

The first-attempt pre-cutover baseline, revalidated read-only on 2026-08-02, was:

- `origin/main` and the cutover base: `d1be190b81abf9f5a874ca1e3ed8c1f310d96ec9`.
- The candidate branch contains that main through signed merge commit `6711c32b8aef6a7f0ee23663ec85ee8593489080`; revalidate the final remote PR head after the required corrective push.
- Candidate tip after Phase 4 Task 6: `e29f484b475f353e1db897c74660fb5316f120a3`.
- Secrets present: `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`.
- Repository variables absent in the original snapshot; the exact App bot variables were subsequently seeded and revalidated.
- App bot identity already observed on forge records: numeric user ID `306488075`, login `agent-smith-bugabinga-adc[bot]`.
- Main ruleset ID `19155559`; squash-only and signed commits are active; required contexts are `check` and `merge-gate`. PR #167 requires a current-head `check` and confirmed owner administrative bypass if the deleted legacy workflow cannot publish `merge-gate`; the plan never pretends that context exists.
- Live ruleset has organic drift from `.github/rulesets/main.json`: live strict required checks are `true` and include `do_not_enforce_on_create:true`, while checked-in policy says strict `false` and omits that field.
- Live label `urgent` has organic color drift (`ededed` live versus `e03131` checked in).
- PR #163 head `1b1891ee0000c817891fdcc963d778c030e5a74d` is open and REST `mergeable_state` is `behind`.
- PR #165 head `adf17c538ff655d8fb065a848bdc1f499622d482` is open and REST `mergeable_state` is `behind`.
- PR #166 head `9b3e822ef7eef3563fa22b57daa6ced68520f676` is open and REST `mergeable_state` is `behind`.
- All three still-open proof PRs have current-head legacy App review evidence. Their explicit behind states remain fail-closed.

Historical rationale is retained: on 2026-08-01, PR #150 at head `146c5467cd6b87d1ae3ef10f116b075f5910a94e` was open with composite `BLOCKED`; all four then-open PRs had current-head legacy App evidence. Because missing `merge-gate` could itself produce `BLOCKED`, that status never proved an independent blocker, which is why the original plan required owner disposition before live audit. The exact-head owner squash above is that disposition, not post-cutover proof.

At execution, re-read every live target. A changed SHA or merge state is not a reason to inject state. If #163, #165, or #166 is no longer organically open and behind/dirty, stop that assertion and ask the owner for another natural candidate; do not make one.

### Actual pre-hold execution record

The initial branch push preceded the required hold. Live Actions evidence was re-read without mutation on 2026-08-01:

- Push run [`30713498516`](https://github.com/bugabinga/smith/actions/runs/30713498516) failed before job creation on the then-unsupported alert trigger grammar and produced zero artifacts.
- Pull review runs [`30713534731`](https://github.com/bugabinga/smith/actions/runs/30713534731) and [`30713540804`](https://github.com/bugabinga/smith/actions/runs/30713540804), plus review-comment runs [`30713534847`](https://github.com/bugabinga/smith/actions/runs/30713534847) and [`30713540946`](https://github.com/bugabinga/smith/actions/runs/30713540946), used feature-branch workflow records at head `2baf202af878a5e18806056f5883b40c5a46addf`. All four pull runs minted App read tokens, then prepare failed on old control `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c` with `command is unsupported`.
- The two review runs incorrectly scheduled fallback jobs after prepare failure, but artifact download failed before either provider command; every apply-token and apply command was skipped. The four pull runs each had zero artifacts and zero writes.
- `ADW_CUTOVER_HOLD=true` was armed at `2026-08-01T19:14:00Z`; the exact App variables were present, and no later candidate operational run existed at validation time. This is containment evidence, not retroactive satisfaction of the first-push gate.

### Production cutover attempts, signed rollbacks, and root causes

The first production cutover did not complete Phase 5:

- PR #167 landed as cutover squash `2a31a5a4c2ae259b2ff51caf3f8b39648bdca114` on 2026-08-02. Manual audit run [`30746446905`](https://github.com/bugabinga/smith/actions/runs/30746446905) failed in prepare on an App-authenticated HTTP 404 and produced zero source/snapshot/apply artifacts. No positive audit receipt exists from that attempt.
- MJS was contained and the prepared direct-child rollback landed as `d4dd6c6d0e828c876aab5470e8e80524b6cd7e84`. `git verify-commit d4dd6c6` reports a Good ED25519 signature, its sole parent is `2a31a5a`, and its tree exactly equals pre-cutover baseline `d1be190b81abf9f5a874ca1e3ed8c1f310d96ec9`. This safely restored legacy authority without rewriting history.
- Read-only App probe runs [`30747070695`](https://github.com/bugabinga/smith/actions/runs/30747070695), [`30747221797`](https://github.com/bugabinga/smith/actions/runs/30747221797), and [`30747419140`](https://github.com/bugabinga/smith/actions/runs/30747419140) isolated the first root cause: the App can read open PR #163 files, while merged PR #167 files return 404 after its head branch deletion. The first correction skipped merged details in audit and attempted to recover reconciliation/post-merge paths from the immutable merge commit. The second attempt proved that fallback was not App-readable and it is now superseded.
- Follow-up read-only App probe [`30748610808`](https://github.com/bugabinga/smith/actions/runs/30748610808) exposed the REST merge-setting redaction: the repository response omitted all five merge-setting properties under the read-only App token. The correction reads their exact booleans through one fixed, bounded, closed GraphQL `Repository` selection while retaining REST repository identity and failing closed on malformed GraphQL data.
- Read-only App probe [`30749637033`](https://github.com/bugabinga/smith/actions/runs/30749637033) exposed ruleset redaction: ruleset detail includes all auditable conditions, rules, and rule parameters but omits `bypass_actors`. The correction preserves that omission as unobservable `null`, compares every visible field, and reports expected actors as visibility-limited drift rather than treating redaction as an empty actor list.
- Final read-only App probe [`30766618499`](https://github.com/bugabinga/smith/actions/runs/30766618499) succeeded after those corrections: the auditor completed under the production App and reported the expected visibility-limited bypass-actor drift. The run performed no GitHub mutation.

The retry also did not complete Phase 5:

- PR #168 landed as cutover squash `4cd78089db44306f8a7f9c6855accff0ae5c8c29` at `2026-08-02T21:39:10Z`. Manual audit run [`30768604275`](https://github.com/bugabinga/smith/actions/runs/30768604275) produced source, snapshot, decision, and verification artifacts, then failed at operation 0 while recomputing current revisions. Its failed apply result has zero complete operations and zero receipts; no GitHub write occurred.
- Read-only probe [`30769482565`](https://github.com/bugabinga/smith/actions/runs/30769482565) downloaded those exact artifacts and replayed operation 0 through the record-only writer. It read existing issues, labels, and pulls, then the production App received HTTP 404 for immutable merge commit `4cd78089db44306f8a7f9c6855accff0ae5c8c29`; owner-authenticated REST could read the same commit. The replay emitted no intent, write, or receipt.
- The second-attempt root cause was a mode mismatch: the auditor snapshot intentionally used `mergedDetails=false`, but apply-time `pulls` revision recomputation omitted that argument and defaulted to `true`, entering the merge-commit file fallback before it could compare the revision. The correction preserves `mergedDetails=false` during auditor recomputation, removes every merged-pull files/commit-detail read and the `commitFiles` fallback from App paths, and represents reconciler/provider merged paths as a fixed bounded unavailability value with `changedPaths=[]`. Closing-issue GraphQL authority and the merge SHA remain available.
- MJS was contained again and direct-child rollback `2f3d9c98b9f678139b0f8cd2e671afde16ffbc98` landed over `4cd78089db44306f8a7f9c6855accff0ae5c8c29`. `git verify-commit 2f3d9c9` reports a Good ED25519 signature, and its tree exactly equals the first signed rollback `d4dd6c6d0e828c876aab5470e8e80524b6cd7e84`, restoring legacy authority without history rewriting.
- Exact-operation probe run [`30771214058`](https://github.com/bugabinga/smith/actions/runs/30771214058) was isolated after every legacy writer was disabled. It replayed the captured `report_drift` operation with the production App, completed, and created App-authored drift issue #169. That isolated write proves the failed audit stopped in merged-commit revision recomputation rather than issue delivery; it is diagnostic mutation evidence, not a complete cutover or audit receipt.
- Inspection of #169 exposed a third prerequisite: `report_drift` had replaced its durable `smith:settings-drift/v1` semantic marker with a decision-specific apply marker for matching. A later control SHA would therefore miss the exact semantic report and create duplicate drift issues. The correction keeps semantic marker and semantic body as the idempotency authority across retry/control SHA, accepts #169 after stripping only its validated trailing apply marker, rejects conflicting semantic content as stale, and omits decision-specific markers from new drift bodies.

The third attempt also did not complete Phase 5:

- Owner-authored PR #170 landed as GitHub-verified cutover squash `7ec4fbf0e89e498d679a8e2f8dfd9feaf70f470e` at `2026-08-03T00:12:17Z`.
- Manual audit run [`30775063472`](https://github.com/bugabinga/smith/actions/runs/30775063472) reached apply and produced a partial receipt: operation 0 `report_drift` completed, then operation 1 `sync_labels` failed. This is one completed drift receipt followed by a failed label operation, not a complete audit receipt.
- Exact App probe run [`30775537057`](https://github.com/bugabinga/smith/actions/runs/30775537057) replayed the `urgent` PATCH shape and received HTTP 422. The checked-in `urgent` description was 148 Unicode characters, beyond GitHub's 100-character label-description limit, while both trusted label parsers incorrectly permitted 4096. The correction bounds API-safe trusted label definitions to 100 Unicode characters before mutation and shortens the description to `Time-critical work; planner ranks it before equal- or lower-priority backlog items.`
- MJS was contained and signed direct-child rollback `58ff44b186d7ffa5c2d5530ca089ee925b29d4a1` landed over `7ec4fbf0e89e498d679a8e2f8dfd9feaf70f470e`. `git verify-commit 58ff44b` reports a Good ED25519 signature, and its tree exactly equals second rollback `2f3d9c98b9f678139b0f8cd2e671afde16ffbc98`, restoring legacy authority without rewriting history.
- Corrected exact App label probe run [`30776357596`](https://github.com/bugabinga/smith/actions/runs/30776357596) succeeded. Its post-write App GET bound the live `urgent` post-state to color `e03131` and the exact 83-character description `Time-critical work; planner ranks it before equal- or lower-priority backlog items.` This is positive repaired-label prerequisite evidence for a fourth retry only; it does not establish deployment, cutover, a complete audit receipt, or Phase 5 completion. Failed run `30775537057` remains immutable HTTP 422 diagnosis evidence.
- Temporary `.github/workflows/p38-adw-label-write-probe.yml` was then permanently deleted under promote-or-delete; it is not production authority or a retained workflow.

The fourth attempt for PR #171 produced a complete audit receipt but ended in signed rollback and did not complete Phase 5:

- Owner-authored PR #171 at exact signed head `e0d351da4c96ad5020155a303a436a54746345f2` landed as cutover squash `e91e4a17d447dc5f18417f77907e77088d955356` at `2026-08-03T07:33:28+02:00`.
- Manual audit run [`30787720045`](https://github.com/bugabinga/smith/actions/runs/30787720045) succeeded with a complete receipt. This is positive audit evidence from the fourth cutover, but does not complete Phase 5 without reconciliation and two consecutive scheduled cycles.
- Manual reconciliation run [`30788000713`](https://github.com/bugabinga/smith/actions/runs/30788000713) failed in prepare before any artifacts with `operational pull run entity is malformed`. No reconciliation decision, apply operation, write, or receipt occurred.
- The root cause was a false recovery identity invariant in `adw/github.mjs`: `cancelledApplyEvidence` required `run.name === run.displayTitle`. GitHub REST returns workflow name `ADW pull and reconcile triggers` in `name` and run-name `ADW pull #167` in `display_title`; the committed `30713540804` fixture incorrectly made both fields `ADW pull #167`.
- MJS was contained and signed direct-child rollback `64a4515225f8f988989d38e21657bde97177202b` restored legacy authority over cutover `e91e4a17d447dc5f18417f77907e77088d955356`. `git verify-commit 64a4515` reports a Good ED25519 signature, and its tree exactly equals signed third rollback `58ff44b186d7ffa5c2d5530ca089ee925b29d4a1`; `adw-release` remains disabled.
- Pre-cutover reconciliation probe [`30790255777`](https://github.com/bugabinga/smith/actions/runs/30790255777) then failed read-only prepare in `cancelledApplyEvidence` with `operational run identity is malformed`. The exact workflow-run endpoint included historical failed pregraph run [`30713498516`](https://github.com/bugabinga/smith/actions/runs/30713498516), whose REST `name` is `.github/workflows/adw-maintenance.yml` rather than current canonical workflow name `ADW maintenance triggers`. Such endpoint records are forge history candidates, not current workflow authority.
- Exact reconciliation read probe [`30793832261`](https://github.com/bugabinga/smith/actions/runs/30793832261) subsequently succeeded at corrected signed head `d6018155bfb85afaceac961c2af2d80d87a9958d` after noncanonical historical workflow runs were filtered before candidate inspection. The run was read-only while signed fourth rollback `64a4515225f8f988989d38e21657bde97177202b` retained legacy authority; no GitHub mutation occurred.

The fifth attempt for PR #172 reached audit writes but ended in signed rollback and did not complete Phase 5:

- Owner-authored PR #172 landed as fifth cutover squash `2917520ee4842a8dbc9e57cce829a51710e5acff` over signed fourth rollback `64a4515225f8f988989d38e21657bde97177202b`.
- Audit retry run [`30798105635`](https://github.com/bugabinga/smith/actions/runs/30798105635) attempt 1 produced a canonical partial receipt: operation 0 `report_drift` completed, operation 1 completed the failing `publish_check` for PR #163, operation 2, the PR #165 `publish_check`, failed, and operation 3 remained pending. The two complete receipts are durable fifth-attempt write evidence; the run is not success.
- `gh run rerun --failed 30798105635` created attempt 2. Before any apply operation, prior-receipt loading failed with `prior apply result entry is invalid`. Live logs prove pinned `actions/download-artifact` received a single `adw-apply-result-*` pattern match and extracted `result.json` plus `result.sha256` directly into `previous-apply-results`, not beneath `adw-apply-result-1/`; the loader accepted only attempt-named directories.
- MJS was contained and signed direct-child rollback `6c9a656c66b38b8bf4771ad47a79fab8bd617bba` restored legacy authority over fifth cutover `2917520ee4842a8dbc9e57cce829a51710e5acff`. `git verify-commit 6c9a656` reports a Good ED25519 signature, and its tree exactly equals signed fourth rollback `64a4515225f8f988989d38e21657bde97177202b`; `adw-release` remains disabled.
- Apply-resume probe run [`30801002050`](https://github.com/bugabinga/smith/actions/runs/30801002050) failed with the old `prior apply result entry is invalid` parser error before any resumed operation. The probe deliberately downloaded the exact source artifact retained by fifth-attempt run `30798105635`; that immutable artifact is bound to old control `2917520ee4842a8dbc9e57cce829a51710e5acff` and necessarily contains the old parser. The failure proves immutable transport prevents a later branch correction from retroactively repairing old source, not that the corrected parser fails or succeeds. It is not live evidence for the new parser and produced no GitHub write.

The sixth attempt for PR #173 completed two audits, then correctly failed stale during reconciliation and ended in signed rollback:

- Owner-authored PR #173 landed as sixth cutover squash `57361a625096b392299f7f2861d5d7b24db16d3f` over signed fifth rollback `6c9a656c66b38b8bf4771ad47a79fab8bd617bba`.
- Manual audit runs [`30849959379`](https://github.com/bugabinga/smith/actions/runs/30849959379) and [`30850408903`](https://github.com/bugabinga/smith/actions/runs/30850408903) succeeded while the natural behind candidates remained fail-closed. They are positive sixth-attempt audit evidence, not reconciliation or scheduled-cycle proof.
- Reconciliation run [`30850775894`](https://github.com/bugabinga/smith/actions/runs/30850775894) attempt 1 emitted eight canonically ordered `dispatch_repository` operations. Operation 0 delivery completed. Its forge-native child workflow then progressed and changed the globally named `runs` projection outside operation 0's predecessor revision, so operation 1 correctly failed stale rather than weakening the global precondition.
- Failed-job rerun attempt 2 proved the corrected flat prior-receipt parser live by restoring operation 0's receipt. It then correctly failed stale again because the child progression remained outside the predecessor revision. This proves receipt recovery and the precondition; it does not prove a complete reconciliation.
- Signed direct-child rollback `6538fd7cc4ad1a97c64a87539273c55469f51cd8` restored the exact legacy tree after sixth cutover `57361a625096b392299f7f2861d5d7b24db16d3f`. `git verify-commit 6538fd7` reports a Good ED25519 signature; legacy authority is restored and `adw-release` remains disabled.
- Root cause is decision granularity: one deterministic reconciliation decision admitted multiple asynchronous operations, although each delivered child can advance the globally preconditioned run projection. The correction emits at most one asynchronous operation per decision, retaining canonical order, retry-before-dispatch priority, all held intents, and safe synchronous operations. It does not weaken preconditions, ignore workflow-run changes, batch dispatches, or add a queue or database.

The seventh attempt for PR #175 had no observed control defect, but forge scheduling failed safely and it ended in signed rollback:

- Owner-authored PR #175 landed as GitHub-verified seventh cutover squash `737402d1de1ce57cbdcd8553c3a9829f91be4847` over signed sixth rollback `6538fd7cc4ad1a97c64a87539273c55469f51cd8`.
- Owner-dispatched audit run [`30854346376`](https://github.com/bugabinga/smith/actions/runs/30854346376) remained `queued` for more than 30 minutes with zero jobs and zero artifacts. Normal cancellation and force cancellation both returned GitHub HTTP 500; DELETE returned HTTP 403. No control-plane job started and no MJS write occurred.
- MJS wrappers were disabled and contained while `ADW_CUTOVER_HOLD=true`. Signed direct-child rollback `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c` restored the exact legacy tree over cutover `737402d1de1ce57cbdcd8553c3a9829f91be4847`; `git verify-commit db80fd4` reports a Good ED25519 signature, and `adw-release` remains disabled.
- Workflow record `325210492` is deleted, but run `30854346376` remains queued. Its exact run, jobs, artifacts, and SHA256 manifest are retained under `~/.local/state/smith-adw-phase5-retry6/queued-30854346376`; the captured jobs and artifacts counts are both zero.
- This is a forge queue/control-record failure, not evidence of an MJS control defect or positive audit execution. The corrupted identity is now permanently contained by `ADW_CUTOVER_HOLD=true`; later retries do not wait for or mutate that orphan.

The eighth attempt for PR #176 also failed safely at the corrupted workflow identity and ended in signed rollback:

- Owner-authored PR #176 landed as eighth cutover squash `91aff7927e17cc5d84288455ea336512c255a7df` over signed seventh rollback `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c`.
- Owner-dispatched run [`30859128166`](https://github.com/bugabinga/smith/actions/runs/30859128166) remains queued with zero jobs and zero artifacts alongside old run [`30854346376`](https://github.com/bugabinga/smith/actions/runs/30854346376). Cancellation and force cancellation return HTTP 500; DELETE returns HTTP 403. Neither run started MJS or wrote to GitHub.
- Workflow identity `325210492` at historical path `.github/workflows/adw-maintenance.yml` is corrupted. It and both queued runs are treated as immutable orphaned forge state, not current workflow authority.
- Signed direct-child rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817` restored the exact legacy tree over eighth cutover `91aff7927e17cc5d84288455ea336512c255a7df`. `git verify-commit 3e91aac` reports a Good ED25519 signature; its tree equals signed seventh rollback `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c`.
- Fresh held-path probe [`30859241539`](https://github.com/bugabinga/smith/actions/runs/30859241539) completed `skipped` with no job execution under a distinct workflow identity. The temporary probe was then deleted at clean tree `44a0393`; this proves fresh-path scheduling and hold evaluation only, not cutover or positive production behavior.

The ninth attempt for PR #177 produced a complete audit and reconciliation delivery receipt, but its dispatched Claude reviewer failed before artifact creation and the attempt ended in signed rollback:

- Owner-authored PR #177 landed as GitHub-verified ninth cutover squash `7497f61b712d24a056b32fae3c2e5b4be3a01d98` over signed eighth rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`.
- Owner-dispatched audit run [`30884816241`](https://github.com/bugabinga/smith/actions/runs/30884816241) succeeded with a complete receipt. Owner-dispatched reconciliation run [`30884990977`](https://github.com/bugabinga/smith/actions/runs/30884990977) also completed its single `dispatch_repository` operation and receipt.
- Dispatched Claude reviewer child [`30885142692`](https://github.com/bugabinga/smith/actions/runs/30885142692) exited before producing an assessment artifact. The reconciliation receipt proves dispatch delivery only; it does not prove the failed child obligation or complete Phase 5.
- MJS was contained and signed direct-child rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd` restored the exact legacy tree over ninth cutover `7497f61b712d24a056b32fae3c2e5b4be3a01d98`. `git verify-commit 9a5d2ca` reports a Good ED25519 signature, and its tree exactly equals signed eighth rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`.
- Diagnostic runs [`30886814052`](https://github.com/bugabinga/smith/actions/runs/30886814052) and [`30887204135`](https://github.com/bugabinga/smith/actions/runs/30887204135) proved the pinned CLI effort contract and `xhigh`; [`30887382006`](https://github.com/bugabinga/smith/actions/runs/30887382006) proved model `claude-opus-4-8`, `xhigh`, and OAuth together.
- Exact-snapshot diagnostics [`30888153701`](https://github.com/bugabinga/smith/actions/runs/30888153701) and [`30888436716`](https://github.com/bugabinga/smith/actions/runs/30888436716) isolated pinned Claude's rejection of only the explicit draft-2020 `$schema`. Exact no-forge reviewer snapshot replay [`30889239515`](https://github.com/bugabinga/smith/actions/runs/30889239515) then completed `invoke=success` after removing only that declaration; the closed schema and semantic validation remain.
- Temporary Claude classifier workflows and `adw/test/live-claude-classify-probe.mjs` are deleted under promote-or-delete and are not production authority or shipped files. The successful diagnostic replay is retry-prerequisite evidence, not production completion.

**Current prerequisite and probe status:** Phase 5 remains incomplete and all nine cutovers are rolled back. Earlier disposable probes, temporary `.github/workflows/p38-adw-issue-write-probe.yml`, `adw/test/live-apply-record-probe.mjs`, and the ninth-attempt Claude classifiers remain deleted under promote-or-delete. Fourth-, fifth-, sixth-, and ninth-attempt positive/partial receipts remain historical evidence; runs `30854346376` and `30859128166` remain immutable queue evidence at the corrupted old identity. A corrected retry remains required; no scheduled-cycle proof and no Phase 5 completion exist.

## Current post-rollback baseline

Current `origin/main` is signed ninth rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd`, whose sole parent is ninth cutover `7497f61b712d24a056b32fae3c2e5b4be3a01d98` and whose tree exactly equals signed eighth rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`, restoring the legacy baseline. `ADW_CUTOVER_HOLD=true` remains permanently armed for orphaned old workflow identities; legacy writers are active except deferred `adw-release`, which remains disabled. The prior retry used owner-authored PR #168 from `adw/mjs-phase5-retry`, based on first rollback `d4dd6c6d0e828c876aab5470e8e80524b6cd7e84`, and landed as cutover `4cd78089db44306f8a7f9c6855accff0ae5c8c29`; signed aggregate commit `f79462666647a0c504479f68fe4083050d9e5f9d` remains historical implementation provenance, not current deployment evidence.

The rolled-back third attempt used owner-authored PR #170 from `adw/mjs-phase5-retry2`, based on signed second rollback `2f3d9c98b9f678139b0f8cd2e671afde16ffbc98`, and landed as cutover `7ec4fbf0e89e498d679a8e2f8dfd9feaf70f470e`; signed aggregate commit `273dda4cd2a9dc77fc2193498886a5badc389895` is its implementation anchor. Those values and all earlier attempts, runs, rollbacks, and probes remain historical evidence.

The rolled-back fourth attempt used owner-authored PR #171 from `adw/mjs-phase5-retry3`, based on signed third rollback `58ff44b186d7ffa5c2d5530ca089ee925b29d4a1`. Signed direct-child aggregate `fe3dfa00029cc588996486386daab7dc791fd27b` and signed plan head `e0d351da4c96ad5020155a303a436a54746345f2` are its implementation anchors. Cutover `e91e4a17d447dc5f18417f77907e77088d955356`, complete audit `30787720045`, failed pre-artifact reconciliation `30788000713`, signed rollback `64a4515225f8f988989d38e21657bde97177202b`, failed read probe `30790255777`, and successful exact read probe `30793832261` are historical execution and retry-prerequisite evidence. Tasks 8–11 completed for that attempt; Task 12 stopped at reconciliation; Tasks 13–16 did not execute, so a fifth retry remained required.

The rolled-back fifth attempt used owner-authored PR #172 from `adw/mjs-phase5-retry4`, based on signed fourth rollback `64a4515225f8f988989d38e21657bde97177202b`. Signed direct-child aggregate `5343ec254bdf63b0e1617ec345a139764f544c02` and signed planning head `b59d8d5293013a0bcbb0f98c25fd3be25983a212` are its implementation anchors. Fifth cutover `2917520ee4842a8dbc9e57cce829a51710e5acff`, partial audit retry `30798105635`, failed attempt-2 recovery, signed rollback `6c9a656c66b38b8bf4771ad47a79fab8bd617bba`, and immutable-old-source failure `30801002050` are historical execution evidence. Run `30801002050` cannot validate the corrected parser because its exact source artifact necessarily contains control `2917520`'s old parser. Tasks 8–11 completed for that attempt; Task 12 stopped at audit recovery; Tasks 13–16 did not execute.

The rolled-back sixth attempt used owner-authored PR #173 from `adw/mjs-phase5-retry5`, based on signed fifth rollback `6c9a656c66b38b8bf4771ad47a79fab8bd617bba`. Signed direct-child aggregate `60d471bab66f6bafc1774281b5bbc6d422250944`, cutover `57361a625096b392299f7f2861d5d7b24db16d3f`, audits `30849959379` and `30850408903`, partial reconciliation `30850775894`, and signed rollback `6538fd7cc4ad1a97c64a87539273c55469f51cd8` are historical evidence.

The rolled-back seventh attempt used owner-authored PR #175 from `adw/mjs-phase5-retry6`, based on signed sixth rollback `6538fd7cc4ad1a97c64a87539273c55469f51cd8`. Signed direct-child aggregate `26283a9015dc44f0f5770f69b3618ba96bf1b1c0`, signed planning head `f1c691984e539f1afd0d2f6569d7ffecf1262ad4`, cutover `737402d1de1ce57cbdcd8553c3a9829f91be4847`, queued audit `30854346376`, deleted workflow record `325210492`, and signed rollback `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c` are historical evidence.

The rolled-back eighth attempt used owner-authored PR #176 from `adw/mjs-phase5-retry7`, based on signed seventh rollback `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c`. Signed aggregate `cb8e61eb900e289263e166a37673e0ea5ccad692`, cutover `91aff7927e17cc5d84288455ea336512c255a7df`, queued run `30859128166`, signed rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`, and fresh held-path probe `30859241539` are historical evidence.

The rolled-back ninth attempt used owner-authored PR #177 from `adw/mjs-phase5-retry8`, based on signed eighth rollback `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`. Signed aggregate `870d77069c9054dd9f040803940df796da3f4a6e`, cutover `7497f61b712d24a056b32fae3c2e5b4be3a01d98`, complete audit `30884816241`, reconciliation delivery receipt `30884990977`, failed child `30885142692`, and signed rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd` are historical evidence. Diagnostics `30886814052`, `30887204135`, `30887382006`, `30888153701`, and `30888436716` isolated the pinned Claude draft incompatibility; no-forge replay `30889239515` completed `invoke=success` after removing only explicit draft-2020 `$schema`. This does not complete Phase 5.

Tenth-attempt owner-authored PR #178 uses branch `adw/mjs-phase5-retry9` directly over signed ninth rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd`. Signed aggregate `28f84ba7055b437fb95fb4a5462da89b6d6d3e6b` is staging provenance only; the next signed one-anchor planning head binds PR #178's future commands and exact-head approval. `ADW_CUTOVER_HOLD=true` remains permanent, `ADW_MJS_CUTOVER_HOLD=true` remains the current barrier, legacy authority remains active except disabled `adw-release`, and no tenth cutover, deployment proof, scheduled-cycle proof, or Phase 5 completion has occurred.

## File map

### Control-plane production readiness

- `adw/core.mjs`: carry canonical dispatch authority and emit at most one retry-or-dispatch asynchronous operation per reconciliation decision.
- `adw/github.mjs`: normalize owner `workflow_dispatch` controls and App-authenticated `repository_dispatch` intents into bounded issue/pull/control events; provide only the fixed repository-dispatch writer and reject spoofed or incomplete dispatches.
- `adw/roles.mjs`: permit owner-authenticated manual `dispatch` for the reconciler while preserving provider-free control authority.
- `adw/test/core.test.mjs`: dispatch intent authority and exact repository-dispatch payload tests.
- `adw/test/github.test.mjs`: owner/App dispatch authentication, entity/head binding, and stale rejection tests.
- `adw/test/scenarios.test.mjs`: full reconciliation-dispatch-to-role scenarios.
- `adw/test/wrappers.test.mjs`: production App input, event gating, dispatch grammar, exact promotion, sole-writer inventory, self-test, and charter boundaries.

### Wrappers and self-test

- `prototypes/p38-adw-disposable/wrappers/adw-issues.yml`: canonical issue/reusable/internal-dispatch wrapper; use `app-id`, gate label/comment events, and consume only the three closed issue `repository_dispatch` payloads.
- `prototypes/p38-adw-disposable/wrappers/adw-pulls.yml`: canonical pull/reconcile wrapper; provider-route only intended events and consume only App `run_review` repository dispatches.
- `prototypes/p38-adw-disposable/wrappers/adw-operations.yml`: canonical maintenance wrapper; expose owner-only manual audit/reconcile choices, consume only App `run_obligation` repository dispatches, and snapshot alerts only from the existing `57 2 * * *` schedule; GitHub Actions has no alert webhook trigger here.
- `.github/workflows/adw-issues.yml`: byte-identical promoted issue wrapper.
- `.github/workflows/adw-pulls.yml`: byte-identical promoted pull wrapper.
- `.github/workflows/adw-operations.yml`: byte-identical promoted maintenance wrapper.
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

Every accepted production run records its run ID and URL, event, expected run head SHA, trusted control SHA, attempt, conclusion, job list, artifact IDs/names, and downloaded sidecar verification. Expected artifact sets are:

- Provider lane: `adw-target`, `adw-source`, `adw-snapshot`, exactly one successful primary `adw-assessment-{claude|codex}`, `adw-decision`, `adw-verification`, the current `adw-apply-result-<attempt>`, and every earlier apply result that the run artifact inventory says was uploaded.
- Provider-free audit/reconcile lane: `adw-target`, `adw-source`, `adw-snapshot`, `adw-decision`, `adw-verification`, the current `adw-apply-result-<attempt>`, and every earlier apply result that the run artifact inventory says was uploaded; no `adw-assessment-*`.
- Attempt defaults to `1`; recovered attempts pass their explicit positive integer. Missing earlier apply-result artifacts are admissible only when the exact run's artifact inventory proves no such result was uploaded. Successful source/snapshot/decision/verification artifacts are preserved by failed-job reruns, and the required current complete receipt reconstructs forge state even when an earlier cancelled apply uploaded no result. `run.json.attempt` must equal the explicit attempt.
- Every JSON/patch sidecar digest, including every retained `result.sha256`, must match exact bytes.
- The current attempt's `result.json` must have `schemaVersion:1`, `status:"complete"`, `failure:null`, all operations `status:"complete"`, and only complete receipts. Each uploaded earlier result must be a structurally valid `partial`/`failed` result with a failure at the chain's exact operation boundary; its complete receipts must be an unchanged prefix of the next uploaded result's receipts.
- Every `dispatch_repository` receipt must be backed by one exact child run lineage: `repository_dispatch` event, closed workflow path, operation digest as display title, exact App actor, trusted control head on `main`, creation at or after the dispatch boundary, and a positive attempt number. A duplicate run identity is conflicting evidence, not success; a failed child proves delivery only and must be recovered by a separate attempt-bound rerun.
- `snapshot.json.controlSha`, `decision.json.controlSha`, `verification.json.controlSha`, and `result.json.controlSha` must equal the run's trusted control SHA.
- Decision/snapshot/verification/result digest links must match the corresponding canonical artifact bytes, as additionally enforced by the runtime and offline tests.

Define this exact positive-run capture function once in the owner shell. Call it with a forge-derived run ID, lane (`provider-free`, `provider-claude`, or `provider-codex`), expected run head SHA, trusted control SHA, and optional explicit run attempt (default `1`):

```bash
capture_run() (
  set -euo pipefail
  local run_id=$1 lane=$2 expected_run_head=$3 control_sha=$4 run_attempt=${5:-1} repo=bugabinga/smith
  [[ $run_id =~ ^[1-9][0-9]*$ ]]
  [[ $expected_run_head =~ ^[0-9a-f]{40}$ ]]
  [[ $control_sha =~ ^[0-9a-f]{40}$ ]]
  [[ $run_attempt =~ ^[1-9][0-9]*$ ]]
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

  local -a expected_artifacts=(adw-decision adw-snapshot adw-source adw-target adw-verification)
  case "$lane" in
    provider-free) ;;
    provider-claude) expected_artifacts+=(adw-assessment-claude) ;;
    provider-codex) expected_artifacts+=(adw-assessment-codex) ;;
    *) return 2 ;;
  esac
  expected_artifacts+=("adw-apply-result-$run_attempt")
  local artifact
  for artifact in "${expected_artifacts[@]}"; do
    test "$(jq -r --arg name "$artifact" 'select(.name == $name) | .name' "$root/artifacts.jsonl" | wc -l)" = 1
  done
  while IFS= read -r artifact; do
    case "$artifact" in
      adw-apply-result-*)
        local artifact_attempt=${artifact#adw-apply-result-}
        [[ $artifact_attempt =~ ^[1-9][0-9]*$ ]]
        test "$artifact_attempt" -le "$run_attempt"
        ;;
      *)
        printf '%s\n' "${expected_artifacts[@]}" | grep -Fx -- "$artifact" >/dev/null
        ;;
    esac
  done < <(jq -r '.name' "$root/artifacts.jsonl")
  test "$(find "$root/download" -type f -name '*.sha256' | wc -l)" -ge 5
  find "$root/download" -type f -name '*.sha256' -print0 |
  while IFS= read -r -d '' sidecar; do
    case "$sidecar" in
      *.patch.sha256) payload=${sidecar%.sha256} ;;
      *) payload="${sidecar%.sha256}.json" ;;
    esac
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
  for file in "$source" "$snapshot" "$decision" "$verification"; do test -f "$file"; done
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

  local -a receipts=()
  local result_dir
  while IFS= read -r result_dir; do
    local attempt=${result_dir##*-}
    [[ $attempt =~ ^[1-9][0-9]*$ ]]
    test "$attempt" -le "$run_attempt"
    local receipt="$result_dir/result.json" result_sidecar="$result_dir/result.sha256"
    for file in "$receipt" "$result_sidecar"; do test -f "$file"; done
    receipts+=("$receipt")
    jq -e --arg control "$control_sha" --arg source "$source_digest" \
      --arg snapshot "$snapshot_digest" --arg decision "$decision_digest" \
      --arg verification "$verification_digest" --argjson artifact_attempt "$attempt" \
      --argjson current_attempt "$run_attempt" '
        . as $result |
        $result.schemaVersion == 1 and $result.controlSha == $control and
        $result.sourceDigest == $source and $result.snapshotDigest == $snapshot and
        $result.decisionDigest == $decision and $result.verificationDigest == $verification and
        ($result.operations | length >= 1) and
        ([$result.operations[].receipts[]?.status] | all(. == "complete")) and
        (if $artifact_attempt == $current_attempt then
          $result.status == "complete" and $result.failure == null and
          ([$result.operations[].status] | all(. == "complete"))
        else
          ($result.status == "partial" or $result.status == "failed") and $result.failure != null and
          ([$result.operations[] | select(.status == "failed")] | length == 1) and
          ($result.failure.operationIndex as $failed_operation |
            $result.operations[$failed_operation].status == "failed") and
          (([$result.operations[].receipts[]?] | length) as $completed_receipts |
            $result.status == (if $completed_receipts > 0 then "partial" else "failed" end) and
            all(range(0; $result.operations | length);
              . as $operation |
              $result.operations[$operation].status ==
                (if $operation < $result.failure.operationIndex then "complete"
                 elif $operation == $result.failure.operationIndex then "failed"
                 else "pending" end)))
        end)
      ' "$receipt" >/dev/null
  done < <(find "$root/download" -mindepth 1 -maxdepth 1 -type d -name 'adw-apply-result-*' | sort -V)
  test "${#receipts[@]}" -ge 1
  jq -s -e '
    . as $chain |
    all(range(0; length - 1);
      . as $attempt |
      $chain[$attempt] as $previous |
      $chain[$attempt + 1] as $next |
      ($previous.operations | length) == ($next.operations | length) and
      all(range(0; $previous.operations | length);
        . as $operation |
        $previous.operations[$operation].index == $next.operations[$operation].index and
        $previous.operations[$operation].operationDigest == $next.operations[$operation].operationDigest and
        $previous.operations[$operation].receipts ==
          $next.operations[$operation].receipts[0:($previous.operations[$operation].receipts | length)]))
  ' "${receipts[@]}" >/dev/null
  jq -e --argjson id "$run_id" --arg head "$expected_run_head" --argjson attempt "$run_attempt" '
    .databaseId == $id and .headSha == $head and .attempt == $attempt and
    .status == "completed" and .conclusion == "success" and
    ([.jobs[] | select((.name | test("(^| / )evidence$")) and .conclusion == "success")] | length == 1)
  ' "$root/run.json" >/dev/null
)
```

Expected: any API, download, sidecar, exact-set, receipt, control binding, expected run-head binding, attempt, or evidence-job failure exits nonzero; zero files cannot pass vacuously.

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
repository_dispatch run_obligation  -> adw-operations.yml -> {repositoryId,prId,mergeSha,role,provider} -> docs-writer/codex
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
owner issue_comment with bounded @smith -> steerer, Claude primary
owner comment without bounded @smith -> skipped
App/non-owner issue_comment          -> skipped
pull opened/reopened/synchronize     -> reviewer
pull labeled changes-requested       -> reviser
pull labeled reviewed                -> security-reviewer
pull labeled any other label         -> reconcile-only
pull closed+merged                    -> docs-writer
pull closed+unmerged                 -> reconcile-only
pull_request_review changes_requested on exact App-authored PR -> reviser
all other pull_request_review submissions -> reconcile-only
pull_request_review_comment created  -> reconcile-only
check_run/check_suite completed      -> reconcile-only
manual maintenance audit/reconcile   -> provider-free owner control lane
scheduled maintenance 57 2 * * *     -> alert-triager snapshot; no alert webhook
internal run_review                  -> exact requested review role/current head
internal run_obligation              -> exact requested role/merge SHA
```

Also require internal run-name to equal `${{ github.event.client_payload.smith_operation_digest }}` so `github.mjs` can prove delivery. Require exact `client_payload` fields for each closed `repository_dispatch` event type and no internal `workflow_dispatch` input.

- [x] **Step 3: Write failing loop-prevention tests**

Assert triager-applied classification labels cannot start another triager, steerer App replies cannot start another steerer, and reviewer/security labels outside the two explicit handoff labels wake reconciliation rather than another provider. Assert every reconcile-only path has zero `assess` commands reachable. With `vars.ADW_MJS_CUTOVER_HOLD == 'true'`, every operational job across all three wrappers must skip, emit no artifact, and mint no token; self-test remains unaffected.

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

Use only existing closed `github.mjs` methods. The only new writer permitted is fixed `POST /repos/bugabinga/smith/dispatches` with a closed event type and exact `client_payload`; it must add the operation digest, bind the App identity and current `main` head, validate entity/revision authority, and prove one matching workflow delivery before completing its receipt. `dispatch_repository` uses Contents write plus only the exact reads needed to reconstruct every named snapshot revision. Any Actions write belongs to a separate `rerun_check` in the same closed decision, not to a dispatch endpoint. Before the 204 request it re-reads and compares `expectedBefore`; afterward bounded polling binds event, workflow path, operation digest/display title, exact App actor, control head on `main`, created-after boundary, status/conclusion, and attempt lineage. Delivery timeout is retryable; duplicate exact runs fail closed. Add no generic URL/method/GraphQL escape and no wrapper-side `gh`, `jq`, policy shell, or inline prompt.

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
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-operations.yml`
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

Add job-level conditions and input expressions matching Task 2 exactly. Add the exact global `ADW_MJS_CUTOVER_HOLD != 'true'` guard to natural callers and every `always()` shared-graph path so no downstream verify/apply/evidence job runs when prepare is held. Preserve one reusable execution graph, one provider credential per provider job, tokenless reduce/verify, operation-scoped apply token, `adw-write`, and `cancel-in-progress:false`. Alert triage is schedule-only at `57 2 * * *`; do not declare unsupported `dependabot_alert` or `code_scanning_alert` webhook keys or infer alert events with `endsWith(...)`.

- [x] **Step 4: Prove internal dispatch delivery grammar**

Require each dispatched workflow to:

- run from `main` at the repository-dispatch head proven by `github.mjs`;
- use the exact natural/manual/internal run names above so evidence selection binds entity or operation rather than timestamp alone;
- derive control SHA only from trusted `github.workflow_sha`;
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
  prototypes/p38-adw-disposable/wrappers/adw-operations.yml \
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
- Create: `.github/workflows/adw-operations.yml`
- Modify: `.github/workflows/adw-selftest.yml`
- Delete: all legacy workflow and `.github/adw/` files listed in the file map
- Modify: `adw/test/wrappers.test.mjs`

- [x] **Step 1: Write failing exact-promotion and sole-writer tests**

Require byte equality between each prototype candidate and production path. Require exact production ADW inventory:

```text
.github/workflows/adw-issues.yml
.github/workflows/adw-operations.yml
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
cp prototypes/p38-adw-disposable/wrappers/adw-operations.yml \
  .github/workflows/adw-operations.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-issues.yml \
  .github/workflows/adw-issues.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-pulls.yml \
  .github/workflows/adw-pulls.yml
cmp prototypes/p38-adw-disposable/wrappers/adw-operations.yml \
  .github/workflows/adw-operations.yml
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
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-operations.yml`
- Modify: `.github/workflows/adw-operations.yml`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

Production run `30713498516` failed before job creation because GitHub Actions does not support `dependabot_alert` or `code_scanning_alert` as workflow `on` events. Alert snapshot collection remains a scheduled maintenance responsibility.

- [x] **Step 1: Add and run the failing wrapper regression**

Require maintenance triggers to reject both unsupported keys, reject `endsWith(github.event_name, '_alert')`, and select `alert-triager` only for `57 2 * * *`. The focused test failed on the first unsupported key with zero passes and one failure, recording RED before implementation.

- [x] **Step 2: Remove only unsupported alert routing and promote exact bytes**

Delete both unsupported trigger blocks and both `endsWith(..._alert)` branches from the canonical wrapper. Preserve the `57 2 * * *` schedule and its `alert-triager` role, then copy canonical bytes to production.

- [x] **Step 3: Verify the correction and record lint scope honestly**

The focused regression, all 18 wrapper tests, and all 224 Node tests pass. Exact actionlint v1.7.7 passes the four production ADW workflows and the known-clean `ci.yml` control; linting every production workflow no longer reports `adw-operations.yml` but still reports seven unrelated pre-existing findings in `ci-prototype.yml`, `devskim.yml`, `p35-adw-harness.yml`, `p37-codex-harness.yml`, and `prototypes.yml`. All production workflow YAML parses, all three promoted wrappers equal canonical bytes, canonical wrappers total 371 physical lines, and `git diff --check` passes.

### Task 7B: Close deployed-workflow trust and proof-capture blockers

**Files:**

- Modify: `adw/permissions.json`
- Modify: `adw/test/wrappers.test.mjs`
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-{issues,pulls,maintenance}.yml`
- Modify: `.github/workflows/adw-{issues,pulls,maintenance}.yml`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Validate live evidence read-only and add RED contracts**

PR #167 remained at `cdca1b92987ec8af11f792c15e5454811a7d08f9`, main remained at `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c`, and the hold was `true`. The focused wrapper run recorded 27 tests with 14 passes and 13 expected failures covering all nine required behaviors plus isolation of untrusted target checkout; no production setting, workflow, issue, PR, or branch was mutated.

- [x] **Step 2: Implement canonical wrappers, then promote exact bytes**

Gate every top-level caller on trusted deployed workflow SHA before secret forwarding; isolate entity-head checkout in a read-only target job; require successful target/prepare roots before providers and downstream credentials; route only exact App-authored `changes_requested` reviews to reviser; require a space-bounded `@smith`; name schedules with the exact cron; and use `github.workflow_sha` as control while preserving entity head as target. Canonical wrappers were edited first and then byte-copied to production.

- [x] **Step 3: Bind proof history, run head, control SHA, and cutover bypass honestly**

Record all five pre-hold run URLs and their zero-artifact/zero-write outcome, leave the missed first-push hold gate unchecked, bind `capture_run` to separate expected run head and trusted control SHA, update every call, and treat absent cutover `merge-gate` only through explicit owner bypass. Existing proof-PR merge-gate assertions remain unchanged.

- [x] **Step 4: Verify the corrected tree**

Focused Node: 27/27 pass. Full Node: 233/233 pass. Exact actionlint v1.7.7 passes all four production ADW workflows. `yq` v4.53.3 parses all four, all three canonical/production wrapper pairs are byte-equal, canonical operational YAML totals 383 physical lines, and `git diff --check` passes.

### Task 7C: Close production-data GitHub adapter blockers

**Files:**

- Modify: `adw/github.mjs`
- Modify: `adw/permissions.json`
- Modify: `adw/roles.mjs`
- Modify: `adw/test/{apply,github,main,wrappers}.test.mjs`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record RED from current production data**

The initial focused run recorded 97 passes and 11 expected failures across 108 tests: dispatch still requested Actions/Checks write, performed one immediate run read, accepted incomplete run identity, rejected the 116550-byte `docs/SPEC.md`, and used unsafe 100-item pull/run pages. Read-only production probes measured 1,404,156-byte pull and 1,276,745-byte run pages, and current `createGitHub` snapshots failed for auditor, reconciler, and planner. Follow-up focused RED isolated malformed irrelevant timeline events, explicit collection maxima, and GitHub's second-resolution `created_at` boundary. No GitHub object was mutated.

- [x] **Step 2: Implement the minimum closed correction**

Keep rerun Actions/Checks write separate from dispatch delivery, remove dispatch check markers, and poll twelve times at fixed five-second intervals. Match one run lineage by event, closed workflow path, digest display title, App actor, `main` control head, and floored created-after boundary; make timeout retryable and duplicates stale. Dispatch also receives the exact snapshot reads required by Task 7F's immediate `expectedBefore` reconstruction. Keep only open issues, the newest 10 pulls, and newest 20 general runs; supplement recovery through exact bounded workflow queries, use 10/20/20-item pull/run/comment pages, fail comments at the defined total ceiling, and ignore irrelevant non-`unlabeled` timeline shapes. Raise only trusted UTF-8 text to the exact 262144-byte ceiling.

- [x] **Step 3: Verify offline and read-only live behavior**

Focused Node passed 109/109; full Node passed 238/238; `git diff --check` passed. Read-only `createGitHub` snapshots at control `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c` succeeded for auditor (77,432 bytes, digest `a64aacc951e7fe303c7cc68c3dbd181d965c4eca39550e7852effc978a8ab926`), reconciler (220,840 bytes, digest `97159347d3648e7175a97f03d29f2f2ee166e79906c4e18dd2287f2ac8764cd6`), and planner (165,884 bytes, digest `72960ee37776fd9494bd41f50b659581d506f78610eb2073e8c0916b698e40b1`). No token value or GitHub mutation was emitted.

### Task 7D: Close adversarial production blockers and concurrency recovery

**Files:**

- Modify: `adw/{core,github,main,roles}.mjs`
- Modify: `adw/test/{apply,core,github,roles,scenarios,wrappers}.test.mjs`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record focused RED before implementation**

The focused six-file run recorded 156 passes and 13 expected failures. Regressions proved receipt-chain laundering after a later write plus unrelated body/label drift, duplicate positive marker rejection, circular `BLOCKED` merge gating, unsafe repository/ref/run issue endpoints, absent cancelled-apply reconciliation, and unsupported FIFO planning claims. Follow-up read-only live reduction exposed GitHub's synthetic `merge_commit_sha` on unmerged pulls, and a mixed-operation scenario exposed unsafe dispatch/action ordering; both received focused RED regressions before correction. No GitHub object was mutated.

- [x] **Step 2: Implement strict authority and endpoint corrections**

Natural completion now follows expected-before/current authority; only an exact reversible transition or operation marker can reconstruct a lost receipt, and unrelated drift is stale. One-or-more exact current-head App approvals—including bounded legacy compatibility markers—satisfy each review kind while reject evidence vetoes and stale/wrong-actor evidence never counts. Unmerged synthetic merge candidates normalize to no merge SHA. `BLOCKED` no longer circularly fails the ADW gate; explicit `BEHIND`/`DIRTY` remains fail-closed and native rules retain other protection/freshness authority. Planner/surveyor/alert/maintenance findings reduce only to bounded create/report/no-op or valid run reruns, never repository/ref/run issue endpoints.

- [x] **Step 3: Preserve the lock without claiming queue order**

`adw-write` remains the repository-wide lock with `cancel-in-progress:false`. GitHub permits one running and at most one pending job; a newer pending job can cancel the older pending job, so there is no FIFO guarantee. Exact operational-workflow runs with bound entity/run identity, cancelled apply, and no successful evidence are snapshot-bound as recoverable reconciliation work and retried by attempt; Task 7H corrects discovery to include completed runs whose overall conclusion is failure and does not require the earlier verify job to have succeeded. Pull-event run heads and branches remain entity authority rather than being forced to control/`main`. Revision-observing state repairs run before action reruns, and repository dispatches run last under their chained receipt authority. A cancelled apply result is never positive proof of success.

- [x] **Step 4: Re-run complete offline, read-only live, diff, and signature verification**

On 2026-08-01, focused Node passed 172/172 and full Node passed 248/248; workspace Rust tests passed 34/34 across seven suites. `git diff --check`, YAML parsing, and all three canonical/production wrapper byte comparisons passed. `cargo run -p xtask -- check` still reached `xtask pup` and failed only because this Termux environment has no rustup-style `cargo +nightly-2026-01-22`; the earlier project-plan blocker remains open.

Read-only live reduction at main `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c` produced an auditor snapshot of 78,778 bytes (digest `94137e8e76db3e82f379ffaa3343d318aae70e79a2d9e11484da0c1365cd5ce3`) and a reconciler snapshot of 223,611 bytes (digest `1d30d6deedb293a8ec810d05b33a27622e738ca969706a6168b76f444f6909b6`). Auditor failed the three explicit-behind heads, judged then-open #150 eligible without circular `BLOCKED`, and would reconstruct its existing auto-merge arm; reconciler reduced successfully with zero cancelled applies in the bounded live window. At that snapshot, live audit remained blocked pending independent #150 safety or owner disposition; the exact-head owner squash recorded above later supplied disposition before cutover. No GitHub object was mutated.

### Task 7E: Bind deployed refs, submitted-review control, and route-label execution

**Files:**

- Modify: `adw/roles.mjs`
- Modify: `adw/test/{roles,scenarios,wrappers}.test.mjs`
- Modify: `prototypes/p38-adw-disposable/wrappers/adw-{issues,pulls,maintenance}.yml`
- Modify: `.github/workflows/adw-{issues,pulls,maintenance}.yml`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Add wrapper, role, and scenario RED before implementation**

The focused three-file run recorded 71 tests with 63 passes and 8 expected failures. Regressions exposed missing default-ref authority for direct internal dispatch, maintenance's non-push ref bypass, missing pull base-ref checks, implicit submitted-review routing, absent reconciler event authority, and route labels terminalizing planner/pioneer/reviser/reviewer work. No production workflow, GitHub object, secret, setting, issue, PR, or branch was mutated.

- [x] **Step 2: Implement only event-specific trust and execution-hold corrections**

Maintenance now requires `github.ref == 'refs/heads/main'` and `github.workflow_sha == github.sha` before every natural, manual, or internal lane. Pull natural events bind the event-specific default base ref and its deployed workflow SHA; pull and issue `repository_dispatch` bind the default branch, and every guard remains behind `ADW_MJS_CUTOVER_HOLD`. Exact App-authored `changes_requested` review events still invoke only reviser, while every other submitted review is provider-free reconciliation and `reconciler` explicitly accepts `pull_request_review`.

Merge holds remain unchanged. Execution filtering ignores only `needs:breakdown` for planner, `needs:prototype` for pioneer, and `changes-requested` for reviser plus the reviewer that deterministically clears it after a successful revision. Planner and pioneer dequeue their own route labels on canonical non-noop completion; reviser preserves `changes-requested` until reviewer approval removes it. `blocked`, `risk:high`, `needs:info`, `needs:spec`, and every unrelated hold remain terminal.

- [x] **Step 3: Promote exact bytes and verify offline**

Focused Node passed 71/71; full Node passed 253/253. Exact actionlint v1.7.7 passed all four production ADW workflows; `yq` v4.53.3 parsed the three canonical and four production workflows. All three canonical/production wrapper pairs are byte-equal, canonical operational YAML remains 383 physical lines, and `git diff --check` passes.

### Task 7F: Close live pagination, recovery, dispatch, and snapshot ceilings

**Files:**

- Modify: `adw/{core,github,roles}.mjs`
- Modify: `adw/schemas/decision.schema.json`
- Modify: `adw/test/{apply,core,github,roles,scenarios,wrappers}.test.mjs`
- Add: `adw/test/fixtures/github/blockers.json`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record adversarial RED and read-only API evidence**

The focused four-file RED run recorded 140 tests with 130 passes and 10 expected failures. Live-shaped fixtures exposed unsupported Dependabot `page`, global newest-20 cancellation discovery, pull-run control-head assumptions, fabricated dispatch revision digests, failed-child redispatch, and aggregate comment overflow. A read-only production probe confirmed `dependabot/alerts?...&page=1` returns HTTP 400 (`Pagination using the page parameter is not supported`), while one `per_page=100` request returned three current open alerts. No GitHub object was mutated.

- [x] **Step 2: Implement bounded current-state and recovery authority**

Dependabot uses one supported `per_page=100` request and treats a full page as explicitly incomplete. Cancelled apply discovery uses bounded exact operational workflow queries, then binds entity and run identity plus cancelled apply and absent successful evidence; Task 7H additionally binds control SHA and apply-job ID while querying all completed operational conclusions. Pull events do not require their run head to equal control or their branch to equal `main`; their exact workflow, event, display title, pull number, run ID, and attempt remain bound. Reconciliation emits an attempt-bound retry for each cancelled apply and never counts cancellation as success. GitHub's repository-wide concurrency lock is still not FIFO.

`dispatch_repository` retains `contents:write` plus exact snapshot read permissions. Every dispatch apply must reread its exact source entity and all named revisions, compare the observed digest with `expectedBefore` before the POST, and never synthesize that digest. Bounded polling binds event, workflow path, operation digest, App actor, control head, created-after boundary, child status/conclusion, and attempt lineage. An existing child proves delivery only; a failed child produces a separate deterministic attempt-bound rerun and never a duplicate dispatch.

Untrusted text retains full byte count and digest while exposing an explicit bounded preview. Comment collections retain the triggering comment and newest context under a fixed snapshot budget, record omitted-item/body truncation, and fail closed only when the defined 1000-comment or 8 MiB total-entity ceiling is incomplete. Final snapshots remain under 256 KiB before provider canonicalization.

- [x] **Step 3: Verify focused/full Node, read-only live snapshots, diff, and signatures**

Focused Node passed 182/182; full Node passed 258/258. `git diff --check`, `git show --check`, Node syntax checks, and both changed JSON parses passed. Read-only snapshots at current main `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c` produced 131450 alert bytes (digest `54faf9b66e860b698ca89f2a63563de1936ecf7a7d5f742aaec52f12b592196b`, 22 open alerts through the supported bounded request) and 192029 reconciler bytes (digest `692b047a93bedaeba63b5ce94e554cc88b85151017b5ce5a856217d274f05dbd`, zero cancelled applies, zero failed-child reruns, 29 intents). Reconciliation explicitly retained 79 newest/authority comments from 136 and recorded 57 omissions with zero body truncations.

Signed commit `468afb79b33668959d9687e043d1f5e01f51e61d` verifies as Good under ED25519 key `SHA256:/hKgUDV+nKK77+MpfPjoTPym4qiOGZIsa8D1/mTrh5Y`. No GitHub object was mutated and nothing was pushed.

### Task 7G: Make rollback executable after unexpected main movement

**Files:**

- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Bind rollback to the current main parent**

Keep the prepared signed rollback as the fast-forward path only while `main == MERGE_SHA`. If main advances, disable and drain MJS first, create a new detached worktree at the newly fetched current main, apply the exact hashed reverse cutover patch with `--3way --index`, and abort without commit or push on conflict. Prove the resulting index changes only cutover-owned paths, every cutover-owned path equals `CUTOVER_BASE`, unrelated later paths remain from current main, and the new signed commit has current main as its sole parent.

Expected: later unrelated commits survive rollback; neither path uses force-push or reset.

- [x] **Step 2: Verify rollback plan searches and shell syntax**

```bash
set -euo pipefail
PLAN=docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md
ROLLBACK_SCRIPT=$(mktemp)
trap 'rm -f "$ROLLBACK_SCRIPT"' EXIT
awk '
  /^Rollback from the owner shell:$/ { found=1; next }
  found && /^```bash$/ { code=1; next }
  code && /^```$/ { exit }
  code { print }
' "$PLAN" > "$ROLLBACK_SCRIPT"
test -s "$ROLLBACK_SCRIPT"
bash -n "$ROLLBACK_SCRIPT"
rg -n 'CURRENT_MAIN|apply --3way --index|cutover-owned|verify-commit|current_user_can_bypass' \
  "$ROLLBACK_SCRIPT"
! rg -n -- 'git reset|git push .*--force|git push -f' "$ROLLBACK_SCRIPT"
test "$(rg -c '^[[:space:]]+-m "Anchor:' "$ROLLBACK_SCRIPT")" = 1
```

Expected: the owner-shell block parses as Bash, contains both current-parent paths and exactly one signed-commit anchor, and contains no force-push/reset command.

### Task 7H: Close final recovery, mutation, obligation, evidence, and disclosure blockers

**Files:**

- Modify: `adw/{core,github,main,providers,roles}.mjs`
- Modify: `adw/test/{apply,core,github,main,providers,roles,scenarios,wrappers}.test.mjs`
- Modify: `adw/test/fixtures/github/blockers.json`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record focused RED and read-only live evidence**

The focused eight-file RED run recorded 223 tests with 209 passes and 14 expected failures. Read-only API evidence captured live-shaped run `30713540804`: the operational run was completed with overall `failure`, its exact apply job `91405160611` was `cancelled`, and its verify/evidence jobs failed. Source inspection also confirmed operational commands wrote complete snapshots, assessments, decisions, and receipts to public stdout, while an injected provider-auth canary was accepted as a model-controlled comment body. Pulls #146/#147/#148 were merged at `0425d4ed2e001933c65ac8745ec44137f79acda1`, `5b5eefbd333c7380a88a82170304fa5c8d8d9fa6`, and `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c`, with no existing `merge-finalized` comments. No GitHub object was mutated and nothing was pushed.

- [x] **Step 2: Implement exact bounded corrections**

Cancelled-apply discovery now inspects bounded completed operational workflow queries rather than only overall-cancelled runs or the global newest 20. Recovery binds exact workflow, entity, control SHA, run/attempt/conclusion, and cancelled apply-job identity; successful evidence still vetoes recovery. Pull snapshots carry separate head and mutable pull metadata revisions, including labels/holds, comments, and `updatedAt`; `publish_check`, comment, and dispatch writes re-read them, while each operation's observed post-revision remains the next operation's ordered precondition.

Every registered merged-pull obligation role—currently `docs-writer`—appends an exact App-authenticated `smith:merge-finalized/v1` marker after patch or noop completion. Reconciliation imports only the same role and merge SHA, so #146/#147/#148 are not redispatched on later control SHAs; a failed final marker leaves prior operation receipts resumable without replay. `capture_run` accepts an explicit run attempt, defaults to attempt 1, and binds both artifact suffix and run JSON attempt. The administrative merge command uses exact `--match-head-commit`.

Operational stdout now emits only a bounded non-sensitive status while artifact files retain complete transport data. Provider-auth canaries remain transport-only: any credential echoed into a semantic payload or captured patch is rejected before an assessment can become operations. The attack and disclosure regressions cover both findings.

- [x] **Step 3: Verify focused Node, full Node, read-only live recovery/reconcile snapshots, diff, and signatures**

The focused nine-file Node run passed 239/239 and the full Node run passed 263/263. `git diff --check`, `git show --check`, Node syntax checks, the changed fixture JSON parse, and the 16-file implementation scope all passed.

A guarded read-only live reconciliation at main `491a42a3cc8848853e4ccd6cedc5695d9bd06e8c` made 86 API requests and produced 192865 snapshot bytes with digest `d0d190cee178ba8daa102ddd8fef4ea9018727d500b86dbd427a88adf8a9789a`. It recovered exactly run `30713540804`, attempt 1, overall `failure`, cancelled apply job `91405160611`, pull #167, and the same control SHA. The read-only reduction produced 30 intents: 21 held, one cancelled-apply retry, three first-time missing obligations for #146/#147/#148, four reviews, and one label sync. Mapping produced one `sync_labels`, one `rerun_check`, and seven `dispatch_repository` operations; none was applied. The three historical obligations remain expected first executions because production has no finalization markers yet; after each exact marker lands, later control SHAs do not redispatch it.

Signed implementation commit `b9d379efebe8e19a8b8be1a25d383be268d8706e` verifies as Good under ED25519 key `SHA256:/hKgUDV+nKK77+MpfPjoTPym4qiOGZIsa8D1/mTrh5Y`. No GitHub object was mutated and nothing was pushed.

### Task 7I: Close concatenated credential disclosure and full-run recovery blockers

**Files:**

- Modify: `adw/{core,github,providers,roles}.mjs`
- Modify: `adw/test/{apply,core,github,providers,roles,scenarios,wrappers}.test.mjs`
- Modify: `adw/test/fixtures/github/blockers.json`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record focused RED before implementation**

The focused provider/apply RED run passed 58/61 and failed the three new attacks as expected: a complete nested Codex access token split across valid steerer fields, a complete nested token split across patch metadata/content, and a rerun operation still bound to the full-run endpoint. No GitHub object was mutated, no secret was logged, and nothing was pushed.

- [x] **Step 2: Implement exact bounded corrections**

Credential leaves are derived recursively from the exact provider credential. Scanning covers exact raw provider bytes, every individual semantic key/value, and deterministic semantic concatenation with arrays in index order and object values in lexicographic key order. Patch scanning additionally concatenates normalized manifest strings with exact patch bytes. Ceilings are exactly 524288 raw provider bytes, 262144 normalized semantic bytes, 1048576 patch bytes, and 1310720 combined patch-metadata/content bytes. Matching is exact bytes only: separators remain separators, arbitrary encoding is not claimed, errors contain no credential, and the pinned exact provider CLI remains the trust root.

Recovery now posts only `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`; the full-run `/rerun` endpoint is closed. Snapshot, intent, operation, App check evidence, and immediate pre-write reread bind the exact run attempt plus the sorted REST IDs/conclusions of its failed/cancelled jobs. The Actions/Checks write token remains exact for rerun delivery and its idempotency check marker. Successful source/snapshot/decision/verification jobs and artifacts are not rerun. Missing earlier apply results are accepted in production evidence only when the exact run artifact inventory proves none was uploaded; the current complete receipt reconstructs forge state. The live-30713540804-shaped regression binds run `30713540804`, cancelled apply job `91405160611`, and all five failed/cancelled jobs.

- [x] **Step 3: Verify focused/full Node, diff, and one-anchor signature**

Focused Node passed 206/206 and full Node passed 267/267. Changed MJS syntax checks, fixture JSON parse, and `git diff --check` passed. The single signed anchor is verified with `git verify-commit HEAD`; no GitHub object was mutated and nothing was pushed.

### Task 7J: Correct live workflow-name versus run-title recovery identity

**Files:**

- Modify: `adw/github.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/test/wrappers.test.mjs`
- Modify: `adw/test/fixtures/github/blockers.json`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record strict RED from the actual live run shape**

The `30713540804` fixture now uses the live GitHub REST shape: workflow `name` is `ADW pull and reconcile triggers`, while `display_title` is `ADW pull #167`. Production prepare `30788000713` reported `operational pull run entity is malformed`; the focused regression failed exactly once at the same false invariant with `operational run entity is malformed`. No GitHub object was mutated and nothing was pushed.

- [x] **Step 2: Bind closed workflow identity without conflating name and title**

The closed operational workflow registry now binds each exact workflow name, path, and allowed event. Entity parsing consumes only `display_title` under the already-bound workflow grammar; it never requires workflow name to equal run title. Wrong workflow name, path, event, title, and pull entity fail closed. A valid old-control run is ignored and cannot enter current recovery. The live `30713540804` regression binds pull #167, control SHA, cancelled apply job `91405160611`, and all five failed/cancelled jobs.

- [x] **Step 3: Verify focused/full Node, diff, JSON, syntax, and signature**

Focused GitHub Node passed 32/32 and full Node passed 281/281. Changed MJS syntax, fixture JSON parsing, and `git diff --check` passed. The implementation is recorded in one signed commit with exactly one `Anchor:` trailer; no GitHub object was mutated and nothing was pushed.

### Task 7K: Ignore non-registry historical workflow runs during cancelled recovery

**Files:**

- Modify: `adw/github.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/test/wrappers.test.mjs`
- Modify: `adw/test/fixtures/github/blockers.json`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record strict RED from the live historical run shape**

The live fixture now records failed pregraph run `30713498516` with REST `name` `.github/workflows/adw-maintenance.yml`, exactly as returned inside the canonical maintenance workflow endpoint. With valid cancellation control `30713540804` in the same reconciliation, focused GitHub Node passed 31/32 and failed once with `operational run identity is malformed`, reproducing read-only probe `30790255777`. The focused Phase 5 prerequisite regression also failed because this task record was absent. No GitHub object was mutated and nothing was pushed.

- [x] **Step 2: Separate forge history candidates from current workflow authority**

Cancelled recovery compares candidate `name`, `path`, and `event` exactly against the immutable current workflow registry before parsing any other candidate field or requesting its jobs. Any mismatch must return null; it must never throw or poison reconciliation. The historical malformed-name candidate is ignored while the valid cancellation control is recovered. After exact identity selection, malformed candidate fields—including entity title and pull identity—still fail closed, and old-control candidates still cannot enter recovery.

- [x] **Step 3: Verify focused/full Node, fixture, syntax, diff, and one-anchor signature**

Focused GitHub Node passed 32/32 and full Node passed 282/282. Changed MJS syntax, fixture JSON parsing, `git diff --check`, and `git show --check` passed; `git verify-commit HEAD` verifies the implementation recorded in one signed commit with exactly one `Anchor:` trailer. Exact reconciliation read probe `30793832261` then succeeded at that signed head after noncanonical historical workflow runs were filtered; failed probe `30790255777` remains immutable evidence. Signed fourth rollback `64a4515225f8f988989d38e21657bde97177202b` retained legacy authority throughout. The temporary probe workflow and script were deleted under promote-or-delete after success. This closes only the read prerequisite; a fifth retry remains required.

### Task 7L: Accept the live single-match prior-receipt layout after fifth rollback

**Files:**

- Modify: `adw/main.mjs`
- Modify: `adw/test/main.test.mjs`
- Modify: `adw/test/wrappers.test.mjs`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`
- Delete: `.github/workflows/p38-adw-apply-resume-probe.yml`

- [x] **Step 1: Record strict RED from the fifth audit rerun**

Audit retry run `30798105635` attempt 1 retained a canonical partial result: operation 0 `report_drift` completed, operation 1 `publish_check` completed the PR #163 failure check, operation 2, the PR #165 `publish_check`, failed, and operation 3 remained pending. `gh run rerun --failed` attempt 2 failed before any apply operation with `prior apply result entry is invalid`. Live logs prove the pinned `actions/download-artifact` single pattern match extracted `result.json` and `result.sha256` directly into `previous-apply-results`, not into `adw-apply-result-1/`. The focused prior-reader RED run passed 2/3 and failed only the live flat-layout regression. No GitHub object was mutated and nothing was pushed.

- [x] **Step 2: Accept only the exact flat transport pair**

When current attempt is greater than one, the prior receipt loader accepts exactly one flat canonical `applyResult` pair and treats it as the immediately previous attempt. It delegates sidecar, canonical JSON, regular-file, symlink, and directory identity validation to the existing `readTransportArtifact`. Mixed flat and attempt directories, extra files, symlinks, a missing sidecar, and a flat root at attempt 1 fail closed. Multiple prior attempts preserve the `adw-apply-result-<attempt>/` directory layout and latest-earlier-attempt selection.

Signed direct-child rollback `6c9a656c66b38b8bf4771ad47a79fab8bd617bba` restored the exact legacy tree from fourth rollback `64a4515225f8f988989d38e21657bde97177202b` after fifth cutover `2917520ee4842a8dbc9e57cce829a51710e5acff`. The partial receipts remain historical evidence; no operation was replayed during this correction, and a sixth retry remains required.

- [x] **Step 3: Verify focused/full Node, diff, and one-anchor signature**

Focused prior-reader Node passed 3/3 and full Node passed 285/285. Changed MJS syntax, `git diff --check`, and `git show --check` passed. The implementation is recorded in one signed commit with exactly one `Anchor:` trailer and verified with `git verify-commit HEAD`; no GitHub object was mutated and nothing was pushed.

- [x] **Step 4: Record the immutable old-source result and retire the probe**

Apply-resume probe run `30801002050` failed on `prior apply result entry is invalid` because it executed the exact source artifact retained by run `30798105635`. That artifact is immutably bound to old control `2917520ee4842a8dbc9e57cce829a51710e5acff` and necessarily carries the old parser, so immutable transport correctly prevents the branch's later parser repair from changing it. The result is diagnosis of transport immutability, not live evidence for the corrected parser. Focused unit coverage of the exact live single-match shape and full Node remain the sixth-retry prerequisites. The run reached no resumed operation or GitHub write, and temporary `.github/workflows/p38-adw-apply-resume-probe.yml` was deleted under promote-or-delete.

### Task 7M: Bound each reconciliation decision to one asynchronous operation after sixth rollback

**Files:**

- Modify: `adw/core.mjs`
- Modify: `adw/test/core.test.mjs`
- Modify: `adw/test/scenarios.test.mjs`
- Modify: `adw/test/wrappers.test.mjs`
- Modify: `docs/super/plans/2026-08-01-adw-mjs-control-plane-phase-5-production-cutover-proof.md`

- [x] **Step 1: Record strict RED from multiple dispatch intents**

A focused fixture supplied multiple valid dispatch intents and required exactly the canonical first dispatch. Before the correction, `mapReconciliationIntents` returned all five dispatch operations, reproducing the unsafe decision granularity without forge mutation. The focused run failed only that exact assertion.

- [x] **Step 2: Preserve synchronous work and select one asynchronous operation**

The mapper still validates every intent, rejects duplicate intents, preserves all `held` intents upstream, canonicalizes intent order, deduplicates operations, and retains safe synchronous `add_label` and `sync_labels` operations. Those synchronous transitions complete before asynchronous work and chain their observed post-revisions through the existing receipt contract. From the remaining asynchronous operations it emits exactly one: the canonical first `rerun_check` when any rerun exists, otherwise the canonical first `dispatch_repository`. `noop` remains only for a decision with no operation. Because the sole asynchronous action is last, forge-native child progression cannot invalidate a later operation in the same decision; the next scheduled or manual reconciliation uses child evidence to remove the completed intent and advance the next missing obligation.

Global preconditions and the `runs` projection remain unchanged and authoritative. Workflow-run changes are not ignored, dispatches are not batched, held work is not discarded, and no queue or database is introduced.

- [x] **Step 3: Verify focused/full Node, diff, and one-anchor signature**

Focused core/scenario coverage requires one canonical dispatch and `sync_labels` plus one rerun with dispatch suppressed. Full Node, changed MJS syntax, `git diff --check`, and one signed commit with exactly one `Anchor:` trailer are required. This correction was the prerequisite for the eighth retry. No GitHub object is mutated and nothing is pushed.

### Task 8: Push the signed PR #178 planning head and bind owner approval

**Files:** none

**Historical seventh through ninth procedure:** PR #175 on `adw/mjs-phase5-retry6`, PR #176 on `adw/mjs-phase5-retry7`, and PR #177 on `adw/mjs-phase5-retry8` ended at signed rollbacks `db80fd48c1c5fb7bd5a076f1c6b0571c3586361c`, `3e91aac769c8010a50f58c0a0c75e3aa85d3f817`, and `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd`. Those branches, PRs, rollback refs, and orphaned runs remain immutable history.

Branch `adw/mjs-phase5-retry9` and owner-authored PR #178 already exist at signed aggregate `28f84ba7055b437fb95fb4a5462da89b6d6d3e6b` directly over signed ninth rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd`. Both holds are already armed. The next signed one-anchor planning commit supersedes that aggregate only as PR #178's exact head; every future step remains unchecked until executed in order, and no approval marker may be posted before its push and current-head checks.

- [ ] **Step 1: Revalidate the signed aggregate and local planning head**

```bash
BRANCH=adw/mjs-phase5-retry9
BASE=9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd
AGGREGATE=28f84ba7055b437fb95fb4a5462da89b6d6d3e6b
PLAN_HEAD=$(git rev-parse HEAD)
test "$(git branch --show-current)" = "$BRANCH"
test "$(git rev-parse origin/main)" = "$BASE"
test "$(git show -s --format=%P "$AGGREGATE")" = "$BASE"
test "$(git show -s --format=%P "$PLAN_HEAD")" = "$AGGREGATE"
git verify-commit "$BASE"
git verify-commit "$AGGREGATE"
git verify-commit "$PLAN_HEAD"
node --test adw/test/*.test.mjs
find adw -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
actionlint .github/workflows/adw-{issues,operations,pulls,selftest}.yml .github/workflows/ci.yml
while IFS= read -r yaml; do yq eval '.' "$yaml" >/dev/null; done < <(
  find . -type f \( -name '*.yml' -o -name '*.yaml' \) -not -path './.git/*' -not -path './target/*' | sort
)
mapfile -t bash_files < <(find . -type f \( -name '*.sh' -o -name '*.bash' \) -not -path './.git/*' -not -path './target/*' | sort)
if test "${#bash_files[@]}" -gt 0; then shellcheck "${bash_files[@]}"; fi
cmp prototypes/p38-adw-disposable/wrappers/adw-operations.yml .github/workflows/adw-operations.yml
test "$(git show -s --format=%B "$PLAN_HEAD" | grep -c '^Anchor:')" = 1
git diff "$BASE" "$PLAN_HEAD" --check
test -z "$(git status --porcelain)"
```

Expected: signed ninth rollback is aggregate `28f84ba`'s sole parent and the signed one-anchor planning head is the aggregate's sole child. Full Node, actionlint, YAML, MJS, bash, grep, diff, signature, promotion, and clean-tree checks pass. Do not amend, merge, or rebase after exact-head approval.

- [ ] **Step 2: Revalidate both already-armed barriers immediately before push**

```bash
test "$(gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith)" = true
test "$(gh variable get ADW_MJS_CUTOVER_HOLD --repo bugabinga/smith)" = true
```

Expected: permanent orphan barrier and current-wrapper barrier both remain exactly `true`; do not mutate either variable.

- [ ] **Step 3: Push only the corrected signed head to PR #178's branch**

```bash
PR=178
test "$(git ls-remote origin refs/heads/$BRANCH | cut -f1)" = "$AGGREGATE"
git push origin "$PLAN_HEAD:refs/heads/$BRANCH"
PR_HEAD=$PLAN_HEAD
test "$PR_HEAD" = "$(git ls-remote origin refs/heads/$BRANCH | cut -f1)"
```

Expected: PR #178's remote branch and signed local planning head name one exact head; no other ref changes.

- [ ] **Step 4: Validate existing owner-authored PR #178 on the corrected head**

```bash
PR=178
gh pr view "$PR" --repo bugabinga/smith \
  --json number,state,headRefName,headRefOid,baseRefName,author |
  jq -e --arg head "$PR_HEAD" --arg branch "$BRANCH" '
    .number == 178 and .state == "OPEN" and .headRefName == $branch and
    .headRefOid == $head and .baseRefName == "main" and
    .author.login == "bugabinga"' >/dev/null
```

Expected: existing owner-authored PR #178 targets `main` from exact branch `adw/mjs-phase5-retry9` and signed planning head; no new PR is created.

- [ ] **Step 5: Validate current-head checks and then record exact-head owner approval**

```bash
PR=178
PR_HEAD=$(git rev-parse HEAD)
test "$PR_HEAD" = "$PLAN_HEAD"
test "$PR_HEAD" = "$(git ls-remote origin refs/heads/$BRANCH | cut -f1)"
test "$PR_HEAD" = "$(gh pr view 178 --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
checks=$(gh api "repos/bugabinga/smith/commits/$PR_HEAD/check-runs?filter=latest&per_page=100")
jq -e --arg head "$PR_HEAD" '
  [.check_runs[] | select(.name == "check" and .head_sha == $head and
    .status == "completed" and .conclusion == "success")] | length >= 1
' <<<"$checks" >/dev/null
test "$(jq --arg head "$PR_HEAD" \
  '[.check_runs[] | select(.name == "merge-gate" and .head_sha == $head)] | length' \
  <<<"$checks")" = 0
test "$(gh api repos/bugabinga/smith/rulesets/19155559 --jq .current_user_can_bypass)" = always
gh api user | jq -e '.id == 876467 and .login == "bugabinga"' >/dev/null
OWNER_APPROVAL_MARKER="Owner approval: quiet-window MJS production cutover tenth attempt and positive-only proof on PR #178 exact head $PR_HEAD."
OWNER_APPROVAL_COMMENT_JSON=$(gh api --method POST \
  "repos/bugabinga/smith/issues/178/comments" -f body="$OWNER_APPROVAL_MARKER")
OWNER_APPROVAL_COMMENT_ID=$(jq -er '.id' <<<"$OWNER_APPROVAL_COMMENT_JSON")
OWNER_APPROVAL_COMMENT_CREATED_AT=$(jq -er '.created_at' <<<"$OWNER_APPROVAL_COMMENT_JSON")
jq -e --arg body "$OWNER_APPROVAL_MARKER" '
  .id > 0 and .user.id == 876467 and .user.login == "bugabinga" and
  .author_association == "OWNER" and .body == $body and
  .created_at == .updated_at and
  .issue_url == "https://api.github.com/repos/bugabinga/smith/issues/178"
' <<<"$OWNER_APPROVAL_COMMENT_JSON" >/dev/null
```

Expected: legacy `merge-gate` is intentionally absent and explicit owner bypass remains mandatory. Approval follows the signed planning-head push and current-head checks; its body binds PR #178 and exact post-commit `PR_HEAD`. Any mismatch stops cutover.

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

Expected: four required names present; `APP_CLIENT_ID` secret and variable both absent. Do not run `gh secret set` or `gh secret delete`. The first-attempt read is historical; this retry check must be current.

- [ ] **Step 2: Validate exact App bot variables already seeded**

```bash
gh variable list --repo bugabinga/smith --json name,value \
  --jq 'sort_by(.name) | map(select(.name == "APP_BOT_USER_ID" or .name == "APP_BOT_LOGIN"))'
```

Expected on the retry:

```json
[{"name":"APP_BOT_LOGIN","value":"agent-smith-bugabinga-adc[bot]"},{"name":"APP_BOT_USER_ID","value":"306488075"}]
```

The first-attempt read is retained above as history and does not complete this retry check.

- [ ] **Step 3: Freeze and recheck the owner-approved head**

```bash
PR=178
test "$PR_HEAD" = "$PLAN_HEAD"
test "$PR_HEAD" = "$(gh pr view 178 --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
test "$(git rev-parse origin/main)" = "$(gh api repos/bugabinga/smith/commits/main --jq .sha)"
test "$(git rev-parse origin/main)" = "9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd"
```

Expected: PR #178 remains on its exact owner-approved signed planning head and main remains exactly signed ninth rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd`.

- [ ] **Step 4: Create an encrypted/private rollback workspace and reverse patch**

```bash
ROLLBACK_ROOT="$HOME/.local/state/smith-adw-phase5-retry9-rollback"
mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
CUTOVER_BASE=9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd
test "$(git rev-parse origin/main)" = "$CUTOVER_BASE"
test "$(git merge-base origin/main "$PR_HEAD")" = "$CUTOVER_BASE"
test "$PR_HEAD" = "$(gh pr view 178 --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
git diff --binary "$CUTOVER_BASE" "$PR_HEAD" > "$ROLLBACK_ROOT/cutover.patch"
git diff --binary -R "$CUTOVER_BASE" "$PR_HEAD" > "$ROLLBACK_ROOT/rollback.patch"
sha256sum "$ROLLBACK_ROOT"/*.patch > "$ROLLBACK_ROOT/SHA256SUMS"
```

Expected: both patches derive only from signed rollback base `9a5d2ca` and the exact approved tenth-attempt head; the reverse patch restores the rollback tree and contains no secret values.

- [ ] **Step 5: Rehearse and sign rollback before merge**

```bash
REHEARSAL_WT=$(mktemp -d "$ROLLBACK_ROOT/rehearsal.XXXXXX")
git worktree add --detach "$REHEARSAL_WT" "$PR_HEAD"
git -C "$REHEARSAL_WT" apply --index "$ROLLBACK_ROOT/rollback.patch"
git -C "$REHEARSAL_WT" commit -S \
  -m "Restore legacy ADW control plane" \
  -m "Cutover rollback must stop new MJS writes before restoring legacy authority; history rewriting was dropped because rollback is modeled as a signed child of the protected tip." \
  -m "Anchor: .github/workflows/adw-*.yml restores the pre-cutover authority boundary."
REHEARSAL_SHA=$(git -C "$REHEARSAL_WT" rev-parse HEAD)
git -C "$REHEARSAL_WT" verify-commit "$REHEARSAL_SHA"
test "$(git -C "$REHEARSAL_WT" rev-parse HEAD^{tree})" = \
  "$(git rev-parse "$CUTOVER_BASE^{tree}")"
git branch -f fix/rollback-adw-mjs-phase5-retry9-rehearsal "$REHEARSAL_SHA"
git bundle create "$ROLLBACK_ROOT/rehearsal.bundle" \
  refs/heads/fix/rollback-adw-mjs-phase5-retry9-rehearsal
git bundle verify "$ROLLBACK_ROOT/rehearsal.bundle"
git worktree remove --force "$REHEARSAL_WT"
```

Expected: signed rehearsal commit verifies and its tree equals the pre-cutover tree. It is rehearsal only because GitHub's future squash SHA cannot be known before merge.

### Task 10: Disable and drain every legacy writer in the retry quiet window

**Files:** none

Legacy writers are currently active except `adw-release`; that rollback state is not a tenth-attempt drain. Disable and observe all 21 paths again inside PR #178's quiet window.

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
test "$(gh variable get ADW_MJS_CUTOVER_HOLD --repo bugabinga/smith)" = true
test "$(gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith)" = true
```

Expected: zero active legacy runs, all legacy workflows disabled, self-test active, production MJS wrappers not yet present on main, and the non-secret global cutover hold armed. If any new legacy run appears, cancel it and restart the zero-active observation; do not merge until stable.

### Task 11: Atomically squash-merge and materialize the cutover-child rollback

**Files:** none

- [ ] **Step 1: Revalidate exact head, checks, immutable owner comment, bypass, and drain immediately before merge**

```bash
set -euo pipefail
PR=178
test "$PR_HEAD" = "$PLAN_HEAD"
test "$PR_HEAD" = "$(gh pr view 178 --repo bugabinga/smith --json headRefOid --jq .headRefOid)"
test "$CUTOVER_BASE" = 9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd
test "$CUTOVER_BASE" = "$(gh api repos/bugabinga/smith/commits/main --jq .sha)"
test "$CUTOVER_BASE" = "$(git rev-parse origin/main)"
test "$(gh pr view 178 --repo bugabinga/smith --json mergeable --jq .mergeable)" = MERGEABLE
CUTOVER_CHECKS=$(gh api "repos/bugabinga/smith/commits/$PR_HEAD/check-runs?filter=latest&per_page=100")
jq -e --arg head "$PR_HEAD" '
  [.check_runs[] | select(.name == "check" and .head_sha == $head and
    .status == "completed" and .conclusion == "success")] | length >= 1
' <<<"$CUTOVER_CHECKS" >/dev/null
OWNER_APPROVAL_COMMENT_JSON=$(gh api \
  "repos/bugabinga/smith/issues/comments/$OWNER_APPROVAL_COMMENT_ID")
jq -e --argjson id "$OWNER_APPROVAL_COMMENT_ID" \
  --arg body "$OWNER_APPROVAL_MARKER" \
  --arg created "$OWNER_APPROVAL_COMMENT_CREATED_AT" \
  --arg head "$PR_HEAD" '
    .id == $id and
    .user.id == 876467 and .user.login == "bugabinga" and
    .author_association == "OWNER" and .body == $body and
    .body == ("Owner approval: quiet-window MJS production cutover tenth attempt and positive-only proof on PR #178 exact head " + $head + ".") and
    .created_at == $created and .updated_at == $created and
    .issue_url == "https://api.github.com/repos/bugabinga/smith/issues/178"
  ' <<<"$OWNER_APPROVAL_COMMENT_JSON" >/dev/null
test "$(sha256sum "$ROLLBACK_ROOT/cutover.patch" "$ROLLBACK_ROOT/rollback.patch")" = \
  "$(cat "$ROLLBACK_ROOT/SHA256SUMS")"
test "$(gh api repos/bugabinga/smith/rulesets/19155559 --jq .current_user_can_bypass)" = always
test "$(gh variable get ADW_MJS_CUTOVER_HOLD --repo bugabinga/smith)" = true
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

Expected: exact owner-approved head and main base, mergeable PR, green current-head product `check`, immutable exact-head owner comment, unchanged rollback patch hashes, explicit owner bypass for the absent legacy `merge-gate`, all legacy workflows disabled, and an explicitly created empty final-drain file.

- [ ] **Step 2: Perform the one atomic squash merge**

```bash
MERGE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr merge --admin --squash --delete-branch --match-head-commit "$PR_HEAD" "$PR" --repo bugabinga/smith
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

Expected: `verified:true`; active paths are exactly `adw-issues.yml`, `adw-operations.yml`, `adw-pulls.yml`, and `adw-selftest.yml`. Removed `adw-release` has no active replacement.

- [ ] **Step 4: Materialize the cutover-child signed rollback before proof writes**

```bash
ROLLBACK_WT=$(mktemp -d "$ROLLBACK_ROOT/parent-correct.XXXXXX")
git worktree add --detach "$ROLLBACK_WT" "$MERGE_SHA"
git -C "$ROLLBACK_WT" apply --index "$ROLLBACK_ROOT/rollback.patch"
git -C "$ROLLBACK_WT" commit -S \
  -m "Restore legacy ADW control plane" \
  -m "Cutover rollback must stop new MJS writes before restoring legacy authority; history rewriting was dropped because this prepared commit is a signed fast-forward child while main remains at the cutover SHA." \
  -m "Anchor: .github/workflows/adw-*.yml restores the pre-cutover authority boundary."
ROLLBACK_SHA=$(git -C "$ROLLBACK_WT" rev-parse HEAD)
test "$(git -C "$ROLLBACK_WT" rev-parse HEAD^)" = "$MERGE_SHA"
test "$(git -C "$ROLLBACK_WT" rev-parse HEAD^{tree})" = \
  "$(git rev-parse "$CUTOVER_BASE^{tree}")"
git -C "$ROLLBACK_WT" verify-commit "$ROLLBACK_SHA"
test -z "$(git ls-remote --heads origin refs/heads/fix/rollback-adw-mjs-phase5-retry9)"
git branch -f fix/rollback-adw-mjs-phase5-retry9 "$ROLLBACK_SHA"
git push origin refs/heads/fix/rollback-adw-mjs-phase5-retry9
git bundle create "$ROLLBACK_ROOT/parent-correct.bundle" \
  refs/heads/fix/rollback-adw-mjs-phase5-retry9
git bundle verify "$ROLLBACK_ROOT/parent-correct.bundle"
git worktree remove --force "$ROLLBACK_WT"
HOLD_CHECK=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  for workflow in adw-issues.yml adw-pulls.yml adw-operations.yml; do
    gh run list --repo bugabinga/smith --workflow "$workflow" --limit 100 \
      --json databaseId,createdAt |
      jq -r --arg start "$MERGE_START" --arg end "$HOLD_CHECK" \
        '.[] | select(.createdAt >= $start and .createdAt <= $end) | .databaseId'
  done
} | sort -u > "$ROLLBACK_ROOT/held-mjs-runs"
test -s "$ROLLBACK_ROOT/held-mjs-runs"
while read -r run; do
  run_json=$(gh api "repos/bugabinga/smith/actions/runs/$run")
  if ! jq -e '.status == "completed" and .conclusion == "skipped"' <<<"$run_json" >/dev/null; then
    printf 'held MJS run %s is not completed/skipped; retain hold and roll back\n' "$run" >&2
    exit 1
  fi
  gh api "repos/bugabinga/smith/actions/runs/$run/jobs?per_page=100" |
    jq -e '.total_count == 0 or all(.jobs[]; .conclusion == "skipped")' >/dev/null
  test "$(gh api "repos/bugabinga/smith/actions/runs/$run/artifacts" --jq .total_count)" = 0
done < "$ROLLBACK_ROOT/held-mjs-runs"
HOLD_RELEASE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh variable delete ADW_MJS_CUTOVER_HOLD --repo bugabinga/smith
if gh variable get ADW_MJS_CUTOVER_HOLD --repo bugabinga/smith >/dev/null 2>&1; then false; fi
test "$(gh variable get ADW_CUTOVER_HOLD --repo bugabinga/smith)" = true
```

Expected: prepared signed rollback is a direct child of the tenth cutover squash, restores exact base `9a5d2ca`, and is available at `fix/rollback-adw-mjs-phase5-retry9` plus the private bundle. All nine historical rollback branches and commits remain untouched. Every tenth-attempt run created under `ADW_MJS_CUTOVER_HOLD` must be `completed`/`skipped`, zero-artifact, and either zero-job or all-skipped before that independent hold is deleted. `ADW_CUTOVER_HOLD=true` remains permanent; queued old-path runs `30854346376` and `30859128166` are never cancellation or release blockers for the fresh identity.

- [ ] **Step 5: Verify only MJS can write**

```bash
gh workflow list --repo bugabinga/smith --all --json path,state \
  --jq '.[] | select(.state == "active" and (.path | startswith(".github/workflows/adw-"))) | .path' \
  | sort
```

Expected exactly:

```text
.github/workflows/adw-issues.yml
.github/workflows/adw-operations.yml
.github/workflows/adw-pulls.yml
.github/workflows/adw-selftest.yml
```

### Task 12: Run manual audit and reconciliation positive proof

**Files:** none; evidence is downloaded outside the repository

**Historical fourth- through ninth-attempt execution:** Fourth-attempt audit `30787720045` succeeded with a complete receipt; fifth and sixth attempts retained the partial/success evidence recorded above. Seventh-attempt run `30854346376` and eighth-attempt run `30859128166` never started a job and remain immutable queue evidence. Ninth audit `30884816241` and reconciliation `30884990977` completed, but dispatched child `30885142692` exited before artifact creation; signed rollback `9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd` restored legacy authority. Those runs do not complete the tenth retry; the unchecked commands below are its future procedure.

- [ ] **Step 1: Revalidate three organic proof states without mutation**

```bash
mkdir -p "$HOME/adw-phase5-evidence"
for pr in 163 165 166; do
  gh api "repos/bugabinga/smith/pulls/$pr" \
    --jq '{number,state,headRefOid:.head.sha,mergeableState:.mergeable_state,autoMergeRequest:.auto_merge,url:.html_url}'
done | jq -s '.' > "$HOME/adw-phase5-evidence/pre-audit-prs.json"
jq -e '
  length == 3 and
  all(.[];
    (.number == 163 or .number == 165 or .number == 166) and
    .state == "open" and .mergeableState == "behind")
' "$HOME/adw-phase5-evidence/pre-audit-prs.json" >/dev/null
```

Only the three still-open targets participate in live state counts, no-arm assertions, and open-proof evidence.

Capture immutable policy baselines before audit:

```bash
gh api repos/bugabinga/smith/rulesets/19155559 | jq -S . \
  > "$HOME/adw-phase5-evidence/ruleset.before.json"
gh api repos/bugabinga/smith | jq -S \
  '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}' \
  > "$HOME/adw-phase5-evidence/settings.before.json"
```

Expected: exactly three live targets are open and explicitly behind. If any differs, pause; never force it back or manufacture a hold.

- [ ] **Step 2: Dispatch owner manual audit**

```bash
AUDIT_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run adw-operations.yml --repo bugabinga/smith --ref main \
  -f lane=audit
AUDIT_RUN=$(gh run list --repo bugabinga/smith --workflow adw-operations.yml \
  --event workflow_dispatch --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$AUDIT_START" '
    [.[] | select(.createdAt >= $start and .displayTitle == "ADW maintenance audit")]
    | sort_by(.createdAt) | last | .databaseId')
[[ $AUDIT_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$AUDIT_RUN" --repo bugabinga/smith --exit-status
```

Expected: success; auditor provider jobs skipped; existing label drift repaired only for checked-in labels; settings/ruleset drift reported through an owner-visible issue; #163/#165/#166 receive explicit-behind failure checks.

- [ ] **Step 3: Capture and validate audit artifacts/receipt**

Run `capture_run "$AUDIT_RUN" provider-free "$MERGE_SHA" "$MERGE_SHA"`. Then assert:

```bash
AUDIT_DIR="$HOME/adw-phase5-evidence/$AUDIT_RUN/download"
test -z "$(find "$AUDIT_DIR" -maxdepth 1 -type d -name 'adw-assessment-*' -print)"
jq -e '.authority.name == "auditor" and .status == "complete"' \
  "$AUDIT_DIR"/adw-apply-result-1/result.json >/dev/null
jq -e '
  [.operations[] | select(
    .type == "arm_auto_merge" and
    (.prId == "163" or .prId == "165" or .prId == "166"))] | length == 0
' "$AUDIT_DIR"/adw-decision/decision.json >/dev/null
gh api repos/bugabinga/smith/labels/urgent \
  --jq '.color == "e03131" and .description == "Time-critical work; planner ranks it before equal- or lower-priority backlog items."'
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

Expected: no assessment artifacts; complete auditor receipt; no auto-merge operation for the three explicit behind/dirty PRs; exact `urgent` repair; byte-equivalent live ruleset/settings snapshots; and an App-authored drift report URL.

- [ ] **Step 4: Prove current-head App checks and independently fail-closed merge states**

```bash
for pr in 163 165 166; do
  head=$(gh pr view "$pr" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
  gh api "repos/bugabinga/smith/commits/$head/check-runs?filter=latest&per_page=100" |
    jq -e --arg head "$head" '
      ([.check_runs[] | select(.name == "check" and .head_sha == $head and .app.slug == "github-actions" and .status == "completed" and .conclusion == "success")] | length >= 1) and
      ([.check_runs[] | select(.name == "merge-gate" and .head_sha == $head and .app.slug == "agent-smith-bugabinga-adc" and .app.id != null and .status == "completed" and .conclusion == "failure")] | length >= 1)
    ' >/dev/null
  test "$(gh pr view "$pr" --repo bugabinga/smith --json state --jq .state)" = OPEN
done
```

Expected: all three explicit behind PRs have green product checks, failing current-head App gates, remain open, and cannot arm.

- [ ] **Step 5: Dispatch owner manual reconciliation**

```bash
RECONCILE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run adw-operations.yml --repo bugabinga/smith --ref main \
  -f lane=reconcile
RECONCILE_RUN=$(gh run list --repo bugabinga/smith --workflow adw-operations.yml \
  --event workflow_dispatch --limit 20 --json databaseId,createdAt,displayTitle |
  jq -er --arg start "$RECONCILE_START" '
    [.[] | select(.createdAt >= $start and .displayTitle == "ADW maintenance reconcile")]
    | sort_by(.createdAt) | last | .databaseId')
[[ $RECONCILE_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$RECONCILE_RUN" --repo bugabinga/smith --exit-status
```

Expected: success; no provider job runs unless reconciliation positively dispatches a missing real obligation/review through the closed internal path. Such a child run is recorded, not induced.

> **Historical fourth-attempt blocker:** Run `30788000713` failed in prepare before any artifact upload with `operational pull run entity is malformed`. No child dispatch, apply, write, or receipt occurred, and rollback followed; this does not complete the tenth-attempt step.

- [ ] **Step 6: Capture reconciliation and any child runs**

Run `capture_run "$RECONCILE_RUN" provider-free "$MERGE_SHA" "$MERGE_SHA"`. For each `dispatch_repository` receipt, require exactly one child run identity with event `repository_dispatch`, the closed workflow path for its event type, operation digest as display title, actor ID/login `306488075`/`agent-smith-bugabinga-adc[bot]`, `main` at the trusted control head, creation at or after the parent receipt's created-after boundary, and its complete attempt lineage. Call `capture_run` with the intent's canonical provider lane, `"$MERGE_SHA"` as expected run head, `"$MERGE_SHA"` as trusted control SHA, and the explicit attempt when it is greater than one. For example, a recovered provider-free run is captured only after all four values are read from the forge:

```bash
capture_run "$RECOVERED_RUN" provider-free "$RECOVERED_HEAD" "$MERGE_SHA" "$RECOVERED_ATTEMPT"
```

Use the canonical provider lane instead of `provider-free` for a recovered provider run. A failed child proves delivery only and must have one separate attempt-bound rerun receipt.

Expected: parent receipt and every natural child receipt complete; duplicate exact runs fail closed, failed children never cause duplicate dispatch, and no duplicate operation digest is accepted.

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

Run `capture_run "$TRIAGE_RUN" provider-codex "$MERGE_SHA" "$MERGE_SHA"`, then:

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

Run `capture_run "$STEER_RUN" provider-claude "$MERGE_SHA" "$MERGE_SHA"`, then:

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

- [ ] **Step 1: Create one benign file-level review comment on #163's exact head**

```bash
PR_PROOF=163
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

Run `capture_run "$REVIEW_COMMENT_RUN" provider-free "$REVIEW_HEAD" "$MERGE_SHA"`, then:

```bash
jq -e '[.jobs[] | select((.name | test("primary-|fallback-| / reduce$")) and .conclusion != "skipped")] | length == 0' \
  "$HOME/adw-phase5-evidence/$REVIEW_COMMENT_RUN/run.json" >/dev/null
jq -e '.authority.name == "reconciler"' \
  "$HOME/adw-phase5-evidence/$REVIEW_COMMENT_RUN/download/adw-apply-result-1/result.json" >/dev/null
test "$(gh pr view "$PR_PROOF" --repo bugabinga/smith --json state --jq .state)" = OPEN
test "$(gh pr view "$PR_PROOF" --repo bugabinga/smith --json headRefOid --jq .headRefOid)" = "$REVIEW_HEAD"
```

Expected: all provider/reduce jobs skipped, reconciler receipt complete, and open PR #163 unchanged.

- [ ] **Step 4: Identify the check-triggered reconcile-only run from audit's MJS check**

```bash
CHECK_RUN=$(gh run list --repo bugabinga/smith --workflow adw-pulls.yml \
  --event check_run --limit 50 --json databaseId,createdAt,headSha,displayTitle |
  jq -er --arg head "$REVIEW_HEAD" --arg title "ADW pull #$PR_PROOF" '
    [.[] | select(.headSha == $head and .displayTitle == $title)]
    | sort_by(.createdAt) | last | .databaseId')
[[ $CHECK_RUN =~ ^[1-9][0-9]*$ ]]
gh run watch "$CHECK_RUN" --repo bugabinga/smith --exit-status
```

If GitHub emitted `check_suite` rather than `check_run`, select the matching `check_suite` run instead; do not create another check.

Run `capture_run "$CHECK_RUN" provider-free "$REVIEW_HEAD" "$MERGE_SHA"`, then:

```bash
jq -e '[.jobs[] | select((.name | test("primary-|fallback-| / reduce$")) and .conclusion != "skipped")] | length == 0' \
  "$HOME/adw-phase5-evidence/$CHECK_RUN/run.json" >/dev/null
```

Expected: reconcile-only graph, all provider/reduce jobs skipped, no provider assessment, exact current head, complete receipt.

- [ ] **Step 5: Prove current-head App review evidence remains exact**

```bash
for pr in 163 165 166; do
  head=$(gh pr view "$pr" --repo bugabinga/smith --json headRefOid --jq .headRefOid)
  gh api --paginate "repos/bugabinga/smith/issues/$pr/comments?per_page=100" |
    jq -e --arg head "$head" '
      def app: .user.id == 306488075 and .user.login == "agent-smith-bugabinga-adc[bot]" and .user.type == "Bot";
      ([.[] | select(app and (((.body | startswith("Review: " + $head)) and (.body | contains("\nVERDICT: reviewed"))) or (.body | test("smith:review-evidence/v1 kind=correctness head=" + $head + " conclusion=approve .*authoritative=true"))))] | length >= 1) and
      ([.[] | select(app and (((.body | startswith("Security review: " + $head)) and (.body | contains("\nVERDICT: security-cleared"))) or (.body | test("smith:review-evidence/v1 kind=security head=" + $head + " conclusion=approve .*authoritative=true"))))] | length >= 1)' >/dev/null
done
```

Expected: each of the three still-open PRs has one-or-more exact current-head App-authored positive records for correctness and security. Duplicate positives are valid; reject, stale-head, malformed, or wrong-actor records never satisfy either kind.

### Task 15: Reconcile #163/#165/#166 and observe two schedule cycles

**Files:** none

- [ ] **Step 1: Verify explicit behind/dirty PRs did not auto-merge during proof**

```bash
for pr in 163 165 166; do
  gh pr view "$pr" --repo bugabinga/smith \
    --json number,state,mergedAt,headRefOid,mergeStateStatus,url
done | jq -s '.' > "$HOME/adw-phase5-evidence/post-proof-prs.json"
jq -e '
  length == 3 and
  all(.[];
    (.number == 163 or .number == 165 or .number == 166) and
    .state == "OPEN" and .mergedAt == null)
' "$HOME/adw-phase5-evidence/post-proof-prs.json" >/dev/null
```

Expected: exactly three explicit behind/dirty proof PRs remain open and unmerged.

- [ ] **Step 2: Wait for first natural six-hour reconciliation schedule**

Select the first `schedule` run of `adw-operations.yml` after `MERGE_SHA` whose run name/lane is `maintenance-reconcile` (`7 */6 * * *`). Do not use manual dispatch as a schedule substitute.

```bash
set -euo pipefail
CYCLE1_DEADLINE=$(( $(date -d "$QUIET_START" +%s) + 7 * 3600 ))
CYCLE1=
while test -z "$CYCLE1"; do
  test "$(gh api repos/bugabinga/smith/commits/main --jq .sha)" = "$MERGE_SHA"
  CYCLE1=$(gh run list --repo bugabinga/smith --workflow adw-operations.yml \
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
  CYCLE2=$(gh run list --repo bugabinga/smith --workflow adw-operations.yml \
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

Run `capture_run "$CYCLE1" provider-free "$MERGE_SHA" "$MERGE_SHA"` and `capture_run "$CYCLE2" provider-free "$MERGE_SHA" "$MERGE_SHA"`. Then:

```bash
for run in "$CYCLE1" "$CYCLE2"; do
  dir="$HOME/adw-phase5-evidence/$run/download"
  test -z "$(find "$dir" -maxdepth 1 -type d -name 'adw-assessment-*' -print)"
  jq -e '.authority.name == "reconciler" and .status == "complete"' \
    "$dir"/adw-apply-result-1/result.json >/dev/null
done
CYCLE2_CREATED=$(gh run view "$CYCLE2" --repo bugabinga/smith --json createdAt --jq .createdAt)
test "$(gh run list --repo bugabinga/smith --workflow adw-operations.yml \
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

- [ ] **Step 5: Final current-head and independent-blocker assertions**

Re-run Task 12 Step 4, Task 14 Step 5, and Task 15 Step 1. Expected: exact current-head App evidence/checks remain valid for all three live targets; they remain open; no receipt arms them.

### Task 16: Publish evidence and close the quiet window

**Files:** none; post evidence to the already-merged cutover PR

- [ ] **Step 1: Build a redacted evidence manifest**

```bash
EVIDENCE_ROOT="$HOME/adw-phase5-evidence"
ACTIVE_ADW=$(gh workflow list --repo bugabinga/smith --all --json path,state |
  jq -r '.[] | select(.state == "active" and (.path | startswith(".github/workflows/adw-"))) | .path' | sort)
test "$ACTIVE_ADW" = $'.github/workflows/adw-issues.yml\n.github/workflows/adw-operations.yml\n.github/workflows/adw-pulls.yml\n.github/workflows/adw-selftest.yml'
mapfile -t decisions < <(find "$EVIDENCE_ROOT" -path '*/adw-decision/decision.json' -type f | sort)
test "${#decisions[@]}" -ge 8
for decision in "${decisions[@]}"; do
  jq -e '
    [.operations[] | select(
      .type == "arm_auto_merge" and
      (.prId == "163" or .prId == "165" or .prId == "166"))]
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
prepared signed rollback SHA/branch, its `MERGE_SHA` parent, and verify-commit result; if rollback ran after main movement, also record the new rollback SHA/current-main parent, cutover-owned path proof, and GitHub verification
legacy disabled/drained count (21 workflows, zero active runs)
active ADW inventory (three MJS wrappers plus self-test)
manual audit and reconcile run URLs
Codex triager and Claude steerer run URLs
review-comment and check reconcile-only run URLs
both natural schedule-cycle run URLs
artifact IDs/names and receipt status for every run
APP bot ID/login evidence
#163/#165/#166 exact heads, merge states, App evidence/check IDs, and open status
label drift repair result and settings/ruleset drift report URL
statement that no secret was rotated and no malformed/stale/failure/partial production injection occurred
```

Use `gh pr comment "$PR" --repo bugabinga/smith --body-file <generated-redacted-summary>`.

- [ ] **Step 3: Close quiet window only after owner acceptance**

Owner comments acceptance on the evidence. Normal main merges may resume. Keep `fix/rollback-adw-mjs-phase5-retry9` until Phase 6 explicitly retires it; retain historical rollback refs through `fix/rollback-adw-mjs-phase5-retry8` as first- through ninth-attempt evidence.

Expected after a fully proved tenth cutover: owner acceptance may complete Phase 5. Earlier audit, receipt, stale-rejection, queue-failure, rollback, diagnostic, and fresh-path evidence remains historical. The tenth attempt remains unexecuted; Phase 6 remains separate.

## Rollback triggers and exact procedure

Trigger rollback immediately on any of:

- any active legacy writer after MJS activation;
- any operational ADW writer outside the three MJS wrappers;
- App token mint failure from `APP_ID`/private key or unexpected minted permission;
- provider job with forge credential, apply job with provider credential, or secret in log/artifact;
- malformed/missing artifact, sidecar mismatch, incomplete/failed receipt, stale write reaching mutation, or duplicate operation digest;
- current-head `check`/`merge-gate` or App evidence bound to a different head/actor;
- review-comment/check path executing a provider;
- any explicit behind/dirty proof PR being armed or merged;
- settings/ruleset mutation;
- unbounded provider recursion from label/App comments;
- either required schedule cycle missing, failing, cancelling, or running on unexpected control SHA;
- any tenth-attempt run created under `ADW_MJS_CUTOVER_HOLD` not reaching `completed`/`skipped` with zero artifacts and zero jobs or only skipped jobs before that independent hold is released;
- any attempt to delete or set false the permanent orphan barrier `ADW_CUTOVER_HOLD=true`;
- any unexpected movement of `main` after cutover and before Phase 5 acceptance;
- any need to rotate a production secret or manufacture a failure to continue proof.

Rollback from the owner shell:

```bash
set -euo pipefail
REPO=bugabinga/smith
PR=178
gh pr view "$PR" --repo "$REPO" --json number,headRefName,baseRefName |
  jq -e '.number == 178 and .headRefName == "adw/mjs-phase5-retry9" and .baseRefName == "main"' >/dev/null
ROLLBACK_ROOT="$HOME/.local/state/smith-adw-phase5-retry9-rollback"
EXPECTED_CUTOVER_BASE=9a5d2caeefbf1cd23ec7ee90045a9655676cf8bd
mjs=(adw-issues.yml adw-pulls.yml adw-operations.yml)

# Contain first: no rollback ref or main-head inspection precedes MJS disable/drain.
for workflow in "${mjs[@]}"; do
  gh workflow disable "$workflow" --repo "$REPO"
done
while :; do
  active=$(
    for workflow in "${mjs[@]}"; do
      gh api --paginate \
        "repos/$REPO/actions/workflows/$workflow/runs?per_page=100" \
        --jq '.workflow_runs[] | select(.status != "completed") | .id'
    done | sort -u
  )
  if test -z "$active"; then
    break
  fi
  while read -r run; do
    test -z "$run" && continue
    if ! gh run cancel "$run" --repo "$REPO"; then
      test "$(gh run view "$run" --repo "$REPO" --json status --jq .status)" = completed
    fi
  done <<<"$active"
  sleep 15
done
workflow_states=$(gh workflow list --repo "$REPO" --all --json path,state)
for workflow in "${mjs[@]}"; do
  jq -e --arg path ".github/workflows/$workflow" '
    [.[] | select(.path == $path and .state == "disabled_manually")] | length == 1
  ' <<<"$workflow_states" >/dev/null
done

# Bind artifacts and both candidate commits only after containment.
git fetch --no-tags origin
MERGE_SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit --jq .mergeCommit.oid)
CUTOVER_BASE=$(git rev-parse "$MERGE_SHA^")
test "$CUTOVER_BASE" = "$EXPECTED_CUTOVER_BASE"
CURRENT_MAIN=$(git rev-parse origin/main)
test "$CURRENT_MAIN" = "$(gh api "repos/$REPO/commits/main" --jq .sha)"
git merge-base --is-ancestor "$MERGE_SHA" "$CURRENT_MAIN"
sha256sum --check "$ROLLBACK_ROOT/SHA256SUMS"
PREPARED_ROLLBACK_SHA=$(git rev-parse origin/fix/rollback-adw-mjs-phase5-retry9)
test "$(git rev-parse "$PREPARED_ROLLBACK_SHA^")" = "$MERGE_SHA"
test "$(git rev-parse "$PREPARED_ROLLBACK_SHA^{tree}")" = \
  "$(git rev-parse "$CUTOVER_BASE^{tree}")"
git verify-commit "$PREPARED_ROLLBACK_SHA"
CUTOVER_OWNED="$ROLLBACK_ROOT/cutover-owned.paths"
APPLIED_PATHS="$ROLLBACK_ROOT/applied.paths"
UNEXPECTED_PATHS="$ROLLBACK_ROOT/unexpected.paths"
git diff --no-renames --name-only -z "$CUTOVER_BASE" "$MERGE_SHA" -- |
  sort -z > "$CUTOVER_OWNED"
test -s "$CUTOVER_OWNED"

if test "$CURRENT_MAIN" = "$MERGE_SHA"; then
  # The prepared signed child is valid only for this unchanged-main case.
  ROLLBACK_SHA=$PREPARED_ROLLBACK_SHA
else
  # Preserve later commits by making a new signed child of current main.
  ROLLBACK_WT=$(mktemp -d "$ROLLBACK_ROOT/current-main.XXXXXX")
  git worktree add --detach "$ROLLBACK_WT" "$CURRENT_MAIN"
  if ! git -C "$ROLLBACK_WT" apply --3way --index \
    "$ROLLBACK_ROOT/rollback.patch"; then
    printf 'rollback patch conflicted; leave worktree for inspection and abort\n' >&2
    exit 1
  fi
  test -z "$(git -C "$ROLLBACK_WT" ls-files --unmerged)"
  git -C "$ROLLBACK_WT" diff --quiet --
  git -C "$ROLLBACK_WT" diff --cached --check
  git -C "$ROLLBACK_WT" diff --cached --no-renames --name-only -z \
    "$CURRENT_MAIN" -- | sort -z > "$APPLIED_PATHS"
  test -s "$APPLIED_PATHS"
  comm -z -13 "$CUTOVER_OWNED" "$APPLIED_PATHS" > "$UNEXPECTED_PATHS"
  test ! -s "$UNEXPECTED_PATHS"
  while IFS= read -r -d '' path; do
    git -C "$ROLLBACK_WT" diff --cached --quiet "$CUTOVER_BASE" -- "$path"
  done < "$CUTOVER_OWNED"
  git -C "$ROLLBACK_WT" commit -S \
    -m "Restore legacy ADW control plane" \
    -m "Main advanced after cutover, so reusing the prepared child would not fast-forward. Reversing only cutover-owned paths preserves unrelated later commits while restoring pre-cutover authority." \
    -m "Anchor: .github/workflows/adw-*.yml restores the pre-cutover authority boundary."
  ROLLBACK_SHA=$(git -C "$ROLLBACK_WT" rev-parse HEAD)
  test "$(git -C "$ROLLBACK_WT" rev-parse HEAD^)" = "$CURRENT_MAIN"
  git -C "$ROLLBACK_WT" diff --no-renames --name-only -z \
    "$CURRENT_MAIN" "$ROLLBACK_SHA" -- | sort -z > "$APPLIED_PATHS"
  comm -z -13 "$CUTOVER_OWNED" "$APPLIED_PATHS" > "$UNEXPECTED_PATHS"
  test ! -s "$UNEXPECTED_PATHS"
  while IFS= read -r -d '' path; do
    git -C "$ROLLBACK_WT" diff --quiet "$CUTOVER_BASE" "$ROLLBACK_SHA" -- "$path"
  done < "$CUTOVER_OWNED"
  git -C "$ROLLBACK_WT" verify-commit "$ROLLBACK_SHA"
fi

# Recheck parent, owner bypass, and remote main immediately before a plain push.
test "$(git rev-parse "$ROLLBACK_SHA^")" = "$CURRENT_MAIN"
git verify-commit "$ROLLBACK_SHA"
gh api user | jq -e '.id == 876467 and .login == "bugabinga"' >/dev/null
test "$(gh api repos/bugabinga/smith/rulesets/19155559 \
  --jq .current_user_can_bypass)" = always
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$CURRENT_MAIN"
git push origin "$ROLLBACK_SHA:refs/heads/main"
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$ROLLBACK_SHA"
test "$(gh api "repos/$REPO/commits/$ROLLBACK_SHA" \
  --jq .commit.verification.verified)" = true
if test -n "${ROLLBACK_WT:-}"; then
  git worktree remove "$ROLLBACK_WT"
fi

# Restore legacy authority only after the rollback commit is remote and verified.
for workflow in \
  adw-alerts.yml adw-automerge.yml adw-build.yml adw-codex-build.yml \
  adw-codex-review.yml adw-comment.yml adw-deps.yml adw-docs.yml \
  adw-doctor.yml adw-gate.yml adw-intake.yml adw-jam-detector.yml \
  adw-labels.yml adw-pioneer.yml adw-plan.yml adw-review.yml \
  adw-revise.yml adw-settings-audit.yml adw-survey.yml adw-sweep.yml; do
  gh workflow enable "$workflow" --repo "$REPO"
done
gh workflow disable adw-release.yml --repo "$REPO"
```

Expected: MJS is disabled and drained before rollback selection. Unchanged main receives the prepared verified child; advanced main receives a newly signed, verified direct child whose staged paths are a subset of cutover-owned paths, whose cutover-owned paths equal `CUTOVER_BASE`, and whose other paths retain current-main state. A conflict, unexpected path, signature failure, lost bypass, or main race aborts before push. The plain fast-forward push uses confirmed owner bypass; no force-push or reset occurs. Legacy writers are enabled only after the remote rollback verifies; `adw-release` remains disabled. Record irreversible forge effects honestly.

## Phase boundary

Phase 5 remains incomplete after nine cutovers through `7497f61` and signed rollbacks through `9a5d2ca`. Ninth audit `30884816241` and reconciliation `30884990977` are positive receipt evidence, but Claude child `30885142692` failed before assessment. Diagnostics `30886814052`, `30887204135`, `30887382006`, `30888153701`, and `30888436716` isolated explicit draft-2020 `$schema`; exact no-forge replay `30889239515` completed `invoke=success` after removing only that declaration. All temporary classifier files are absent. Owner-authored PR #178 on `adw/mjs-phase5-retry9` remains at signed aggregate `28f84ba7055b437fb95fb4a5462da89b6d6d3e6b` until the future signed planning-head push and exact-head approval. `ADW_CUTOVER_HOLD=true` permanently contains corrupted identity `325210492`; `ADW_MJS_CUTOVER_HOLD=true` remains the current tenth-retry barrier. No scheduled-cycle proof or completion claim exists. Phase 5 still requires a future GitHub-verified cutover, parent-correct signed rollback, positive receipts, fail-closed candidates, and two green scheduled cycles; Phase 6 remains separate.
