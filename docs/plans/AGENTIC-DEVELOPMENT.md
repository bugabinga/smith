# Agentic Development — Guide

> Guide and overview, **not** the source of truth. The ADW *is* the encoded
> config — `.github/workflows/`, GitHub settings (CODEOWNERS, rulesets, labels,
> the Project board), and `.claude/` (agents, settings, skills). This doc
> explains and ties those together; when the doc and the config disagree, **the
> config wins** and the doc is corrected — never the reverse, because the config
> is what actually runs. `docs/SPEC.md` stays canonical for what Smith *is*;
> agent conduct and merge policy deliberately live here and in
> PROJECT-INVARIANTS §5, not in the spec.

## Vision

The human has exactly **three input points**; agents own everything between them
and leave a reviewed GitHub trail the human can inspect, step into, and steer.

| # | Human input | Frequency | Enforced by |
|---|-------------|-----------|-------------|
| 1 | **The spec** (`docs/SPEC.md`) — mission-critical definition | primary | CODEOWNERS + branch protection (required owner review) |
| 2 | **Issues** — small tasks, bugs | regular | agents consume; humans need never triage |
| 3 | **PR review** — emergencies / high-risk only | rare | required only on `risk:high` or security escalation or protected paths |

Everything else — trigger, triage, implement, review, security-review, merge,
track — is autonomous.

## Encoding surface — where the ADW actually lives

This doc is the map; these are the territory. Each concept resolves to a
concrete artifact that *executes*; the doc only narrates them. "In repo?" flags
what is version-controlled and reviewable via PR versus what lives in GitHub's
API/UI (a drift risk to minimize by preferring the as-code option).

| Concept | Encoded in | In repo? | Authority |
|---|---|---|---|
| agent persona / model / tool scope | `.claude/agents/<role>.md` | ✅ | the file |
| which agent runs on which event | `.github/workflows/<role>.yml` | ✅ | the workflow |
| shared rules all agents inherit | `CLAUDE.md` (+ nested) | ✅ | the file |
| Claude runtime settings | `.claude/settings.json` | ✅ | the file |
| reusable role workflows | `.claude/skills/<name>/SKILL.md` | ✅ | the file |
| integrity floor (never fake green) | `PROJECT-INVARIANTS.md §5`, enforced by CI | ✅ | invariant |
| spec-review requirement | `CODEOWNERS` + a branch **ruleset** | ✅ CODEOWNERS; ⚠️ ruleset exportable as JSON | ruleset |
| merge gates / auto-merge | branch ruleset + workflow gate logic | ⚠️ partial | ruleset + workflow |
| routing labels | `.github/labels.yml` + a label-sync action | ✅ if adopted as-code | `labels.yml` |
| waves | Milestones | ❌ GitHub API/UI | GitHub |
| lifecycle board | Project (v2) | ❌ mostly (scriptable via `gh`) | GitHub |
| bot identity | GitHub App + secrets | ⚠️ App-manifest JSON can live in repo; key/install manual | GitHub |

**Rule:** prefer the as-code option for anything that can be one (rulesets,
labels-as-code, the App manifest) so the ADW is reviewable and reproducible;
accept that the Project board, milestones, and the App installation are
irreducibly GitHub-side. A `xtask adw` (or CI) check can assert the in-repo
artifacts agree with this doc's tables — the same no-drift discipline as the
arch gate.

## The autonomous lifecycle

```
issue opened ──▶ triager ──▶ [board: Ready] ──▶ implementer ──▶ PR
   ▲                                                              │
spec merged ──▶ spec-decomposer ──▶ issues/plan/board            ▼
                                                     reviewer + security-reviewer
                                                              │
                                          ┌───────────────────┴───────────────┐
                                     all gates green                    risk:high / sev:high
                                          │                                    │
                                     auto-merge*                        request human review (#3)
```

`*` auto-merge is gated; the integrity floor (never fake a green run) is
PROJECT-INVARIANTS §5, and the merge *policy* is this plan — see **Open
decisions**.

## Agent roster — the central review surface for models

The **authority** for each role's model and tool scope is that agent's
`.claude/agents/<role>.md` frontmatter — the one central directory to review and
change them. `xtask agents` renders this table *from* that frontmatter, so the
snapshot below is illustrative and generated, never hand-authoritative. To
change a model, edit the frontmatter; the table follows.

| Agent | Trigger | Model | Scoped tools | Role |
|-------|---------|-------|--------------|------|
| `triager` | `issues` opened/reopened | Haiku | Issues RW, read | label, estimate, route, link, place on board |
| `spec-decomposer` | push to `main` touching `docs/SPEC.md` | Opus | Issues RW, read | diff the spec, derive/refresh issues + plan, update board |
| `implementer` | issue labeled `ready` | Sonnet | Contents RW, PR RW, Bash | branch, build per `WALKING-SKELETON`, open PR |
| `reviewer` | `pull_request` opened/synced | Opus | PR review, read | adversarial code review — **different model than the implementer on purpose** |
| `security-reviewer` | `pull_request` (+ `needs:security`) | Opus | PR review, read | the `security-review` skill; escalates high severity to human |
| `gardener` | `schedule` | Haiku→Sonnet | Issues/PR RW, Actions | detect stalls, re-kick, report; circuit-breaker |
| `pioneer` (exists) | `spec-risk` label / manual | Sonnet/Opus | `prototypes/` only | validate spec claims with disposable prototypes |

Rationale for the tiering: cheap/mechanical work (triage) on Haiku; building on
Sonnet; anything adversarial or judgment-heavy (review, security, spec
decomposition) on Opus, and the reviewer is deliberately a *different* model
from the implementer so review is a second opinion, not self-congratulation.

## Control surfaces — agents vs output styles vs CLAUDE.md

Deliberately **not** stacked; each does one job:

- **`.claude/agents/*.md`** — the per-role control surface. Carries name,
  description, **model**, **tool scope**, and the persona system prompt in one
  file. This is where a role's identity lives.
- **`CLAUDE.md`** — shared project rules every agent inherits (commit voice,
  spec-before-code). Context, not persona.
- **Output styles** — session-global, main-thread only; they **cannot set model
  or tools and do not reach subagents**. So they are the *wrong* tool for
  per-role control. Recommendation: **do not combine them per role.** At most,
  one house-wide output style could enforce global tone; role behavior stays in
  the agent files.

Net: agents = who/which-model/what-tools; CLAUDE.md = shared rules; output style
= optional global voice. Keeping them in separate layers gives more control than
stacking, with less confusion about what wins.

## GitHub feature mapping (the reviewed trail)

| Concern | Feature |
|---|---|
| unit of work | **Issues** (+ sub-issues for decomposition) |
| lifecycle state | **Project (v2)** board: Triage → Ready → In Progress → In Review → Security → Done; fields for risk / wave / agent-owner |
| routing & gates | **Labels**: `ready`, `risk:high`, `needs:security`, `agent:*` |
| grouping | **Milestones** = waves (`WALKING-SKELETON`, then `TASK-BREAKDOWN` waves) |
| every change | **PRs**, linked to issues (`closes #N`), agent-reviewed |
| spec protection | **CODEOWNERS** + branch protection on `docs/SPEC.md`, `PROJECT-INVARIANTS.md` |
| compute | **Actions** workflows (the triggers) |
| optional | **Discussions** for design deliberation; **Wiki** for generated docs |

Projects v2, Discussions, and Wiki are not reachable from the MCP toolset but
are reachable from `gh` / `gh api graphql` inside Actions — so the agents (which
run in Actions) can drive them.

## Identity — the keystone

A **`smith-bot` GitHub App** is required, not optional, for two reasons:

1. **Cascade.** Actions taken with the default `GITHUB_TOKEN` do **not** trigger
   downstream workflows — an agent-opened PR would never trip the review
   workflow. An App installation token cascades, so the chain actually flows.
2. **Projects scope.** Projects v2 is org/user-scoped; `GITHUB_TOKEN` can't
   write it. The App can be granted project permission.

Bonus: every autonomous action is attributable to the bot, not the human — a
clean audit identity.

### TL;DR — creating the App

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (org-level if
   the Project is org-owned).
2. **Permissions:** Contents RW, Issues RW, Pull requests RW, Checks R, Actions
   R; Organization **Projects RW** (and repo Projects if used); Discussions RW
   and Metadata R as needed.
3. **Install** the App on the `smith` repo.
4. **Generate a private key**; store `APP_ID` + `PRIVATE_KEY` as repo/org
   secrets.
5. In each workflow, mint an installation token with
   `actions/create-github-app-token@v1` and pass it as the action's
   `github_token` (and to `gh` via `GH_TOKEN`). That token both cascades and
   carries Projects scope.

## Guardrails

- **Cost / runaway** — per-run `--max-turns`, concurrency caps, and the
  `gardener` as circuit-breaker; token budgets.
- **Self-review blind spots** — reviewer on a different model than the
  implementer; security-reviewer never auto-approves high severity — it
  escalates to touchpoint #3.
- **Merge safety** — branch protection is the backstop; the integrity rules in
  PROJECT-INVARIANTS §5 bind every agent absolutely: never fake a green run,
  never delete/skip tests, never merge on a red gate. Those are the floor this
  policy sits on.
- **Spec decomposition quality** — the human still owns the spec; the decomposer
  only *proposes* issues. A soft `approved` label can gate the implementer until
  trust is established.

## Open decisions (owner / spec)

1. **Auto-merge gates.** Agent governance now lives outside the spec (the §17.10
   rules moved to PROJECT-INVARIANTS §5 as the integrity floor), so this is no
   longer a spec conflict — it is a policy call owned here. Decide the exact
   gate: CI green + independent review approved + security clear + risk below
   which threshold? Nothing auto-merges until this row is filled in.
2. **Create the `smith-bot` App** (only the owner can).
3. **Risk threshold** for what forces human review (touchpoint #3).

## Phased rollout

- **Phase 0** — CODEOWNERS + branch protection on the spec (enforces touchpoint
  #1); create the Project board; land the `.claude/agents/*` personas. No
  autonomy yet.
- **Phase 1** — `issues → triager → implementer → PR` on the existing proven CI;
  **human reviews every PR** (build trust in the trail).
- **Phase 2** — add `reviewer` + `security-reviewer`; enable gated auto-merge for
  `risk:low` only (requires decision #1).
- **Phase 3** — add `spec-decomposer` + `gardener`; full autonomy with the human
  at the three touchpoints.

Each phase is independently useful and reversible.
