# SM-008: smith-tui/ — Terminal UI

Create the `smith-tui/` crate providing terminal UI primitives.

## Context

Foundation crate for all TUI rendering. Depends on smith/ (SM-005).
Exposes **widget creation** only — layout and data binding done by Lua plugins.

**Design doc:** `docs/TUI-CRATE-DESIGN.md` — read this first.

## Key Design Decisions

1. **ratatui + crossterm backend** — ratatui provides widget framework, layout engine, and `TestBackend` for snapshot tests; crossterm is the terminal I/O backend that ratatui drives
2. **TUI exposes widgets, Lua uses them** — even default layout is a Lua plugin
3. **Border layout** — center + N/E/S/W panels, panels empty/invisible by default
4. **Layout primitives** — Column, Row, Box, Expanded, Scrollable, Overlay, Widget, Spacer, Tabs, Split
5. **Virtual scroll** — highest priority widget, differential rendering
6. **Everything themable** via Lua tables
7. **17 widgets** matching pi's component set
8. **Tick-based render loop** — 16ms (≈60 FPS) tick, crossterm event polling, differential draw

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
#[derive(Clone, Debug)]
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

### 4. TuiApp — Render Loop

`TuiApp` owns the main TUI lifecycle. Created by `smith-harness`, driven by the
harness event loop.

```rust
use ratatui::{Terminal, Viewport};
use ratatui::backend::CrosstermBackend;
use std::time::Duration;

pub struct TuiApp {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
    border_layout: BorderLayout,
    widgets: HashMap<String, Box<dyn Component>>,
    focused_id: Option<String>,
    prev_focused_id: Option<String>,
    theme: Theme,
    tick_rate: Duration,
    running: bool,
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

        // 1. Enable raw mode (crossterm)
        // 2. Enter alternate screen
        // 3. Enable Kitty keyboard enhancement flags
        // 4. Create CrosstermBackend
        // 5. Create Terminal with backend
        // 6. Clear screen
        // 7. Disarm RAII guard on success
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

            // 3. Render
            self.terminal.draw(|f| {
                self.render_frame(f);
            })?;

            // 4. Tick wait (16ms ≈ 60 FPS)
            std::thread::sleep(self.tick_rate);
        }
        Ok(())
    }

    /// Dispatch a single event to the appropriate component.
    fn dispatch_event(&mut self, event: TuiEvent) {
        // 0. Defocus previously focused widget
        if self.prev_focused_id != self.focused_id {
            if let Some(prev_id) = &self.prev_focused_id {
                if let Some(widget) = self.widgets.get_mut(prev_id) {
                    if let Some(focusable) = widget.as_focusable_mut() {
                        focusable.set_focused(false);
                    }
                }
            }
            self.prev_focused_id = self.focused_id.clone();
        }

        // 1. Route key events to focused widget
        if let Some(id) = &self.focused_id {
            if let Some(widget) = self.widgets.get_mut(id) {
                // If widget implements Focusable, track focus state
                if let Some(focusable) = widget.as_focusable_mut() {
                    focusable.set_focused(true);
                }
                let consumed = widget.handle_event(&event);
                if consumed { return; }
            }
        }
        // 2. Route mouse events to widget at position
        // 3. Route resize to all widgets
        // 4. Check for global keybindings (panel toggles, etc.)
        // 5. If no handler consumed it, try focused widget
    }

    /// Render one frame using the border layout.
    fn render_frame(&self, frame: &mut ratatui::Frame) {
        let rect = frame.area();
        let layout = self.border_layout.resolve(rect);
        // Render each panel area
        // Render center with widget tree
    }

    /// Graceful shutdown. Restores terminal state.
    pub fn shutdown(&mut self) -> Result<(), TuiError> {
        self.running = false;
        // 1. Disable Kitty keyboard flags
        // 2. Leave alternate screen
        // 3. Disable raw mode
        // 4. Show cursor
        // 5. Flush stdout
    }

    // --- Widget management ---

    /// Register a widget instance by ID.
    pub fn register_widget(&mut self, id: String, widget: Box<dyn Component>);

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

### 5. Widgets (17 total)

**Primitives:**
- `Text` — multi-line text with word wrap
- `TruncatedText` — single-line, truncated to viewport
- `Markdown` — markdown rendering (headings, code, links, tables, syntax highlight)
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
- `FuzzyFilter` — fuzzy matching for search/filter
- `Overlay` — floating panel with configurable anchor and size

**Layout:**
- `VirtualScroll` — high-performance virtual scroll (most important widget)

All widgets implement `Component` using ratatui's `Rect`/`Buffer` render interface.

### 6. Layout System

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

### 7. Border Layout (predefined, only one)

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

### 8. Theme System

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

### 9. Virtual Scroll

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

### 10. Error Type

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
- Editor: input handling, history, autocomplete
- TuiEvent conversion from crossterm events
- TuiApp lifecycle: new → run → shutdown (mocked event channel)
- Component handle_event returns correct consumed/not-consumed
- Border layout: panel toggle shows/hides correctly

## Steps

- [ ] Create `smith-tui/Cargo.toml`
- [ ] Implement `TuiEvent` enum with crossterm conversion
- [ ] Implement `TuiError` error type
- [ ] Update Component/Focusable traits (ratatui Rect/Buffer render)
- [ ] Implement `TuiApp` struct (lifecycle, render loop, event dispatch)
- [ ] Implement Text, TruncatedText, Spacer
- [ ] Implement Markdown renderer
- [ ] Implement Input widget
- [ ] Implement Editor widget
- [ ] Implement SelectList, SettingsList
- [ ] Implement Loader, CancellableLoader
- [ ] Implement Image widget
- [ ] Implement FuzzyFilter
- [ ] Implement Overlay system
- [ ] Implement VirtualScroll (highest priority)
- [ ] Implement Layout system (Column, Row, Box, Expanded, Scrollable, etc.)
- [ ] Implement BorderLayout
- [ ] Implement Theme system
- [ ] Write snapshot tests with TestBackend + insta
- [ ] Verify: `cargo check -p smith-tui`
- [ ] Test: `cargo test -p smith-tui`
- [ ] Commit: `jj describe -m "feat(SM-008): smith-tui — widgets, layout, themes, TuiApp"`
