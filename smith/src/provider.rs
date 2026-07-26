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
    fn provider_errors_serialize_as_adjacent_kind_and_message() {
        // `kind` preserves failover classification while `message` keeps the
        // human context; their adjacent JSON form is a wire contract.
        let cases = [
            (
                ProviderError::RateLimit("try later".to_owned()),
                r#"{"kind":"rate_limit","message":"try later"}"#,
            ),
            (
                ProviderError::AuthFailed("bad token".to_owned()),
                r#"{"kind":"auth_failed","message":"bad token"}"#,
            ),
            (
                ProviderError::Network("connection reset".to_owned()),
                r#"{"kind":"network","message":"connection reset"}"#,
            ),
            (
                ProviderError::ServerError("overloaded".to_owned()),
                r#"{"kind":"server_error","message":"overloaded"}"#,
            ),
            (
                ProviderError::InvalidRequest("invalid tool".to_owned()),
                r#"{"kind":"invalid_request","message":"invalid tool"}"#,
            ),
            (
                ProviderError::ModelNotFound("missing model".to_owned()),
                r#"{"kind":"model_not_found","message":"missing model"}"#,
            ),
            (
                ProviderError::Timeout("deadline exceeded".to_owned()),
                r#"{"kind":"timeout","message":"deadline exceeded"}"#,
            ),
        ];

        for (error, expected) in cases {
            assert_eq!(serde_json::to_string(&error).unwrap(), expected);
        }
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
