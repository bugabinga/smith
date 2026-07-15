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

- Spec: `docs/SPEC.md` — canonical project specification.
- Research: `docs/research/` — ecosystem research and tool analysis.
- Plans: `docs/plans/` — task breakdowns and documentation plans.

Former `docs/design/` subsystem docs and the P1–P20 prototype report are fully
absorbed into `docs/SPEC.md` and deleted (see git history).
- Docs tree and invariants: `docs/PROJECT-INVARIANTS.md` — build system,
  directory structure, coding standards, and canonical docs inventory.

## Rules

1. Spec before code. No `.rs` files until `docs/SPEC.md` covers the work.
2. AGENTS.md is the navigation index. `docs/SPEC.md` is the canonical project spec.
3. Every spec section answers: interfaces, types, errors, tests.
4. Open questions: stop and ask. No guessing.
5. Invoke spec work: `/spec <topic>`.
6. Cargo is the sole build system. See `docs/PROJECT-INVARIANTS.md` §1.
7. Agents must not modify `docs/SPEC.md` or `docs/PROJECT-INVARIANTS.md` without approval.
