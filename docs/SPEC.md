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
- **Pi is Smith's philosophical ancestor, not a dependency.** Smith improves
  on pi's ideas with no data or format coupling to it.
- **Exact at boundaries, shapes inside.** This spec is exact where others
  program against it — files, wire formats, CLI, config, Lua SDK — and
  shape-level (named types, behavior, properties) for internal Rust. Code
  blocks are illustrative unless a section says otherwise.

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
bumpalo = "3"
thiserror = "2"
anyhow = "1"
toml = "0.8"
regex = "1"
tokio-stream = "0.1"
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
  auth.json
```

Session files are plaintext length-prefixed CBOR sequences. Trace files are
compressed deterministic replay logs. Secrets in sessions are plaintext after
local registration (§6.7, §11).

## 5. Shared Crate: `smith`

`smith` owns shared types and utilities. It has no business logic and no
downstream dependencies.

Exposed surface (names, not module layout):

- the shared types of §5.1–§5.3 (IDs, messages, provider types, tool types:
  `AgentTool`, `AgentToolResult`, `AgentToolUpdate`, `ToolExecutionMode`),
- `StreamFn` (§5.4),
- `LuaRuntime` (§5.5),
- `Config` (§5.6),
- the model-resolution types (§5.7): `ModelAlias`, `ModelGroup`,
  `ProviderBucket`, `ModelResolver`, `ResolvedModel`, `ResolveError`,
- `SmithError` (§5.8).

`smith` must not re-export `smith-core` types. Domain types are imported from
their owning crates.

### 5.1 IDs and Messages

Required shared types:

- `EntryId(String)` — UUID v7, time-sortable.
- `SessionId(String)`.
- `SecretId(String)`.
- `VcsOpId(String)`.
- `Role`: `System`, `User`, `Assistant`, `Tool`.
- `ContentBlock` — the authoritative content representation:
  - `Text(String)`,
  - `Image { data, media_type }`,
  - `ToolCall { id, name, arguments (JSON) }`,
  - `ToolResult { id, result, is_error }`,
  - `Thinking { content, provider_metadata? }` — `provider_metadata` is opaque
    and preserved, never consumed by Smith; provider adapters attach it (e.g.
    thinking signatures) and replay it on later requests (§7.2), so signed
    thinking round-trips across turns.
- `Message { role, content: list of ContentBlock }`.

Roles say who speaks; entry kinds say what happened. Tool results are
`Tool`-role messages carrying `ToolResult` blocks — there is no tool-result
role. Events like user bash executions are `SessionEntry` kinds (§6.5), not
roles.

### 5.2 Provider Types

- `ProviderUsage` tracks input, output, cache read/write, and total tokens.
- `StopReason`: `EndTurn`, `ToolUse`, `OverMaxTokens`, `Aborted`, `StopSequence`, `Error`.
- `ThinkingLevel`: `Off`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`.
- `ProviderEvent`:
  - `TextDelta { text }`,
  - `ThinkingDelta { text }`,
  - `ToolCall { id, name, arguments }` — assembled and complete; partial
    argument chunks are joined at the provider boundary (§7.2),
  - `Done { usage, stop_reason }`,
  - `Error(ProviderError)`.
- `ProviderError` kinds — the failover-relevant classification consumed by
  `MuxProvider` (§7.5), each carrying a message: `RateLimit`, `AuthFailed`,
  `Network`, `ServerError`, `InvalidRequest`, `ModelNotFound`, `Timeout`.
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

The cascade is re-evaluated at runtime by host configuration reload (§9.19).

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
- cost,
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

`SmithError` is the shared error enum. It wraps the domain errors defined at
their subsystems: `ProviderError` (§5.2), auth (§7.4), tool errors including
the §9.12 codes, config validation (§5.6), Lua (§5.5), I/O, session/trace
codec (§6.6, §6.11), and model resolution (§5.7).

Recoverability is the load-bearing property of every error path:

- **Recoverable** (the default): the failure surfaces to the user and/or the
  LLM as content — error tool results (§6.4), UI notifications, plugin
  diagnostics (§9.17) — and the loop continues. Provider failures (§7.5),
  tool errors, plugin faults and OOM (§9.14, §9.17), and rejected config
  reloads (§9.19) are all recoverable.
- **Fatal**: the process cannot continue safely — unrecoverable terminal
  state, invalid startup config, providers exhausted in non-interactive eval.
  Fatal paths restore the terminal (§10) and exit nonzero with a diagnostic.

Shipped library code never panics for external failures; internal impossible
states use debug assertions.

## 6. Core Crate: `smith-core`

`smith-core` owns pure business logic: agent loop, sessions, tools, hooks,
secret proxy, compaction, cost, trace, and replay. It depends only on `smith`.

Responsibilities (names, not module layout): the agent loop (§6.1), agent and
engine events (§6.2–§6.3), hooks (§6.4), session model and format (§6.5–§6.6),
secret proxy (§6.7), system prompt (§6.8), compaction and cost (§6.9), tool
registry (§6.10), trace and replay (§6.11).

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

Blocked-call contract (prototype-proven, p07): a blocked tool call never
executes the tool, still emits `ToolExecutionStart` and `ToolExecutionEnd`
(with error flag and the block reason) so the UI can show it, and feeds the
block reason to the provider as an error tool result so the model can react.

`smith-harness` translates Lua plugin event returns into these core hook results.

### 6.5 Session Model

`Session` contains:

- `SessionId`,
- optional name,
- cwd,
- entries,
- current leaf,
- created/updated timestamps.

Sessions are branching trees. A branch is emergent, not stored: the path from
root to a leaf. `ctx.session.branch()` (§9.9) returns the current path.
"Immutable once created" means entries are append-only and never rewritten —
working from an older point creates a new child, never edits history. `/tree`
and history/time-travel features are Lua plugins over this core state.

Tree operations:

- **append**: adds an entry as a child of the current leaf; the leaf advances
  to it. Appending while the leaf sits on a non-leaf entry creates a fork
  point implicitly — there is no explicit branch operation.
- **switch leaf**: moves the current leaf to any entry, recorded by appending
  a leaf-switch metadata entry. On load, the effective leaf is the last
  leaf-switch entry's target, or the last appended entry if none exists —
  leaf state rides the §6.6 append-only recovery guarantees, and leaf history
  is replayable for free.
- **read path**: returns the root→leaf path. The LLM context is built from
  the current path only (through compaction, §6.9); sibling branches are
  invisible to the model.
- **fork**: clones entries up to a given entry into a new `SessionId` and
  session file (the `session_before_fork` event, §9.8). Distinct from in-tree
  branching, which stays in one file.

No branch deletion or pruning exists in v1. A session has a single writer:
one agent loop appends to it at a time.

Leaf switches never touch the working tree. Filesystem time travel is plugin
policy, not core behavior: the time-travel plugin (§9.11) pairs leaf switches
with `smith.vcs.op_restore` using the `VcsOpId` stored in entries.
Conversation navigation alone is never destructive.

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
- user bash execution (`!`/`!!` commands and their output),
- leaf switch (tree navigation),
- metadata entries needed for migration and replay.

Every entry has a stable `EntryId`, optional parent, and timestamp. New entry
kinds are forward-compatible by construction: readers preserve unknown
variants (§6.6), so adding a kind never breaks older sessions or readers.

### 6.6 Session Format

Session files are length-prefixed CBOR sequences:

```text
u32 BE len | CBOR entry bytes | u32 BE len | CBOR entry bytes | ...
```

Properties (recovery boundaries prototype-proven, p06):

- truncated tail stops parsing; prior entries survive,
- a corrupt entry BODY is precisely skippable with a warning — the intact
  length prefix bounds the damage,
- a corrupt LENGTH PREFIX desynchronizes framing: entries before it survive,
  everything after is unrecoverable and indistinguishable from truncation,
- unknown-vs-corrupt is decided by two-stage decode (raw CBOR, then typed):
  well-formed CBOR with an unknown variant tag is preserved raw and survives
  rewrite roundtrips; invalid CBOR is corrupt and skipped,
- `smith session dump` outputs JSONL,
- session discovery is keyed by canonical `{session-id}.session` filenames.

### 6.7 Secret Proxy

The secret proxy prevents LLM exposure of registered secrets. Smith provides
the masking mechanics only; secret *detection* mechanisms are out of scope
for core and belong to plugins.

**Registry.** The proxy holds a table of `SecretId → plaintext + label`.
Registration paths:

- automatic: every credential the auth resolver loads (§7.4) — provider keys
  can never enter context, even via a tool reading a config file,
- automatic: values of a plugin's `declared secrets` (§9.2) when read through
  the SDK,
- explicit: the built-in `/secret` command (§9.11),
- plugins: `smith.secret.register(value, label)` (§9.10). Detection plugins
  (pattern-based or otherwise) inspect content through the §9.8 `input` /
  `tool_result` hooks and register what they find; the mechanism is theirs,
  the mechanics are Smith's.

**Masking at ingestion.** Scanning is exact substring matching against
registered values — no heuristics in core. Content is masked to `smith:sec:N`
placeholders *before* it becomes a session entry. Plaintext exists in exactly
one entry kind: the secret-registration entry (preserved verbatim by
compaction, §6.9). The ingestion scan runs after plugin `input`/`tool_result`
hooks, so a value registered during those hooks is masked in the very content
that surfaced it. On resume, the table rebuilds by scanning session entries
backward for registration entries.

**Rehydration.** Placeholders turn back into plaintext at exactly one layer:
immediately before tool execution (subprocess and tool `execute`, Rust and
Lua alike). Session content, provider requests, traces, and events carry
placeholders only. Replay with compare (§6.11) re-executes tools and
therefore rehydrates from the session's registration entries; trace files
themselves stay masked. A placeholder whose ID is not registered passes
through untouched — never rehydrated, never an error.

**Display.** The TUI renders placeholders masked with their label
(`‹secret: github-token›`); display matches context content. The local user
can recover plaintext from registration entries via `smith session dump`.

**Limits.** An unregistered secret is not protected — by design. The
protection target is the remote LLM; the trust model is §11's, and core does
no best-effort guessing.

### 6.8 System Prompt

`SystemPromptBuilder` composes:

- base identity,
- active model/tool capabilities,
- plugin prompt contributions,
- project/context facts,
- safety and tool-use instructions,
- user overrides.

Plugins may transform prompts through typed hooks. No hidden global prompt mutation.

The system prompt bootstraps SDK self-learning: it teaches the agent to
discover plugin/SDK capabilities through `smith help --search`, `--guide`, and
`--example` (§10.2) instead of embedding the full SDK reference inline.

### 6.9 Compaction and Cost

Compaction never rewrites history. Entries are append-only (§6.5), so
compaction is a mask applied at context-assembly time, not a storage
mutation:

- **Storage never shrinks.** The session file keeps every entry verbatim;
  memory stays bounded by lazy loading (§13.1).
- **A compaction pass appends a summary entry** to the current path,
  recording the covered span (from/to `EntryId`), the summary text, and
  before/after token estimates.
- **Context assembly folds the path** (§6.5 read path): spans covered by a
  summary entry collapse into the summary; trim-masked content collapses
  into stubs. What the model sees is the folded path; the file is untouched.

Because the summary rides the path like any entry, branching needs no
special case: switching the leaf to a pre-compaction entry yields a path
without the summary — full history visible again, eligible to re-compact —
and branches created after the compaction point inherit the mask.

Trigger: before each provider request, when the estimated folded-path tokens
exceed the configured threshold — by default a fraction of
`AgentLoopConfig.model_metadata.context_window` minus the output-token
reserve. The threshold is a named config key (§5.6; reloadable per §9.19).

Trim ladder, cheapest first, repeated until the context fits or the
configured iteration limit is reached:

1. mask old tool-result bodies to stubs (dominant bytes per the memory
   profile),
2. mask old thinking blocks,
3. LLM-summarize the oldest span. Summarization uses the active model unless
   the `compaction_model` config key selects another (resolved via §5.7, so
   aliases/groups work); its usage is tracked as normal cost.

Survives verbatim, always:

- secret registrations (§6.7),
- the system prompt snapshot,
- existing compaction summary entries,
- the recency window: the most recent entries up to a configured fraction of
  the context window (token-budget based, so it adapts to model size).

`session_before_compact` (§9.8, blockable) may veto the round, adjust the
span, or replace the summarization prompt; `session_compact` reports the
result.

Token estimator:

- v1 heuristic: chars/4,
- exact tokenizer is not required in core.

Cost tracking:

- consumes `ProviderUsage`,
- multiplies by `ModelMetadata.cost`,
- tracks input/output/cache tokens and running total.

### 6.10 Tool Registry

`ToolRegistry` stores shared, thread-safe `AgentTool` handles by name.

Rules:

- duplicate registration follows harness plugin precedence,
- arguments are JSON-schema validated,
- final tool errors become tool-result content for the LLM,
- transient failures may retry according to tool policy.

### 6.11 Trace and Replay

Trace files capture deterministic replay data:

- file header with magic/version/session ID,
- compressed entries via zstd — per-entry compression inflates small traces
  (p11 evidence, `prototypes/PLAN.md`), so the codec uses block-level
  compression or a minimum entry-size threshold; small traces never exceed
  their uncompressed size,
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

`Provider` is thread-safe and object-safe (usable as a trait object without
async-trait machinery — a prototype-verified property). It exposes:

- identity: id and display name,
- auth validation, failing fast before the first stream (§7.4),
- `stream`: takes a `ProviderRequest`, returns a boxed async stream of
  `ProviderEvent` — a plain method returning a stream, not an async method.

`provider_to_stream_fn` adapts a shared `Provider` handle into the `StreamFn`
consumed by `smith-core`.

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
- thinking/reasoning fields (reasoning text may arrive inside `content` before
  the final answer on some OpenAI-compatible endpoints),
- provider-specific stop reasons,
- cache usage fields,
- model capability flags.

Error detection: some providers return errors as plain JSON bodies with
HTTP 200 instead of SSE (prototype-proven against a live OpenAI-compatible
endpoint). A provider implementation must detect a non-streaming JSON error
body on a streaming request and convert it to `ProviderEvent::Error` — never
hang waiting for SSE frames that will not come.

### 7.3 Model Registry

`providers.json` is bundled in `smith-ai/src/providers.json`. That checked-in
file is authoritative at runtime.

`fetch-providers` is a bootstrap and maintenance aid, not an automatic truth
source:

```bash
cargo run -p xtask -- fetch-providers
```

Data source priority for generated suggestions:

1. models.dev (`https://models.dev/api.json` — the open, community-maintained
   model database with a CI-validated schema),
2. catwalk provider configs,
3. later shared provider repositories after review.

Merge rule (prototype-proven, p05):

- merge by provider/model ID at LEAF-FIELD granularity — a recursive
  field-level merge; subtree or whole-model replacement would clobber curated
  registry values (e.g. structured cost objects),
- models.dev primary,
- catwalk fills gaps (missing field, missing model, missing provider),
- unknown provider fields are preserved for forward compatibility but ignored
  by v1. Preservation is semantic (value-equal), not byte-for-byte — default
  JSON tooling reorders keys. Unknown fields must never appear in generated
  diffs.

Conflict policy: some conflicts cannot be auto-merged and are excluded from the
suggestion and reported explicitly, at minimum:

- ambiguous-primary-source: the primary source lists the same model ID twice
  with differing metadata,
- type-mismatch-vs-curated: a source proposes a value whose structure differs
  from the hand-curated registry value (curated value kept).

`fetch-providers` exits non-zero while unresolved conflicts remain, so PR
automation can never auto-merge a corrupting suggestion. Its outputs are the
suggested file, a reviewable source-attributed patch, and a machine-readable
conflict report.

`replace_models` is a plugin provider-override flag (`smith.provider.*`,
§9.10), not a `fetch-providers` merge input.

**Canonical schema.** Smith does not invent a provider/model schema — it adopts
the models.dev shape and keeps a pinned local snapshot: a JSON Schema at
`smith-ai/src/providers.schema.json`, translated from the models.dev schema at
a recorded upstream version. Local pinning keeps validation deterministic and
offline; upstream schema evolution is reviewed like any dependency bump.

The snapshot is validated with the `jsonschema` workspace crate at three
boundaries:

1. `fetch-providers` source data after normalization — a source value that
   fails the schema is a validation error at the source boundary, not a merge
   conflict,
2. the checked-in `providers.json` (CI gate),
3. provider tables passed to `smith.provider.register` at runtime (§9.10).

Registry shapes follow models.dev naming: `cost` (USD per million tokens:
`input`, `output`, `cache_read`, `cache_write`, optionally `reasoning` and
audio variants), `limit` (`context`, `input`, `output`), modalities
(`input`/`output` type lists), and capability flags (`attachment`,
`reasoning`, `tool_call`, `structured_output`, `temperature`). `cost` is
always an object — never a scalar (the p05 type-mismatch class). Unknown
fields remain schema-legal (`additionalProperties` allowed) per the
preservation rule above.

Mapping into `ModelMetadata` (§5.7):

| §5.7 field | models.dev source |
|------------|-------------------|
| context window | `limit.context` |
| max output tokens | `limit.output` |
| cost | `cost` |
| thinking | `reasoning` |
| vision | `"image"` in `modalities.input` |
| tool use | `tool_call` |
| streaming | assumed true; provider config may disable |

`structured_output`, `temperature`, and `attachment` are not represented in v1
`ModelMetadata` and are preserved, not consumed.

Provider config correctness cannot be fully automated because Smith does not
have all provider accounts, subscriptions, API keys, or regional access.
Generated changes require review before commit.

### 7.4 Auth

Auth resolver sources:

- environment variables,
- `config_dir/smith/auth.json` (§4),
- plaintext Lua config values when explicitly supplied.

No OS keychain. No encryption.

Auth errors fail fast before first provider stream.

Auth methods per provider are declared in the registry's `auth_types` map:
`api_key` (with its `env_var` name), `oauth`, and `organization` (org-scoped
key, e.g. OpenAI: api key + org ID). `AuthMethod` mirrors these three.

`auth.json` is a per-provider object map:

```json
{
  "anthropic": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1234567890
  }
}
```

OAuth module supports mocked OAuth flow in tests and provider-specific OAuth
where configured. OAuth per provider is configured with `id`, `name`,
`auth_url`, `token_url`, `scope`, and `client_id`; credentials are
`access_token`, `refresh_token`, `expires_at` (Unix seconds), auto-refreshed on
expiry. The login flow surfaces the auth URL to the user, receives the code via
a local callback HTTP server on a random port (or manual paste), exchanges it
for credentials, and persists them to `auth.json`.

### 7.5 MuxProvider

`MuxProvider` wraps multiple providers/accounts for resolved groups and buckets.

Behavior, keyed by the `ProviderError` kinds (§5.2):

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

Probe contract:

- capabilities are probed once per session at startup, with a 100ms timeout
  per probe; on timeout the capability is treated as absent (fail
  conservative),
- image protocol is `ImageProtocol::{Kitty, Sixel}`; the capability is
  detected but has no v1 consumer — inline image rendering is deferred
  (§8.11),
- Kitty keyboard protocol flags are pushed on TUI startup and popped on
  shutdown (including error/signal paths, §10),
- synchronized output (`CSI ?2026 h/l`) wraps render passes when the terminal
  supports it.

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

Syntax highlighting uses `syntastica` with the `runtime-c2rust` runtime (no C
runtime dependencies; prototype-proven). Diffs use `similar` and support
unified and side-by-side modes. Fuzzy matching uses `fuzzy-matcher`.

Overlays (modals, fuzzy search, autocomplete) are positioned by an anchor
model: nine anchors (`Center`, four corners, four edge-centers) plus
`offset_x`/`offset_y` and optional margin; overlay `width`/`max_height` are
`Size::Absolute(cells)` or `Size::Percent`.

### 8.7 Layout

Rust provides primitives; Lua defines layout.

Primitives and their shapes:

- `column` / `row`: child list, stacked vertically/horizontally,
- `box`: single child, optional `width`/`height` (`Size`), optional border
  (`BorderStyle::{Single, Double, Rounded, Thick, None}` + optional title),
- `expanded`: single child, takes remaining space after fixed siblings,
- `scrollable`: single child, direction vertical/horizontal/both,
- `overlay`: single child + overlay options (§8.6 anchor model),
- `spacer`: optional fixed `Size`,
- `tabs`: labeled child list + active index,
- `split`: two children, horizontal/vertical, `split_ratio: f32`.

One predefined border layout exists: center + north/east/south/west panels,
each panel carrying `visible`, `size`, and its own layout. Panels are invisible
when empty. Default layout is a Lua plugin.

### 8.8 Theme

Themes are Lua tables validated by Rust schemas (prototype-proven, p08).

Theme values cover status bar, messages, assistant content, tool call/result,
errors, input, borders, selections, diffs, syntax groups, and accents.

Schema contract:

- The Rust schema defines the required key set and nesting; every section above
  is a named table of color/style values.
- Colors are `#rrggbb` strings. Named/ANSI-indexed colors are not part of the
  v1 schema.
- A missing required key or malformed value is a validation error carrying the
  exact key path (e.g. `theme.status_bar.fg: expected "#rrggbb"`). Unknown keys
  warn.
- A user theme that fails validation at runtime does not abort Smith: it falls
  back to the built-in default theme with a visible warning naming the path
  error.

### 8.9 Virtual Scroll

Message history uses virtual scrolling. `sticky_bottom` defaults true and turns
false when user scrolls up. New content does not move viewport until user returns
to bottom or submits input.

### 8.10 Tool Rendering

Tools may register `renderCall` and `renderResult` Lua renderers. TUI receives
structured render instructions from harness, not arbitrary terminal writes.

### 8.11 Deferred Scope (v1)

Explicitly out of v1 TUI scope:

- vim-style normal-mode editing,
- inline image rendering (Kitty graphics protocol),
- split-pane resizing (the `split` primitive exists; interactive resize does
  not),
- multiple simultaneous sessions.

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

Every plugin has a mandatory Lua manifest file named `smith-plugin.lua` in the
plugin root. Plugin authors create it. Manifest loading uses a restricted
manifest environment — an empty Lua environment with no globals, no Smith SDK,
and no host I/O — so the chunk can only build and return a pure data table.
A manifest that reaches for `os`/`require`/any global, or that contains
function values, is rejected (prototype-proven, p04).

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
- `heap_limit` (bytes, §9.14),
- `interfaces` — list of interface names this package exports descriptors for
  (§9.6),
- `implements` — list of interface names this package implements (§9.6).

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

- resolves the source into a temporary staging area,
- reads and validates the manifest, namespace, and API compatibility in
  staging — a rejected plugin never touches the plugins root,
- copies into `data_dir/smith/plugins/<org>/<name>/` only after validation,
- refuses duplicates unless `--force`,
- does not run plugin entry code during install (prototype-proven, p04).

Install semantics:

- A duplicate is defined as: the destination directory
  `data_dir/smith/plugins/<org>/<name>/` already exists, regardless of version.
- `--force` is full replacement: remove the old plugin directory, then place the
  new one. Plugin data under `data_dir/smith/data/<org>/<name>/` survives a
  forced reinstall.
- Git installs strip the `.git` directory: an installed plugin is a pure file
  snapshot, not a working clone. Updates go through reinstall.

Git URL installs go through Smith's internal git boundary; the concrete
implementation (`gix` or system-git shell-out) is release engineering's choice,
hidden behind the boundary (p04 evidence, `prototypes/PLAN.md`).

`smith uninstall <org>/<name>`:

- removes installed plugin code,
- keeps plugin data by default,
- supports `--purge-data` to remove `data_dir/smith/data/<org>/<name>/`,
- never removes project plugins.

### 9.6 Plugin Interface Modules

Interfaces are plain Lua descriptor tables validated at runtime. This design is
prototype-proven (p02, p03); the typed-Lua (Teal) and annotation-schema
candidates are rejected.

**Why Teal is rejected.** Teal's compile-time guarantees evaporate at the
runtime boundary: Smith embeds LuaJIT, so Teal ships as compiled Lua and the
host must re-validate conformance regardless — Teal would be additive toolchain
cost, not a replacement for runtime descriptors. Making official interfaces
Teal-authored would also split the ecosystem into typed and plain-Lua authors,
the exact fragmentation §9.6 exists to prevent. The authoring-time typing Teal
would provide is delivered instead by LuaLS annotations (below and §9.10)
without a compile step.

**Generated typing.** Interface descriptors mechanically generate LuaLS stub
files (`---@class`/`---@field`/`---@param` annotations derived from the
descriptor's `functions` table) as part of `cargo run -p xtask -- doc-gen`.
Plugin authors targeting an interface get editor-time type checking against
the same descriptor the runtime validates — one source of truth, two
enforcement points.

**Descriptor.** An interface package exports a descriptor: a pure data table
with `name` (`<org>/<name>`), `generation` (integer — the interface's own
version, distinct from the plugin API generation of §9.3 and the reload domain
generation of §9.16), `functions` (map of function name → `{ params, returns }`
with typed, optionally-optional named parameters), and `events` (list of bus
topics, §9.18).

**Ecosystem shapes.** Interface-only packages, implementation-only packages,
implementations referencing external interfaces, and combined packages are all
supported through two manifest fields (§9.2): `interfaces` (list of interface
names this package exports descriptors for) and `implements` (list of interface
names this package implements).

**Adapters.** An adapter is an implementation package whose entry exports
`adapts = "<org>/<name>"` (the wrapped plugin) plus a `make(wrapped)` factory
returning a conforming implementation. The plugin manager injects the wrapped
plugin's exports into `make`.

**Binding.** User config selects the implementation backing an interface:

```lua
interfaces = { ["community/subagent"] = "org/name" }
```

Binding precedence: explicit config binding, else the last-loaded plugin
declaring `implements` for that interface (§9.7 order). Conformance is checked
at bind time. A conformance failure names the plugin, interface and generation,
every missing/mis-shaped export with its exact path, the exports the plugin
actually provides, and any installed adapter for it.

**Views.** Consumers receive an interface view: only declared functions are
visible (implementation-private fields are hidden), and arguments are validated
against the descriptor at call time with errors naming function and parameter.
A resolved binding is a singleton: all consumers of an interface share the one
bound implementation instance.

### 9.7 Plugin Precedence

Load order:

1. built-in plugins,
2. global user plugins,
3. project plugins,
4. explicit CLI/config overrides.

Later registrations override earlier ones unless registration marks duplicate as
an error.

### 9.8 Event Bridge

Lua receives event tables with a `type` field. The canonical event catalog and
per-event blocking capability:

| Event | Can block | Notes |
|-------|-----------|-------|
| `resources_discover` | No | contribute skill/prompt/theme paths |
| `session_start`, `session_shutdown` | No | started/loaded/reloaded; shutting down |
| `session_before_switch` | **Yes** | before switching sessions |
| `session_before_fork` | **Yes** | before forking/cloning |
| `session_before_compact` | **Yes** | can customize compaction |
| `session_compact`, `session_tree` | No | completed notifications |
| `before_agent_start` | No | may inject messages, modify system prompt |
| `agent_start`, `agent_end`, `turn_start`, `turn_end` | No | lifecycle |
| `model_select` | No | model changed |
| `message_start`, `message_update`, `message_end` | No | streaming lifecycle |
| `thinking_delta`, `text_delta` | No | token deltas |
| `tool_execution_start` | No | execution began or call was blocked (§6.4) |
| `tool_call` | **Yes** | before tool executes (§6.4 blocked-call contract) |
| `tool_execution_update`, `tool_result`, `tool_execution_end` | No | `tool_result` may modify the result |
| `input` | No | may intercept/transform/mark handled |
| `user_bash` | No | user `!`/`!!` commands |
| `context` | No | may modify messages before LLM call |
| `before_provider_request`, `after_provider_response` | No | inspect/replace payload; response received |
| `config_changed` | No | §9.19, carries changed key paths |
| `plugin_loaded`, `plugin_unloaded` | No | plugin lifecycle |
| `panel_toggle`, `resize` | No | TUI |
| `provider_registered` | No | after provider add/override |
| VCS events | No | §9.13 operations |
| errors | No | §9.17 |
| shutdown | No | host shutdown (§10, §12) |

Handler return-table contracts (Lua-facing, one per §6.4 hook capability):

- `tool_call` → `{ block = true, reason = "..." }` or
  `{ args = <replacement> }` or `{ cancel = true }` or nil/`{}` (allow),
- `tool_result` → `{ content = <replacement> }` or `{ retry = true }` or
  `{ cancel = true }` or nil (keep),
- `turn_end` → `{ stop = true }` to end the agent loop after this turn
  (ShouldStopAfterTurn), or nil (continue),
- `input` → `{ action = "handled" | "continue", text = <transformed>? }`,
- `context` → `{ messages = <modified> }` or nil,
- `session_before_*` → `{ block = true, reason = "..." }` or nil,
- all other events: return value ignored.

The bridge maps these into `AgentLoopConfig` hooks (§6.4).

### 9.9 Extension Contexts

SDK contexts:

- `ExtensionContext`: agent lifecycle, model, context, tools, config, logging.
- `ExtensionCommandContext`: slash command args, selection, output, session.
- `ExtensionUIContext`: selection, confirm, prompt, status, layout, widget APIs.

The `ctx` table passed to event handlers, tool `execute`, and command handlers
has this shape:

```lua
ctx = {
  ui = {
    notify = function(message, level) end, -- "info"|"success"|"error"|"warning"
    confirm = function(title, message) end,      -- -> bool
    select = function(title, items) end,         -- -> chosen item
    input = function(title, placeholder) end,    -- -> string
    set_status = function(key, text) end,
    set_widget = function(key, lines) end,
  },
  session = {  -- read-only
    id = "...", name = "...",
    entries = function() end,      -- -> table
    entry_count = function() end,  -- -> number
    branch = function() end,       -- -> table
  },
  model = { id = "...", provider = "..." },
  cwd = "/path/to/project",
  signal = AbortSignal,
  shutdown = function() end,
}
```

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
- `smith.secret.*` (`register(value, label)`, `list()` — labels/ids only,
  never plaintext; §6.7),
- `smith.shortcut.*` (keyboard shortcut registration),
- `smith.credentials.*` (`get(provider)`/`set(provider, value)` over the §7.4
  auth store),
- `smith.active_tools.*` (`get()`/`all()`/`set(names)`),
- `smith.send_message(text, { deliver_as = "steer" | "followUp" })` and
  `smith.send_user_message(text)`,
- `smith.abort()`,
- `smith.shutdown()`,
- `smith.getContextUsage()`.

Core registration shapes:

```lua
smith.tool.register({
  name = "my_tool",
  description = "shown to the LLM",
  parameters = { --[[ JSON-schema table, validated per §5.3 ]] },
  execute = function(input, ctx)
    return { content = { { type = "text", text = "..." } } }
  end,
})

smith.command.register("name", {
  description = "...",
  autocomplete = function(prefix) end, -- optional -> { {value, label}, ... }
  handler = function(args, ctx) end,
})

smith.shortcut.register("ctrl+shift+p", {
  description = "...",
  handler = function(ctx) end,
})
```

`smith.provider.register(name, table)` merges into an existing provider or adds
a new one. Merge rules: `base_url`/`api_key`/`api` override; `headers` merge
per-key; `oauth` replaces whole; `models` merge by ID field-by-field (same
rules recursively); omitted fields keep existing values; `replace_models =
true` drops all existing models first. `smith.provider.unregister(name)` and
`smith.provider.unregister_model(provider, model_id)` remove entries. All
tables are validated against the §7.3 schema.

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
  `/secret` (§6.7), replay/time-travel,
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

Behavior (ordering is the contract):

1. read the file (`ENOENT`),
2. validate: non-empty `old_text`, non-binary content (`EEMPTY`, `EBINARY`),
3. count exact matches: zero fails; multiple fails unless `allow_multiple`
   (`ENOMATCH`, `EMULTI`),
4. re-read and hash immediately before write; fail if the file changed
   (`ESTALE`),
5. write atomically via temp file + rename (`ELOCK`),
6. return change count and before/after hashes.

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

Smith uses jj internally for operation-level undo/redo/time travel. jj is
driven through the same kind of internal boundary as §9.5's git installs: the
concrete integration (`jj-lib` crate or jj binary shell-out) is release
engineering's choice, hidden behind `smith.vcs.*`.

State:

- actual `.jj` lives under `data_dir/smith/vcs/{project-hash}/jj-state`,
- project root contains only `.jj` symlink,
- colocated git repos rewrite jj `git_target` to absolute `.git` path.

Plugins interact only through `smith.vcs.*`.

`smith.vcs.*` exposes:

Read-only queries:

```lua
smith.vcs.status()               -- { modified={}, added={}, deleted={}, renamed={} }
smith.vcs.diff(opts)             -- { hunks={}, text="..." }
smith.vcs.diff_revs(a, b)        -- diff between revisions/operations
smith.vcs.op_log({ limit = n })  -- { { id, description, time, op_type } }
smith.vcs.op_show(op_id)         -- { id, description, diff, files }
smith.vcs.annotate(path, opts)   -- line attribution data
smith.vcs.interdiff(a, b)        -- patch-vs-patch comparison
smith.vcs.evolog(rev)            -- logical change evolution
```

Mutations (explicit, validated inputs):

```lua
smith.vcs.commit(message)
smith.vcs.undo()
smith.vcs.redo()
smith.vcs.op_restore(op_id)
smith.vcs.restore_paths(paths, rev)
smith.vcs.split(opts)
smith.vcs.squash(source, dest)
smith.vcs.parallelize(revs)
smith.vcs.sparse(paths)
smith.vcs.workspace_add(name, opts)
```

Lua receives stable smith-shaped tables; jj/gix implementation details never
leak through this surface.

`gix` is used only for targeted structured queries behind `smith.vcs.*`.

### 9.14 Sandbox

Plugins are trusted but constrained to Smith SDK APIs:

- no raw `io`, `os`, or `debug`,
- filesystem/env access only through SDK,
- no path capability system in v1,
- built-in and user plugins use same API.

**Heap limit.** A plugin may be given a Lua heap limit via the optional
`heap_limit` manifest field (§9.2) or config override; when both are set, the
config override wins (§5.6 cascade: user config over plugin contributions).
Prototype-proven (p10, p11) semantics:

- The limit's domain is the plugin's own Lua state — one `mlua::Lua` per
  plugin (matching the §9.16 domain model). Per-plugin limits in a shared Lua
  state are not attributable and are not offered.
- Enforcement is `Lua::set_memory_limit()`; under the locked vendored-LuaJIT
  feature set this enforces exactly, and breach surfaces as a recoverable
  memory error handled by the §9.17 error model. Targets where mlua reports
  memory control as unavailable must fail heap-limit configuration loudly,
  never enforce silently at zero; per-target enforcement is CI-verified.
- The limit covers the plugin's Lua heap only, including host-created Lua
  values. Host-side Rust allocations held for a plugin are invisible to it
  and are bounded by domain teardown (§9.16) instead.
- After a plugin OOM, the preferred recovery is whole-domain replacement
  (§9.16) rather than in-place retry.

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

Nothing plugin-owned may outlive its domain. Registrations are keyed by domain
generation so teardown removes them deterministically. A callback, task, or
subscription that escapes its domain is a reload defect; the loader rejects
registrations that cannot be tied to the domain.

**Callback discipline** (prototype-proven, p11): plugin callbacks are reachable
exclusively through the generation-keyed registry. The host never clones or
stashes a raw callback handle outside it — invoking a raw `mlua` function after
its domain dropped is an unrecoverable panic, not a catchable error. Every
dispatch path (hook, tool, command, bus) checks the callback's domain generation
against the active set before touching any Lua value; stale generations are
rejected with a diagnostic and the callback does not run. An audit sweep over
the registries (anything registered under a non-active generation) is the
loader's escape-detection mechanism.

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
   and scratch memory. Repeated reloads must plateau in live memory after
   warmup; no stale callback from `D` may run after the swap. The plateau is
   the enforceable observable — an instantaneous RSS decrease per teardown is
   not required, since small freed heaps are legitimately retained by the
   allocator for reuse (p11 evidence, `prototypes/PLAN.md`).

**Rollback.** Reload is all-or-nothing. Either `D'` fully replaces `D`, or `D`
remains and no partial state from `D'` survives. A failed reload never leaves the
plugin unregistered.

**Session continuity.** Reload does not reset the session. Session entries, agent
state, and other plugins' state are untouched. In-flight tool executions from the
old domain run to completion under `D`; their results are still delivered. New
invocations after the swap use `D'`.

**Interface bindings.** If the reloaded plugin backs an interface binding
(§9.6), the swap re-resolves the binding to `D'` and re-runs bind-time
conformance against it. Consumers' interface views rebind transparently — the
next call through a view dispatches into `D'`. A conformance failure is a
reload failure: rollback keeps `D` and its binding active.

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

**Scope.** A host reload re-evaluates config cascade layers 1–4 (§5.6). CLI
flags (layer 5) are per-invocation: resolved at process start, they continue to
override the reloaded layers unchanged.

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
- `smith completions <shell>` — generate shell completions (`clap_complete`).
  The full method catalog is deferred: it is expected to mirror the Lua SDK
  surface (§9.10), with mode-specific additions and omissions, rather than
  define an independent API.
- `smith help [topic] [--search q] [--list] [--examples] [--example name] [--guide name]`.
  Topics support dotted function addressing: `smith help tool.register`
  resolves the `register` entry within the `tool` topic.
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

1. Tool registry (§6.10) controls which tools the LLM can invoke.
2. Secret proxy (§6.7) prevents real secrets from reaching LLM context.
3. Restricted Lua runtime (§5.5) removes raw OS/file APIs.
4. Users configure active tools; no confirmation-dialog security theater.

Credential storage follows §7.4: plaintext, no keychain, no encryption.

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
- Bench regressions fail nightly/release gates (thresholds in §17.9).

### 13.1 Memory Policy

Prototype-proven against the measured session corpus (p09; see
`docs/research/SMITH-MEMORY-ALLOCATION-PROFILE.md`):

- **Session discovery is lazy and metadata-only.** Discovery reads session
  headers, never full bodies: O(session count), not O(corpus bytes).
- **Virtual scroll materializes at most viewport rows per frame.** Row
  formatting stops at the visible window (lazy wrap); a single multi-MiB
  message must not be fully formatted to render its visible slice.
- **Arenas are scratch-only.** `bumpalo` is permitted solely for phase-local
  render/request scratch in measured hot paths. Persisted and session data use
  stable IDs and owned strings — never arena references. No custom or unsafe
  arena code. Arena references never cross async, thread, or persistence
  boundaries.
- **Keep/drop gates for arena use** weigh allocator-call pressure, elapsed
  time, and peak/plateau stability — not allocation count alone. Render-frame
  scratch is a clear win; request-build scratch is marginal — arenas are not a
  latency win where serialization dominates (p09 measurements,
  `prototypes/PLAN.md`).
- **Provider request assembly** at compaction-scale contexts has a transient
  peak of a small multiple of the serialized request size and must release it
  fully after send; peak memory (not just CPU) is a test gate.

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
- No standing design docs: subsystem design content lives in this spec. Any
  future exploratory design doc is non-canonical and cannot contradict
  `SPEC.md`.
- SDK docs are generated from Lua `---@` annotations and `@usage` blocks.
- `smith help` resolves docs in order: (1) embedded in the binary via
  `include_str!`, (2) install directory `<prefix>/share/smith/docs/`,
  (3) `SMITH_DOCS_PATH` environment override (development). First hit wins.

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

Every PR: the fast tier (§17.1, with `--profile default` instead of `fast`),
plus:

```bash
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

Overall workspace coverage target is 85%; merges are blocked below 80%.

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

[profile.ci]
fail-fast = false
retries = 2
slow-timeout = "60s"
# supports --partition for sharded CI runs
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

Snapshot contract (prototype-proven, p08): widget and theme snapshots serialize
styled cells — symbol plus fg/bg/modifier per cell — not buffer text alone.
Text-only snapshots cannot catch theme regressions: a theme swap changes styles
while leaving text byte-identical. Text-only snapshots are permitted only for
layout-only assertions.

### 17.8 Integration Tests

Required integration coverage:

- CLI commands and flags,
- session create/resume/fork/dump/replay,
- plugin load/order/override/event dispatch,
- provider registry/custom provider/auth/mock streaming/MuxProvider failover,
- TUI startup/shutdown/capabilities/mouse/layout/theme/scroll,
- interactive PTY smoke tests via `expectrl` (real terminal I/O paths),
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

Regression thresholds per benchmark: >5% warns, >10% fails the nightly gate
(§13).

### 17.10 Continuous Integration

Test hermeticity — CI tests never touch real external state:

- providers are mocked (`StreamFn` fakes; no network),
- TUI renders through `TestBackend` (no TTY),
- filesystem via temp dirs,
- clock and randomness injected (mock clock, fixed seeds),
- tests requiring real network live behind a `network-tests` feature and never
  run in the default CI lane.

Gate tiers by context:

| Context | Gate |
|---------|------|
| every agent iteration | fast tier (§17.1) |
| before merge | fast + medium tiers (coverage gate included, §17.4) |
| CI only | slow tier, mutation, benchmarks |

Agent CI-safety rules (binding for any coding agent working on Smith):

- never auto-merge,
- never modify CI configuration to make a run pass,
- never modify or delete tests to make them pass,
- never skip tests to get green.

Android/Termux (`aarch64-linux-android`) is a supported development
environment, not a release target (§14): CI keeps a validation lane that
smoke-builds vendored LuaJIT and syntastica for it; breakage there blocks
source-compatibility fixes, not artifact publishing.

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

The p02–p11 validation campaign (2026-07-14, x86_64-linux, rustc 1.94.1) ran
all ten prototypes to completion; result blocks live in `prototypes/PLAN.md`.
Sections marked "prototype-proven" in this spec cite that evidence.
