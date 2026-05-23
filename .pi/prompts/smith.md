---
name: smith
description: Create or refine smith spec docs. No code.
argument-hint: "[topic]"
---

Create or edit `docs/SPEC.md` only.
Only markdown.
No `.rs`, `.toml`, scripts.

Focus on $ARGUMENTS.

Spec content must state desired project behavior:
- purpose,
- interfaces,
- data types,
- error handling,
- test strategy.

Read `AGENTS.md`, `docs/SPEC.md`, and related design/research docs first.
Stay consistent with `docs/PROJECT-INVARIANTS.md`.

Stop and ask on architectural decisions.
Do not guess.

Output structured JSON at end:

```json
{
  "status": "complete | blocked | needs-user-input",
  "summary": "...",
  "files": ["docs/SPEC.md"],
  "actions": ["Updated SPEC"],
  "notDone": ["..."],
  "nextSteps": ["..."]
}
```
