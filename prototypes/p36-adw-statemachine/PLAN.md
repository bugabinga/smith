# p36 — ADW as a state machine, model-checked

Validates the **Agentic Development Workflow** (`docs/plans/AGENTIC-DEVELOPMENT.md`),
not a `SPEC.md` claim: does the encoded merge-gate + loops actually hold, and are
the audit's holes real? An explicit-state model checker (std-only, no deps)
models one PR's life — push, CI, the two label verdicts, security escalation, the
`needs:spec` escape valve, and native auto-merge released by `merge-gate` — then
BFS-explores every reachable state (bounded to `MAX_HEAD=3` pushes) and checks
safety + liveness. Ground truth (`code_ok`, the head a reviewer actually saw) is
kept *hidden from the gate*, so the checker can catch the gate trusting a label
that lies.

## Status
complete

## Proved
- **The gate is sound as designed.** Under `Config::FIXED` (require-CI + strip
  stale labels on push), across all **1284** reachable states, no state is
  reachable that: merges broken code, merges a head no reviewer saw, or merges
  with a blocking label (`risk:high` / `blocked` / `changes-requested`) set.
- **The cycle stays live.** A clean merge is reachable (the gate is not a
  deadlock) and the `needs:spec` escape valve is reachable — so the safety rules
  don't freeze progress.
- **`blocked`/`risk:high`/`changes-requested` never co-merge under *any* config**
  — the gate structurally forbids it regardless of the fix toggles (a separate
  invariant, holds in all three runs).
- **The two audit holes are real, with concrete counterexamples:**
  - Issue **#17** (no required CI check): `Config::NO_CI` reaches a merged state
    with `code_ok=false` — broken code auto-merged on two LLM labels.
  - Issue **#3** (no stale-label reset): `Config::NO_RESET` reaches a merged state
    at `head=2` whose `reviewed_head=1` — an unreviewed revision merged behind a
    stale `reviewed`.
- Both fixes are therefore load-bearing, not cosmetic: turning either off makes
  an unsafe merge reachable; turning both on makes it unreachable.

## Disproved
- None. The FIXED design met every invariant checked; no safety property failed.

## Spec Issues
- None against `docs/SPEC.md` (this exercises the ADW plan, not the spec). It
  confirms the fixes committed for issues #3 and #17 are necessary and sufficient
  *within the modeled scope* (single PR, bounded pushes); multi-PR races (#7),
  identity/authorization (#19), and injection (#18) are out of this model's scope
  and remain tracked.

## Prototype Artifacts
- `prototypes/p36-adw-statemachine/Cargo.toml`
- `prototypes/p36-adw-statemachine/src/lib.rs` — model + BFS checker + tests
- `prototypes/p36-adw-statemachine/src/main.rs` — narrated report

## Commands
- `cargo test` — 4 tests pass (FIXED safe+live; NO_CI and NO_RESET counterexamples
  found; blocking-labels-never-merge across all configs). Exit 0.
- `cargo run` — prints the reachable-state counts and the counterexamples.

## Next Steps
- Land issue **#17** (make CI a required check) — the model shows it is the single
  fix that keeps `code_ok=false` from merging.
- Extend the model (future) to two concurrent PRs to exercise the duplicate-open
  race (#7) and WIP limits, and an identity dimension for #19.
- Disposable evidence (SPEC §18); delete once the ADW is live and its real gate is
  exercised end to end.
