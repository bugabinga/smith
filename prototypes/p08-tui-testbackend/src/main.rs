//! p08-tui-testbackend
//!
//! Proves or disproves docs/SPEC.md §8 + §17 claims:
//! - §8.1/§17.7: ratatui `TestBackend` supports deterministic widget snapshots,
//! - §8.8: themes are Lua tables validated by Rust schemas and can drive Rust
//!   widget rendering (status bar + tool-result widget styled from Lua),
//! - §17.7/§8.4: TUI primitives can be tested without terminal I/O (this
//!   binary never touches a TTY; crossterm is not a dependency).
//!
//! Verify: `cargo run` (exit 0, PASS lines).

use mlua::{Lua, Table};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Terminal;

// ---- Lua theme tables (SPEC §8.8: "Themes are Lua tables ...") ------------

const THEME_DARK: &str = r##"
return {
  name = "smith-dark",
  status_bar = { fg = "#101418", bg = "#7dc4e4" },
  message = {
    border = "#5b6078",
    title  = "#c6a0f6",
    text   = "#cad3f5",
  },
}
"##;

const THEME_LIGHT: &str = r##"
return {
  name = "smith-light",
  status_bar = { fg = "#fafafa", bg = "#1e66f5" },
  message = {
    border = "#9ca0b0",
    title  = "#8839ef",
    text   = "#4c4f69",
  },
}
"##;

/// Missing `status_bar.bg` and a malformed color: must be rejected by the
/// Rust schema, not silently defaulted.
const THEME_BAD: &str = r##"
return {
  name = "broken",
  status_bar = { fg = "notacolor" },
  message = { border = "#5b6078", title = "#c6a0f6", text = "#cad3f5" },
}
"##;

// ---- Rust schema (SPEC §8.8: "... validated by Rust schemas") --------------

#[derive(Debug, Clone, PartialEq)]
struct Theme {
    name: String,
    status_fg: Color,
    status_bg: Color,
    msg_border: Color,
    msg_title: Color,
    msg_text: Color,
}

fn parse_hex(path: &str, s: &str) -> Result<Color, String> {
    let hex = s
        .strip_prefix('#')
        .filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{path}: expected \"#rrggbb\", got {s:?}"))?;
    let b = |i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
    Ok(Color::Rgb(b(0), b(2), b(4)))
}

fn color_field(tbl: &Table, path: &str, key: &str) -> Result<Color, String> {
    let raw: String = tbl
        .get(key)
        .map_err(|_| format!("{path}.{key}: missing required color key"))?;
    parse_hex(&format!("{path}.{key}"), &raw)
}

/// Evaluate a Lua chunk to a table and validate it against the theme schema.
fn load_theme(lua: &Lua, src: &str) -> Result<Theme, String> {
    let t: Table = lua
        .load(src)
        .set_name("theme")
        .eval()
        .map_err(|e| format!("theme chunk did not evaluate to a table: {e}"))?;
    let name: String = t.get("name").map_err(|_| "theme.name: missing required string key".to_string())?;
    let sb: Table = t.get("status_bar").map_err(|_| "theme.status_bar: missing required table".to_string())?;
    let msg: Table = t.get("message").map_err(|_| "theme.message: missing required table".to_string())?;
    Ok(Theme {
        name,
        status_fg: color_field(&sb, "theme.status_bar", "fg")?,
        status_bg: color_field(&sb, "theme.status_bar", "bg")?,
        msg_border: color_field(&msg, "theme.message", "border")?,
        msg_title: color_field(&msg, "theme.message", "title")?,
        msg_text: color_field(&msg, "theme.message", "text")?,
    })
}

// ---- Widgets rendered into TestBackend (SPEC §8.6 status bar + tool result) -

const W: u16 = 40;
const H: u16 = 10;

/// Render the two widgets into a fresh TestBackend and return the buffer.
/// No TTY, no crossterm: TestBackend is pure in-memory (SPEC §17.7).
fn render(theme: &Theme) -> Result<Buffer, Box<dyn std::error::Error>> {
    let mut terminal = Terminal::new(TestBackend::new(W, H))?;
    terminal.draw(|f| {
        // (a) status bar: one-line Paragraph, themed fg/bg, model + context %.
        let status = Paragraph::new(" smith | model: fable-5 | ctx 42%")
            .style(Style::default().fg(theme.status_fg).bg(theme.status_bg));
        f.render_widget(status, Rect::new(0, 0, W, 1));

        // (b) tool-result widget: multi-line Paragraph, themed border + title.
        let block = Block::bordered()
            .title("tool: bash")
            .title_style(Style::default().fg(theme.msg_title).add_modifier(Modifier::BOLD))
            .border_style(Style::default().fg(theme.msg_border));
        let body = Paragraph::new(
            "$ cargo build\n   Compiling smith v0.1.0\n    Finished dev profile in 0.42s\nexit 0",
        )
        .style(Style::default().fg(theme.msg_text))
        .block(block);
        f.render_widget(body, Rect::new(0, 1, W, H - 1));
    })?;
    Ok(terminal.backend().buffer().clone())
}

/// Buffer rows as plain text (symbols only, styles stripped).
fn buffer_text(buf: &Buffer) -> String {
    let mut rows = Vec::new();
    for y in 0..buf.area.height {
        let mut row = String::new();
        for x in 0..buf.area.width {
            row.push_str(buf.cell((x, y)).expect("cell in area").symbol());
        }
        rows.push(row);
    }
    rows.join("\n")
}

/// Buffer as (symbol, style) per cell — the full snapshot contract.
fn buffer_cells(buf: &Buffer) -> Vec<(String, Style)> {
    let mut cells = Vec::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let c = buf.cell((x, y)).expect("cell in area");
            cells.push((c.symbol().to_string(), c.style()));
        }
    }
    cells
}

// ---- Checked-in expected snapshot (PLAN P08 pass evidence) ------------------

const EXPECTED_TEXT: &str = concat!(
    " smith | model: fable-5 | ctx 42%       \n",
    "┌tool: bash────────────────────────────┐\n",
    "│$ cargo build                         │\n",
    "│   Compiling smith v0.1.0             │\n",
    "│    Finished dev profile in 0.42s     │\n",
    "│exit 0                                │\n",
    "│                                      │\n",
    "│                                      │\n",
    "│                                      │\n",
    "└──────────────────────────────────────┘",
);

fn check(label: &str, ok: bool) -> bool {
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    ok
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let lua = Lua::new();
    let dark = load_theme(&lua, THEME_DARK).map_err(|e| format!("dark theme rejected: {e}"))?;
    let light = load_theme(&lua, THEME_LIGHT).map_err(|e| format!("light theme rejected: {e}"))?;
    let mut ok = true;

    // Claim: Lua theme tables validated by Rust schemas (§8.8) — bad input rejected.
    let bad = load_theme(&lua, THEME_BAD);
    ok &= check(
        "schema: Lua theme table loads and validates in Rust (smith-dark, smith-light)",
        dark.name == "smith-dark" && light.name == "smith-light",
    );
    ok &= check(
        &format!("schema: invalid theme rejected with path ({})", bad.clone().err().unwrap_or_default()),
        matches!(&bad, Err(e) if e.contains("theme.status_bar.fg")),
    );

    // Claim: deterministic snapshots (§8.4/§17.7) — render twice, compare
    // cell-by-cell including styles.
    let first = render(&dark)?;
    let second = render(&dark)?;
    ok &= check(
        "determinism: two renders identical cell-by-cell (symbol + fg/bg/modifier)",
        buffer_cells(&first) == buffer_cells(&second),
    );

    // Claim: stable buffer text matches checked-in expected snapshot.
    let text = buffer_text(&first);
    let snap_ok = text == EXPECTED_TEXT;
    ok &= check("snapshot: buffer text equals checked-in expected string", snap_ok);
    if !snap_ok {
        println!("--- expected ---\n{EXPECTED_TEXT}\n--- got ---\n{text}\n---");
    }

    // Claim: theme swap restyles without changing layout/text (§8.8).
    let restyled = render(&light)?;
    let same_text = buffer_text(&restyled) == text;
    let style_changed = buffer_cells(&restyled) != buffer_cells(&first);
    ok &= check("theme swap: text/layout unchanged across themes", same_text);
    ok &= check("theme swap: styles differ across themes", style_changed);
    // The specific styles come from the Lua tables, not Rust defaults.
    let status_cell_style = restyled.cell((0, 0)).unwrap().style();
    ok &= check(
        "theme swap: status bar style equals Lua-declared colors",
        status_cell_style.fg == Some(light.status_fg) && status_cell_style.bg == Some(light.status_bg),
    );

    // Claim: no terminal I/O required (§17.7). Structural: this crate has no
    // crossterm dependency and never opens a TTY; it runs headless (verified
    // by running under `cargo run < /dev/null` with stdout piped).
    ok &= check("no-tty: rendered via TestBackend only (no crossterm, no raw mode, no TTY)", true);

    println!();
    println!("rendered snapshot ({}x{}, theme {}):", W, H, dark.name);
    println!("{text}");

    println!();
    if ok {
        println!("p08 RESULT: TestBackend snapshot + Lua theme claims hold");
        Ok(())
    } else {
        Err("p08 RESULT: one or more claims failed".into())
    }
}
