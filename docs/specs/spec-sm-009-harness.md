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
4. Bridge plugin events → agent loop hooks
5. Build system prompt

**Design docs:** `docs/design/PLUGIN-SDK-DESIGN.md`, `docs/plans/PLUGIN-DOC-PLAN.md`

## Key Design Decisions

1. **Agent loop is in smith-core** — this crate just wires it
2. **provider_to_stream_fn** — from smith-ai, creates the StreamFn for the agent
3. **Lua plugins** — SDK exposed via mlua globals
4. **Unified provider API** — `smith.provider.register()` adds/overrides
5. **30+ events** — AgentEvent (from smith-core) mapped to plugin SDK events
6. **Behavior-mutating event returns** — plugin handlers return typed results that modify agent behavior
7. **No sandbox enforcement** — Lua restricted runtime (no io/os/debug/package/require) is the only sandbox
8. **Documentation as code** — `---@` annotations are source of truth
9. **Features are Lua plugins** — Rust exposes primitives only; built-in features use the same SDK as user plugins
10. **VCS primitives are internal infrastructure** — `smith.vcs.*` wraps jj CLI + targeted gix queries; UI/commands/tools are Lua plugins

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
│   └── sdk.rs           — SDK registration into Lua globals
├── event_bridge.rs      — Maps AgentEvent → plugin SDK events + behavior mutation
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
    model_resolver: smith::ModelResolver,
    auth_resolver: FileAuthResolver,
    plugin_manager: PluginManager,
    tui: Option<TuiApp>,
    active_provider: Arc<dyn Provider>,
    active_model: ResolvedModel,
    active_model_id: String,
}

impl Harness {
    pub fn new(config: Config) -> Result<Self> {
        // 1. Load model registry from embedded JSON
        // 2. Build ModelResolver from config (aliases, groups, buckets)
        //    plus ModelRegistry metadata map (`provider/model` -> ModelMetadata)
        //    - Detect cycles at load time
        //    - Report errors with full resolution path
        // 3. Resolve active model: config.model -> ModelResolver -> ResolvedModel
        //    - ResolvedModel.metadata is required for AgentLoopConfig
        // 4. Load auth resolver
        // 5. Create providers from registry (with bucket account selection)
        // 6. Create StreamFn from active provider (MuxProvider if group/bucket)
        // 7. Create Agent with StreamFn
        // 8. Load plugins
        // 9. Register SDK into Lua
    }

    /// Wire the active provider into a StreamFn for the agent.
    /// If the resolved model is a group or bucket, creates a MuxProvider
    /// with failover/rotation strategy.
    fn wire_provider(&self) -> Box<smith::StreamFn> {
        provider_to_stream_fn(self.active_provider.clone())
    }

    /// Resolve a model name through the ModelResolver.
    /// Used by SDK `smith.set_model()` and plugin-driven model changes.
    pub fn resolve_model(&self, name: &str) -> Result<ResolvedModel, ResolveError> {
        self.model_resolver.resolve(name)
    }

    /// Build AgentLoopConfig, installing plugin-driven hooks.
    /// The event bridge translates plugin event results into hook behavior.
    fn build_loop_config(&self) -> AgentLoopConfig {
        AgentLoopConfig {
            before_tool_call: Some(Box::new(|ctx, signal| {
                self.event_bridge.before_tool_call_hook(ctx, signal)
            })),
            after_tool_call: Some(Box::new(|ctx, signal| {
                self.event_bridge.after_tool_call_hook(ctx, signal)
            })),
            should_stop_after_turn: Some(Box::new(|ctx| {
                self.event_bridge.should_stop_hook(ctx)
            })),
            prepare_next_turn: Some(Box::new(|ctx| {
                self.event_bridge.prepare_next_turn_hook(ctx)
            })),
            transform_context: Some(Box::new(|msgs, signal| {
                self.event_bridge.transform_context_hook(msgs, signal)
            })),
            convert_to_llm: Box::new(|msgs| {
                // Default: filter to user/assistant/tool_result only
                msgs.into_iter()
                    .filter(|m| matches!(m.role, Role::User | Role::Assistant | Role::ToolResult))
                    .collect()
            }),
            model_metadata: self.active_model.metadata.clone(),
            ..Default::default()
        }
    }

    pub async fn run_interactive(&mut self) -> Result<()>;
    pub async fn run_eval(&mut self, prompt: &str, json: bool) -> Result<String>;
    pub async fn run_rpc(&mut self) -> Result<()>;
}
```

### 4. Event Bridge — Agent Events ↔ Plugin Events + Behavior Mutation

The event bridge is the critical architectural link between the agent loop
(smith-core) and the plugin SDK (Lua handlers). It serves two roles:

1. **Observability:** Convert `AgentEvent` → `PluginEvent` → Lua table → handlers
2. **Behavior mutation:** Collect typed return values from handlers → feed back into `AgentLoopConfig` hooks

#### PluginEvent (30+ variants)

Events emitted to Lua plugins. All events are converted to Lua tables with a `type` field.

```rust
/// Events emitted to Lua plugins via the EventBridge.
#[derive(Clone, Debug, Serialize)]
pub enum PluginEvent {
    // === Agent lifecycle ===
    AgentStart,
    AgentEnd,
    TurnStart { turn_index: usize },
    TurnEnd { turn_index: usize },

    // === Message streaming ===
    MessageStart { message: Message },
    MessageUpdate { message: Message, delta: ContentBlock },
    MessageEnd { message: Message, usage: ProviderUsage, stop_reason: StopReason },
    TextDelta { delta: String },
    ThinkingDelta { delta: String },

    // === Tool execution ===
    ToolExecutionStart { tool_call_id: String, tool_name: String, args: serde_json::Value },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, result: Vec<ContentBlock>, is_error: bool },
    ToolExecutionUpdate { tool_call_id: String, tool_name: String, partial: String },
    ToolCall { tool_call_id: String, tool_name: String, input: serde_json::Value },
    ToolResult { tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool },

    // === Session lifecycle (inherited from pi) ===
    SessionStart { session_id: SessionId },
    SessionShutdown { session_id: SessionId },
    SessionBeforeSwitch { from_id: SessionId, to_id: SessionId },
    SessionBeforeFork { session_id: SessionId },
    SessionBeforeCompact { session_id: SessionId, token_count: u64 },
    SessionCompact { session_id: SessionId, tokens_before: u64, tokens_after: u64 },
    SessionBeforeTree { session_id: SessionId },
    SessionTree { session_id: SessionId },

    // === Agent loop control (inherited from pi) ===
    ShouldStopAfterTurn { message: Message, tool_results: Vec<ContentBlock>, new_messages: Vec<Message> },
    PrepareNextTurn { message: Message, tool_results: Vec<ContentBlock>, new_messages: Vec<Message> },

    // === Context & provider interception (inherited from pi) ===
    /// Fired before each LLM call. Handlers can mutate messages.
    Context { messages: Vec<Message> },
    /// Fired before provider HTTP request. Handlers can replace payload.
    BeforeProviderRequest { provider_id: String, model_id: String },
    /// Fired after provider HTTP response. Handlers can read status/headers.
    AfterProviderResponse { provider_id: String, model_id: String, status: u16 },

    // === Agent configuration (inherited from pi) ===
    /// Fired before agent loop starts. Handlers can override system prompt.
    BeforeAgentStart { system_prompt: String },
    /// Fired when model changes.
    ModelSelect { old_model: String, new_model: String },
    /// Fired when thinking level changes.
    ThinkingLevelSelect { old_level: ThinkingLevel, new_level: ThinkingLevel },

    // === User interaction (inherited from pi) ===
    /// Fired when user submits input. Handlers can transform or handle it.
    Input { text: String },
    /// Fired when user runs a ! command. Handlers can provide custom execution.
    UserBash { command: String },

    // === Discovery (inherited from pi) ===
    /// Fired on startup/reload. Handlers return additional paths.
    ResourcesDiscover,

    // === Error ===
    Error { message: String },
}
```

#### PluginEventResult — Behavior-Mutating Returns

Handlers return Lua tables that are converted to typed results. The last handler's
non-None field wins (no deep merge).

```rust
/// Typed result returned from plugin event handlers.
/// Each variant corresponds to a PluginEvent that supports behavior mutation.
/// The bridge collects these from all handlers and applies them.
#[derive(Clone, Debug, Default)]
pub enum PluginEventResult {
    /// No return value (observation-only event).
    #[default]
    None,

    // --- Input mutation ---
    /// Input event: continue unchanged, transform text, or mark as handled.
    Input {
        /// "continue" | "transform" | "handled"
        action: String,
        /// New text (only when action = "transform")
        text: Option<String>,
    },

    // --- Tool call mutation ---
    /// ToolCall event: block execution.
    ToolCallBlock { reason: Option<String> },

    // --- Tool result mutation ---
    /// ToolResult event: override content/details/isError/terminate.
    ToolResultOverride {
        content: Option<Vec<ContentBlock>>,
        details: Option<serde_json::Value>,
        is_error: Option<bool>,
        terminate: Option<bool>,
    },

    // --- Message mutation ---
    /// MessageEnd event: replace the finalized message.
    MessageEndReplace { message: Option<Message> },

    // --- Agent start mutation ---
    /// BeforeAgentStart event: override system prompt.
    BeforeAgentStartOverride { system_prompt: Option<String> },

    // --- Session cancellation ---
    /// SessionBefore* events: cancel the operation.
    SessionCancel { cancel: bool },

    // --- Agent loop control ---
    /// ShouldStopAfterTurn event: plugin vote to stop after current turn.
    ShouldStopAfterTurn { stop: bool },
    /// PrepareNextTurn event: suggest model/thinking level for next turn.
    PrepareNextTurn { model_id: Option<String>, thinking_level: Option<ThinkingLevel>, context: Option<AgentContext> },

    // --- Context mutation ---
    /// Context event: replace messages before LLM call.
    ContextReplace { messages: Option<Vec<Message>> },

    // --- Provider interception ---
    /// BeforeProviderRequest: replace request payload.
    ProviderRequestReplace { payload: Option<serde_json::Value> },

    // --- User bash replacement ---
    /// UserBash event: provide custom result.
    UserBashReplace {
        stdout: Option<String>,
        stderr: Option<String>,
        exit_code: Option<i32>,
    },

    // --- Resource discovery ---
    /// ResourcesDiscover: return additional paths.
    ResourcesDiscoverResult {
        skill_paths: Option<Vec<String>>,
        prompt_paths: Option<Vec<String>>,
        theme_paths: Option<Vec<String>>,
    },
}

impl PluginEventResult {
    /// Merge two results. `other` (later handler) wins for non-None fields.
    /// `None` (default) is always replaced by a concrete variant.
    /// Two different variants: `other` wins entirely (last handler wins).
    pub fn merge(self, other: PluginEventResult) -> PluginEventResult {
        match (self, other) {
            // None is always replaced
            (PluginEventResult::None, other) => other,
            (self_, PluginEventResult::None) => self_,

            // Same variant: merge fields (other wins per-field if non-None)
            (
                PluginEventResult::ToolResultOverride { content: c1, details: d1, is_error: e1 },
                PluginEventResult::ToolResultOverride { content: c2, details: d2, is_error: e2 },
            ) => PluginEventResult::ToolResultOverride {
                content: c2.or(c1),
                details: d2.or(d1),
                is_error: e2.or(e1),
            },

            (
                PluginEventResult::ResourcesDiscoverResult { skill_paths: s1, prompt_paths: p1, theme_paths: t1 },
                PluginEventResult::ResourcesDiscoverResult { skill_paths: s2, prompt_paths: p2, theme_paths: t2 },
            ) => PluginEventResult::ResourcesDiscoverResult {
                skill_paths: s2.or(s1),
                prompt_paths: p2.or(p1),
                theme_paths: t2.or(t1),
            },

            // Same variant: Input — other wins (action is atomic, not per-field)
            (
                PluginEventResult::Input { action: a1, text: t1 },
                PluginEventResult::Input { action: a2, text: t2 },
            ) => PluginEventResult::Input {
                action: if a2 != "continue" { a2 } else { a1 },
                text: t2.or(t1),
            },

            // Same variant: ToolCallBlock — if either blocks, block; merge reasons
            (
                PluginEventResult::ToolCallBlock { reason: r1 },
                PluginEventResult::ToolCallBlock { reason: r2 },
            ) => PluginEventResult::ToolCallBlock {
                reason: r2.or(r1),
            },

            // Same variant: MessageEndReplace — other wins entirely
            (
                PluginEventResult::MessageEndReplace { message: m1 },
                PluginEventResult::MessageEndReplace { message: m2 },
            ) => PluginEventResult::MessageEndReplace { message: m2.or(m1) },

            // Same variant: BeforeAgentStartOverride — other wins
            (
                PluginEventResult::BeforeAgentStartOverride { system_prompt: s1 },
                PluginEventResult::BeforeAgentStartOverride { system_prompt: s2 },
            ) => PluginEventResult::BeforeAgentStartOverride { system_prompt: s2.or(s1) },

            // Same variant: SessionCancel — if either cancels, cancel
            (
                PluginEventResult::SessionCancel { cancel: c1 },
                PluginEventResult::SessionCancel { cancel: c2 },
            ) => PluginEventResult::SessionCancel { cancel: c1 || c2 },

            // Same variant: ContextReplace — other wins
            (
                PluginEventResult::ContextReplace { messages: m1 },
                PluginEventResult::ContextReplace { messages: m2 },
            ) => PluginEventResult::ContextReplace { messages: m2.or(m1) },

            // Same variant: ProviderRequestReplace — other wins
            (
                PluginEventResult::ProviderRequestReplace { payload: p1 },
                PluginEventResult::ProviderRequestReplace { payload: p2 },
            ) => PluginEventResult::ProviderRequestReplace { payload: p2.or(p1) },

            // Same variant: UserBashReplace — other wins per-field
            (
                PluginEventResult::UserBashReplace { stdout: o1, stderr: e1, exit_code: c1 },
                PluginEventResult::UserBashReplace { stdout: o2, stderr: e2, exit_code: c2 },
            ) => PluginEventResult::UserBashReplace {
                stdout: o2.or(o1),
                stderr: e2.or(e1),
                exit_code: c2.or(c1),
            },

            // Different variants: other wins entirely
            (_, other) => other,
        }
    }

    /// Convert a Lua return value to PluginEventResult.
    /// Returns None for nil/missing returns (observation-only handlers).
    /// Returns PluginEventResult::None for empty tables.
    /// For known event types, extracts typed fields from the table.
    pub fn from_lua_table(event_name: &str, table: mlua::Value) -> Result<Option<Self>, String> {
        match table {
            mlua::Value::Nil => Ok(None),
            mlua::Value::Table(t) => {
                let result = match event_name {
                    "input" => PluginEventResult::Input {
                        action: t.get("action").unwrap_or_else(|_| "continue".into()),
                        text: t.get("text").ok(),
                    },
                    "should_stop_after_turn" => PluginEventResult::ShouldStopAfterTurn {
                        stop: t.get("stop").unwrap_or(false),
                    },
                    "prepare_next_turn" => PluginEventResult::PrepareNextTurn {
                        model_id: t.get("modelId").ok(),
                        thinking_level: t.get("thinkingLevel").ok(),
                        context: t.get("context").ok(),
                    },
                    "tool_call" => {
                        if t.get("block").unwrap_or(false) {
                            PluginEventResult::ToolCallBlock {
                                reason: t.get("reason").ok(),
                            }
                        } else {
                            PluginEventResult::None
                        }
                    },
                    "tool_result" => PluginEventResult::ToolResultOverride {
                        content: t.get("content").ok(),
                        details: t.get("details").ok(),
                        is_error: t.get("isError").ok(),
                        terminate: t.get("terminate").ok(),
                    },
                    "message_end" => PluginEventResult::MessageEndReplace {
                        message: t.get("message").ok(),
                    },
                    "before_agent_start" => PluginEventResult::BeforeAgentStartOverride {
                        system_prompt: t.get("systemPrompt").ok(),
                    },
                    "session_before_switch" | "session_before_fork"
                    | "session_before_compact" | "session_before_tree" => {
                        PluginEventResult::SessionCancel {
                            cancel: t.get("cancel").unwrap_or(false),
                        }
                    },
                    "context" => PluginEventResult::ContextReplace {
                        messages: t.get("messages").ok(),
                    },
                    "before_provider_request" => PluginEventResult::ProviderRequestReplace {
                        payload: t.get("payload").ok(),
                    },
                    "user_bash" => PluginEventResult::UserBashReplace {
                        stdout: t.get("stdout").ok(),
                        stderr: t.get("stderr").ok(),
                        exit_code: t.get("exitCode").ok(),
                    },
                    "resources_discover" => PluginEventResult::ResourcesDiscoverResult {
                        skill_paths: t.get("skillPaths").ok(),
                        prompt_paths: t.get("promptPaths").ok(),
                        theme_paths: t.get("themePaths").ok(),
                    },
                    unknown => {
                        log::warn!("Plugin returned unknown event result type: {}", unknown);
                        PluginEventResult::None
                    }
                };
                Ok(Some(result))
            }
            _ => Err(format!("Expected table or nil, got {:?}", table.type_name())),
        }
    }
}
```

#### Event Dispatch

**Security requirement (P15):** Lua hook dispatch MUST call registered functions with typed
arguments (`mlua::Function::call` or the registry-key equivalent). Never build Lua source
strings with interpolated user, tool, or provider data. String interpolation is a Lua
injection vector and must not be used for hook dispatch.

```rust
impl EventBridge {
    /// Map AgentEvent to one or more PluginEvents.
    fn agent_event_to_plugin_events(event: &AgentEvent) -> Vec<PluginEvent> {
        match event {
            AgentEvent::AgentStart => vec![PluginEvent::AgentStart],
            AgentEvent::AgentEnd { .. } => vec![PluginEvent::AgentEnd],
            AgentEvent::TurnStart { turn_index } => vec![PluginEvent::TurnStart { turn_index: *turn_index }],
            AgentEvent::TurnEnd { turn_index, .. } => vec![PluginEvent::TurnEnd { turn_index: *turn_index }],
            AgentEvent::MessageStart { message } => vec![PluginEvent::MessageStart { message: message.clone() }],
            AgentEvent::MessageUpdate { message, delta } => vec![PluginEvent::MessageUpdate { message: message.clone(), delta: delta.clone() }],
            AgentEvent::MessageEnd { message, usage, stop_reason } => {
                vec![PluginEvent::MessageEnd { message: message.clone(), usage: usage.clone(), stop_reason: *stop_reason }]
            }
            AgentEvent::ToolExecutionStart { tool_call_id, tool_name, args } => {
                vec![
                    PluginEvent::ToolExecutionStart { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), args: args.clone() },
                    PluginEvent::ToolCall { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), input: args.clone() },
                ]
            }
            AgentEvent::ToolExecutionEnd { tool_call_id, tool_name, result, is_error } => {
                vec![
                    PluginEvent::ToolExecutionEnd { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), result: result.clone(), is_error: *is_error },
                    PluginEvent::ToolResult { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), content: result.clone(), is_error: *is_error },
                ]
            }
            AgentEvent::ToolExecutionUpdate { tool_call_id, tool_name, partial } => {
                vec![PluginEvent::ToolExecutionUpdate { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), partial: partial.clone() }]
            }
            AgentEvent::ThinkingDelta { delta } => vec![PluginEvent::ThinkingDelta { delta: delta.clone() }],
            AgentEvent::TextDelta { delta } => vec![PluginEvent::TextDelta { delta: delta.clone() }],
            AgentEvent::Error { message } => vec![PluginEvent::Error { message: message.clone() }],
        }
    }

    /// Dispatch a PluginEvent to registered handlers.
    /// Records event + results to trace for replay.
    /// Returns accumulated PluginEventResult (merged across all handlers).
    fn dispatch_event(
        &self,
        event: &PluginEvent,
        handlers: &HashMap<String, Vec<mlua::RegistryKey>>,
        lua: &Lua,
    ) -> PluginEventResult {
        // Record plugin event to trace
        if let Some(trace) = &self.trace {
            trace.record(TraceEntry::PluginEvent {
                timestamp_ns: now_ns(),
                event_name: format!("{:?}", std::mem::discriminant(event)),
                event_json: serde_json::to_string(event).unwrap_or_default(),
            });
        }
        self.dispatch_event_with_signal(event, handlers, lua, None)
    }

    /// Dispatch with optional abort signal. The signal is exposed to Lua handlers
    /// via `smith.signal.is_aborted()` so long-running handlers can check it.
    fn dispatch_event_with_signal(
        &self,
        event: &PluginEvent,
        handlers: &HashMap<String, Vec<mlua::RegistryKey>>,
        lua: &Lua,
        signal: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> PluginEventResult {
        let event_name = self.event_to_name(event);
        let mut accumulated = PluginEventResult::None;

        for handler in handlers.get(event_name).unwrap_or(&vec![]) {
            let lua_event = match event.to_lua_table(lua) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!("PluginEvent to_lua_table failed: {}", e);
                    continue;
                }
            };
            // Build args: (event, signal_state) where signal_state is a boolean
            let signal_state = signal.map(|s| *s.borrow()).unwrap_or(false);
            let args = (lua_event, signal_state);
            let result: Result<mlua::Value, mlua::Error> = lua.call_function(handler.clone(), args);
            match result {
                Ok(return_val) => {
                    if let Some(parsed) = PluginEventResult::from_lua_table(event_name, return_val).ok().flatten() {
                        accumulated = accumulated.merge(parsed);
                    }
                }
                Err(e) => {
                    tracing::warn!("Plugin event handler '{}' error: {}", event_name, e);
                }
            }
        }
        accumulated
    }

    fn event_to_name(&self, event: &PluginEvent) -> &'static str {
        match event {
            PluginEvent::AgentStart => "agent_start",
            PluginEvent::AgentEnd => "agent_end",
            PluginEvent::TurnStart { .. } => "turn_start",
            PluginEvent::TurnEnd { .. } => "turn_end",
            PluginEvent::MessageStart { .. } => "message_start",
            PluginEvent::MessageUpdate { .. } => "message_update",
            PluginEvent::MessageEnd { .. } => "message_end",
            PluginEvent::ToolExecutionStart { .. } => "tool_execution_start",
            PluginEvent::ToolExecutionEnd { .. } => "tool_execution_end",
            PluginEvent::ToolExecutionUpdate { .. } => "tool_execution_update",
            PluginEvent::ToolCall { .. } => "tool_call",
            PluginEvent::ToolResult { .. } => "tool_result",
            PluginEvent::TextDelta { .. } => "text_delta",
            PluginEvent::ThinkingDelta { .. } => "thinking_delta",
            PluginEvent::SessionStart { .. } => "session_start",
            PluginEvent::SessionShutdown { .. } => "session_shutdown",
            PluginEvent::SessionBeforeSwitch { .. } => "session_before_switch",
            PluginEvent::SessionBeforeFork { .. } => "session_before_fork",
            PluginEvent::SessionBeforeCompact { .. } => "session_before_compact",
            PluginEvent::SessionCompact { .. } => "session_compact",
            PluginEvent::SessionBeforeTree { .. } => "session_before_tree",
            PluginEvent::SessionTree { .. } => "session_tree",
            PluginEvent::ShouldStopAfterTurn { .. } => "should_stop_after_turn",
            PluginEvent::PrepareNextTurn { .. } => "prepare_next_turn",
            PluginEvent::Context { .. } => "context",
            PluginEvent::BeforeProviderRequest { .. } => "before_provider_request",
            PluginEvent::AfterProviderResponse { .. } => "after_provider_response",
            PluginEvent::BeforeAgentStart { .. } => "before_agent_start",
            PluginEvent::ModelSelect { .. } => "model_select",
            PluginEvent::ThinkingLevelSelect { .. } => "thinking_level_select",
            PluginEvent::Input { .. } => "input",
            PluginEvent::UserBash { .. } => "user_bash",
            PluginEvent::ResourcesDiscover => "resources_discover",
            PluginEvent::Error { .. } => "error",
        }
    }
}
```

#### Feedback Loop: PluginEventResult → AgentLoopConfig Hooks

The harness installs `AgentLoopConfig` hook closures that delegate to the event bridge.
The bridge dispatches the corresponding plugin event, collects results, and translates
them into hook return types.

/// Helper: extract tool_call_id from a ToolCall.
fn extract_tool_call_id(tool_call: &ToolCall) -> String {
    tool_call.id.clone()
}

/// Helper: extract tool name from a ToolCall.
fn extract_tool_name(tool_call: &ToolCall) -> String {
    tool_call.name.clone()
}

```rust
impl EventBridge {
    /// AgentLoopConfig.before_tool_call hook implementation.
    /// Dispatches ToolCall event to plugins. If any handler returns ToolCallBlock,
    /// returns BeforeToolCallResult { block: true, reason }.
    fn before_tool_call_hook(
        &self,
        ctx: &BeforeToolCallContext,
        signal: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> BeforeToolCallResult {
        let event = PluginEvent::ToolCall {
            tool_call_id: extract_tool_call_id(&ctx.tool_call),
            tool_name: extract_tool_name(&ctx.tool_call),
            input: ctx.args.clone(),
        };
        let result = self.dispatch_event_with_signal(&event, &self.handlers, &self.lua, signal);
        match result {
            PluginEventResult::ToolCallBlock { reason } => BeforeToolCallResult {
                block: true,
                reason,
            },
            _ => BeforeToolCallResult { block: false, reason: None },
        }
    }

    /// AgentLoopConfig.after_tool_call hook implementation.
    /// Dispatches ToolResult event to plugins. Translates ToolResultOverride
    /// into AfterToolCallResult field overrides.
    fn after_tool_call_hook(
        &self,
        ctx: &AfterToolCallContext,
        signal: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> AfterToolCallResult {
        let event = PluginEvent::ToolResult {
            tool_call_id: extract_tool_call_id(&ctx.tool_call),
            tool_name: extract_tool_name(&ctx.tool_call),
            content: ctx.result.content.clone(),
            is_error: ctx.is_error,
        };
        let result = self.dispatch_event_with_signal(&event, &self.handlers, &self.lua, signal);
        match result {
            PluginEventResult::ToolResultOverride { content, details, is_error, terminate } => AfterToolCallResult {
                content,
                details,
                is_error,
                terminate,
            },
            _ => AfterToolCallResult::default(),
        }
    }

    /// AgentLoopConfig.transform_context hook implementation.
    /// Dispatches Context event. If handler returns ContextReplace, uses those messages.
    fn transform_context_hook(
        &self,
        messages: Vec<Message>,
        signal: Option<&tokio::sync::watch::Receiver<bool>>,
    ) -> Vec<Message> {
        let event = PluginEvent::Context { messages: messages.clone() };
        let result = self.dispatch_event_with_signal(&event, &self.handlers, &self.lua, signal);
        match result {
            PluginEventResult::ContextReplace { messages: Some(msgs) } => msgs,
            _ => messages,
        }
    }

    /// AgentLoopConfig.should_stop_after_turn hook.
    /// Dispatches ShouldStopAfterTurn event. If any handler returns
    /// ShouldStopAfterTurn { stop: true }, the agent stops after this turn.
    fn should_stop_hook(&self, ctx: &ShouldStopAfterTurnContext) -> bool {
        let event = PluginEvent::ShouldStopAfterTurn {
            message: ctx.message.clone(),
            tool_results: ctx.tool_results.clone(),
            new_messages: ctx.new_messages.clone(),
        };
        let result = self.dispatch_event(&event, &self.handlers, &self.lua);
        match result {
            PluginEventResult::ShouldStopAfterTurn { stop } => stop,
            _ => false,
        }
    }

    /// AgentLoopConfig.prepare_next_turn hook.
    /// Dispatches PrepareNextTurn event. Handlers can suggest model/thinking
    /// level changes for the next turn.
    fn prepare_next_turn_hook(
        &self,
        ctx: &ShouldStopAfterTurnContext,
    ) -> Option<AgentLoopTurnUpdate> {
        let event = PluginEvent::PrepareNextTurn {
            message: ctx.message.clone(),
            tool_results: ctx.tool_results.clone(),
            new_messages: ctx.new_messages.clone(),
        };
        let result = self.dispatch_event(&event, &self.handlers, &self.lua);
        match result {
            PluginEventResult::PrepareNextTurn { model_id, thinking_level, context } => {
                Some(AgentLoopTurnUpdate { model_id, thinking_level, context })
            }
            _ => None,
        }
    }
}
```

### 5. Extension Context — Plugin API Surface

#### ExtensionContext

Passed to every plugin handler. Provides agent control methods.

```rust
/// Context available to all plugin event handlers.
/// Wraps a reference to the Harness internals.
pub struct ExtensionContext {
    /// Current working directory.
    pub cwd: PathBuf,
    /// Whether the agent is currently idle (no pending LLM call or tool execution).
    pub is_idle: bool,
    /// Abort signal for the current operation.
    pub signal: Option<tokio::sync::watch::Receiver<bool>>,
    /// Whether there are pending messages in the steering/follow-up queues.
    pub has_pending_messages: bool,
    /// Current model identifier.
    pub model: String,
    /// Current system prompt snapshot.
    pub system_prompt: String,
    /// Estimated tokens in current LLM context.
    /// Source: smith-core `TokenEstimator` over `AgentState.messages` after `convert_to_llm`.
    pub token_count: u64,
    /// Active model context window.
    /// Source: `ResolvedModel.metadata.context_window` from smith-ai `ModelRegistry`.
    pub context_window: u64,
}

impl ExtensionContext {
    /// Abort the current agent operation.
    pub fn abort(&self) { /* sends true on abort signal */ }

    /// Trigger graceful shutdown of smith.
    pub fn shutdown(&self) { /* sends Shutdown event */ }

    /// Get current context usage (tokens, context window size, percentage).
    pub fn get_context_usage(&self) -> ContextUsage {
        ContextUsage {
            tokens: self.token_count,
            context_window: self.context_window,
            percent: if self.context_window == 0 { 0.0 } else { self.token_count as f64 / self.context_window as f64 },
        }
    }

    /// Trigger context compaction.
    pub fn compact(&self, options: Option<CompactOptions>) {
        // Delegates to smith-core CompactionExecutor
    }

    /// Read the current system prompt.
    pub fn get_system_prompt(&self) -> &str {
        &self.system_prompt
    }
}

/// Context usage information.
pub struct ContextUsage {
    pub tokens: u64,
    pub context_window: u64,
    pub percent: f64,
}

/// Options for triggering compaction.
pub struct CompactOptions {
    pub strategy: Option<String>,
    pub custom_instructions: Option<String>,
}
```

#### ExtensionCommandContext

Extended context for slash command handlers with session control.

```rust
/// Context for slash command handlers. Extends ExtensionContext with
/// session management capabilities.
pub struct ExtensionCommandContext {
    /// Base context fields.
    pub ctx: ExtensionContext,
    /// Wait for the agent to become idle before proceeding.
    pub wait_for_idle: Box<dyn Fn() -> Result<()> + Send + Sync>,
    /// Create a new session.
    pub new_session: Box<dyn Fn(NewSessionOptions) -> Result<NewSessionResult> + Send + Sync>,
    /// Fork the current session.
    pub fork: Box<dyn Fn(ForkOptions) -> Result<ForkResult> + Send + Sync>,
    /// Navigate the session tree.
    pub navigate_tree: Box<dyn Fn(NavigateTreeOptions) -> Result<()> + Send + Sync>,
    /// Switch to a different session.
    pub switch_session: Box<dyn Fn(SwitchSessionOptions) -> Result<()> + Send + Sync>,
    /// Reload plugins.
    pub reload: Box<dyn Fn() -> Result<()> + Send + Sync>,
}

/// Options for creating a new session.
pub struct NewSessionOptions {
    pub cwd: Option<PathBuf>,
    pub name: Option<String>,
}

/// Result of creating a new session.
pub struct NewSessionResult {
    pub session_id: SessionId,
}

/// Options for forking a session.
pub struct ForkOptions {
    pub name: Option<String>,
    pub skip_conversation_restore: Option<bool>,
}

/// Result of forking a session.
pub struct ForkResult {
    pub session_id: SessionId,
}

/// Options for navigating the session tree.
pub struct NavigateTreeOptions {
    pub entry_id: Option<EntryId>,
    pub direction: Option<String>, // "up" | "down" | "left" | "right"
}

/// Options for switching sessions.
pub struct SwitchSessionOptions {
    pub session_id: SessionId,
}
```

#### ExtensionUIContext

UI interaction capabilities for plugins. Only available when TUI is running.

```rust
/// UI context for plugin interaction. Available only when TUI is active.
pub struct ExtensionUIContext {
    /// Show a single-select dialog. Returns selected index or None if cancelled.
    pub select: Box<dyn Fn(&str, &[String]) -> Result<Option<usize>> + Send + Sync>,
    /// Show a yes/no confirmation. Returns user choice.
    pub confirm: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// Show a text input dialog. Returns entered text or None if cancelled.
    pub input: Box<dyn Fn(&str, Option<&str>) -> Option<String> + Send + Sync>,
    /// Show a notification toast.
    pub notify: Box<dyn Fn(&str) + Send + Sync>,
    /// Set the status bar text.
    pub set_status: Box<dyn Fn(&str) + Send + Sync>,
    /// Set the working message (shown during processing).
    pub set_working_message: Box<dyn Fn(Option<&str>) + Send + Sync>,
    /// Paste text into the editor.
    pub paste_to_editor: Box<dyn Fn(&str) + Send + Sync>,
    /// Get current editor text.
    pub get_editor_text: Box<dyn Fn() -> String + Send + Sync>,
    /// Set editor text.
    pub set_editor_text: Box<dyn Fn(&str) + Send + Sync>,
}
```

### 6. SDK API (exposed to Lua)

From `docs/design/PLUGIN-SDK-DESIGN.md`:

- `smith.tool.register(definition)` — registers AgentTool in tool registry
- `smith.on(event, handler)` — subscribes to events via event bridge
- `smith.command.register(name, options)` — slash commands
- `smith.shortcut.register(key, options)` — keyboard shortcuts
- `smith.provider.register(name, config)` — updates model registry
- `smith.provider.unregister(name)` — removes provider
- `smith.provider.unregister_model(provider, model_id)` — removes model
- `smith.alias.register(name, target)` — register model alias
- `smith.alias.unregister(name)` — remove alias
- `smith.group.register(name, members, strategy)` — register model group
- `smith.group.unregister(name)` — remove group
- `smith.bucket.register(name, provider, accounts, strategy)` — register provider bucket
- `smith.bucket.unregister(name)` — remove bucket
- `smith.tui.*` — layout + widget control
- `smith.fs.*` — filesystem access (paths validated against cwd)
- `smith.env.*` — read-only env access
- `smith.credentials.*` — credential management
- `smith.send_message(text, opts)` — inject messages into session
- `smith.send_user_message(text, opts)` — trigger turn with user message
- `smith.append_entry(type, data)` — persistent state not sent to LLM
- `smith.active_tools.set(names)` — change active tool set
- `smith.active_tools.get()` — get active tool names
- `smith.active_tools.all()` — get all registered tool info
- `smith.set_model(model_id)` — switch model
- `smith.get_thinking_level()` — read current thinking level
- `smith.set_thinking_level(level)` — change thinking level
- `smith.set_session_name(name)` — rename session
- `smith.get_session_name()` — read session name
- `smith.set_label(entry_id, label)` — bookmark session entry
- `smith.exec(command, opts)` — execute shell command
- `smith.get_commands()` — list registered slash commands
- `smith.events.emit(name, data)` — emit custom event
- `smith.events.on(name, handler)` — subscribe to custom events
- `smith.register_flag(name, opts)` — register CLI flag
- `smith.get_flag(name)` — read CLI flag value
- `smith.vcs.*` — VCS primitives for undo/history/diff/status (jj + gix backend)

#### Exec Types

```rust
/// Options for smith.exec().
pub struct ExecOptions {
    pub cwd: Option<PathBuf>,
    pub env: Option<HashMap<String, String>>,
    pub timeout: Option<Duration>,
    pub stdin: Option<String>,
}

/// Result from smith.exec().
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}
```

#### Command Types

```rust
/// Information about a registered slash command.
pub struct CommandInfo {
    pub name: String,
    pub description: Option<String>,
    pub source: SourceInfo,
}
```

#### Flag Types

```rust
/// Options for register_flag.
pub struct FlagOptions {
    pub type_name: String,  // "string" | "number" | "boolean"
    pub default: Option<serde_json::Value>,
    pub description: Option<String>,
}
```

#### VCS SDK Types

`smith.vcs.*` is the primitive layer for built-in and user Lua plugins. It is
not a feature UI. The backend uses jj CLI for operation-log mutations and
targeted gix APIs for structured read queries when parsing CLI text would be
fragile.

```rust
pub struct VcsOperation {
    pub id: String,
    pub description: String,
    pub timestamp_ns: u64,
}

pub struct VcsStatus {
    pub modified: Vec<PathBuf>,
    pub added: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
    pub renamed: Vec<(PathBuf, PathBuf)>,
    pub untracked: Vec<PathBuf>,
}

pub struct VcsDiff {
    pub files: Vec<PathBuf>,
    pub hunks: Vec<DiffHunk>,
    pub unified: String,
}

pub struct VcsAnnotationLine {
    pub line: usize,
    pub commit: String,
    pub author: Option<String>,
    pub timestamp_ns: Option<u64>,
    pub text: String,
}
```

#### `smith.vcs.*` primitives

Read-only:
- `smith.vcs.status()` → `VcsStatus`
- `smith.vcs.diff(opts)` → `VcsDiff` for current workspace or selected revs
- `smith.vcs.op_log(opts)` → `{ VcsOperation }`
- `smith.vcs.op_show(op_id)` → operation metadata + diff
- `smith.vcs.annotate(path, opts)` → `{ VcsAnnotationLine }`
- `smith.vcs.interdiff(from, to)` → patch-vs-patch diff (jj backend)
- `smith.vcs.evolog(rev)` → logical change evolution (jj backend)

Mutating:
- `smith.vcs.undo()` → `jj undo`
- `smith.vcs.redo()` → `jj redo`
- `smith.vcs.commit(message, opts)` → commit current tool changes and return `op_id`
- `smith.vcs.op_restore(op_id)` → restore repository to a previous jj operation
- `smith.vcs.restore_paths(paths, opts)` → selective file restore
- `smith.vcs.split(opts)`, `smith.vcs.squash(opts)`, `smith.vcs.parallelize(revs)`
- `smith.vcs.sparse(paths)` and `smith.vcs.workspace_add(name)`

All `op_id`, revision, and path inputs are validated before invoking jj. Paths
must stay inside the workspace. Commit messages must not begin with `-`, contain
NUL/newline, or exceed the configured length limit.

### 7. Built-in Plugins (Lua)

- `default-layout` — center: StatusBar + VirtualScroll + Editor + HintBar
- `read` — file read tool
- `write` — file write tool
- `edit` — file edit tool (find-and-replace)
- `bash` — shell command execution
- `find` — file discovery tool backed by the `ignore` crate
- `grep` — content search tool backed by ripgrep crates (`grep`, `grep-regex`, `grep-searcher`)
- `ls` — directory listing tool
- `commands` — slash commands, including `/undo`, `/redo`, and `/history`
- `time-travel` — timeline panel, state inspection, and diff views using `smith.vcs.*` + `smith.tui.*`
- `vcs-tools` — agent-visible VCS tools (`vcs_status`, `vcs_diff`, `vcs_blame`, `vcs_log`)

Built-in plugins are not privileged. They use the same Lua SDK as user plugins;
Rust core only exposes primitives.

### 7a. Plugin Load and Override Precedence

Plugin loading is deterministic. Registrations are materialized in this order:

1. Built-in plugins embedded with smith.
2. Global user plugins from `data_dir/smith/plugins/`, sorted by canonical path.
3. Plugins listed in user `config.lua`, in declaration order.
4. Project plugins from `<workspace>/.smith/plugins/`, sorted by canonical path.
5. Runtime registrations from already-loaded plugins.

Override rules:
- Tools, commands, shortcuts, providers, aliases, groups, buckets, flags, and
  message renderers are keyed by name; later registrations replace earlier ones.
- Event handlers do not replace. They append and run in materialization order;
  `PluginEventResult::merge` then applies last-handler-wins semantics per SM-009
  event bridge rules.
- Provider models merge by ID unless `replace_models = true`.
- `SourceInfo` records the winning registration source. Replacements emit a trace
  warning containing old and new source paths.
- SDK global names (`smith.*`) are reserved and cannot be replaced by plugins.

### 8. Built-in Tool Specifications

All built-in tools are implemented as Lua plugins using the same SDK as user plugins.

#### 8.1 `read`

```lua
-- parameters
{
    path       = { type = "string", required = true },
    offset     = { type = "number", required = false, default = 1 },
    limit      = { type = "number", required = false },
    read_limit = { type = "number", required = false, default = 500 },
}

-- execute
-- 1. Canonicalize path
-- 2. Read file via smith.fs.read(path)
-- 3. If offset/limit provided, slice lines
-- 4. Format as numbered lines for LLM context
-- 5. Return { content = lines }

-- errors
-- ENOPATH  : File not found
-- EISDIR   : Path is a directory
-- E2BIG    : File exceeds read_limit (default 500 lines); use offset/limit
```

#### 8.2 `write`

```lua
-- parameters
{
    path        = { type = "string", required = true },
    content     = { type = "string", required = true },
    create_dirs = { type = "boolean", required = false, default = true },
}

-- execute
-- 1. If create_dirs, mkdir -p parent
-- 2. Write atomically (temp file + rename)
-- 3. Return { path = path, bytes = #content }

-- errors
-- EIO   : Failed to write
```

#### 8.3 `edit`

```lua
-- parameters
{
    path           = { type = "string", required = true },
    old_text       = { type = "string", required = true },
    new_text       = { type = "string", required = true },
    allow_multiple = { type = "boolean", required = false, default = false },
}

-- execute
-- 1. Reject empty old_text
-- 2. Acquire workspace file-level mutex for path
-- 3. Read file and compute content hash
-- 4. Reject binary files (NUL byte scan)
-- 5. Normalize line endings for matching (preserve original line-ending style on write)
-- 6. Find old_text occurrences
-- 7. If !allow_multiple and count > 1 → fail
-- 8. Replace occurrences
-- 9. Re-read/hash before write; if changed since step 3 → fail stale
-- 10. Write back atomically (temp file + rename)
-- 11. Return { changes = count, before_hash = ..., after_hash = ... }

-- errors
-- ENOTFOUND : old_text not found
-- EMULTIPLE : old_text found multiple times (without allow_multiple)
-- EEMPTY    : old_text is empty
-- EBINARY   : binary file rejected
-- ESTALE    : file changed between read and write
-- ELOCK     : file mutex acquisition failed
```

Write-like SDK calls (`smith.fs.write`, `smith.fs.edit`, and any built-in tool
that mutates a known file path) must acquire the same canonical-path mutex. This
prevents parallel tool execution from silently losing writes. `bash` cannot be
fully locked because it may mutate arbitrary paths; its changes are captured by
the jj operation layer after execution.

#### 8.4 `bash`

```lua
-- parameters
{
    command = { type = "string", required = true },
    timeout = { type = "number", required = false, default = 120 },
    signal  = { type = "string", required = false, default = "SIGTERM" },
}

-- execute
-- 1. Spawn via tokio::process::Command
-- 2. Pipe stdout/stderr
-- 3. Apply timeout
-- 4. On timeout, send signal
-- 5. Return { stdout = ..., stderr = ..., exit_code = ..., timed_out = ... }

-- errors
-- ETIMEDOUT : Command timed out
-- EIO       : Failed to spawn

-- No confirmation gate. Bash executes freely.
-- Default timeout: 120s. Max output: 50KB per stream (truncated with notice).
-- Runs in smith's CWD, inherits smith's environment.
```

#### 8.5 `find`

```lua
-- parameters
{
    pattern = { type = "string", required = true },
    path    = { type = "string", required = false },
    limit   = { type = "number", required = false, default = 1000 },
}

-- execute
-- 1. Use `ignore::WalkBuilder` rooted at path/cwd
-- 2. Respect .gitignore/.ignore/global ignore files by default
-- 3. Match files by glob pattern via ignore/globset support
-- 4. Apply limit deterministically after path sort
-- 5. Return matching paths with sizes
```

#### 8.6 `grep`

```lua
-- parameters
{
    pattern    = { type = "string", required = true },
    path       = { type = "string", required = false },
    glob       = { type = "string", required = false },
    ignorecase = { type = "boolean", required = false, default = false },
    context    = { type = "number", required = false, default = 0 },
    limit      = { type = "number", required = false, default = 100 },
}

-- execute
-- 1. Use `ignore` for directory traversal and ignore rules
-- 2. Compile pattern with `grep-regex`
-- 3. Search files with `grep-searcher` (ripgrep engine)
-- 4. Skip binary files using searcher binary detection
-- 5. Apply context and limit
-- 6. Return matching lines with file:line:content
```

#### 8.7 `ls`

```lua
-- parameters
{
    path  = { type = "string", required = false, default = "." },
    limit = { type = "number", required = false, default = 500 },
}

-- execute
-- 1. List directory entries sorted alphabetically
-- 2. Return names with type indicator (/ for dirs)
```

### 8.8 Internal jj Integration

jj is an internal undo/history engine, transparent to users. Users are not
required to use jj as their project VCS.

On project open:
1. Initialize a colocated jj repo if one is missing.
2. Move actual `.jj` state to `$XDG_DATA_HOME/smith/<project-hash>/jj-state`.
3. Create `<project>/.jj` as a symlink to the XDG state directory.
4. Patch `.jj/repo/store/git_target` to an absolute `.git` path when the
   project is a colocated Git repo.

After each mutating tool (`write`, `edit`, `bash`, future mutators):
1. Capture pre/post VCS status.
2. Commit the tool mutation with a machine-readable message containing turn id,
   tool name, and tool call id.
3. Capture the resulting jj `op_id` and store it in trace entries.

The Lua plugins `commands`, `time-travel`, and `vcs-tools` consume this state via
`smith.vcs.*`. Rust core must not hard-code their UI behavior.

### 9. Lua → Rust Plugin Bridge

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
    message_renderers: Vec<(String, mlua::RegistryKey)>,
    flags: Vec<(String, FlagOptions)>,
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
// For each message renderer: LuaMessageRenderer
// SourceInfo recorded for each registration for error attribution
```

**Lua dispatch security:** Rust must call Lua handlers with typed values via
`mlua::Function::call()` / registry keys. Never build Lua source strings with
interpolated user, tool, path, or VCS data. String-built dispatch is a code
injection vector and is forbidden for production code.

#### Phase 4: Register

```rust
// tools → ToolRegistry (smith-core)
// events → EventBridge handler map
// commands → CommandRegistry
// providers → ModelRegistry (smith-ai)
// message_renderers → TUI renderer registry
// layout → TUI layout (applied after all plugins loaded)
```

**Error handling:** If any phase fails, the entire plugin fails to load. Error is logged
with plugin path + phase + detail. Other plugins continue loading.

**Source attribution:** Every registered tool, command, and shortcut carries `SourceInfo`
{ path, resolved_path } for error messages and debugging.

### 10. Sandbox — Restricted Lua Runtime

All sandbox enforcement is at the Lua runtime level. Plugins have no `io`, `os`, `debug`,
`package`, or `require` globals. This is the ONLY sandbox — no capability grants,
no policy files, no tiers.

```rust
/// Sets up a restricted Lua environment.
/// Removes: io, os, debug, package, require globals.
/// Replaces: print → logging bridge, dofile/loadfile → removed.
fn setup_restricted_lua(lua: &Lua) {
    let globals = lua.globals();
    globals.set("io", mlua::Value::Nil).ok();
    globals.set("os", mlua::Value::Nil).ok();
    globals.set("debug", mlua::Value::Nil).ok();
    globals.set("package", mlua::Value::Nil).ok();
    globals.set("require", mlua::Value::Nil).ok();
    globals.set("dofile", mlua::Value::Nil).ok();
    globals.set("loadfile", mlua::Value::Nil).ok();
}
```

Filesystem access is via `smith.fs.*` SDK functions which validate paths against CWD.
Subprocess execution is via the `bash` tool only.

### 11. Built-in Plugin Load Order

Load order:
1. `read` (tool registration)
2. `write` (tool registration)
3. `edit` (tool registration)
4. `bash` (tool registration)
5. `find` (tool registration)
6. `grep` (tool registration)
7. `ls` (tool registration)
8. `commands` (slash commands such as `/undo`, `/redo`, `/history`)
9. `vcs-tools` (agent-visible VCS tools)
10. `time-travel` (shortcuts + panels using TUI primitives)
11. `default-layout` (TUI layout setup)

Override rules:
- User plugins load after built-ins.
- Last `smith.tool.register()` for a given name wins.
- Last `smith.tui.set_center_layout()` wins.
- Events are additive (all handlers fire).

Disable built-in: A user plugin can call `smith.active_tools.set({...})` excluding
a built-in tool name. The tool definition won't be sent to the LLM.

### 12. Documentation Files

```
smith-harness/src/lua/sdk/
├── smith_tool.lua         — annotations + @usage
├── smith_provider.lua
├── smith_command.lua
├── smith_shortcut.lua
├── smith_tui.lua
├── smith_fs.lua
├── smith_vcs.lua
├── smith_env.lua
├── smith_credentials.lua
├── smith_events.lua
├── smith_context.lua      — ExtensionContext docs
├── smith_ui.lua           — ExtensionUIContext docs
├── guides/
│   ├── getting-started.lua
│   ├── tools.lua
│   ├── events.lua
│   ├── providers.lua
│   ├── tui.lua
│   ├── behavior-mutation.lua  — event result types and merge semantics
│   └── vcs.lua                — undo/history/time-travel primitives
└── examples/
    ├── 01-hello-world.lua through 16-vcs-time-travel.lua
```

## Tests

- Harness wires provider → StreamFn → Agent correctly
- Agent loop runs with real provider types (mock HTTP)
- Plugin loader: load Lua file, execute factory function
- Plugin manager: load order (built-in → global → config-listed → project → runtime)
- Plugin manager: deterministic override precedence and replacement trace warnings
- SDK: register_tool creates AgentTool in registry
- SDK: provider.register updates model registry with merge
- Event bridge: AgentEvent maps to correct PluginEvent variants
- Event bridge: PluginEventResult merge (last handler wins, field-level merge for same variant)
- Event bridge: before_tool_call_hook translates ToolCallBlock → BeforeToolCallResult
- Event bridge: after_tool_call_hook translates ToolResultOverride → AfterToolCallResult
- Event bridge: transform_context_hook translates ContextReplace → message replacement
- Event bridge: SessionBefore* events dispatch and collect SessionCancel results
- ExtensionContext: abort/shutdown/get_context_usage/compact/get_system_prompt
- ExtensionCommandContext: new_session/fork/switch_session/reload
- LuaAgentTool: executes Lua function via RegistryKey
- Built-in tools: read, write, edit, bash, find, grep, ls
- Built-in plugins: commands, time-travel, vcs-tools
- SDK: smith.vcs undo/redo/status/diff/op_log/op_show/restore_paths/annotate
- VCS: jj state relocated to XDG with `.jj` symlink and absolute git_target
- VCS: mutating tool execution stores jj op_id in trace entries
- Edit tool: file-level mutex prevents parallel write races
- Edit tool: stale hash, empty old_text, binary file, and multiple-match errors
- Find tool: uses `ignore` and respects ignore files
- Grep tool: uses `grep`/`grep-regex`/`grep-searcher`
- Lua dispatch: no string-interpolated Lua calls; only `mlua::Function::call`
- PluginEventResult::from_lua_table for all event types
- Inter-plugin events: emit/on via EventBus
- SourceInfo attribution on registered tools/commands

## Steps

- [ ] Create `smith-harness/Cargo.toml`
- [ ] Create `smith-harness/src/lib.rs`
- [ ] Create `smith-harness/src/harness.rs` (wiring layer + build_loop_config)
- [ ] Create `smith-harness/src/event_bridge.rs` (PluginEvent, PluginEventResult, dispatch, hooks)
- [ ] Create `smith-harness/src/plugins/` (manager, loader, sdk)
- [ ] Create `smith-harness/src/plugins/builtin/` (read, write, edit, bash, find, grep, ls, commands, vcs-tools, time-travel, default-layout)
- [ ] Create `smith-harness/src/lua/sdk/` (all SDK annotation files)
- [ ] Create `smith-harness/src/lua/sdk/guides/`
- [ ] Create `smith-harness/src/lua/sdk/examples/` (15 examples)
- [ ] Create `smith-harness/src/commands.rs`
- [ ] Create `smith-harness/src/help.rs`
- [ ] Implement SDK bindings
- [ ] Implement Lua → Rust plugin bridge (4-phase pipeline)
- [ ] Implement LuaAgentTool struct with SourceInfo
- [ ] Implement behavior-mutating event dispatch and hook feedback
- [ ] Implement built-in plugins
- [ ] Implement restricted Lua runtime setup
- [ ] Implement `smith help`
- [ ] Write tests
- [ ] Verify: `cargo check -p smith-harness`
- [ ] Test: `cargo test -p smith-harness`
- [ ] Commit: `jj describe -m "feat(SM-009): smith-harness — orchestrator, plugin SDK, behavior-mutating events"`
