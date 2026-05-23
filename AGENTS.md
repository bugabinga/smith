# smith

Rust coding agent TUI. Phase: spec/planning. No code until specs are final.

## Architecture

```
smith/ (types, StreamFn, AgentTool, Lua, config)
  → smith-ai/ | smith-core/ | smith-tui/ (parallel)
  → smith-harness/ (wiring, plugins, SDK)
  → smith-cli/ (binary)
```

## Locked Decisions

| Decision | Rationale |
|----------|-----------|
| Latest stable Rust, ed. 2024 | Rolling MSRV follows stable compiler |
| mlua + LuaJIT | Performance, coroutines |
| CBOR sessions | Compact, binary-safe |
| Secret proxy (no keychain) | Cross-platform |
| XDG dirs | Linux standards |
| jj VCS | Modern DVCS |
| StreamFn abstraction | Decouples agent from providers |
| Lua plugins with sandbox | Safe extensibility |
| Rust widgets, Lua layout | Performance + flexibility |
| Cargo-only build system | Single entry point, no make/just/scripts |

## Source of Truth

### Specs (canonical subsystem specifications)
- `docs/specs/spec-sm-003-scaffolding.md`
- `docs/specs/spec-sm-004-architecture.md`
- `docs/specs/spec-sm-005-shared-types.md`
- `docs/specs/spec-sm-006-core.md`
- `docs/specs/spec-sm-007-ai.md`
- `docs/specs/spec-sm-008-tui.md`
- `docs/specs/spec-sm-009-harness.md`
- `docs/specs/spec-sm-010-cli.md`
- `docs/specs/spec-sm-011-workspace.md`
- `docs/specs/spec-sm-012-testing.md`

### Research (ecosystem analysis, tool evaluation)
- `docs/research/RESEARCH-NOTES.md`
- `docs/research/TERMINAL-CAPABILITIES-RESEARCH.md`
- `docs/research/TESTING-STRATEGY-RESEARCH.md`
- `docs/research/CI-PATTERNS-RESEARCH.md`
- `docs/research/CRATE-ECOSYSTEM-RESEARCH.md`
- `docs/research/CLIPPY-BEST-PRACTICES.md`

### Design (subsystem design documents)
- `docs/design/TUI-CRATE-DESIGN.md`
- `docs/design/PLUGIN-SDK-DESIGN.md`
- `docs/design/AI-CRATE-DESIGN.md`

### Plans (task breakdowns, documentation plans)
- `docs/plans/TASK-BREAKDOWN.md`
- `docs/plans/PLUGIN-DOC-PLAN.md`

### Project Invariants
- `docs/PROJECT-INVARIANTS.md` — build system, directory structure, coding standards

## Rules

1. Spec before code. No `.rs` files until spec is final.
2. AGENTS.md is the index. Specs are the source of truth.
3. Chunk large specs. One subsystem per doc.
4. Every spec answers: interfaces, types, errors, tests.
5. Open questions: stop and ask. No guessing.
6. Invoke spec work: `/spec <topic>`.
7. Cargo is the sole build system. See `docs/PROJECT-INVARIANTS.md` §1.
8. Agents must not modify `docs/specs/` or `docs/PROJECT-INVARIANTS.md` without approval.
