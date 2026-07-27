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
require .github/workflows/adw-build.yml 'open a PR that closes the issue' \
  'Claude builder is instructed to open a closing PR'
if grep -R -q --include='adw-*.yml' 'anthropics/claude-code-action@v1' .github/workflows; then
  echo "FAIL ADW pins Claude Code Action past the tsconfig crash"
  fail=1
else
  echo "PASS ADW pins Claude Code Action past the tsconfig crash"
fi

exit "$fail"
