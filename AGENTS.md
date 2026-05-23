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

AGENTS.md is a navigation index. Do not mirror individual source-of-truth file
lists here; use the canonical directories and docs tree instead.

- Specs: `docs/specs/` — canonical subsystem specifications.
- Research: `docs/research/` — ecosystem research and tool analysis.
- Design: `docs/design/` — subsystem design documents.
- Plans: `docs/plans/` — task breakdowns and documentation plans.
- Docs tree and invariants: `docs/PROJECT-INVARIANTS.md` — build system,
  directory structure, coding standards, and canonical docs inventory.

## Rules

1. Spec before code. No `.rs` files until spec is final.
2. AGENTS.md is the navigation index. `docs/specs/` contains the canonical subsystem specs.
3. Chunk large specs. One subsystem per doc.
4. Every spec answers: interfaces, types, errors, tests.
5. Open questions: stop and ask. No guessing.
6. Invoke spec work: `/spec <topic>`.
7. Cargo is the sole build system. See `docs/PROJECT-INVARIANTS.md` §1.
8. Agents must not modify `docs/specs/` or `docs/PROJECT-INVARIANTS.md` without approval.
