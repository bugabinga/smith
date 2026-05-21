# SM-006: smith-core/ — Agent Loop + Session + Business Logic

Create the `smith-core/` crate with the agent loop, session management, and core business logic.

## Context

Depends on smith/ (SM-005) only. Does NOT depend on smith-ai.
The agent loop takes a `StreamFn` (from smith/) — it never imports provider types.
This enables parallel builds: smith-core and smith-ai build simultaneously.

**Architecture:** Follows pi's agent pattern, but uses dependency inversion
via `StreamFn` instead of importing provider types directly.

## Key Design Decision

The agent loop is here, not in smith-harness. It is fully testable with mock stream functions.
smith-harness wires concrete providers into the stream function.

## Deliverables

### 1. `smith-core/Cargo.toml`

```toml
[package]
name = "smith-core"
version = "0.1.0"
edition = "2024"
rust-version.workspace = true

[dependencies]
smith = { path = "../smith" }
serde = { workspace = true }
serde_json = { workspace = true }
minicbor = { workspace = true }
tokio = { workspace = true, features = ["sync", "rt"] }
futures = { workspace = true }
tracing = { workspace = true }
thiserror = { workspace = true }
uuid = { workspace = true, features = ["v7"] }

[dev-dependencies]
tokio = { workspace = true, features = ["full"] }
insta = { workspace = true }
```

### 2. `smith-core/src/lib.rs`

```rust
pub mod agent;
pub mod session;
pub mod session_format;
pub mod tools;
pub mod hooks;
pub mod events;
pub mod secret_proxy;
pub mod system_prompt;
pub mod compaction;
pub mod cost;

pub use agent::{Agent, AgentContext, AgentEvent, AgentState, AgentLoopConfig};
pub use session::{Session, SessionEntry, SessionStore, SessionInfo};
pub use session_format::SessionCodec;
pub use tools::ToolRegistry;
pub use hooks::{HookRegistration, HookContext, HookResult};
pub use events::EngineEvent;
pub use secret_proxy::{SecretProxy, SecretId, InMemorySecretProxy};
pub use system_prompt::SystemPromptBuilder;
pub use compaction::{CompactionSettings, CompactionExecutor, TokenEstimator, HeuristicEstimator};
pub use cost::CostTracker;
```

### 3. `smith-core/src/agent.rs` — The Agent Loop

This is the core LLM interaction loop. It takes a StreamFn and tools,
sends requests, processes responses, executes tools, and repeats.

```rust
use smith::{
    StreamFn, AgentTool, AgentToolResult, ToolError,
    ProviderEvent, ProviderRequest, ProviderUsage,
    Message, ContentBlock, Role, StopReason, ThinkingLevel, ToolDefinition,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Agent context snapshot passed into the loop
#[derive(Clone)]
pub struct AgentContext {
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
}

/// Events emitted by the agent during a run. This is the canonical source of truth.
#[derive(Clone, Debug)]
pub enum AgentEvent {
    // Lifecycle
    AgentStart,
    AgentEnd { messages: Vec<Message> },

    // Turn tracking
    TurnStart { turn_index: usize },
    TurnEnd { turn_index: usize, message: Message, tool_results: Vec<ContentBlock> },

    // Message streaming
    MessageStart { message: Message },
    MessageUpdate { message: Message, delta: ContentBlock },
    MessageEnd { message: Message, usage: ProviderUsage, stop_reason: StopReason },

    // Tool execution
    ToolExecutionStart { tool_call_id: String, tool_name: String, args: serde_json::Value },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, result: Vec<ContentBlock>, is_error: bool },
    ToolExecutionUpdate { tool_call_id: String, tool_name: String, partial: String },

    // Streaming deltas
    ThinkingDelta { delta: String },
    TextDelta { delta: String },

    // Error
    Error { message: String },
}

/// Configuration for the agent loop
pub struct AgentLoopConfig {
    pub model_id: String,
    pub provider_id: String,
    pub thinking_level: ThinkingLevel,
    pub max_tokens: Option<u32>,
    pub convert_to_llm: Box<dyn Fn(Vec<Message>) -> Vec<Message> + Send + Sync>,
    pub transform_context: Option<Box<dyn Fn(Vec<Message>) -> Vec<Message> + Send + Sync>>,
    pub get_api_key: Option<Box<dyn Fn(&str) -> Option<String> + Send + Sync>>,
    pub after_tool_call: Option<Box<dyn Fn(&str, &AgentToolResult) -> Option<AgentToolResult> + Send + Sync>>,
}

/// Stateful agent wrapper (like pi's Agent class)
pub struct Agent {
    state: AgentState,
    tools: HashMap<String, Arc<dyn AgentTool>>,
    stream_fn: Box<StreamFn>,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    event_rx: mpsc::UnboundedReceiver<AgentEvent>,
}

/// Current agent state
pub struct AgentState {
    pub system_prompt: String,
    pub messages: Vec<Message>,
    pub model_id: String,
    pub provider_id: String,
    pub thinking_level: ThinkingLevel,
    pub is_streaming: bool,
    pub abort_signal: tokio::sync::watch::Sender<bool>,
}

impl Agent {
    pub fn new(stream_fn: Box<StreamFn>) -> Self;
    pub fn set_tools(&mut self, tools: HashMap<String, Arc<dyn AgentTool>>);
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<AgentEvent>;
    pub fn state(&self) -> &AgentState;
    pub async fn prompt(&mut self, text: &str, config: AgentLoopConfig) -> Result<(), SmithError>;
    pub async fn continue_loop(&mut self, config: AgentLoopConfig) -> Result<(), SmithError>;
    pub fn abort(&self);
    pub fn is_streaming(&self) -> bool;
}
```

The core loop:
```
1. Convert messages to LLM format (convert_to_llm)
2. Optionally transform context (transform_context)
3. Build ProviderRequest
4. Call stream_fn(request) → get event stream
5. Process ProviderEvents:
   - TextDelta → emit AgentEvent::TextDelta, accumulate
   - ToolCall → queue tool call
   - ThinkingDelta → emit AgentEvent::ThinkingDelta
   - Done → finalize assistant message, execute queued tools
6. For each tool call:
   a. Execute tool (AgentTool::execute)
   b. after_tool_call hook (can modify result)
   c. Add tool result to messages
7. If stop_reason == ToolUse, goto 1 (next turn)
8. If stop_reason == EndTurn, emit AgentEnd
```

### 4. `smith-core/src/events.rs` — Engine Event Bus

`EngineEvent` wraps `AgentEvent` and adds harness-level session/steering events.
This is the event type consumed by smith-harness and smith-tui.

```rust
use smith::{Message, ContentBlock, ProviderUsage, StopReason};

#[derive(Clone, Debug)]
pub enum EngineEvent {
    // All agent events are wrapped in a single variant
    Agent(AgentEvent),

    // Session events (not from agent loop)
    SessionSaved { session_id: SessionId },
    CompactionStart,
    CompactionEnd { tokens_before: u64, tokens_after: u64 },

    // Session tree events
    BranchCreated { from_id: EntryId, to_id: EntryId },

    // User interaction events
    SteeringQueued { text: String },
    FollowUpQueued { text: String },

    // Retry policy
    Retry { attempt: u8, tool_name: String },

    // Cost tracking
    CostUpdate { cumulative_cost: f64, last_response_cost: f64 },

    // Shutdown
    Shutdown,
}
```

**Design note:** `EngineEvent::Agent(AgentEvent)` wraps ALL agent events.
Downstream consumers match with:
```rust
if let EngineEvent::Agent(AgentEvent::TextDelta { delta }) = event { ... }
```
This avoids duplicating 15 agent event variants at the harness level.

### 5. `smith-core/src/session.rs` — Session Management

Session management (tree, entries, compaction point).

```rust
pub struct Session {
    pub id: SessionId,
    pub name: Option<String>,
    pub cwd: PathBuf,
    pub entries: Vec<SessionEntry>,
    pub current_leaf: EntryId,
    pub created: u64,
    pub updated: u64,
}

/// Session entry — immutable record. Canonical definition lives here.
#[derive(Clone, Debug, Serialize, Deserialize, minicbor::Encode, minicbor::Decode)]
pub enum SessionEntry {
    Session { version: u32, created: u64 },
    User { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, timestamp: u64 },
    Assistant { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, usage: ProviderUsage, provider: String, model: String, stop_reason: StopReason, timestamp: u64 },
    ToolResult { id: EntryId, parent_id: Option<EntryId>, tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool, timestamp: u64 },
    Compaction { id: EntryId, parent_id: Option<EntryId>, summary: String, first_kept_id: EntryId, tokens_before: u64, read_files: Vec<String>, modified_files: Vec<String>, timestamp: u64 },
    BranchSummary { id: EntryId, parent_id: Option<EntryId>, summary: String, from_id: EntryId, timestamp: u64 },
    ThinkingLevelChange { id: EntryId, parent_id: Option<EntryId>, level: ThinkingLevel, timestamp: u64 },
    ModelChange { id: EntryId, parent_id: Option<EntryId>, provider: String, model_id: String, timestamp: u64 },
    BashExecution { id: EntryId, parent_id: Option<EntryId>, command: String, output: String, timestamp: u64 },
    Label { id: EntryId, parent_id: Option<EntryId>, label: String, timestamp: u64 },
    SecretRegister { id: EntryId, parent_id: Option<EntryId>, secret_id: String, value: String, source: String, timestamp: u64 },
    Unknown { id: EntryId, data: Vec<u8>, timestamp: u64 },
}

pub trait SessionStore: Send + Sync {
    fn load(&self, id: &SessionId) -> Result<Session>;
    fn save(&self, session: &Session) -> Result<()>;
    fn list(&self) -> Result<Vec<SessionInfo>>;
    fn delete(&self, id: &SessionId) -> Result<()>;
}

pub struct SessionInfo {
    pub id: SessionId,
    pub name: Option<String>,
    pub cwd: PathBuf,
    pub created: u64,
    pub updated: u64,
    pub entry_count: usize,
}
```

### 6. `smith-core/src/session_format.rs` — CBOR Codec

Length-prefixed CBOR-seq codec for session persistence.

```rust
/// Wire format:
///   [u32 BE len][CBOR entry bytes][u32 BE len][CBOR entry bytes]...
pub struct SessionCodec;

/// Decode error for a single entry.
pub struct DecodeError {
    pub entry_index: usize,
    pub error_offset: usize,
    pub source: String,
}

impl SessionCodec {
    /// Encode entries to CBOR-seq bytes.
    pub fn encode(entries: &[SessionEntry]) -> Result<Vec<u8>>;

    /// Decode CBOR-seq bytes to entries (fault-tolerant).
    /// Returns all successfully decoded entries plus a list of per-entry errors.
    /// Never returns Err for partial corruption — skips corrupt entries and continues.
    pub fn decode(data: &[u8]) -> (Vec<SessionEntry>, Vec<DecodeError>);

    /// Append a single entry (for incremental writes during a session).
    pub fn append_entry(writer: &mut impl Write, entry: &SessionEntry) -> Result<()>;

    /// Read entries from a file path (fault-tolerant).
    /// Returns entries and errors separately so callers can decide whether to proceed.
    pub fn read_file(path: &Path) -> (Vec<SessionEntry>, Vec<DecodeError>);
}
```

**Fault tolerance rules:**
- Truncated entry (crash mid-write) → stop reading, all prior entries intact.
- Corrupt CBOR bytes → log warning, skip entry (advance by len), continue.
- Unknown entry type → keep as `SessionEntry::Unknown { data }`.
- Unknown CBOR fields in known entry → ignored (forward compatible).
- Missing optional fields → `None` (backward compatible).
- Empty or missing file → return empty vec, create on first write.

### 7. `smith-core/src/tools.rs`

Tool registry (maps names to AgentTool instances).

```rust
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self;
    pub fn register(&mut self, tool: Arc<dyn AgentTool>);
    pub fn get(&self, name: &str) -> Option<&Arc<dyn AgentTool>>;
    pub fn list(&self) -> Vec<&Arc<dyn AgentTool>>;
    pub fn definitions(&self) -> Vec<ToolDefinition>;
}
```

### 8. `smith-core/src/hooks.rs`

Hook system for intercepting events. Maps to plugin SDK events.

```rust
pub struct HookRegistration {
    pub event: String,
    pub handler: Box<dyn Fn(&HookContext) -> HookResult + Send + Sync>,
}

pub struct HookContext {
    pub event: String,
    pub data: serde_json::Value,
}

pub enum HookResult {
    Pass,
    Modify { data: serde_json::Value },
}
```

### 9. `smith-core/src/system_prompt.rs`

Builds the system prompt from components.

```rust
/// Builds the system prompt from components.
/// Called once per agent loop invocation.
pub struct SystemPromptBuilder {
    base_template: String,
    tool_registry: ToolRegistry,
    session_context: SessionContext,
    plugin_sections: Vec<(String, String)>,
}

pub struct SessionContext {
    pub cwd: PathBuf,
    pub git_branch: Option<String>,
    pub file_tree_summary: Option<String>,
}

impl SystemPromptBuilder {
    pub fn new(base_template: String, tools: ToolRegistry) -> Self;
    pub fn set_context(&mut self, context: SessionContext);
    pub fn add_plugin_section(&mut self, name: String, content: String);
    /// Build the complete system prompt string.
    /// Components (in order):
    /// 1. Base instructions ("You are smith, a coding agent...")
    /// 2. Tool descriptions (from ToolRegistry::definitions())
    /// 3. Session context (cwd, file tree, git branch)
    /// 4. Plugin-provided prompt additions
    /// 5. Self-extension instructions (how to use smith's plugin system)
    pub fn build(&self) -> String;
}
```

### 10. `smith-core/src/compaction.rs`

Context compaction and token estimation.

```rust
pub struct CompactionSettings {
    pub max_tokens: u64,
    pub threshold_ratio: f64,  // default 0.8
}

pub struct CompactionExecutor;

impl CompactionExecutor {
    pub fn compact(session: &mut Session, settings: &CompactionSettings) -> Result<CompactionSummary>;
}

pub struct CompactionSummary {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub summary: String,
    pub read_files: Vec<String>,
    pub modified_files: Vec<String>,
}

/// Token estimator for compaction decisions.
pub trait TokenEstimator: Send + Sync {
    fn estimate(&self, messages: &[Message]) -> u64;
}

/// Default estimator: chars / 4 (rough but safe for context window checks).
pub struct HeuristicEstimator;

impl TokenEstimator for HeuristicEstimator {
    fn estimate(&self, messages: &[Message]) -> u64 {
        let total_chars: usize = messages.iter()
            .flat_map(|m| &m.content)
            .map(|c| match c {
                ContentBlock::Text(t) => t.len(),
                ContentBlock::Thinking { content } => content.len(),
                ContentBlock::ToolCall { arguments, .. } => arguments.len(),
                ContentBlock::ToolResult { result, .. } => result.len(),
                _ => 0,
            })
            .sum();
        (total_chars / 4) as u64
    }
}
```

**Token counting strategy:**
- v1 uses `HeuristicEstimator` (chars/4) for compaction decisions.
- Exact per-model tokenization (tiktoken, cl100k) is a smith-ai concern.
- The agent loop checks `estimate(messages) > model.context_window * threshold_ratio`
  to trigger compaction.
- Cost calculation uses `ModelCost` × tokens from `ProviderUsage` (exact where available).

### 11. `smith-core/src/cost.rs`

Cost tracking across a session.

```rust
/// Tracks cumulative cost across a session.
/// Emits CostUpdate events via the agent loop for TUI display.
pub struct CostTracker {
    cumulative_input_tokens: u64,
    cumulative_output_tokens: u64,
    cumulative_cache_read_tokens: u64,
    cumulative_cache_write_tokens: u64,
    total_cost: f64,
    cost_per_response: Vec<f64>,
}

impl CostTracker {
    pub fn new() -> Self;

    /// Record usage from a completed LLM response. Returns the cost of this response.
    pub fn record(&mut self, usage: &ProviderUsage, cost: &ModelCost) -> f64;

    pub fn total_cost(&self) -> f64;
    pub fn total_input_tokens(&self) -> u64;
    pub fn reset(&mut self);
}
```

### 12. `smith-core/src/secret_proxy.rs`

Secret proxy for hiding sensitive data from the LLM.

```rust
pub trait SecretProxy: Send + Sync {
    fn register(&mut self, secret: String) -> SecretId;
    fn resolve(&self, id: &SecretId) -> Option<&str>;
}

pub struct InMemorySecretProxy {
    table: HashMap<SecretId, String>,
}
```

## Tests

- **Agent loop with mock stream** — most important test
  - Mock StreamFn returns TextDelta + Done
  - Agent emits AgentStart, MessageStart, TextDelta, MessageEnd, AgentEnd
  - Messages appended to state
- **Agent loop with tool calls**
  - Mock StreamFn returns ToolCall + Done
  - Agent executes tool, adds result, loops again
  - Second loop returns EndTurn
- **Session creation and entry addition**
- **Session fork creates correct tree**
- **SecretProxy hides and restores secrets**
- **Token estimation** (HeuristicEstimator)
- **Compaction cut point**
- **CostTracker accumulation**
- **SystemPromptBuilder includes all components**
- **SessionCodec roundtrip and fault tolerance**

## Steps

- [ ] Create `smith-core/Cargo.toml`
- [ ] Create `smith-core/src/lib.rs`
- [ ] Create `smith-core/src/agent.rs` (agent loop — most important)
- [ ] Create `smith-core/src/session.rs` (SessionEntry canonical definition)
- [ ] Create `smith-core/src/session_format.rs` (CBOR codec)
- [ ] Create `smith-core/src/tools.rs` (ToolRegistry)
- [ ] Create `smith-core/src/hooks.rs`
- [ ] Create `smith-core/src/events.rs` (EngineEvent wrapping AgentEvent)
- [ ] Create `smith-core/src/secret_proxy.rs`
- [ ] Create `smith-core/src/system_prompt.rs` (expanded)
- [ ] Create `smith-core/src/compaction.rs` (TokenEstimator)
- [ ] Create `smith-core/src/cost.rs` (CostTracker)
- [ ] Write agent loop tests (mock stream function)
- [ ] Write session/tool/hook/cost tests
- [ ] Verify: `cargo check -p smith-core`
- [ ] Test: `cargo test -p smith-core`
- [ ] Commit: `jj describe -m "feat(SM-006): smith-core — agent loop, session, events, cost, compaction"`
