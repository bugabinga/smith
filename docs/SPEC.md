# Smith Specification

Smith is a Rust coding-agent TUI. This document describes the desired project
state. It is the canonical specification for architecture, crates, interfaces,
configuration, plugins, CLI behavior, build gates, and testing.

## 1. Product Shape

Smith is a fast, extensible AI coding agent with:

- interactive terminal UI,
- non-interactive eval mode,
- JSON-RPC stdio mode,
- Lua plugin system,
- provider-independent agent loop,
- deterministic session storage and replay,
- built-in coding tools implemented through the same plugin API as user tools.

Core design principles:

- **Spec before code.** No production Rust exists without a matching spec.
- **Cargo only.** No Makefile, justfile, package scripts, or root shell scripts.
- **Stable Rust for product code.** Pinned nightly is allowed only for the
  required cargo-pup architecture gate.
- **Deep modules.** Public interfaces are small, honest, and typed.
- **Sinks, not pipes.** Cross-crate behavior flows through explicit typed
  requests, streams, events, or hooks. No hidden downstream cascades.
- **Everything user-visible is a plugin.** Tools, slash commands, themes,
  keybindings, prompts, layouts, and feature UI are Lua plugins.
- **LLM is the only untrusted actor.** Local user, local plugins, local files,
  and Smith itself are trusted.

## 2. Workspace

### 2.1 Crates

```text
smith/          foundation crate: shared types, StreamFn, AgentTool, config, Lua runtime, errors
smith-core/     agent loop, sessions, tools, hooks, compaction, cost, trace, replay
smith-ai/       LLM providers, auth, model registry, provider streams, MuxProvider
smith-tui/      terminal events, widgets, layout primitives, render loop, themes
smith-harness/  orchestration, plugin system, SDK, event bridge, built-ins, help
smith-cli/      binary entry point, clap CLI, session commands, eval/rpc/replay
xtask/          Cargo-only automation
```

### 2.2 Allowed Internal Dependencies

| Crate | May depend on |
|-------|---------------|
| `smith` | none |
| `smith-core` | `smith` |
| `smith-ai` | `smith` |
| `smith-tui` | `smith` |
| `smith-harness` | `smith`, `smith-core`, `smith-ai`, `smith-tui` |
| `smith-cli` | `smith`, `smith-harness` |
| `xtask` | none |

Forbidden:

- `smith` depending on any downstream crate.
- `smith-core`, `smith-ai`, and `smith-tui` depending on each other.
- `smith-cli` depending directly on `smith-core`, `smith-ai`, or `smith-tui`.
- Wildcard imports outside tests.
- `mod.rs` containing anything except module declarations and re-exports.
- Public API leaking from implementation modules unless explicitly listed here.

Architecture gates:

- `cargo run -p xtask -- arch` checks stable Cargo metadata and source
  invariants not covered by pup.
- `cargo run -p xtask -- pup` runs `cargo +nightly-2026-01-22 pup`.
- `cargo run -p xtask -- print-modules` prints crate roots from Cargo metadata
  plus cargo-pup submodule output.
- `cargo run -p xtask -- check` includes `arch` and `pup`.

### 2.3 Workspace Manifest

Workspace root:

```toml
[workspace]
members = [
    "smith",
    "smith-core",
    "smith-ai",
    "smith-tui",
    "smith-harness",
    "smith-cli",
    "xtask",
]
resolver = "3"

[workspace.package]
edition = "2024"
version = "0.1.0"
license = "Apache-2.0"
```

Required shared dependencies:

```toml
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
mlua-pkg = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
clap_complete = "4"
crossterm = "0.28"
ratatui = "0.29"
ciborium = "0.2"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
futures = "0.3"
unicode-width = "0.2"
unicode-segmentation = "1"
syntastica = { version = "0.6", default-features = false, features = ["runtime-c2rust"] }
syntastica-parsers = "0.6"
fuzzy-matcher = "0.3"
similar = "2"
ignore = "0.4"
grep = "0.4"
grep-regex = "0.1"
grep-searcher = "0.1"
gix = { version = "0.83", default-features = false, features = ["blame", "blob-diff", "revision"] }
url = "2"
oauth2 = "4"
insta = "1"
dirs = "5"
jsonschema = "0.28"
uuid = { version = "1", features = ["v7"] }
assert_cmd = "2"
assert_fs = "1"
proptest = "1"
expectrl = "0.9"
criterion = { version = "0.5", features = ["async_tokio"] }
zstd = "0.13"
sha2 = "0.10"
zip = { version = "2", default-features = false, features = ["deflate"] }
tar = "0.4"
flate2 = "1"
```

Release profile:

```toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = "symbols"
panic = "abort"

[profile.release.package."*"]
opt-level = 3
```

## 3. Toolchain, Lints, and Build Gates

### 3.1 Rust Toolchain

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

Smith follows latest stable Rust. Do not pin a numeric MSRV unless release
engineering creates a formal support window.

Nightly exception:

- `cargo-pup` uses pinned `nightly-2026-01-22` because it depends on rustc internals.
- Nightly is used only by the pup gate.
- Stable remains required for build, test, run, and release.
- Nightly breakage is fixed by updating pup/toolchain config, not by moving
  product code to nightly.
- Pup failure blocks commit, PR, and release.

### 3.2 Rust Flags

`.cargo/config.toml`:

```toml
[build]
rustflags = [
    "-D", "warnings",
    "-D", "clippy::unwrap_used",
    "-D", "clippy::expect_used",
    "-D", "clippy::panic",
    "-D", "clippy::todo",
    "-D", "clippy::unimplemented",
    "-D", "clippy::print_stdout",
    "-D", "clippy::print_stderr",
    "-D", "missing_docs",
    "-D", "rustdoc::missing_crate_level_docs",
    "-D", "rustdoc::broken_intra_doc_links",
    "-W", "rustdoc::invalid_html_tags",
    "-W", "rustdoc::bare_urls",
]

[registries.crates-io]
protocol = "sparse"

[target.aarch64-linux-android]
rustflags = ["-C", "link-args=-lclang_rt.builtins-aarch64-android"]
```

Every library crate has:

```rust
#![forbid(unsafe_code)]
#![warn(missing_docs)]
```

`smith-cli` may use unsafe only for OS terminal manipulation when no safe
alternative exists, wrapped in a tested safe abstraction with `// SAFETY:`.

### 3.3 Clippy Policy

- Zero warnings.
- No `unwrap`, `expect`, `panic`, `todo`, `unimplemented` in shipped library code.
- Tests may use `unwrap`, `expect`, and `panic`.
- `smith-cli` and `xtask` may use them only with a justification comment.
- Prefer `#[expect(lint, reason = "...")]` over `#[allow]`.

`.clippy.toml`:

```toml
cognitive-complexity-threshold = 25
```

### 3.4 Audit

`cargo run -p xtask -- audit` runs:

```bash
cargo deny check
cargo audit --deny warnings
```

`deny.toml` allows Apache-2.0, MIT, and Unicode-DFS-2016. Duplicate versions are
warned unless explicitly accepted.

### 3.5 cargo-pup

Root `pup.ron` exists and is required. Cargo-pup is the pinned-nightly source
architecture lint gate. `xtask arch` remains the stable Cargo metadata gate.

Initial pup rules enforce:

- hygienic `mod.rs`,
- no wildcard imports,
- `smith-core` imports no `smith-ai`, `smith-tui`, `smith-harness`, `smith-cli`,
- `smith-ai` imports no `smith-core`, `smith-tui`, `smith-harness`, `smith-cli`,
- `smith-tui` imports no `smith-core`, `smith-ai`, `smith-harness`, `smith-cli`.

Crate-boundary module match patterns must include the crate root. Use
`^crate($|::.*)`, not only `^crate::.*`. Cargo-pup sees root-owned items in
`lib.rs`/`main.rs` under the crate name itself.

Required boundary patterns:

```ron
matches: Module("^smith_core($|::.*)")
matches: Module("^smith_ai($|::.*)")
matches: Module("^smith_tui($|::.*)")
```

`cargo pup print-modules` is not a complete module inventory. It can omit crate
roots and can emit synthetic `unknown_crate` for crates with no child `mod`
items. Developer-facing module inventory uses `cargo run -p xtask -- print-modules`,
which prefixes crate roots from stable Cargo metadata and then prints
cargo-pup-discovered submodules.

Required setup:

```bash
rustup component add --toolchain nightly-2026-01-22 rust-src rustc-dev llvm-tools-preview
cargo +nightly-2026-01-22 install cargo_pup
```

Gate:

```bash
cargo +nightly-2026-01-22 pup
```

## 4. Runtime Directories and Files

Smith uses XDG-style directories via `dirs`.

| Platform | Config | Data | Cache |
|----------|--------|------|-------|
| Linux | `~/.config/smith/` | `~/.local/share/smith/` | `~/.cache/smith/` |
| macOS | `~/Library/Application Support/smith/` | same | `~/Library/Caches/smith/` |
| Windows | `%APPDATA%\smith\` | `%LOCALAPPDATA%\smith\` | `%LOCALAPPDATA%\smith\cache\` |

Data layout:

```text
data_dir/smith/
  sessions/
    {session-id}.session
    {session-id}.trace
  plugins/
  data/
  vcs/
    {project-hash}/
      jj-state/

cache_dir/smith/
  bytecode/

config_dir/smith/
  config.lua
```

Session files are plaintext length-prefixed CBOR sequences. Trace files are
compressed deterministic replay logs. Secrets in sessions are plaintext after
local registration; the security boundary is the LLM, not the local user.

## 5. Shared Crate: `smith`

`smith` owns shared types and utilities. It has no business logic and no
downstream dependencies.

Exports:

```rust
pub mod types;
pub mod stream;
pub mod tool;
pub mod lua;
pub mod config;
pub mod error;
pub mod mux;

pub use types::*;
pub use stream::StreamFn;
pub use tool::{AgentTool, AgentToolResult, AgentToolUpdate, ToolExecutionMode};
pub use lua::LuaRuntime;
pub use config::Config;
pub use error::SmithError;
pub use mux::{ModelAlias, ModelGroup, ProviderBucket, ModelResolver, ResolvedModel, ResolveError};
```

`smith` must not re-export `smith-core` types. Domain types are imported from
their owning crates.

### 5.1 IDs and Messages

Required shared types:

- `EntryId(String)` — UUID v7, time-sortable.
- `SessionId(String)`.
- `SecretId(String)`.
- `VcsOpId(String)`.
- `Role`: `System`, `User`, `Assistant`, `Tool`, `ToolResult`, `Custom`, `BashExecution`.
- `ContentBlock`:
  - `Text(String)`,
  - `Image { data, media_type }`,
  - `ToolCall { id, name, arguments }`,
  - `ToolResult { id, result, is_error }`,
  - `Thinking { content }`.
- `Message { role, content }`.

### 5.2 Provider Types

- `ProviderUsage` tracks input, output, cache read/write, and total tokens.
- `StopReason`: `EndTurn`, `ToolUse`, `OverMaxTokens`, `Aborted`, `StopSequence`, `Error`.
- `ThinkingLevel`: `Off`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`.
- `ProviderEvent`:
  - `TextDelta`,
  - `ToolCall`,
  - `ThinkingDelta`,
  - `Done`,
  - `Error`.
- `ProviderRequest` contains messages, system prompt, model/provider IDs, tool
  definitions, thinking level, token limit, and stop sequences.

### 5.3 Tool Types

- `ToolDefinitionSpec` is serializable metadata for LLM function calling and
  plugin metadata.
- `ToolDefinition` is runtime definition used by providers and the agent loop.
- `AgentTool` is async and `Send + Sync`.
- `ToolExecutionMode`: sequential or parallel according to tool metadata.
- `AgentToolResult` returns content blocks, error flag, and optional updates.
- Tool arguments are JSON and validated with `jsonschema`.

### 5.4 StreamFn

`StreamFn` is the provider abstraction consumed by `smith-core`:

- input: `ProviderRequest`,
- output: async stream of `ProviderEvent`,
- no dependency on `smith-ai`.

This permits `smith-core` and `smith-ai` to build independently.

### 5.5 Lua Runtime

`LuaRuntime` wraps mlua + LuaJIT + `mlua-pkg` custom require.

Allowed standard libraries:

- `string`,
- `table`,
- `math`,
- `coroutine`,
- `utf8`,
- `package` with custom searchers.

Removed globals:

- `io`,
- `os`,
- `debug`,
- `getfenv`,
- `setfenv`.

Smith host APIs are exposed through `require("smith")`.

Bytecode cache:

- Smith compiles `.lua` to bytecode on first load.
- Cache key includes source hash.
- Smith never loads bytecode it did not compile.

### 5.6 Config

Lua is the configuration language. Rust defines schemas; Lua supplies values.

Cascade order, later overrides earlier:

1. Rust type defaults/schema,
2. built-in Lua defaults,
3. plugin contributions,
4. user config at `config_dir/smith/config.lua`,
5. CLI flags.

Invalid values are rejected with clear errors. Unknown keys warn or fail
according to the schema context.

The cascade is re-evaluated at runtime by host configuration reload (§9.19);
CLI flags stay fixed for the process lifetime.

Example:

```lua
return {
  theme = "catppuccin",
  keybindings = {
    ["ctrl+l"] = "cycle_model",
    ["ctrl+c"] = "abort",
  },
  tools = { "read", "write", "edit", "bash" },
  model = "anthropic/claude-sonnet-4",
}
```

### 5.7 Models, Aliases, Groups, Buckets

`ModelMetadata` includes:

- provider/model IDs,
- context window,
- max output tokens,
- pricing,
- capabilities: thinking, vision, tool use, streaming.

`ModelResolver` is pure. It resolves:

```text
requested name → alias → group → bucket/account → provider/model metadata
```

Rules:

- no I/O during resolution,
- cycles detected at config load and reported with full path,
- DAGs allowed,
- `ResolvedModel` carries metadata needed by `smith-core`.

Failover:

- `FailoverStrategy`: ordered or round-robin.
- `BucketStrategy`: account rotation policy.
- Rate limits fail over immediately.
- Non-rate-limit transient errors retry before failover.

### 5.8 Errors

`SmithError` is the shared recoverable error enum. It wraps provider, auth, tool,
config, Lua, I/O, CBOR, and resolver errors.

Internal impossible states use assertions during development but shipped library
code must not panic for external failures.

## 6. Core Crate: `smith-core`

`smith-core` owns pure business logic: agent loop, sessions, tools, hooks,
secret proxy, compaction, cost, trace, and replay. It depends only on `smith`.

Exports:

```rust
pub mod agent;
pub mod session;
pub mod session_format;
pub mod tools;
pub mod events;
pub mod secret_proxy;
pub mod system_prompt;
pub mod compaction;
pub mod cost;
pub mod trace;
pub mod replay;
```

### 6.1 Agent Loop

The agent loop:

- receives an `AgentContext`, `AgentLoopConfig`, `StreamFn`, tool registry, and event sender,
- streams model responses,
- emits `AgentEvent`,
- executes tool calls,
- handles steering/follow-up messages,
- repeats until stop criteria.

The loop uses two nested loops:

- outer loop: turns and follow-up messages,
- inner loop: provider streaming, tool calls, steering.

It never imports provider implementations. Providers are `StreamFn` only.

Important config:

- `max_tool_calls_per_turn` default `100`,
- `max_turns_per_user_message` default `50`,
- tool execution mode: sequential or parallel,
- `model_metadata` for context/cost,
- hook callbacks.

Abort:

- Ctrl+C or programmatic abort sets an abort signal.
- Streaming and tool execution check it and bail cleanly.
- Every state is interruptible.

### 6.2 Agent Events

`AgentEvent` is source of truth for agent behavior:

- `AgentStart`, `AgentEnd`,
- `TurnStart`, `TurnEnd`,
- `MessageStart`, `MessageUpdate`, `MessageEnd`,
- `ToolExecutionStart`, `ToolExecutionUpdate`, `ToolExecutionEnd`,
- `TextDelta`, `ThinkingDelta`,
- `Error`.

`AgentEvent::to_session_entry(timestamp)` returns a `SessionEntry` only for
conversation-relevant completed events.

### 6.3 Engine Events

`EngineEvent` wraps `AgentEvent` and adds harness-level events:

- session lifecycle,
- steering/follow-up,
- UI state changes,
- provider/model changes,
- errors and shutdown.

`EngineEvent` is consumed by `smith-harness` and `smith-tui`.

### 6.4 Hooks

Core hook result types:

- `BeforeToolCallResult`: allow, block, replace args, cancel.
- `AfterToolCallResult`: keep, replace result, retry, cancel.
- `ShouldStopAfterTurn`: stop or continue.
- `PrepareNextTurn`: mutate queued prompts/messages.
- `TransformContext`: mutate LLM context before provider request.

`smith-harness` translates Lua plugin event returns into these core hook results.

### 6.5 Session Model

`Session` contains:

- `SessionId`,
- optional name,
- cwd,
- entries,
- current leaf,
- created/updated timestamps.

Sessions are branching trees. Branches are immutable once created. `/tree` and
history/time-travel features are Lua plugins over this core state.

`SessionEntry` variants include:

- user message,
- assistant message,
- tool call,
- tool result,
- system prompt snapshot,
- compaction summary,
- secret registration,
- model/provider change,
- VCS operation,
- metadata entries needed for migration and replay.

Every entry has a stable `EntryId`, optional parent, and timestamp.

### 6.6 Session Format

Session files are length-prefixed CBOR sequences:

```text
u32 BE len | CBOR entry bytes | u32 BE len | CBOR entry bytes | ...
```

Properties:

- crash recovery: truncated tail stops parsing,
- corrupt entry: skip + warn if possible,
- unknown future entry: preserve when round-tripping,
- `smith session dump` outputs JSONL,
- session discovery is keyed by canonical `{session-id}.session` filenames.

### 6.7 Secret Proxy

The secret proxy prevents LLM exposure of secrets:

- scans user messages and tool outputs for secrets,
- replaces secrets with `smith:sec:N`,
- stores plaintext translation entries locally,
- rehydrates tool arguments before local execution,
- rebuilds table on resume by scanning session entries backward.

Secrets are local plaintext. The protection target is the remote LLM.

### 6.8 System Prompt

`SystemPromptBuilder` composes:

- base identity,
- active model/tool capabilities,
- plugin prompt contributions,
- project/context facts,
- safety and tool-use instructions,
- user overrides.

Plugins may transform prompts through typed hooks. No hidden global prompt mutation.

### 6.9 Compaction and Cost

Compaction:

- uses `AgentLoopConfig.model_metadata.context_window`,
- starts with old non-essential/redundant entries,
- runs summarization when trimming is insufficient,
- repeats until context fits or configured iteration limit reached,
- preserves secret registrations and necessary lineage.

Token estimator:

- v1 heuristic: chars/4,
- exact tokenizer is not required in core.

Cost tracking:

- consumes `ProviderUsage`,
- multiplies by `ModelMetadata.cost`,
- tracks input/output/cache tokens and running total.

### 6.10 Tool Registry

`ToolRegistry` stores `Arc<dyn AgentTool>` by name.

Rules:

- duplicate registration follows harness plugin precedence,
- arguments are JSON-schema validated,
- final tool errors become tool-result content for the LLM,
- transient failures may retry according to tool policy.

### 6.11 Trace and Replay

Trace files capture deterministic replay data:

- file header with magic/version/session ID,
- compressed entries via zstd,
- provider requests/events,
- tool calls/results,
- TUI events as opaque JSON,
- plugin events as opaque JSON,
- VCS operation IDs,
- agent state snapshots.

Trace guarantees:

- preserves event order,
- enough data to reconstruct session state,
- compare mode can re-execute tools and diff outputs,
- replay can run real-time, speed multiplier, or max speed.

Replay modes:

- visual replay,
- max-speed reconstruction,
- compare old vs new tool outputs,
- fast-forward to turn range.

## 7. AI Crate: `smith-ai`

`smith-ai` owns concrete provider integrations. It depends only on `smith`.

### 7.1 Provider Trait

```rust
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn validate_auth(&self) -> Result<(), ProviderError>;
    fn stream(&self, request: ProviderRequest) -> Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>;
}
```

`provider_to_stream_fn(Arc<dyn Provider>)` returns the `StreamFn` consumed by
`smith-core`.

### 7.2 Provider Implementations

Required providers:

- Anthropic,
- OpenAI,
- Google,
- OpenAI-compatible local/remote endpoints.

Provider implementations normalize vendor wire formats into `ProviderEvent`.

Quirks handled at provider boundary:

- streaming vs non-streaming APIs,
- partial tool-call argument chunks,
- thinking/reasoning fields,
- provider-specific stop reasons,
- cache usage fields,
- model capability flags.

### 7.3 Model Registry

`providers.json` is bundled in `smith-ai/src/providers.json`. That checked-in
file is authoritative at runtime.

`fetch-providers` is a bootstrap and maintenance aid, not an automatic truth
source:

```bash
cargo run -p xtask -- fetch-providers
```

Data source priority for generated suggestions:

1. pi.dev model data,
2. catwalk provider configs,
3. later shared provider repositories after review.

Merge rule:

- merge by provider/model ID,
- pi.dev primary,
- catwalk fills gaps,
- `replace_models` permits full provider override,
- unknown provider fields are preserved for forward compatibility but ignored by v1.

Provider config correctness cannot be fully automated because Smith does not have
all provider accounts, subscriptions, API keys, or regional access. Generated
changes require review before commit. After the provider format stabilizes,
Smith may use a Pi agent to open provider-data PRs from `fetch-providers` diffs.

### 7.4 Auth

Auth resolver sources:

- environment variables,
- `~/.smith/auth.json`,
- plaintext Lua config values when explicitly supplied.

No OS keychain. No encryption.

Auth errors fail fast before first provider stream.

OAuth module supports mocked OAuth flow in tests and provider-specific OAuth where
configured.

### 7.5 MuxProvider

`MuxProvider` wraps multiple providers/accounts for resolved groups and buckets.

Behavior:

- `RateLimit`: immediate failover,
- `AuthFailed`, `Network`, `ServerError`: retry configured count then failover,
- `InvalidRequest`, `ModelNotFound`: no retry, immediate failover,
- `Timeout`: retry once then failover,
- exhausted providers emit `ProviderEvent::Error`.

## 8. TUI Crate: `smith-tui`

`smith-tui` owns terminal primitives, normalized events, widgets, themes, and
render loop. It depends only on `smith`.

### 8.1 Backend

Rendering uses:

- `ratatui` for layout/widgets/TestBackend snapshots,
- `crossterm` for terminal I/O, event polling, raw mode, alternate screen,
  Kitty keyboard protocol flags, and terminal capability probes.

### 8.2 Events

`TuiEvent` normalizes crossterm events:

- keyboard,
- mouse,
- resize,
- focus gained/lost,
- paste.

Keyboard events include normalized key code, modifiers, and press/repeat/release
kind. Mouse events include button, scroll, position, and modifiers.

### 8.3 Terminal Capabilities

`TerminalCapabilities` records:

- truecolor,
- undercurl,
- Kitty keyboard protocol,
- bracketed paste,
- focus events,
- mouse support,
- Kitty graphics / sixel availability.

No terminfo database. Probe directly. Unsupported optional features degrade to
plain text without user-facing error.

### 8.4 Component Trait

Components render into ratatui buffers and handle normalized `TuiEvent`.

Rules:

- rendering is deterministic,
- focus handling is explicit,
- event handlers return consumed/not-consumed,
- cached state has explicit invalidation.

### 8.5 TuiApp

`TuiApp` lifecycle:

```text
new → enter terminal → run event/render loop → shutdown → restore terminal
```

The render loop ticks at 16ms. Event polling runs on a blocking thread and sends
normalized events over channels. `TuiApp` is created/driven by `smith-harness`.

States:

- `Idle`,
- `Thinking`,
- `ToolRunning`,
- `ToolResult`,
- `Error`,
- `Exiting`.

Every state is interruptible.

### 8.6 Widgets

Required widget set includes:

- text,
- truncated text,
- spacer,
- markdown,
- message list,
- input area,
- status bar,
- hint bar,
- spinner,
- progress/cost/context indicators,
- tool call/result views,
- diff view,
- syntax-highlighted code,
- fuzzy list,
- tabs,
- scrollable,
- overlay,
- border layout panels.

Syntax highlighting uses `syntastica`. Diffs use `similar`. Fuzzy matching uses
`fuzzy-matcher`.

### 8.7 Layout

Rust provides primitives; Lua defines layout.

Primitives:

- column,
- row,
- box,
- expanded,
- scrollable,
- overlay,
- spacer,
- tabs,
- split.

One predefined border layout exists: center + north/east/south/west panels.
Panels are invisible when empty. Default layout is a Lua plugin.

### 8.8 Theme

Themes are Lua tables validated by Rust schemas.

Theme values cover status bar, messages, assistant content, tool call/result,
errors, input, borders, selections, diffs, syntax groups, and accents.

### 8.9 Virtual Scroll

Message history uses virtual scrolling. `sticky_bottom` defaults true and turns
false when user scrolls up. New content does not move viewport until user returns
to bottom or submits input.

### 8.10 Tool Rendering

Tools may register `renderCall` and `renderResult` Lua renderers. TUI receives
structured render instructions from harness, not arbitrary terminal writes.

## 9. Harness Crate: `smith-harness`

`smith-harness` wires all subsystems and owns plugin management.

Responsibilities:

- load config,
- load model registry and auth,
- resolve active model,
- create provider and `StreamFn`,
- create agent,
- load plugins,
- expose SDK to Lua,
- bridge core events to plugin events,
- translate plugin returns into core hooks,
- coordinate TUI, eval, and RPC modes.

### 9.1 Harness Structure

`Harness` contains:

- `Agent`,
- provider map,
- `ModelRegistry`,
- `ModelResolver`,
- auth resolver,
- `PluginManager`,
- optional `TuiApp`,
- active provider,
- active model.

### 9.2 Plugin Identity and Manifest

Plugin names are mandatory and namespaced:

```text
<org>/<name>
```

Rules:

- `org` and `name` use lowercase ASCII letters, numbers, `_`, and `-`.
- `smith/*` is reserved for built-in plugins.
- Installed global plugins live under `data_dir/smith/plugins/<org>/<name>/`.
- Project plugins live under `.smith/plugins/<org>/<name>/`.

Every plugin has a mandatory Lua manifest file. Plugin authors create it.
Manifest loading uses a restricted manifest environment with no Smith SDK and no
host I/O. The manifest returns a data table only.

Required manifest fields:

```lua
return {
  name = "org/name",
  version = "0.1.0",
  entry = "init.lua",
}
```

Optional manifest fields:

- `smith_api`,
- description,
- license,
- authors,
- repository,
- dependencies,
- declared secrets,
- exported interfaces,
- implemented interfaces.

If `smith_api` is absent, Smith treats it as `1`.

Smith validates manifests before loading plugin code.

### 9.3 Plugin API Compatibility

Smith plugin API uses integer generations, not semver ranges.

- API generation `1` is the default.
- If `smith_api` is absent, the plugin uses API generation `1`.
- From Smith `1.0.0` onward, API generation `1` is stable permanently.
- Future breaking plugin APIs use new generations (`2`, `3`, ...).
- Plugins opt in to a newer generation by setting `smith_api = 2`.
- A plugin declaring a generation newer than Smith supports does not load.
  `smith plugins` shows it as disabled with required/supported API generations.

Smith must keep API generation `1` working. Silent best-effort loading across
unknown generations is forbidden.

### 9.4 Plugin Loading

Lua plugins return registration tables/factories from their entry file. Plugin
bridge phases:

1. Load manifest in manifest environment.
2. Validate name, version, source, API range, dependencies, and declared secrets.
3. Load entry Lua source in restricted runtime.
4. Collect registrations.
5. Materialize Rust-side handles.
6. Register into tool/event/command/provider/TUI registries.

No Rust trait-object plugin API exists. Canonical plugin loading is the Lua
registration pipeline above.

### 9.5 Plugin Install and Uninstall

Supported install sources for v1:

- local directory path,
- git URL.

No central registry exists in v1.

`smith install <path-or-git-url>`:

- resolves the source,
- reads and validates the manifest,
- validates namespace and API compatibility,
- copies or clones into `data_dir/smith/plugins/<org>/<name>/`,
- refuses duplicates unless `--force`,
- does not run plugin entry code during install.

Git URL installs use Smith's internal git implementation boundary. The preferred
implementation is `gix` if its required clone/fetch feature set stays bounded;
otherwise the behavior remains the same behind the install boundary.

`smith uninstall <org>/<name>`:

- removes installed plugin code,
- keeps plugin data by default,
- supports `--purge-data` to remove `data_dir/smith/data/<org>/<name>/`,
- never removes project plugins.

### 9.6 Plugin Interface Modules

Plugin shape is mandatory. The exact interface/implementation module design is a
prototype target before production implementation.

Desired ecosystem capability:

- interface-only plugin packages,
- implementation-only plugin packages,
- implementations referencing external interfaces,
- packages containing both interface and implementation.

Smith must avoid a fractured plugin ecosystem. The candidate designs are:

1. declarative Lua interface tables validated at load time,
2. a typed Lua superset such as Teal compiled to Lua,
3. generated LuaLS/EmmyLua annotations plus runtime schemas.

A prototype must prove the chosen design before this section becomes an
implementation contract.

### 9.7 Plugin Precedence

Load order:

1. built-in plugins,
2. global user plugins,
3. project plugins,
4. explicit CLI/config overrides.

Later registrations override earlier ones unless registration marks duplicate as
an error.

### 9.8 Event Bridge

`PluginEvent` variants cover:

- agent lifecycle,
- turns,
- message deltas/end,
- tool call/result,
- session lifecycle,
- model changes,
- context/compaction,
- config reload (`config_changed`, §9.19),
- TUI/input events,
- commands,
- provider/auth events,
- VCS events,
- errors and shutdown.

Lua receives event tables with a `type` field.

Plugin event results can:

- block tool call,
- transform tool args,
- replace tool result,
- retry/cancel,
- transform input,
- override system prompt/context,
- request continue/stop,
- emit UI actions.

The bridge maps these into `AgentLoopConfig` hooks.

### 9.9 Extension Contexts

SDK contexts:

- `ExtensionContext`: agent lifecycle, model, context, tools, config, logging.
- `ExtensionCommandContext`: slash command args, selection, output, session.
- `ExtensionUIContext`: selection, confirm, prompt, status, layout, widget APIs.

### 9.10 Lua SDK

SDK namespaces include:

- `smith.fs.*`,
- `smith.search.*`,
- `smith.env.*`,
- `smith.time.*`,
- `smith.log.*`,
- `smith.tool.*`,
- `smith.command.*`,
- `smith.provider.*`,
- `smith.alias.*`,
- `smith.group.*`,
- `smith.bucket.*`,
- `smith.tui.*`,
- `smith.vcs.*`,
- `smith.bus.*`,
- `smith.config.*` (read access; `smith.config.reload()` triggers §9.19),
- `smith.abort()`,
- `smith.shutdown()`,
- `smith.getContextUsage()`.

All public Lua SDK functions carry LuaLS/EmmyLua `---@` annotations. LuaLS is the
canonical annotation dialect; no other dialect is supported. Every public binding
declares, at minimum:

- `---@param` for each argument (name, type, description),
- `---@return` for each result (type, description),
- a `---@usage` block with a runnable example.

Runtime argument schemas (used for validation) and generated docs both derive
from these annotations, so annotations and runtime behavior stay in sync. The
`xtask verify-docs` gate fails if any public binding lacks required annotations.

### 9.11 Built-in Plugins

Built-ins are Lua plugins, not Rust special cases:

- tools: `read`, `write`, `edit`, `bash`, `find`, `grep`, `ls`,
- slash commands: `/undo`, `/redo`, `/history`, `/tree`, `/reload-config`,
  replay/time-travel,
- VCS tools,
- default layout,
- default keybindings,
- default theme,
- default prompts.

### 9.12 Built-in Tool Specs

#### `read`

Inputs:

- `path: string`,
- `offset?: number`,
- `limit?: number`.

Behavior:

- reads text files,
- supports line windowing,
- rejects binary content or returns explicit binary metadata,
- output is bounded for LLM context.

#### `write`

Inputs:

- `path: string`,
- `content: string`.

Behavior:

- creates parent dirs as needed,
- writes atomically with temp file + rename,
- records VCS op when mutation succeeds.

#### `edit`

Inputs:

- `path: string`,
- exact `old_text`,
- `new_text`,
- `allow_multiple?: bool`.

Behavior:

1. read file,
2. reject empty `old_text`,
3. reject binary,
4. count exact matches,
5. fail if zero matches,
6. fail if multiple and `allow_multiple` false,
7. re-read/hash before write,
8. fail stale if file changed,
9. write atomically,
10. return change count and before/after hashes.

Errors include `ENOENT`, `EEMPTY`, `EBINARY`, `ENOMATCH`, `EMULTI`, `ESTALE`,
`ELOCK`.

#### `bash`

Inputs:

- `command: string`,
- `timeout?: number`,
- `cwd?: string`.

Behavior:

- executes subprocess on tool thread,
- captures stdout/stderr/status,
- enforces timeout,
- records output truncation metadata,
- supports abort.

#### `find`

Uses `ignore` crate. Respects gitignore-style files. Returns sorted paths with
limits.

#### `grep`

Uses `grep`, `grep-regex`, and `grep-searcher`. Supports context lines, glob,
case-insensitive search, literal/regex modes, match limits.

#### `ls`

Lists directory entries sorted alphabetically, with directory suffix, bounded
output, and explicit errors.

### 9.13 VCS SDK

Smith uses jj internally for operation-level undo/redo/time travel.

State:

- actual `.jj` lives under `data_dir/smith/vcs/{project-hash}/jj-state`,
- project root contains only `.jj` symlink,
- colocated git repos rewrite jj `git_target` to absolute `.git` path.

Plugins interact only through `smith.vcs.*`.

`smith.vcs.*` exposes:

- init/status/snapshot,
- op ID capture,
- diff queries,
- undo/redo/time-travel primitives,
- structured file statuses and hunks.

`gix` is used only for targeted structured queries behind `smith.vcs.*`.

### 9.14 Sandbox

Plugins are trusted but constrained to Smith SDK APIs:

- no raw `io`, `os`, or `debug`,
- filesystem/env access only through SDK,
- no path capability system in v1,
- built-in and user plugins use same API.

### 9.15 Dependency Resolution

Plugins may declare dependencies on other plugins in their manifest
(`dependencies`, §9.2). v1 resolves dependencies from already-available plugins
only; there is no central registry and no network resolution.

Each dependency entry names a plugin and a minimum API generation:

```lua
dependencies = {
  { name = "acme/logger", smith_api = 1 },
}
```

Resolution runs once per plugin set (built-in, global, project) after manifests
load and before entry code runs:

1. Build the dependency graph from validated manifests.
2. Fail loading a plugin whose declared dependency is absent from the resolved
   set. The plugin is disabled with a diagnostic naming the missing dependency.
3. Fail loading a plugin whose dependency is present but supports a lower API
   generation than requested.
4. Detect cycles. A dependency cycle disables every plugin in the cycle with a
   diagnostic listing the cycle path. Smith never partially loads a cycle.
5. Load plugins in topological order so a dependency's registrations exist before
   its dependents run.

v1 does not solve version ranges. `dependencies` express presence and API
generation only. Semver range solving is deferred until a registry exists.
Precedence (§9.7) still applies: a later plugin may override an earlier
registration even across a dependency edge.

### 9.16 Plugin Hot-Reload

Smith reloads a single plugin without restarting the process or losing the active
session. Reload is whole-domain replacement, not in-place mutation.

**Plugin domain.** Each loaded plugin instance owns one reload domain. The domain
owns all reloadable plugin state:

- the plugin's `mlua` runtime state and registry handles,
- registered tool/command/provider/shortcut/interface descriptors,
- event subscriptions, including `smith.bus` subscriptions (§9.18),
- TUI layout/widget registrations and render caches,
- host-side scratch allocations and any cancellation token for plugin tasks.

Nothing plugin-owned may outlive its domain. Registrations are keyed by domain so
teardown removes them deterministically. A callback, task, or subscription that
escapes its domain is a reload defect; the loader rejects registrations that
cannot be tied to the domain.

**Triggers.** Reload is requested by:

- the `smith plugins reload <org>/<name>` CLI/command path,
- a project plugin file change when watch-reload is enabled in config,
- reinstall of an already-loaded plugin.

Built-in `smith/*` plugins reload by the same mechanism.

**Sequence.** For a reload of plugin `P`:

1. Construct a new domain `D'` and load `P`'s manifest and entry code into it.
2. If load or registration fails, drop `D'` and keep the old domain `D` active.
   The old plugin keeps running. Reload reports failure with the load error.
3. On success, atomically swap `D'` in for `D`: new registrations replace old,
   subscriptions transfer to `D'`, then drop `D`.
4. Dropping `D` tears down its Lua state, registrations, subscriptions, caches,
   and scratch memory. Repeated reloads must plateau in live memory after warmup;
   no stale callback from `D` may run after the swap.

**Rollback.** Reload is all-or-nothing. Either `D'` fully replaces `D`, or `D`
remains and no partial state from `D'` survives. A failed reload never leaves the
plugin unregistered.

**Session continuity.** Reload does not reset the session. Session entries, agent
state, and other plugins' state are untouched. In-flight tool executions from the
old domain run to completion under `D`; their results are still delivered. New
invocations after the swap use `D'`.

**Dependents.** Reloading `P` does not reload its dependents (§9.15). Dependents
keep their handles to `P`'s registrations by stable name; the swap rebinds those
names to `D'`. A reload that removes a registration a dependent relies on surfaces
as a normal missing-registration error at next use, not a crash.

### 9.17 Plugin Error Model

Plugin faults are isolated. A plugin error never corrupts the host, the terminal,
or another plugin. Errors are classified by phase:

- **Manifest/validation error** (bad name, bad version, unsupported `smith_api`,
  missing/cyclic dependency): the plugin does not load. It is disabled and listed
  by `smith plugins` with the reason. Other plugins load normally.
- **Entry-load error** (Lua error while running entry code or collecting
  registrations): the plugin's partial registrations are discarded, the plugin is
  disabled with the error, and loading continues for the rest of the set. On
  reload (§9.16) this is a failed reload and the old domain is kept.
- **Event-handler error** (Lua error inside a subscribed handler): the error is
  caught, logged through `smith.log`, and the handler's result is treated as
  absent. A non-blocking event proceeds; a blocking event (e.g. `tool_call`) is
  treated as no decision — it does not block. One handler's failure never
  prevents other handlers for the same event from running.
- **Tool-execute error** (Lua error or returned error inside a plugin tool): it
  surfaces to the agent as a normal tool error result, not a host crash. The
  agent loop continues and the model may react to the error.
- **Bus-handler error** (§9.18): same isolation as event-handler errors — caught,
  logged, other subscribers still run.

Host library code never panics on plugin input (PROJECT-INVARIANTS §3.5). Plugin
errors carry the plugin name and phase so `smith plugins` and logs attribute them
unambiguously.

### 9.18 Inter-Plugin Messaging Bus

`smith.bus.*` is a namespaced publish/subscribe channel for plugin-defined
messages. It is separate from core lifecycle events (§9.8): the bus carries custom
plugin topics, not engine events, and plugins cannot emit core event types on it.

API:

```lua
-- Subscribe to a topic. Returns a handle usable to unsubscribe.
local handle = smith.bus.on("acme/index-ready", function(payload, ctx)
  ctx.ui.notify("index has " .. payload.count .. " files", "info")
end)

-- Publish to a topic. Delivers to all current subscribers.
smith.bus.emit("acme/index-ready", { count = 128 })

-- Stop receiving.
smith.bus.off(handle)
```

Rules:

- **Topic names are namespaced** `<org>/<topic>`, using the same character set as
  plugin names (§9.2). A plugin may emit any topic; convention is to emit under
  its own `org`. `smith/*` topics are reserved for built-in plugins.
- **Payloads are plain Lua data tables** — the same value shape passed across the
  SDK boundary. No functions, userdata, or host handles cross the bus.
- **Delivery is synchronous, in registration order,** on the plugin thread within
  the current tick. Emitting during delivery enqueues to run after the current
  dispatch completes; the bus does not re-enter.
- **Subscriptions are domain-owned** (§9.16). A subscription is dropped when its
  plugin's domain is torn down on reload or unload, so no stale subscriber
  survives.
- **A subscriber error is isolated** (§9.17): caught, logged, remaining
  subscribers still receive the message.
- **No delivery guarantee across load order:** a message emitted before a
  subscriber loads is not replayed. The bus is fire-and-forget, not a queue.

The bus is the only sanctioned direct plugin-to-plugin channel. Plugins otherwise
compose through shared tool/command/provider registries and the core event
bridge.

### 9.19 Host Configuration Reload

Smith reloads its own configuration at runtime without restarting the process or
losing the active session. Host reload follows the same contract shape as plugin
reload (§9.16): validate fully, swap atomically, roll back on failure.

**Scope.** A host reload re-evaluates the config cascade (§5.6) layers 1–4:

1. Rust type defaults/schema,
2. built-in Lua defaults,
3. plugin contributions,
4. user config at `config_dir/smith/config.lua`.

CLI flags (layer 5) are per-invocation. They were resolved at process start and
continue to override the reloaded layers unchanged.

**Triggers.** Reload is requested by:

- the built-in `/reload-config` slash command (§9.11), a Lua plugin calling the
  `smith.config.reload()` primitive (§9.10),
- a change to `config_dir/smith/config.lua` when watch-reload is enabled in
  config (same setting family as plugin watch-reload, §9.16),
- a plugin reload (§9.16), which may change layer-3 contributions; after the
  domain swap the cascade is re-evaluated automatically,
- in RPC mode (§10.2), the `config/reload` JSON-RPC method. The response reports
  success with the changed key paths, or the validation failure verbatim.

Eval mode reads config at startup and has no runtime reload trigger.

**Sequence.** For a host reload:

1. Re-evaluate the cascade into a candidate config. Validate every value against
   the Rust schemas, and re-run model resolution (§5.7) including alias/group/
   bucket cycle detection.
2. If evaluation, validation, or resolution fails, discard the candidate and keep
   the active config. The failure is reported with the exact key path and error;
   nothing partially applies.
3. On success, atomically swap the candidate in as the active config.
4. Apply effects in order: theme, keybindings, active tool set, resolved
   model/provider. TUI re-renders with the new theme on the next frame.
5. Emit the `config_changed` plugin event (§9.8) carrying the changed key paths.
   Plugins read the new values through their contexts (§9.9); the event does not
   carry secrets.

**Continuity.** Reload is invisible to in-flight work:

- an in-flight agent turn keeps the resolved model, tools, and system prompt it
  started with; the next turn uses the new config,
- running tool executions complete under the old values,
- the session, its entries, and plugin domains are untouched — a config reload
  never loads, unloads, or reloads plugin code.

**Restart-only.** The following are fixed for the process lifetime and never
hot-reload:

- CLI flags (layer 5),
- config/data/cache directory locations (§4),
- the active session identity and storage paths,
- the run mode (interactive, eval, RPC),
- the bundled `providers.json` (§7.3) — runtime provider changes go through
  `smith.provider.*` plugin overrides, not registry reload.

Credential resolution (§7.4) is not cached across reloads: the next provider
stream after a reload resolves auth against the new config values.

## 10. CLI Crate: `smith-cli`

Binary name: `smith`.

### 10.1 Global Flags

- `--model <model>`
- `--provider <provider>`
- `--session <id-or-name>`
- `--config <path>`
- `--no-config`

### 10.2 Commands

Default:

- `smith` starts interactive TUI with new auto-named session.

Subcommands:

- `smith new <name>` — new named interactive session.
- `smith attach [id-or-name]` — attach; fuzzy select if no arg.
- `smith continue` — continue last session in cwd.
- `smith resume` — fuzzy select session in cwd.
- `smith session list [--cwd]` — list sessions.
- `smith session dump [id] [--last N] [--output path]` — JSONL dump.
- `smith plugins` — list plugins, including disabled plugins with their reason.
- `smith plugins reload <org>/<name>` — reload a single loaded plugin (§9.16).
- `smith install <plugin>` — install plugin.
- `smith uninstall <plugin>` — uninstall plugin.
- `smith eval <prompt> [--json] [--session id]` — non-interactive eval.
- `smith rpc` — JSON-RPC via stdio; methods include `config/reload` (§9.19).
- `smith help [topic] [--search q] [--list] [--examples] [--example name] [--guide name]`.
- `smith replay <session> [--speed f64] [--compare] [--sandbox path]
  [--turns N] [--from-turn N] [--format text|json|summary] [--continue-on-diff bool]`.

Interactive slash commands are registered by Lua plugins, not clap subcommands.

### 10.3 Main

`main` uses tokio, parses clap, resolves config, creates `Harness`, dispatches to
interactive/eval/rpc/replay/session/plugin/help command handlers.

`smith-cli` restores terminal state on errors and signals.

## 11. Security Model

Trusted:

- user,
- OS/filesystem,
- local plugins,
- Smith code,
- session/config/cache files.

Untrusted:

- remote LLM,
- provider network response content.

Security mechanisms:

1. Tool registry controls which tools the LLM can invoke.
2. Secret proxy prevents real secrets from reaching LLM context.
3. Restricted Lua runtime removes raw OS/file APIs.
4. Users configure active tools; no confirmation-dialog security theater.

Credentials:

- environment vars preferred,
- plaintext config/auth file allowed,
- no keychain,
- no encryption.

## 12. Concurrency and Async

Threads/tasks:

- engine/main: owns harness event loop and agent state,
- UI thread: render/event polling, never blocks engine,
- tool thread pool: subprocess/file/plugin tool execution,
- provider async tasks: streaming HTTP.

Async boundary:

- `tokio` in `smith-ai`, `smith-core`, and harness orchestration,
- TUI rendering is sync on UI thread,
- tool execution runs off the UI thread.

Responsiveness:

- UI keypress acknowledged within 16ms,
- engine never blocks on UI,
- every long operation observes abort.

## 13. Performance Requirements

- Release binary < 20MB stripped.
- `smith --help` < 100ms.
- TUI frame draw < 2ms within 16ms frame budget.
- Session encode 1000 entries < 5ms.
- Agent loop turn target < 30s excluding provider/network stalls beyond timeout.
- Bench regressions >10% fail nightly/release gates.

## 14. Release Artifacts

Required targets:

| Platform | Triple | Status |
|----------|--------|--------|
| Windows x86_64 | `x86_64-pc-windows-msvc` | required |
| Windows ARM64 | `aarch64-pc-windows-msvc` | required |
| macOS Intel | `x86_64-apple-darwin` | required |
| macOS Apple Silicon | `aarch64-apple-darwin` | required |
| Linux x86_64 glibc | `x86_64-unknown-linux-gnu` | required |
| Linux ARM64 glibc | `aarch64-unknown-linux-gnu` | required |
| Linux x86_64 musl | `x86_64-unknown-linux-musl` | required |
| Linux ARM64 musl | `aarch64-unknown-linux-musl` | required |
| OpenBSD x86_64 | `x86_64-unknown-openbsd` | best-effort |

Artifacts:

- `smith-{triple}-v{version}.{zip|tar.gz}`,
- `checksums-sha256.txt`.

No install scripts, package manifests, distribution metadata, or code signing in v1.

## 15. xtask

Required commands:

| Command | Purpose |
|---------|---------|
| `check` | fmt + clippy + arch + pup + test + doc |
| `test` | all tests via nextest |
| `lint` | clippy + rustfmt check |
| `fmt` | auto-format |
| `fetch-providers` | generate `smith-ai/src/providers.json` |
| `doc-test` | run Lua `@usage`, guide blocks, examples |
| `verify-docs` | verify SDK/API docs completeness |
| `doc-gen` | generate man pages and docs bundle |
| `spec-verify` | verify SPEC links and project invariants |
| `arch` | stable architecture checks |
| `pup` | pinned-nightly cargo-pup gate |
| `print-modules` | module inventory: Cargo metadata crate roots + cargo-pup submodules |
| `audit` | cargo-deny + cargo-audit |
| `bench` | criterion benchmarks |
| `coverage` | tarpaulin coverage |
| `mutants` | cargo-mutants mutation testing |
| `release` | build archives and checksums |

xtask commands are thin orchestrators. No business logic.

## 16. Documentation

- `docs/SPEC.md` is the canonical spec.
- `docs/PROJECT-INVARIANTS.md` contains non-negotiable repository invariants.
- Design docs may expand implementation rationale but cannot contradict `SPEC.md`.
- SDK docs are generated from Lua `---@` annotations and `@usage` blocks.
- `smith help` reads embedded generated docs.

Documentation gates:

- every Rust SDK function has Lua binding docs,
- every Lua binding has annotations,
- every annotated function has usage,
- every event appears in at least one example,
- no documented function missing in code,
- no public SDK function undocumented.

## 17. Testing

### 17.1 Fast Tier

Every commit:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo run -p xtask -- arch
cargo +nightly-2026-01-22 pup
cargo nextest run --profile fast
cargo test --doc
```

Blocks push.

Scope:

- unit tests,
- property tests,
- TUI snapshots,
- serialization snapshots,
- doc tests,
- architecture gates.

### 17.2 Medium Tier

Every PR:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo run -p xtask -- arch
cargo +nightly-2026-01-22 pup
cargo nextest run --profile default
cargo test --doc
cargo tarpaulin --out Lcov
cargo nextest run --profile integration
cargo doc --workspace --no-deps
```

Blocks merge.

### 17.3 Slow Tier

Nightly + release:

```bash
cargo nextest run --profile thorough
cargo mutants --test-tool=nextest
cargo bench -- --baseline main
```

Blocks release if mutation score <80% or benchmark regression exceeds threshold.

### 17.4 Coverage Goals

| Crate | Target |
|-------|--------|
| `smith` | 100% |
| `smith-core` | ≥95% |
| `smith-ai` | ≥90% |
| `smith-tui` | ≥85% |
| `smith-harness` | ≥90% |
| `smith-cli` | ≥80% |

### 17.5 nextest

`.config/nextest.toml`:

```toml
[profile.default]
retries = 3
slow-timeout = "30s"
fail-fast = false

[profile.fast]
test-group = "fast"
retries = 0
fail-fast = true
slow-timeout = "5s"

[profile.integration]
filter = 'test(integration::) or test(cli::) or test(tui::)'
retries = 2
slow-timeout = "30s"

[profile.thorough]
retries = 1
slow-timeout = "120s"
```

### 17.6 Property Tests

Required property areas:

- CBOR session codec roundtrip,
- model resolver determinism and cycle detection,
- valid Lua config parsing,
- token estimator monotonicity,
- event-to-session-entry conversion,
- trace filtering preserves order.

Commit `proptest-regressions/`.

### 17.7 Snapshot Tests

Use `insta` + ratatui `TestBackend` for:

- widgets,
- layout composition,
- themes,
- CLI help,
- error formatting,
- config parse output,
- provider normalization.

CI runs with `INSTA_UPDATE=no`.

### 17.8 Integration Tests

Required integration coverage:

- CLI commands and flags,
- session create/resume/fork/dump/replay,
- plugin load/order/override/event dispatch,
- provider registry/custom provider/auth/mock streaming/MuxProvider failover,
- TUI startup/shutdown/capabilities/mouse/layout/theme/scroll,
- docs/help/search/examples.

Fixtures live under `tests/fixtures/` with plugins, sessions, configs, providers,
and traces.

### 17.9 Benchmarks

Criterion benchmarks:

- `session_encode_1000`,
- `session_decode_1000`,
- `widget_render_100`,
- `agent_loop_turn`,
- `config_resolve_3level`,
- `trace_filter_10000`,
- `plugin_load_10`.

## 18. Prototype Policy

Prototypes are disposable evidence for or against this spec. They live under
`prototypes/`, never in production crates. A prototype tests one claim or risk,
runs minimal commands, and reports whether the spec should change.

Prototype output must include:

- status,
- proved claims,
- disproved claims,
- spec issues with evidence,
- artifacts created,
- commands run,
- next spec/design actions.

Production code must not depend on prototype artifacts.
