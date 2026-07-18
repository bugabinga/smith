# p35-adw-harness

Tests the **mechanics** the agentic workflow (AGENTIC-DEVELOPMENT.md) rides on,
which no amount of local YAML linting can prove:

1. Do the App secrets mint a working installation token
   (`actions/create-github-app-token@v1` from `APP_ID` / `APP_PRIVATE_KEY`)?
2. Does `anthropics/claude-code-action@v1` actually run in Actions with that
   token + `ANTHROPIC_API_KEY`, and what are its **real input names**? (Flagged
   uncertain when the ADW workflows were authored.)
3. Can it invoke a repo subagent (`.claude/agents/*.md`) and a model override?

The harness workflow is `.github/workflows/p35-adw-harness.yml`, push-triggered
on this branch and path-scoped so it runs only when p35 changes — it does not
need to be on `main`, unlike the real `issues`/`pull_request` ADW workflows. The
action step is `continue-on-error` so the run always completes and the logs are
readable even when an input name is wrong; the wrong-input error *is* the
evidence.

Once the correct invocation is pinned here, the same shape is applied to the
real ADW workflows. Disposable evidence (SPEC §18); delete once folded.
