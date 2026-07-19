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

Crucially, the spec is a **standing** input, not a one-shot one: the owner does
not have to file an issue for the build to advance. On a schedule the `surveyor`
measures the gap between the spec (the goal) and the code (what exists) and opens
the next work-order itself, one slice at a time. So touchpoint 1 alone — a
realized spec sitting in `main` — is enough to pull the whole build forward on its
own; issues (touchpoint 2) are for the extra, out-of-band work the spec doesn't
already imply. Development flows over time from the spec, not only from the
owner's next keystroke.

## Two phases — build-out, then indefinite maintenance

One cycle whose character changes over time, not two:

- **Build-out.** Drive the spec to a shipped product, autonomously: the
  `surveyor` finds the next unbuilt slice in `WALKING-SKELETON` order and opens a
  work-order for it, `planner` folds in any owner spec change, `builder`
  implements slice by slice, the reviewers gate each PR. It self-advances — no
  issue required — throttled to one open slice at a time. Ends when the spec is
  realized and the first release ships.
- **Maintenance (indefinite).** The same machinery keeps the product healthy with
  near-zero owner input — `dependency-manager` on bumps, `security-reviewer` on
  alerts, `docs-writer` on drift, `release-manager` on the next release, `triager`
  on incoming bugs, `sweeper` keeping it moving. New work still enters only
  through the three touchpoints.

The dial is set to **predictability and quality over speed**: small slices,
adversarial review on a second model, low work-in-progress, no auto-merge above
the `risk` threshold, thorough verification. A slow, legible, reversible cycle is
the goal, not throughput — it is fine for build-out to take a long time.

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
| spec-review requirement | `CODEOWNERS` + a branch **ruleset** | ✅ `CODEOWNERS`; ⚠️ `main.json` recorded, applied via `gh api` (not auto-read) | ruleset |
| merge gates / auto-merge | native auto-merge + `merge-gate` check + ruleset | ✅ `adw-automerge.yml` + `adw-gate.yml` + ruleset (`merge-gate` required); ⚠️ ruleset applied by hand | workflow + ruleset |
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

## The roster — mission · artifact

Plain, self-describing names, one per `.claude/agents/<name>.md`. Each is pinned
by its **mission** and the single **artifact** it may touch. Triggers are *not*
in the agent files — an agent doesn't need to know what woke it; the trigger is a
property of the workflow that runs it (the encoding surface), and is listed here
only for the reader's map. The craft skills (`sabotnik`, `handmade`, `pioneer`,
`smith`) are *verbs the agents wield*, not agents.

| Agent | Woken by (in the workflow) | Mission | Artifact it owns | Model |
|-------|----------------------------|---------|------------------|-------|
| `surveyor` | `schedule` | measure the spec-vs-code gap and open the next unbuilt slice as a work-order — the engine of autonomous build-out | **one Issue** per tick | Opus |
| `triager` | issue opened | triage a raw issue into a labeled, routed, spec-anchored work-order | the **Issue** + board card | Haiku |
| `planner` | spec change lands on `main` | turn the spec diff into tracked work-orders + refresh the plan | **Issues** + `docs/plans/*` | Opus |
| `builder` | issue labeled `ready` | build one slice per `WALKING-SKELETON`, hardened, tested | a **branch + PR** | Sonnet |
| `reviewer` | `pull_request` | adversarial correctness review vs the spec — a *second* model | a **PR review** | Opus |
| `security-reviewer` | PR on sensitive surface / `needs:security` / scanner alert | security review; escalate high severity | a **PR review** + `risk:*` | Opus |
| `docs-writer` | merged PR changes user-facing / SDK behavior | keep user + plugin-author docs and the site true to the product | doc sources + Pages, via **PR** | Sonnet |
| `dependency-manager` | Dependabot bump PR | shepherd version bumps through the gates; escalate risky ones | **Dependabot PRs** | Sonnet |
| `release-manager` | milestone green / `v*` tag | draft notes, verify the §14 matrix, publish the Release | a **GitHub Release** | Sonnet |
| `sweeper` | `schedule` | unstick stalls, enforce WIP, brake runaways | **Issues/PRs/board** labels | Haiku |
| `pioneer` (skill) | `needs:prototype` | prove/disprove an unproven spec claim with a prototype | `prototypes/*` | Sonnet |

The **authority** for each model and tool scope is the agent's frontmatter — the
`.claude/agents/` directory is the one place to review and change them; a
prospective `xtask agents` renders this table from it. `builder` and `reviewer`
wield `/sabotnik` and `/handmade`; `pioneer` and `smith` stay
owner/skill-invoked, since the spec is touchpoint 1.

Model tiering favours **quality over speed** (see *Two phases*): mechanical work
(triager, sweeper) on Haiku; building/docs/deps/release on Sonnet; everything
adversarial or judgment-heavy (surveyor, reviewer, security-reviewer, planner) on
Opus —
and `reviewer` is deliberately a *different* model from `builder` so review is a
second opinion, not self-congratulation.

## How the cycle pushes Smith forward

The state of Smith advances spec → issue → branch → review → trunk, with the
human present only at the three touchpoints. Auto-merge is gated (integrity
floor: PROJECT-INVARIANTS §5; merge policy: this plan — see **Open decisions**).
The diagram below is deliberately *not* only the happy path — it shows the
self-heal loop (red CI), the change-request loop (review), and the two ways work
bounces back to the owner: a risky change (touchpoint 3) and a defective spec
(the escape valve, touchpoint 1).

```mermaid
sequenceDiagram
    actor Owner
    participant Spec as docs/SPEC.md
    participant Sur as surveyor
    participant Plan as planner
    participant Board as Issues · Milestones · Board
    participant Tri as triager
    participant Bld as builder
    participant CI as CI gates
    participant PR as Pull Request
    participant Rev as reviewer
    participant Sec as security-reviewer
    participant Trunk as main

    Note over Owner,Spec: Touchpoint 1 — the spec
    Owner->>Spec: merge a spec change
    Spec-->>Plan: push to main
    Plan->>Board: work-orders, sorted into a milestone (wave)

    Note over Sur,Board: Autonomous — no owner input
    loop every 6h, WIP permitting
        Sur->>Board: open next slice of the current milestone as `ready`
    end

    Note over Owner,Board: Touchpoint 2 — issues
    Owner->>Board: file an issue
    Board-->>Tri: issue opened
    Tri->>Board: classify · anchor · size · route · card→Ready

    Board-->>Bld: labeled `ready` (card→In Progress)
    loop until gates green
        Bld->>CI: push slice
        CI-->>Bld: red → self-heal
    end
    Bld->>PR: open PR, closes #N (card→In Review)
    PR-->>Rev: pull_request
    PR-->>Sec: pull_request

    alt reviewer requests changes
        Rev-->>Bld: file-anchored findings
        Bld->>PR: revise → re-review
    else spec is wrong, missing, or self-contradictory
        Note over Bld,Rev: escape valve → Touchpoint 1
        Bld->>Board: open `needs:spec`, block the slice
        Board->>Owner: escalate
        Owner->>Spec: resolve via /smith, then re-plan
    end

    alt reviewed + security-cleared, no blocking label
        Note over PR,Trunk: native auto-merge, gated by merge-gate
        PR->>Trunk: rebase-merge (signed) — card→Done
        Trunk-->>Sur: front clears → next slice
    else risk:high / sev:high
        Note over PR,Owner: Touchpoint 3 — PR review
        Sec->>Owner: risk:high holds merge-gate red; escalate
    end
```

Two agents run on a schedule, outside any single event: `surveyor` *feeds* the
spine — it opens the next `ready` slice when the front is clear, so the loop above
turns without the owner filing an issue — and `sweeper` *maintains* it, sweeping
for stalls and braking runaways. `docs-writer`, `dependency-manager`, and
`release-manager` hang off the same trunk (a merged PR, a Dependabot PR, a green
milestone) rather than the issue→PR spine.

The two schedulers are deliberately opposed: `surveyor` only ever *adds* one unit
of work and only when nothing is in flight, while `sweeper` enforces the WIP
ceiling and brakes runaways. Together they hold the cycle at a steady, low
throughput — the "predictability over speed" dial, made mechanical.

## The escape valve — when work contradicts the spec

The spec is touchpoint 1, and agents may not edit it. But building against a spec
is the surest way to discover the spec is *wrong* — silent on an edge case,
self-contradictory, or resting on a claim the code disproves. Without a defined
outlet, an agent facing that has only bad options: guess (corrupts everything
downstream), or stall silently. So the spec is not only the cycle's **input**, it
is also its **sink for reality's feedback** — the one escape valve every agent
shares.

The rule is uniform across the roster: **discover the spec is wrong → stop, don't
guess, open a `needs:spec` issue, and block the dependent work.** Then:

1. The finder (`builder`, `reviewer`, `security-reviewer`, `dependency-manager`,
   or `/pioneer`) opens a `needs:spec` issue: the contradiction, the SPEC anchor,
   the evidence (a failing test, a disproof, a review finding). The work-order that
   hit the wall gets `blocked` and a comment linking the new issue — it does *not*
   merge on a guess.
2. `needs:spec` is the owner's alone. The owner resolves it via `/smith` — clarify,
   correct, or decide — which is a spec change, i.e. touchpoint 1.
3. That spec change lands on `main` and wakes `planner`, which re-plans the delta
   and clears the `blocked` slice back to `ready`. The cycle resumes with the
   contradiction resolved at the source, not patched around in code.

`/pioneer` is the sharp end of this: a prototype that *disproves* a spec claim
emits a "Spec Issues" report (its result contract), and that report becomes the
`needs:spec` issue verbatim. Evidence, not opinion, reopens the spec.

## Unhappy paths — where each failure routes

The happy path is one row of this table. Every other outcome has a defined owner
and destination; nothing dead-ends or merges on a guess.

| When… | Detected by | Handled by | Routes to |
|---|---|---|---|
| CI is red | CI gates | `sweeper` (hourly) | re-kicks `builder` to self-heal; brakes `stalled` if no progress |
| review requests changes | `reviewer` | `builder` via `adw-revise` | revise on the same branch → re-review on push |
| PR green but unmerged / conflicted / `ready` with no branch | schedule | `sweeper` | re-kick if tractable, else label `stalled` with why |
| change is high-risk / high-severity | `security-reviewer` | owner | `risk:high` → **touchpoint 3**; never auto-merges |
| the issue needs info only the reporter has | `triager` / `builder` | reporter | `needs:info`; parked until answered |
| the spec is wrong / missing / contradictory | any agent | owner | `needs:spec` → **the escape valve above** |
| a spec claim is unproven | `planner` / `surveyor` | `/pioneer` | `needs:prototype`; a prototype proves or disproves it |
| a Dependabot bump is semver-incompatible / MSRV-raising | `dependency-manager` | owner | escalate as its own issue; the bump waits |
| the cycle floods (WIP exceeded) or an agent loops | schedule | `sweeper` | enforce WIP, brake the runaway — the circuit-breaker |

Two invariants hold across every row: an agent never fakes a green gate to move a
PR (PROJECT-INVARIANTS §5), and an agent never resolves ambiguity by guessing — it
routes to the human via one of `needs:spec`, `risk:high`, or `needs:info`.

## Merging — native auto-merge, gated by labels

Nothing needs a bespoke merge robot. The close of the loop is **GitHub's native
auto-merge**, armed for every agent PR and released by the ruleset's gate:

1. `adw-automerge` arms auto-merge (rebase) on each bot-authored, non-Dependabot
   PR the moment it opens. GitHub now merges it *itself* the instant its gate is
   green — no agent watches, polls, or clicks.
2. The gate is the ruleset's **required status checks** plus its code-owner rule.
   The load-bearing check is **`merge-gate`** (`adw-gate.yml`) — a plain, no-LLM
   job that reads the PR's labels and is green only when both review verdicts are
   in (`reviewed` + `security-cleared`) and no blocking label
   (`risk:high`, `blocked`, `needs:*`, `stalled`) is present. CI checks join this
   list once the workspace CI lands.
3. The reviewers cast their verdict **as labels**, not approvals — deliberately.
   `builder`, `reviewer`, and `security-reviewer` are one GitHub identity (the
   App), and GitHub forbids approving your own PR, so a required *approval* could
   never be satisfied by an agent. A required *check* driven by a label has no such
   problem: `reviewer` adds `reviewed`, `security-reviewer` adds `security-cleared`,
   and `merge-gate` turns green. `required_approving_review_count` stays `0`; the
   code-owner rule still forces a **human** approval on CODEOWNERS paths (spec,
   workflows, agents, invariants) — touchpoints 1 and 3 — where the author is the
   App, not the owner, so there is no self-approval there either.
4. `risk:high` keeps `merge-gate` red, so a risky PR simply never auto-merges and
   waits for the owner. Same for a changes-requested review: `reviewed` is absent,
   the gate stays red, and the PR waits for the revision that adds it back.

Net: the merge is native and deterministic; the LLMs only move labels, and a
label can't fake a green check. Two owner enable-steps make it live — **Allow
auto-merge** (repo setting) and importing the ruleset with `merge-gate` required
(issue #14).

## Reaction workflows — the loops that make it self-sustaining

Beyond the issue→PR spine, five workflows wake agents on GitHub's own feedback
events, each carrying a loop-guard so agents never react to themselves:

| Workflow | Wakes on | Does | Loop-guard |
|---|---|---|---|
| `adw-revise` | review = *changes requested* on a bot PR | `builder` addresses findings on the same branch; re-review fires on the push | a push emits `synchronize`, not a review — never self-triggers; `sweeper` brakes an endless loop |
| `adw-docs` | merged PR touching **product code** (not docs/site/prototypes/config) | `docs-writer` updates docs + site to match, or no-ops | doc-only PRs are `paths-ignore`d, so `docs-writer`'s own PR can't re-trigger it |
| `adw-release` | `v*` tag (the owner's release touchpoint) | `release-manager` drafts notes, verifies §14, publishes a Release | tag push is owner-made; relayed via dispatch (the action can't serve `push`) |
| `adw-comment` | **owner** writes `@smith …` on an issue/PR | routes the instruction to the fitting agent, or answers | locked to `author_association == OWNER` — a public-repo stranger's comment does nothing; agents' own comments aren't the owner |
| `adw-alerts` | Dependabot / code-scanning alert (or daily) | `security-reviewer` sweeps open alerts, escalates real high-severity, ignores prototype-only ones | alert events relay to dispatch (action can't serve them); a schedule backstops missed events |
| *CI self-heal* | — | folded into `sweeper` (hourly), not a per-event trigger | avoids the fiddly `check_suite`→PR mapping and its loop risk; fits the predictability dial |

The one deliberately-owner-gated reaction is `adw-comment`: because the repo is
public, a comment body is untrusted input, so only the owner may steer through it.
Everything else keys off structural events (a review verdict, a merge, a tag) that
agents produce as a matter of course, which is why the loop-guards matter — without
them, an agent's own review or merge would wake another agent without end.

## Coordination — choreography and a single writer

Three agents open issues and touch milestones (`planner`, `surveyor`, `triager`),
so they need to coordinate without stepping on each other. Two rules make that
happen by construction, not by hoping three prompts agree.

**No central orchestrator — choreography.** There is deliberately *no* dispatcher
agent that wakes on every event and routes to a subagent. The routing already
lives, declaratively, in the workflow `on:` triggers and `if:` guards: each event
maps to its agent with no LLM in the middle. An orchestrator would add cost,
latency, a single point of failure, and — worst for the dial — a model *guessing*
the route. The only per-item routing judgment belongs to `triager` (one issue →
`ready` / `needs:spec` / `needs:prototype`), which is scoped triage, not global
control. If routing ever branches, the answer is a **deterministic dispatcher
workflow** (plain `if:` logic), never an LLM conductor. Recorded here so it is a
decision, not an omission someone later "fixes."

**Milestones: one writer, one source.** Waves are defined once — the
`WALKING-SKELETON` build sequence is the first milestone, `TASK-BREAKDOWN` holds
the rest — and all three agents *read* that order; none redefine it. **`planner`
is the sole milestone *creator*.** `surveyor` and `triager` only *file issues into*
an existing milestone, never open one, and only the **current** wave is open at a
time. Single-writer + single-source is what keeps the three from inventing
overlapping or misordered waves.

**Work-orders: one format.** Every issue the three open uses the same shape — one
deliverable, its SPEC anchor, acceptance in the spec's own terms, filed under the
current milestone. That is the `.github/ISSUE_TEMPLATE/task.md` shape; the agents
follow it so `builder` always meets the same contract, whoever wrote the order.

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

## Leaning into GitHub (the reviewed trail)

The point is to use GitHub's own machinery as the record, so nothing the agents
do is invisible. Beyond the issue→PR spine:

| Concern | Feature | Owned by |
|---|---|---|
| unit of work | **Issues** (+ sub-issues) | triager / planner / surveyor |
| lifecycle state | **Project (v2)** board: Triage → Ready → In Progress → In Review → Security → Done; fields for risk / wave / owner | each agent moves its own card; `sweeper` reconciles drift |
| routing & gates | **Labels** (`.github/labels.yml`, as code) | triager / security-reviewer |
| grouping | **Milestones** = waves | `planner` opens + assigns; `surveyor` fills the current one; `release-manager` closes |
| every change | **PRs** linked to issues, agent-reviewed | builder |
| spec protection | **CODEOWNERS** + branch **ruleset** | (owner) |
| dependency updates | **Dependabot** (`.github/dependabot.yml`) — bumps as maintenance | dependency-manager |
| code scanning | **DevSkim** (`.github/workflows/devskim.yml`, SARIF → Security tab) + **CodeQL** (Rust) + `cargo audit`/`cargo deny` in CI | security-reviewer |
| secret scanning | **Secret scanning + push protection** (repo setting) | security-reviewer |
| shipping | **Releases** (binaries + checksums, §14) — *not* Packages | release-manager |
| site + book | **Astro site + mdBook book → Pages** (`.github/workflows/pages.yml`, one deploy on push to `main`) | docs-writer |
| compute | **Actions** workflows | — |

Projects v2, Discussions, Pages, and Releases aren't reachable from the MCP
toolset but are reachable from `gh` / `gh api graphql` inside Actions — so the
agents (which run in Actions) drive them. Code scanning, secret scanning, and
push protection are **repo settings** the owner enables once; the agents then
triage their alerts.

Two owner-added workflows already sit on `main` and the plan wraps around them
rather than replacing them:

- **`devskim.yml`** runs Microsoft's DevSkim on push / PR / weekly and uploads
  SARIF to the Security tab. It is a second scanner alongside CodeQL and `cargo
  deny`; `security-reviewer` triages its alerts the same way (SPEC §9 / §6.7
  lenses), and a finding that traces to a spec gap takes the escape valve
  (`needs:spec`). Being on `main` already, it needs no merge to activate.
- **`pages.yml`** publishes the two web artifacts in one Pages deployment (Pages
  allows only one site per repo): the **site** — Astro (Node), under `site/`,
  served at `/` — and the **book** — mdBook (`cargo install`-able), under
  `docs/book/`, served at `/book`. `docs-writer` owns both content trees, not the
  workflow. The site's Node build is confined to `site/` and exempted by the §1
  scope note; the book needs no exemption. The workflow is dormant-safe: each half
  builds only if its manifest exists and deploy is skipped until at least one is
  scaffolded, so `main` stays green until those work-orders land.

### Milestones and the board — planning in the open

The two features exist to make the plan *visible on GitHub itself*, not buried in
`docs/plans/`. They carry different axes and have different maturity:

- **Milestones = waves (wire now).** A milestone is one wave of the walking
  skeleton. `planner` opens a milestone per wave and files each work-order into it;
  `surveyor` only opens slices from the **current** milestone, in order, and does
  not reach into the next wave until the current one closes — that ordering is what
  keeps autonomous build-out marching the skeleton rather than sprawling.
  `release-manager` treats a milestone going all-closed-and-green as the trigger to
  cut a release. Milestones are first-class REST (reachable from the MCP `milestone`
  field and from `gh`), so this is cheap and encoded now — no proof needed.
- **The board = lifecycle (gated on proof).** The Project (v2) board carries the
  *state* axis milestones don't: Triage → Ready → In Progress → In Review →
  Security → Done, with fields for risk / wave / owner. Each agent moves its own
  card as the diagram annotates (`triager`→Ready, `builder`→In Progress→In Review,
  reviewers→Security/Done, merge→Done), and `sweeper` reconciles cards that drift
  from reality (a card stuck "In Review" on a PR that already merged). **But
  Projects v2 is reachable only via `gh api graphql`, which p35 did not exercise** —
  so board-driving is *designed, not yet proven*. It is gated on two things: the
  board existing (owner, issue #14) and a mechanic proof that an Action step can
  read and move a card with the App token (a `needs:prototype`, the same discipline
  p35 applied to the action). Until both land, **issues + labels + milestones are
  the load-bearing state**, and the board is best-effort mirror, not source of
  truth. This keeps the cycle honest: no agent blocks on a surface that isn't
  proven to work.

## Release lifecycle — Releases, not Packages

Cutting a release is a gated, predictable event:

1. A milestone's issues all close and `main` is green.
2. `release-manager` drafts notes from the merged PRs and verifies the SPEC §14
   target matrix still cross-builds (proven in `prototypes/p34-ci-pipeline`).
3. It opens a release-readiness issue; the **owner approves the version tag** —
   the one release touchpoint.
4. On the `v*` tag, the release workflow builds every §14 triple (`cargo-zigbuild`
   for linux/windows-gnu, native runners for msvc/darwin), emits
   `smith-{triple}-v{version}` archives + `checksums-sha256.txt`, and publishes a
   **GitHub Release**.

**Why Releases and not Packages:** GitHub Packages hosts registry artifacts
(containers, crates, npm). Smith v1 ships standalone binaries + checksums for end
users to download — exactly what Releases are for — and SPEC §14 rules out
package manifests and distribution metadata in v1. Packages can be revisited only
if Smith ever publishes a container image or a crate.

## Identity — the keystone

The App is provisioned: **`agent-smith-bugabinga-adc`** is created, installed on
the repo, and its `APP_ID` / `APP_PRIVATE_KEY` are stored as secrets. It is
required, not optional, for two reasons:

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

## Signed commits — verified trail, now; enforced, later

The reviewed trail is also a **cryptographically** verified one. Two layers,
both available now that the repo is **public** (rulesets, branch protection, and
code scanning are free on public repos):

- **Agents sign — on now.** The committing workflows (`adw-build`, `adw-plan`,
  `adw-deps`) set `use_commit_signing: true`, so `claude-code-action` writes each
  commit through GitHub's API with the App installation token. Every agent commit
  lands **Verified**, signed by `agent-smith-bugabinga-adc` — no keys to manage,
  no local GPG. The owner's own edits from the GitHub web UI are auto-signed too,
  so the phone-only path stays Verified.
- **Enforce it — now possible.** A branch **ruleset** on `main` with *Require
  signed commits* + *Require a pull request before merging* (CODEOWNERS review) +
  *Require linear history* makes only Verified, reviewed, rebase-merged commits
  land. This was blocked while the repo was private on the free plan; going public
  removed the block. It is the one owner enable-step (issue #14), and a proposed
  upgrade to the PROJECT-INVARIANTS §7 version-control rule — pending owner
  approval before that invariant is edited.

The cost of enforcement is that a local unsigned commit (bare git/jj with no
signing key) would be rejected on `main` — acceptable for a mostly-agent +
web-owner flow, since web-UI edits are auto-signed.

The ruleset's definition is version-controlled at `.github/rulesets/main.json`.
GitHub does **not** auto-read that path (unlike `.github/workflows/`,
`dependabot.yml`, or `CODEOWNERS`) — the file is the reviewable *record* of intent,
applied deliberately once with
`gh api --method POST /repos/bugabinga/smith/rulesets --input .github/rulesets/main.json`
(the REST shape; the UI importer wants the fatter *export* shape). Keeping it as a
file means the ruleset is diffed and reviewed like any other change, even though a
human runs the apply. Its `pull_request` rule is tuned so autonomy survives
enforcement: `required_approving_review_count: 0` with
`require_code_owner_review: true` means an ordinary agent PR merges with **no**
human approval, while any PR touching a CODEOWNERS-owned path — `docs/SPEC.md`,
the workflows, the agent files, the invariants — still requires the owner's
review. That is touchpoints 1 and 3, expressed as one rule: the spec and the
machinery are gated to the human; everything the spec already implies flows on
its own. GitHub signs the rebase-merge commits it creates on merge, so
`required_signatures` is satisfied without the App holding a key.

The ruleset also lists the **`merge-gate`** status check as required (that is what
native auto-merge waits on — see *Merging*) and grants the **repository-admin role
an `always` bypass**. The bypass is the owner's escape valve: because rulesets do
*not* auto-exempt admins and `merge-gate` depends on the agents applying their
verdict labels, without it the owner could be unable to merge their own spec PR if
the agents were down or disagreed. The App is not an admin, so agents never
inherit the bypass — only the human does.

## Runners — how an agent actually executes (proven by p35)

The live harness `prototypes/p35-adw-harness` settled the mechanics, and the
action's docs settled the rest:

- **Identity works.** `actions/create-github-app-token@v1` mints a working
  installation token from `APP_ID` / `APP_PRIVATE_KEY`; agent actions run as
  `agent-smith-bugabinga-adc` and cascade.
- **One runner: `claude-code-action@v1`, in two modes.** It routes by event:
  *interactive* (issue / PR / comment — reads that entity and replies) and
  *automation* (`schedule` / `workflow_dispatch` — runs an explicit `prompt`).
  It **rejects `push`** because that has no entity and fits neither mode. So a
  push-triggered agent (`planner`) is split into a plain no-Claude watcher that
  `gh workflow run`s the action on `workflow_dispatch`. No CLI is used — the
  headless `claude -p` path is dropped.
- **Subscription auth, no metered API.** Every workflow authenticates with
  `claude_code_oauth_token` (`${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`, generated
  once with `claude setup-token`), which draws on the owner's Claude
  subscription — not per-token API billing. `anthropic_api_key` is not used.
  Until the secret exists no agent can call a model (issue #13).
- **Event workflows fire only from `main`.** `issues` / `pull_request` /
  `schedule` workflows run from the default branch, so the ADW activates only
  once merged (issue #14). A branch can exercise `push`-triggered probes (how
  p35 ran), not the real triggers.

## Guardrails

- **Cost / runaway** — per-run `--max-turns`, concurrency caps, and the
  `sweeper` as circuit-breaker; token budgets. The `surveyor` self-throttles: it
  opens at most one slice per tick and only when the front is clear, so schedule
  ticks cannot pile up work.
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

1. ~~**Auto-merge gates.**~~ **Decided: native auto-merge, low-risk** (see
   *Merging* below). The gate is: required checks green (incl. `merge-gate`) +
   `reviewed` + `security-cleared` + no blocking label. `risk:high` holds it for
   the owner. Encoded, not just described.
2. **Create the `smith-bot` App** (only the owner can). *(Done — installed.)*
3. **Risk threshold** for what forces human review (touchpoint #3). Current line:
   `risk:high` (set by `security-reviewer` on high/critical severity) and any PR
   touching a CODEOWNERS path (spec, workflows, agents, invariants).

## Phased rollout

- **Phase 0** — CODEOWNERS + branch protection on the spec (enforces touchpoint
  #1); create the Project board; land the `.claude/agents/*` personas. No
  autonomy yet.
- **Phase 1** — `issues → triager → implementer → PR` on the existing proven CI;
  **human reviews every PR** (build trust in the trail).
- **Phase 2** — add `reviewer` + `security-reviewer`; enable gated auto-merge for
  `risk:low` only (requires decision #1).
- **Phase 3** — add `surveyor` (self-advancing build-out) + `sweeper` (the
  circuit-breaker); full autonomy with the human at the three touchpoints.

Each phase is independently useful and reversible.
