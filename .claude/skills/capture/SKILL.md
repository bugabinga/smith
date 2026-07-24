---
name: capture
description: Capture legible screenshots (PNG) and recordings (GIF/MP4) of TUI runs for PRs, QA, and debugging. Invoke with a target, e.g. /capture prototypes/p27 layout demo.
---

# capture — TUI screenshots and recordings

Produce a legible still or recording of a terminal run, as evidence: what a
PR achieved, what a bug looks like, what a prototype does.

Focus on the target given with the invocation — what to run and what
behavior to show. If none was given, ask for one.

## Workflow

1. **Tools.** Needs `vhs`, `ttyd`, `ffmpeg` (plus `freeze` for the
   fallback still path). Any missing → `references/setup.md`.
2. **Write a tape.** Copy from `examples/`, keep the sizing defaults
   (`FontSize 20`, `Width 1200`, `Height 700`, `Padding 12` — legibility
   comes from font size, not canvas size). Full syntax and sizing math →
   `references/tape.md`.
3. **Run.** `VHS_NO_SANDBOX=true vhs the.tape` (`VHS_NO_SANDBOX` is
   required when running as root, which agent sandboxes usually are).
4. **Look at it.** Read the PNG (and GIF) yourself before delivering.
   Illegible text, mistimed frames, wrong state on screen → fix the tape,
   rerun. Never ship a capture you have not seen.
5. **Deliver.** GIF for anything that must render inline on GitHub; how and
   where to put files → `references/publishing.md`.

## Rules

- **Capture, don't fabricate.** The image must be a render of a real
  terminal session (vhs, or tmux + freeze). Never fake a "screenshot" by
  drawing command output into an image with an image library — that is
  fabricated evidence, and colors/attributes/interaction state are lost.
- **One capture, one claim.** Show exactly the behavior the PR or issue is
  about. Trim scope with terminal size and tape length, never by editing
  the image afterwards.
- **Deterministic tapes.** Drive the app with `Type`/`Enter`/key commands;
  `Wait` on a completion pattern for anything of variable duration, `Sleep`
  only for UI settle. No wall-clock-dependent content in the frame if you
  can avoid it (clocks, PIDs, load averages make diffs and reruns noisy).
- **Stills are tapes too.** Use the `Screenshot` command inside a tape; it
  captures at an exact scripted moment.
- **No browser or ffmpeg available?** Use the tmux + `freeze` still path
  in `references/setup.md`. Recordings need vhs; stills do not.

## Status block

End with Markdown, not JSON:

```markdown
## Status
complete | blocked

## Artifacts
- `path/to/capture.gif` — what it shows

## Actions
- ...
```
