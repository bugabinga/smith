# Smith Task Breakdown

> Non-normative execution plan. `docs/SPEC.md` is canonical; where this file and
> the spec disagree, the spec wins. Architecture and crate responsibilities are
> defined once in SPEC §2 and CLAUDE.md — this file only sequences the build.

Top-level build order for the first implementation pass, at crate granularity.
Each task is a whole crate; decomposition into buildable, tested units is
deferred to that crate's own wave (see **Granularity**).

## Task dependency graph

```
SM-003 (scaffolding) ── SM-005 (smith/) ──┬── SM-006 (smith-core/) ──┐
                  ├── SM-007 (smith-ai/)   ──┼── SM-009 (smith-harness/) ── SM-010 (smith-cli/)
                  └── SM-008 (smith-tui/)  ──┘            │
                                                        SM-011 (workspace)
                                                             │
                                                        SM-012 (testing)
```

The edges are the §2.2 boundary rules: `smith/` is the sole foundation;
`smith-core` / `smith-ai` / `smith-tui` build in parallel and never depend on
each other; `smith-harness` wires them; `smith-cli` sits on top.

## Execution order

```
Wave 0: SM-003  scaffolding — jj repo, Cargo workspace, crate skeletons, xtask
Wave 1: SM-005  smith/ — foundation types (sequential; everything blocks on it)
Wave 2: SM-006 + SM-007 + SM-008  core / ai / tui (parallel)
Wave 3: SM-009  smith-harness — wiring (after wave 2)
Wave 4: SM-010 + SM-011  cli + workspace (parallel)
Wave 5: SM-012  integration tests
```

## Tasks

| Task | Crate | Blocked by | Blocks |
|------|-------|------------|--------|
| SM-003 | workspace | — | SM-005 |
| SM-005 | smith/ | SM-003 | SM-006/007/008 |
| SM-006 | smith-core/ | SM-005 | SM-009 |
| SM-007 | smith-ai/ | SM-005 | SM-009 |
| SM-008 | smith-tui/ | SM-005 | SM-009 |
| SM-009 | smith-harness/ | SM-006/007/008 | SM-010 |
| SM-010 | smith-cli/ | SM-009 | SM-012 |
| SM-011 | workspace | SM-009 | SM-012 |
| SM-012 | testing | SM-010, SM-011 | — |

What each crate owns and must not own is defined once in SPEC §2.2 — not
repeated here, to avoid drift.

## Granularity

These tasks are crate-sized, not buildable units: "SM-006 smith-core" is an
entire agent loop plus session, tools, hooks, and events. Before a crate's wave
starts it needs its own breakdown into vertical, tested slices. This file is
top-level sequencing only; a pure bottom-up walk of it produces nothing runnable
until SM-010, so the first implementation move should be a thin end-to-end slice
(walking skeleton) rather than a full horizontal wave — see the plans index.
