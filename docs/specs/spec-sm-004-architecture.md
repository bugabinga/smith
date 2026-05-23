# SM-004: smith Architecture Design

## Summary

Design the full application architecture for smith — a Rust coding agent TUI.
Define module boundaries, data flow, trait hierarchies, extension points, and
security model. Output as architecture document + skeleton Rust modules with
doc comments and TODO stubs. No implementation beyond type definitions and
trait declarations.

## Context

SM-003 established the project foundation (workspace, xtask, testing, config).
This task designs what smith actually *is*: a fast, extensible coding
agent with a TUI interface.

**Inspired by pi's architecture**, but with distinct design choices:
- Modern terminal rendering via Kitty protocol
- Plugin system: LuaJIT only
- LLM is the only untrusted actor
- Everything is a plugin: tools, themes, keybindings

## Architecture Overview

smith is split into **6 crates**:

| Crate | Purpose |
|-------|---------|
| `smith/` | Shared library — types, Lua runtime, config |
| `smith-core/` | Pure business logic — session, tools, hooks |
| `smith-ai/` | LLM providers — preconfigured + config-driven |
| `smith-tui/` | Terminal rendering — widgets, themes |
| `smith-harness/` | Orchestrator + plugins — event loop, SDK |
| `smith-cli/` | Binary entry point |

**Data flow:**

```
User Input → smith-cli (parse) → smith-harness (orchestrate)
                                          ↓
                        ┌─────────────────┼─────────────────┐
                        ↓                 ↓                 ↓
                   smith-core        smith-ai          smith-tui
                  (session/tools)    (providers)       (render)
                        ↓                 ↓                 ↓
                        └─────────────────┼─────────────────┘
                                          ↓
                               smith-harness (coordination)
                                          ↓
                               smith-tui (display)
```

### Canonical Spec Map

| Type / Trait | Canonical Spec | Notes |
|-------------|----------------|-------|
| `Config`, `LuaRuntime`, `SmithError` | **SM-005** (`smith/`) | Shared types, error types |
| `AgentTool`, `ToolDefinition`, `ProviderRequest`, `ProviderEvent`, `ProviderUsage`, `StopReason` | **SM-005** (`smith/`) | Tool and streaming types |
| `Session`, `SessionEntry`, `SessionStore`, `AgentEvent`, `EngineEvent`, `AgentLoopConfig` | **SM-006** (`smith-core/`) | Business logic, events, sessions |
| `Provider` trait, model registry, auth | **SM-007** (`smith-ai/`) | LLM providers |
| TUI widgets, `TuiApp`, render loop, themes | **SM-008** (`smith-tui/`) | Terminal rendering |
| Plugin system, SDK, built-in tools | **SM-009** (`smith-harness/`) | Orchestration + plugins |
| CLI args, session commands | **SM-010** (`smith-cli/`) | Binary entry point |
| Workspace deps, crate graph | **SM-011** | Workspace manifest |
| Testing strategy | **SM-012** | Test plan |
| Behavior-mutating event returns | **SM-009** (`smith-harness/`) | Plugin events return typed results (block, transform, cancel, replace) — inherited from pi |
| Tool renderers (`renderCall`, `renderResult`) | **SM-009** (`smith-harness/`) + **SM-008** (`smith-tui/`) | Per-tool custom TUI rendering — inherited from pi |
| ExtensionContext / ExtensionUIContext | **SM-009** (`smith-harness/`) | Plugin control over agent lifecycle and UI — inherited from pi |
| Agent loop hooks (`beforeToolCall`, `afterToolCall`, `shouldStopAfterTurn`) | **SM-006** (`smith-core/`) | Pre/post tool interception and loop control — inherited from pi |
| `TraceEntry`, `TraceRecorder`, `TraceCodec`, `TraceFileHeader` | **SM-006** (`smith-core/`) | Session recording — deterministic replay capture of all events |
| `ReplayEngine`, `ReplaySpeed`, `ReplayMode`, `ReplayDiff` | **SM-006** (`smith-core/`) | Replay engine — reconstruct session from trace, compare mode |
| `ModelAlias`, `ModelGroup`, `ProviderBucket` | **SM-005** (`smith/`) | Model aliasing, grouping, and provider buckets |
| `ModelResolver`, `ResolvedModel`, `ResolveError` | **SM-005** (`smith/`) | Resolution pipeline with cycle detection |
| `FailoverStrategy`, `BucketStrategy` | **SM-005** (`smith/`) | Failover and rotation strategies |
| `MuxProvider` | **SM-007** (`smith-ai/`) | Multi-provider wrapper with failover/retry |

SM-004 is the **architecture narrative** — for type definitions, see the canonical specs above.

### Core Principle: Everything is a Plugin

smith-harness defines the plugin system. All user-visible features are Lua plugins.
Rust core exposes primitives only: data types, widget primitives, event routing,
provider streams, tool execution, and SDK namespaces such as `smith.fs.*`,
`smith.search.*`, `smith.tui.*`, and `smith.vcs.*`.

- `read`, `write`, `edit`, `bash`, `find`, `grep`, `ls` — shipped as Lua plugins in smith's built-in package
- `/undo`, `/redo`, `/history`, time-travel, and VCS tools — shipped as Lua plugins using `smith.vcs.*`
- Themes — Lua tables defining colors/styles
- Keybindings — Lua tables mapping keys → actions
- Default prompts — Lua strings
- UI layout configuration — Lua tables

This means:
1. The plugin system is battle-tested from day one (smith depends on it)
2. Users can override ANY built-in with their own implementation
3. Iteration on tools/themes/config doesn't require recompiling Rust
4. No "second class" API — built-in and user plugins use the exact same interface
5. Rust stays lean and open/closed: add features by composing primitives in Lua, not by growing core

### Configuration Language: Lua

Lua is smith's configuration language. Rust defines the types/schemas;
Lua provides the values:

```lua
-- ~/.smith/config.lua
theme = "catppuccin"
keybindings = {
    ["ctrl+l"] = "cycle_model",
    ["ctrl+c"] = "abort",
}
tools = { "read", "write", "edit", "bash" }
model = "anthropic/claude-sonnet-4"
```

### Configuration Cascade

Settings are resolved in layers, later layers override earlier:

```
Rust type definitions (schema validation)
    ↓
Built-in Lua defaults (shipped with smith)
    ↓
Plugin contributions (plugins register themes, keybindings, tools)
    ↓
User config (~/.smith/config.lua)
    ↓
CLI flags (--model, --theme, etc.)
```

Each layer is validated against the Rust schema. Invalid values are rejected
with a clear error message. Unknown keys are either ignored or warned.

### Credentials

Credentials (API keys, tokens) read from environment variables or plain text config.
No OS keychain integration. No encryption. Plaintext in config or environment.

Rationale: smith runs as the same user. If an attacker can read smith's data,
they can read the user's environment. OS keychain adds complexity without security benefit.

```lua
-- config.lua — credentials in plain text
return {
    anthropic_api_key = "sk-ant-...",
    openai_api_key = "sk-...",
}
```

Or via environment variables (preferred):
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
smith
```

**Runtime data** (sessions, cache, state): XDG-compliant directory structure via `dirs` crate:

| Platform | Config | Data | Cache |
|----------|--------|------|-------|
| Linux | `~/.config/smith/` | `~/.local/share/smith/` | `~/.cache/smith/` |
| macOS | `~/Library/Application Support/smith/` | same | `~/Library/Caches/smith/` |
| Windows | `%APPDATA%\smith\` | `%LOCALAPPDATA%\smith\` | `%LOCALAPPDATA%\smith\cache\` |

```
data_dir/smith/
  sessions/              ← length-prefixed CBOR-seq files
    {session-id}.session
    {session-id}.trace    ← trace log for deterministic replay
  plugins/               ← installed user Lua plugins
  data/                  ← plugin persistent state (per-plugin)
  vcs/                   ← smith-managed jj state, keyed by project hash
    {project-hash}/
      jj-state/           ← actual .jj directory; project has only a .jj symlink

cache_dir/smith/
  bytecode/              ← compiled LuaJIT bytecode with source hash headers

config_dir/smith/
  config.lua             ← user configuration
  themes/                ← user theme overrides (see SM-008 §theme.rs)
  keybindings/           ← user keybinding overrides
```

**Internal VCS engine**: smith may initialize a transparent jj repository for
operation-level undo/redo and time-travel. The actual `.jj` state is relocated to
`data_dir/smith/vcs/{project-hash}/jj-state/`; the project root contains only a
`.jj` symlink. For colocated git repositories, smith rewrites jj's `git_target`
to an absolute `.git` path after relocation. Users do not need to use jj as their
VCS; jj is an internal state engine exposed to plugins only via `smith.vcs.*`.

**Session format**: Length-prefixed CBOR-seq (RFC 8949 entries with u32 BE length prefix).

File structure:
```
┌────────────┬──────────────────┬────────────┬──────────────────┐
│ u32 BE len │ CBOR entry bytes │ u32 BE len │ CBOR entry bytes │
└────────────┴──────────────────┴────────────┴──────────────────┘
```

Session format, entries, persistence, and fault-tolerant CBOR codec are
defined in **SM-006** §session.rs and §session_format.rs.
See SM-006 for: `SessionEntry` enum (12 variants), `SessionCodec`,
`SessionStore` trait, compaction, and migration logic.
Session discovery is keyed by canonical `SessionId` filenames. Legacy
timestamp-shaped filenames may be discovered by reading the CBOR header and
renamed to `{session-id}.session` / `{session-id}.trace` during migration.

**Key properties** (narrative only -- types are canonical in SM-006):
- CBOR-encoded, length-prefixed entries for crash recovery.
- Fault-tolerant parsing: truncated -> stop, corrupt -> skip+warn, unknown -> keep.
- smith session dump converts CBOR-seq -> JSONL (see SM-010 CLI spec).
- Secret proxy translation table rebuilt by scanning backward from session end.
- Compaction rolls up old entries while preserving secret registrations.

## Crate: smith (Shared Library)

Shared types and utilities. No business logic.

### Responsibilities
- Common types (EntryId, SessionId, Message, ContentBlock, Role, etc.)
- Lua runtime setup (mlua, mlua-pkg)
- Config resolution from Lua files
- Error types (smith Error)

### Key Types

Types are defined in **SM-005** (`smith/` shared library). This crate re-exports
`smith_core::SessionEntry`, `smith_core::Session`, etc. See SM-005 §types.rs,
§config.rs, §lua.rs, and §error.rs for canonical definitions.

```rust
// Re-exported from smith-core
pub use smith_core::{EntryId, SessionId, Session, SessionEntry, Message, ContentBlock, Role};
```

## Crate: smith-core

Pure business logic. No I/O, no side effects. Session management, tools, hooks.

### Responsibilities
- Session management (tree, entries, compaction)
- Session format (CBOR encode/decode)
- Tool registry and execution
- Hook types and registration
- Secret proxy
- System prompt building
- Engine event types

### Key Types

```rust
/// Session: conversation with an LLM
pub struct Session {
    pub id: SessionId,
    pub name: Option<String>,
    pub cwd: PathBuf,
    pub entries: Vec<SessionEntry>,
    pub current_leaf: EntryId,
    pub created: u64,
    pub updated: u64,
}

/// SessionEntry, SessionStore, AgentEvent, and EngineEvent are defined in
/// **SM-006** (`smith-core/`). See SM-006 §session.rs, §session_format.rs,
/// §agent.rs, and §events.rs for canonical definitions.

/// Tool trait — canonical definition is `AgentTool` (async) in **SM-005** §tool.rs.
/// The tool registry uses `Arc<dyn AgentTool>`. See SM-006 §tools.rs.

/// Event bus — replaced by `mpsc::UnboundedSender<AgentEvent>`. See SM-006 §agent.rs.

/// Events are split into two layers:
/// - **AgentEvent** (source of truth, emitted by the agent loop) — defined in **SM-006** §agent.rs.
/// - **EngineEvent** (harness-level wrapper with session/steering events) — defined in **SM-006** §events.rs.
/// See SM-009 §event_bridge.rs for the mapping to plugin SDK events.

/// Secret proxy
pub trait SecretProxy: Send + Sync {
    fn register(&mut self, secret: String) -> SecretId;
    fn resolve(&self, id: &SecretId) -> Option<&str>;
}
```

### Extension Points
- Add new `SessionEntry` variants
- Add new `EngineEvent` variants
- Custom `Tool` implementations
- Behavior-mutating hook implementations (`beforeToolCall`, `afterToolCall`) — see SM-006 §agent.rs
- Agent loop control callbacks (`shouldStopAfterTurn`, `prepareNextTurn`) — see SM-006 §agent.rs
- Add new `TraceEntry` variants for new event sources
- Custom `TraceRecorder` implementations (e.g., network sink)
- Replay compare mode strategies (custom diff functions)

## Crate: smith-ai

LLM provider layer. Preconfigured providers + config-driven models.

### Responsibilities
- Provider trait (streaming responses, tool calling)
- Preconfigured providers (Anthropic, OpenAI, Google, local)
- Model registry and resolution
- API calls and streaming
- Reads Lua config for provider/model settings

### Key Types

Provider trait, streaming types, model registry, and auth are defined in
**SM-007** (`smith-ai/`). Shared streaming types (`ProviderEvent`, `ProviderRequest`)
live in **SM-005** §types.rs to enable parallel builds.

Provider implementations: AnthropicProvider, OpenAIProvider, GoogleProvider,
OpenAICompatProvider. See also `docs/design/AI-CRATE-DESIGN.md`.

```rust
// Re-exported from smith (shared types)
pub use smith::{ProviderEvent, ProviderRequest, ProviderUsage, StopReason};
```

## Crate: smith-tui

Terminal rendering. Widgets, themes, keybindings. Receives events from harness.

### Responsibilities
- Render UI based on engine state
- Send UI events (input, resize, abort) to harness
- Widgets (message list, input area, status bar)
- Theme system
- Keybinding handling

```
Main Thread (Engine)                  UI Thread (Rendering)
     │                                     │
     ├─state_tx───►[TuiState]──────────────┤  (what to render)
     │                                     │
     │◄──input_rx───[user input]───────────┤  (what to do)
     │                                     │
     ├─EngineEvent: ThinkingStarted ───────►│
     ├─EngineEvent: TokenDelta ─────────────►│
     ├─EngineEvent: ToolCall ───────────────►│
     ├─EngineEvent: ToolResult ─────────────►│
     └─EngineEvent: Error ───────────────────►│

Tool Thread (Execution)
     │
     ├─tool_rx──►Engine (results)
```

Engine event loop (never blocks on UI):
```rust
loop {
    select! {
        input = input_rx.recv() => self.handle_input(input?),
        result = tool_rx.recv() => self.handle_tool_result(result?),
        _ = tick(Duration::from_millis(16)) => self.ui_state.render(),
    }
}
```

### TUI State Machine

Every state is interruptible by the user (Ctrl+C → abort flag).

```rust
pub enum TuiState {
    Idle,           // waiting for input, blinking cursor
    Thinking,       // LLM processing, spinner, input locked
    ToolRunning,   // tool executing, can cancel
    ToolResult,    // showing tool output, input unlocked
    Error,         // error displayed, input unlocked
    Exiting,       // terminal restore, cleanup
}
// Note: Security confirmations are not in core — tools are either exposed or not via config.
```

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ [ctx: 45k/200k] [$0.23] [session: foo] [claude-sonnet-4]│  ← status bar
├─────────────────────────────────────────────────────────┤
│ User: Read the Cargo.toml                               │
│ Assistant: [tool: read("Cargo.toml")]                   │  ← message history
│ Tool: [expanded inline or collapsed]                     │    (virtual scroll)
│                                                         │
├─────────────────────────────────────────────────────────┤
│ > cargo run -- --help                                  │  ← input area
│ [Enter: send] [Ctrl+C: abort] [Ctrl+L: model]         │  ← hint bar
└─────────────────────────────────────────────────────────┘
```

**Status bar**: No smith name/version. Shows:
- `ctx: X/Y` — current context usage / max
- `$N.NN` — running cost estimate (updated in real time)
- `session: name` — current session
- `model: name` — active model

**Message history**: Virtual scrolling. `sticky_bottom` flag:
- `true` (default): new messages auto-scroll to bottom
- `false` (user scrolled up): stay in place until user scrolls back or submits

**Input area**: Custom `InputArea` widget on ratatui. Not reedline — reedline
owns inline rendering which conflicts with ratatui managing the whole screen.
Built with ratatui primitives + crossterm cursor. Single-line by default,
multiline when content wraps. Arrow keys navigate. Ctrl+C cancels.

**Hint bar**: Keyboard shortcuts for current state. Updates dynamically.

### Rendering: ratatui + crossterm

ratatui handles widgets, layout, TestBackend for snapshots.
crossterm handles terminal I/O, cursor, Kitty keyboard protocol flags.

```rust
// Kitty keyboard flags via crossterm
use crossterm::event::{KeyboardEnhancementFlags, DisableBracketedPaste};

terminal.push_event_filter(KeyboardEnhancementFlags::DisambiguateEscapeCodes);
terminal.push_event_filter(KeyboardEnhancementFlags::ReportEventTypes);
```

Custom `Backend` wraps crossterm, emits Kitty escape sequences for:
- Extended colors (24-bit, beyond 256)
- Undercurl (spelled out for cross-compatibility)
- Image support (sixel/kitty-ki) — deferred v1

ratatui `TestBackend` enables snapshot testing:
```rust
#[test]
fn renders_status_bar_with_context() {
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|f| render_status_bar(f, "45k", "$0.23"));
    insta::assert_snapshot!(terminal.backend());
}
```

### Theme System

Themes defined in config.lua, not separate files:

```lua
return {
    theme = {
        status_bar = { bg = "#1a1a2e", fg = "#eeeaea" },
        user_message = { bg = "#16213e", fg = "#e8e8e8" },
        assistant = { bg = "#0f0f23", fg = "#c4c4c4" },
        tool_call = { bg = "#2d2d44", fg = "#7f7fff" },
        tool_result = { bg = "#1a1a1a", fg = "#00ff00" },
        error = { bg = "#2a0a0a", fg = "#ff4444" },
        input = { bg = "#1e1e2e", fg = "#cdd6f4" },
    },
}
```

Rust defines the theme schema (validates keys and color formats). Lua provides values.
No `themes/` directory — themes live in config.lua.

### Deferred (v1 scope)

- Vim-style normal mode editing
- Multiline input with explicit newline insertion
- Inline image rendering (Kitty graphics)
- Fuzzy history search
- Split panes / tabs
- Multiple simultaneous sessions

## Crate: smith-harness

Orchestrator + plugin system. Owns the event loop, coordinates all crates.

### Responsibilities
- Plugin loading (LuaJIT via mlua)
- Plugin SDK (Lua API, credential access, **ExtensionContext** for agent control, **ExtensionUIContext** for UI interaction)
- Event loop (engine owns it)
- Coordinates core + ai + tui
- Receives UI events, dispatches to engine

### Key Types

```rust
pub struct Harness {
    pub core: CoreEngine,
    pub ai: AiLayer,
    pub tui: TuiBridge,
    pub plugins: PluginManager,
}

pub struct PluginManager {
    lua: LuaRuntime,
    plugins: Vec<LoadedPlugin>,
}

pub struct PluginSdk {
    // smith.fs.*, smith.env.*, smith.credentials.*
    // smith.abort(), smith.shutdown(), smith.getContextUsage()
    // smith.ui.select(), smith.ui.confirm(), smith.ui.setStatus()
}
```

### Lua Runtime Restrictions

**Standard libraries**: Keep `string`, `table`, `math`, `coroutine`, `utf8`, `package`
(with custom searchers). Strip `io`, `os`, `debug`, `getfenv`, `setfenv`.

**Host functions** exposed through a `smith.*` Lua module:
```lua
smith.fs.read("path")         -- read file
smith.fs.write("path", data)  -- write file
smith.env.get("HOME")         -- read-only env access
smith.time.now()              -- safe timestamp
```

Plugins have no `io`, `os`, `debug`, `getfenv`, `setfenv` globals. They can only
access the filesystem and environment through `smith.fs.*` and `smith.env.*`.
No path restrictions or capability grants — the Lua runtime itself is the only
guard. Built-in tools and user plugins use the same API.

**Custom require** via `mlua-pkg` crate — composable resolver chain:
- `NativeResolver` — smith's Rust API surface to plugins
- `FsResolver` — plugin's own directory
- `MemoryResolver` — embedded modules smith provides
- Plugins can be multi-file with nested directories

**Bytecode caching**: Smith compiles `.lua` → bytecode on first load, caches
by source hash. Smith never loads bytecode it didn't compile itself. No signing
needed — trust is in the source, cache is just a performance optimization.



### ~~OCaml-Style Interface Modules~~

> **⚠️ Superseded by SM-009 §7-9.** The OCaml-style `PluginInterface`
> hierarchy was an early design. The canonical plugin system uses Lua
> factory functions → `PluginRegistrations` → 4-phase materialization.
> See SM-009 for the authoritative plugin architecture.

~~```rust
/// STALE — see SM-009 for canonical plugin traits.
pub trait PluginInterface: Send + Sync {
    fn interface_name(&self) -> &str;
}

pub trait Plugin: Send + Sync {
    fn metadata(&self) -> PluginMetadata;
    fn interfaces(&self) -> Vec<Box<dyn PluginInterface>>;
}

pub trait ToolInterface: PluginInterface {
    fn tool(&self) -> Box<dyn AgentTool>;
}

pub trait WidgetInterface: PluginInterface {
    fn widget(&self) -> Box<dyn Widget>;
}

pub trait HookInterface: PluginInterface {
    fn hooks(&self) -> Vec<HookRegistration>;
}
~~```

### Plugin Loading

```rust
/// Plugin loader — discovers and instantiates plugins
pub trait PluginLoader {
    /// Load a plugin from the given path
    fn load(&self, path: &Path) -> Result<Box<dyn Plugin>>;
    /// List available plugin interfaces
    fn available_interfaces(&self) -> &[InterfaceDescriptor];
}

/// Lua plugin loader (uses mlua with LuaJIT + mlua-pkg for custom require)
pub struct LuaPluginLoader { /* TODO */ }


```

### Extension Points
- New Lua plugin hooks (add to SM-009 §4 PluginEvent variants)
- New plugin loaders (e.g., native Rust `.so` plugins)
- Behavior-mutating event handlers (block tool calls, transform input, override system prompts)
- Tool custom renderers (`renderCall`, `renderResult`)
- Plugin-to-plugin communication via EventBus

## Crate: smith-cli

Binary entry point. Parses args, creates harness, runs it.

```rust
pub struct CliArgs { /* clap derive */ }

pub struct AppConfig {
    pub mode: AppMode,
    pub provider: ProviderConfig,
    pub model: ModelSelection,
    pub session: SessionSelection,
    pub tools: ToolSelection,
    pub ui: UiConfig,
}

pub enum AppMode {
    Interactive,
    Print { prompt: String },
    Json,
    Rpc,
}

pub fn main() -> Result<()> {
    let args = CliArgs::parse();
    let config = resolve_config(args)?;
    let mut harness = Harness::new(config)?;
    harness.run()
}
```

## Security Model

The LLM is the **only untrusted actor**. Everything else is trusted.

**Trusted** (inside boundary):
- User's machine, OS, filesystem
- User running smith
- Plugins (user verified source before installing)
- Smith itself
- All local data (sessions, secrets, config)

**Untrusted** (outside boundary):
- The LLM (remote server — could be compromised, prompt-injected, or adversarial)
- Network calls to LLM provider

**What this means in practice:**
- Session files: plaintext CBOR-seq, no encryption
- Secret proxy translation table: merged into session entries, plaintext
- API keys: read from environment variables or plain text config, smith passes them to tools
- No OS keychain integration — credentials stay in env/config
- Smith focuses security effort on **bounding LLM capabilities**, not encrypting local data

**LLM bounding mechanisms:**
1. Tool registry: smith controls which tools the LLM sees — not all tools are exposed
2. Secret proxy: LLM sees `smith:sec:N` identifiers, never real secrets
3. Lua runtime restrictions: plugins have no `io`, `os`, `debug` globals. They
   access the filesystem only through `smith.fs.*` (Rust). No capability system.

Security is primarily **configuration** — users configure which tools are active.
Tools execute without confirmation dialogs. Popups that users learn to
auto-accept are theater, not security. Security comes from restricting what
tools can do (restricted Lua context, no filesystem escape) and what the LLM
sees (secret proxy), not from interrupting the user.

**The secret proxy system** prevents LLM data exfiltration:
- Every user message and tool output scanned for secret patterns (env vars, tokens, keys)
- Detected secrets replaced with `smith:sec:N` identifiers before reaching LLM
- When LLM makes a tool call, arguments scanned for identifiers and rehydrated
- Translation table: stored as session entries, restored on session resume

Secret registration is represented as `SessionEntry::SecretRegister` (canonical: SM-006 §session.rs).
> **Note:** The earlier `SecretRegisterEntry` struct below is historical.

~~```rust
// Historical — see SM-006 SessionEntry::SecretRegister
struct SecretRegisterEntry {
    secret_id: String,
    value: String,
    source: String,
    timestamp: u64,
}
~~```

Session resume builds translation table by scanning backward for most recent
`secret_register` entry per ID. History is always restorable.

## Concurrency Model

Three threads. The engine (main thread) drives the event loop. The UI thread is
purely reactive and must never stall user input.

```
Main Thread (Engine)         UI Thread              Tool Thread
(owns the event loop)        (rendering)            (execution)
     │                        │                        │
     ├─state_tx──────────────►│ (TuiState updates)     │
     │◄──input_rx─────────────┤ (user input)           │
     │                        │                        │
     │ LLM streaming ─────────┼── EngineEvent ────────►│
     │                        │                        ├─tool_rx──►Engine
     │ config resolution      ├─snapshot capture       │ tool execution
     │ session management     │                        │ subprocess
     │ state machine          │                        │ file I/O
```

- **Engine (main thread)**: Owns the event loop. Receives user input via
  `input_rx` channel. Never blocks on UI operations. Drives state machine.
  Receives tool results via `tool_rx`. Sends state updates via `state_tx`.
- **UI thread**: Renders continuously. Reads from `state_rx`. Sends input
  to engine via `input_tx`. Never calls the engine directly. Never blocks
  on engine operations.
- **Tool thread**: Executes tools, runs subprocesses, performs file I/O.
  Returns results to engine via `tool_rx`. Plugins run here.

**Never block the UI**: Every user keypress must be acknowledged within 16ms.
The engine loop uses non-blocking channel receives. If no input is available,
the loop proceeds without waiting. The UI thread is always responsive.

**Every state is interruptible**: Ctrl+C sets an abort flag. The current
operation checks the flag and bails cleanly. No state is a dead end.

**Async boundary**: `tokio` is scoped to the **provider layer** (smith-ai)
and **agent loop** (smith-core). Tool execution and TUI rendering remain
sync/single-threaded on their respective threads. The engine main thread uses
`tokio::select!` for non-blocking channel receives. See SM-005 (tokio sync),
SM-006 (tokio rt+sync), and SM-007 (tokio full) for crate-specific async usage.

## Error Handling Strategy

Two-tier error model:

```rust
/// Recoverable errors — canonical definition in SM-005 §8 (`smith/src/error.rs`).
/// Variants below are illustrative; SM-005 is authoritative.
pub enum SmithError {
    Provider(ProviderError),
    Auth(AuthError),
    Tool(ToolError),
    Resolve(#[from] ResolveError),
    Config(String),
    Lua(mlua::Error),
    Io(#[from] std::io::Error),
    CborEncode(ciborium::ser::Error<std::io::Error>),
    CborDecode(ciborium::de::Error<std::io::Error>),
}
```

`ProviderError` and `AuthError` are defined in **SM-005** §error.rs. `SmithError` is defined in **SM-005** §error.rs.

/// Unreachable states — asserted, panic on failure
/// Used for: invariant violations, impossible states, programmer errors
/// These are NOT caught — they indicate bugs.
///
/// assert!(entries.len() <= MAX_ENTRIES);
/// assert_eq!(state.current_turn, expected_turn);
```

Rule of thumb:
- External failures (network, disk, LLM, plugins) → `Result<_, SmithError>`
- Internal invariants (state machine consistency, bounds) → `assert!`
- Never use `unwrap()`/`expect()` — clippy denies them

## Example Plugin

A concrete example of what a real smith plugin looks like. This informs the
architecture — every trait and type must support this use case:

```lua
-- built-in/tools/read.lua
-- One of smith's built-in tools — implements the "read" tool for the LLM
-- Uses the same plugin API as any user plugin

local smith = require("smith")

return {
    name = "read",
    version = smith.version,
    description = "Read file contents",

    interfaces = {
        tool = true,
    },

    tool = {
        name = "read",
        description = "Read file contents. Supports offset/limit for large files.",
        parameters = {
            path = { type = "string", description = "File path to read" },
            offset = { type = "number", description = "Line offset", optional = true },
            limit = { type = "number", description = "Max lines", optional = true },
        },
        execute = function(params)
            -- smith.fs.* is the file API
            local content = smith.fs.read(params.path)
            if params.offset then
                content = smith.string.lines(content, params.offset, params.limit)
            end
            return { content = content }
        end,
    },
}
```

And a user plugin for comparison:

```lua
-- ~/.smith/plugins/my_search/init.lua
-- User plugin — semantic code search

local smith = require("smith")

return {
    name = "my_search",
    version = "0.1.0",

    interfaces = {
        tool = true,
        hook = true,
    },

    tool = {
        name = "search",
        description = "Search the codebase",
        parameters = {
            query = { type = "string", description = "Search query" },
        },
        execute = function(params)
            local files = smith.fs.list_dir("src")
            -- ... search logic ...
            return { results = results }
        end,
    },

    hooks = {
        on_session_start = function(event)
            smith.log("info", "Search plugin loaded")
        end,
    },
}
```

Both use the same API. Built-in tools have no special privileges.

## Novel Tool Research

Traditional coding agents expose: `read`, `write`, `edit`, `bash`.
Smith wants to explore richer tool primitives. Architecturally, the `AgentTool`
trait (SM-005 §tool.rs) and Lua plugin system (SM-009) support this — any research
into novel tools just implements the `AgentTool` trait.

Ideas to explore (not implement now, just design space):
- Structured editing (AST-aware, not text-based)
- Semantic search over codebase
- Execution tracing / debugging tools
- Multi-file refactoring primitives
- Test generation and mutation tools

## Dependency Decisions

### Workspace Crates

```
smith/          — shared library (types, Lua runtime, config)
smith-core/     — pure business logic (session, tools, hooks)
smith-ai/       — LLM providers (preconfigured + config-driven)
smith-tui/      — terminal rendering (widgets, themes)
smith-harness/  — orchestrator + plugins (event loop, SDK)
smith-cli/      — binary entry point
xtask/          — build subcrate (check, test, lint)
```

### Production Dependencies

| Crate | Purpose |
|-------|---------|
| `ratatui` | Widget system, TestBackend for snapshots |
| `crossterm` | Terminal I/O, cursor, Kitty keyboard flags |
| `clap` | CLI argument parsing (derive macros) |
| `ciborium` | CBOR-seq encode/decode for sessions via Serde |
| `dirs` | XDG directory paths |
| `mlua` | LuaJIT bindings |
| `mlua-pkg` | Lua module loader (custom require) |
| `tokio` | Async runtime (provider layer) |
| `reqwest` | HTTP client (provider API calls) |
| `uuid` | Entry IDs (v7 for time-ordering) |
| `serde_json` | Tool definitions, JSON handling |
| `jsonschema` | Tool argument validation |
| `ignore` | Gitignore-aware directory walking for `find` plugin |
| `grep`, `grep-regex`, `grep-searcher` | Ripgrep engine for `grep` plugin |
| `syntastica`, `syntastica-parsers` | Syntax highlighting primitive for TUI/plugin views |
| `similar` | Unified/patience/word diffs for replay and plugin diff views |
| `fuzzy-matcher` | Fuzzy filtering with match indices for Lua-driven TUI lists |
| `clap_complete` | Shell completion generation for smith-cli |
| `gix` | Targeted structured VCS queries behind `smith.vcs.*` |
| `tracing` | Structured logging |
| `tracing-subscriber` | Log formatting (JSON, pretty) |
| `color-eyre` | **Deferred** — not used in v1 |
| `indicatif` | **Deferred** — not used in v1 |

### Dev Dependencies

| Crate | Purpose |
|-------|---------|
| `insta` | Snapshot testing |
| `assert_cmd` | CLI integration tests |

### Deferred

| Item | Decision |
|------|----------|
| Kitty graphics (sixel/kitty-ki) | v1: text only. v2: evaluate crate |


## Deliverables

### 1. Architecture Document

This spec (`spec-sm-004-architecture.md`) and `docs/PROJECT-INVARIANTS.md` are the authoritative architecture references:
- Module overview with responsibilities
- Data flow diagram (text-based)
- Trait hierarchy for each module
- Extension point catalog
- Security model layers
- Plugin system design (interfaces, loading)
- Dependency decisions with rationale
- Research-question resolution status; no open architecture research questions remain for v1 after SM-005/006/007/009 contracts are normalized.

### 2. Skeleton Modules

Create Rust files with doc comments, type definitions, trait declarations, and
`todo!()` stubs. **No implementation** — just the shape:

```
src/
  lib.rs
  engine/
    mod.rs          — module root, re-exports
    provider.rs     — Provider trait, ProviderStream, ProviderEvent, Message, ContentBlock
    session.rs      — Session, SessionEntry enum, SessionStore trait
    session_format.rs — Length-prefixed CBOR-seq read/write, fault-tolerant parser
    tools.rs        — AgentTool trait, ToolDefinition, ToolInput/Output
    events.rs       — EngineEvent enum, AgentEvent enum
    error.rs        — SmithError enum (two-tier: recoverable vs asserted)
    config.rs       — ConfigResolver, ConfigCascade, ConfigSource
    credentials.rs  — CredentialReader trait (env vars + config)
    secret_proxy.rs — Secret detection, identifier substitution, translation table
    engine.rs       — Engine struct, agent loop, 3-thread concurrency
    compaction.rs   — Token estimation, cut points, summarization, compaction
    tool_exec.rs    — Tool execution modes, retry policy, sequential/parallel
    system_prompt.rs — System prompt construction from components
    commands.rs     — Slash commands, CommandHandler trait
    hooks.rs        — Extension hooks, HookRegistration, ExtensionRunner
    /// ============================================================================
    /// AGENT LOOP
    /// ============================================================================
    /// Based on pi's agent-loop design. Simple event-driven loop with two nested loops:
    /// - Outer loop: handles tool calls + pending messages
    /// - Inner loop: streams LLM response
    ///
    /// Key insight: The loop is reactive. It responds to:
    /// - User input via channel (non-blocking)
    /// - Steering messages (queue during streaming)
    /// - Follow-up messages (queue when agent would stop)
    ///
    /// The loop NEVER blocks on UI. Input is delivered via channel.
    ///
    /// Start a new turn:
    /// agent_loop_add_prompt(prompts, context, config, signal, emit)
    ///
    /// Continue without adding prompt (for retry):
    /// agent_loop_continue(context, config, signal, emit)
    ///
    /// Main loop structure:
    /// loop {
    ///     // Inner: process tool calls and steering
    ///     while has_tool_calls || has_pending {
    ///         // Emit turn start
    ///         // Process pending steering messages
    ///         // Stream assistant response
    ///         // Execute tool calls (sequential or parallel)
    ///         // Collect results
    ///         // Check for more steering
    ///     }
    ///     // Check if agent would stop
    ///     if has_followup_messages {
    ///         // Continue with follow-ups (sets pending, goes back to inner loop)
    ///         continue;
    ///     }
    ///     // No more messages, exit
    ///     break;
    /// }
    ///
    /// Tool execution:
    /// - Sequential: execute one at a time, feed results back
    /// - Parallel: execute independent tools simultaneously
    /// - Before/after hooks via ExtensionRunner
    ///
    /// Error handling:
    /// - Tool errors: retry with backoff, or return error to LLM
    /// - LLM errors: abort, emit error event
    /// - User abort (Ctrl+C): set abort flag, current operation checks flag and bails
  interface/
    mod.rs          — module root, re-exports
    cli.rs          — CliArgs, clap derive
    config.rs       — AppConfig, resolve_config()
  tui/
    mod.rs          — module root, re-exports
    backend.rs      — TerminalBackend trait, TerminalCapabilities
    app.rs          — TuiState, TuiEvent, run_tui()
    widget.rs       — Widget trait
    theme.rs        — Theme types (schema — values come from Lua)
    keybinding.rs   — Keybinding types (schema — values come from Lua)
  plugins/
    mod.rs          — module root, re-exports
    interface.rs    — ~~PluginInterface~~ (historical; see SM-009 §7-9)
    loader.rs       — PluginLoader trait, LuaPluginLoader
    sdk.rs          — Lua SDK module definition, bytecode caching
    sdk.rs          — smith.* Lua module definition (what plugins can call)
built-in/           — Lua plugins shipped with smith (NOT in src/)
  tools/
    read.lua        — read tool implementation
    write.lua       — write tool implementation
    edit.lua        — edit tool implementation
    bash.lua        — bash tool implementation
  keybindings/
    default.lua     — default keybindings
  config.lua        — default configuration (includes theme values)
```

### 3. Tests

Every skeleton file must compile. Write **test stubs** that document the
intended test behavior with `todo!()`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_completes_with_streaming_response() {
        todo!("mock provider, send request, verify streaming events");
    }
}
```

These stubs serve as the test plan. Future tasks fill them in via TDD.

### 4. Update PROJECT-INVARIANTS.md

Add architecture section to `docs/PROJECT-INVARIANTS.md`:
- Module overview
- Key traits and their relationships
- Where to add new functionality (extension points)

## Steps

- [ ] Step 1: Verify `docs/PROJECT-INVARIANTS.md` covers all architecture invariants
- [ ] Step 2: Create `src/engine/` — trait definitions and type stubs
- [ ] Step 3: Create `src/interface/` — config types and CLI skeleton
- [ ] Step 4: Create `src/tui/` — backend trait, app state, widget trait
- [ ] Step 5: Create `src/plugins/` — interface module hierarchy, loader traits
- [ ] Step 6: Create `src/lib.rs` — re-export all modules
- [ ] Step 7: Write test stubs for every module (document intended test behavior)
- [ ] Step 8: Verify everything compiles: `cargo run -p xtask -- check`
- [ ] Step 9: Run `cargo run -p xtask -- lint` — zero warnings
- [ ] Step 10: Update `docs/PROJECT-INVARIANTS.md` with architecture section
- [ ] Step 11: Commit with `jj describe -m "arch(SM-004): smith architecture design — engine, interface, tui, plugins"

### Edge Cases and Design Decisions

1. **Tool failure**: Return error to LLM, LLM decides next action.
   - `execute_with_retry` retries transients
   - Final error → tool_result content → LLM handles it

2. **UI-to-Engine communication**: All UI events go through an event queue.
   - UI emits events: abort, user_input, resize, etc.
   - Engine processes events from queue (non-blocking)
   - Example: Ctrl+C → emit Abort event → engine checks abort flag → stops current operation

3. **Streaming vs non-streaming**: Both supported.
   - `ProviderStream` trait: `async fn next() -> Option<ProviderEvent>`
   - Streaming: yields tokens as they arrive
   - Non-streaming: waits for complete response, yields all at once
   - Same trait, different implementations
4. **Thinking/reasoning**: Part of model configuration, not auto-detected.
   - `Model` struct has `thinking_levels: Vec<ThinkingLevel>` field
   - User configures which thinking levels the model supports
   - No runtime detection — user knows their model
5. **Context overflow**: Trim oldest entries, retry compaction until it fits.
   - Start with oldest non-essential entries (redundant tool outputs)
   - If still overflow: run compaction
   - If compaction fails: trim more, repeat
   - Only fail after N iterations (prevent infinite loop)
   - Never error to user — keep trying until context fits
6. **Steering/follow-up/feedback loop**: Works exactly like pi.
   - Steering (queue during streaming): processed immediately after current tool result
   - Follow-up (queue when agent would stop): processed when agent would exit
   - Max iterations: `max_tool_calls_per_turn: usize` (default: 100), `max_turns_per_user_message: usize` (default: 50)

### Implementation Notes

1. **Model capabilities**: Handled via model configuration.
   - Each `Model` declares metadata: `context_window`, `max_output_tokens`, pricing, and supported features (thinking, vision, streaming, etc.)
   - No auto-detection — user configures their models
   - Provider decides which features to enable per-request

2. **Branching UX**: Like pi.
   - `/tree` shows session tree
   - Jump to any point, continue from there
   - Branches are immutable once created

3. **Graceful shutdown**: Like pi.
   - Signal handling for SIGTERM, SIGINT
   - Save session on signal, cleanup protocol

4. **Cost calculation**: Like pi.
   - Track input/output/cache tokens per response
   - Multiply by `ModelMetadata.cost` from the model registry or user provider config

5. **Plugin secret access**: Like pi.
   - Plugins declare required secrets in manifest
   - User sets credentials in config.lua or env vars
   - Plugins request secrets via SDK API

6. **Tool argument validation**: Use existing crate (jsonschema).

## Out of Scope
