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
| Rust 1.85, ed. 2024 | Async closures |
| mlua + LuaJIT | Performance, coroutines |
| CBOR sessions | Compact, binary-safe |
| Secret proxy (no keychain) | Cross-platform |
| XDG dirs | Linux standards |
| jj VCS | Modern DVCS |
| StreamFn abstraction | Decouples agent from providers |
| Lua plugins with sandbox | Safe extensibility |
| Rust widgets, Lua layout | Performance + flexibility |

## Source of Truth

- `docs/spec-sm-003-scaffolding.md`
- `docs/spec-sm-004-architecture.md`
- `docs/spec-sm-005-shared-types.md`
- `docs/spec-sm-006-core.md`
- `docs/spec-sm-007-ai.md`
- `docs/spec-sm-008-tui.md`
- `docs/spec-sm-009-harness.md`
- `docs/spec-sm-010-cli.md`
- `docs/spec-sm-011-workspace.md`
- `docs/spec-sm-012-testing.md`
- `docs/TASK-BREAKDOWN.md` — dependency graph
- `docs/TUI-CRATE-DESIGN.md`
- `docs/PLUGIN-SDK-DESIGN.md`
- `docs/AI-CRATE-DESIGN.md`
- `docs/PLUGIN-DOC-PLAN.md`
- `docs/RESEARCH-NOTES.md`

## Rules

1. Spec before code. No `.rs` files until spec is final.
2. AGENTS.md is the index. Specs are the source of truth.
3. Chunk large specs. One subsystem per doc.
4. Every spec answers: interfaces, types, errors, tests.
5. Open questions: stop and ask. No guessing.
6. Invoke spec work: `/spec <topic>`.
