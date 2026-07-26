//! Roles, content blocks, and messages (SPEC §5.1).
//!
//! [`ContentBlock`] is the authoritative content representation: every other
//! shape in Smith that carries model-visible content carries these. Roles say
//! *who speaks*; what *happened* is a session entry kind (§6.5), not a role.
//! Tool results are therefore [`Role::Tool`] messages holding
//! [`ContentBlock::ToolResult`] — there is no separate tool-result role.

use serde::{Deserialize, Serialize};

/// Who is speaking in a [`Message`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// The system prompt.
    System,
    /// The person using Smith.
    User,
    /// The model.
    Assistant,
    /// A tool reporting back; carries [`ContentBlock::ToolResult`].
    Tool,
}

/// One unit of model-visible content.
///
/// Variants are externally tagged so that an unrecognized variant is
/// well-formed CBOR with an unknown tag rather than a decode failure, which is
/// what lets the session codec tell *unknown* from *corrupt* (§6.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text.
    Text(String),
    /// An image, carried inline.
    Image {
        /// Encoded image bytes, as supplied by the provider or the user.
        data: String,
        /// The IANA media type describing `data`, e.g. `image/png`.
        media_type: String,
    },
    /// The model asking for a tool to run.
    ToolCall {
        /// Correlates this call with its [`ContentBlock::ToolResult`].
        id: String,
        /// The tool being called.
        name: String,
        /// Arguments as JSON, validated against the tool's schema (§5.3).
        arguments: serde_json::Value,
    },
    /// The outcome of a tool call.
    ToolResult {
        /// The `id` of the [`ContentBlock::ToolCall`] this answers.
        id: String,
        /// What the tool produced, rendered for the model.
        result: String,
        /// Whether `result` describes a failure.
        is_error: bool,
    },
    /// Model reasoning.
    Thinking {
        /// The reasoning text.
        content: String,
        /// Provider-attached data that Smith never interprets.
        ///
        /// Anthropic's thinking signatures travel here. Smith stores the value
        /// untouched and replays it on later requests (§7.2) so that signed
        /// thinking round-trips across turns; a provider adapter is the only
        /// thing that may read it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<serde_json::Value>,
    },
}

/// One message in a conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// Who is speaking.
    pub role: Role,
    /// What was said, in order.
    pub content: Vec<ContentBlock>,
}

impl Message {
    /// Builds a message from a role and its content.
    #[must_use]
    pub const fn new(role: Role, content: Vec<ContentBlock>) -> Self {
        Self { role, content }
    }

    /// Builds a single-block text message.
    #[must_use]
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self::new(role, vec![ContentBlock::Text(text.into())])
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::panic,
    reason = "Test fixtures use unwrap and panic so failures report their exact operation."
)]
mod tests {
    use super::{ContentBlock, Message, Role};

    /// Encodes to CBOR and back, which is the codec sessions are stored in
    /// (§6.6) and therefore the one that has to preserve these shapes.
    fn cbor_round_trip(message: &Message) -> Message {
        let mut bytes = Vec::new();
        ciborium::into_writer(message, &mut bytes).unwrap();
        ciborium::from_reader(bytes.as_slice()).unwrap()
    }

    #[test]
    fn every_block_kind_survives_cbor() {
        let message = Message::new(
            Role::Assistant,
            vec![
                ContentBlock::Text("hello".to_owned()),
                ContentBlock::Image {
                    data: "AAAA".to_owned(),
                    media_type: "image/png".to_owned(),
                },
                ContentBlock::ToolCall {
                    id: "call-1".to_owned(),
                    name: "read".to_owned(),
                    arguments: serde_json::json!({ "path": "src/lib.rs" }),
                },
                ContentBlock::ToolResult {
                    id: "call-1".to_owned(),
                    result: "contents".to_owned(),
                    is_error: false,
                },
                ContentBlock::Thinking {
                    content: "considering".to_owned(),
                    provider_metadata: None,
                },
            ],
        );

        assert_eq!(cbor_round_trip(&message), message);
    }

    #[test]
    fn thinking_provider_metadata_is_preserved_opaquely() {
        // Smith never reads this value, so the test asserts only that whatever
        // the provider attached comes back byte-for-byte — including a nested
        // shape Smith has no type for.
        let metadata = serde_json::json!({
            "signature": "sig-abc",
            "nested": { "unknown_to_smith": [1, 2, 3] },
        });
        let message = Message::new(
            Role::Assistant,
            vec![ContentBlock::Thinking {
                content: "considering".to_owned(),
                provider_metadata: Some(metadata.clone()),
            }],
        );

        let restored = cbor_round_trip(&message);
        let ContentBlock::Thinking {
            provider_metadata, ..
        } = &restored.content[0]
        else {
            panic!("the thinking block must decode as a thinking block");
        };
        assert_eq!(provider_metadata.as_ref(), Some(&metadata));
    }

    #[test]
    fn absent_provider_metadata_stays_absent() {
        // The field is skipped when empty rather than written as null, so a
        // block that never had metadata does not grow a field on every rewrite.
        let message = Message::new(
            Role::Assistant,
            vec![ContentBlock::Thinking {
                content: "considering".to_owned(),
                provider_metadata: None,
            }],
        );
        let json = serde_json::to_string(&message).unwrap();
        assert!(
            !json.contains("provider_metadata"),
            "empty metadata must not be written: {json}"
        );
        assert_eq!(cbor_round_trip(&message), message);
    }

    #[test]
    fn messages_survive_json_as_well() {
        // `smith session dump` emits JSONL (§6.6), so the same shapes have to
        // survive JSON, not only CBOR.
        let message = Message::text(Role::User, "hello");
        let json = serde_json::to_string(&message).unwrap();
        let restored: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, message);
    }
}
