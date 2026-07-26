//! Configuration schema (SPEC §5.6).
//!
//! Lua is the configuration language: Rust defines the schema, Lua supplies the
//! values, and the cascade (Rust defaults → built-in Lua → plugins → user config
//! → CLI flags) resolves them. This type is the Rust-defaults layer, and only
//! the part of it the walking skeleton needs — the cascade itself, the Lua
//! loader, and strict-context key checking arrive with the harness (§9.19).

use serde::{Deserialize, Serialize};

/// The resolved configuration the skeleton runs against.
///
/// Deliberately two fields. Every key here is one the walking skeleton reads to
/// run a turn; anything broader would be schema written ahead of a consumer,
/// which is what the §5.6 cascade would then have to keep honest for no gain.
/// Unknown top-level keys are tolerated rather than rejected. §5.6 says they
/// *warn* in the top-level schema context and *fail* only in strict contexts
/// (`models.*`, `compaction.*`), and this slice defines neither a strict
/// context nor the diagnostic channel a warning needs — both arrive with the
/// config loader (§9.19). Denying them here would be stricter than the spec and
/// would reject a valid wider config against this deliberately minimal schema.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The model to run, as a resolver name (§5.7) or a raw `provider/model`.
    pub model: String,
    /// Names of the tools to make available.
    pub tools: Vec<String>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "Test fixtures use unwrap so setup failures report their exact operation."
)]
mod tests {
    use super::Config;

    #[test]
    fn a_partial_config_fills_from_defaults() {
        // The cascade overrides layer by layer, so a layer that sets one key
        // must not blank the others.
        let config: Config =
            serde_json::from_str(r#"{ "model": "anthropic/claude-sonnet-4" }"#).unwrap();
        assert_eq!(config.model, "anthropic/claude-sonnet-4");
        assert!(config.tools.is_empty());
    }

    #[test]
    fn an_unknown_top_level_key_does_not_reject_the_config() {
        // §5.6 warns on unknown top-level keys rather than failing; failing is
        // reserved for strict contexts. A wider config than this minimal schema
        // knows about must therefore still load, with the keys it does know
        // intact. Emitting the warning belongs to the loader (§9.19).
        let config: Config = serde_json::from_str(
            r#"{ "model": "anthropic/claude-sonnet-4", "theme": "catppuccin" }"#,
        )
        .unwrap();
        assert_eq!(config.model, "anthropic/claude-sonnet-4");
    }

    #[test]
    fn a_config_round_trips() {
        let config = Config {
            model: "anthropic/claude-sonnet-4".to_owned(),
            tools: vec!["read".to_owned(), "bash".to_owned()],
        };
        let json = serde_json::to_string(&config).unwrap();
        assert_eq!(serde_json::from_str::<Config>(&json).unwrap(), config);
    }
}
