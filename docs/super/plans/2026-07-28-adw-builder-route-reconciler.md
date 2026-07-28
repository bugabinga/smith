# ADW Builder Route Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace racy event-driven Claude-to-Codex label routing with a deterministic, resumable scheduled reconciler.

**Architecture:** A Bash reconciler owns fallback route transitions through App-authored issue comments and targeted label calls. The Claude workflow records a missing artifact; the hourly sweep invokes the reconciler before the advisory LLM sweep; Codex accepts fallback work only when an armed App record and live issue state agree.

**Tech Stack:** GitHub Actions, Bash, GitHub CLI/REST API, jq, existing workflow contract tests.

**Roadmap:** None

**Phase:** Single-plan implementation

---

## File structure

- Create `.github/adw/reconcile-builder-routes.sh`: deterministic scan, durable route/attempt comments, targeted route transitions.
- Create `.github/adw/reconcile-builder-routes.test.sh`: fake-`gh` shell cases for every transition and failure path.
- Modify `.github/workflows/adw-build.yml`: emit an idempotent missing-Claude attempt record only.
- Modify `.github/workflows/adw-codex-build.yml`: require live, armed App fallback records; keep ordinary backend routing unchanged.
- Modify `.github/workflows/adw-sweep.yml`: invoke the reconciler with the App token before Codex.
- Modify `.claude/agents/sweeper.md`: prohibit LLM builder-route label changes.
- Modify `.github/adw/workflow-contract.test.sh`: assert the new workflow/script boundaries.

### Task 1: Failing reconciler fixtures

**Files:**

- Create: `.github/adw/reconcile-builder-routes.test.sh`
- Create: `.github/adw/reconcile-builder-routes.sh`

- [ ] **Step 1: Write a fake GitHub CLI fixture harness**

Create `reconcile-builder-routes.test.sh` with `set -euo pipefail`, a temporary `bin/gh`, and fixture JSON files. Route `gh issue list`, `gh issue view`, `gh api`, and `gh issue comment` through fixture variables; append every mutating command to `$CALLS`. Export `PATH="$tmp/bin:$PATH"`, `GH_TOKEN=test`, `REPO=owner/repo`, and `MAX_ISSUES=100`.

- [ ] **Step 2: Add failing cases**

Add test functions that invoke `.github/adw/reconcile-builder-routes.sh` and assert exact `$CALLS` sequences:

```bash
case_missing_attempt_does_not_route
case_hold_never_mutates_labels
case_missing_claude_attempt_writes_prepared_then_removes_ready_adds_fallback_arms_adds_codex
case_retry_resumes_prepared_without_second_route_comment
case_live_hold_after_prepared_pauses_before_next_label_call
case_same_branch_fork_pr_does_not_qualify
case_cross_repository_closing_reference_does_not_qualify
case_gh_read_failure_exits_nonzero_without_mutation
case_scan_stops_after_100_issues
```

Use `grep -E` for mutating calls whose route ID is dynamic; match `[0-9a-f-]{36}` rather than a fixed UUID. Require the route marker `smith:builder-route/v1`, source `claude/issue-<n>`, target `codex/issue-<n>`, and phases `prepared` then `armed`.

- [ ] **Step 3: Run the new test**

Run: `bash .github/adw/reconcile-builder-routes.test.sh`

Expected: FAIL because `.github/adw/reconcile-builder-routes.sh` does not exist.

### Task 2: Deterministic reconciler

**Files:**

- Create: `.github/adw/reconcile-builder-routes.sh`
- Test: `.github/adw/reconcile-builder-routes.test.sh`

- [ ] **Step 1: Implement required environment and bounded scan**

Implement a POSIX-Bash script with `set -euo pipefail`. Reject absent `GH_TOKEN` or `REPO`; default `MAX_ISSUES=100`; reject non-positive or over-100 bounds. List open `ready` issues and open `codex`+`fallback:claude` issues via `gh issue list --limit "$MAX_ISSUES" --json number`, deduplicate numeric issue IDs with `sort -nu`, and process at most `MAX_ISSUES` IDs.

- [ ] **Step 2: Implement App-owned records**

Use these exact markers in App-authored comments:

```text
<!-- smith:claude-attempt/v1 issue=<n> branch=claude/issue-<n> head=<sha|absent> outcome=<outcome> -->
<!-- smith:builder-route/v1 issue=<n> id=<uuid> source=claude/issue-<n> target=codex/issue-<n> phase=<prepared|armed|completed|cancelled> -->
```

Generate a route ID with `id=$(cat /proc/sys/kernel/random/uuid)`. Fetch issue comments with `gh api "repos/$REPO/issues/$issue/comments" --paginate`; accept markers only where `.user.login` equals the App bot login obtained once from `gh api user -q .login`. Select the latest active route record by comment ID. Edit only that comment through `PATCH repos/$REPO/issues/comments/<id>`.

- [ ] **Step 3: Implement artifact qualification**

For the candidate source or target branch, list open PRs using `GET repos/$REPO/pulls?state=open&head=<owner>:<branch>`. For each PR, fetch `baseRefName`, `headRepository`, and `closingIssuesReferences`; qualify only `baseRefName == "main"`, `headRepository.nameWithOwner == "$REPO"`, and a closing reference whose `repository.nameWithOwner == "$REPO"` and `number == issue`.

- [ ] **Step 4: Implement phase transitions with targeted labels**

For an open, unheld `ready` issue with a matching Claude attempt and no qualifying Claude PR: create `prepared` if no active route exists; then before each transition refetch `state,labels`. If state is not open or any hold exists, stop without label mutation. If `ready` exists, run `gh issue edit --remove-label ready`; ensure `fallback:claude`; edit the route comment to `armed`; ensure `codex`.

For an `armed` record, never remove/add primary-route labels again; only mark `completed` when a qualifying target PR exists. For a `prepared` record with a qualifying Claude PR, mark `cancelled` and remove only `fallback:claude` if present. Any API failure exits nonzero and preserves the current record phase.

- [ ] **Step 5: Run reconciler tests**

Run: `bash .github/adw/reconcile-builder-routes.test.sh`

Expected: PASS for all listed cases.

- [ ] **Step 6: Commit**

```bash
git add .github/adw/reconcile-builder-routes.sh .github/adw/reconcile-builder-routes.test.sh
git commit -m "Add deterministic builder route reconciler"
```

### Task 3: Record Claude failure without routing

**Files:**

- Modify: `.github/workflows/adw-build.yml:78-111`
- Modify: `.github/adw/workflow-contract.test.sh`
- Test: `.github/adw/reconcile-builder-routes.test.sh`

- [ ] **Step 1: Add failing contract assertions**

Replace assertions expecting `PATCH` and `codex` label mutation in `adw-build.yml` with assertions for `smith:claude-attempt/v1` and absence of `--add-label codex` and `--remove-label ready` within the Claude workflow's final step.

- [ ] **Step 2: Replace the fallback router step**

Keep the live issue and qualifying same-repository Claude PR checks. When no artifact exists, read `refs/heads/claude/issue-$ISSUE` for its SHA with `gh api ... -q .object.sha || printf absent`; list App-authored attempt comments matching the issue, branch, and resulting SHA-or-`absent`; post the exact `smith:claude-attempt/v1` marker only when absent. Include the Claude action outcome in the marker and human-readable comment body. Do not add, remove, or replace issue labels.

- [ ] **Step 3: Run contract tests**

Run: `bash .github/adw/workflow-contract.test.sh`

Expected: PASS, including the new no-routing assertions.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/adw-build.yml .github/adw/workflow-contract.test.sh
git commit -m "Record Claude builder misses for reconciliation"
```

### Task 4: Gate Codex fallback by live durable state

**Files:**

- Modify: `.github/workflows/adw-codex-build.yml:29-90`
- Modify: `.github/adw/workflow-contract.test.sh`

- [ ] **Step 1: Add failing validation assertions**

Require the Codex workflow to fetch App-authored `smith:builder-route/v1` comments, accept fallback UI/UX work only at `phase=armed`, and require `headRepository.nameWithOwner` in its PR qualification query.

- [ ] **Step 2: Simplify event trigger and validation**

Keep `issues.types: [labeled, unlabeled]`. Trigger on a `codex` addition or removal of one hold label (`blocked`, `risk:high`, `needs:info`, `needs:spec`, `needs:prototype`, `needs:breakdown`) while `codex` remains live; no other label removal wakes the builder. In `Validate live Codex route`, preserve the open, non-held, non-dual-route checks. For `fallback:claude`, require the latest App-authored route record for this issue to be `armed`; otherwise set `run=false`. For ordinary Codex backend work, do not require a route record. Replace every branch-PR check with the Task 2 qualification contract.

- [ ] **Step 3: Run workflow contracts**

Run: `bash .github/adw/workflow-contract.test.sh`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/adw-codex-build.yml .github/adw/workflow-contract.test.sh
git commit -m "Gate Codex fallback on reconciled route state"
```

### Task 5: Invoke reconciliation before the LLM sweep

**Files:**

- Modify: `.github/workflows/adw-sweep.yml:25-56`
- Modify: `.claude/agents/sweeper.md:1-70`
- Modify: `.github/adw/workflow-contract.test.sh`

- [ ] **Step 1: Add failing workflow contracts**

Assert `adw-sweep.yml` invokes `bash .github/adw/reconcile-builder-routes.sh` with `GH_TOKEN` and `REPO` before `codex exec`. Assert the sweeper charter says it must not add/remove `ready`, `codex`, or `fallback:claude`.

- [ ] **Step 2: Wire the deterministic step**

Add a step after App-token minting and before Codex auth:

```yaml
      - name: Reconcile builder routes
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          REPO: ${{ github.repository }}
          MAX_ISSUES: 100
        run: bash .github/adw/reconcile-builder-routes.sh
```

Keep failure fatal. Do not pass the App token into the Codex step beyond existing sweeper behavior.

- [ ] **Step 3: Restrict the LLM charter**

Add to `.claude/agents/sweeper.md`: “Never add, remove, or replace `ready`, `codex`, or `fallback:claude`; the deterministic reconciler owns builder routes.” Keep hold and stall authority unchanged.

- [ ] **Step 4: Validate all static contracts**

Run:

```bash
bash .github/adw/reconcile-builder-routes.test.sh
bash .github/adw/workflow-contract.test.sh
bash .github/adw/gate-labels.test.sh
for file in .github/workflows/adw-*.yml; do yq . "$file" >/dev/null; done
git diff --check
```

Expected: every shell test passes, every workflow parses, and no whitespace errors occur.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/adw-sweep.yml .claude/agents/sweeper.md .github/adw/workflow-contract.test.sh
git commit -m "Run builder reconciliation before sweeping"
```

### Task 6: PR verification

**Files:**

- Modify: PR #145 only through the prior tasks.

- [ ] **Step 1: Verify signed commits and clean tree**

Run:

```bash
git status --short
git log --show-signature --format=oneline origin/main..HEAD
```

Expected: no unstaged changes; every implementation commit reports `Good "git" signature`.

- [ ] **Step 2: Push and inspect CI**

Push the branch, then run:

```bash
gh pr checks 145 --repo bugabinga/smith --watch
gh pr view 145 --repo bugabinga/smith --json labels,comments,statusCheckRollup
```

Expected: workflow contracts pass; PR remains blocked until owner review because protected ADW files intentionally fail closed.
