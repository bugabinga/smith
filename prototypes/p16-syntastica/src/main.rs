//! P16: syntastica syntax highlighting prototype

use syntastica::renderer::TerminalRenderer;
use syntastica::Processor;
use syntastica::language_set::SupportedLanguage;
use syntastica_parsers::{Lang, LanguageSetImpl};

fn main() {
    println!("=== P16: syntastica syntax highlighting prototype ===\n");

    // T1: Rust highlighting
    test_rust();

    // T2: Lua highlighting
    test_lua();

    // T3: JavaScript highlighting
    test_javascript();

    // T4: TypeScript highlighting
    test_typescript();

    // T5: File type detection
    test_file_type_detection();

    // T6: Processor reuse (multiple languages)
    test_processor_reuse();

    // T7: Multiple themes for same code
    test_multiple_themes();

    // T8: Custom theme via theme! macro
    test_custom_theme();

    // T9: HTML rendering
    test_html_render();

    println!("\n=== ALL 9 TESTS PASSED ===");
}

fn test_rust() {
    let code = r#"fn main() {
    let agent = Agent::new("smith");
    match agent.run() {
        Ok(result) => println!("Result: {result}"),
        Err(e) => eprintln!("Error: {e}"),
    }
}"#;

    let output = syntastica::highlight(
        code,
        Lang::Rust,
        &LanguageSetImpl::new(),
        &mut TerminalRenderer::new(None),
        syntastica_themes::gruvbox::dark(),
    ).unwrap_or_else(|err| panic!("[FAIL] Rust highlighting: {err}"));

    println!("T1 Rust:");
    println!("{output}");
    assert!(!output.is_empty(), "[FAIL] Rust output empty");
    println!("T1 ✅ PASS\n");
}

fn test_lua() {
    let code = r#"-- Lua plugin for smith
local function tool_call_transform(name, args)
    if name == "bash" then
        return string.format("exec: %s %s", name, args)
    end
    return args
end

return {
    hooks = {
        tool_call = tool_call_transform,
        context = function(ctx) return ctx end,
    }
}"#;

    let output = syntastica::highlight(
        code,
        Lang::Lua,
        &LanguageSetImpl::new(),
        &mut TerminalRenderer::new(None),
        syntastica_themes::gruvbox::dark(),
    ).unwrap_or_else(|err| panic!("[FAIL] Lua highlighting: {err}"));

    println!("T2 Lua:");
    println!("{output}");
    assert!(!output.is_empty(), "[FAIL] Lua output empty");
    println!("T2 ✅ PASS\n");
}

fn test_javascript() {
    let code = r#"const express = require('express');
const app = express();

app.get('/api/agent', (req, res) => {
    const { model, provider } = req.query;
    res.json({ status: 'ok', model });
});

app.listen(3000);"#;

    let output = syntastica::highlight(
        code,
        Lang::Javascript,
        &LanguageSetImpl::new(),
        &mut TerminalRenderer::new(None),
        syntastica_themes::one::dark(),
    ).unwrap_or_else(|err| panic!("[FAIL] JS highlighting: {err}"));

    println!("T3 JavaScript:");
    println!("{output}");
    assert!(!output.is_empty(), "[FAIL] JS output empty");
    println!("T3 ✅ PASS\n");
}

fn test_typescript() {
    let code = r#"interface AgentConfig {
    model: string;
    provider: string;
    maxTokens: number;
}

const createAgent = (config: AgentConfig): Agent => {
    return new Agent(config.model, config.provider);
};"#;

    let output = syntastica::highlight(
        code,
        Lang::Typescript,
        &LanguageSetImpl::new(),
        &mut TerminalRenderer::new(None),
        syntastica_themes::one::dark(),
    ).unwrap_or_else(|err| panic!("[FAIL] TS highlighting: {err}"));

    println!("T4 TypeScript:");
    println!("{output}");
    assert!(!output.is_empty(), "[FAIL] TS output empty");
    println!("T4 ✅ PASS\n");
}

fn test_file_type_detection() {
    // Detect from path
    let ft = tft::detect("main.rs", "");
    let lang = Lang::for_file_type(ft, &()).expect("[FAIL] no lang for .rs");
    assert!(matches!(lang, Lang::Rust), "[FAIL] expected Rust, got {lang:?}");

    let ft_lua = tft::detect("plugin.lua", "");
    let lang_lua = Lang::for_file_type(ft_lua, &()).expect("[FAIL] no lang for .lua");
    assert!(matches!(lang_lua, Lang::Lua), "[FAIL] expected Lua, got {lang_lua:?}");

    // TS: tft may need content hint — test .tsx instead
    let ft_tsx = tft::detect("App.tsx", "");
    let lang_tsx = Lang::for_file_type(ft_tsx, &());
    println!("  .tsx detection: {lang_tsx:?}");

    // .ts: check what tft returns (may not map to TS without content)
    let ft_ts = tft::detect("index.ts", "");
    let lang_ts = Lang::for_file_type(ft_ts, &());
    println!("  .ts detection: {lang_ts:?}");
    // Accept any result for .ts (tft mapping may vary)

    // Unknown extension
    let ft_unknown = tft::detect("data.xyz", "");
    let lang_unknown = Lang::for_file_type(ft_unknown, &());
    assert!(lang_unknown.is_none(), "[FAIL] expected None for .xyz, got {lang_unknown:?}");

    println!("T5 File type detection: ✅ PASS (.rs→Rust, .lua→Lua, .xyz→None)\n");
}

fn test_processor_reuse() {
    let language_set = LanguageSetImpl::new();
    let mut processor = Processor::new(&language_set);

    let rust_hl = processor.process(
        "fn hello() -> String { \"world\".to_string() }",
        Lang::Rust,
    ).unwrap_or_else(|err| panic!("[FAIL] processor Rust: {err}"));

    let lua_hl = processor.process(
        "local x = 42",
        Lang::Lua,
    ).unwrap_or_else(|err| panic!("[FAIL] processor Lua: {err}"));

    let js_hl = processor.process(
        "const x = 42;",
        Lang::Javascript,
    ).unwrap_or_else(|err| panic!("[FAIL] processor JS: {err}"));

    let rust_out = syntastica::render(&rust_hl, &mut TerminalRenderer::new(None), syntastica_themes::gruvbox::dark());
    let lua_out = syntastica::render(&lua_hl, &mut TerminalRenderer::new(None), syntastica_themes::gruvbox::dark());
    let js_out = syntastica::render(&js_hl, &mut TerminalRenderer::new(None), syntastica_themes::one::dark());

    assert!(!rust_out.is_empty());
    assert!(!lua_out.is_empty());
    assert!(!js_out.is_empty());

    println!("T6 Processor reuse (Rust+Lua+JS on one processor):");
    println!("  Rust:   {rust_out}");
    println!("  Lua:    {lua_out}");
    println!("  JS:     {js_out}");
    println!("T6 ✅ PASS\n");
}

fn test_multiple_themes() {
    let highlights = Processor::process_once(
        "fn main() { println!(\"Hello, smith!\"); }",
        Lang::Rust,
        &LanguageSetImpl::new(),
    ).unwrap_or_else(|err| panic!("[FAIL] process_once: {err}"));

    let gruvbox = syntastica::render(&highlights, &mut TerminalRenderer::new(None), syntastica_themes::gruvbox::dark());
    let onedark = syntastica::render(&highlights, &mut TerminalRenderer::new(None), syntastica_themes::one::dark());
    let onelight = syntastica::render(&highlights, &mut TerminalRenderer::new(None), syntastica_themes::one::light());

    assert!(!gruvbox.is_empty());
    assert!(!onedark.is_empty());
    assert!(!onelight.is_empty());
    // Different themes should produce different output
    assert_ne!(gruvbox, onedark, "[FAIL] dark themes should differ");
    assert_ne!(gruvbox, onelight, "[FAIL] dark vs light should differ");

    println!("T7 Multiple themes (same code, 3 themes):");
    println!("  gruvbox dark: {gruvbox}");
    println!("  onedark:      {onedark}");
    println!("  onelight:     {onelight}");
    println!("T7 ✅ PASS (all different)\n");
}

fn test_custom_theme() {
    use syntastica::theme;

    let theme = theme! {
        "keyword": "#c678dd",
        "function": "#61afef",
        "string": "#98c379",
        "comment": "#5c6370",
        "type": "#e5c07b",
        "punctuation": "#abb2bf",
        "constant": "#d19a66",
        "variable": "#abb2bf",
        "operator": "#d19a66",
    };

    let output = syntastica::highlight(
        r#"/// A doc comment
fn greet(name: &str) -> String {
    let msg = format!("Hello, {}!", name);
    msg
}"#,
        Lang::Rust,
        &LanguageSetImpl::new(),
        &mut TerminalRenderer::new(None),
        theme,
    ).unwrap_or_else(|err| panic!("[FAIL] custom theme: {err}"));

    println!("T8 Custom theme:");
    println!("{output}");
    assert!(!output.is_empty(), "[FAIL] custom theme output empty");
    println!("T8 ✅ PASS\n");
}

fn test_html_render() {
    use syntastica::renderer::HtmlRenderer;

    let code = "fn add(a: i32, b: i32) -> i32 { a + b }";
    let highlights = Processor::process_once(
        code,
        Lang::Rust,
        &LanguageSetImpl::new(),
    ).unwrap_or_else(|err| panic!("[FAIL] process for HTML: {err}"));

    let html = syntastica::render(
        &highlights,
        &mut HtmlRenderer::new(),
        syntastica_themes::gruvbox::dark(),
    );

    assert!(!html.is_empty(), "[FAIL] HTML output empty");
    assert!(html.contains("<span"), "[FAIL] HTML should contain <span> tags");
    assert!(html.contains("style"), "[FAIL] HTML should contain style attributes");
    assert!(html.contains("fn"), "[FAIL] HTML should contain code text");

    println!("T9 HTML render: ✅ PASS ({} bytes, contains <span>)", html.len());
}

// TOML not in syntastica-parsers (crates.io version). Use git or dynamic parsers for TOML.
// Smith can add TOML highlighting later via syntastica-parsers-git or custom Lang.
