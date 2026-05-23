# SM-005: smith/ Shared Library

Create the `smith/` shared library crate with types, streaming primitives, tool trait, and config resolution.

## Context

This is the foundation crate. ALL other crates depend on it.
It contains shared types, the StreamFn abstraction, and the AgentTool trait.

**Architecture note:** In pi, the core agent depends on the AI layer for streaming types.
In Rust, we avoid this dependency by putting shared streaming types here. This lets
`smith-core` and `smith-ai` build in parallel with no coupling.

## Deliverables

### 1. `smith/Cargo.toml`

```toml
[package]
name = "smith"
version = "0.1.0"
edition = "2024"

[dependencies]
mlua = { workspace = true }
mlua-pkg = { workspace = true }
ciborium = { workspace = true }
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
pub mod mux;

pub use types::*;
pub use stream::StreamFn;
pub use tool::{AgentTool, AgentToolResult, AgentToolUpdate, ToolExecutionMode};
pub use lua::LuaRuntime;
pub use config::Config;
pub use error::SmithError;
pub use mux::{ModelAlias, ModelGroup, ProviderBucket, ModelResolver, ResolvedModel, ResolveError};
```

### 3. `smith/src/types.rs`

All shared types used across crates.

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

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

/// jj operation identifier correlated with trace entries.
/// Opaque to plugins; generated/read by the `smith.vcs.*` SDK.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct VcsOpId(pub String);

/// VCS state snapshot for trace/time-travel integration.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VcsSnapshot {
    pub op_id: VcsOpId,
    pub repo_root: String,
    pub changed_files: Vec<VcsFileStatus>,
}

/// Structured file status exposed by VCS primitives.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VcsFileStatus {
    pub path: String,
    pub status: VcsStatusKind,
}

#[derive(Clone, Debug, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VcsStatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// Structured diff hunk returned by `smith.vcs.*` and rendered by Lua plugins.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<String>,
}

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

/// Serializable tool definition for LLM function calling and persisted plugin metadata.
/// Contains schema/prompt fields only. Runtime callbacks/state are intentionally excluded.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinitionSpec {
    pub name: String,
    /// Human-readable label for UI display. Defaults to name.
    pub label: String,
    pub description: String,
    /// JSON Schema for tool parameters.
    pub parameters: serde_json::Value,

    // System prompt contributions (inherited from pi)
    /// One-liner shown in the Available tools section of the system prompt.
    pub prompt_snippet: Option<String>,
    /// Bullets appended to the Guidelines section when this tool is active.
    pub prompt_guidelines: Option<Vec<String>>,
}

/// Runtime tool definition for AgentTool registration.
/// Canonical definition lives in smith/ (foundation crate) so all
/// downstream crates (smith-core, smith-harness, smith-tui) share it.
///
/// This type is deliberately not Serialize/Deserialize: function pointers,
/// execution overrides, render hints, and source attribution are runtime-only.
/// Persist or send tools to providers via `ToolDefinitionSpec` (`to_spec()`).
#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub name: String,
    /// Human-readable label for UI display. Defaults to name.
    pub label: String,
    pub description: String,
    /// JSON Schema for tool parameters.
    pub parameters: serde_json::Value,

    // System prompt contributions (inherited from pi)
    /// One-liner shown in the Available tools section of the system prompt.
    pub prompt_snippet: Option<String>,
    /// Bullets appended to the Guidelines section when this tool is active.
    pub prompt_guidelines: Option<Vec<String>>,

    // Execution control (inherited from pi)
    /// Optional compatibility shim for raw tool-call arguments before schema validation.
    pub prepare_arguments: Option<fn(JsonValue) -> JsonValue>,
    /// Per-tool execution mode override. None = use AgentLoopConfig default.
    pub execution_mode: Option<ToolExecutionMode>,

    // Custom rendering (inherited from pi)
    /// Which shell framing mode this tool uses in the TUI.
    pub render_shell: Option<RenderShell>,

    // Source attribution (inherited from pi)
    /// Which plugin registered this tool.
    pub source_info: Option<SourceInfo>,
}

impl ToolDefinition {
    /// Drop runtime-only fields before serialization or provider schema emission.
    pub fn to_spec(&self) -> ToolDefinitionSpec {
        ToolDefinitionSpec {
            name: self.name.clone(),
            label: self.label.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
            prompt_snippet: self.prompt_snippet.clone(),
            prompt_guidelines: self.prompt_guidelines.clone(),
        }
    }
}

/// Shell framing mode for tool rendering in the TUI.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum RenderShell {
    /// TUI renders standard shell frame; tool only produces inner content.
    Default,
    /// Tool produces the entire component including framing.
    Self,
}

/// Source attribution for plugin registrations (inherited from pi).
#[derive(Clone, Debug)]
pub struct SourceInfo {
    pub path: String,
    pub resolved_path: String,
}

/// Cost information for a model
#[derive(Clone, Debug, Copy, Default, Serialize, Deserialize)]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// Capability flags and limits for a provider model.
/// Sourced from smith-ai's model registry or user provider config.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelMetadata {
    /// Maximum input context window in tokens. Used by compaction and SDK context usage.
    pub context_window: u64,
    /// Optional provider output cap for one response.
    pub max_output_tokens: Option<u32>,
    /// Per-token or per-million-token pricing, normalized by smith-ai.
    pub cost: ModelCost,
    /// Feature support used when building ProviderRequest.
    pub capabilities: ModelCapabilities,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub thinking_levels: Vec<ThinkingLevel>,
    pub vision: bool,
    pub tool_use: bool,
    pub streaming: bool,
    pub json_mode: bool,
}
```

### 4. `smith/src/stream.rs`

Streaming abstraction. Enables smith-core to call LLM without knowing about providers.

```rust
use crate::types::{ProviderEvent, ProviderRequest};
use futures::Stream;
use std::pin::Pin;

/// Trait-object alias for the streaming function.
/// The agent loop calls this to get LLM responses.
/// Provider implementations (smith-ai) return `Box<StreamFn>`.
///
/// Single-box contract: `StreamFn` is the dyn function type, not `Box<dyn Fn>`.
/// Callers store/pass `Box<StreamFn>`; nested `Box<Box<dyn Fn...>>` is forbidden.
pub type StreamFn = dyn Fn(ProviderRequest) -> Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>
    + Send
    + Sync;
```

### 5. `smith/src/tool.rs`

Tool trait used by the agent loop.

```rust
use crate::types::{ContentBlock, ToolDefinition};
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

/// Tool execution mode for a batch of tool calls.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    /// Execute tool calls one by one: prepare, execute, finalize before next.
    Sequential,
    /// Preflight all tool calls sequentially, then execute concurrently.
    Parallel,
}

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

    /// Human-readable label for UI display. Defaults to definition().name.
    fn label(&self) -> String {
        self.definition().name
    }

    /// Optional compatibility shim for raw tool-call arguments before schema validation.
    /// Must return a JsonValue that matches the tool's parameter schema.
    fn prepare_arguments(
        &self,
        args: JsonValue,
    ) -> JsonValue {
        args
    }

    /// Per-tool execution mode override. None = use AgentLoopConfig default.
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        None
    }

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
    /// Model aliases: short name -> fully qualified model ID
    pub model_aliases: std::collections::HashMap<String, String>,
    /// Model groups: group name -> list of model IDs with failover strategy
    pub model_groups: std::collections::HashMap<String, ModelGroupConfig>,
    /// Provider buckets: bucket name -> list of accounts with rotation strategy
    pub provider_buckets: std::collections::HashMap<String, ProviderBucketConfig>,
}

impl Config {
    pub fn from_lua_table(table: mlua::Table) -> Result<Self, SmithError>;
}

/// Model group configuration from Lua config.
#[derive(Clone, Debug)]
pub struct ModelGroupConfig {
    pub models: Vec<String>,
    pub strategy: FailoverStrategy,
}

/// Provider bucket configuration from Lua config.
#[derive(Clone, Debug)]
pub struct ProviderBucketConfig {
    pub accounts: Vec<ProviderAccountConfig>,
    pub strategy: BucketStrategy,
}

/// Single account within a provider bucket.
#[derive(Clone, Debug)]
pub struct ProviderAccountConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

/// Note: sandbox enforcement was removed. Lua plugins run in a restricted
/// context (no io/os/debug/package/require globals) — that is the only sandbox.
```

### 8. `smith/src/mux.rs`

Model aliasing, grouping, and provider muxing.

This module defines the resolution pipeline that translates a user-facing model
name (e.g. "larry", "agentic") into a concrete provider + model + credentials.

**Design decisions:**
1. **Resolution is pure** — no I/O, no network calls. Only walks config tables.
2. **Cycles are detected at config load time** — resolution never panics at runtime.
3. **Plugin API mirrors config** — plugins register aliases/groups/buckets dynamically.
4. **Failover on RateLimit immediately** — other errors retry N times before failover.
5. **Balance fair (default)** — distributes load evenly; round_robin as alternative.

```rust
use std::collections::HashMap;
use thiserror::Error;

/// A user-defined alias: "larry" -> "anthropic/claude-sonnet-4"
#[derive(Clone, Debug)]
pub struct ModelAlias {
    pub name: String,
    pub target: String,  // fully qualified model ID or another alias name
}

/// A group of models treated as one logical model with automatic failover.
/// Example: "agentic" -> [claude-sonnet-4, opus-4-7, glm-5-1]
#[derive(Clone, Debug)]
pub struct ModelGroup {
    pub name: String,
    pub members: Vec<String>,  // model IDs, aliases, or other group names
    pub strategy: FailoverStrategy,
}

/// Failover strategy for model groups.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum FailoverStrategy {
    /// Try members in order. On RateLimit, fail over immediately.
    /// On other errors, retry up to N times before failing over.
    Sequential,
    /// Try members in round-robin order.
    RoundRobin,
    /// Deferred to v2 — requires metrics infrastructure not in v1.
    /// When implemented, picks member with lowest recent latency.
    #[deprecated = "deferred to v2 — requires metrics"]
    Latency,
}

/// A bucket of provider accounts for load balancing / key rotation.
/// Example: "codex" -> [api_key_1, api_key_2]
#[derive(Clone, Debug)]
pub struct ProviderBucket {
    pub name: String,
    pub provider: String,  // which provider this bucket is for
    pub accounts: Vec<ProviderAccount>,
    pub strategy: BucketStrategy,
}

/// Single account in a provider bucket.
///
/// **Security note (v1):** API keys are stored as plaintext Strings in memory.
/// This is a known limitation — future versions will migrate to `SecretId` references
/// resolved through `SecretProxy` at provider creation time, keeping keys out of
/// long-lived structs.
#[derive(Clone, Debug)]
pub struct ProviderAccount {
    /// Resolved from `ProviderAccountConfig::api_key` at config validation time.
    /// Config validation rejects `None` — this field is always `Some` at runtime.
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    /// Mutable state for rotation strategies.
    /// NOTE: These counters are duplicated when ProviderAccount is cloned
    /// (ProviderBucket derives Clone). For v1 this is acceptable — buckets
    /// are typically accessed from a single thread. Future: wrap in
    /// Arc<Mutex<...>> for shared mutable state across threads/tasks.
    pub last_used: Option<u64>,  // unix timestamp
    pub failure_count: u32,
}

/// Rotation strategy for provider buckets.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum BucketStrategy {
    /// Select account with oldest `last_used` timestamp (least-recently-used).
    /// Provides even distribution without counters.
    BalanceFair,
    /// Rotate accounts in fixed order (index modulo len).
    RoundRobin,
}

/// Resolution result: what model + provider + credentials to use.
#[derive(Clone, Debug)]
pub struct ResolvedModel {
    /// The model ID the user originally requested (before resolution).
    pub requested_id: String,
    /// The resolved model ID (after alias/group expansion).
    pub resolved_id: String,
    /// The provider ID (e.g. "anthropic", "openai").
    pub provider_id: String,
    /// Model registry metadata for compaction, context usage, cost tracking, and capability checks.
    pub metadata: ModelMetadata,
    /// Which bucket account was selected (if any).
    pub bucket_account: Option<usize>,
    /// Which group member was selected (if any).
    pub group_member: Option<usize>,
}

/// Resolution error with excellent error messages.
#[derive(Error, Clone, Debug)]
pub enum ResolveError {
    #[error("Model alias cycle detected: {path}")]
    Cycle { path: String },
    #[error("Unknown model or alias: '{name}'")]
    Unknown { name: String },
    #[error("Group '{group}' has no resolvable members")]
    EmptyGroup { group: String },
    #[error("Bucket '{bucket}' has no accounts")]
    EmptyBucket { bucket: String },
    #[error("Group '{group}' exhausted all members after retries")]
    GroupExhausted { group: String },
    #[error("Bucket '{bucket}' exhausted all accounts")]
    BucketExhausted { bucket: String },
}

/// Resolves user-facing model names to concrete provider + model + credentials.
///
/// Resolution pipeline:
///   requested_name
///     -> AliasResolver (alias -> target)
///     -> GroupResolver (group -> member)
///     -> BucketResolver (bucket -> account)
///     -> ProviderResolver (provider_id + model_id)
///
/// Cycles are detected at config load time. Resolution is pure (no I/O).
pub struct ModelResolver {
    aliases: HashMap<String, ModelAlias>,
    groups: HashMap<String, ModelGroup>,
    buckets: HashMap<String, ProviderBucket>,
    /// Concrete model ID (`provider/model`) -> metadata loaded by smith-harness from smith-ai.
    /// Keeps resolution pure while avoiding a dependency from smith/ to smith-ai/.
    model_metadata: HashMap<String, ModelMetadata>,
}

impl ModelResolver {
    pub fn new(
        config: &Config,
        model_metadata: HashMap<String, ModelMetadata>,
    ) -> Result<Self, ResolveError>;

    /// Resolve a requested model name to a concrete ResolvedModel.
    ///
    /// Walks: alias -> group -> member model -> provider ID.
    /// If a bucket is configured for that provider, selects an account.
    /// Falls through to direct model ID if no alias/group/bucket matches.
    /// Detects cycles during traversal.
    pub fn resolve(&self, requested: &str) -> Result<ResolvedModel, ResolveError>;

    /// Register a dynamic alias (from plugin).
    pub fn register_alias(&mut self, alias: ModelAlias);

    /// Register a dynamic group (from plugin).
    pub fn register_group(&mut self, group: ModelGroup);

    /// Register a dynamic bucket (from plugin).
    pub fn register_bucket(&mut self, bucket: ProviderBucket);

    /// Unregister by name.
    pub fn unregister(&mut self, name: &str);

    /// Detect cycles in the resolution graph at config load time.
    /// Returns Ok(()) if no cycles, Err with full path if cycle found.
    fn detect_cycles(&self) -> Result<(), ResolveError>;
}

/// MuxProvider lives in `smith-ai` (SM-007) where it implements the `Provider` trait.
/// It wraps multiple Provider instances with failover / rotation.
/// Created after resolution determines which provider + account to use.
/// See SM-007 §MuxProvider for full implementation.
```

**Config schema (Lua):**

```lua
-- ~/.smith/config.lua
model_aliases = {
  larry = "anthropic/claude-sonnet-4",
}

model_groups = {
  agentic = {
    models = {
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4-7",
      "google/glm-5-1",
    },
    strategy = "failover",  -- "failover" | "round_robin" | "latency"
  }
}

provider_buckets = {
  codex = {
    provider = "openai",
    accounts = {
      { api_key = "sk-1..." },
      { api_key = "sk-2..." },
    },
    strategy = "balance_fair",  -- "balance_fair" | "round_robin"
  },
  kimi = {
    provider = "moonshot",
    accounts = {
      { api_key = "sk-a...", base_url = "https://api.moonshot.cn" },
      { api_key = "sk-b...", base_url = "https://api.moonshot.cn" },
      { api_key = "sk-c...", base_url = "https://api.moonshot.cn" },
    },
    strategy = "balance_fair",
  }
}
```

**Cycle example and error message:**

```
alias "a" -> group "g" -> bucket "b" -> alias "a"
Error: Model alias cycle detected: a -> g -> b -> a
```

**Interaction rules:**
- Alias can reference: direct model ID, another alias, a group, or a bucket.
- Group can reference: direct model IDs, aliases, or other groups (but not buckets).
- Bucket can reference: aliases or groups (resolved to find the provider).
- Bucket members must all be for the same provider.
- Every concrete model ID must have `ModelMetadata`; otherwise resolution returns `ResolveError::Unknown`.
- `ResolvedModel.metadata` is copied from the resolver's metadata map and is authoritative for core compaction/cost decisions.

### 9. `smith/src/error.rs`

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
    #[error("CBOR encode error: {0}")]
    CborEncode(#[from] ciborium::ser::Error<std::io::Error>),
    #[error("CBOR decode error: {0}")]
    CborDecode(#[from] ciborium::de::Error<std::io::Error>),
    #[error("Provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("Auth error: {0}")]
    Auth(#[from] AuthError),
    #[error("Tool error: {0}")]
    Tool(#[from] ToolError),
    #[error("Resolve error: {0}")]
    Resolve(#[from] ResolveError),
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
- `ToolDefinition::to_spec` omits runtime callbacks/source fields
- `Config::from_lua_table` with valid/invalid tables
- Lua runtime executes simple code
- `StreamFn` can be boxed and called (mock test)
- `StreamFn` uses single-box `Box<StreamFn>` contract
- `ProviderError::Network` roundtrips through `SmithError::Provider`
- `AuthError::NotFound` display formatting
- `ModelResolver::resolve` with aliases
- `ModelResolver::resolve` with groups and failover
- `ModelResolver::resolve` with buckets and rotation
- `ModelResolver::resolve` copies `ModelMetadata.context_window` into `ResolvedModel`
- `ModelResolver::detect_cycles` catches cycles
- `ModelResolver::detect_cycles` allows DAGs

## Steps

- [ ] Create `smith/Cargo.toml`
- [ ] Create `smith/src/lib.rs`
- [ ] Create `smith/src/types.rs` (all shared types + streaming types)
- [ ] Create `smith/src/stream.rs` (StreamFn type alias)
- [ ] Create `smith/src/tool.rs` (AgentTool trait)
- [ ] Create `smith/src/lua.rs`
- [ ] Create `smith/src/config.rs` (Config + ModelGroupConfig + ProviderBucketConfig)
- [ ] Create `smith/src/mux.rs` (ModelResolver, aliases, groups, buckets)
- [ ] Create `smith/src/error.rs` (SmithError + ProviderError + AuthError + ResolveError)
- [ ] Write tests
- [ ] Verify: `cargo check -p smith`
- [ ] Test: `cargo test -p smith`
- [ ] Commit: `jj describe -m "feat(SM-005): smith shared library — types, StreamFn, AgentTool, lua, config, mux, errors"`
