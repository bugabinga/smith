//! Prototype: Config parsing + CBOR roundtrip (SM-005 config types).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Config structure from SM-005 spec.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct SmithConfig {
    core: CoreConfig,
    ai: AiConfig,
    tui: TuiConfig,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct CoreConfig {
    editor: Option<String>,
    session_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct AiConfig {
    default_provider: String,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct TuiConfig {
    theme: Option<String>,
    mouse: bool,
}

fn main() {
    // Test config structure with hardcoded JSON (TOML parsing is a separate concern)
    let json_str = r#"{"core":{"editor":"vim","session_dir":"~/.local/share/smith/sessions"},"ai":{"default_provider":"openai","max_tokens":4096,"temperature":0.7},"tui":{"mouse":true,"theme":"default"}}"#;
    let config: SmithConfig = serde_json::from_str(json_str).expect("failed to parse config");

    println!("Config parsed OK:");
    println!("  core.editor = {:?}", config.core.editor);
    println!("  ai.default_provider = {}", config.ai.default_provider);
    println!("  ai.max_tokens = {}", config.ai.max_tokens);
    println!("  ai.temperature = {}", config.ai.temperature);
    println!("  tui.mouse = {}", config.tui.mouse);
    println!("  tui.theme = {:?}", config.tui.theme);

    assert_eq!(config.ai.default_provider, "openai");
    assert_eq!(config.ai.max_tokens, 4096);
    assert!(config.tui.mouse);

    // Test CBOR serialization of config (session storage format)
    let mut cbor_buf = Vec::new();
    ciborium::ser::into_writer(&config, &mut cbor_buf).expect("cbor encode failed");
    let decoded: SmithConfig = ciborium::de::from_reader(&cbor_buf[..]).expect("cbor decode failed");
    assert_eq!(decoded, config);
    println!("Config CBOR roundtrip OK: {} bytes", cbor_buf.len());

    println!("All config tests passed");
}
