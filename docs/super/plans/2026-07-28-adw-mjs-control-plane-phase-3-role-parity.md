# ADW Role Parity and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Encode every invariant-permitted ADW role as validated data and pure reducers, then prove legacy marker/state reconciliation through offline end-to-end scenarios.

**Architecture:** `roles.mjs` gains the production registry and role payload validators; `core.mjs` maps validated role artifacts plus normalized snapshots into the closed operation set. `github.mjs` expands snapshots into bounded normalized resources, while all provider/forge/VCS effects remain injected and dry-run-only until Phase 5.

**Tech Stack:** Node.js ESM/standard library, `node:test`, existing MJS adapters and JSON fixtures.

**Roadmap:** `docs/super/roadmaps/2026-07-28-adw-mjs-control-plane-roadmap.md`

**Phase:** Phase 3: Role Parity and Reconciliation

---

## Canonical role matrix

| Role | Mode | Primary | Fallback | Payload family | Patch |
|---|---|---|---|---|---|
| steerer | single | Claude opus/high | Codex sol/high | steering | no |
| triager | single | Codex luna/medium | Claude opus/high | triage | no |
| planner | single | Claude fable/xhigh | Codex sol/xhigh | plan | no |
| surveyor | single | Claude fable/high | Codex sol/high | survey | no |
| builder | single | Claude opus/high | Codex terra/high | change | product/config except global denials |
| codex-builder | single | Codex terra/high | none | change | routed product/config |
| pioneer | single | Claude opus/high | Codex sol/high | pioneer | `prototypes/` only |
| reviewer | single | Claude opus/xhigh | Codex sol/high | review | no; fallback authority denied on protected/incomplete/fork/binary/oversized input |
| security-reviewer | single | Claude opus/high | Codex sol/high | security-review | no; same fallback restrictions |
| reviser | single | Claude opus/high | Codex terra/high | change | current PR paths only |
| sweeper | single | Codex luna/low | none | maintenance | no |
| adw-doctor | single | Codex sol/xhigh | Claude opus/high | diagnosis | no control-plane patch; issue only |
| docs-writer | single | Codex terra/medium | Claude opus/high | change | docs/site/book only |
| dependency-manager | single | Codex terra/medium | Claude opus/high | dependency | no direct patch |
| alert-triager | single | Claude opus/high | Codex sol/high | alert | no |
| settings-auditor | deterministic | none | none | drift | no |
| jam-detector | deterministic | none | none | jam | no |
| label-sync | deterministic | none | none | labels | no |

`steerer` runs only for an owner-ID-authenticated `@smith` issue/PR comment, never bot/non-owner text; it emits one comment/no-op and cannot mutate labels/code. Release-manager remains deferred with release automation. Projects v2 remains deleted. Exact timeout ceiling is 300 seconds for all provider roles. CLI versions remain Phase 2 pins.

## File map

- `adw/roles.mjs`: production/deterministic registries, model matrix, payload families, snapshot bounds, capabilities, operations, fallback and patch policies.
- `adw/core.mjs`: payload validation, role reduction, marker parsing, obligation derivation, route/review/risk/reconciliation transitions.
- `adw/github.mjs`: bounded role snapshot expansion and normalized timeline/check/milestone/alert/settings records.
- `adw/schemas/role-payloads/*.schema.json`: provider-facing exact JSON Schemas per payload family.
- `adw/test/roles.test.mjs`: full matrix and payload tests.
- `adw/test/scenarios.test.mjs`: issue-to-merge, maintenance, retry, hold, and post-merge scenarios.
- `adw/test/fixtures/legacy/*.json`: captured marker/event/state records.

### Task 1: Production role registry

**Files:**

- Modify: `adw/roles.mjs`
- Modify: `adw/test/roles.test.mjs`

- [x] Write failing tests asserting the exact matrix above, charter path existence, model/effort/timeout, required capabilities/snapshot fields, allowed operations, fallback restrictions, global patch denials, deterministic-role separation, and absence of release-manager/Projects.
- [x] Run `node --test adw/test/roles.test.mjs`; expect missing registry exports.
- [x] Export `role(name)`, `listRoles()`, `deterministicRole(name)`, and `listDeterministicRoles()` over deeply frozen data created through `defineRole`; unknown names throw `AdwError("role", ...)`.
- [x] Keep one matrix object; no classes, inheritance, registry mutation, default models, or duplicate role files.
- [x] Run role tests and commit: `Encode the production ADW role matrix`.

### Task 2: Exact role payload contracts

**Files:**

- Modify: `adw/roles.mjs`
- Create: `adw/schemas/role-payloads/triage.schema.json`
- Create: `adw/schemas/role-payloads/plan.schema.json`
- Create: `adw/schemas/role-payloads/survey.schema.json`
- Create: `adw/schemas/role-payloads/change.schema.json`
- Create: `adw/schemas/role-payloads/pioneer.schema.json`
- Create: `adw/schemas/role-payloads/review.schema.json`
- Create: `adw/schemas/role-payloads/maintenance.schema.json`
- Create: `adw/schemas/role-payloads/dependency.schema.json`
- Create: `adw/schemas/role-payloads/alert.schema.json`
- Modify: `adw/test/roles.test.mjs`

- [x] Write failing table tests for `validateRolePayload(roleName, payload)`: exact keys, closed verdict enums, bounded text/findings/labels, no unknown fields, explicit no-op reason, steering `comment|noop`, patch metadata only for patch roles, pioneer `proved|disproved|inconclusive`, review `approve|reject` plus findings/risk, and malformed/oversized rejection.
- [x] Define one exact shape per payload family. Findings are `{ severity: "low|medium|high", path, line, message }`; no arbitrary commands or forge operation objects appear in provider payloads.
- [x] Generate matching draft-2020-12 schemas with nested `additionalProperties:false`; each role record points at one schema path and validator family.
- [x] Run role/schema tests and commit: `Close every ADW role artifact contract`.

### Task 3: Role artifacts to closed operations

**Files:**

- Modify: `adw/roles.mjs`
- Modify: `adw/core.mjs`
- Modify: `adw/test/roles.test.mjs`

- [x] Write failing tests for `reduceRoleArtifact({ snapshot, rolePolicy, reduction, assessments })` covering every payload verdict and operation mapping.
- [x] Require selected assessment digests, exact current resource revisions, holds, and role operations before mapping.
- [x] Map owner-authenticated steering to comment/no-op; map triage/planning/maintenance/alert payloads to deterministic issue/comment/label/milestone/check/rerun/drift operations; map patch payloads to branch/PR/update operations plus bound patch metadata; map reviews to current-head App evidence/check/labels; map no-op to explicit `noop` only.
- [x] Encode pioneer exactly: `proved` closes the linked work-order only when its closing PR artifact qualifies; `disproved` leaves it open, adds `needs:spec`, and records the falsified claim; `inconclusive` leaves it open/retryable without proof labels or queue suppression.
- [x] Negative/security-high decisions dominate; protected fallback can report findings but cannot emit approval labels/check success.
- [x] Validate every emitted operation with `validateOperation`, then return a `validateDecision` record.
- [x] Run core tests and commit: `Reduce role artifacts into closed operations`.

### Task 4: Legacy markers and bounded reconciliation

**Files:**

- Modify: `adw/core.mjs`
- Create: `adw/test/fixtures/legacy/routes.json`
- Create: `adw/test/fixtures/legacy/reviews.json`
- Create: `adw/test/fixtures/legacy/jams.json`
- Modify: `adw/test/core.test.mjs`

- [ ] Write failing tests for strict parsing of `smith:claude-attempt/v1`, `smith:builder-route/v1`, current-head reviewer/security evidence, sticky risk, jam, and merge-finalization markers; malformed/forged/stale markers are data, never authority.
- [ ] Parse only App-authored markers with exact version/fields and bounded scan order; latest valid marker wins, conflicts fail closed.
- [ ] Expand reconciliation to derive stale routes, missing current-head reviews, dropped label sync, failed/missing post-merge obligations, held work, pioneer verdict state, and equivalent completed artifacts without replacing label sets.
- [ ] Preserve one fallback maximum and deterministic route branches; fork PRs and wrong-repository closing issues never qualify.
- [ ] Run marker/reconciliation tests and commit: `Import legacy ADW state without trusting labels`.

### Task 5: Bounded normalized role snapshots

**Files:**

- Modify: `adw/github.mjs`
- Modify: `adw/test/github.test.mjs`
- Create: `adw/test/fixtures/snapshots/*.json`

- [ ] Write failing tests for role/event snapshot plans covering owner-authenticated steering comments, issue comments/timeline/labels/milestones/parent links, PR diff metadata/reviews/checks/files, workflow runs, alerts, settings/rulesets read-only, and merged-PR obligations.
- [ ] Add only closed adapter methods and normalized records; no generic endpoint/path or raw GitHub JSON escapes. Every content field is an exact envelope `{ trust: "trusted|untrusted", source, bytes, digest, data }`: base-branch charters/config are trusted; issue/PR/comment/diff/provider text is untrusted and prompt assembly states that boundary explicitly.
- [ ] Enforce each role’s declared fields/max bytes, page/record/scan caps, trusted App/owner IDs, control SHA, and resource revision list.
- [ ] Required truncation/overflow/unsupported capability fails `forge`; optional absent data is explicit null/empty.
- [ ] Run GitHub snapshot tests and commit: `Build bounded role snapshots from forge state`.

### Task 6: Full offline role scenarios and parity

**Files:**

- Create: `adw/test/scenarios.test.mjs`
- Modify: `adw/test/dry-run.test.mjs`
- Modify: `docs/super/plans/2026-07-28-adw-mjs-control-plane-phase-3-role-parity.md`

- [ ] Add issue→triage→plan→builder→PR→review→security→check→auto-merge-intent scenarios for Claude primary, Codex fallback, current-head update, hold before every write, reviewer disagreement, sticky-risk owner clearance, stale artifacts, both-provider failure, and missed-event reconciliation.
- [ ] Replace the shell gate contract exactly: require current-head App evidence plus labels `reviewed` and `security-cleared`; block `risk:high`, `blocked`, `changes-requested`, `needs:info`, `needs:spec`, and `needs:prototype`; `stalled` never blocks; require current-head product `check`; publish `merge-gate` then arm squash auto-merge only after all conditions pass. Labels never substitute for evidence.
- [ ] Add pioneer proved/disproved/inconclusive, dependency safe/risky, alert covered/uncovered, settings drift, doctor issue-only, docs no-op/change, jam, label sync, and post-merge failure/retry scenarios.
- [ ] Replay captured legacy fixtures and assert either identical semantic intent or an explicit approved deletion (Projects/release/self-modifying doctor).
- [ ] Run all Node and legacy suites, boundary greps, `git diff --check`, and read-only dry-run fixtures.
- [ ] Mark plan complete, record exact counts/differences, and commit: `Prove ADW role parity offline`.
