#!/usr/bin/env bash
set -euo pipefail

fail=0

require() {
  local file=$1
  local pattern=$2
  local message=$3
  if ! grep -Eq -- "$pattern" "$file"; then
    echo "FAIL $message"
    fail=1
  else
    echo "PASS $message"
  fi
}

require .github/workflows/adw-review.yml 'Assert a verdict was cast' \
  'review workflows assert verdict labels instead of trusting action exit status'
require .github/workflows/adw-review.yml 'attempt 1 ended without a verdict' \
  'review workflows retry a no-verdict attempt once'
require .github/workflows/adw-review.yml 'need_correctness=' \
  'Codex fallback probes missing artifacts instead of job failure alone'
require .github/workflows/adw-review.yml 'Re-trigger approval gate' \
  'reviewers re-trigger the gate after their marker evidence exists'
require .github/workflows/adw-review.yml 'HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}' \
  'review evidence is tied to the current PR head'
require .github/workflows/adw-review.yml 'Security review:' \
  'security-reviewer marker cannot be confused with correctness reviewer marker'
require .github/workflows/adw-gate.yml 'Fallback review:' \
  'merge gate binds labels to evidence for the current head'
require .github/workflows/adw-gate.yml 'VERDICT: reviewed' \
  'merge gate binds an approval label to an approval comment'
require .github/workflows/adw-review.yml 'pulls/\$PR/files' \
  'Codex fallback refuses merge labels for binary or incomplete files'
require .github/workflows/adw-review.yml 'previous_filename' \
  'Codex fallback protects renamed instruction files'
require .github/workflows/adw-review.yml 'split\("\\n"\)\[1\]' \
  'review assertions bind labels to their verdict lines'
require .github/workflows/adw-review.yml 'pull-requests: read' \
  'Codex fallback runs without a write-capable GitHub token'
require .github/workflows/adw-review.yml 'if ! gh pr comment "\$PR" --repo "\$REPO" --body-file c.md; then' \
  'Codex fallback refuses labels when its marker comment cannot post'
require .github/workflows/adw-review.yml 'codex-fallback:' \
  'Codex fallback runs only after a Claude review artifact fails'
require .github/workflows/adw-review.yml "needs\.reviewer\.result == 'failure'" \
  'Codex fills a missing correctness verdict, not a concurrent review'
require .github/workflows/adw-review.yml "needs\['security-reviewer'\]\.result == 'failure'" \
  'Codex fills a missing security verdict, not a concurrent review'
require .github/workflows/adw-review.yml 'CORRECTNESS: approve \| changes-requested' \
  'Codex fallback emits a machine-readable correctness verdict'
require .github/workflows/adw-review.yml 'SECURITY: cleared \| risk-high' \
  'Codex fallback emits a machine-readable security verdict'
require .github/workflows/adw-review.yml 'ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}' \
  'Codex fallback reads trusted instructions from the PR base'
require .github/workflows/adw-review.yml 'AGENTS\.md' \
  'Codex fallback protects agent instruction files'
require .github/workflows/adw-review.yml '\.pi/\*|\.agents/\*' \
  'Codex fallback protects harness instruction surfaces'
require .github/workflows/adw-review.yml 'files=\$\(gh api "repos/\$REPO/pulls/\$PR/files"' \
  'Codex fallback fails when protected-path inspection fails'
require .github/workflows/adw-gate.yml '"Review: \$HEAD_SHA"\|"Review: \$HEAD_SHA "\*' \
  'merge gate accepts a current-head reviewer marker with a finding suffix'
require .github/workflows/adw-build.yml 'git fetch origin "\$branch:refs/remotes/origin/\$branch"' \
  'Claude builder fetches the stable branch as a tracking ref'
require .github/workflows/adw-build.yml 'git checkout --track "origin/\$branch"' \
  'Claude builder checks out an existing stable branch before retrying'
require docs/plans/AGENTIC-DEVELOPMENT.md 'fallback UI/UX' \
  'ADW guide records Codex UI/UX fallback ownership'
if grep -Fq 'Advisory as a reviewer — it never sets a gate label.' docs/plans/AGENTIC-DEVELOPMENT.md; then
  echo "FAIL ADW guide records Codex fallback gate semantics"
  fail=1
else
  echo "PASS ADW guide records Codex fallback gate semantics"
fi
if [ "$(grep -c 'ref: \${{ github.event.pull_request.base.sha }}' .github/workflows/adw-review.yml)" -lt 3 ]; then
  echo "FAIL all review providers pin project instructions to the PR base"
  fail=1
else
  echo "PASS all review providers pin project instructions to the PR base"
fi
require .github/workflows/adw-review.yml 'MAX_DIFF_BYTES=100000' \
  'Codex fallback refuses merge labels for an incomplete diff'
require .github/workflows/adw-review.yml 'changedFiles' \
  'Codex fallback refuses merge labels beyond GitHub’s diff file limit'
require .github/workflows/adw-review.yml 'REVIEWER_FAILED' \
  'Codex fallback re-reviews labels from a failed Claude job'
if awk '/^  codex-apply:/{p=1} p && /--remove-label changes-requested/{found=1} END{exit !found}' .github/workflows/adw-review.yml; then
  echo "FAIL Codex fallback must preserve a reviewer rejection"
  fail=1
else
  echo "PASS Codex fallback preserves a reviewer rejection"
fi
require .github/workflows/adw-review.yml 'codex-apply:' \
  'Codex assessment cannot reach the token-bearing label reducer'
if awk '/^  codex-apply:/{p=1} p && /github\.token/{found=1} END{exit !found}' .github/workflows/adw-review.yml; then
  echo "FAIL Codex reducer must not fall back to github.token"
  fail=1
else
  echo "PASS Codex reducer requires its App token"
fi
require .github/workflows/adw-review.yml 'needs: \[reviewer, security-reviewer, codex-fallback\]' \
  'Codex reducer receives the failed-provider state in a clean downstream job'
require .github/workflows/adw-codex-review.yml 'advisory' \
  'ordinary Codex review remains advisory'

require .github/workflows/adw-build.yml 'Create the Claude issue branch' \
  'Claude builder creates its stable issue branch before agent mode'
require .github/workflows/adw-build.yml 'CLAUDE_BRANCH: "claude/issue-\$\{\{ github\.event\.issue\.number \}\}"' \
  'Claude builder directs agent mode to its stable issue branch'
require .github/workflows/adw-build.yml 'use_commit_signing: true' \
  'Claude builder keeps GitHub-verified App commits'
require .github/workflows/adw-build.yml 'id: claude' \
  'Claude builder exposes its result to the fallback path'
require .github/workflows/adw-codex-build.yml 'fallback:claude' \
  'Codex builder accepts a failed Claude UI/UX slice'
require .github/workflows/adw-build.yml 'repos/\$REPO/pulls' \
  'Claude builder probes same-repository PR artifacts through the API'
require .github/workflows/adw-build.yml 'timeout-minutes: 15' \
  'Claude builder bounds a provider hang before fallback'
require .github/workflows/adw-build.yml 'smith:claude-attempt/v1' \
  'Claude builder records a missing artifact for reconciliation'
if awk '/Record a missing Claude artifact/{p=1} p && /--add-label codex|--remove-label ready|--method PATCH/{found=1} END{exit !found}' .github/workflows/adw-build.yml; then
  echo "FAIL Claude builder must not route fallback labels"
  fail=1
else
  echo "PASS Claude builder leaves fallback routing to the reconciler"
fi
require .github/workflows/adw-codex-build.yml 'types: \[labeled, unlabeled\]' \
  'Codex builder rechecks work after a hold clears'
require .github/workflows/adw-build.yml 'closingIssuesReferences' \
  'Claude fallback accepts only an issue-closing PR artifact'
require .github/workflows/adw-build.yml 'qualifies=\$\(gh pr view' \
  'Claude fallback fails on PR artifact verification errors'
require .github/workflows/adw-codex-build.yml 'id: validate' \
  'Codex builder validates live routing before execution'
require .github/workflows/adw-codex-build.yml 'steps.validate.outputs.run == '\''true'\''' \
  'Codex builder skips stale routing events'
require .github/workflows/adw-codex-build.yml '\*,ready,\*\) run=false' \
  'Codex builder rejects a dual-routed issue'
require .github/workflows/adw-codex-build.yml 'return 2' \
  'Codex builder fails on artifact verification errors'
require .github/workflows/adw-codex-build.yml 'issue-labels.txt' \
  'Codex builder reads live route labels'
require .github/workflows/adw-codex-build.yml 'remote=\$\(git ls-remote origin' \
  'Codex builder distinguishes remote failure from an absent branch'
require .github/workflows/adw-codex-build.yml 'git checkout --track "origin/\$branch"' \
  'Codex builder resumes an existing fallback branch'
require .github/workflows/adw-build.yml 'numbers=\$\(gh api' \
  'Claude builder fails rather than duplicate on a PR lookup error'
require .github/workflows/adw-build.yml '-f "head=\$owner:\$branch"' \
  'Claude builder only trusts its own branch PR artifact'
require .github/workflows/adw-codex-build.yml 'set -o pipefail' \
  'Codex builder fails when its provider fails'
require .github/workflows/adw-revise.yml 'fallback:claude' \
  'Codex reviser preserves a Claude UI/UX fallback assignment'
require .github/workflows/adw-codex-build.yml 'fallback:claude' \
  'Codex builder distinguishes inherited Claude UI/UX work'
require .github/workflows/adw-codex-build.yml 'Closes #\$\{ISSUE\}' \
  'Codex fallback PR closes its routed issue'
require .github/workflows/adw-codex-build.yml 'smith:builder-route/v1' \
  'Codex fallback requires an armed reconciler record'
require .github/adw/reconcile-builder-routes.sh 'headRepository' \
  'Route reconciler rejects fork PR artifacts'
require .github/adw/reconcile-builder-routes.sh 'closingIssuesReferences' \
  'Route reconciler verifies the closed issue repository'
require .github/workflows/adw-sweep.yml 'bash .github/adw/reconcile-builder-routes.sh' \
  'Sweep runs deterministic route reconciliation'
if awk '/Reconcile builder routes/{seen=1} seen && /codex exec/{found=1; exit} END{exit !found}' .github/workflows/adw-sweep.yml; then
  echo "PASS sweep reconciles routes before Codex"
else
  echo "FAIL sweep must reconcile routes before Codex"
  fail=1
fi
require .claude/agents/sweeper.md 'Never add, remove, or replace `ready`, `codex`, or `fallback:claude`' \
  'Sweeper cannot mutate builder routes'
require .github/workflows/adw-build.yml 'open a PR that closes the issue' \
  'Claude builder is instructed to open a closing PR'
if grep -R -q --include='adw-*.yml' 'anthropics/claude-code-action@v1' .github/workflows; then
  echo "FAIL ADW pins Claude Code Action past the tsconfig crash"
  fail=1
else
  echo "PASS ADW pins Claude Code Action past the tsconfig crash"
fi

exit "$fail"
