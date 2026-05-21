# Smith Task Breakdown

## Architecture

```
smith/ (shared types + StreamFn + AgentTool trait)
  ↑
  ├── smith-ai/     (Provider implementations — parallel with smith-core)
  ├── smith-core/   (Agent loop + session — parallel with smith-ai)
  └── smith-tui/    (Widgets + layout — parallel with smith-core/ai)

smith-core + smith-ai + smith-tui
  ↑
smith-harness/ (Wiring: provider → StreamFn → agent, plugins, SDK)
  ↑
smith-cli/ (Binary entry point)
```

**Key design:** The agent loop lives in `smith-core`. It takes a `StreamFn` (from `smith/`),
not a concrete provider. `smith-ai` implements providers and creates `StreamFn` instances.
`smith-harness` wires them together. This enables `smith-core` and `smith-ai` to build in parallel.

## Dependency Graph

```
SM-003 (scaffolding) ── SM-005 (smith/) ──┬── SM-006 (smith-core/) ──┐
                  ├── SM-007 (smith-ai/)   ──┼── SM-009 (smith-harness/) ── SM-010 (smith-cli/)
                  └── SM-008 (smith-tui/)  ──┘            │
                                                        SM-011 (workspace)
                                                             │
                                                        SM-012 (testing)
```

## Execution Order

```
Wave 0: SM-003 (scaffolding — jj repo, workspace, crate skeletons)
Wave 1: SM-005 (sequential — foundation types)
Wave 2: SM-006 + SM-007 + SM-008 (parallel)
Wave 3: SM-009 (sequential — after wave 2)
Wave 4: SM-010 + SM-011 (parallel — after SM-009)
Wave 5: SM-012 (sequential — after wave 4)
```

## Task List

| Task | Crate | Description | Blocked By | Blocks |
|------|-------|-------------|------------|--------|
| SM-003 | workspace/ | jj repo, Cargo workspace, crate skeletons, xtask | - | SM-005 |
| SM-005 | smith/ | Shared types, StreamFn, AgentTool trait, Lua runtime, config | SM-003 | SM-006, 007, 008 |
| SM-006 | smith-core/ | Agent loop, session, tools, hooks, events | SM-005 | SM-009 |
| SM-007 | smith-ai/ | Provider trait, implementations, auth, OAuth | SM-005 | SM-009 |
| SM-008 | smith-tui/ | Widgets, layout, themes, rendering | SM-005 | SM-009 |
| SM-009 | smith-harness/ | Wiring, plugins, SDK, smith help | SM-006, 007, 008 | SM-010 |
| SM-010 | smith-cli/ | Binary entry point, subcommands | SM-009 | SM-012 |
| SM-011 | workspace/ | Cargo workspace, xtask | SM-009 | SM-012 |
| SM-012 | testing/ | Integration tests | SM-010, SM-011 | - |

## Crate Responsibilities

| Crate | Owns | Does NOT own |
|-------|------|-------------|
| **smith/** | Shared types, StreamFn type, AgentTool trait, ProviderEvent, ProviderRequest, Lua runtime, config | No business logic, no I/O |
| **smith-core/** | Agent loop (takes StreamFn), session, ToolRegistry, hooks, EngineEvent, AgentEvent, compaction, system prompt | No provider implementations, no I/O |
| **smith-ai/** | Provider trait + impls, model registry, auth, OAuth, providers.json, provider_to_stream_fn | No agent loop, no session |
| **smith-tui/** | 17 widgets, layout primitives, border layout, virtual scroll, themes | No business logic |
| **smith-harness/** | Wiring (provider→StreamFn→agent), plugins, SDK, event bridge, built-in plugins, smith help | No new core logic |
| **smith-cli/** | CLI subcommands (new, attach, continue, resume, eval, rpc, help) | No business logic |
