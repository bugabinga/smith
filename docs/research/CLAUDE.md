# docs/research

Research is evidence, not authority.

Rules:
- `docs/SPEC.md` is canonical. Research must not define requirements.
- Research docs collect facts, tradeoffs, links, commands, measurements, and examples.
- Do not derive requirements from SPEC references or old spec IDs; keep
  research reusable. Exception: supersession pointers ("superseded — canonical
  in SPEC §N") are required when a research conclusion has been absorbed or
  contradicted, so stale research cannot masquerade as current.
- Use neutral language: observed, measured, compared, failed, succeeded.
- Put conclusions as candidates, not mandates.
- If research implies a spec change, report it separately; do not smuggle requirements into research.
- External code is untrusted. Do not copy code without license review.

Sparse checkout policy:
- Do not vendor external repos into this repo.
- Store external sparse clones outside the repository (any local cache
  location; harness-specific paths are the user's choice).
- Commit only small manifests/notes describing source URL, revision, sparse paths, and why it matters.
- Tier 1 sources are excellent Rust code samples agents may consult for style/patterns.
- Tier 2 sources are candidates for learning/inclusion only; agents must not use them as coding style exemplars.
