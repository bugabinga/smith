# p37 — Codex as a CI reviewer on the ChatGPT subscription

Proves the mechanics the **cross-family CI reviewer** rides on (AGENTIC-DEVELOPMENT
→ *Cross-family review*), which no local check can settle: can Codex run inside
GitHub Actions authenticated by the owner's **ChatGPT subscription** — not a
metered OpenAI API key — and post a review? Mirrors p35's proof for Claude.

The harness is `.github/workflows/p37-codex-harness.yml`, push-triggered on this
branch and path-scoped. Every step is `continue-on-error`, so the run completes and
the logs are the evidence — a missing-auth or wrong-flag error *is* the finding.

## Status
blocked — needs the owner secret to complete the auth half (install/invocation
half provable now)

## Proved (from OpenAI's docs, to be confirmed by the run)
- There is an official **`openai/codex-action@v1`** (the Codex analog of
  `claude-code-action`) that installs the CLI and runs `codex exec`.
- Non-interactive form is `codex exec --json --ephemeral` (JSONL to stdout, no
  session files) — suitable for a CI reviewer.
- Subscription auth in CI **is** possible: restore the ChatGPT-login `auth.json`
  from a secret before the run.

## Disproved / cautions (the two costs that shape the decision)
- **`auth.json` goes stale ~every 8 days.** A CI reviewer would need the secret
  refreshed and persisted back on a cadence — a standing maintenance burden that
  cuts against "autonomous with near-zero owner input."
- **Headless runs draw from the ChatGPT plan's shared 5-hour rolling window.** A
  reviewer firing on every PR competes with the owner's own interactive Codex use
  and can exhaust it. This is the load-bearing reason to keep Codex review
  **advisory and rate-limited**, and the contributor path (Codex opens PRs the ADW
  reviews) more attractive since it doesn't add per-PR CI cost.

## Spec Issues
- None against `docs/SPEC.md` (this validates the ADW's cross-family-review plan).

## Prototype Artifacts
- `.github/workflows/p37-codex-harness.yml`
- `prototypes/p37-codex-review/PLAN.md`

## Commands
- Push this branch (or `workflow_dispatch`) to run the harness; read the run log.
- Owner precondition for the auth half: `codex login` locally, then add the
  contents of `~/.codex/auth.json` as the repo secret **`CODEX_AUTH_JSON`**.
- The harness prints, per single review: the **resolved model**, the **token
  usage**, and the **5-hour-window cost** (rate-limit `used_percent` / reset), so
  the owner can price a cadence before wiring `adw-codex-review.yml`.

## Next Steps
- Owner: add `CODEX_AUTH_JSON` and re-run to confirm `codex exec` returns
  `CODEX-HARNESS-OK` on subscription auth, and which of the CLI vs
  `openai/codex-action@v1` path is cleaner.
- If it passes and the owner accepts the refresh + shared-window costs, add
  `adw-codex-review.yml` (advisory, on `pull_request`, rate-limited), feeding the
  reviewers per PR #31 — never a gate label.
- If the costs aren't worth it, ship the **contributor** path only (issue #32) and
  delete this prototype. Disposable evidence (SPEC §18).
