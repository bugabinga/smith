# SM-005: smith/ Shared Library

Create the `smith/` shared library crate with types, streaming primitives, tool trait, and config resolution.

## Context

This is the foundation crate. ALL other crates depend on it.
It contains shared types, the StreamFn abstraction, and the AgentTool trait.

**Architecture note:** In pi, `pi-agent-core` depends on `pi-ai` for streaming types.
In Rust, we avoid this dependency by putting shared streaming types here. This lets
`smith-core` and `smith-ai` build in parallel with no coupling.

## Deliverables

### 1. `smith/Cargo.toml`

```toml
[package]
name = "smith"
version = "0.1.0"
edition = "2024"
rust-version.workspace = true

[dependencies]
mlua = { workspace = true }
mlua-pkg = { workspace = true }
minicbor = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true, features = ["sync"] }
futures = { workspace = true }
dirs = { workspace = true }
jsonschema = { workspace = true }

[dev-dependencies]
tokio = { workspace = true, features = ["full"] }
```

### 2. `smith/src/lib.rs`

```rust
pub mod types;
pub mod stream;
pub mod tool;
pub mod lua;
pub mod config;
pub mod error;

pub use types::*;
pub use stream::StreamFn;
pub use tool::{AgentTool, AgentToolResult, AgentToolUpdate};
pub use lua::LuaRuntime;
pub use config::{Config, SandboxConfig, Capability};
pub use error::SmithError;
```

### 3. `smith/src/types.rs`

All shared types used across crates.

```rust
use serde::{Deserialize, Serialize};

/// Unique entry identifier (UUID v7 for time-ordering)
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntryId(pub String);

impl EntryId {
    pub fn new() -> Self;
    pub fn from_string(s: String) -> Self;
    pub fn as_str(&self) -> &str;
}

/// Unique session identifier
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

/// Message role
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
    ToolResult,
    Custom,
    BashExecution,
}

/// Content block in a message
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ContentBlock {
    Text(String),
    Image { data: Vec<u8>, media_type: String },
    ToolCall { id: String, name: String, arguments: String },
    ToolResult { id: String, result: String, is_error: bool },
    Thinking { content: String },
}

/// Message in the conversation
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

/// Token usage from a completed response
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

/// Why the LLM stopped generating
#[derive(Clone, Debug, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    OverMaxTokens,
    Aborted,
    StopSequence,
    Error,
}

/// Thinking level
#[derive(Clone, Debug, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
}

/// Secret identifier for secret proxy
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SecretId(pub String);

// --- Streaming types (shared between smith-core and smith-ai) ---

/// Streaming event from an LLM provider.
/// Used by both the agent loop (smith-core) and provider implementations (smith-ai).
#[derive(Clone, Debug)]
pub enum ProviderEvent {
    TextDelta { text: String },
    ToolCall { id: String, name: String, arguments: String },
    ThinkingDelta { text: String },
    Done { usage: ProviderUsage, stop_reason: StopReason },
    Error { message: String },
}

/// Request sent to an LLM provider.
/// Constructed by the agent loop, consumed by provider implementations.
#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub messages: Vec<Message>,
    pub system_prompt: String,
    pub model_id: String,
    pub provider_id: String,
    pub tools: Vec<ToolDefinition>,
    pub thinking_level: ThinkingLevel,
    pub max_tokens: Option<u32>,
    pub stop_sequences: Vec<String>,
}

/// Tool definition for LLM function calling
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Cost information for a model
#[derive(Clone, Debug, Copy, Default, Serialize, Deserialize)]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
```

### 4. `smith/src/stream.rs`

Streaming abstraction. Enables smith-core to call LLM without knowing about providers.

```rust
use crate::types::{ProviderEvent, ProviderRequest};
use futures::Stream;
use std::pin::Pin;

/// Type alias for the streaming function.
/// The agent loop calls this to get LLM responses.
/// Provider implementations (smith-ai) create concrete instances.
pub type StreamFn = Box<
    dyn Fn(ProviderRequest) -> Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>
        + Send
        + Sync,
>;
```

### 5. `smith/src/tool.rs`

Tool trait used by the agent loop.

```rust
use crate::types::{ContentBlock, ToolDefinition};
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

/// Result returned from a tool execution
#[derive(Clone, Debug)]
pub struct AgentToolResult {
    pub content: Vec<ContentBlock>,
    pub details: JsonValue,
    pub terminate: bool,
}

/// Callback for streaming partial tool results
pub type AgentToolUpdate = Box<dyn Fn(AgentToolResult) + Send + Sync>;

/// Tool trait. Implementations are provided by smith-harness (built-in tools + Lua plugins).
pub trait AgentTool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    fn execute(
        &self,
        tool_call_id: &str,
        params: JsonValue,
        signal: Option<tokio::sync::watch::Receiver<bool>>,
        on_update: Option<&AgentToolUpdate>,
    ) -> Pin<Box<dyn Future<Output = Result<AgentToolResult, ToolError>> + Send + '_>>;
}

#[derive(thiserror::Error, Debug)]
pub enum ToolError {
    #[error("Invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("Execution failed: {0}")]
    ExecutionFailed(String),
    #[error("Timeout")]
    Timeout,
    #[error("Blocked: {0}")]
    Blocked(String),
}
```

### 6. `smith/src/lua.rs`

Lua runtime setup with mlua-pkg.

```rust
use mlua::Lua;
use std::path::PathBuf;

pub struct LuaRuntime {
    lua: Lua,
    config_path: PathBuf,
}

impl LuaRuntime {
    pub fn new(config_path: PathBuf) -> Result<Self, SmithError>;
    pub fn load_config(&self) -> Result<Config, SmithError>;
    pub fn load_module(&self, path: &std::path::Path) -> Result<mlua::Value, SmithError>;
    pub fn execute(&self, code: &str) -> Result<mlua::Value, SmithError>;
    pub fn globals(&self) -> mlua::Table;
}
```

### 7. `smith/src/config.rs`

Config loaded from Lua.

```rust
#[derive(Clone, Debug)]
pub struct Config {
    pub theme: String,
    pub model: String,
    pub provider: String,
    pub tools: Vec<String>,
    pub keybindings: std::collections::HashMap<String, String>,
    pub extensions: Vec<String>,
    pub thinking_level: ThinkingLevel,
    pub max_tokens: Option<u32>,
    pub system_prompt: Option<String>,
    pub sandbox: SandboxConfig,
}

impl Config {
    pub fn from_lua_table(table: mlua::Table) -> Result<Self, SmithError>;
}

/// Plugin sandbox configuration — enforced through SDK layer, not OS-level.
/// Moved here from the architecture doc (SM-004) to live in the foundation crate.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub capabilities: Vec<Capability>,
}

/// Capability declarations — enforced by SDK (Rust), not OS-level sandboxing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Capability {
    FileSystemRead,
    FileSystemWrite,
    Network,
    Subprocess,
    Environment,
}
```

### 8. `smith/src/error.rs`

Error types.

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SmithError {
    #[error("Lua error: {0}")]
    Lua(#[from] mlua::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Config error: {0}")]
    Config(String),
    #[error("CBOR error: {0}")]
    Cbor(#[from] minicbor::decode::Error),
    #[error("Provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("Auth error: {0}")]
    Auth(#[from] AuthError),
    #[error("Tool error: {0}")]
    Tool(#[from] ToolError),
}

/// Provider-specific errors. Lives in smith/ (not smith-ai) to avoid circular deps.
/// smith-ai adds conversion impls from reqwest::Error etc.
#[derive(Error, Clone, Debug)]
pub enum ProviderError {
    #[error("Rate limit exceeded. Retry after {retry_after:?}s")]
    RateLimit { retry_after: Option<u64> },
    #[error("Auth failed for {provider}: {reason}")]
    AuthFailed { provider: String, reason: String },
    #[error("Network error: {message}")]
    Network { message: String },
    #[error("Invalid request: {0}")]
    InvalidRequest(String),
    #[error("Server error {status}: {message}")]
    ServerError { status: u16, message: String },
    #[error("Timeout after {elapsed:?}")]
    Timeout { elapsed: std::time::Duration },
    #[error("Model not found: {provider}/{model}")]
    ModelNotFound { provider: String, model: String },
    #[error("Response parse error: {0}")]
    ResponseParse(String),
    #[error("Stream aborted")]
    StreamAborted,
}

/// Authentication errors.
#[derive(Error, Clone, Debug)]
pub enum AuthError {
    #[error("Credentials not found for {provider} ({auth_type})")]
    NotFound { provider: String, auth_type: String },
    #[error("Token expired for {provider}")]
    Expired { provider: String },
    #[error("Token refresh failed for {provider}: {reason}")]
    RefreshFailed { provider: String, reason: String },
    #[error("Invalid token for {provider}")]
    InvalidToken { provider: String },
    #[error("Storage error at {path}: {source}")]
    StorageError { path: String, source: String },
    #[error("OAuth callback failed: {0}")]
    OAuthCallbackFailed(String),
}
```

## Tests

- `EntryId::new()` generates valid UUID v7
- `ContentBlock` serialization roundtrip
- `ProviderEvent` can be created and matched
- `ProviderRequest` construction
- `Config::from_lua_table` with valid/invalid tables
- Lua runtime executes simple code
- `StreamFn` can be boxed and called (mock test)
- `ProviderError::Network` roundtrips through `SmithError::Provider`
- `AuthError::NotFound` display formatting

## Steps

- [ ] Create `smith/Cargo.toml`
- [ ] Create `smith/src/lib.rs`
- [ ] Create `smith/src/types.rs` (all shared types + streaming types)
- [ ] Create `smith/src/stream.rs` (StreamFn type alias)
- [ ] Create `smith/src/tool.rs` (AgentTool trait)
- [ ] Create `smith/src/lua.rs`
- [ ] Create `smith/src/config.rs` (Config + SandboxConfig + Capability)
- [ ] Create `smith/src/error.rs` (SmithError + ProviderError + AuthError)
- [ ] Write tests
- [ ] Verify: `cargo check -p smith`
- [ ] Test: `cargo test -p smith`
- [ ] Commit: `jj describe -m "feat(SM-005): smith shared library — types, StreamFn, AgentTool, lua, config, errors"`
