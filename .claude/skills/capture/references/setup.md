# Tool setup

All steps verified on Ubuntu 24.04 (noble) inside a root agent container.

## Recording stack (vhs)

`vhs` scripts a real headless terminal (ttyd + Chromium) and renders
GIF/MP4/PNG via ffmpeg.

```sh
apt-get update
apt-get install -y ffmpeg ttyd     # noble ships ttyd 1.7.4
go install github.com/charmbracelet/vhs@latest
export PATH="$PATH:$HOME/go/bin"
```

No Go toolchain? Use the release binaries:
<https://github.com/charmbracelet/vhs/releases> and
<https://github.com/tsl0922/ttyd/releases> (static `ttyd.x86_64`).

Notes:

- First run downloads a Chromium into `~/.cache/rod/` (needs network).
- Running as root: set `VHS_NO_SANDBOX=true` or the browser refuses to
  start (`Running as root without --no-sandbox is not supported`).
- A pre-installed Playwright Chromium does not help; vhs uses its own.

## Still-only fallback (tmux + freeze)

When no browser/ffmpeg is possible, capture the pane's ANSI and render it
to PNG. No recordings on this path, stills only.

```sh
go install github.com/charmbracelet/freeze@latest

tmux new-session -d -s cap -x 120 -y 30 'the-tui-command'
sleep 3                                   # let the UI settle
# optional: drive it — tmux send-keys -t cap j j Enter
tmux capture-pane -t cap -ep > pane.ansi  # -e keeps colors
tmux kill-session -t cap
freeze pane.ansi --output shot.png --font.size 16
```

## Health check

```sh
for t in vhs ttyd ffmpeg freeze; do command -v "$t" || echo "$t missing"; done
```
