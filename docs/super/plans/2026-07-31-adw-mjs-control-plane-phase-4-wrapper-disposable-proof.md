# ADW Wrapper and Disposable-Repository Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the MJS read/assess/reduce/verify/apply path, encode three inactive thin wrappers, and prove the exact write/failure/retry/merge behavior in a separately scoped disposable repository without changing production authority.

**Architecture:** `main.mjs` composes the existing pure reducers and leaf adapters into artifact-bound commands. `github.mjs` and `vcs.mjs` gain only closed, preconditioned write methods; providers and verification remain tokenless. Exact candidate wrappers live under `prototypes/p38-adw-disposable/wrappers/`, where GitHub cannot activate them in production, and are copied unchanged into the disposable repository for live proof.

**Tech Stack:** Node.js ESM/standard library, `node:test`, `gh`, `git`, exact-pinned Claude/Codex CLIs, GitHub Actions artifacts.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 4: Wrapper and Disposable-Repository Proof

---

## Locked boundaries

- Production legacy workflows remain enabled and authoritative throughout this phase.
- No candidate wrapper exists directly under production `.github/workflows/`.
- `pull_request_review_comment` and check events wake reconciliation only; they never dispatch a provider role.
- Repository settings/rulesets are read-only. Drift creates a bounded owner issue/comment; MJS never mutates owner policy.
- Provider jobs receive one provider credential and no forge token, persisted checkout credential, opposite-provider secret, or SSH agent.
- Verify receives no secrets and never executes target code. Apply receives only the operation-scoped App token and never executes target code.
- Every write uses repository-wide `adw-write` concurrency with `cancel-in-progress: false`.
- Release automation and Projects v2 remain absent.

## External proof gate

Before Task 7, the owner must provide a separately scoped disposable GitHub App with no production access, its private key/provider credentials, and an owner bootstrap token allowed to create/delete one synthetic repository and add/remove it from that App installation. Task 7 creates the repository; it need not pre-exist. Exact inputs are bootstrap token, owner/repository name, App ID/login/installation ID, owner numeric ID, installation-permission digest, minted-scope digest, job-permission digest, and the four workflow secrets. Bootstrap authority remains local to the harness and never enters repository Actions. Missing scope or credentials blocks live proof; it never weakens tests or redirects writes to production.

## File map

- `adw/main.mjs`: command composition, bounded artifact input/output, command-specific environment contract, exit codes.
- `adw/github.mjs`: full-fidelity ruleset/merge-state reads and the sole closed GitHub writer.
- `adw/vcs.mjs`: exact verified-patch commit/push path with hooks, filters, credentials, and target execution disabled.
- `adw/permissions.json`: three separate contracts: installation permission union, per-operation minted App-token scopes, and minimal read-only/none job `GITHUB_TOKEN` permissions.
- `adw/test/transport.test.mjs`: artifact names, hashes, control SHA, bounds, and command composition.
- `adw/test/apply.test.mjs`: write preconditions, idempotency, stale state, partial retry, and no-execution tests.
- `adw/test/wrappers.test.mjs`: inactive wrapper triggers, refs, permissions, secrets, artifacts, concurrency, and policy-absence contracts.
- `adw/test/live/disposable.mjs`: opt-in live disposable-repository assertions, excluded from the offline `*.test.mjs` glob, using only closed adapters plus the external bootstrap boundary.
- `prototypes/p38-adw-disposable/wrappers/`: exact inactive issue, pull, and maintenance wrapper candidates.
- `prototypes/p38-adw-disposable/NOTES.md`: environment identity, run URLs, failure injection, cleanup, and result evidence; no secrets.
- `prototypes/PLAN.md`: compact Phase 4 proof result.

### Task 1: Close live-read gaps exposed by production

**Files:**

- Modify: `adw/github.mjs`
- Modify: `adw/core.mjs`
- Modify: `adw/roles.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/test/core.test.mjs`
- Modify: `adw/test/roles.test.mjs`

- [x] Write failing tests proving ruleset snapshots include canonical conditions, every rule parameter, bypass actors, enforcement, and target—not only rule types/list summaries. A live `strict_required_status_checks_policy:true` value against checked-in `false` must produce drift.
- [x] Run `node --test --test-name-pattern='ruleset|settings drift' adw/test/{github,roles}.test.mjs`; expect missing detail/drift failures.
- [x] Add fixed `ruleset(id)` reads after the bounded list call; normalize exact full rulesets and reject pagination, unknown shapes, duplicate IDs, or omitted required parameters. Do not expose a generic endpoint.
- [x] Map deterministic settings comparison to `report_drift` with one deterministic marker; settings remain read-only.
- [x] Write failing tests that a current-head PR with successful required checks and verdict evidence but live `BEHIND`/`BLOCKED` merge state becomes a jam finding rather than a no-op.
- [x] Add bounded per-open-PR merge-state enrichment and jam reduction. Historical failed checks do not override the latest run of the same check context; latest successful reruns qualify.
- [x] Pin review-comment/check dispatch as reconcile-only in table tests; no `ROLE_EVENTS` entry may accept either event.
- [x] Run `node --test adw/test/{core,github,roles,scenarios}.test.mjs`; expect PASS.
- [x] Commit: `Close live ADW state gaps before write proof`.

### Task 2: Exact artifact transport and missing CLI commands

**Files:**

- Modify: `adw/main.mjs`
- Create: `adw/test/transport.test.mjs`
- Modify: `adw/test/main.test.mjs`

- [x] Write failing tests for `prepare`, `assess --provider`, `reduce`, and `verify` using injected adapters and external temporary directories.
- [x] Require the fixed transport tree:

```text
adw-snapshot/{snapshot.json,snapshot.sha256}
adw-assessment-claude/{envelope.json,envelope.sha256,change.patch?,change.patch.sha256?}
adw-assessment-codex/{envelope.json,envelope.sha256,change.patch?,change.patch.sha256?}
adw-decision/{decision.json,decision.sha256,change.patch?,change.patch.sha256?}
adw-verification/{verification.json,verification.sha256,change.patch?,change.patch.sha256?}
adw-apply-result/{result.json,result.sha256}
adw-source/{control/**,target.bundle,manifest.json,manifest.sha256}
```

- [x] Reject symlinks, non-regular files, extra files, missing siblings, digest mismatch, documents above 256 KiB, patches above 1 MiB, wrong control SHA, wrong snapshot/decision/precondition digest, and artifact paths overlapping either checkout.
- [x] `prepare` creates a trusted `control/` artifact containing only the exact control-SHA `adw/**` plus required charters/schemas, and an immutable hardened target Git bundle plus manifest binding repository IDs, refs, SHAs, path-tree/blob digests, and sizes. Every tokenless downstream job—provider, reduce, and verify—uses `actions/download-artifact` as its credential-free CI transport bootstrap and executes `control/adw/main.mjs` directly; provider/verify materialize `target.bundle` only when required. They perform no forge checkout and receive no forge credential. Bundle materialization disables hooks, filters, fsmonitor, credentials, and file protocol and rejects refs/objects outside the manifest.
- [x] `prepare` reads only the trusted event path through `github.mjs`, derives the canonical role policy, and writes one snapshot artifact.
- [x] `assess` installs one exact-pinned CLI in `RUNNER_TEMP`, accepts exactly one provider credential, invokes one provider, and writes only that provider's assessment artifact.
- [x] `reduce` accepts primary/fallback artifacts according to canonical role policy; missing/malformed primary reaches the one permitted fallback state rather than widening authority.
- [x] `verify` emits a state or patch verification using `vcs.mjs`; it has no credential fields or target-execution callback.
- [x] Preserve existing stdin fixture commands. New operational commands use fixed `ADW_*` environment names validated as exact absolute paths/IDs; unknown or cross-command variables are ignored because wrappers pass explicit env allowlists.
- [x] Run `node --test adw/test/{main,transport,providers,vcs}.test.mjs`; expect PASS.
- [x] Commit: `Bind ADW commands to exact transport artifacts`.

### Task 3: Closed, preconditioned GitHub writes

**Files:**

- Modify: `adw/github.mjs`
- Create: `adw/test/apply.test.mjs`
- Modify: `adw/test/github.test.mjs`
- Modify: `adw/roles.mjs`
- Modify: `adw/test/roles.test.mjs`

- [x] Write failing argv/stdin tests for every GitHub-owned operation in `OPERATIONS`: comments, targeted labels, issues, milestones, sub-issue links, PR metadata/create, checks, reruns, dispatch, squash auto-merge, label sync, drift reporting, no-op, and terminal failure. Assert `github.mjs` rejects `create_branch` and patch-bearing `update_pr`, which belong exclusively to `vcs.mjs`.
- [x] Add `applyOperation({ operation, snapshot, verification })`; it validates a GitHub-owned canonical operation and re-reads only revisions named by the snapshot before mutation. Any changed precondition returns `AdwError("stale", ...)` before the first write.
- [x] Use fixed methods and JSON request bodies only. No caller-provided URL, host, HTTP method, GraphQL document, or arbitrary `gh` argument exists.
- [x] Search deterministic markers/external IDs before creates. Equivalent comments/issues/milestones/checks/PRs are success; conflicting duplicates fail closed.
- [x] Label operations add/remove one named label and never replace full sets. Auto-merge verifies PR ID/head, current `check`, both current-head App evidence markers, no hold/sticky risk, and method `squash` before arming.
- [x] `sync_labels` reads the trusted control-SHA definition, validates its digest, and changes only definitions named there. Rulesets/settings remain outside the write capability.
- [x] Define an apply receipt as `{ decisionDigest, verificationDigest, operations: [{ operationDigest, status, beforeRevision, preparedRevision, afterRevision }] }`. Each operation has an explicit transition table accepting exactly original → prepared-marker → expected post-state; snapshot revision checks include those own-write states, so a marker/comment digest created by this decision is not mistaken for external drift. Any state outside that table is stale. On retry, reconstruct authority from forge markers/external IDs/natural state—not a local artifact. Prepared rerun/dispatch operations search bounded runs after marker time before retrying. `adw-apply-result` is uploaded with `if:always()` as evidence/cache, but forge state is durable authority across workflow reruns.
- [x] Assert all errors are sanitized and no token/provider content appears in argv, stdout, stderr, or exceptions.
- [x] Run `node --test adw/test/{github,apply}.test.mjs`; expect PASS.
- [x] Commit: `Apply closed forge operations with live preconditions`.

### Task 4: Exact verified-patch commit and push

**Files:**

- Modify: `adw/vcs.mjs`
- Modify: `adw/test/vcs.test.mjs`
- Modify: `adw/test/apply.test.mjs`

- [x] Write failing real-temporary-repository tests for state-only decisions, new branch/PR patches, reviser updates, retries, stale base/head, non-fast-forward rejection, signing behavior, and cleanup.
- [x] Add `applyVerifiedPatch(...)` that owns `create_branch` and the `headSha` projection of patch-bearing `update_pr`: it reuses exact attested bytes and expected `resultTree`, then creates the commit through Git plumbing with hooks, filters, fsmonitor, credential helpers, file protocol, and target execution disabled. `main.mjs` decomposes one `update_pr` operation digest into ordered VCS-head and GitHub-metadata subreceipts; complete means both subreceipts reached their expected post-state. `github.mjs` owns only optional title/body projection and subsequent PR create/metadata; it never creates or moves patch branches.
- [x] Permit only the verified branch/ref target from the decision. Push through an injected short-lived credential configuration; never write credentials into repository config, remote URLs, worktrees, or artifacts.
- [x] Treat an existing branch whose head tree equals the attested `resultTree` and whose parent/base matches the decision as idempotent success regardless of commit timestamp/ID; any different tree/parent is stale/conflict. This deterministic post-state is the durable VCS receipt. Never force-push.
- [x] Verify the resulting commit/tree before push and remove every temporary index, patch, auth file, and worktree in `finally`; cleanup failure is terminal.
- [x] Assert no checked-out target executable, build script, hook, filter, test, or package command runs.
- [x] Run `node --test adw/test/{vcs,apply}.test.mjs`; expect PASS.
- [x] Commit: `Push only attested ADW patch trees`.

### Task 5: Apply, reconcile, and audit composition

**Files:**

- Modify: `adw/main.mjs`
- Modify: `adw/core.mjs`
- Modify: `adw/test/main.test.mjs`
- Modify: `adw/test/scenarios.test.mjs`
- Modify: `adw/test/apply.test.mjs`

- [x] Write failing end-to-end injected scenarios for `apply`, `reconcile`, and `audit`: issue route, patch PR, review/security evidence, product-check rerun, merge arm, post-merge obligation, settings drift, labels, green-but-blocked jam, stale retry, and partial retry.
- [x] `apply` requires exact decision+verification+optional patch artifacts, canonical role policy, matching control SHA/digests, and an operation-scoped GitHub capability set. Canonical order is VCS-owned verified branch/update first, GitHub PR metadata second, then remaining state operations; it emits `adw-apply-result` receipts.
- [x] `reconcile` is credentialed for bounded reads only: it imports legacy markers, derives and emits a canonical decision artifact through `planReconciliation`. A dedicated tokenless `verify` job always emits the required state verification; a separate `apply` job with the minted operation-scoped token performs writes under `adw-write`. Reconciliation itself never verifies or writes.
- [x] Review-comment and check jobs run prepare → reconcile → verify → serialized apply. They cannot invoke `assess` or emit a provider routing artifact.
- [x] Replace caller-supplied dry-run intents with the real final pipeline: fixture assessments may drive reduce/verify, while live provider-free mode runs prepare plus deterministic reconcile/audit and records the exact apply intents. Add tests that dry-run uses identical snapshot, decision, verification, precondition, operation-order, and stale checks as write mode, with the writer replaced only by `record`.
- [x] `audit` performs full-fidelity settings/label/ruleset comparison plus deterministic jam/merge-gate reduction and emits only canonical no-op, drift-report, label-sync, jam-comment, check, or merge-arm operations.
- [x] Terminal/fallback states publish sanitized checks/comments through canonical operations; malformed transport never reaches apply.
- [x] Run `node --test adw/test/{main,apply,scenarios}.test.mjs`; expect PASS.
- [x] Commit: `Compose the complete ADW write path`.

### Task 6: Inactive exact wrapper candidates

**Files:**

- Create: `adw/permissions.json`
- Create: `adw/test/wrappers.test.mjs`
- Create: `prototypes/p38-adw-disposable/wrappers/adw-issues.yml`
- Create: `prototypes/p38-adw-disposable/wrappers/adw-pulls.yml`
- Create: `prototypes/p38-adw-disposable/wrappers/adw-maintenance.yml`

- [ ] Write failing structural tests for triggers, trusted refs, job graph, `adw-write`, token permissions, provider isolation, artifact names/hashes, `persist-credentials:false`, `if:always()` failure paths, and exact `node adw/main.mjs <command>` calls.
- [ ] Encode three canonical layers in `adw/permissions.json`: the disposable/production App installation permission union, exact minted-token scopes per apply class, and job-level `GITHUB_TOKEN` permissions. Provider/reduce/verify jobs use `permissions:{}` and only artifact service transport; prepare/reconcile use read-only job/App scopes; apply has read-only job permissions and passes only its minted App token to the MJS process. Tests reject any layer conflation or superset.
- [ ] Issue wrapper: issue/issue-comment/backlog triggers; trusted default-branch control SHA; prepare → conditional primary/fallback → reduce → verify → serialized apply.
- [ ] Pull wrapper: pull/review events follow the provider path; review-comment/check events run prepare → reconcile → verify → serialized apply only. Trusted control code comes from PR base SHA.
- [ ] Maintenance wrapper: default-branch push, schedules, alerts, manual dispatch, reconciliation, spec planning, settings audit, and label sync; no release/tag automation.
- [ ] All three wrappers contain no `gh`, `git`, jq, npm/provider commands, inline prompts, policy shell, target execution, generic token, or checkout credential persistence. Combined operational YAML remains below 400 lines.
- [ ] Assert production `.github/workflows/` contains none of the candidate filenames, so Phase 4 cannot become a second writer.
- [ ] Run `node --test adw/test/wrappers.test.mjs`; expect PASS.
- [ ] Commit: `Encode inactive thin ADW wrappers`.

### Task 7: Disposable-repository harness and failure matrix

**Files:**

- Create: `adw/test/live/disposable.mjs`
- Create: `prototypes/p38-adw-disposable/NOTES.md`
- Modify: `prototypes/PLAN.md`

- [ ] After Tasks 1–6 are committed, derive `ADW_DISPOSABLE_CONTROL_SHA` from that proof commit and compute all tested path/permission digests; reject caller-supplied mismatches. The live harness also requires exact owner/repository name, App ID/login/installation ID, owner ID, three permission-contract digests, and absolute tool/temp paths. Create the repository, then refuse `bugabinga/smith`, forks, unexpected App identity, production installation access, or digest mismatch. The repository contains synthetic test data only and may be public; provider/verify source still comes exclusively from `adw-source` artifacts.
- [ ] Keep bootstrap outside checked-in code: the owner runs explicit recorded `gh repo create`, App-installation selection, secret/variable setup, and `gh repo delete` commands from the local authenticated shell. `adw/test/live/disposable.mjs` receives only the resulting IDs and uses `github.mjs` for repository-contained reads/writes; no second checked-in GitHub endpoint/CLI boundary exists. Bootstrap authority never enters repository Actions or any MJS child process.
- [ ] Confirm the external gate: installation permission union equals `adw/permissions.json`; minted tokens are exact per apply class; required secrets exist without reading values; ruleset requires `check` and `merge-gate`, squash only, verified main commits, and `strict_required_status_checks_policy:false`.
- [ ] Install and pin one proof commit containing final behavior: `adw/**`, assessment charters/schemas, `adw/permissions.json`, labels, product `check`, and candidate wrappers. Record its control SHA and every supporting path tree/blob digest. The later evidence-only plan/result commit may change repository HEAD but must preserve every tested path digest exactly.
- [ ] Keep candidate wrappers unchanged. Add a disposable-only harness workflow outside the candidate set that can rotate invalid provider credentials, cancel a primary job to create a missing artifact, inject malformed transport, race a stale revision, and stop after operation N. The harness has bootstrap authority only in the disposable repo, is never copied at cutover, and cannot target any other repository. Real process timeout remains covered by the non-mocked `runProcess` test; live cancellation proves wrapper `if:always()` and fallback transport.
- [ ] Run and record this matrix: Claude primary success; Codex primary success; each inverse fallback; valid negative/no-op skips fallback; real local process timeout; live cancelled-primary missing artifact; malformed artifact; both providers unavailable; stale snapshot; partial apply retry with receipts; review disagreement; sticky risk/owner clearance; current-head check refresh; green-but-blocked jam report; settings parameter drift report; label sync; post-merge obligation retry.
- [ ] Run one patch route through verification/apply/product `check`/both review evidences/`merge-gate`/squash auto-merge. Verify every main commit is GitHub-verified although feature commits may be unsigned.
- [ ] Capture job permission/secret evidence proving provider and verify jobs never receive forge credentials and apply never receives provider credentials.
- [ ] Run `node --test adw/test/live/disposable.mjs`; expect PASS while the live repository exists.
- [ ] Record exact counts, run URLs, control/path/wrapper digests, failure injections, and any GitHub semantic differences in `prototypes/PLAN.md`.
- [ ] Register the unique `smith-adw-disposable-<timestamp>` repository name in `NOTES.md` before creation. Wrap the harness in `finally` cleanup, add an `if:always()` cleanup job for in-repository temporary state, and record an owner-side reaper command that deletes any matching repository older than the run TTL if the harness process/job dies. Verify temporary CLI homes/auth files are gone, then delete the entire repository through the local bootstrap authority and confirm 404; retain only immutable run URLs/digests and redacted evidence.
- [ ] Commit: `Prove ADW writes in a disposable repository`.

### Task 8: Phase verification and cutover handoff

**Files:**

- Modify: `docs/super/plans/2026-07-31-adw-mjs-control-plane-phase-4-wrapper-disposable-proof.md`

- [ ] Run `node --test adw/test/*.test.mjs`; expect zero failures/skips/cancellations/todos offline; the live disposable harness is outside this glob by construction.
- [ ] Run all legacy ADW suites, `cargo run -p xtask -- check`, and `git diff --check`; expect PASS while legacy remains authoritative.
- [ ] Run boundary greps: only `github.mjs` contains GitHub endpoints/tokens, only `vcs.mjs` invokes git, provider jobs have one provider secret, wrappers contain no policy/tools, and no package manifest/lockfile exists.
- [ ] Run the Task 5 final-pipeline dry-run read-only against production for issue, pull, review-comment, check, schedule, settings drift, and merged-PR reconciliation fixtures. Compare canonical decisions/verifications/intents with current forge state; no production token with write scope is supplied.
- [ ] Verify production workflow inventory and active runs are unchanged by candidate wrappers; no Phase 4 code can write production without explicit production token inputs that wrappers do not provide.
- [ ] Compare the proof commit's tested path tree/blob digests with final HEAD after the evidence-only edits; require exact equality for `adw/**`, charters/schemas, permissions, labels, product `check`, and all candidate wrappers.
- [ ] Mark this plan complete and append the commit range, offline/live counts, disposable repository/run URLs, wrapper line count, permission proof, signing proof, and cleanup result.
- [ ] Commit: `Complete disposable ADW cutover proof`.

## Phase boundary

Execution stops after Phase 4. Production remains legacy-driven, candidate wrappers remain inactive in this repository, and no legacy workflow is disabled or deleted. Phase 5 requires a separate detailed plan, an owner-approved quiet window, green required checks, zero active legacy writers, exact Phase 4 wrapper digests, and an owner-signed rollback commit prepared before cutover.
