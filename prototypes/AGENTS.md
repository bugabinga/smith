# prototypes

Purpose: prove or invalidate `../docs/SPEC.md` with tiny disposable prototypes.

Rules:
- Read `../AGENTS.md`, this file, then `../docs/SPEC.md` before work.
- One prototype = one SPEC claim/risk.
- Keep code minimal. No production crates. No broad implementations.
- Prefer compile checks, focused tests, and runnable repros.
- Every prototype must have a command that verifies the claim.
- Evidence beats opinion. Report SPEC defects with exact command output.
- Do not edit `../docs/SPEC.md` unless explicitly asked.
- Delete throwaway work unless user asks to keep it.

Required result JSON:
```json
{
  "status": "complete|blocked|failed",
  "proved": [],
  "disproved": [],
  "specIssues": [
    {
      "file": "../docs/SPEC.md",
      "issue": "missing/false/unclear requirement",
      "evidence": "prototype path + command + result",
      "severity": "P0|P1|P2|P3"
    }
  ],
  "prototypeArtifacts": [],
  "commands": [],
  "nextSteps": []
}
```
