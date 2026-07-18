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

## Findings

- **Run 1 (claude-code-action@v1):** App token minted cleanly (identity works),
  but the action failed with `Unsupported event type: push`. The action only
  handles issue / pull_request / comment events. Consequence: the
  push/schedule/tag-triggered agents (planner, sweeper, docs-writer,
  release-manager) cannot use the action and need the event-agnostic
  `claude -p` headless CLI runner. The action stays valid for the issue/PR
  agents (triager, reviewer, security-reviewer, dependency-manager) — but those
  workflows only fire once they are on `main` (event workflows run from the
  default branch), so they can't be exercised from a branch.
- **Run 2 (headless `claude -p`):** the CLI installs and runs (`2.1.214`), so the
  event-agnostic runner path is real — but the call failed `Not logged in`
  because **`ANTHROPIC_API_KEY` is empty** in the job env (only `GH_TOKEN` was
  set). The model-auth secret (`ANTHROPIC_API_KEY` or, for subscription auth,
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) was never added. Owner
  action; no agent can call a model until it exists.

## Verdict

- **Proven:** App token mints (identity); the action *accepts* the input syntax
  `github_token` / `anthropic_api_key` / `prompt` / `claude_args --model` (it
  only rejected the event, not the inputs); the CLI installs and runs in CI.
- **Design decision (revised):** one runner — `claude-code-action@v1` for
  everything, in its two modes: *interactive* (issue/PR/comment) and *automation*
  (`schedule`/`workflow_dispatch`). `push` fits neither, so `planner` is relayed
  by a plain no-Claude watcher that `gh workflow run`s it on `workflow_dispatch`.
  The headless CLI is dropped.
- **Auth is subscription, not API.** All workflows use `claude_code_oauth_token`
  (`claude setup-token`), drawing on the owner's plan — no metered API. The
  earlier CLI failure was only because it was pointed at an (empty)
  `ANTHROPIC_API_KEY`.
- **Blocked on owner:** add `CLAUDE_CODE_OAUTH_TOKEN` (#13); merge to `main`
  (event workflows run only from the default branch) to exercise end to end (#14).

<!-- token re-verify: 2 -->
