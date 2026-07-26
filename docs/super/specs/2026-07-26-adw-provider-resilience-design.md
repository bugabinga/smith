# ADW Provider Resilience Design

## Decision

ADW treats Claude and Codex as equal provider families. No role is owned by one provider forever: every role has a primary, a fallback, and optional multi-provider quorum rules.

The goal is autarky: a weekly limit, auth expiry, provider outage, or no-verdict run must not stop issue triage, build, review, sweep, or merge gating when the other provider is healthy.

## Scope

In scope:

- ADW GitHub workflows under `.github/workflows/`.
- Role-to-provider routing for planner, surveyor, triager, builders, reviewers, security reviewer, sweeper, docs writer, dependency manager, release manager, pioneer, and adw-doctor.
- Merge-gate semantics for provider fallback and multi-provider verdicts.
- Documentation in `docs/plans/AGENTIC-DEVELOPMENT.md`.

Out of scope:

- New model providers beyond Claude and Codex.
- Replacing GitHub Actions.
- Changing CODEOWNERS, branch rulesets, or the human-owned spec gate.
- Loosening security boundaries around secrets or fork PRs.

## Architecture

Add an ADW provider matrix as the single source for role routing. The matrix records each role's Claude runner, Codex runner, effort, mode, and whether it normally runs one provider or both.

Workflows consume that matrix instead of hard-coding “Claude role” and “Codex role” as permanent ownership. Existing workflows may stay split if that is the smallest change, but their behavior must match the matrix.

Role modes:

- `single`: run the preferred provider; if it cannot produce the required artifact, run fallback.
- `quorum`: run both providers when available; one healthy provider may satisfy the role during outage.
- `advisory`: best-effort extra signal; never required for merge.

## Role matrix

| Role | Normal mode | Preferred | Fallback | Notes |
|---|---|---|---|---|
| planner | single | Claude fable | Codex sol | High-context planning; fallback must open/update the same issue/plan artifacts. |
| surveyor | single | Claude fable | Codex sol | Opens at most one work-order per tick. |
| triager | single | Codex luna | Claude opus | Cheap classification first, Claude fallback if Codex auth/limit fails. |
| builder-ui | single | Claude opus | Codex terra | UI/UX issue labels route here, but fallback may still build. |
| builder-backend | single | Codex terra | Claude opus | Backend issue labels route here, but fallback may still build. |
| reviewer | quorum | Claude opus + Codex sol | either healthy provider | Correctness verdict is required; conflicting provider verdicts block. |
| security-reviewer | quorum | Claude opus + Codex sol | either healthy provider | Security verdict is required; any high-risk verdict blocks. |
| sweeper | single | Codex luna | Claude opus | Must keep queues moving even when one provider is down. |
| docs-writer | single | Codex terra | Claude opus | Same artifact contract: doc PR or explicit no-op comment. |
| dependency-manager | single | Codex terra | Claude opus | Same escalation rules for risky bumps. |
| release-manager | single | Codex terra | Claude opus | Release still requires owner tag touchpoint. |
| pioneer | single | Claude opus | Codex sol | Prototype evidence contract unchanged. |
| adw-doctor | quorum | Codex sol + Claude fable | either healthy provider | Multi-provider preferred for systemic ADW fixes. |

## Data flow

1. Workflow starts for an ADW role.
2. Deterministic setup mints the GitHub App token and prepares provider auth.
3. Primary provider runs with the role charter and exact artifact contract.
4. A probe checks the artifact, not just process exit:
   - issue labels/comments for triage;
   - branch + PR for build;
   - verdict label + head-SHA marker comment for review;
   - issue/PR/comment for sweeper and doctor;
   - release artifact for release.
5. If the artifact is missing and fallback is configured, fallback runs once.
6. The final assert succeeds only when the required artifact exists for the current head/event.

## Review and merge semantics

`reviewer` and `security-reviewer` become provider-family-aware gates.

Correctness review:

- Claude pass alone may apply `reviewed` when Codex is unavailable.
- Codex pass alone may apply `reviewed` when Claude is unavailable.
- Any provider requesting changes applies or preserves `changes-requested`.
- If providers disagree, `changes-requested` wins until a later run resolves it.

Security review:

- One healthy provider may apply `security-cleared`.
- Any provider finding high risk applies `risk:high` and removes `security-cleared`.
- `risk:high` remains sticky and owner-cleared only.

Advisory comments may remain, but required verdict labels must come from provider-family-aware review workflows, not a forever-Claude path.

## Error handling

Provider failure classes that trigger fallback:

- missing/expired auth;
- weekly/monthly limit hit;
- provider API outage;
- action/CLI exits non-zero;
- silent no-op: exit 0 but missing artifact;
- timeout before artifact.

Fallback does not trigger on a valid negative verdict. “Changes requested” and `risk:high` are successful artifacts, not provider failures.

If both providers fail to produce the required artifact, the workflow fails loudly and leaves the existing deterministic gate red. Sweeper/adw-doctor then diagnose the stall.

## Tests and validation

Implementation must include cheap deterministic checks:

- Matrix parsing/validation if stored as data.
- Shell tests for provider-result reduction: primary pass, primary fail fallback pass, both fail, conflicting review verdicts, security high-risk wins.
- Existing merge-gate label tests updated only if labels change.
- Workflow grep/audit proving no mission-critical role has a single provider with no fallback path.

Manual validation:

- Simulate Claude unavailable and confirm Codex can satisfy at least triage/review.
- Simulate Codex unavailable and confirm Claude can satisfy at least triage/review.
- Simulate conflicting review results and confirm merge stays blocked.

## ADW issue scan

Scanned all GitHub issues whose title, body, or labels mention ADW, including closed incidents. The open ADW-relevant issues are:

| Issue | Root cause | Design response |
|---|---|---|
| #127 | Separate Claude builder lane is unreachable and branch setup differs from Codex. | One builder contract with provider-selected execution; branch creation is deterministic and shared before the provider runs. |
| #114 | Review action success is not proof of a review artifact. | Artifact assertions are mandatory; missing verdict/comment triggers fallback, then hard failure. |
| #49 | Reviewers read PR-head `CLAUDE.md` as trusted instructions. | Provider runners pin trusted project instructions to base SHA while reviewing PR-head diff/files as untrusted input. |
| #51 | Codex setup, docs wording, and revise routing drift across copied workflows. | Shared provider setup + provider matrix removes copy-paste and records the provider family that owns revisions. |
| #56 | Owner GitHub interactions can fall into silent voids. | Add a documented coverage matrix; prefer one scheduled reconciler over new per-event workflows. |
| #21 | Liveness cliff, revise thrash, and no post-merge recovery. | Bounded WIP with one alternate unblocked slice, per-PR revise counter, and post-merge red-CI revert PR path. |
| #20 | Some event triggers are unproven. | Treat schedules/reconciliation as load-bearing; prototype only events that remain load-bearing. |
| #17 | `merge-gate` is labels-only until real CI is required. | No hands-off auto-merge until `xtask check` is a required status beside `merge-gate`. |
| #16 | Project v2 board driving is unproven. | Labels, issues, milestones remain source of truth; board stays disabled/best-effort until proven. |
| #122 | Release workflow must stay thin and invoke `xtask release`. | Release-manager uses the same provider runner; release mechanics wait on #104/#120 and stay xtask-owned. |

Closed ADW incidents cluster into the same roots: merge-gate jams (#39, #43, #58-#76, #84), stale labels (#94), label drift (#113), no-verdict recovery (#128/#129), stale CodeQL config (#116), auth/setup blockers (#13/#14/#32/#47), and wrong-signing diagnosis (#115). They argue for fewer moving pieces, not more per-incident patches.

## Simplified ADW shape

The minimal system is four boring layers:

1. **State:** GitHub issues, labels, milestones, required checks. Project boards are mirrors only.
2. **Runner:** one provider runner contract prepares trusted inputs, runs Claude or Codex, and proves the artifact.
3. **Reducer:** deterministic shell logic reduces provider results into labels, comments, PRs, or failures.
4. **Reconciler:** scheduled sweeper/doctor repairs missed events, stalled work, and provider outages.

No role should own bespoke auth setup, branch setup, verdict probing, or provider fallback. If a workflow needs those, it calls the shared runner/reducer. New instant triggers are added only when schedule-based reconciliation cannot preserve correctness.

## Rollout

1. Add provider matrix, shared setup, and reducer helpers.
2. Convert review/security first: base-pinned instructions, quorum/fallback, no-verdict assertions, conflict blocking.
3. Convert builder into one shared branch/PR path with provider-selected execution.
4. Convert triage, sweep, planner, surveyor, docs, deps, release, pioneer, and doctor to the same runner.
5. Add ADW coverage matrix and liveness rules to `docs/plans/AGENTIC-DEVELOPMENT.md`.
6. Keep auto-merge disabled until real CI is required with `merge-gate`.
7. Leave Project v2 disabled as source of truth until #16 is proven.

Each step must preserve current artifact contracts before adding new behavior.
