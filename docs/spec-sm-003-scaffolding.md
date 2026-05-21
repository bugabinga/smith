# SM-003: Project Initialization + Scaffolding

Create the Cargo workspace, jj repo, directory structure, and xtask build tooling.

## Context

No Rust code exists yet. This task creates the entire project skeleton that all
subsequent tasks (SM-005 through SM-012) build upon.

## Deliverables

### 1. jj Repository

```bash
jj init --git smith
cd smith
```

### 2. Workspace Cargo.toml

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
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
license = "Apache-2.0"

[workspace.dependencies]
# Lua
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
mlua-pkg = "0.2"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"
minicbor = { version = "0.25", features = ["derive"] }

# Async
tokio = { version = "1", features = ["full"] }
futures = "0.3"

# HTTP (for smith-ai)
reqwest = { version = "0.12", features = ["json", "stream"] }

# CLI
clap = { version = "4", features = ["derive"] }

# TUI
crossterm = "0.28"
unicode-width = "0.2"
unicode-segmentation = "1"

# Auth
oauth2 = "4"
url = "2"

# Utilities
uuid = { version = "1", features = ["v7"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# Testing
insta = "1"
```

### 3. Crate Skeletons (stub only — compile but empty)

Each crate gets:
- `Cargo.toml` with dependencies
- `src/lib.rs` (or `src/main.rs` for smith-cli) — empty, just `pub mod` stubs
- Compiles with `cargo check`

```
smith/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── types.rs       — pub struct stubs
│   ├── stream.rs      — StreamFn type alias
│   ├── tool.rs        — AgentTool trait stub
│   ├── lua.rs         — LuaRuntime stub
│   ├── config.rs      — Config stub
│   └── error.rs       — SmithError enum

smith-core/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── agent.rs       — Agent/AgentEvent stubs
│   ├── session.rs     — Session stub
│   ├── session_format.rs
│   ├── tools.rs       — ToolRegistry stub
│   ├── hooks.rs
│   ├── events.rs      — EngineEvent stub
│   ├── secret_proxy.rs
│   ├── system_prompt.rs
│   └── compaction.rs

smith-ai/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── provider.rs    — Provider trait stub
│   ├── stream.rs      — provider_to_stream_fn
│   ├── model_registry.rs
│   ├── auth.rs
│   ├── oauth.rs
│   ├── anthropic.rs
│   ├── openai.rs
│   ├── google.rs
│   └── config.rs
└── providers.json     — empty placeholder

smith-tui/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── component.rs   — Component/Focusable traits
│   ├── layout.rs      — Layout enum stub
│   ├── border_layout.rs
│   ├── theme.rs       — Theme stub
│   └── widgets/
│       ├── mod.rs
│       ├── text.rs
│       ├── input.rs
│       ├── editor.rs
│       ├── markdown.rs
│       ├── select_list.rs
│       ├── settings_list.rs
│       ├── loader.rs
│       ├── image.rs
│       ├── fuzzy_filter.rs
│       ├── overlay.rs
│       └── virtual_scroll.rs

smith-harness/
├── Cargo.toml
├── src/
│   ├── lib.rs
│   ├── harness.rs
│   ├── event_bridge.rs
│   ├── commands.rs
│   ├── help.rs
│   ├── plugins/
│   │   ├── mod.rs
│   │   ├── manager.rs
│   │   ├── loader.rs
│   │   ├── sandbox.rs
│   │   └── sdk.rs
│   └── lua/
│       └── sdk/
│           └── (empty — filled by SM-009)
└── examples/          — empty — filled by SM-009

smith-cli/
├── Cargo.toml
├── src/
│   └── main.rs        — stub main with clap

xtask/
├── Cargo.toml
├── src/
│   ├── main.rs        — command dispatch
│   ├── fetch_providers.rs
│   ├── doc_test.rs
│   ├── verify_docs.rs
│   └── doc_gen.rs
```

### 4. .gitignore

```
/target
*.swp
.DS_Store
```

### 5. rust-toolchain.toml

```toml
[toolchain]
channel = "1.85"
components = ["rustfmt", "clippy"]
```

### 6. xtask Skeleton

```rust
// xtask/src/main.rs
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("fetch-providers") => { /* TODO: SM-011 */ }
        Some("doc-test") => { /* TODO: SM-011 */ }
        Some("verify-docs") => { /* TODO: SM-011 */ }
        Some("doc-gen") => { /* TODO: SM-011 */ }
        Some("lint") => lint(),
        Some("test") => test(),
        _ => {
            eprintln!("Usage: cargo run -p xtask -- <command>");
            eprintln!("Commands: fetch-providers, doc-test, verify-docs, doc-gen, lint, test");
        }
    }
}

fn lint() {
    let status = std::process::Command::new("cargo")
        .args(["clippy", "--workspace", "--", "-D", "warnings"])
        .status()
        .expect("failed to run clippy");
    assert!(status.success());
}

fn test() {
    let status = std::process::Command::new("cargo")
        .args(["test", "--workspace"])
        .status()
        .expect("failed to run tests");
    assert!(status.success());
}
```

### 7. Stub Types (key shared types from SM-005 design)

Put enough in smith/ that other crates compile:

```rust
// smith/src/types.rs — minimal stubs
pub struct EntryId(pub String);
pub struct SessionId(pub String);
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Role { System, User, Assistant, Tool, ToolResult, Custom, BashExecution }
#[derive(Clone, Debug)]
pub enum ContentBlock { Text(String), Image { data: Vec<u8>, media_type: String }, ToolCall { id: String, name: String, arguments: String }, ToolResult { id: String, result: String, is_error: bool }, Thinking { content: String } }
#[derive(Clone, Debug)]
pub struct Message { pub role: Role, pub content: Vec<ContentBlock> }
#[derive(Clone, Debug, Default)]
pub struct ProviderUsage { pub input_tokens: u64, pub output_tokens: u64, pub cache_read_tokens: Option<u64>, pub cache_write_tokens: Option<u64>, pub total_tokens: Option<u64> }
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum StopReason { EndTurn, ToolUse, OverMaxTokens, Aborted, StopSequence, Error }
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum ThinkingLevel { Off, Minimal, Low, Medium, High, XHigh }
pub struct SecretId(pub String);
#[derive(Clone, Debug)]
pub enum ProviderEvent { TextDelta { text: String }, ToolCall { id: String, name: String, arguments: String }, ThinkingDelta { text: String }, Done { usage: ProviderUsage, stop_reason: StopReason }, Error { message: String } }
#[derive(Clone, Debug)]
pub struct ProviderRequest { pub messages: Vec<Message>, pub system_prompt: String, pub model_id: String, pub provider_id: String, pub tools: Vec<ToolDefinition>, pub thinking_level: ThinkingLevel, pub max_tokens: Option<u32>, pub stop_sequences: Vec<String> }
#[derive(Clone, Debug)]
pub struct ToolDefinition { pub name: String, pub description: String, pub parameters: serde_json::Value }
pub struct SecretId(pub String);
```

## Verification

After completion:
```bash
cargo check --workspace    # all crates compile
cargo test --workspace     # no tests yet, but no build errors
cargo run -p xtask -- lint # clippy passes
cargo run -p xtask -- test # test passes (empty)
```

## Steps

- [ ] Initialize jj repo
- [ ] Create workspace Cargo.toml
- [ ] Create smith/ skeleton with stub types
- [ ] Create smith-core/ skeleton
- [ ] Create smith-ai/ skeleton
- [ ] Create smith-tui/ skeleton
- [ ] Create smith-harness/ skeleton
- [ ] Create smith-cli/ skeleton
- [ ] Create xtask/ skeleton
- [ ] Create .gitignore, rust-toolchain.toml
- [ ] Verify: `cargo check --workspace`
- [ ] Verify: `cargo run -p xtask -- lint`
- [ ] Commit: `jj describe -m "feat(SM-003): project scaffolding — workspace, crates, xtask"`
