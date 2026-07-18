# Plans

Non-normative execution plans — the bridge from `docs/SPEC.md` (what to build)
to code (in what order). The spec is canonical; a plan never overrides it.

| Plan | Covers | Status |
|------|--------|--------|
| `WALKING-SKELETON.md` | first vertical slice — one turn end-to-end, proving the four seams | ready to start |
| `TASK-BREAKDOWN.md` | crate build order (SM-003→012), wave sequencing | pre-implementation |
| `PLUGIN-DOC-PLAN.md` | plugin-SDK doc source, `smith help`, doc tooling/tests | pre-implementation |

## Is this the whole set?

`WALKING-SKELETON` is the entry point for implementation — a thin slice through
every layer that proves the StreamFn, EngineEvent, session-codec, and TUI seams
connect before any of them is built out. `TASK-BREAKDOWN` is the full crate
sequencing that follows once the skeleton is green. One thing is still
intentionally *not* written, to avoid speculative planning:

- **Per-crate breakdowns.** Each SM-0xx task is crate-sized; it gets decomposed
  into tested units at the start of its own wave, not now.

Prototype evidence that de-risks all of this lives in `../../prototypes/PLAN.md`.
