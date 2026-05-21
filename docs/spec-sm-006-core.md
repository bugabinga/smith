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
zstd = { workspace = true }          # trace file compression
sha2 = { workspace = true }          # payload/file hashing for trace

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

pub mod events;
pub mod secret_proxy;
pub mod system_prompt;
pub mod compaction;
pub mod cost;
pub mod trace;
pub mod replay;

pub use agent::{
    Agent, AgentContext, AgentEvent, AgentState, AgentLoopConfig,
    ToolExecutionMode, QueueMode,
    BeforeToolCallResult, AfterToolCallResult,
    BeforeToolCallContext, AfterToolCallContext,
    ShouldStopAfterTurnContext, AgentLoopTurnUpdate,
};
pub use session::{Session, SessionEntry, SessionStore, SessionInfo};
pub use session_format::SessionCodec;
pub use tools::ToolRegistry;
pub use events::EngineEvent;
pub use secret_proxy::{SecretProxy, SecretId, InMemorySecretProxy};
pub use system_prompt::SystemPromptBuilder;
pub use compaction::{CompactionSettings, CompactionExecutor, TokenEstimator, HeuristicEstimator};
pub use cost::CostTracker;
pub use trace::{TraceEntry, TraceCodec, TraceRecorder, FileTraceRecorder, TraceWriter, TraceFileHeader, AgentStateSnapshot};
pub use replay::{ReplayEngine, ReplaySpeed, ReplayMode, ReplayStep, ReplayDiff, ReplaySummary};
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
    ToolExecutionStart { tool_call_id: String, tool_name: String, args_json: String },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, result: Vec<ContentBlock>, is_error: bool },
    ToolExecutionUpdate { tool_call_id: String, tool_name: String, partial: String },

    // Streaming deltas (for TUI real-time updates)
    TextDelta { delta: String },
    ThinkingDelta { delta: String },

    // Error
    Error { message: String },
}

/// Convert an AgentEvent to a SessionEntry for the LLM conversation log.
/// Returns None for events that don't belong in the conversation context
/// (e.g., streaming deltas, errors).
impl AgentEvent {
    pub fn to_session_entry(&self, timestamp: u64) -> Option<SessionEntry> {
        match self {
            AgentEvent::AgentStart => None,
            AgentEvent::AgentEnd { messages } => None, // Intentionally not stored — session end is implicit from last entry
            AgentEvent::TurnStart { .. } => None,
            AgentEvent::TurnEnd { turn_index, message, tool_results } => {
                // TurnEnd is a lifecycle marker; Assistant and ToolResult
                // entries are produced by MessageEnd and ToolExecutionEnd.
                None
            }
            AgentEvent::MessageStart { .. } => None,
            AgentEvent::MessageUpdate { .. } => None,
            AgentEvent::MessageEnd { message, usage, stop_reason } => {
                Some(SessionEntry::Assistant {
                    id: EntryId::new(),
                    parent_id: None,
                    content: message.content.clone(),
                    usage: usage.clone(),
                    provider: String::new(), // caller post-processes from AgentStateSnapshot
                    model: String::new(),    // caller post-processes from AgentStateSnapshot
                    stop_reason: stop_reason.clone(),
                    timestamp,
                })
            }
            AgentEvent::ToolExecutionStart { .. } => None,
            AgentEvent::ToolExecutionEnd { tool_call_id, tool_name, result, is_error } => {
                Some(SessionEntry::ToolResult {
                    id: EntryId::new(),
                    parent_id: None,
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    content: result.clone(),
                    is_error: *is_error,
                    timestamp,
                })
            }
            AgentEvent::ToolExecutionUpdate { .. } => None,
            AgentEvent::TextDelta { .. } => None,
            AgentEvent::ThinkingDelta { .. } => None,
            AgentEvent::Error { .. } => None,
        }
    }
}

/// Result from before_tool_call hook.
#[derive(Clone, Debug, Default)]
pub struct BeforeToolCallResult {
    pub block: bool,
    pub reason: Option<String>,
}

/// Result from after_tool_call hook.
#[derive(Clone, Debug, Default)]
pub struct AfterToolCallResult {
    pub content: Option<Vec<ContentBlock>>,
    pub details: Option<serde_json::Value>,
    pub is_error: Option<bool>,
    pub terminate: Option<bool>,
}

/// Context passed to `before_tool_call`.
pub struct BeforeToolCallContext {
    pub assistant_message: Message,
    pub tool_call: ContentBlock, // ToolCall variant
    pub args: serde_json::Value,
    pub agent_context: AgentContext,
}

/// Context passed to `after_tool_call`.
pub struct AfterToolCallContext {
    pub assistant_message: Message,
    pub tool_call: ContentBlock,
    pub args: serde_json::Value,
    pub result: AgentToolResult,
    pub is_error: bool,
    pub agent_context: AgentContext,
}

/// Context passed to `should_stop_after_turn`.
pub struct ShouldStopAfterTurnContext {
    pub message: Message,
    pub tool_results: Vec<ContentBlock>,
    pub agent_context: AgentContext,
    pub new_messages: Vec<Message>,
}

/// Update returned by `prepare_next_turn` hook.
#[derive(Clone, Debug)]
pub struct AgentLoopTurnUpdate {
    pub model_id: Option<String>,
    pub thinking_level: Option<ThinkingLevel>,
    pub context: Option<AgentContext>,
}

/// Tool execution concurrency mode.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

/// Queue drain mode for steering/follow-up messages.
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum QueueMode {
    All,
    OneAtATime,
}

/// Configuration for a single agent loop invocation.
pub struct AgentLoopConfig {
    pub model_id: String,
    pub provider_id: String,
    pub thinking_level: ThinkingLevel,
    pub max_tokens: Option<u32>,
    pub system_prompt: String,
    pub tool_execution: ToolExecutionMode,
    pub queue_mode: QueueMode,

    /// Called before each tool execution.
    /// Return `block: true` to prevent execution; loop emits error tool result.
    pub before_tool_call: Option<Box<dyn Fn(&BeforeToolCallContext, Option<&tokio::sync::watch::Receiver<bool>>) -> BeforeToolCallResult + Send + Sync>>,
    /// Called after tool finishes, before events emitted.
    /// Return overrides for content/details/is_error/terminate.
    pub after_tool_call: Option<Box<dyn Fn(&AfterToolCallContext, Option<&tokio::sync::watch::Receiver<bool>>) -> AfterToolCallResult + Send + Sync>>,
    /// Called after each turn completes. Return true to emit `agent_end` and exit.
    pub should_stop_after_turn: Option<Box<dyn Fn(&ShouldStopAfterTurnContext) -> bool + Send + Sync>>,
    /// Called after `turn_end`, before deciding next provider request.
    /// Return replacement context/model/thinking for next turn.
    pub prepare_next_turn: Option<Box<dyn Fn(&ShouldStopAfterTurnContext) -> Option<AgentLoopTurnUpdate> + Send + Sync>>,
    /// Transform messages before each LLM call.
    pub transform_context: Option<Box<dyn Fn(Vec<Message>, Option<&tokio::sync::watch::Receiver<bool>>) -> Vec<Message> + Send + Sync>>,
    /// Convert messages to LLM-compatible format (default: filter to user/assistant/tool_result).
    pub convert_to_llm: Box<dyn Fn(Vec<Message>) -> Vec<Message> + Send + Sync>,
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
    /// Tool call ids currently executing.
    pub pending_tool_calls: std::collections::HashSet<String>,
    /// Error message from most recent failed/aborted turn, if any.
    pub error_message: Option<String>,
    /// Partial assistant message for current streamed response, if any.
    pub streaming_message: Option<Message>,
    /// Pending user messages queued for steering.
    pub steering_queue: Vec<Message>,
    /// Pending user messages queued for follow-up.
    pub follow_up_queue: Vec<Message>,
    /// Trace recorder for deterministic replay.
    pub trace: Option<Arc<dyn TraceRecorder>>,
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
1. Record trace: EnvSnapshot (cwd, env) if first turn
2. Convert messages to LLM format (convert_to_llm)
3. Optionally transform context (transform_context)
   - Record trace: PluginEvent::Context if transform changes messages
4. Build ProviderRequest
   - Record trace: ProviderRequest { provider_id, model_id, payload_hash }
5. Call stream_fn(request) → get event stream
6. Process ProviderEvents:
   - TextDelta → emit AgentEvent::TextDelta, accumulate
   - ToolCall → queue tool call
   - ThinkingDelta → emit AgentEvent::ThinkingDelta
   - Done → finalize assistant message
7. Record trace: ProviderResponse { status, payload_hash }
8. Emit TurnStart
   - Record trace: AgentEvent::TurnStart
9. For each tool call (respecting tool_execution mode):
   a. Record trace: ToolStart { tool_call_id, tool_name, args }
   b. Validate arguments against tool schema
   c. before_tool_call hook → if block, emit error tool result
      - Record trace: PluginEventResult::ToolCallBlock
   d. Execute tool (AgentTool::execute) with abort signal
   e. after_tool_call hook → apply overrides (content/details/is_error/terminate)
      - Record trace: PluginEventResult::ToolResultOverride
   f. Record trace: ToolEnd { result_hash, is_error }
   g. Emit ToolExecutionStart/Update/End
      - Record trace: AgentEvent for each
   h. Add tool result to messages
   i. **Early termination check:** If all finalized tools in this batch
      had `terminate=true` (from after_tool_call or original result),
      emit `AgentEnd` and exit immediately.
10. Emit TurnEnd
    - Record trace: AgentEvent::TurnEnd
11. Record trace: Snapshot { agent_state } (every 10s or on compaction)
12. should_stop_after_turn hook → if true, emit AgentEnd and exit
    - Record trace: PluginEventResult::ShouldStopAfterTurn
13. prepare_next_turn hook → apply context/model/thinking overrides
    - Record trace: PluginEventResult::PrepareNextTurn
14. If stop_reason == ToolUse, goto 2 (next turn)
15. If stop_reason == EndTurn:
    a. Drain steering queue (respecting queue_mode)
       - Record trace: SteeringDrain { messages }
    b. Drain follow-up queue (respecting queue_mode)
       - Record trace: FollowUpDrain { messages }
    c. If messages drained, emit AgentEnd
       - Record trace: AgentEvent::AgentEnd
    d. Else goto 2

**Queue drain semantics:**
- `QueueMode::All` — drain entire queue into messages, then proceed.
- `QueueMode::OneAtATime` — drain exactly one message, process it in next turn.
- Steering messages are prepended (higher priority) before follow-up messages.
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

> **Note:** The legacy `hooks.rs` HookRegistration/HookResult system was removed.
> All behavior mutation now happens through `AgentLoopConfig` typed hooks
> (`before_tool_call`, `after_tool_call`, `should_stop_after_turn`, `prepare_next_turn`).
> Plugin SDK event handlers in smith-harness return `PluginEventResult` values
> which the harness translates into these hook results.
> See SM-009 §Event Bridge for the plugin-side event result system.

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

### 13. `smith-core/src/trace.rs` — Session Recording and Replay

Deterministic replay requires capturing every event that affects state.
The session log (`SessionEntry`) remains conversation-only for the LLM.
The trace log (`TraceEntry`) captures everything: UI events, plugin events,
provider requests/responses, system signals, and periodic snapshots.

#### 13.1 Trace File Format

Trace files are stored alongside session files in the XDG data directory:

```
data_dir/smith/
  sessions/
    {session-id}.session      ← SessionEntry CBOR-seq (LLM context)
    {session-id}.trace        ← TraceEntry CBOR-seq (full replay log)
```

Trace file wire format:

```
┌───────────────────── Header (fixed 64 bytes) ─────────────────────┐
│ magic: [u8; 4]  = b"SMTH"                                         │
│ version: u16    = 1                                               │
│ flags: u16      = 0x01 (compressed) | 0x00 (raw)                  │
│ session_id: [u8; 16]  (UUID v7 bytes)                              │
│ start_timestamp_ns: u64  (monotonic clock base)                    │
│ (entry count is not stored in header — iterate body to count)      │
│ reserved: [u8; 32]                                                 │
├───────────────────── Body ─────────────────────────────────────────┤
│ [u32 BE len][CBOR TraceEntry bytes][u32 BE len][CBOR TraceEntry]...│
│ (each entry optionally zstd-compressed when flag 0x01 set)         │
└────────────────────────────────────────────────────────────────────┘
```

```rust
/// Trace file header. Fixed 64 bytes at file start.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TraceFileHeader {
    pub magic: [u8; 4],         // b"SMTH"
    pub version: u16,           // 1
    pub flags: u16,             // 0x01 = zstd compressed entries
    pub session_id: [u8; 16],   // UUID v7
    pub start_timestamp_ns: u64,
    pub reserved: [u8; 32],
}

impl TraceFileHeader {
    pub const MAGIC: [u8; 4] = *b"SMTH";
    pub const FLAG_COMPRESSED: u16 = 0x01;
    pub const SIZE: usize = 64;
}
```

#### 13.2 Trace Types

```rust
use std::sync::Arc;
use tokio::sync::mpsc;

/// Central recording trait. All subsystems call into a single recorder.
pub trait TraceRecorder: Send + Sync {
    /// Record a trace entry with monotonic nanosecond timestamp.
    fn record(&self, entry: TraceEntry);
    /// Flush pending entries to disk.
    fn flush(&self) -> Result<()>;
}

/// File-backed trace recorder. Append-only CBOR-seq with optional zstd.
pub struct FileTraceRecorder {
    path: PathBuf,
    header: TraceFileHeader,
    tx: mpsc::UnboundedSender<TraceEntry>,
}

impl FileTraceRecorder {
    /// Create new trace file with header. Returns recorder + writer handle.
    /// If `compressed` is true, entries are individually zstd-compressed.
    pub fn new(
        path: PathBuf,
        session_id: [u8; 16],
        compressed: bool,
    ) -> Result<(Self, TraceWriter)>;

    /// Open existing trace file for appending (reads header, validates magic).
    pub fn open(path: PathBuf) -> Result<(Self, TraceWriter)>;
}

/// Background writer task. Receives entries via channel, appends to file.
pub struct TraceWriter;

/// A single trace entry. Append-only, immutable.
#[derive(Clone, Debug, Serialize, Deserialize, minicbor::Encode, minicbor::Decode)]
pub enum TraceEntry {
    // === Agent loop events (also in SessionEntry, but with precise timing) ===
    AgentEvent { timestamp_ns: u64, event: AgentEvent },
    TurnStart { timestamp_ns: u64, turn_index: usize },
    TurnEnd { timestamp_ns: u64, turn_index: usize, messages: Vec<Message> },
    SteeringDrain { timestamp_ns: u64, messages: Vec<Message> },
    FollowUpDrain { timestamp_ns: u64, messages: Vec<Message> },

    // === TUI events ===
    TuiEvent { timestamp_ns: u64, event: TuiEvent },
    FocusChange { timestamp_ns: u64, widget_id: String, focused: bool },
    Scroll { timestamp_ns: u64, widget_id: String, offset: usize },

    // === Plugin events ===
    PluginEvent { timestamp_ns: u64, event: PluginEvent },
    PluginEventResult { timestamp_ns: u64, event_name: String, result: PluginEventResult },
    PluginLoaded { timestamp_ns: u64, path: String, success: bool },
    PluginError { timestamp_ns: u64, path: String, error: String },

    // === Provider interception ===
    ProviderRequest { timestamp_ns: u64, request_id: u64, provider_id: String, model_id: String, payload_hash: String },
    ProviderResponse { timestamp_ns: u64, request_id: u64, provider_id: String, model_id: String, status: u16, payload_hash: String },

    // === Tool execution ===
    ToolStart { timestamp_ns: u64, tool_call_id: String, tool_name: String, args_json: String },
    ToolEnd { timestamp_ns: u64, tool_call_id: String, tool_name: String, result_hash: String, is_error: bool },

    // === System events ===
    SystemSignal { timestamp_ns: u64, signal: String },
    EnvSnapshot { timestamp_ns: u64, cwd: String, env_vars: Vec<(String, String)> }, // API keys hashed: KEY=sha256:abc...
    FileHashSnapshot { timestamp_ns: u64, files: Vec<(String, String)> }, // (path, sha256)

    // === Snapshots (periodic state capture for deterministic replay) ===
    Snapshot { timestamp_ns: u64, agent_state: AgentStateSnapshot }, // rng_seed omitted — smith does not use RNG in v1
}

/// Lightweight agent state snapshot for deterministic replay.
#[derive(Clone, Debug, Serialize, Deserialize, minicbor::Encode, minicbor::Decode)]
pub struct AgentStateSnapshot {
    pub message_count: usize,
    pub model_id: String,
    pub provider_id: String,
    pub thinking_level: ThinkingLevel,
    pub pending_tool_calls: Vec<String>,
}
```

#### 13.3 Trace Codec

```rust
/// Trace codec — length-prefixed CBOR-seq with optional zstd compression.
pub struct TraceCodec;

impl TraceCodec {
    /// Encode entries to CBOR-seq bytes (uncompressed).
    pub fn encode(entries: &[TraceEntry]) -> Result<Vec<u8>>;

    /// Decode CBOR-seq bytes to entries (fault-tolerant, same rules as SessionCodec).
    pub fn decode(data: &[u8]) -> (Vec<TraceEntry>, Vec<DecodeError>);

    /// Append a single entry to writer. If header has compression flag,
    /// each entry is individually zstd-compressed: [u32 BE len][zstd(CBOR)].
    pub fn append_entry(
        writer: &mut impl Write,
        entry: &TraceEntry,
        compressed: bool,
    ) -> Result<()>;

    /// Read entries from a trace file (reads header, validates magic, decodes body).
    pub fn read_file(path: &Path) -> Result<(TraceFileHeader, Vec<TraceEntry>, Vec<DecodeError>)>;
}
```

**Compression trade-off:** Individual entry zstd compression (level 3) gives ~60-70% size
reduction on typical traces. Each entry compressed independently preserves random access —
a reader can skip an entry by reading the length prefix and seeking past. Block-level
compression (compressing N entries together) would give better ratios but loses random access.

#### 13.4 Snapshot Strategy

| Snapshot Type | When Captured | Purpose |
|--------------|---------------|----------|
| `EnvSnapshot` | Session start, every 5 minutes | Record cwd + env vars for replay env reconstruction |
| `FileHashSnapshot` | Session start, before/after each tool execution | Detect file changes for comparison mode |
| `Snapshot` (agent state) | Every 10s, on compaction, on model change | Agent state checkpoint for fast-forward during replay |

**FileHashSnapshot scope:** Only files in CWD that were touched by tool executions
(`read`, `write`, `edit`, `bash` tools). Not a full directory scan — tracked via
a `touched_files: HashSet<PathBuf>` in the trace recorder.

**EnvSnapshot scope:** `CWD`, `PATH`, `HOME`, `TERM`, `SHELL`, plus any vars
prefixed with `SMITH_`. Provider API keys and other secrets are captured as
`NAME=sha256:<hash>` — the value is hashed, not stored plaintext. This prevents
secret leakage in trace files while still allowing replay env reconstruction.

#### 13.5 Determinism Guarantees

**Guaranteed deterministic (same trace → same replay output):**
- Agent event ordering (monotonic nanosecond timestamps)
- Provider request/response pairing (by payload hash)
- Plugin event dispatch order and results
- Tool execution order (sequential mode) or per-turn grouping (parallel mode)
- SessionEntry derivation (smart filter is pure function over TraceEntry)

**Best-effort (may differ between live and replay):**
- Exact LLM responses (provider may return different text for same payload)
- File system state at tool execution time (files may have changed)
- Timing (wall-clock durations may differ, but ordering preserved)
- Plugin handler execution speed (Lua GC pauses may vary)

**Not captured (out of scope for v1):**
- Network latency/response times
- Exact memory layout or heap state
- External process state (tools that spawn subprocesses)
- Random number generation (smith doesn't use RNG in agent loop)

**Comparison mode** bridges the determinism gap for regression testing:
By re-executing tool calls in a controlled environment (same files, same env),
the replay engine can diff old vs new tool outputs, isolating changes caused
by code modifications vs. external state differences.

#### 13.6 Smart Filter — TraceEntry → SessionEntry

The smart filter produces the LLM-visible `SessionEntry` list from `TraceEntry`.
Only conversation-relevant entries pass through:

| TraceEntry | SessionEntry | Notes |
|------------|-------------|-------|
| `AgentEvent { AgentEvent::TextDelta, .. }` | filtered (aggregated into Assistant) | Text deltas accumulated into full message |
| `AgentEvent { AgentEvent::ToolExecutionEnd, .. }` | `ToolResult` | Tool results become session entries |
| `AgentEvent { AgentEvent::MessageEnd, .. }` | `Assistant` | Finalized assistant messages |
| `TurnEnd` (steering message detected) | `User` | Steering/follow-up messages become user entries |
| `ToolStart` (bash) | `BashExecution` | Bash tool calls record command + output |
| `Snapshot` (model change) | `ModelChange` | Model changes recorded |
| `Snapshot` (thinking change) | `ThinkingLevelChange` | Thinking level changes recorded |
| All other TraceEntry variants | _filtered out_ | TUI, plugin, provider events excluded from LLM context |

```rust
impl TraceEntry {
    /// Filter trace entries to produce SessionEntry for LLM context.
    pub fn to_session_entries(entries: &[TraceEntry]) -> Vec<SessionEntry> {
        let mut result = Vec::new();
        for e in entries {
            match e {
                TraceEntry::AgentEvent { timestamp_ns, event } => {
                    if let Some(se) = event.to_session_entry(*timestamp_ns) {
                        result.push(se);
                    }
                }
                TraceEntry::TurnEnd { timestamp_ns, messages } => {
                    // Steering/follow-up messages become user entries
                    let text: String = messages.iter()
                        .flat_map(|m| m.content.iter().filter_map(|c| match c {
                            ContentBlock::Text(t) => Some(t.as_str()),
                            _ => None,
                        }))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        result.push(SessionEntry::User {
                            id: EntryId::new(),
                            parent_id: None,
                            content: vec![ContentBlock::Text { text }],
                            timestamp: *timestamp_ns,
                        });
                    }
                }
                TraceEntry::ToolStart { timestamp_ns, tool_name, args_json }
                    if tool_name == "bash" =>
                {
                    // Extract command string from JSON args {"command":"ls",...}
                    let command = serde_json::from_str::<serde_json::Value>(args_json)
                        .ok()
                        .and_then(|v| v.get("command").and_then(|c| c.as_str().map(|s| s.to_string())))
                        .unwrap_or_else(|| args_json.clone());
                    result.push(SessionEntry::BashExecution {
                        id: EntryId::new(),
                        parent_id: None,
                        command,
                        output: String::new(), // output stored in ToolEnd, not session log
                        timestamp: *timestamp_ns,
                    });
                }
                TraceEntry::Snapshot { timestamp_ns, agent_state } => {
                    // Emit both ModelChange and ThinkingLevelChange from agent state
                    result.push(SessionEntry::ModelChange {
                        id: EntryId::new(),
                        parent_id: None,
                        provider: agent_state.provider_id.clone(),
                        model_id: agent_state.model_id.clone(),
                        timestamp: *timestamp_ns,
                    });
                    result.push(SessionEntry::ThinkingLevelChange {
                        id: EntryId::new(),
                        parent_id: None,
                        level: agent_state.thinking_level,
                        timestamp: *timestamp_ns,
                    });
                }
                _ => {} // TUI, plugin, provider events excluded from LLM context
            }
        }
        result
    }
}
```

#### 13.7 Replay Engine

The replay engine reconstructs a session from a trace log, feeding events into
a reconstructed agent at configurable speed. Used for debugging, testing, and
regression comparison.

```rust
/// Replay engine. Reads trace entries and reconstructs the session.
pub struct ReplayEngine {
    trace: Vec<TraceEntry>,
    header: TraceFileHeader,
    speed: ReplaySpeed,
    mode: ReplayMode,
    /// Current entry index for replay. Set by `seek_to_turn`.
    cursor: usize,
}

/// Replay speed control.
pub enum ReplaySpeed {
    /// Max speed — process events as fast as possible, ignore timing.
    Max,
    /// Real-time — respect original inter-event timing from timestamps.
    RealTime,
    /// Custom multiplier — scale original timing by factor (2.0 = 2x speed).
    Factor(f64),
}

/// Replay mode.
pub enum ReplayMode {
    /// Normal replay — reconstruct and display events.
    Normal,
    /// Compare mode — intercept tool calls, re-execute with current code,
    /// diff old vs new outputs. Requires controlled test environment.
    Compare {
        /// Directory containing the file state for replay.
        /// Should match the original session's CWD structure.
        sandbox_dir: PathBuf,
        /// Tool names to intercept for comparison (empty = all).
        tools: Vec<String>,
        /// Whether to continue on diff failures.
        continue_on_diff: bool,
    },
}

/// Result of a single replay step.
pub struct ReplayStep {
    pub entry: TraceEntry,
    pub timestamp_ns: u64,
    /// In compare mode: diff between old and new tool output, if any.
    pub diff: Option<ReplayDiff>,
}

/// Diff between original and replayed tool output.
pub struct ReplayDiff {
    pub tool_call_id: String,
    pub tool_name: String,
    /// Original output hash (from trace).
    pub original_hash: String,
    /// New output hash (from re-execution).
    pub new_hash: String,
    /// Unified diff of the output text, if textual.
    pub text_diff: Option<String>,
}

/// Summary produced at replay completion.
pub struct ReplaySummary {
    pub total_entries: usize,
    pub duration_ms: u64,
    pub agent_events: usize,
    pub tool_executions: usize,
    pub diffs: Vec<ReplayDiff>,
    /// In compare mode: whether any diffs were found.
    pub has_regressions: bool,
}

impl ReplayEngine {
    /// Create replay engine from a trace file.
    pub fn from_file(
        path: &Path,
        speed: ReplaySpeed,
        mode: ReplayMode,
    ) -> Result<Self>;

    /// Run the replay. Calls `on_step` for each processed entry.
    /// 
    /// The callback is synchronous (`Fn`) and must not block. Use it for
    /// lightweight work only (log, channel send, flag check). Heavy work
    /// (disk I/O, network) should be done in a separate task, or the replay
    /// will stall. Return `false` to abort the replay early.
    pub async fn run<F>(&mut self, on_step: F) -> Result<ReplaySummary>
    where
        F: Fn(ReplayStep) -> bool; // return false to abort

    /// Seek to the first entry of a specific turn.
    /// Sets internal cursor so subsequent `run()` begins at this position.
    /// Returns the entry index into `self.trace` where the turn starts.
    pub fn seek_to_turn(&mut self, turn_index: usize) -> Result<usize>;

    /// Extract the session entries from the trace (smart filter).
    pub fn extract_session(&self) -> Vec<SessionEntry>;

    /// Extract provider request/response pairs matched by request_id.
    /// Unmatched requests (no response recorded, e.g., crash mid-stream)
    /// are returned as `(request, None)`.
    pub fn extract_provider_trace(&self) -> Vec<(TraceEntry, Option<TraceEntry>)>;
}
```

**Replay execution flow:**
1. Read trace file → decode header + entries.
2. Optional: `seek_to_turn` to skip ahead.
3. Iterate entries in order:
   - **Max speed:** process immediately, no delays.
   - **RealTime:** compute delta from previous entry's `timestamp_ns`, `tokio::time::sleep`.
   - **Factor:** compute delta, divide by factor, sleep.
4. For each entry:
   - **Normal mode:** call `on_step(ReplayStep { entry, timestamp, diff: None })`.
   - **Compare mode:** on `ToolEnd` entries, re-execute the tool in sandbox,
     compare result hash. Call `on_step` with `diff` if hashes differ.
5. On completion, return `ReplaySummary`.

**Compare mode requirements:**
- Sandbox directory must contain files matching the original session's CWD.
- Environment should match (provider keys not needed — tool outputs are re-executed locally).
- Read-only tools (`read`, `find`, `grep`, `ls`) can always be compared.
- Write tools (`write`, `edit`, `bash`) modify the sandbox — subsequent tools see modified state.
- Diffs are reported but do not stop replay (unless `continue_on_diff: false`).

**Replay output formats** (for CLI consumption):
- `--format text` — human-readable step-by-step log with timestamps.
- `--format json` — JSONL stream of `ReplayStep` objects.
- `--format summary` — only `ReplaySummary` at the end.

#### 13.8 Design Decisions

- **Single `TraceRecorder` trait** — all subsystems (agent, TUI, plugins, provider) call into one recorder.
- **Background writer task** — recording never blocks the agent loop or TUI render thread.
- **Provider payloads hashed, not stored** — SHA-256 for privacy and size. Full payloads can be captured with a config flag for deep debugging, but default is hash-only.
- **Monotonic nanosecond timestamps** — `std::time::Instant::elapsed().as_nanos()` for ordering, not wall clock.
- **Optional zstd compression** — per-entry, preserving random access. Trades ~10% worse compression vs block-level for seekability.
- **FileHashSnapshot is incremental** — only files touched by tools, not full directory scans.
- **EnvSnapshot is selective** — only relevant env vars, not full environment.
- **Compare mode is sandboxed** — never re-executes against real filesystem unless explicitly configured.

## Tests

- **Trace recording**
  - Mock TraceRecorder records all agent events
  - Verify TraceCodec roundtrip (encode → decode)
  - FileTraceRecorder appends without blocking
  - Smart filter produces correct SessionEntry subset
  - TraceFileHeader write/read roundtrip
  - TraceCodec with zstd compression roundtrip
  - EnvSnapshot captures selective env vars
  - FileHashSnapshot captures only touched files
  - Snapshot emission on 10s interval and model change
- **Replay engine**
  - ReplayEngine::from_file loads trace correctly
  - Max speed replay processes all entries without delays
  - RealTime replay respects inter-event timing
  - Factor replay scales timing correctly
  - seek_to_turn skips to correct position
  - extract_session produces same entries as live session
  - extract_provider_trace pairs request/response correctly
- **Compare mode**
  - Read tool re-execution matches original output (same files)
  - Write tool re-execution produces diff when content changed
  - Compare mode continues on diff with continue_on_diff: true
  - Compare mode stops on first diff with continue_on_diff: false
- **Agent loop with mock stream** — most important test
  - Mock StreamFn returns TextDelta + Done
  - Agent emits AgentStart, MessageStart, TextDelta, MessageEnd, AgentEnd
  - Messages appended to state
- **Agent loop with tool calls**
  - Mock StreamFn returns ToolCall + Done
  - Agent executes tool, adds result, loops again
  - Second loop returns EndTurn
- **before_tool_call blocking**
  - Mock before_tool_call returns block=true
  - Tool not executed; error result added to messages
- **after_tool_call mutation**
  - Mock after_tool_call overrides content/details/is_error
  - Modified result added to messages
- **should_stop_after_turn**
  - Hook returns true after N turns
  - Agent emits AgentEnd and exits cleanly
- **prepare_next_turn**
  - Hook returns new model_id/thinking_level
  - Next turn uses updated config
- **ToolExecutionMode::Parallel**
  - Multiple tool calls execute concurrently
  - Results collected and added in source order
- **QueueMode::OneAtATime**
  - Steering queue drains one message per turn
  - Follow-up queue drains one message per turn
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
- [ ] Create `smith-core/src/events.rs` (EngineEvent wrapping AgentEvent)
- [ ] Create `smith-core/src/secret_proxy.rs`
- [ ] Create `smith-core/src/system_prompt.rs` (expanded)
- [ ] Create `smith-core/src/compaction.rs` (TokenEstimator)
- [ ] Create `smith-core/src/cost.rs` (CostTracker)
- [ ] Create `smith-core/src/trace.rs` (TraceEntry, TraceCodec, TraceRecorder, TraceFileHeader)
- [ ] Create `smith-core/src/replay.rs` (ReplayEngine, ReplaySpeed, ReplayMode, ReplayStep, ReplayDiff, ReplaySummary)
- [ ] Write agent loop tests (mock stream function)
- [ ] Write session/tool/hook/cost tests
- [ ] Write trace recording tests (codec, header, compression, snapshots)
- [ ] Write replay engine tests (speed modes, compare mode, fast-forward)
- [ ] Verify: `cargo check -p smith-core`
- [ ] Test: `cargo test -p smith-core`
- [ ] Commit: `jj describe -m "feat(SM-006): smith-core — agent loop, session, events, cost, compaction, trace, replay"`