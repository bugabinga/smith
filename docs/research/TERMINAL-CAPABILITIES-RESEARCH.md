# Terminal Capabilities Research

**Date:** 2026-05-21
**Sources:** [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), [WezTerm Escape Sequences](https://wezterm.org/escape-sequences.html), [Ghostty](https://github.com/ghostty-org/ghostty)

## 1. Kitty Graphics Protocol

The kitty graphics protocol allows rendering arbitrary raster images inside the terminal via escape sequences.

### Transmission

- **Escape sequence:** `ESC _ G <key>=<value>,... ; <payload> ESC \`
- **Actions:** `t`=transmit+display, `T`=transmit only, `p`=placement, `q`=query, `d`=delete
- **Pixel formats:** 24-bit RGB, 32-bit RGBA, PNG (with deflate compression)
- **Transmission medium:** `m=0` direct (base64 payload), `m=1` shared memory (local-only, faster)
- **Compression:** `z=0` none, `z=1` deflate

### Placement

- `c`=columns, `r`=rows for cell-based sizing
- `x`/`y` offset within cell, `w`/`h` absolute pixel size
- `z`=z-index for layering multiple images
- `C=1` moves cursor after image
- `o`=overflow mode: `d` default, `z` z-index, `c` contain, `t` crop-to-cell

### Detection

Query available transmission mediums:
```
ESC _ Gq=s,m=i;payload ESC \
```

**Key finding:** Ghostty implements the kitty graphics protocol natively. There is no separate "Ghostty image protocol." `ImageProtocol::Ghostty` was incorrect.

## 2. Kitty Keyboard Protocol

Progressive enhancement for keyboard input with 6 capability flags.

### Progressive Enhancement Flags

| Bit | Flag | Meaning |
|-----|------|---------|
| 1 | Disambiguate | Distinguish `CSI u` from legacy `CSI A/B/C/D` |
| 2 | Event types | Report press/release/repeat separately |
| 4 | Alternate keys | Report layout-dependent key text |
| 8 | All keys as escape | Even text-producing keys sent as CSI u |
| 16 | Associated text | Include typed text alongside key code |
| 64 | No modify | Query-only, do not change input state |

### Detection

Send interleaved query:
```
ESC [ ? u       (keyboard enhancement query)
ESC [ c         (primary device attributes)
```

If keyboard enhancement response arrives before DA1 response, the protocol is supported. Crossterm's `supports_keyboard_enhancement()` implements this exact logic.

### Mode Stack

Programs can push/pop keyboard modes independently. Smith pushes flags on `TuiApp::new()` and pops on `shutdown()`.

## 3. WezTerm Escape Sequences

### SGR Extensions

- **RGB color:** `CSI 38:2:R:G:B m` (colon-separated, not semicolon)
- **RGBA color:** `CSI 38:6:R:G:B:A m` (alpha channel)
- **Underline styles:** `CSI 4:1 m` single, `4:2 m` double, `4:3 m` curly/undercurl, `4:4 m` dotted, `4:5 m` dashed
- **Underline color:** `CSI 58:2:R:G:B m`
- **Overline:** `CSI 53 m` on, `CSI 55 m` off
- **Strikethrough:** `CSI 9 m`
- **Italic:** `CSI 3 m` on, `CSI 23 m` off
- **Dim:** `CSI 2 m`

### OSC Sequences

- **OSC 8:** Hyperlinks (`OSC 8 ; params ; URI ST`)
- **OSC 9:** Desktop notifications
- **OSC 52:** Clipboard read/write
- **OSC 4:** Palette color change (256 colors)
- **OSC 10/11/12:** Default foreground/background/cursor color
- **OSC 7:** Current directory report

## 4. Ghostty

### Architecture

- Zig core with platform-native UI (SwiftUI macOS, GTK Linux)
- OpenGL/Metal rendering
- Multi-threaded: read, write, render threads per terminal
- `libghostty-vt`: C library for terminal emulation (public API)

### Supported Protocols

- Kitty graphics protocol (full)
- Kitty keyboard protocol
- Sixel
- Clipboard (OSC 52)
- Synchronized output (CSI ? 2026 h/l)
- Light/dark mode notifications
- Semantic zones / shell integration (OSC 3)

### Non-Standard Behaviors

- **Hyperlinks:** Ghostty uses OSC 10/11 for hyperlink start/end, not the standard OSC 8. This is non-standard but documented.
- **No separate image protocol:** Ghostty implements kitty graphics natively.

### libghostty-vt API

```c
// OSC parser (streaming byte-by-byte)
ghostty_osc_* functions

// Kitty graphics protocol
ghostty_kitty_graphics_* functions
// - Placement iteration
// - Image lookup
// - Pixel data management
```

## 5. Modern Terminal Capabilities Summary

| Capability | kitty | ghostty | wezterm | Detection Method |
|------------|-------|---------|---------|-----------------|
| Kitty graphics | ✅ | ✅ (native) | ✅ | OSC 204 query |
| Kitty keyboard | ✅ | ✅ | ✅ | CSI ? u + CSI c interleaved |
| Sixel | ❌ | ✅ | ✅ | DCS + q query |
| Synchronized output | ✅ | ✅ | ✅ | CSI ? 2026 h |
| OSC 8 hyperlinks | ✅ | ❌ (uses 10/11) | ✅ | Test both |
| OSC 52 clipboard | ✅ | ✅ | ✅ | Query |
| OSC 9 notifications | ✅ | ✅ | ✅ | Query |
| OSC 3 semantic prompts | ✅ | ✅ | ✅ | Query |
| Undercurl (SGR 4:3) | ✅ | ✅ | ✅ | TERM_PROGRAM |
| Truecolor | ✅ | ✅ | ✅ | COLORTERM |
| Bracketed paste | ✅ | ✅ | ✅ | Terminfo / TERM |

## 6. Design Implications for smith

1. **No `ImageProtocol::Ghostty`.** Ghostty uses kitty graphics. The enum should be `Kitty | Sixel` only.

2. **Per-flag keyboard capabilities.** Use crossterm's `KeyboardEnhancementFlags` to detect which progressive enhancement bits are supported, not just on/off.

3. **Synchronized output.** Enable `CSI ? 2026 h` during rendering to prevent flicker. Supported by all modern terminals.

4. **Hyperlink variant detection.** Test OSC 8 first; if no response, test Ghostty's OSC 10/11.

5. **No terminfo dependency.** Direct probing is more reliable than terminfo for modern terminals.

6. **Graceful degradation.** Every probe has a 100ms timeout. Failure conservatively disables the feature.

7. **Probe once.** Terminal capabilities don't change during a session.

## 7. viuer Evaluation

`viuer` is a Rust terminal image-display crate that supports Kitty graphics,
iTerm2 images, Sixel, and text/block fallbacks. It is useful when smith needs
multi-protocol image rendering from tool outputs.

Current decision: **defer**.

Rationale:
- v1 terminal-image needs are kitty-first and can be implemented with direct
  protocol primitives already documented above.
- Adding `viuer` now would use only a thin surface (`print_from_file` /
  `print_from_bytes`) while hiding placement/lifecycle control smith needs in a
  TUI widget.
- Re-evaluate if v2 requires Sixel/iTerm2 fallback, animation, or broad terminal
  image compatibility.
