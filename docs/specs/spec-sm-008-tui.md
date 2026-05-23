# SM-008: smith-tui/ — Terminal UI

Create the `smith-tui/` crate providing terminal UI primitives.

## Context

Foundation crate for all TUI rendering. Depends on smith/ (SM-005).
Exposes **widget creation** only — layout and data binding done by Lua plugins.

**Design doc:** `docs/design/TUI-CRATE-DESIGN.md` — read this first.

## Key Design Decisions

1. **ratatui + crossterm backend** — ratatui provides widget framework, layout engine, and `TestBackend` for snapshot tests; crossterm is the terminal I/O backend that ratatui drives
2. **TUI exposes widgets, Lua uses them** — even default layout is a Lua plugin
3. **Border layout** — center + N/E/S/W panels, panels empty/invisible by default
4. **Layout primitives** — Column, Row, Box, Expanded, Scrollable, Overlay, Widget, Spacer, Tabs, Split
5. **Virtual scroll** — highest priority widget, differential rendering
6. **Everything themable** via Lua tables
7. **18 widgets** matching pi's component set plus smith's diff primitive
8. **Tick-based render loop** — 16ms (≈60 FPS) tick, crossterm event polling, differential draw
9. **Feature UIs are Lua plugins** — Rust exposes widget primitives; built-in features (time-travel, history, VCS tools) compose those primitives from Lua

## Deliverables

### 1. `smith-tui/Cargo.toml`

```toml
[package]
name = "smith-tui"
version = "0.1.0"
edition = "2024"

[dependencies]
smith = { path = "../smith" }
ratatui = { workspace = true }
crossterm = { workspace = true }
unicode-width = { workspace = true }
unicode-segmentation = { workspace = true }
serde = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true, features = ["sync", "time"] }
syntastica = { workspace = true }
syntastica-parsers = { workspace = true }
similar = { workspace = true }
fuzzy-matcher = { workspace = true }

[dev-dependencies]
insta = { workspace = true }
```

**Note:** `crossterm` remains as an explicit dependency because smith-tui uses it directly for:
- Kitty keyboard protocol flags (`KeyboardEnhancementFlags`)
- Event polling configuration (`EventStream`, poll duration)
- Raw mode / alternate screen setup
- Terminal capability queries

ratatui uses crossterm internally as its backend, but smith-tui also needs direct crossterm access for the above.

### 2. TuiEvent Enum

Normalized input event type. All crossterm events are converted to `TuiEvent` before
reaching components. This decouples widgets from the crossterm event types.

```rust
/// Normalized TUI event. Crossterm events are mapped to this enum
/// before dispatch to components.
#[derive(Clone, Debug, Serialize)]
pub enum TuiEvent {
    // Keyboard
    Key(KeyEvent),
    // Mouse
    Mouse(MouseEvent),
    // Terminal
    Resize { width: u16, height: u16 },
    // Focus
    FocusGained,
    FocusLost,
    // Paste
    Paste(String),
}

/// Keyboard event (normalized from crossterm::event::KeyEvent)
#[derive(Clone, Debug)]
pub struct KeyEvent {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
    pub kind: KeyEventKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyCode {
    Char(char),
    F(u8),
    Enter,
    Backspace,
    Delete,
    Tab,
    Esc,
    Up, Down, Left, Right,
    Home, End,
    PageUp, PageDown,
    Null,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyModifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub super_: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyEventKind {
    Press,
    Repeat,
    Release,
}

/// Mouse event (normalized from crossterm::event::MouseEvent)
#[derive(Clone, Debug)]
pub struct MouseEvent {
    pub kind: MouseEventKind,
    pub column: u16,
    pub row: u16,
    pub modifiers: KeyModifiers,
}

#[derive(Clone, Debug)]
pub enum MouseEventKind {
    Down(MouseButton),
    Up(MouseButton),
    Drag(MouseButton),
    Moved,
    ScrollDown,
    ScrollUp,
    ScrollLeft,
    ScrollRight,
}

#[derive(Clone, Debug)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}
```

**Conversion:** A `From<crossterm::event::Event>` impl for `TuiEvent` handles the mapping.
This isolates all crossterm-specific event handling to one place.

```rust
impl TuiEvent {
    /// Convert a raw crossterm event to our normalized TuiEvent.
    /// Returns None for events we don't care about (e.g., mouse when disabled).
    pub fn try_from_crossterm(event: crossterm::event::Event) -> Option<Self> {
        use crossterm::event::Event as CEvent;
        match event {
            CEvent::Key(key) => Some(TuiEvent::Key(convert_key(key))),
            CEvent::Mouse(mouse) => Some(TuiEvent::Mouse(convert_mouse(mouse))),
            CEvent::Resize(w, h) => Some(TuiEvent::Resize { width: w, height: h }),
            CEvent::FocusGained => Some(TuiEvent::FocusGained),
            CEvent::FocusLost => Some(TuiEvent::FocusLost),
            CEvent::Paste(text) => Some(TuiEvent::Paste(text)),
            _ => None,
        }
    }
}

fn convert_key(key: crossterm::event::KeyEvent) -> KeyEvent { /* ... */ }
fn convert_mouse(mouse: crossterm::event::MouseEvent) -> MouseEvent { /* ... */ }
```

### 3. Component Trait (updated)

```rust
pub trait Component: Send + Sync {
    /// Render the widget to ratatui buffer lines for the given area.
    fn render(&self, area: Rect, buf: &mut Buffer);

    /// Handle a normalized TUI event. Returns true if the event was consumed.
    fn handle_event(&mut self, event: &TuiEvent) -> bool;

    /// Mark cached state as stale; next render will recompute.
    fn invalidate(&mut self);

    /// Return self as Focusable if this widget supports focus tracking.
    fn as_focusable_mut(&mut self) -> Option<&mut dyn Focusable> { None }
}

/// Focusable widgets receive focus/blur events via the dispatcher.
pub trait Focusable: Component {
    fn focused(&self) -> bool;
    fn set_focused(&mut self, focused: bool);
}
```

**Changes from previous spec:**
- `render` signature changed from `fn render(&self, width: u16) -> Vec<String>` to ratatui's native `fn render(&self, area: Rect, buf: &mut Buffer)`. This aligns with ratatui's `Widget` trait and enables direct use of ratatui's layout primitives.
- `handle_input(&mut self, data: &str) -> bool` → `handle_event(&mut self, event: &TuiEvent) -> bool`. Accepts the full event enum, not just strings.

### 3.5. TerminalCapabilities

Detected at `TuiApp::new()` via crossterm queries and `TERM`/`TERM_PROGRAM`
environment inspection. Features are probed once at startup; the result drives
all capability-gated behavior for the session.

```rust
/// Capabilities of the connected terminal emulator.
/// Probed once at TuiApp startup. Never re-detected during the session.
#[derive(Clone, Debug, Default)]
pub struct TerminalCapabilities {
    /// Kitty keyboard protocol per-flag capabilities.
    /// Detected via crossterm's `supports_keyboard_enhancement()`.
    pub kitty_keyboard: KeyboardCapabilities,
    /// Kitty graphics protocol (inline images via escape sequences).
    pub kitty_graphics: bool,
    /// Sixel graphics (fallback for inline images).
    pub sixel: bool,
    /// Hyperlink variant supported by this terminal.
    /// OSC 8 is standard; Ghostty uses OSC 10/11.
    pub hyperlink_variant: HyperlinkVariant,
    /// Truecolor / 24-bit color support.
    pub truecolor: bool,
    /// Bracketed paste support.
    pub bracketed_paste: bool,
    /// Mouse capture support (crossterm EnableMouseCapture succeeded).
    pub mouse: bool,
    /// Synchronized output (CSI ? 2026 h) — batch screen updates to prevent flicker.
    pub synchronized_output: bool,
    /// OSC 52 clipboard manipulation support.
    pub clipboard: bool,
    /// OSC 9 desktop notification support.
    pub notifications: bool,
    /// OSC 3 semantic prompt / shell integration support.
    pub semantic_prompts: bool,
    /// Undercurl / curly underline (SGR 4:3) support.
    pub undercurl: bool,
}

/// Per-flag Kitty keyboard capabilities.
/// Detected by crossterm's `KeyboardEnhancementFlags` query.
#[derive(Clone, Debug, Default)]
pub struct KeyboardCapabilities {
    /// Disambiguate escape codes (Bit 1).
    pub disambiguate: bool,
    /// Report event types: press, release, repeat (Bit 2).
    pub event_types: bool,
    /// Report alternate keys (Bit 4).
    pub alternate_keys: bool,
    /// Report all keys as escape codes (Bit 8).
    pub all_keys_as_escape_codes: bool,
    /// Associate text with key events (Bit 16).
    pub associated_text: bool,
}

/// Which hyperlink escape sequence variant the terminal supports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HyperlinkVariant {
    /// Standard OSC 8 hyperlinks (`OSC 8 ; params ; URI ST`).
    Osc8,
    /// Ghostty non-standard OSC 10/11 hyperlink start/end.
    GhosttyOsc10,
    /// No hyperlink support detected.
    None,
}

impl TerminalCapabilities {
    /// Probe the terminal at startup.
    ///
    /// Detection strategy (in order):
    /// 1. `TERM_PROGRAM` env: "ghostty" → kitty_graphics, kitty_keyboard (all flags)
    /// 2. `TERM` env: "xterm-kitty" → kitty_keyboard, kitty_graphics
    /// 3. crossterm `supports_keyboard_enhancement()` → per-flag `KeyboardCapabilities`
    /// 4. Query with OSC 204 (kitty graphics availability) → kitty_graphics
    /// 5. Query with DCS + q (sixel availability) → sixel
    /// 6. `COLORTERM` == "truecolor" → truecolor
    /// 7. Check TERM_PROGRAM for known mouse-supporting terminals → mouse
    /// 8. Send CSI ? 2026 h then query → synchronized_output
    /// 9. Query OSC 52 / OSC 9 / OSC 3 availability → clipboard, notifications, semantic_prompts
    /// 10. Check TERM_PROGRAM (ghostty, wezterm, kitty) or terminfo for undercurl → undercurl
    /// 11. Test OSC 8 hyperlink; if no response, test Ghostty OSC 10/11 → hyperlink_variant
    ///
    /// Any probe that fails or times out (100ms) is conservatively disabled.
    pub fn detect() -> Self;

    /// Best image protocol for this terminal, in priority order.
    /// Ghostty implements kitty graphics natively — no separate protocol.
    pub fn image_protocol(&self) -> Option<ImageProtocol> {
        if self.kitty_graphics { Some(ImageProtocol::Kitty) }
        else if self.sixel { Some(ImageProtocol::Sixel) }
        else { None }
    }
}

pub enum ImageProtocol {
    Kitty,
    Sixel,
}
```

**Design decisions:**
- **Probe once, not continuously.** Terminal capabilities don't change during
  a smith session. Re-detection adds complexity with no benefit.
- **Graceful degradation.** If a capability probe fails or times out, smith
  disables it and falls back to text equivalents. No error is shown to the user.
- **No terminfo database.** We probe directly rather than parsing terminfo.
  Terminfo is often stale or missing for modern terminals (Ghostty, WezTerm,
  Alacritty). Direct probing is more reliable.
- **Mouse is opt-out.** Mouse capture is enabled by default if the terminal
  supports it. Users can disable via config: `mouse = false`.
- **Image protocols are prioritized:** Kitty > Sixel. Ghostty implements kitty
  graphics natively — no separate protocol. Only one protocol is active per session.
  The `Image` widget uses the active protocol.
- **Synchronized output (CSI 2026).** When supported, each `terminal.draw()` is
  wrapped in `BeginSynchronizedUpdate` / `EndSynchronizedUpdate` to prevent
  screen flicker. This is critical for smooth rendering in fast-updating TUIs.
- **Hyperlink variant detection.** Terminals use different OSC sequences for
  hyperlinks: OSC 8 is standard; Ghostty uses OSC 10/11. We test OSC 8 first,
  then fall back to Ghostty's variant. The detected variant is stored in
  `HyperlinkVariant` and used by the `Markdown` widget when rendering links.
- **Keyboard enhancement is per-flag.** The Kitty keyboard protocol has 6
  progressive enhancement levels. We detect each flag independently via
  crossterm and push only the supported subset.

### 4. TuiApp — Render Loop

`TuiApp` owns the main TUI lifecycle. Created by `smith-harness`, driven by the
harness event loop.

```rust
use ratatui::{Terminal, Viewport};
use ratatui::backend::CrosstermBackend;
use std::time::Duration;

/// A registered widget with its last-known screen rect, for hit-testing.
pub struct WidgetSlot {
    pub widget: Box<dyn Component>,
    pub rect: Option<ratatui::layout::Rect>,
    pub sticky: bool,
}

pub struct TuiApp {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
    border_layout: BorderLayout,
    widgets: HashMap<String, WidgetSlot>,
    sticky_widgets: Vec<String>,
    focused_id: Option<String>,
    prev_focused_id: Option<String>,
    theme: Theme,
    tick_rate: Duration,
    running: bool,
    terminal_caps: TerminalCapabilities,
    /// Optional trace recorder for session replay. Set by harness during wiring.
    trace: Option<Arc<dyn TraceRecorder>>,
}

impl TuiApp {
    /// Create a new TuiApp. Enters alternate screen + raw mode.
    /// Uses a RAII guard to restore terminal state if setup panics.
    pub fn new(theme: Theme) -> Result<Self, TuiError> {
        // RAII guard: restores terminal on panic or early return.
        // Disarm with guard.disarm() once setup succeeds.
        struct TerminalGuard(bool);
        impl TerminalGuard {
            fn disarm(&mut self) { self.0 = false; }
        }
        impl Drop for TerminalGuard {
            fn drop(&mut self) {
                if self.0 {
                    let _ = crossterm::terminal::disable_raw_mode();
                    let _ = crossterm::execute!(
                        std::io::stdout(),
                        crossterm::terminal::LeaveAlternateScreen,
                        crossterm::event::DisableMouseCapture
                    );
                }
            }
        }
        let mut guard = TerminalGuard(true);

        // 1. Detect terminal capabilities
        let caps = TerminalCapabilities::detect();

        // 2. Enable raw mode (crossterm)
        // 3. Enter alternate screen
        // 4. Enable mouse capture if supported and requested by config
        // Detection is query-only (env vars); actual enable happens here.
        if caps.mouse {
            let _ = crossterm::execute!(std::io::stdout(), crossterm::event::EnableMouseCapture);
        }
        // 5. Enable Kitty keyboard enhancement flags if supported
        // Build flags from per-capability detection results.
        let mut kb_flags = crossterm::event::KeyboardEnhancementFlags::empty();
        if caps.kitty_keyboard.disambiguate {
            kb_flags |= crossterm::event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES;
        }
        if caps.kitty_keyboard.event_types {
            kb_flags |= crossterm::event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES;
        }
        if caps.kitty_keyboard.alternate_keys {
            kb_flags |= crossterm::event::KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS;
        }
        if caps.kitty_keyboard.all_keys_as_escape_codes {
            kb_flags |= crossterm::event::KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES;
        }
        if caps.kitty_keyboard.associated_text {
            kb_flags |= crossterm::event::KeyboardEnhancementFlags::REPORT_ASSOCIATED_TEXT;
        }
        if !kb_flags.is_empty() {
            let _ = crossterm::execute!(
                std::io::stdout(),
                crossterm::event::PushKeyboardEnhancementFlags(kb_flags)
            );
        }
        // 6. Create CrosstermBackend + Terminal
        // 7. Clear screen
        // 8. Disarm RAII guard on success
    }

    /// Main render loop. Blocks until shutdown.
    /// Called by smith-harness::Harness::run_interactive().
    pub fn run(
        &mut self,
        event_rx: tokio::sync::mpsc::Receiver<TuiEvent>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), TuiError> {
        self.running = true;
        while self.running {
            // 1. Poll for shutdown signal
            if shutdown.has_changed().unwrap_or(true) {
                break;
            }

            // 2. Drain all pending TuiEvents from channel
            while let Ok(event) = event_rx.try_recv() {
                self.dispatch_event(event);
            }

            // 3. Render main frame + sticky widgets in a single draw call
            // Wrap in synchronized output (CSI ? 2026) when supported to prevent flicker.
            if self.terminal_caps.synchronized_output {
                let _ = crossterm::execute!(
                    std::io::stdout(),
                    crossterm::terminal::BeginSynchronizedUpdate
                );
            }
            self.terminal.draw(|f| {
                self.render_frame(f);
                self.render_sticky_widgets(f);
            })?;
            if self.terminal_caps.synchronized_output {
                let _ = crossterm::execute!(
                    std::io::stdout(),
                    crossterm::terminal::EndSynchronizedUpdate
                );
            }

            // 5. Tick wait (16ms ≈ 60 FPS)
            std::thread::sleep(self.tick_rate);
        }
        Ok(())
    }

    /// Dispatch a single event to the appropriate component.
    /// Records TuiEvent to trace recorder for replay.
    fn dispatch_event(&mut self, event: TuiEvent) {
        // Record to trace
        if let Some(trace) = &self.trace {
            // Serialize TuiEvent as opaque JSON — avoids smith-tui → smith-core dep
            trace.record(TraceEntry::TuiEvent {
                timestamp_ns: now_ns(),
                event_type: format!("{:?}", std::mem::discriminant(&event)),
                event_json: serde_json::to_string(&event).unwrap_or_default(),
            });
        }

        // Mouse hit-testing: find widget under cursor
        if let TuiEvent::Mouse(ref mouse) = event {
            if let Some(id) = self.hit_test(mouse.column, mouse.row) {
                // Click-to-focus: left mouse down defocuses previous, focuses new
                if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
                    // Defocus previous widget (inline — must happen at point of focus change)
                    if let Some(prev_id) = &self.focused_id {
                        if prev_id != &id {
                            if let Some(slot) = self.widgets.get_mut(prev_id) {
                                if let Some(focusable) = slot.widget.as_focusable_mut() {
                                    focusable.set_focused(false);
                                }
                            }
                        }
                    }
                    self.focused_id = Some(id.clone());
                    self.prev_focused_id = self.focused_id.clone();
                    // Focus new widget
                    if let Some(slot) = self.widgets.get_mut(&id) {
                        if let Some(focusable) = slot.widget.as_focusable_mut() {
                            focusable.set_focused(true);
                        }
                    }
                }
                // Deliver mouse event to the hit widget
                if let Some(slot) = self.widgets.get_mut(&id) {
                    let consumed = slot.widget.handle_event(&event);
                    if consumed { return; }
                }
            }
            // Scroll wheel: route to focused VirtualScroll widget
            if matches!(mouse.kind, MouseEventKind::ScrollDown | MouseEventKind::ScrollUp) {
                // v1: route scroll events to focused widget (which must impl VirtualScroll)
                if let Some(focused) = &self.focused_id {
                    if let Some(slot) = self.widgets.get_mut(focused) {
                        slot.widget.handle_event(&event);
                    }
                }
            }
            return;
        }

        // 1. Route key events to focused widget
        if let Some(id) = &self.focused_id {
            if let Some(slot) = self.widgets.get_mut(id) {
                // If widget implements Focusable, track focus state
                if let Some(focusable) = slot.widget.as_focusable_mut() {
                    focusable.set_focused(true);
                }
                let consumed = slot.widget.handle_event(&event);
                if consumed { return; }
            }
        }
        // 2. Route resize to all widgets
        // 3. Check for global keybindings (panel toggles, etc.)
        // 4. If no handler consumed it, try focused widget
    }

    /// Hit-test: find the topmost widget at the given cell position.
    /// Sticky widgets are checked first (they render on top), then non-sticky.
    fn hit_test(&self, col: u16, row: u16) -> Option<String> {
        let pos = ratatui::layout::Position { x: col, y: row };
        // Check sticky widgets first (top layer)
        let sticky_hit = self.widgets.iter()
            .filter(|(_, slot)| slot.sticky)
            .filter_map(|(id, slot)| {
                slot.rect?.contains(pos).then_some(id.clone())
            })
            .next();
        if sticky_hit.is_some() {
            return sticky_hit;
        }
        // Then check non-sticky widgets
        self.widgets.iter()
            .filter(|(_, slot)| !slot.sticky)
            .filter_map(|(id, slot)| {
                slot.rect?.contains(pos).then_some(id.clone())
            })
            .next()
    }

    /// Render one frame using the border layout.
    fn render_frame(&self, frame: &mut ratatui::Frame) {
        let rect = frame.area();
        let layout = self.border_layout.resolve(rect);
        // Render each panel area
        // Render center with widget tree
        // After rendering each widget, store its rect in the WidgetSlot
        // for the next frame's hit-testing.
    }

    /// Render sticky widgets in a second pass, on top of everything else.
    fn render_sticky_widgets(&self, frame: &mut ratatui::Frame) {
        for id in &self.sticky_widgets {
            if let Some(slot) = self.widgets.get(id) {
                if let Some(rect) = slot.rect {
                    slot.widget.render(rect, frame.buffer_mut());
                }
            }
        }
    }

    /// Graceful shutdown. Restores terminal state.
    pub fn shutdown(&mut self) -> Result<(), TuiError> {
        self.running = false;
        // 1. Disable Kitty keyboard flags if they were enabled
        // Pop only if any flag was pushed (i.e., if the struct is not all false).
        let kb = &self.terminal_caps.kitty_keyboard;
        if kb.disambiguate || kb.event_types || kb.alternate_keys || kb.all_keys_as_escape_codes || kb.associated_text {
            let _ = crossterm::execute!(std::io::stdout(), crossterm::event::PopKeyboardEnhancementFlags);
        }
        // 2. Disable mouse capture if it was enabled
        if self.terminal_caps.mouse {
            let _ = crossterm::execute!(std::io::stdout(), crossterm::event::DisableMouseCapture);
        }
        // 3. Leave alternate screen
        // 4. Disable raw mode
        // 5. Show cursor
        // 6. Flush stdout
    }

    // --- Widget management ---

    /// Register a widget instance by ID.
    pub fn register_widget(&mut self, id: String, widget: Box<dyn Component>);

    /// Register a sticky widget. Sticky widgets render in a second pass,
    /// on top of all normal widgets. They do not participate in layout
    /// resolution — the caller provides their rect directly.
    pub fn register_sticky_widget(&mut self, id: String, widget: Box<dyn Component>, rect: Rect);

    /// Set the center layout tree.
    pub fn set_center_layout(&mut self, layout: Layout);

    /// Toggle a border panel.
    pub fn toggle_panel(&mut self, panel: PanelSide);

    /// Update theme at runtime.
    pub fn set_theme(&mut self, theme: Theme);
}

pub enum PanelSide { North, South, East, West }
```

#### Lifecycle Contract

```
Harness::run_interactive()
    │
    ├── TuiApp::new(theme)          ← enters raw mode + alternate screen
    │
    ├── spawn_event_poller(tx, shutdown_rx)  ← blocking thread: crossterm → TuiEvent
    │
    ├── tokio::task::spawn_blocking(move || {
    │       TuiApp::run(event_rx, shutdown_rx)   ← sync render loop on blocking thread
    │   })
    │   .await?;
    │
    └── TuiApp::shutdown()          ← restores terminal
```

**Why `spawn_blocking`?** `TuiApp::run` is synchronous because `terminal.draw()`
and `std::thread::sleep` are blocking operations. Running the TUI on a tokio
blocking thread keeps the async runtime free for the agent loop, HTTP streams,
and plugin events. The harness awaits the blocking task and forwards shutdown
via the watch channel.

#### Event Polling (runs on a blocking thread)

`crossterm::event::poll` is a blocking syscall. It must run on a tokio
blocking thread, not inside an async task, to avoid freezing the runtime.

```rust
/// Spawn a blocking thread that polls crossterm and forwards TuiEvents
/// through an async channel.
pub fn spawn_event_poller(
    tx: tokio::sync::mpsc::Sender<TuiEvent>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(16);
        loop {
            if shutdown.has_changed().unwrap_or(true) {
                break;
            }
            if crossterm::event::poll(tick).unwrap_or(false) {
                if let Ok(event) = crossterm::event::read() {
                    if let Some(tui_event) = TuiEvent::try_from_crossterm(event) {
                        // Blocking send is OK here — channel is unbounded
                        let _ = tx.blocking_send(tui_event);
                    }
                }
            }
        }
    });
}
```
```

### 5. Widgets (18 total)

**Primitives:**
- `Text` — multi-line text with word wrap
- `TruncatedText` — single-line, truncated to viewport
- `Markdown` — markdown rendering (headings, code, links, tables, syntax-highlighted fenced code via `syntastica`)
- `Box` — container with optional border
- `Spacer` — empty space

**Input:**
- `Input` — single-line text input with cursor, kill ring, undo
- `Editor` — multi-line editor with autocomplete, history, paste, undo

**Selection:**
- `SelectList` — filterable list with keyboard navigation
- `SettingsList` — key-value settings with cycling values and submenus

**Feedback:**
- `Loader` — animated spinner with message
- `CancellableLoader` — loader cancellable with Escape

**Media:**
- `Image` — terminal image (Kitty protocol, Sixel fallback)

**Utilities:**
- `FuzzyFilter` — fuzzy matching for search/filter via `fuzzy-matcher` (score + match indices for highlighted spans)
- `Overlay` — floating panel with configurable anchor and size
- `DiffView` — unified and split diff rendering via `similar`, with optional syntax-highlighted code spans from `syntastica`

**Layout:**
- `VirtualScroll` — high-performance virtual scroll (most important widget)

All widgets implement `Component` using ratatui's `Rect`/`Buffer` render interface.

#### Syntax, Diff, and Fuzzy Primitives

These are Rust primitives, not feature implementations:

- `Markdown` owns syntax-highlighted code block rendering. It uses `syntastica`
  with explicit language selection from fence info or file extension. No
  auto-detection is used because prototype P16 and pi both found automatic
  language detection unreliable for prose.
- `DiffView` owns diff rendering. It uses `similar` for Myers/patience line
  diffs, unified-diff hunk generation, and word-level inline highlights. The
  widget accepts already-computed left/right text or a `UnifiedDiff` model.
- `FuzzyFilter` owns fuzzy matching only. It uses `fuzzy-matcher` and returns
  `(score, indices)` so `SelectList`, command palettes, and Lua plugins can
  style matched characters without duplicating scoring logic.

Feature UIs such as time-travel are built-in Lua plugins. They use these
widgets through `smith.tui.*`; Rust core must not contain time-travel-specific
panels or commands.

### 6. Tool Rendering

Tools can provide custom TUI renderers for their calls and results, giving
built-in tools and plugins full control over how they appear in the conversation.
This mirrors pi's `renderCall`/`renderResult` design.

```rust
/// Re-exported from smith/ (SM-005 §types.rs) — canonical definition.
/// Controls whether the TUI renders a standard colored shell frame around
/// the tool call/result, or the tool provides its own framing.
pub use smith::RenderShell;  // { Default, Self }

/// Options passed to tool result renderers.
pub struct ToolRenderResultOptions {
    pub expanded: bool,
    pub is_partial: bool,
}

/// Context passed to tool renderers. Shared state across call and result renders
/// for the same tool execution.
pub struct ToolRenderContext {
    /// Tool call arguments (shared across call and result renders).
    pub args: serde_json::Value,
    /// Unique id for this tool execution. Stable across call/result renders.
    pub tool_call_id: String,
    /// Invalidate just this tool execution component for redraw.
    /// Arc (not Box) so ToolRenderContext can be cloned/cached by the TUI.
    pub invalidate: Arc<dyn Fn() + Send + Sync>,
    /// Previously returned widget for this render slot, if any.
    pub last_component: Option<Box<dyn Component>>,
    /// Shared renderer state for this tool row. Initialized by the TUI on first render.
    pub state: serde_json::Value,
    /// Working directory for this tool execution.
    pub cwd: PathBuf,
    /// Whether the tool execution has started.
    pub execution_started: bool,
    /// Whether the tool call arguments are complete.
    pub args_complete: bool,
    /// Whether the tool result is partial/streaming.
    pub is_partial: bool,
    /// Whether the result view is expanded.
    pub expanded: bool,
    /// Whether inline images are currently shown.
    pub show_images: bool,
    /// Whether the current result is an error.
    pub is_error: bool,
}

/// Trait for custom tool rendering in the TUI.
/// Implemented by the TUI for built-in tools; plugins provide Lua functions
/// that the TUI wraps in this trait via the plugin bridge.
pub trait ToolRenderer: Send + Sync {
    /// Custom rendering for the tool call display (the "input" half).
    fn render_call(
        &self,
        args: &serde_json::Value,
        theme: &Theme,
        ctx: &mut ToolRenderContext,
    ) -> Box<dyn Component>;

    /// Custom rendering for the tool result display (the "output" half).
    fn render_result(
        &self,
        result: &AgentToolResult,
        options: &ToolRenderResultOptions,
        theme: &Theme,
        ctx: &mut ToolRenderContext,
    ) -> Box<dyn Component>;

    /// Which shell framing mode this tool uses.
    fn render_shell(&self) -> RenderShell {
        RenderShell::Default
    }
}

/// Registry of tool renderers, keyed by tool name.
pub struct ToolRendererRegistry {
    renderers: HashMap<String, Box<dyn ToolRenderer>>,
}

impl ToolRendererRegistry {
    pub fn register(&mut self, name: String, renderer: Box<dyn ToolRenderer>);
    pub fn get(&self, name: &str) -> Option<&dyn ToolRenderer>;
}
```

**RenderShell behavior:**
- `Default` — TUI renders a standard shell frame (colored border, tool name,
  timestamp, expand/collapse controls). The `ToolRenderer` only produces the
  inner content (args for calls, output for results).
- `Self` — The `ToolRenderer` produces the entire component including framing.
  Used when a tool needs complete visual control (e.g., a custom diff viewer).

**Integration with VirtualScroll:**
Each `ScrollItem` in the VirtualScroll knows its message type. For tool-related
messages, the VirtualScroll looks up the `ToolRenderer` by tool name in the
registry. If found, it calls `render_call` or `render_result` with the
appropriate `ToolRenderContext`. If no custom renderer is registered, the
default shell renderer is used.

**Plugin bridge:**
When a Lua plugin registers a tool with `renderCall`/`renderResult` functions,
the harness creates a `LuaToolRenderer` that wraps the Lua functions via
`mlua::RegistryKey`. The TUI calls these through the `ToolRenderer` trait.

### 7. Layout System

```rust
pub enum Layout {
    Column { children: Vec<Layout> },
    Row { children: Vec<Layout> },
    Box { child: Box<Layout>, width: Option<Size>, height: Option<Size>, border: Option<Border> },
    Expanded { child: Box<Layout> },
    Scrollable { child: Box<Layout>, direction: ScrollDirection },
    Overlay { child: Box<Layout>, options: OverlayOptions },
    Widget { id: String },
    Spacer { size: Option<Size> },
    Tabs { children: Vec<TabItem>, active: usize },
    Split { direction: SplitDirection, first: Box<Layout>, second: Box<Layout>, ratio: f32 },
}
```

Layout resolution produces `ratatui::layout::Rect` allocations for each widget.
This replaces the previous `Vec<String>` approach — ratatui's layout engine handles
the space distribution natively.

### 8. Border Layout (predefined, only one)

```rust
pub struct BorderLayout {
    pub center: Layout,
    pub north: Option<Panel>,
    pub south: Option<Panel>,
    pub east: Option<Panel>,
    pub west: Option<Panel>,
}

pub struct Panel {
    pub visible: bool,
    pub size: Size,
    pub layout: Layout,
}
```

Default: all panels invisible, center uses default Lua plugin layout.

### 9. Theme System

```rust
pub struct Theme {
    pub name: String,
    pub default_text: TextStyle,
    pub markdown: MarkdownTheme,
    pub roles: RoleStyles,     // user, assistant, tool, thinking
    pub ui: UiStyles,          // status_bar, hint_bar, input, loader, error, success
    pub select_list: SelectListTheme,
    pub panel: PanelStyle,
    // ... every element themable
}
```

Loaded from Lua tables. Default theme ships as built-in.

### 10. Virtual Scroll

```rust
pub struct VirtualScroll {
    items: Vec<ScrollItem>,
    total_height: usize,
    viewport_height: usize,
    scroll_offset: usize,
    rendered_cache: HashMap<usize, Vec<String>>,
}
```

- Only render visible messages
- Cache rendered lines per message
- Invalidate on resize/theme change
- Differential rendering (pi-style)

### 11. Error Type

```rust
#[derive(thiserror::Error, Debug)]
pub enum TuiError {
    #[error("Terminal I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Terminal setup failed: {0}")]
    Setup(String),
    #[error("Render error: {0}")]
    Render(String),
    #[error("Widget not found: {0}")]
    WidgetNotFound(String),
    #[error("Layout error: {0}")]
    Layout(String),
}
```

## Snapshot Testing with TestBackend

ratatui's `TestBackend` enables deterministic widget snapshot testing without
a real terminal:

```rust
#[test]
fn renders_status_bar() {
    let backend = ratatui::backend::TestBackend::new(80, 24);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    let status = StatusBar::new("claude-sonnet-4", "45k", "$0.23");
    terminal.draw(|f| {
        f.render_widget(status, f.area());
    }).unwrap();
    insta::assert_snapshot!(terminal.backend().buffer().to_string());
}
```

Every widget must have at least one snapshot test. Complex widgets (Markdown,
VirtualScroll, Editor) should have multiple snapshots covering edge cases:
- Minimum size (80×24)
- Large content overflow
- Theme variation
- Empty state

## Tests

- Component render output matches expected ratatui snapshots (via `TestBackend` + `insta`)
- Layout resolution: Column/Row split space correctly
- Layout resolution: Expanded fills remaining
- Virtual scroll: only renders visible items
- Virtual scroll: scroll_by, scroll_to_bottom
- Theme loading from Lua table
- Overlay positioning with anchors
- Tool rendering: render_call produces Component for tool calls
- Tool rendering: render_result produces Component for tool results
- Tool rendering: RenderShell::Default vs Self framing
- Markdown: fenced Rust/Lua/TypeScript code renders with `syntastica` spans
- DiffView: unified and split diffs render with `similar` hunks and inline highlights
- FuzzyFilter: returns deterministic score + match indices for SelectList styling
- Editor: input handling, history, autocomplete
- TuiEvent conversion from crossterm events
- TuiApp lifecycle: new → run → shutdown (mocked event channel)
- Component handle_event returns correct consumed/not-consumed
- Border layout: panel toggle shows/hides correctly
- TerminalCapabilities: detection probes return expected values for known terminals
- TerminalCapabilities: graceful degradation when probe times out
- Mouse hit-testing: click inside widget focuses it
- Mouse hit-testing: click outside defocuses
- Mouse scroll: VirtualScroll receives wheel events
- Sticky widgets: render on top of normal widgets
- Sticky widgets: do not participate in layout resolution
- Kitty keyboard: Push/Pop flags on new/shutdown
- Kitty keyboard: per-flag detection (disambiguate, event_types, alternate_keys)
- Image protocol selection: Kitty > Sixel (Ghostty uses kitty graphics)
- Synchronized output: CSI 2026 wrapped around draw calls
- Hyperlink variant detection: OSC 8 then Ghostty OSC 10/11
- TerminalCapabilities: clipboard, notifications, semantic_prompts, undercurl

## Steps

- [ ] Create `smith-tui/Cargo.toml`
- [ ] Implement `TuiEvent` enum with crossterm conversion
- [ ] Implement `TuiError` error type
- [ ] Update Component/Focusable traits (ratatui Rect/Buffer render)
- [ ] Implement `TuiApp` struct (lifecycle, render loop, event dispatch)
- [ ] Implement Text, TruncatedText, Spacer
- [ ] Implement Markdown renderer
- [ ] Implement DiffView widget (`similar` + optional `syntastica` code spans)
- [ ] Implement Input widget
- [ ] Implement Editor widget
- [ ] Implement SelectList, SettingsList
- [ ] Implement Loader, CancellableLoader
- [ ] Implement TerminalCapabilities detection
- [ ] Implement Image widget
- [ ] Implement FuzzyFilter
- [ ] Implement Overlay system
- [ ] Implement ToolRenderer trait + registry + Lua bridge wrapper
- [ ] Implement VirtualScroll (highest priority)
- [ ] Implement Layout system (Column, Row, Box, Expanded, Scrollable, etc.)
- [ ] Implement BorderLayout
- [ ] Implement sticky widget render pass + hit-testing
- [ ] Implement Theme system
- [ ] Write snapshot tests with TestBackend + insta
- [ ] Verify: `cargo check -p smith-tui`
- [ ] Test: `cargo test -p smith-tui`
- [ ] Commit: `jj describe -m "feat(SM-008): smith-tui — widgets, layout, themes, TuiApp, tool rendering"`
