# Getting captures into PRs and issues

## Format choice

- **GIF** — the default. It is the only motion format GitHub renders
  inline from a markdown image link, and PNG/GIF is all an agent can
  publish (the drag-and-drop attachment upload that accepts MP4 is
  web-UI-only, not reachable via API).
- **MP4** — smaller and smoother for long demos, but only a human can
  attach it to a PR body. Emit it as a secondary `Output` when the GIF
  would bust 10 MB, park it in the branch or hand it over, and say so.
- **PNG** — stills; always fine.

## Where the files go

- **Evidence for a PR or issue** (the common case): push captures to the
  dedicated orphan branch `captures` (create with `git switch --orphan
  captures` if absent), path `captures/<topic>/`, then embed by raw URL:

  ```markdown
  ![fold demo](https://raw.githubusercontent.com/bugabinga/smith/captures/captures/session-fold/demo.gif)
  ```

  This keeps binary blobs out of `main`'s history — the evidence branch
  never merges. Pushing there is an exception to branch discipline scoped
  to `captures/` paths only.

- **Assets that ship** (docs, site, book): commit on the feature branch
  like any other file, wherever the doc that embeds them lives.

- **Throwaway QA/debug captures**: leave them in the scratchpad and Read
  them there; only publish what a human needs to see.

## Checklist before embedding

- You Read the image and the text is legible at PR-body width (~900 px).
- File ≤ 10 MB (GitHub stops inlining above that).
- The frame shows the claim — not a prompt, not build output.
- Raw URL hits the pushed commit (fetch it once to confirm).
