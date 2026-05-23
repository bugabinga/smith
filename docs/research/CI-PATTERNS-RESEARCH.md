# CI/CD Patterns Research: smith

**Date:** 2026-05-21
**Status:** Research — informs SM-012 (testing spec) and CI setup

This document captures CI/CD patterns, test gating strategies, and agent-gating workflows for smith. It does not prescribe a specific CI technology (GitHub Actions, GitLab CI, Buildkite, etc.) but defines goals independent of platform.

---

## 1. CI Tier Philosophy

The goal is **fast feedback on commit, thorough validation on merge, exhaustive testing on release**.

Coding agents (including smith itself when used for self-improvement) must be gated by the right tests at the right time. Agents should not waste time on slow tests for trivial changes, nor should they skip critical validation for risky changes.

### Three-tier model

| Tier | Trigger | Duration | Tests | Gate |
|------|---------|----------|-------|------|
| **Fast** | Every commit (local + push) | < 2 min | Unit, property, snapshot, doc | Block push if fail |
| **Medium** | Every PR | < 10 min | Fast + integration (CLI, TUI, session) | Block merge if fail |
| **Slow** | Nightly + release candidates | < 2 hours | Medium + mutation + benchmarks + full matrix | Block release if fail |

### Why tiers matter for agents

Agents generate code quickly. Running the full test suite on every agent iteration is wasteful. But skipping integration tests before merging agent-generated code is dangerous.

**Rule:** Agents run fast tier on every iteration. Medium tier on "ready to merge". Slow tier is CI's responsibility, not the agent's.

---

## 2. Fast Tier: Every Commit

### What runs

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --profile fast  # unit + property + snapshot
cargo test --doc                 # doctests
```

### Timing budget

- `cargo check`: ~10s
- `cargo fmt --check`: ~1s
- `cargo clippy`: ~30s
- `cargo nextest run --profile fast`: ~60s
- **Total: ~2 min**

### nextest profile

```toml
# .config/nextest.toml
[profile.fast]
test-group = "fast"           # only tests with #[test_group(fast)]
retries = 0                   # no retries — fail fast
fail-fast = true              # stop on first failure
slow-timeout = "5s"           # flag tests > 5s
```

### Pre-push hook

```bash
#!/bin/sh
# .git/hooks/pre-push
cargo fmt --check || exit 1
cargo clippy --workspace --all-targets --all-features -- -D warnings || exit 1
cargo nextest run --profile fast || exit 1
```

### Agent behavior

- Agent runs fast tier after every code generation iteration
- If fast tier fails, agent fixes before continuing
- Agent never proceeds to medium tier without fast tier passing

---

## 3. Medium Tier: Every PR

### What runs

```bash
# Fast tier (re-run in CI for hermeticity)
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --profile default

# Coverage
cargo tarpaulin --out Lcov

# Integration tests
cargo nextest run --profile integration

# Documentation build
cargo doc --workspace --no-deps
```

### Timing budget

- Fast tier (re-run): ~2 min
- Coverage: ~3 min
- Integration tests: ~5 min
- **Total: ~10 min**

### Integration test profile

```toml
# .config/nextest.toml
[profile.integration]
filter = 'test(integration::) or test(cli::) or test(tui::)'
retries = 2
slow-timeout = "30s"
```

### Coverage gate

- **Target:** 85% overall, 100% on `smith/` (types crate)
- **Advisory on PR** — coverage drop > 2% triggers warning comment
- **Block on < 80%** — PR cannot merge if coverage falls below threshold

### Agent behavior

- Agent runs medium tier before declaring "ready for review"
- If medium tier fails, agent fixes and re-runs
- Coverage drop > 2% requires agent justification in PR description

---

## 4. Slow Tier: Nightly + Release

### What runs

```bash
# Full test suite
cargo nextest run --profile thorough

# Mutation testing
cargo mutants --test-tool=nextest

# Benchmarks with regression detection
cargo bench -- --baseline main

# Full platform matrix (if multi-platform CI)
# - Linux x86_64
# - Linux aarch64 (Termux target)
# - macOS aarch64
# - Windows x86_64
```

### Android/Termux validation lane

[V] Android/Termux is a supported development environment for smith, especially for agent-in-terminal workflows on mobile devices. It is not a v1 release artifact target; release artifacts target desktop/server platforms first.

[V] CI should still validate Android/Termux compatibility because prototype evidence found two platform-sensitive integrations:

1. **Vendored LuaJIT on `aarch64-linux-android`** — static vendored LuaJIT requires linking compiler-rt builtins so LuaJIT's cache-flush symbol resolves:

   ```toml
   [target.aarch64-linux-android]
   rustflags = ["-C", "link-args=-lclang_rt.builtins-aarch64-android"]
   ```

2. **Syntax highlighting via `syntastica`** — use `runtime-c2rust` so tree-sitter highlighting remains zero-C-dependency on Android/Termux. CI should reject accidental fallback to `syntect`/Oniguruma or C tree-sitter runtime for the Android lane.

[V] Recommended CI posture:

- Run Android/Termux compatibility in slow tier and before releases.
- Treat failures as release blockers for source compatibility, not artifact publishing blockers.
- Include a focused smoke test: vendored LuaJIT links, Lua sandbox executes, syntastica highlights Rust code, and no `libonig`/external `libtree-sitter` dynamic dependency appears.

### Timing budget

- Full tests: ~10 min
- Mutation testing: ~30-60 min
- Benchmarks: ~10 min
- **Total: ~1-2 hours**

### Mutation gate

- **Target:** > 80% mutants caught
- **Advisory on nightly** — report posted to issue/PR
- **Block release** — release cannot proceed if < 80%

### Benchmark gate

- **Regression threshold:** ±5% for most benchmarks, ±10% for agent loop
- **Block release** — any benchmark regressing > threshold blocks release
- **Advisory on PR** — benchmark comparison comment posted to PR

### Agent behavior

- Agents do NOT run slow tier — it's CI-only
- If nightly slow tier finds issues in agent-generated code, file bug for agent to fix
- Release candidates trigger slow tier; agent cannot release without it passing

---

## 5. Change-Based Test Selection

### Problem

Running all tests on every change is wasteful. A change to `smith-tui/src/widgets/mod.rs` doesn't need `smith-ai` provider tests.

### Solution: nextest filter based on changed files

```bash
# Determine which crates changed
crates=$(git diff --name-only HEAD~1 | grep '^crates/' | cut -d'/' -f2 | sort -u)

# Run only tests for changed crates
for crate in $crates; do
    cargo nextest run -p $crate
done
```

### Dependency-aware selection

If `smith-core` changes, also run tests for crates that depend on it (`smith-harness`, `smith-cli`).

```bash
# Use cargo's dependency graph
cargo tree -i smith-core --prefix none | grep '^smith-' | sort -u
```

### Agent behavior

- Agent uses change-based selection for fast tier iterations
- Agent runs full fast tier before declaring "ready for review"
- CI always runs full medium tier (hermetic — doesn't trust agent's selection)

---

## 6. Agent Gating Strategy

### Agent types that will use smith

1. **Self-hosted agent** — smith improving its own codebase
2. **User agent** — user runs smith on their own projects
3. **CI agent** — automated agent in CI pipeline

### Gating per agent type

| Agent Type | Fast Tier | Medium Tier | Slow Tier | Release |
|------------|-----------|-------------|-----------|---------|
| Self-hosted | Every iteration | Before self-PR | Nightly CI | Blocked by slow tier |
| User | On request | On request | Never | N/A |
| CI | Every commit | Every PR | Scheduled | Blocked by slow tier |

### Agent-specific tests

When an agent modifies smith's own code:

1. **Run agent on test fixture** — does the agent produce valid output for a known task?
2. **Regression test** — replay a recorded session with the new code, verify identical output
3. **Self-test** — agent runs `cargo test` on its own changes

### Agent safety rules

1. **Never auto-merge** — agent opens PR, human reviews
2. **Never skip tests** — agent runs full tier before PR
3. **Never modify CI config** — agent cannot change `.github/workflows/`, `.config/nextest.toml`, etc.
4. **Never modify tests to make them pass** — agent cannot change test assertions to match buggy code

---

## 7. Artifact Management

### What artifacts to keep

| Artifact | Retention | Purpose |
|----------|-----------|---------|
| Test logs | 30 days | Debug failures |
| Coverage reports (HTML) | 30 days | Review coverage |
| Coverage reports (LCOV) | 30 days | codecov.io upload |
| Benchmark results | 90 days | Regression analysis |
| Mutation reports | 90 days | Test quality tracking |
| Snapshot diffs | 7 days | Review pending snapshots |

### Benchmark baselines

Store benchmark baselines as CI artifacts, keyed by branch:

```
artifacts/
├── benchmarks/
│   ├── main/           # Baseline for main branch
│   ├── release-0.1/   # Baseline for release branch
│   └── pr-123/        # Baseline for PR (optional)
```

### Snapshot artifacts

Pending snapshots (`.snap.new` files) are CI artifacts for review:

```bash
# Download pending snapshots from CI
cargo insta test
# Review locally
cargo insta review
```

---

## 8. Notification Strategy

### Who gets notified when

| Event | Channel | Recipient |
|-------|---------|-----------|
| Fast tier fail | PR comment | Agent + author |
| Medium tier fail | PR comment + email | Agent + author + reviewers |
| Coverage drop > 2% | PR comment | Agent + author |
| Mutation score < 80% | Issue + Slack | Team |
| Benchmark regression | Issue + PR comment | Agent + author + team |
| Nightly fail | Email + Slack | Team |

### Agent notifications

Agents consume notifications via:
- PR comments (structured: `<!-- smith-bot: status=fail tier=fast reason=compilation -->`)
- CI status API (GitHub Checks, GitLab Pipeline Status)
- Webhook (for self-hosted agents)

---

## 9. Hermeticity

### What hermetic means

Same code + same dependencies → same test results, regardless of where/when run.

### smith hermeticity challenges

| Challenge | Mitigation |
|-----------|------------|
| Provider API calls | Mock providers in all but `network-tests` feature |
| Terminal capabilities | TestBackend for unit tests; expectrl for integration |
| File system | `tempfile::TempDir` for all file operations |
| Time | Mock clock for deterministic tests; `tokio::time::pause()` |
| RNG | Fixed seeds for all random generation |
| Lua state | Fresh `Lua` instance per test |

### Non-hermetic tests (marked explicitly)

```rust
#[cfg(feature = "network-tests")]
#[tokio::test]
async fn test_anthropic_provider_real() {
    // Calls real API — requires ANTHROPIC_API_KEY env var
}
```

These tests are excluded from CI by default and run only in manual/nightly jobs.

---

## 10. CI Platform Agnosticism

This spec defines goals, not implementation. Any CI platform can implement the three-tier model.

### Platform mapping

| Concept | GitHub Actions | GitLab CI | Buildkite |
|---------|---------------|-----------|-----------|
| Fast tier | `push` trigger + job | `script` in stage | Step in pipeline |
| Medium tier | `pull_request` trigger + job | `merge_requests` pipeline | PR pipeline |
| Slow tier | `schedule` (cron) + job | `schedule` pipeline | Scheduled build |
| Artifacts | `actions/upload-artifact` | `artifacts:` | `artifact_paths` |
| Caching | `actions/cache` | `cache:` | Built-in |
| Notifications | Checks API | Pipeline Status | Webhooks |

### Recommended GitHub Actions structure

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: taiki-e/install-action@nextest
      - run: cargo fmt --check
      - run: cargo clippy --workspace --all-targets --all-features -- -D warnings
      - run: cargo nextest run --profile fast

  medium:
    needs: fast
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: taiki-e/install-action@nextest
      - run: cargo nextest run --profile default
      - run: cargo nextest run --profile integration
      - run: cargo tarpaulin --out Lcov
      - uses: codecov/codecov-action@v3

  slow:
    needs: medium
    if: github.event_name == 'schedule' || startsWith(github.ref, 'refs/tags/')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo mutants --test-tool=nextest
      - run: cargo bench -- --baseline main
```

---

## 11. Rollback Strategy

When a release causes regressions:

1. **Fast rollback** — revert to previous release tag (immediate)
2. **Investigation** — replay recorded sessions with new code to identify cause
3. **Fix forward** — agent or human fixes, runs full slow tier, releases patch

### Rollback gating

Even emergency rollbacks must pass fast tier:

```bash
git revert HEAD  # revert bad release
cargo nextest run --profile fast  # must pass
git tag v0.1.1
git push origin v0.1.1
```

---

## 12. Summary: CI Goals

| Goal | Metric | Tier |
|------|--------|------|
| Fast feedback | < 2 min from push to result | Fast |
| Merge safety | < 10 min from PR open to green | Medium |
| Release confidence | < 2 hours from tag to validated release | Slow |
| Coverage | ≥ 85% overall | Medium |
| Mutation score | ≥ 80% caught | Slow |
| Benchmark regression | ±5% threshold | Slow |
| Flaky tests | 0 tolerated | All tiers |
| Agent gating | Fast on every iteration, medium before merge, slow on release | All |
