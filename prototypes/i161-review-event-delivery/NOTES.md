# i161 — review-event delivery through the ADW control plane

**Issue:** bugabinga/smith#161 (Phase 4).
**Anchor:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`
Phase 4; `docs/super/specs/2026-07-28-adw-mjs-control-plane-design.md` L173
(`adw-pulls.yml`: pull request, review, review-comment, and check events).

## Claim under test

Prove `pull_request_review:submitted` and `pull_request_review_comment:created`
through the Phase 4 wrappers and reconciler. Acceptance:

1. Both events normalize into **bounded role snapshots**.
2. Missed delivery is recovered by reconciliation without duplicate writes.
3. Evidence records current-head behavior and retry semantics.
4. No legacy p35 extension or alert-polling scope.

## Method

`verify.mjs` drives the real control plane — `../../adw/github.mjs`,
`../../adw/core.mjs`, `../../adw/roles.mjs` — with an **injected fake `gh`
process adapter**. The disposable repository is a single open PR #7 with one
approving review #555, simulated in-process with no forge credentials. Run:

```
node verify.mjs      # exits 0, prints one PASS line per check
```

## Result — DISPROVED (criterion 1)

The two named events are **not symmetric**, and only one produces a bounded role
snapshot:

| event kind                       | roles that accept it (`roleSnapshotPlan`)                  |
|----------------------------------|------------------------------------------------------------|
| `pull_request`                   | reviewer, security-reviewer, reviser, docs-writer, dependency-manager |
| `pull_request_review`            | **reviser**                                                |
| `pull_request_review_comment`    | **(none)**                                                 |
| `check` / `check_suite` / `check_run` | **(none)**                                            |

- **`pull_request_review:submitted` → reviser → bounded snapshot: PROVED.**
  3347 B, well under the 262144 B `reviser` bound; pins the current head; a
  stale head (`event.review.commit_id` ≠ live pull head) is rejected with
  `forge/stale` before any snapshot is emitted.
- **`pull_request_review_comment:created` → bounded role snapshot: DISPROVED.**
  No role's `ROLE_EVENTS` entry (`adw/github.mjs`) includes
  `pull_request_review_comment`. `roleSnapshotPlan(*, "pull_request_review_comment")`
  throws for **every** role; the reviser — the natural consumer — rejects the
  event with `contract: role event is unsupported`. The event is otherwise
  first-class: it has an `EVENT_KINDS` entry, a `normalizeEvent` branch, a
  `readSnapshot` (non-role) branch via `methods.reviewComment`, and sits in
  `pullRelated`. It is half-wired: the read exists, but no role can be dispatched.

Criteria 2–4 hold (all PROVED by `verify.mjs`):

- Missed review delivery → reconciliation emits `run_review` for
  `correctness` + `security` at the current head; identical inputs yield an
  identical intent set (deduped via the `unique` map in `planReconciliation`) —
  no duplicate writes.
- Posted review-evidence markers at the current head suppress the re-run.
- Evidence at a **stale** head is ignored; reconciliation retries against the
  advanced head — current-head + retry semantics.
- No p35 harness or alert-polling code is touched; only `adw/` is imported.

## Interpretation (the spec question for the owner)

`pull_request_review_comment` behaves exactly like `check`/`check_suite`/`check_run`:
a `pulls`-wrapper trigger with **no consuming role**. That is consistent with a
design where review-comments (like checks) are **reconcile-only triggers**, not
role-snapshot events. If so, issue #161's acceptance criterion 1 ("Both events
normalize into bounded role snapshots") is mis-stated and should read "both
events are accepted by `adw-pulls` and drive the reconciler."

Either the reviser's `ROLE_EVENTS` should gain `pull_request_review_comment`
(making it a real role-snapshot event), or the acceptance criterion should be
corrected to the reconcile-trigger reading. That choice is a spec decision, not
a prototype's to make — hence DISPROVED and a `needs:spec` escalation.
