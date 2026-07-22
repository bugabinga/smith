# Tape writing and sizing

A `.tape` is a deterministic script: settings first, then keystrokes and
sleeps. Full grammar: `vhs manual`.

## The commands that matter

| Command | Use |
|---|---|
| `Output demo.gif` | render target; repeat for more formats (`.mp4`, `.webm`); omit entirely for still-only tapes |
| `Require cmd` | fail fast if `cmd` is not installed |
| `Set <option> <val>` | see sizing below; must precede all actions |
| `Type "text"` / `Enter` / `Key <k>` | drive the app (`Key` for ctrl/arrows, e.g. `Ctrl+C`, `Down 3`) |
| `Sleep 2s` | fixed wait — the only timing primitive; be generous after launch |
| `Screenshot shot.png` | still frame at exactly this point in the script |
| `Hide` / `Show` | exclude setup noise (cd, build output) from the render |

## Sizing for legibility — the TUI-specific part

A TUI screenshot fails by being a huge terminal with ant-sized text.
Fix the *font* size, then give the app only the columns it needs:

- `FontSize` ≥ 16; **20 is the default here**.
- Columns ≈ `(Width − 2·Padding) / (FontSize × 0.6)`. The defaults
  (`Width 1200`, `Padding 12`, `FontSize 20`) yield a ~98×27 grid — about
  right for a full-screen TUI rendered into a ~900 px-wide PR body.
- Wider app? Prefer 1600×800 @ FontSize 18 (~145 cols) over shrinking the
  font further. Below 14 pt, text in a PR is decoration, not evidence.
- `Set Theme "Catppuccin Mocha"` (or any high-contrast dark theme) and
  `Set Padding 12` keep edges and colors readable.

## Keeping recordings small

GitHub renders inline images up to ~10 MB; aim well under.

- Shortest tape that proves the claim; ≤ 30 s of footage.
- `Set PlaybackSpeed 2` to compress long waits; `Set TypingSpeed 50ms`
  so typing does not dominate.
- `Set Framerate 24` (default 50) roughly halves GIF size.
- Long or high-motion demo → also emit `Output demo.mp4` and let a human
  attach it (see publishing.md); keep the GIF as the inline version.

## Skeleton

```tape
Require cargo
Output demo.gif
Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 12
Set Theme "Catppuccin Mocha"
Hide
Type "cd prototypes/p27-per-frame-layout && cargo build -q"
Enter
Sleep 30s
Show
Type "cargo run -q"
Enter
Sleep 3s
Screenshot startup.png
Key Down 3
Sleep 1s
Type "q"
Sleep 500ms
```
