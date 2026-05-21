# SM-009: smith-harness/ — Orchestrator + Plugin SDK

Create the `smith-harness/` crate that wires all components together and implements
the Lua plugin system.

## Context

Integration crate. Depends on smith/ (SM-005), smith-core/ (SM-006),
smith-ai/ (SM-007), and smith-tui/ (SM-008).

**Key insight:** The agent loop lives in smith-core (SM-006). This crate's job is:
1. Wire concrete providers → StreamFn → Agent
2. Load and manage Lua plugins
3. Expose SDK to Lua
4. Build system prompt

**Design docs:** `docs/PLUGIN-SDK-DESIGN.md`, `docs/PLUGIN-DOC-PLAN.md`

## Key Design Decisions

1. **Agent loop is in smith-core** — this crate just wires it
2. **provider_to_stream_fn** — from smith-ai, creates the StreamFn for the agent
3. **Lua plugins** — SDK exposed via mlua globals
4. **Unified provider API** — `smith.provider.register()` adds/overrides
5. **30+ events** — AgentEvent (from smith-core) mapped to plugin SDK events
6. **Sandbox** — capability-based
7. **Documentation as code** — `---@` annotations are source of truth

## Deliverables

### 1. `smith-harness/Cargo.toml`

```toml
[package]
name = "smith-harness"
version = "0.1.0"
edition = "2024"

[dependencies]
smith = { path = "../smith" }
smith-core = { path = "../smith-core" }
smith-ai = { path = "../smith-ai" }
smith-tui = { path = "../smith-tui" }
mlua = { workspace = true }
mlua-pkg = { workspace = true }
tokio = { workspace = true, features = ["full"] }
serde = { workspace = true }
serde_json = { workspace = true }
tracing = { workspace = true }
thiserror = { workspace = true }
```

### 2. Core Structure

```
smith-harness/src/
├── lib.rs
├── harness.rs           — Harness struct: wires provider → stream_fn → agent
├── plugins/
│   ├── mod.rs
│   ├── manager.rs       — PluginManager
│   ├── loader.rs        — LuaPluginLoader
│   ├── sandbox.rs       — SandboxConfig
│   └── sdk.rs           — SDK registration into Lua globals
├── event_bridge.rs      — Maps AgentEvent → plugin SDK events
├── commands.rs          — Slash command registry
└── help.rs              — smith help command (reads embedded docs)
```

### 3. Harness — The Wiring Layer

```rust
use smith_core::agent::{Agent, AgentLoopConfig, AgentEvent};
use smith_ai::{Provider, provider_to_stream_fn, ModelRegistry, FileAuthResolver};
use smith_tui::TuiApp;
use std::sync::Arc;

pub struct Harness {
    agent: Agent,
    providers: HashMap<String, Arc<dyn Provider>>,
    model_registry: ModelRegistry,
    auth_resolver: FileAuthResolver,
    plugin_manager: PluginManager,
    tui: Option<TuiApp>,
    active_provider: Arc<dyn Provider>,  // Provider: Send + Sync (see SM-007 §2)
    active_model_id: String,
}

impl Harness {
    pub fn new(config: Config) -> Result<Self> {
        // 1. Load model registry from embedded JSON
        // 2. Load auth resolver
        // 3. Create providers from registry
        // 4. Select active provider + model
        // 5. Create StreamFn from active provider
        // 6. Create Agent with StreamFn
        // 7. Load plugins
        // 8. Register SDK into Lua
    }

    /// Wire the active provider into a StreamFn for the agent
    fn wire_provider(&self) -> Box<smith::StreamFn> {
        provider_to_stream_fn(self.active_provider.clone())
    }

    pub async fn run_interactive(&mut self) -> Result<()>;
    pub async fn run_eval(&mut self, prompt: &str, json: bool) -> Result<String>;
    pub async fn run_rpc(&mut self) -> Result<()>;
}
```

### 4. Event Bridge

Maps smith-core's `AgentEvent` to plugin SDK events:

```rust
/// Events emitted to Lua plugins via the EventBridge.
pub enum PluginEvent {
    AgentStart,
    AgentEnd,
    TurnStart,
    TurnEnd,
    MessageStart { message: Message },
    MessageUpdate { message: Message, delta: ContentBlock },
    MessageEnd { message: Message, usage: ProviderUsage, stop_reason: StopReason },
    ToolExecutionStart { tool_call_id: String, tool_name: String, args: serde_json::Value },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, result: Vec<ContentBlock>, is_error: bool },
    ToolCall { tool_call_id: String, tool_name: String, input: serde_json::Value },
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    Error { message: String },
}

/// Reason a tool call was blocked by an event handler.
pub enum BlockReason {
    BlockedByPlugin(String),
    UserDenied,
    PolicyViolation { capability: String, reason: String },
}

impl EventBridge {
    fn agent_event_to_plugin_event(event: &AgentEvent) -> Vec<PluginEvent> {
        match event {
            AgentEvent::AgentStart => vec![PluginEvent::AgentStart],
            AgentEvent::TurnStart { .. } => vec![PluginEvent::TurnStart],
            AgentEvent::MessageStart { message } => vec![PluginEvent::MessageStart { message }],
            AgentEvent::ToolExecutionStart { tool_call_id, tool_name, args } => {
                vec![
                    PluginEvent::ToolExecutionStart { tool_call_id, tool_name, args },
                    PluginEvent::ToolCall { tool_call_id, tool_name, input: args },
                ]
            }
            // ... etc
        }
    }

    /// Dispatches events to registered handlers. For ToolCall events, checks
    /// whether any handler returns Err(BlockReason) and aborts the tool if so.
    fn dispatch_event(
        &self,
        event: &PluginEvent,
        handlers: &HashMap<String, Vec<mlua::RegistryKey>>,
        lua: &Lua,
    ) -> Result<(), BlockReason> {
        if let PluginEvent::ToolCall { tool_call_id, tool_name, .. } = event {
            for handler in handlers.get("tool_call").unwrap_or(&vec![]) {
                let result: Result<String, mlua::Error> = lua.call_function(handler.clone(), (tool_call_id, tool_name));
                if let Err(e) = result {
                    return Err(BlockReason::BlockedByPlugin(e.to_string()));
                }
            }
        }
        Ok(())
    }
}
```

### 5. SDK API (exposed to Lua)

From `docs/PLUGIN-SDK-DESIGN.md`:

- `smith.tool.register(definition)` — registers AgentTool in tool registry
- `smith.on(event, handler)` — subscribes to events via event bridge
- `smith.command.register(name, options)` — slash commands
- `smith.shortcut.register(key, options)` — keyboard shortcuts
- `smith.provider.register(name, config)` — updates model registry
- `smith.provider.unregister(name)` — removes provider
- `smith.provider.unregister_model(provider, model_id)` — removes model
- `smith.tui.*` — layout + widget control
- `smith.fs.*` — sandboxed filesystem
- `smith.env.*` — read-only env access
- `smith.credentials.*` — credential management
- `smith.send_message(text, opts)` — inject messages
- `smith.active_tools.*` — manage tool availability
- `smith.request_capability(capability, options)` — request sandbox capability (Tier 1+)

### 6. Built-in Plugins (Lua)

- `default-layout` — center: StatusBar + VirtualScroll + Editor + HintBar
- `read` — file read tool
- `write` — file write tool
- `edit` — file edit tool (find-and-replace)
- `bash` — shell command execution
- `compact` — context compaction

### 7. Built-in Tool Specifications

All built-in tools are implemented as Lua plugins (Tier 0) using the same SDK as user plugins.

#### 7.1 `read`

```lua
-- parameters
{
    path       = { type = "string", required = true },
    offset     = { type = "number", required = false, default = 1 },
    limit      = { type = "number", required = false },
    read_limit = { type = "number", required = false, default = 500 },
}

-- execute
-- 1. Canonicalize path → sandbox_path_check(path, 'fs_read')
-- 2. Read file via smith.fs.read(path)
-- 3. If offset/limit provided, slice lines
-- 4. Format as numbered lines for LLM context
-- 5. Return { content = lines }

-- errors
-- ENOPATH  : File not found
-- EISDIR   : Path is a directory
-- EPERM    : Path outside sandbox allowlist
-- E2BIG    : File exceeds read_limit (default 500 lines); use offset/limit
```

#### 7.2 `write`

```lua
-- parameters
{
    path        = { type = "string", required = true },
    content     = { type = "string", required = true },
    create_dirs = { type = "boolean", required = false, default = true },
}

-- execute
-- 1. sandbox_path_check(path, 'fs_write')
-- 2. If create_dirs, mkdir -p parent
-- 3. Write atomically (temp file + rename)
-- 4. Return { path = path, bytes = #content }

-- errors
-- EPERM : Path outside sandbox write boundaries
-- EIO   : Failed to write
```

#### 7.3 `edit`

```lua
-- parameters
{
    path           = { type = "string", required = true },
    old_text       = { type = "string", required = true },
    new_text       = { type = "string", required = true },
    allow_multiple = { type = "boolean", required = false, default = false },
}

-- execute
-- 1. sandbox_path_check(path, 'fs_write')
-- 2. Read file
-- 3. Find old_text occurrences
-- 4. If !allow_multiple and count > 1 → fail
-- 5. Replace all occurrences
-- 6. Write back atomically
-- 7. Return { changes = count }

-- errors
-- ENOTFOUND : old_text not found
-- EMULTIPLE : old_text found multiple times (without allow_multiple)
-- EPERM     : Path outside sandbox
```

#### 7.4 `bash`

```lua
-- parameters
{
    command = { type = "string", required = true },
    timeout = { type = "number", required = false, default = 120 },
    signal  = { type = "string", required = false, default = "SIGTERM" },
}

-- execute
-- 1. sandbox_check('subprocess')
-- 2. Spawn via tokio::process::Command
-- 3. Pipe stdout/stderr
-- 4. Apply timeout
-- 5. On timeout, send signal
-- 6. Return { stdout = ..., stderr = ..., exit_code = ..., timed_out = ... }

-- errors
-- ETIMEDOUT : Command timed out
-- EPERM     : Subprocess not allowed by sandbox
-- EIO       : Failed to spawn

-- security
-- DEFAULT: bash requires user confirmation before execution.
--   smith-harness emits PluginEvent::ToolCall before bash execution.
--   If any event handler returns Block, the command is aborted.
--   User can add provider IDs to `auto_approve_bash` in ~/.smith/config.lua
--   to skip confirmation for trusted providers.
-- Default timeout: 120s. Max output: 50KB per stream (truncated with notice).
-- Runs in smith's CWD, inherits smith's environment.
```

#### 7.5 `compact`

```lua
-- parameters
{
    threshold = { type = "number", required = false },  -- null = context_window * 0.8
    strategy  = { type = "string", required = false, default = "summarize", enum = {"summarize","truncate","drop_old"} },
}

-- execute
-- 1. Estimate current tokens
-- 2. If below threshold → return { compacted = false }
-- 3. Delegate to smith-core CompactionExecutor
-- 4. Return { compacted = true, entries_before, entries_after, tokens_saved }
```

### 8. Lua → Rust Plugin Bridge

Four-phase loading model that converts Lua factory functions into Rust trait implementations.

#### Phase 1: Load

```rust
// LuaPluginLoader loads .lua file and calls it as a function
let factory: mlua::Function = lua.load(&source).eval()?;
let sdk_collector = SdkCollector::new();  // empty registrations
lua.globals().set("smith", sdk_collector.to_table())?;
factory.call(sdk_collector.to_table())?;
```

#### Phase 2: Collect

```rust
struct PluginRegistrations {
    tools: Vec<LuaToolDef>,
    events: Vec<(String, mlua::RegistryKey)>,
    commands: Vec<LuaCommandDef>,
    shortcuts: Vec<LuaShortcutDef>,
    providers: Vec<LuaProviderDef>,
    capabilities: Vec<CapabilityRequest>,
    layout: Option<LayoutDef>,
}

// After factory returns, extract each sub-table and validate schemas
```

#### Phase 3: Materialize

```rust
// For each LuaToolDef: create LuaAgentTool struct
pub struct LuaAgentTool {
    definition: ToolDefinition,
    execute_fn: mlua::RegistryKey,
    lua: Arc<Lua>,
    timeout: Duration,
}

impl AgentTool for LuaAgentTool {
    fn definition(&self) -> ToolDefinition { self.definition.clone() }
    fn execute(&self, tool_call_id, params, signal, on_update) -> Pin<Box<dyn Future<...>>> {
        // spawn_blocking: lua.call_function(execute_fn, convert_params(params))
        // with timeout
        //
        // NOTE: spawn_blocking threads are NOT interruptible by tokio.
        // If the Lua function hangs (infinite loop, blocking I/O), the timeout
        // future resolves with ToolError::Timeout but the underlying thread
        // continues executing. This is an accepted v1 limitation.
        // Mitigation: limit max_blocking_threads in tokio runtime config.
        // Future: run Lua tools in a separate process or WASM sandbox.
    }
}

// For each event subscription: EventHandler holding RegistryKey
// For each command: LuaCommand implementing Command trait
```

#### Phase 4: Register

```rust
// tools → ToolRegistry (smith-core)
// events → EventBridge handler map
// commands → CommandRegistry
// providers → ModelRegistry (smith-ai)
// layout → TUI layout (applied after all plugins loaded)
```

**Error handling:** If any phase fails, the entire plugin fails to load. Error is logged with plugin path + phase + detail. Other plugins continue loading.

### 9. Sandbox Enforcement — Runtime Rules

All enforcement is in Rust (`sdk.rs`), not Lua. Plugins have no `io`/`os`/`debug` globals.

#### Path Validation Algorithm

```
1. Canonicalize requested path (resolve symlinks, .., .)
2. Check: canonical_path.starts_with(allowed_prefix) for each prefix in capability's paths list
3. If any prefix matches → ALLOW
4. If no prefix matches → DENY (return EPERM)
5. Reject if canonicalization itself fails (broken symlink) → DENY
```

Edge cases:
- Symlinks: resolved before check. Symlink inside sandbox pointing outside → DENY.
- Path traversal (`../`): canonicalized away before check.
- Absolute paths: checked against allowlist normally.
- CWD-relative: resolved against smith's working directory, then checked.

#### Capability Enforcement Table

| Capability | Lua API | Enforcement |
|---|---|---|
| `fs_read` | `smith.fs.read(path)` | `path_validation(path, granted.fs_read.paths)` |
| `fs_write` | `smith.fs.write(path, data)` | `path_validation(path, granted.fs_write.paths)` |
| `fs_list` | `smith.fs.list(path)` | `path_validation(path, granted.fs_read.paths)` |
| `fs_glob` | `smith.fs.glob(pattern)` | All resolved matches within `fs_read` paths |
| `env` | `smith.env.get(name)` | Check `name` in `granted.env.vars` |
| `subprocess` | `bash` tool | Check `granted.subprocess == true` |
| `network` | *(reserved for v2)* | Check `granted.network == true` |
| `credentials` | `smith.credentials.get(provider)` | Check `granted.credentials == true` |

#### Capability Grant Flow

1. Plugin calls `smith.request_capability('fs_read', { paths = {'./src'} })`
2. SDK collects request into `PluginRegistrations.capabilities`
3. `PluginManager` resolves against `SandboxPolicy` (from `~/.smith/sandbox.lua`)
4. Granted capabilities stored per plugin instance in `GrantedCapabilities`
5. Denied capabilities cause plugin load failure (with warning + user notification)

#### Sandbox Policy and Granted Capabilities

```rust
/// Loaded from ~/.smith/sandbox.lua.
/// Parsed in a RESTRICTED Lua context: no `io`, `os`, `debug`, `package`, `require`.
/// Alternatively, a JSON/TOML file at ~/.smith/sandbox.json is also accepted.
/// If neither exists, use the default policy below.
pub struct SandboxPolicy {
    pub fs_read: Vec<PathBuf>,
    pub fs_write: Vec<PathBuf>,
    pub env: Vec<String>,
    pub network: bool,
    pub credentials: bool,
    pub subprocess: bool,
}

/// Resolved per-plugin at load time.
pub struct GrantedCapabilities {
    pub fs_read: Vec<PathBuf>,
    pub fs_write: Vec<PathBuf>,
    pub env: HashSet<String>,
    pub network: bool,
    pub credentials: bool,
    pub subprocess: bool,
}
```

Default policy: `fs_read: ["./"], fs_write: ["./"], env: [], network: false, credentials: false, subprocess: false`.

Tier overrides:
- **Tier 0 (built-in)**: All capabilities granted automatically.
- **Tier 1 (trusted Lua)**: Capabilities requested, resolved against user `sandbox.lua` policy.
- **Tier 2 (WASM)**: Capability-gated via wasmtime. Not in v1.

### 10. Built-in Plugin Load Order and Interactions

Load order:
1. `read` (tool registration)
2. `write` (tool registration)
3. `edit` (tool registration)
4. `bash` (tool registration + tool_call hook for optional confirmation)
5. `compact` (tool registration)
6. `default-layout` (TUI layout setup)

Override rules:
- User plugins load after built-ins.
- Last `smith.tool.register()` for a given name wins.
- Last `smith.tui.set_center_layout()` wins.
- Events are additive (all handlers fire).

Disable built-in: A user plugin can call `smith.active_tools.set({...})` excluding a built-in tool name. The tool definition won't be sent to the LLM.

### 11. Documentation Files

```
smith-harness/src/lua/sdk/
├── smith_tool.lua         — annotations + @usage
├── smith_provider.lua
├── smith_command.lua
├── smith_shortcut.lua
├── smith_tui.lua
├── smith_fs.lua
├── smith_env.lua
├── smith_credentials.lua
├── smith_events.lua
├── guides/
│   ├── getting-started.lua
│   ├── tools.lua
│   ├── events.lua
│   ├── providers.lua
│   ├── tui.lua
│   └── sandbox.lua
└── examples/
    ├── 01-hello-world.lua through 12-streaming-updates.lua
```

## Tests

- Harness wires provider → StreamFn → Agent correctly
- Agent loop runs with real provider types (mock HTTP)
- Plugin loader: load Lua file, execute factory function
- Plugin manager: load order (built-in → global → project)
- SDK: register_tool creates AgentTool in registry
- SDK: provider.register updates model registry with merge
- Event bridge: AgentEvent maps to correct plugin events
- Sandbox: fs_read restricted to allowed paths
- Sandbox: path validation rejects symlink escape
- Sandbox: capability denied → plugin load failure
- LuaAgentTool: executes Lua function via RegistryKey
- Built-in read: returns file content with line numbers
- Built-in write: atomic write via temp+rename
- Built-in edit: exact find-and-replace, rejects ambiguous match
- Built-in bash: timeout, signal, output truncation
- Built-in compact: delegates to CompactionExecutor
- `smith help` reads embedded docs

## Steps

- [ ] Create `smith-harness/Cargo.toml`
- [ ] Create `smith-harness/src/lib.rs`
- [ ] Create `smith-harness/src/harness.rs` (wiring layer)
- [ ] Create `smith-harness/src/event_bridge.rs`
- [ ] Create `smith-harness/src/plugins/` (manager, loader, sandbox, sdk)
- [ ] Create `smith-harness/src/plugins/builtin/` (read, write, edit, bash, compact, default-layout)
- [ ] Create `smith-harness/src/lua/sdk/` (all SDK annotation files)
- [ ] Create `smith-harness/src/lua/sdk/guides/`
- [ ] Create `smith-harness/src/lua/sdk/examples/` (12 examples)
- [ ] Create `smith-harness/src/commands.rs`
- [ ] Create `smith-harness/src/help.rs`
- [ ] Implement SDK bindings
- [ ] Implement Lua → Rust plugin bridge (4-phase pipeline)
- [ ] Implement LuaAgentTool struct
- [ ] Implement built-in plugins
- [ ] Implement sandbox enforcement (path validation, capabilities, resource limits)
- [ ] Implement `smith help`
- [ ] Implement system prompt bootstrap
- [ ] Write tests
- [ ] Verify: `cargo check -p smith-harness`
- [ ] Test: `cargo test -p smith-harness`
- [ ] Commit: `jj describe -m "feat(SM-009): smith-harness — orchestrator, plugin SDK, wiring"`
