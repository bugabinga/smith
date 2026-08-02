//! Provider-facing request, event, and error types (SPEC §5.2).
//!
//! These describe what a provider is *asked* and what it *emits*, without
//! naming any provider. `smith-core` consumes them through [`StreamFn`]
//! (§5.4), which is why the agent loop can be built and tested with no
//! provider present.
//!
//! [`StreamFn`]: crate::StreamFn

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::message::Message;
use crate::tool::ToolDefinition;

/// Token accounting for one exchange.
///
/// Cache counters are separate because providers price them separately; a
/// total that folded them in could not be re-derived.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderUsage {
    /// Tokens in the request.
    pub input: u64,
    /// Tokens the model produced.
    pub output: u64,
    /// Tokens served from a prompt cache.
    pub cache_read: u64,
    /// Tokens written into a prompt cache.
    pub cache_write: u64,
    /// Total tokens attributed to the exchange.
    pub total: u64,
}

/// Why a provider stopped producing output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The model finished its turn.
    EndTurn,
    /// The model wants a tool to run.
    ToolUse,
    /// The token limit was reached first.
    OverMaxTokens,
    /// The run was cancelled.
    Aborted,
    /// A configured stop sequence matched.
    StopSequence,
    /// The run ended in an error.
    Error,
}

/// How much reasoning to request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    /// No reasoning requested.
    #[default]
    Off,
    /// The smallest budget the provider offers.
    Minimal,
    /// A low budget.
    Low,
    /// A moderate budget.
    Medium,
    /// A high budget.
    High,
    /// The largest budget the provider offers.
    XHigh,
}

/// One item in the stream a provider produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderEvent {
    /// A fragment of assistant text.
    TextDelta {
        /// The fragment.
        text: String,
    },
    /// A fragment of model reasoning.
    ThinkingDelta {
        /// The fragment.
        text: String,
        /// Provider-attached data that Smith never interprets.
        ///
        /// The provider adapter attaches signed-thinking metadata to the delta
        /// whose text it authenticates. The agent loop later carries it into
        /// [`ContentBlock::Thinking`](crate::ContentBlock::Thinking) for
        /// replay on later requests (§5.4).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<serde_json::Value>,
    },
    /// A complete tool call.
    ///
    /// Assembled and whole: providers stream tool arguments in fragments, and
    /// those are joined at the provider boundary (§7.2). Nothing downstream
    /// ever sees a partial call, so no consumer needs reassembly logic.
    ToolCall {
        /// Correlates with the eventual tool result.
        id: String,
        /// The tool being called.
        name: String,
        /// Complete JSON arguments.
        arguments: serde_json::Value,
    },
    /// The stream finished.
    Done {
        /// Token accounting for the exchange.
        usage: ProviderUsage,
        /// Why it stopped.
        stop_reason: StopReason,
    },
    /// The stream failed.
    Error(ProviderError),
}

/// A provider failure, classified by what a caller can do about it.
///
/// The variants are the failover-relevant classification `MuxProvider` reads
/// (§7.5): they distinguish *try another provider* from *stop and tell the
/// user*, which a single opaque error could not.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "message")]
pub enum ProviderError {
    /// The provider is rate-limiting the caller.
    #[error("rate limited: {0}")]
    RateLimit(String),
    /// Credentials were missing, malformed, or rejected.
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    /// The request never completed at the transport layer.
    #[error("network error: {0}")]
    Network(String),
    /// The provider reported a fault on its side.
    #[error("server error: {0}")]
    ServerError(String),
    /// The request was malformed or unacceptable.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// The named model does not exist for this provider.
    #[error("model not found: {0}")]
    ModelNotFound(String),
    /// The request exceeded its time budget.
    #[error("timed out: {0}")]
    Timeout(String),
}

/// Everything a provider needs to answer one turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRequest {
    /// Conversation so far, oldest first.
    pub messages: Vec<Message>,
    /// System prompt, when one applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Which provider to address.
    pub provider_id: String,
    /// Which model to address on that provider.
    pub model_id: String,
    /// Tools the model may call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    /// How much reasoning to request.
    #[serde(default)]
    pub thinking: ThinkingLevel,
    /// Cap on tokens the model may produce.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Sequences that end the turn when produced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_sequences: Vec<String>,
}

impl ProviderRequest {
    /// Builds a request addressing `model_id` on `provider_id`.
    ///
    /// The optional fields default to empty; a caller sets only what it needs,
    /// which keeps the skeleton's call sites honest about what they rely on.
    #[must_use]
    pub fn new(
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        messages: Vec<Message>,
    ) -> Self {
        Self {
            messages,
            system: None,
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            tools: Vec::new(),
            thinking: ThinkingLevel::Off,
            max_tokens: None,
            stop_sequences: Vec::new(),
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::{ProviderError, ProviderEvent, ProviderRequest, ProviderUsage, StopReason};
    use crate::message::{Message, Role};

    #[test]
    fn events_survive_cbor() {
        let events = vec![
            ProviderEvent::TextDelta {
                text: "hel".to_owned(),
            },
            ProviderEvent::ThinkingDelta {
                text: "hmm".to_owned(),
                provider_metadata: None,
            },
            ProviderEvent::ToolCall {
                id: "call-1".to_owned(),
                name: "read".to_owned(),
                arguments: serde_json::json!({ "path": "x" }),
            },
            ProviderEvent::Done {
                usage: ProviderUsage {
                    input: 10,
                    output: 5,
                    cache_read: 1,
                    cache_write: 2,
                    total: 18,
                },
                stop_reason: StopReason::EndTurn,
            },
            ProviderEvent::Error(ProviderError::RateLimit("slow down".to_owned())),
        ];

        let mut bytes = Vec::new();
        ciborium::into_writer(&events, &mut bytes).unwrap();
        let restored: Vec<ProviderEvent> = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert_eq!(restored, events);
    }

    #[test]
    fn a_thinking_delta_preserves_opaque_provider_metadata_through_cbor() {
        let event = ProviderEvent::ThinkingDelta {
            text: "hmm".to_owned(),
            provider_metadata: Some(serde_json::json!({
                "signature": "sig-abc",
                "unrecognized": { "nested": [1, 2, 3] },
            })),
        };

        let mut bytes = Vec::new();
        ciborium::into_writer(&event, &mut bytes).unwrap();
        let restored: ProviderEvent = ciborium::from_reader(bytes.as_slice()).unwrap();

        assert_eq!(restored, event);
    }

    #[test]
    fn a_thinking_delta_omits_absent_provider_metadata() {
        let event = ProviderEvent::ThinkingDelta {
            text: "hmm".to_owned(),
            provider_metadata: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(
            !json.contains("provider_metadata"),
            "absent metadata must not be serialized: {json}"
        );

        let restored: ProviderEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, event);
    }

    /// Maps each variant to the `kind` string it must serialize as.
    ///
    /// Deliberately wildcard-free: an eighth `ProviderError` variant stops this
    /// compiling, which is what forces a new kind through the wire-shape test
    /// rather than letting it ship unpinned. A hand-written list would catch
    /// renames but not additions.
    fn expected_kind(error: &ProviderError) -> &'static str {
        match error {
            ProviderError::RateLimit(_) => "rate_limit",
            ProviderError::AuthFailed(_) => "auth_failed",
            ProviderError::Network(_) => "network",
            ProviderError::ServerError(_) => "server_error",
            ProviderError::InvalidRequest(_) => "invalid_request",
            ProviderError::ModelNotFound(_) => "model_not_found",
            ProviderError::Timeout(_) => "timeout",
        }
    }

    #[test]
    fn the_provider_error_wire_shape_is_pinned() {
        // §7.5's MuxProvider reads the `kind` string to decide failover, so a
        // rename that both sides follow keeps every round-trip green while
        // silently turning classification into a default. Pinning the literal is
        // what makes such a rename visible: this asserts the wire form, not that
        // serialization is self-consistent.
        let encoded =
            serde_json::to_value(ProviderError::RateLimit("slow down".to_owned())).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({ "kind": "rate_limit", "message": "slow down" })
        );

        let all = [
            ProviderError::RateLimit(String::new()),
            ProviderError::AuthFailed(String::new()),
            ProviderError::Network(String::new()),
            ProviderError::ServerError(String::new()),
            ProviderError::InvalidRequest(String::new()),
            ProviderError::ModelNotFound(String::new()),
            ProviderError::Timeout(String::new()),
        ];
        for error in &all {
            let encoded = serde_json::to_value(error).unwrap();
            assert_eq!(
                encoded.get("kind").and_then(serde_json::Value::as_str),
                Some(expected_kind(error)),
                "{error:?} must stay on the wire as {}",
                expected_kind(error)
            );
        }
    }

    #[test]
    fn provider_errors_carry_their_message() {
        // The classification drives failover; the message is what reaches the
        // user, so it must not be swallowed by the variant name.
        let error = ProviderError::AuthFailed("no ANTHROPIC_API_KEY".to_owned());
        assert_eq!(
            error.to_string(),
            "authentication failed: no ANTHROPIC_API_KEY"
        );
    }

    #[test]
    fn a_request_omits_what_it_does_not_set() {
        let request = ProviderRequest::new(
            "anthropic",
            "claude-sonnet-4",
            vec![Message::text(Role::User, "hi")],
        );
        let json = serde_json::to_string(&request).unwrap();
        assert!(!json.contains("system"), "unset system must not appear");
        assert!(
            !json.contains("stop_sequences"),
            "empty lists must not appear"
        );
        let restored: ProviderRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, request);
    }
}
