# ADW Builder Route Reconciler Design

## Decision

A deterministic reconciler, invoked hourly by `adw-sweep.yml`, is the sole writer of builder-route labels. Builder event workflows record artifacts but never move an issue between `ready` and `codex`. The LLM sweeper runs after the reconciler and may report state; it does not change builder-route labels.

## Route Record

The reconciler creates one App-authored issue comment before any transition:

```text
<!-- smith:builder-route/v1 issue=127 id=<uuid> source=claude/issue-127 target=codex/issue-127 phase=prepared -->
```

The comment ID is the durable operation lock. The reconciler finds the latest App-authored record for the issue; `prepared` and `armed` are active, `completed` and `cancelled` are terminal. With workflow concurrency, one active record permits exactly one operation per issue. Retrying resumes the existing record; it never creates another operation. The reconciler edits the App comment through its ID to advance phases. Owner comments cannot impersonate or edit the App-authored record.

A missing Claude artifact is recorded by the Claude builder in an App comment carrying the issue number, source branch, and observed head SHA. The reconciler uses this comment as the fallback precondition. A comment with the same issue, source branch, and head SHA is idempotent; a later Claude artifact makes the active route record `cancelled`.

## State and Interfaces

A primary route is `ready` for Claude UI/UX work or `codex` for Codex backend work. `fallback:claude` is metadata, not a trigger. Holds are `blocked`, `risk:high`, `needs:info`, `needs:spec`, `needs:prototype`, and `needs:breakdown`.

A qualifying artifact is an open PR where all conditions hold:

- `head.ref` is the route branch and `head.repo.full_name` equals `github.repository`;
- `base.ref` is `main`;
- the PR has a closing reference to this repository's issue, verified by repository identity and issue number.

## Reconciliation

`.github/adw/reconcile-builder-routes.sh` receives `GH_TOKEN`, `REPO`, and a maximum scan count of 100. It lists the union of open `ready` issues and open `codex` issues carrying `fallback:claude`, deduplicates it, then fetches each issue's live labels, state, App route records, provider-attempt records, and qualifying PRs.

It performs no write for closed, held, artifacted, or invalidly routed issues. For an open, unheld `ready` issue with a matching missing-Claude record and no qualifying Claude PR, it creates or resumes the route record and uses only targeted label mutations:

1. Write or resume the App route record at `prepared`.
2. Before every mutation, refetch state and labels. A hold pauses the record without changing route labels.
3. Remove `ready`, then add `fallback:claude`.
4. Edit the record to `armed`.
5. Add `codex`.

Targeted mutations never replace the issue label set, so concurrent owner holds cannot be erased. A hold that appears after `armed` may leave `codex` present, but the Codex builder rejects held work. The existing hold-clear event rechecks it. An owner cancels a prepared fallback by adding any hold; removing `ready` alone does not cancel a recorded operation.

When a qualifying target PR appears, the reconciler edits the record to `completed`. If a qualifying Claude PR appears before `armed`, it edits the record to `cancelled` and removes only `fallback:claude`; it never removes owner labels.

## Workflow Contract

`adw-sweep.yml` mints the App token, runs the deterministic reconciler before Codex, and fails if the script fails. Its scan is bounded at 100 deduplicated issues per tick. Codex receives no routing authority.

`adw-build.yml` records the missing-Claude attempt but does not label `codex` or `fallback:claude`. `adw-codex-build.yml` accepts only an `armed` App route record for a fallback UI/UX issue; ordinary backend `codex` work needs no route record. It rejects closed, held, dual-routed, stale, or already-artifacted work.

## Errors

GitHub read failure before a mutation fails the reconciler without a new write. A targeted mutation failure leaves the App record at its prior phase; the next tick resumes from the live state. An App comment read/edit failure fails the tick. Partial transitions remain non-buildable until their `armed` record and live labels agree.

## Tests

Contract and shell tests cover:

- missing-Claude attempt payload and idempotency key;
- App-authored record discovery, phase update, and retry;
- hold before and during each transition phase, with no hold erased;
- concurrent label changes, with only targeted mutations issued;
- same-name fork PR and cross-repository closing reference rejection;
- closed, artifacted, invalid, and dual-routed issues producing no runner;
- one missing-Claude artifact producing one armed Codex fallback route;
- failed reads/writes leaving a resumable record and no broadened route;
- the 100-issue scan bound and reconciler-before-LLM workflow order.
