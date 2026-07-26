//! Tool definition and execution types (SPEC §5.3).
//!
//! [`AgentTool`] is deliberately object-safe: the tool registry stores tools as
//! shared handles by name (§6.10), so the trait has to survive `dyn`. That is
//! why [`AgentTool::execute`] returns a boxed future rather than being written
//! as an `async fn` — an async method is not callable through `dyn`.

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::message::ContentBlock;

/// Whether a tool may run alongside others in the same turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExecutionMode {
    /// Run alone, in call order.
    ///
    /// The default: a tool that mutates the workspace is only safe this way,
    /// and a tool that has not said otherwise is assumed to mutate.
    #[default]
    Sequential,
    /// May run concurrently with other parallel-safe tools.
    Parallel,
}

/// Serializable tool metadata.
///
/// This is the form handed to a provider for function calling and published to
/// plugins; it holds no behavior, so it can cross a wire or a Lua boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinitionSpec {
    /// The name the model calls.
    pub name: String,
    /// What the tool does, written for the model.
    pub description: String,
    /// JSON Schema for the arguments, validated with `jsonschema` (§5.3).
    pub parameters: serde_json::Value,
    /// Whether the tool may run in parallel.
    #[serde(default)]
    pub execution_mode: ToolExecutionMode,
}

/// Runtime tool definition, as used by providers and the agent loop.
///
/// Distinct from [`ToolDefinitionSpec`] so that runtime-only fields can be
/// added later without changing the serialized shape that plugins and
/// providers already depend on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// The serializable metadata.
    #[serde(flatten)]
    pub spec: ToolDefinitionSpec,
}

impl ToolDefinition {
    /// Wraps a spec as a runtime definition.
    #[must_use]
    pub const fn new(spec: ToolDefinitionSpec) -> Self {
        Self { spec }
    }

    /// The name the model calls.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.spec.name
    }
}

/// Progress a tool recorded while it ran.
///
/// §5.3 surfaces these only inside the completed [`AgentToolResult`], so they
/// are a record of what happened rather than a live feed — nothing here moves a
/// progress indicator mid-run. Whether a long tool should be able to report
/// before it finishes is the open question on #132.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolUpdate {
    /// Human-readable progress.
    pub message: String,
}

/// What a tool produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolResult {
    /// The output, as content the model can read.
    pub content: Vec<ContentBlock>,
    /// Whether `content` describes a failure.
    ///
    /// A failed tool is not an error for the agent loop: the model is told and
    /// decides what to do next, which is why this is a flag rather than a
    /// `Result`.
    pub is_error: bool,
    /// Progress emitted while running.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub updates: Vec<AgentToolUpdate>,
}

impl AgentToolResult {
    /// A successful result carrying one text block.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text(text.into())],
            is_error: false,
            updates: Vec::new(),
        }
    }

    /// A failed result carrying one text block.
    #[must_use]
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text(text.into())],
            is_error: true,
            updates: Vec::new(),
        }
    }
}

/// A tool the agent loop can call.
///
/// `Send + Sync` because tools are shared across tasks by the registry
/// (§6.10). Arguments arrive as JSON and are validated against
/// [`ToolDefinitionSpec::parameters`] before `execute` is reached, so an
/// implementation reads its arguments rather than re-checking them.
pub trait AgentTool: Send + Sync {
    /// How this tool presents itself to the model.
    fn definition(&self) -> ToolDefinition;

    /// Runs the tool.
    ///
    /// Returns a boxed future so the trait stays object-safe; see the module
    /// documentation.
    fn execute(&self, arguments: serde_json::Value) -> BoxFuture<'_, AgentToolResult>;
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;

    use super::{
        AgentTool, AgentToolResult, ToolDefinition, ToolDefinitionSpec, ToolExecutionMode,
    };
    use crate::message::ContentBlock;

    struct Echo;

    impl AgentTool for Echo {
        fn definition(&self) -> ToolDefinition {
            ToolDefinition::new(ToolDefinitionSpec {
                name: "echo".to_owned(),
                description: "Returns its argument.".to_owned(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": { "text": { "type": "string" } },
                    "required": ["text"],
                }),
                execution_mode: ToolExecutionMode::Parallel,
            })
        }

        fn execute(&self, arguments: serde_json::Value) -> BoxFuture<'_, AgentToolResult> {
            async move {
                let text = arguments
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                AgentToolResult::text(text)
            }
            .boxed()
        }
    }

    #[test]
    fn a_tool_is_usable_behind_dyn() {
        // The registry stores tools as shared handles by name (§6.10), so the
        // trait has to survive both `dyn` and `Arc`. If this stops compiling,
        // the registry cannot be built on it.
        let tool: Arc<dyn AgentTool> = Arc::new(Echo);
        assert_eq!(tool.definition().name(), "echo");

        let result =
            futures::executor::block_on(tool.execute(serde_json::json!({ "text": "hello" })));
        assert!(!result.is_error);
        assert_eq!(result.content, vec![ContentBlock::Text("hello".to_owned())]);
    }

    #[test]
    fn a_definition_serializes_flat() {
        // Providers receive the spec's fields directly; a nested `spec` key
        // would not match any provider's function-calling shape.
        let definition = Echo.definition();
        let json = serde_json::to_value(&definition).unwrap();
        assert_eq!(
            json.get("name").and_then(serde_json::Value::as_str),
            Some("echo")
        );
        assert!(json.get("spec").is_none(), "the spec must flatten: {json}");

        let restored: ToolDefinition = serde_json::from_value(json).unwrap();
        assert_eq!(restored, definition);
    }

    #[test]
    fn a_definition_flattens_through_cbor_too() {
        // Inspect the encoded bytes, not a round-trip. A round-trip is invariant
        // to `#[serde(flatten)]`: drop the attribute and encoder and decoder
        // still agree with each other — nested — so the test stays green while
        // the wire shape has changed underneath it. Only the encoding says
        // whether the spec's fields sit at the top level.
        //
        // CBOR gets its own assertion rather than inheriting the JSON one at
        // :197 because CBOR is what §6.6 persists and what the §6.11 trace codec
        // will replay, and `flatten` forces a map encoding that self-describing
        // formats do not all treat alike.
        let definition = Echo.definition();
        let mut bytes = Vec::new();
        ciborium::into_writer(&definition, &mut bytes).unwrap();

        let encoded: ciborium::value::Value = ciborium::from_reader(bytes.as_slice()).unwrap();
        let map = encoded.as_map().unwrap();
        let keys: Vec<&str> = map.iter().filter_map(|(key, _)| key.as_text()).collect();

        assert!(
            !keys.contains(&"spec"),
            "the spec must flatten, not nest: {keys:?}"
        );
        for expected in ["name", "description", "parameters", "execution_mode"] {
            assert!(
                keys.contains(&expected),
                "{expected} must sit at the top level: {keys:?}"
            );
        }

        let restored: ToolDefinition = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert_eq!(restored, definition);
    }

    #[test]
    fn tools_are_sequential_unless_they_say_otherwise() {
        assert_eq!(ToolExecutionMode::default(), ToolExecutionMode::Sequential);
    }

    #[test]
    fn an_error_result_is_still_content() {
        let result = AgentToolResult::error("no such file");
        assert!(result.is_error);
        assert_eq!(
            result.content,
            vec![ContentBlock::Text("no such file".to_owned())]
        );
    }
}
