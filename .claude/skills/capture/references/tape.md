# Tape writing and sizing

A `.tape` is a deterministic script: settings first, then keystrokes and
sleeps. Full grammar: `vhs manual`.

## The commands that matter

| Command | Use |
|---|---|
| `Output demo.gif` | render target; repeat for more formats (`.mp4`, `.webm`); omit entirely for still-only tapes |
| `Require cmd` | fail fast if `cmd` is not installed |
| `Set <option> <val>` | see sizing below; must precede all actions |
| `Type "text"` / `Enter` / `Down 3` / `Ctrl+C` | drive the app; every special key is a bare command (`Space`, `Tab`, `Escape`, `PageDown`, arrows with optional repeat count) — there is no `Key` prefix |
| `Wait+Screen /re/` | block until output matches — use for anything of variable duration (builds, downloads); `Set WaitTimeout 60s` raises the cap. The typed command is on screen too, so a sentinel it contains matches instantly — split it (`echo BU''ILT`, wait for `/BUILT/`) |
| `Sleep 2s` | fixed wait — for UI settle after launch/keystrokes, where no completion pattern exists |
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

## Two environment traps

- **No UTF-8 locale in the vhs shell.** Non-ASCII text (§, em-dashes,
  box-drawing) renders as raw bytes like `<C2><A7>`. Put
  `Env LANG "C.UTF-8"` in every tape (add `Env LESSCHARSET "utf-8"` when
  driving `less`), and when verifying the output, check a non-ASCII glyph
  specifically.
- **Absolute `Output` paths can be rejected** by the tape parser (e.g.
  deep paths with hyphen-leading components). Keep `Output` and
  `Screenshot` paths relative and run `vhs` from the directory the files
  belong in.

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
Set WaitTimeout 120s
Env LANG "C.UTF-8"
Hide
Type "cd prototypes/p27-per-frame-layout && cargo build -q && echo BU''ILT"
Enter
Wait+Screen /BUILT/
Show
Type "cargo run -q"
Enter
Sleep 3s
Screenshot startup.png
Down 3
Sleep 1s
Type "q"
Sleep 500ms
```
