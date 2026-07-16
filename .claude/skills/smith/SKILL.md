---
name: smith
description: Create or refine the smith spec (docs/SPEC.md). Markdown only, no code. Invoke with a topic, e.g. /smith compaction thresholds.
disable-model-invocation: true
---

# smith — spec work

Create or edit `docs/SPEC.md` only.
Only markdown.
No `.rs`, `.toml`, scripts.

Focus on the arguments provided with the invocation (the spec topic). If no
topic was given, ask for one.

Spec content must state desired project behavior — interfaces, data, errors,
tests — **as named shapes and behavior, not code**. Exact only at boundaries
others program against (files, wire formats, CLI, config, Lua SDK); code
blocks are illustrative unless the section says otherwise. See `AGENTS.md`
rule 3 and SPEC §1 "Exact at boundaries, shapes inside".

Read `AGENTS.md` and `docs/SPEC.md` first. `docs/research/` is evidence,
non-normative. Stay consistent with `docs/PROJECT-INVARIANTS.md`.

Stop and ask on architectural decisions.
Do not guess.

End with Markdown, not JSON:

```markdown
## Status
complete | blocked | needs-user-input

## Summary
...

## Files
- `docs/SPEC.md`

## Actions
- Updated SPEC

## Not Done
- ...

## Next Steps
- ...
```
