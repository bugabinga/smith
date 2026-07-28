# Planner and Surveyor Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep backlog planning and surveying alive when Claude fails.

**Architecture:** Claude remains primary. Each planner mode and surveyor marks the Claude step non-fatal, then conditionally runs the same charter through Codex `sol`; Codex failure remains fatal.

**Tech Stack:** GitHub Actions, Bash contract tests, Claude Code Action, Codex CLI.

**Roadmap:** None

**Phase:** Single-plan implementation

---

### Task 1: Contract tests

**Files:**
- Modify: `.github/adw/workflow-contract.test.sh`

- [ ] Require four named Claude steps with `continue-on-error: true`.
- [ ] Require four Codex fallback steps conditioned on `steps.claude.outcome == 'failure'`.
- [ ] Require `gpt-5.6-sol`, `set -o pipefail`, and the canonical planner/surveyor charters.
- [ ] Run the test and observe failure because no fallback exists.

### Task 2: Planner fallback

**Files:**
- Modify: `.github/workflows/adw-plan.yml`

- [ ] Give each Claude planner step `id: claude` and `continue-on-error: true`.
- [ ] Add conditional Codex auth/install and `sol` execution for spec-diff, breakdown, and grooming modes.
- [ ] Preserve each mode's prompt, issue permissions, concurrency, and no-spec-edit boundary.
- [ ] Run workflow contracts and YAML parsing.

### Task 3: Surveyor fallback

**Files:**
- Modify: `.github/workflows/adw-survey.yml`

- [ ] Give the Claude step `id: claude` and `continue-on-error: true`.
- [ ] Add conditional Codex auth/install and `sol` execution with the surveyor charter.
- [ ] Preserve one-issue-per-tick and WIP rules.
- [ ] Run all ADW shell tests, parse all ADW YAML, and run `git diff --check`.

### Task 4: Delivery

- [ ] Commit signed changes.
- [ ] Push and open an owner-reviewed PR referencing #21 without closing its remaining liveness policies.
