# Plans

Non-normative execution plans — the bridge from `docs/SPEC.md` (what to build)
to code (in what order). The spec is canonical; a plan never overrides it.

| Plan | Covers | Status |
|------|--------|--------|
| `TASK-BREAKDOWN.md` | crate build order (SM-003→012), wave sequencing | pre-implementation |
| `PLUGIN-DOC-PLAN.md` | plugin-SDK doc source, `smith help`, doc tooling/tests | pre-implementation |

## Is this the whole set?

For the spec/planning phase, yes — but the coverage is deliberately lopsided
(deep on plugin docs, only crate-granular on the product itself), and two plans
are intentionally *not* written yet to avoid speculative planning:

- **A first-vertical-slice (walking-skeleton) plan.** `TASK-BREAKDOWN` is
  bottom-up, so nothing runs end-to-end until the last wave. The first
  implementation move should instead be a thin slice — scaffold → minimal
  `smith/` types → one provider stream → minimal agent loop → minimal TUI → one
  session round-trip — proving the whole pipeline before widening. Write it when
  implementation starts.
- **Per-crate breakdowns.** Each SM-0xx task is crate-sized; it gets decomposed
  into tested units at the start of its own wave, not now.

Prototype evidence that de-risks all of this lives in `../../prototypes/PLAN.md`.
