# smith-tui Crate Design

> **Historical document.** This design doc captures early TUI crate
> exploration. The canonical specification is `docs/SPEC.md` §8.
> Sections below that contradict `docs/SPEC.md` are stale.

## Overview

The `smith-tui` crate provides terminal UI rendering primitives. It exposes
**widget creation** only — actual layout and widget population is done in Lua
plugins. The default layout and widgets ship as a built-in Lua plugin.

## Core Principle: TUI Exposes Widgets, Lua Uses Them

- **smith-tui**: Widget primitives, rendering, input handling
- **Lua plugin**: Layout composition, data binding, widget instances

Even the default layout is a Lua plugin that can be overridden.

## Widget Catalog (from pi)

Based on pi's widget set, smith-tui exposes:

### Primitives

| Widget | Description |
|--------|-------------|
| `Text` | Multi-line text with word wrap |
| `TruncatedText` | Single-line text, truncated to viewport |
| `Markdown` | Markdown rendering (headings, code blocks, links, tables) with syntax-highlighted fenced code blocks |
| `DiffView` | Unified/split diff rendering with hunks, inline word highlights, and syntax-aware code styling |
| `Box` | Container with optional border |
| `Spacer` | Empty space filler |

### Input

| Widget | Description |
|--------|-------------|
| `Input` | Single-line text input with cursor, kill ring, undo |
| `Editor` | Multi-line text editor with autocomplete, history, paste, undo |

### Selection

| Widget | Description |
|--------|-------------|
| `SelectList` | Filterable list with keyboard navigation |
| `SettingsList` | Key-value settings with cycling values and submenus |

### Feedback

| Widget | Description |
|--------|-------------|
| `Loader` | Spinning loader with animated frames |
| `CancellableLoader` | Loader that can be cancelled with Escape |

### Media

| Widget | Description |
|--------|-------------|
| `Image` | Terminal image (Kitty protocol, Sixel fallback) |

### Utilities

| Widget | Description |
|--------|-------------|
| `FuzzyFilter` | Fuzzy matching for search/filter using `fuzzy-matcher` scores and match indices |
| `Overlay` | Floating panel with configurable anchor and size |

## Rendering Helpers

### Syntax highlighting

`Markdown` code blocks and code-oriented tool renderers use `syntastica` with
the `runtime-c2rust` feature. P16 verified this path on Android/Termux with zero
C runtime dependencies. The TUI core owns the highlighter/processor cache; Lua
plugins request highlighted content by language or file path.

```rust
pub struct SyntaxHighlighter {
    // wraps syntastica Processor + language set
}

impl SyntaxHighlighter {
    pub fn highlight_ansi(&mut self, code: &str, lang: Option<&str>) -> String;
    pub fn supports_language(&self, lang: &str) -> bool;
}
```

No automatic language detection for prose. Plugins pass explicit language or a
file path. Unsupported languages fall back to plain text.

### Diff rendering

`DiffView` uses `similar` for line/word diffs and hunk iteration. The widget
supports unified and side-by-side modes so Lua plugins can build time-travel,
replay-compare, and tool-result diff UIs without custom Rust feature code.

```rust
pub enum DiffMode { Unified, SideBySide }

pub struct DiffView {
    mode: DiffMode,
    old_label: String,
    new_label: String,
    hunks: Vec<DiffHunk>,
}
```

### Fuzzy filtering

`FuzzyFilter` wraps `fuzzy-matcher` and returns both score and matched indices.
`SelectList` and plugin-built timelines use these indices to style matched
characters in ratatui spans.

## Layout System: Border Layout

```
┌─────────────────────────────────────────────────┐
│                  [North Panel]                   │
├──────┬──────────────────────────────────┬───────┤
│      │                                  │       │
│[West]│          [Center]                │[East] │
│      │                                  │       │
│      │      (default: messages +        │       │
│      │       input area)                │       │
│      │                                  │       │
├──────┴──────────────────────────────────┴───────┤
│                  [South Panel]                   │
└─────────────────────────────────────────────────┘
```

- **Center**: Default layout (status bar + message list + input + hints)
- **North/East/South/West**: Empty, invisible by default
- Each panel has a default hotkey to toggle visibility
- Panels can be populated by plugins

## Default Layout (Lua Plugin)

The default center layout, shipped as a built-in Lua plugin:

```
┌─────────────────────────────────────────────────┐
│ [ctx 75%] [$0.02] [session: smith] [model: claude] │ ← StatusBar
├─────────────────────────────────────────────────┤
│                                                  │
│  User: What does this function do?               │
│                                                  │
│  Assistant: This function handles...             │
│                                                  │
│  Tool: read("src/main.rs")                       │
│  │  fn main() { ... }                           │
│                                                  │
│  Assistant: As you can see...                    │ ← MessageList (virtual scroll)
│                                                  │
│                                                  │
├─────────────────────────────────────────────────┤
│ > What's the next step?                          │ ← Editor
├─────────────────────────────────────────────────┤
│ [Tab] complete  [Ctrl+L] model  [/help] hints   │ ← HintBar
└─────────────────────────────────────────────────┘
```

## Virtual Scroll (Most Important Widget)

The `MessageList` widget uses virtual scrolling for performance:
- Only render visible messages
- Cache rendered lines per message
- Invalidate cache on resize or theme change
- Smooth scroll with configurable overscan

Reference: pi's differential rendering approach.

```rust
pub struct VirtualScroll {
    items: Vec<ScrollItem>,
    total_height: usize,
    viewport_height: usize,
    scroll_offset: usize,
    rendered_cache: HashMap<usize, Vec<String>>,
}

impl VirtualScroll {
    pub fn scroll_to(&mut self, offset: usize);
    pub fn scroll_by(&mut self, delta: i32);
    pub fn scroll_to_bottom(&mut self);
    pub fn render(&mut self, width: usize, height: usize) -> Vec<String>;
}
```

## Theme System

Every element is themeable. Themes are Lua tables:

```lua
-- ~/.smith/themes/catppuccin.lua
return {
    name = "catppuccin",

    -- Default text styling
    default_text = {
        fg = "#cdd6f4",
        bg = "#1e1e2e",
        bold = false,
        italic = false,
    },

    -- Markdown elements
    markdown = {
        heading = { fg = "#cba6f7", bold = true },
        link = { fg = "#89b4fa", underline = true },
        link_url = { fg = "#6c7086", italic = true },
        code = { fg = "#a6e3a1", bg = "#313244" },
        code_block = { fg = "#a6e3a1", bg = "#1e1e2e" },
        code_block_border = { fg = "#45475a" },
        quote = { fg = "#9399b2", italic = true },
        quote_border = { fg = "#89b4fa" },
        hr = { fg = "#45475a" },
        list_bullet = { fg = "#fab387" },
        bold = { bold = true },
        italic = { italic = true },
        strikethrough = { strikethrough = true },
    },

    -- Message roles
    user = { fg = "#cdd6f4", bg = "#1e1e2e" },
    assistant = { fg = "#cdd6f4", bg = "#181825" },
    tool = { fg = "#fab387", bg = "#26233a" },
    tool_error = { fg = "#f38ba8" },
    thinking = { fg = "#6c7086", italic = true },

    -- UI elements
    status_bar = { fg = "#a6adc8", bg = "#313244" },
    hint_bar = { fg = "#6c7086", bg = "#181825" },
    input = { fg = "#cdd6f4", bg = "#1e1e2e" },
    input_border = { fg = "#45475a" },
    loader = { fg = "#89b4fa" },
    error = { fg = "#f38ba8" },
    success = { fg = "#a6e3a1" },

    -- Select list
    select_list = {
        selected_prefix = { fg = "#89b4fa" },
        selected_text = { fg = "#cdd6f4", bold = true },
        description = { fg = "#6c7086" },
    },

    -- Border panels
    panel = {
        border = { fg = "#45475a" },
        bg = "#1e1e2e",
    },
}
```

## Overlay System

Floating panels for modals, fuzzy search, autocomplete:

```rust
pub enum OverlayAnchor {
    Center,
    TopLeft, TopRight, TopCenter,
    BottomLeft, BottomRight, BottomCenter,
    LeftCenter, RightCenter,
}

pub struct OverlayOptions {
    pub width: Option<Size>,       // absolute or percentage
    pub max_height: Option<Size>,
    pub anchor: OverlayAnchor,
    pub offset_x: i32,
    pub offset_y: i32,
    pub margin: Option<Margin>,
}

pub enum Size {
    Absolute(u16),
    Percent(u8),
}
```

## Component Trait (Rust)

```rust
/// Canonical: SM-008 §3. Uses ratatui-native signatures.
pub trait Component: Send + Sync {
    fn render(&self, area: Rect, buf: &mut Buffer);
    fn handle_event(&mut self, event: &TuiEvent) -> bool;
    fn invalidate(&mut self);
}

pub trait Focusable: Component {
    fn focused(&self) -> bool;
    fn set_focused(&mut self, focused: bool);
    fn as_focusable_mut(&mut self) -> Option<&mut dyn Focusable>;
}
```

## Keybindings

Default keybindings (overridable via Lua config):

```
# Panel toggles
Ctrl+1    toggle north panel
Ctrl+2    toggle east panel
Ctrl+3    toggle south panel
Ctrl+4    toggle west panel

# Navigation
Up/Down   scroll messages
PgUp/PgDn page scroll
Home/End  scroll to top/bottom

# Input
Enter     submit
Ctrl+C    abort
Ctrl+L    cycle model
Tab       autocomplete

# Editor (multiline input)
Alt+Enter newline
Ctrl+A    select all
Ctrl+Z    undo
```

## Panel Hotkeys

| Key | Panel | Default Content |
|-----|-------|----------------|
| Ctrl+1 | North | Empty |
| Ctrl+2 | East | Empty |
| Ctrl+3 | South | Empty |
| Ctrl+4 | West | Empty |

Plugins populate panels. Example: a file tree plugin could populate the west panel.

## Layout Primitives

Plugins compose layouts using primitives. The only predefined layout is the
master border layout. Everything else is built from these building blocks.

### Layout Types

```rust
pub enum Layout {
    /// Stack children vertically
    Column { children: Vec<Layout> },
    /// Stack children horizontally
    Row { children: Vec<Layout> },
    /// Fixed-size box with optional border
    Box {
        child: Box<Layout>,
        width: Option<Size>,
        height: Option<Size>,
        border: Option<Border>,
    },
    /// Flexible space (expands to fill)
    Expanded { child: Box<Layout> },
    /// Scrollable container
    Scrollable {
        child: Box<Layout>,
        direction: ScrollDirection,
    },
    /// Overlay / modal
    Overlay {
        child: Box<Layout>,
        options: OverlayOptions,
    },
    /// Widget slot (binds to a widget instance)
    Widget { id: String },
    /// Empty space with optional size
    Spacer { size: Option<Size> },
    /// Tabs
    Tabs {
        children: Vec<TabItem>,
        active: usize,
    },
    /// Split pane (resizable)
    Split {
        direction: SplitDirection,
        first: Box<Layout>,
        second: Box<Layout>,
        split_ratio: f32,
    },
}

pub enum ScrollDirection { Vertical, Horizontal, Both }
pub enum SplitDirection { Horizontal, Vertical }

pub struct Border {
    pub style: BorderStyle,
    pub title: Option<String>,
}

pub enum BorderStyle {
    Single, Double, Rounded, Thick, None,
}

pub struct TabItem {
    pub label: String,
    pub layout: Layout,
}
```

### Lua API for Layout

```lua
-- Create a column layout
local layout = smith.tui.layout.column({
    smith.tui.layout.widget("status_bar"),
    smith.tui.layout.expanded(
        smith.tui.layout.widget("message_list")
    ),
    smith.tui.layout.box({
        height = smith.tui.size.percent(20),
        border = smith.tui.border.rounded("Input"),
        child = smith.tui.layout.widget("editor"),
    }),
    smith.tui.layout.widget("hint_bar"),
})

-- Register as center content
smith.tui.set_center_layout(layout)
```

### Layout Resolution

```rust
/// Resolve a layout tree into render commands
pub fn resolve_layout(
    layout: &Layout,
    available: Rect,
    widgets: &HashMap<String, Box<dyn Component>>,
) -> Vec<RenderCommand>
```

Layout resolution walks the tree,分配 available space to children:
- `Column`: splits height among children (Expanded takes remaining)
- `Row`: splits width among children (Expanded takes remaining)
- `Box`: constrains child to fixed size, applies border
- `Widget`: renders the bound widget into the allocated rect

### Master Border Layout

The one predefined layout. Cannot be removed, only panels toggled:

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

Default state: all panels invisible, center uses the default Lua plugin layout.

## Deferred (v1 scope)

- Vim-style normal mode editing
- Inline image rendering (Kitty graphics protocol)
- Split pane resizing (Split layout primitive exists)
- Multiple simultaneous sessions
