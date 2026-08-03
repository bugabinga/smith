# ADW MJS Control Plane Roadmap

> **For agentic workers:** Use /skill:writing-plans to create one detailed implementation plan per phase. Start with Phase 1 and proceed sequentially unless the user explicitly changes the order.

**Goal:** Replace GitHub-workflow ADW policy with a tested, credential-isolated, forge-bounded MJS control plane without interrupting the authoritative legacy loop.

**Design Spec:** [`docs/super/specs/2026-07-28-adw-mjs-control-plane-design.md`](../specs/2026-07-28-adw-mjs-control-plane-design.md)

**Planning Strategy:** Six phases separate pure policy, external adapters, role parity, live proof, atomic authority transfer, and cleanup so every boundary stays green and rollbackable.

---

## Phase 1: Pure Control-Plane Foundation

**Outcome:** Dependency-free CLI skeleton, normalized contracts, schemas, pure reducers, and fixture tests exist without reading live forge state or invoking providers.

**Why now:** Every adapter and migration step depends on stable records and fail-closed policy.

**Scope:**

- `main.mjs`, `core.mjs`, `roles.mjs`, schemas, fixture adapters, and `node:test` harness.
- Event, revision, envelope, decision, operation, verification, hold, route, review, and merge-gate contracts.
- State-only and structural patch validation with global protected-path rules.

**Out of scope:**

- Live `gh`, `git`, Claude, Codex, workflow wrappers, or forge writes.

**Key files/areas likely affected:**

- `adw/`: new control-plane foundation and tests.
- `.github/workflows/adw-selftest.yml`: run Node tests while preserving existing legacy tests.

**Dependencies:**

- Approved design and PROJECT-INVARIANTS §1 exception.

**Verification:**

- Offline `node --test adw/test/*.test.mjs` passes without credentials.
- Existing ADW tests and product CI remain green.

**Phase boundary health:** Legacy ADW remains the only production reader/writer; new code is inert except self-tests.

**Risks:**

- Premature adapter assumptions; keep core records forge-neutral and fixtures minimal.

**Context notes:** Prefer data tables and pure functions; reject abstractions without two immediate callers.

## Phase 2: Credential-Isolated Adapters and Dry-Run

**Outcome:** GitHub, VCS, and provider adapters implement bounded reads, isolated execution, stamped artifacts, and mutation recording under dry-run.

**Why now:** Role parity needs proven process, credential, transport, and adapter boundaries.

**Scope:**

- `github.mjs`, `vcs.mjs`, and `providers.mjs` with injected process adapters.
- Exact-pinned temporary CLI installation, environment allowlists, timeouts, and output bounds.
- Trusted-control SHA, sidecar digests, clean worktrees, and no-target-execution verification.
- Live read-only `dry-run` and mutation-intent recording.

**Out of scope:**

- Production writes, canonical charter edits, or workflow replacement.

**Key files/areas likely affected:**

- `adw/github.mjs`: sole GitHub/`gh` boundary.
- `adw/vcs.mjs`: sole `git` boundary.
- `adw/providers.mjs`: sole provider process boundary.
- `adw/test/`: adapter and security fixtures.

**Dependencies:**

- Phase 1 contracts.

**Verification:**

- Adapter argv/stdin, pagination, permission, timeout, digest, and patch-security tests pass.
- Read-only production dry-run and tokenless provider schema probes produce valid bounded artifacts.

**Phase boundary health:** New code still cannot mutate production; legacy remains authoritative.

**Risks:**

- CLI drift or accidental credential inheritance; exact version checks and explicit environment construction fail closed.

**Context notes:** Keep all GitHub names out of core and all command execution shell-free.

## Phase 3: Role Parity and Reconciliation

**Outcome:** Every invariant-permitted ADW role reduces validated artifacts into closed operations, with legacy marker import and missed-event repair.

**Why now:** Wrappers cannot replace legacy until policy and recovery behavior are complete.

**Scope:**

- Planner, surveyor, builders, reviewers, reviser, triager, sweeper, doctor, docs, dependency, alert, settings, and jam-detector contracts.
- Provider-primary/fallback/quorum matrices and protected fallback restrictions.
- Sticky-risk, current-head evidence, route, milestone, post-merge obligation, and idempotency transitions.
- Full offline issue-to-merge and maintenance scenarios.

**Out of scope:**

- Canonical charter mutation or production authority.
- Projects v2 and release automation.

**Key files/areas likely affected:**

- `adw/roles.mjs`: role matrix and validators.
- `adw/core.mjs`: reducers and reconciliation.
- `adw/test/fixtures/`: captured legacy events and artifacts.

**Dependencies:**

- Phases 1–2.

**Verification:**

- Fixture replay matches intended legacy outcomes or records an explicit approved behavior deletion.
- Scenario tests cover both builders, provider failures, retries, holds, security conflict, and post-merge recovery.

**Phase boundary health:** Legacy still writes; MJS parity runs offline/read-only only.

**Risks:**

- Encoding obsolete behavior; canonical ADW plan wins over stale workflow/charter text.

**Context notes:** Preserve deterministic marker compatibility only while live legacy records need it.

## Phase 4: Wrapper and Disposable-Repository Proof

> **Owner-approved supersession (2026-08-01):** Phase 4 Tasks 1–6 remain the completed offline wrapper/failure evidence. Planned disposable-repository Tasks 7–8 remain unchecked and are superseded—not completed—by Phase 5 positive production testing during an owner-authorized quiet window. Production proof must never rotate secrets or inject malformed artifacts, stale writes, cancellation, provider failure, or partial writes.

**Outcome:** Candidate thin wrappers and the complete offline failure/retry/merge matrix are ready for the owner-approved Phase 5 production proof.

**Why now:** Authority transfer requires offline proof of triggers, permissions, credentials, artifacts, checks, and closed writes before positive production testing.

**Scope:**

- Candidate issue, pull, maintenance, and self-test wrappers held outside active production paths until cutover.
- Explicit App permission matrix and global writer concurrency.
- Offline write, provider-failure, retry, current-head, auto-merge, signing, and cleanup contracts retained as regression evidence.
- Wrapper contract tests and production read-only parity.

**Out of scope:**

- Production workflow disablement or legacy deletion.

**Key files/areas likely affected:**

- `adw/test/`: wrapper contracts and live scenarios.
- `prototypes/` and test fixtures: inactive candidate wrappers and offline evidence.

**Dependencies:**

- Phases 1–3 and the owner-approved production-proof substitution above.

**Verification:**

- Offline malformed/stale/partial/fallback and wrapper-contract suites pass with no provider job receiving forge credentials.
- Operational YAML candidate remains below 400 lines and contains no embedded policy/tools.
- Positive write-path evidence is deferred to the superseding Phase 5 plan; no disposable matrix is claimed complete.

**Phase boundary health:** Production remains entirely legacy-driven; candidate wrappers cannot trigger there.

**Risks:**

- Live GitHub semantics differ from mocks; Phase 5 uses positive production proof with signed rollback and no destructive injection.

**Context notes:** Test the exact artifact downloads and job conditions used at cutover, not approximations.

## Phase 5: Atomic Production Cutover

**Outcome:** Three MJS wrappers become the only operational ADW writers; legacy workflows, shell reducers, duplicated setup, and unsafe release workflow are gone.

**Why now:** All policy and live mechanics are proven; partial subsystem ownership would create dual writers.

**Scope:**

- Owner-coordinated legacy workflow disable/drain.
- Assessment-only canonical charters and three production wrappers.
- Atomic deletion of superseded ADW workflows/shell and activation of shared `adw-write` serialization.
- Marker/state import, current-head required checks, auto-merge, and immediate reconciliation.

**Out of scope:**

- Legacy marker-format removal, release automation, or issue backlog cleanup.

**Key files/areas likely affected:**

- `.github/workflows/`: three operational wrappers, self-test, and deletions.
- `.github/adw/`: deletion after fixture evidence moves under `adw/test/`.
- `.claude/agents/`: assessment-only charters.
- `adw/`: authoritative runtime.

**Dependencies:**

- Phases 1–4, owner approval, green required checks, and a quiet cutover window.

**Verification:**

- No legacy ADW workflow can start; no active legacy run remains before merge.
- Manual audit/reconcile, Codex triager, Claude owner steerer, review-comment/check reconcile-only paths, organic blocked/behind jam reporting, and label/settings drift handling produce bound production artifacts and complete receipts.
- PRs #150, #163, #165, and #166 reconcile at exact current heads without auto-merging while blocked/behind.
- Two consecutive natural scheduled reconciliation cycles succeed with no dual writers; production secrets remain unchanged and no malformed/stale/failure injection occurs.

**Phase boundary health:** One control plane owns all writes; owner-signed direct revert remains available.

**Risks:**

- Missed event during disable/drain; first reconciliation repairs forge-authoritative state.

**Context notes:** Never enable candidate wrappers before legacy is disabled and drained.

## Phase 6: Soak, Documentation, and Legacy-State Removal

**Outcome:** MJS operation is documented, observed, and free of expired compatibility paths; remaining ADW issues resume oldest-first.

**Why now:** Compatibility deletion requires evidence that no live legacy record remains.

**Scope:**

- One natural event per latency-critical trigger and two scheduled cycles.
- Update `docs/plans/AGENTIC-DEVELOPMENT.md` and operational guidance.
- Remove expired legacy marker parsing and transitional invariant wording.
- Close/supersede migration PRs/issues, then resume #20, #21, and #51.

**Out of scope:**

- Deferred release automation and unrelated Smith production implementation.

**Key files/areas likely affected:**

- `docs/plans/AGENTIC-DEVELOPMENT.md`: authoritative workflow description.
- `docs/PROJECT-INVARIANTS.md`: remove migration-only allowance.
- `adw/`: compatibility deletion only.

**Dependencies:**

- Phase 5 and soak evidence.

**Verification:**

- Two reconciliations and all critical trigger classes complete without unexplained terminal state.
- Full Node, Cargo, wrapper, dry-run, and retained offline failure regression suites pass.

**Phase boundary health:** Migration is complete; normal ADW maintenance continues through the owner-controlled control plane.

**Risks:**

- Hidden legacy markers; bounded scans report any survivor before compatibility removal.

**Context notes:** Delete transitional code rather than preserving indefinite compatibility.
