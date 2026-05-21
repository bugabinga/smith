# SM-012: Integration Testing

Create integration tests and verify the full smith system works end-to-end.

## Context

Final task. Depends on SM-010 (cli) and SM-011 (workspace).

## Deliverables

### 1. Test Structure

```
tests/
├── integration/
│   ├── cli_tests.rs         — CLI subcommand tests
│   ├── plugin_tests.rs      — Plugin loading and execution
│   ├── provider_tests.rs    — Provider registration and streaming
│   ├── session_tests.rs     — Session lifecycle
│   ├── tui_tests.rs         — TUI rendering
│   └── doc_tests.rs         — Documentation completeness
└── fixtures/
    ├── plugins/             — Test plugins
    │   ├── hello.lua
    │   ├── tool.lua
    │   ├── provider.lua
    │   └── layout.lua
    ├── sessions/            — Test session files
    └── config/              — Test config files
```

### 2. CLI Integration Tests

- `smith` starts interactive mode
- `smith new test-session` creates named session
- `smith sessions` lists sessions
- `smith eval "hello"` outputs text
- `smith eval --json "hello"` outputs valid JSON
- `smith help tools` outputs documentation
- `smith help --search "provider"` finds results
- `smith --model claude-sonnet-4 --provider anthropic eval "test"`
- `smith --no-config eval "test"` skips config
- `smith rpc` accepts JSON-RPC on stdin

### 3. Plugin Integration Tests

- Load Lua plugin from `~/.smith/plugins/`
- Load Lua plugin from `.smith/plugins/`
- Plugin loading order: built-in → global → project
- `smith.tool.register` creates callable tool
- `smith.on("tool_call")` intercepts tool calls
- `smith.on("input")` intercepts user input
- `smith.command.register` creates slash command
- `smith.provider.register` adds new provider
- `smith.provider.register` overrides existing with model merge
- `smith.provider.unregister_model` removes specific model
- Sandbox blocks unauthorized fs access
- Sandbox blocks unauthorized network access

### 4. Provider Integration Tests

- Load bundled providers.json
- Register custom provider via Lua
- Override built-in provider settings
- API key auth reads from env var
- API key auth reads from auth.json
- OAuth flow (mock server)
- Provider streaming produces ProviderEvents

### 5. Session Integration Tests

- Create new session
- Resume session
- Fork session
- Session persistence across restarts
- Tree navigation
- Compaction

### 6. TUI Integration Tests

- Default layout renders correctly
- Border layout with all panels
- Layout primitives (Column, Row, Box, Expanded)
- Custom layout from Lua plugin
- Theme loading
- Virtual scroll performance

### 7. Doc Integration Tests

- `smith help` lists all topics
- `smith help <topic>` shows correct docs
- `smith help --search` finds relevant results
- `smith help --examples` lists all 12 examples
- `smith help --example 01` shows hello world
- All @usage blocks execute without error
- All guide code blocks execute without error
- verify-docs passes

## Steps

- [ ] Create test directory structure
- [ ] Create test fixtures (plugins, sessions, configs)
- [ ] Write CLI integration tests
- [ ] Write plugin integration tests
- [ ] Write provider integration tests
- [ ] Write session integration tests
- [ ] Write TUI integration tests
- [ ] Write doc integration tests
- [ ] Run: `cargo test`
- [ ] Run: `cargo run -p xtask -- doc-test`
- [ ] Run: `cargo run -p xtask -- verify-docs`
- [ ] Commit: `jj describe -m "feat(SM-012): integration tests — CLI, plugins, providers, sessions, TUI, docs"`
