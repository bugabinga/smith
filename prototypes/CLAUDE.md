# prototypes

Purpose: prove or invalidate `../docs/SPEC.md` with tiny disposable prototypes.

Rules:
- Read `../CLAUDE.md`, this file, then `../docs/SPEC.md` before work.
- One prototype = one SPEC claim/risk.
- Keep code minimal. No production crates. No broad implementations.
- Prefer compile checks, focused tests, and runnable repros.
- Every prototype must have a command that verifies the claim.
- Evidence beats opinion. Report SPEC defects with exact command output.
- Do not edit `../docs/SPEC.md` unless explicitly asked.
- Delete throwaway work unless user asks to keep it.

Required result format — Markdown, not JSON (canonical contract lives in
`.claude/skills/pioneer/SKILL.md`):

```markdown
## Status
complete | blocked | failed

## Proved
- spec claims supported by prototype evidence

## Disproved
- spec claims contradicted by prototype evidence

## Spec Issues
- `path`
  - Issue: what spec must clarify or change
  - Evidence: prototype path, command, compiler/test result
  - Severity: P0 | P1 | P2 | P3

## Prototype Artifacts
- paths created

## Commands
- commands run

## Next Steps
- concrete spec or design actions
```
