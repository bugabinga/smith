# Getting captures into PRs and issues

## The iron rule

**No capture ever enters the git object store.** Not on a branch, not
"temporarily", not on an orphan ref — blobs in git history are permanent
bloat (owner ruling). The only exception is an asset that *ships* as
product content (docs site, book), which is committed deliberately like
any other source file.

## Format choice

- **GIF** — the default. It is the only motion format GitHub renders
  inline from a markdown image link, and it is all an agent can publish
  (the drag-and-drop attachment upload that accepts MP4 is web-UI-only,
  with no API).
- **MP4** — smaller for long demos, but only a human can attach it to a
  PR body. Emit as a secondary `Output` when the GIF would bust 10 MB,
  hand it over, and say so.
- **PNG** — stills; always fine.

## Where evidence goes: release assets, not git

Release assets live outside git (they add zero objects and don't count
toward repo size), are uploadable by the bot via API, and their URLs
render inline in PR/issue bodies.

1. Ensure the rolling evidence prerelease exists (first use only):
   `gh release create captures --prerelease --title "capture evidence"
   --notes "PR/issue evidence uploads; not a product release."`
   The tag points at an existing commit — no new git objects.
2. Upload with a unique, traceable name:
   `gh release upload captures pr53-fold-demo.gif`
3. Embed:
   ```markdown
   ![fold demo](https://github.com/bugabinga/smith/releases/download/captures/pr53-fold-demo.gif)
   ```
4. Fetch the URL once to confirm it resolves before posting.

Evidence for a closed/merged PR can be deleted later
(`gh release delete-asset captures <name>`) — or kept; either way git
history is untouched.

Throwaway QA/debug captures stay in the scratchpad and get Read there;
publish only what a human needs to see.

## Checklist before embedding

- You Read the image and the text is legible at PR-body width (~900 px).
- **No secrets in any frame** — keys, tokens, private paths, provider
  responses. Captures are secret sinks like logs; a frame is published
  forever once fetched. When in doubt, re-capture with a scrubbed
  environment.
- File ≤ 10 MB (GitHub stops inlining above that).
- The frame shows the claim — not a prompt, not build output.
- Asset name carries its origin (`pr<N>-` / `issue<N>-` prefix).
