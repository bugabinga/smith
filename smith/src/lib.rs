//! Foundation types and interfaces for Smith.
//!
//! This crate owns the shapes every other crate shares and holds no business
//! logic. It has no dependency on any other workspace crate — the architecture
//! gate enforces that (SPEC §2.2) — which is what lets `smith-core` and
//! `smith-ai` be built and tested independently of each other.
//!
//! What is here, per SPEC §5:
//!
//! - identifiers and content (§5.1): [`EntryId`], [`SessionId`], [`SecretId`],
//!   [`VcsOpId`], [`Role`], [`ContentBlock`], [`Message`],
//! - the provider boundary (§5.2): [`ProviderUsage`], [`StopReason`],
//!   [`ThinkingLevel`], [`ProviderEvent`], [`ProviderError`],
//!   [`ProviderRequest`],
//! - tools (§5.3): [`AgentTool`], [`ToolDefinition`], [`ToolDefinitionSpec`],
//!   [`AgentToolResult`], [`AgentToolUpdate`], [`ToolExecutionMode`],
//! - the provider abstraction (§5.4): [`StreamFn`],
//! - the configuration schema (§5.6): [`Config`].
//!
//! Still to come, in the sections that own them: the Lua runtime (§5.5), model
//! resolution (§5.7), and the full error taxonomy (§5.8). Until those land,
//! [`ProviderError`] is the only error type this crate defines.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod config;
pub mod ids;
pub mod message;
pub mod provider;
pub mod stream;
pub mod tool;

pub use config::Config;
pub use ids::{EntryId, SecretId, SessionId, VcsOpId};
pub use message::{ContentBlock, Message, Role};
pub use provider::{
    ProviderError, ProviderEvent, ProviderRequest, ProviderUsage, StopReason, ThinkingLevel,
};
pub use stream::StreamFn;
pub use tool::{
    AgentTool, AgentToolResult, AgentToolUpdate, ToolDefinition, ToolDefinitionSpec,
    ToolExecutionMode,
};
