# Testing Strategy Research: smith

**Date:** 2026-05-21
**Status:** Research — informs SM-012 (testing spec) and implementation

This document captures research on Rust testing tools, patterns, and strategies that don't belong in formal specs but inform test design decisions.

---

## 1. Test Runner: cargo-nextest

### Why nextest over cargo test

- **3× faster** on multi-core machines via per-test-process parallelism (not just `--test-threads`)
- **Per-test isolation** — each test runs in its own process, preventing global state pollution
- **Retries** — flaky test detection with `--retries 3`
- **Timeouts** — per-test timeouts prevent hung tests from blocking CI
- **JUnit XML output** — native CI integration
- **Partitioning** — `--partition hash:N/T` splits tests across T parallel CI runners
- **Slow test detection** — `--slow-timeout` flags tests exceeding threshold
- **Filtering** — `cargo nextest run -E 'test(some_filter)'` with expression syntax

### Configuration

`.config/nextest.toml`:
```toml
[profile.default]
retries = 3                # retry flaky tests 3x
slow-timeout = "30s"       # flag tests > 30s
fail-fast = false          # run all tests even if some fail

[profile.ci]
retries = 1
fail-fast = true
partition = "count"        # use --partition command-line flag

[[profile.ci.overrides]]
filter = 'test(integration)'
slow-timeout = "120s"
```

### CI sharding

```bash
# Split tests across 4 parallel runners
cargo nextest run --partition hash:1/4  # runner 1
cargo nextest run --partition hash:2/4  # runner 2
cargo nextest run --partition hash:3/4  # runner 3
cargo nextest run --partition hash:4/4  # runner 4
```

### Key insight for smith

smith has async tests (agent loop, provider streaming, TUI event handling). nextest's per-process isolation prevents tokio runtime pollution between tests. Without nextest, a test that panics in a spawned task can poison the runtime for subsequent tests.

---

## 2. Coverage: cargo-tarpaulin

### Why tarpaulin

- **Source-based coverage** — uses LLVM's instrumentation (not ptrace), works in CI containers
- **HTML reports** — `tarpaulin --out Html` for local review
- **LCOV output** — `--out Lcov` for codecov.io integration
- **Exclusion support** — `#[cfg(not(tarpaulin_include))]` or `.tarpaulin.toml` config
- **100% coverage goal** — feasible for smith because it's a CLI/TUI with deterministic I/O

### Configuration

`.tarpaulin.toml`:
```toml
[ tarpaulin ]
engine = "Llvm"            # source-based, not ptrace
out = [ "Html", "Lcov" ]
exclude-files = [ " benches/*", "tests/*" ]
run-types = [ "Tests", "Doctests" ]
all-features = true
```

### Coverage gaps that matter

Coverage tells you code is **reached**, not that it's **checked**. A line can be covered by a test that calls a function but never asserts on the result. This is why coverage alone is insufficient — mutation testing (§3) is required.

### Coverage goals for smith

| Crate | Coverage Target | Rationale |
|-------|----------------|-----------|
| smith (types) | 100% | Pure data types, trivial to cover |
| smith-core | 95%+ | Agent loop is async, harder to fully cover |
| smith-ai | 90%+ | Provider streaming has edge cases |
| smith-tui | 85%+ | Rendering is visual, snapshot tests cover it |
| smith-harness | 90%+ | Plugin bridge has error paths |
| smith-cli | 80%+ | Argument parsing, main entry point |

---

## 3. Mutation Testing: cargo-mutants

### Why mutation testing

- **Coverage is reachability** — "did the test execute this line?"
- **Mutation is verification** — "would the test fail if this line were wrong?"
- Finds tests that exercise code but don't actually check behavior (e.g., test calls function, ignores return value)
- True measure of test quality

### How it works

1. `cargo mutants` generates mutants by making small code changes:
   - Replace `+` with `-`
   - Replace `==` with `!=`
   - Replace `true` with `false`
   - Replace `return x` with `return Default::default()`
2. For each mutant, runs the test suite
3. If tests **fail** → mutant is **caught** (good)
4. If tests **pass** → mutant is **uncaught** (bad — test gap)

### Goals for smith

- **>80% mutants caught** — strong signal that tests verify behavior, not just reach code
- **100% on pure functions** — config resolution, CBOR codec, model resolver, event mapping
- **Incremental on PRs** — only mutants in changed files (fast: ~5 min)
- **Full on main** — all mutants (slow: ~30-60 min, nightly)

### Configuration

`.cargo/mutants.toml`:
```toml
# Skip trivial getters and generated code
exclude_re = [ "^.*::new\\(\\)$", "^.*::default\\(\\)$" ]
exclude_path = [ "benches/", "tests/integration/" ]

# Test command — uses nextest if available
test_tool = "nextest"
```

### Annotation

```rust
#[mutants::skip]  // Skip this function — trivial getter, not worth mutating
fn name(&self) -> &str {
    &self.name
}
```

### CI strategy

| Trigger | Scope | Duration | Gating |
|---------|-------|----------|--------|
| PR | Changed files only | ~5 min | Advisory (comment, not block) |
| Main branch | All mutants | ~30-60 min | Post-merge report |
| Release | All mutants | ~30-60 min | Block release if <80% |

---

## 4. Property Testing: proptest

### Why proptest

- **Generates random inputs** and verifies properties hold
- **Automatic shrinking** — finds minimal failing input
- **Reproducible** — seeds stored in `proptest-regressions/` files
- Perfect for pure functions with complex input spaces

### Use cases for smith

| Function | Property | Generator |
|----------|----------|-----------|
| `SessionCodec::encode` ↔ `decode` | Roundtrip: `decode(encode(entries)) == entries` | Arbitrary `Vec<SessionEntry>` |
| `ModelResolver::resolve` | Deterministic: same input → same output | Arbitrary config + model name |
| `Config::from_lua_table` | Valid config → no error | Arbitrary Lua table matching schema |
| `TokenEstimator::estimate` | Monotonic: more text ≥ higher estimate | Arbitrary `Vec<Message>` |
| `AgentEvent::to_session_entry` | No panic on any valid event | Arbitrary `AgentEvent` |
| `TraceEntry::to_session_entries` | Filter preserves order | Arbitrary `Vec<TraceEntry>` |

### Example

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn session_codec_roundtrip(entries: Vec<SessionEntry>) {
        let encoded = SessionCodec::encode(&entries).unwrap();
        let (decoded, _) = SessionCodec::decode(&encoded);
        prop_assert_eq!(entries, decoded);
    }
}
```

### Regression files

`proptest-regressions/smith_core/session_format.txt`:
```
# Seeds for reproducing failures
gx 1234567890abcdef  # if this test fails, use this seed to reproduce
```

Commit regression files to git — they prevent regressions from reoccurring.

---

## 5. Snapshot Testing: insta

### Why insta

- **Approval workflow** — review changes, accept or reject
- **Redactions** — mask timestamps, UUIDs, paths for stable snapshots
- **Filters** — normalize output before comparison
- **Inline snapshots** — `assert_snapshot!("value", @"expected")` for small values
- Already in smith workspace deps

### Use cases for smith

| Component | Snapshot Content |
|-----------|-----------------|
| TUI widgets | `TestBackend::buffer().to_string()` — exact screen state |
| Config parsing | Serialized `Config` struct |
| Provider responses | Normalized `ProviderEvent` stream |
| Error messages | Formatted `SmithError` Display output |
| CLI help | `--help` output (catches flag changes) |

### Redaction example

```rust
use insta::assert_snapshot;

#[test]
fn test_session_dump() {
    let session = create_test_session();
    let output = dump_session(&session);
    
    assert_snapshot!(output, {
        ".timestamp" => "[timestamp]",
        ".session_id" => "[session-id]",
    });
}
```

### Review workflow

```bash
cargo test  # generates .snap.new files for changed snapshots
cargo insta review  # interactive TUI to accept/reject each change
```

### CI

```bash
# In CI: fail if snapshots changed without review
INSTA_UPDATE=no cargo test  # default: fail on new pending snapshots
```

---

## 6. TUI Integration Testing: expectrl

### Why expectrl

- **PTY-driven** — spawns real terminal process, not mock
- **Cross-platform** — Unix (ptyprocess) + Windows (conpty)
- **Send keys, expect output** — `send("hello").await`, `expect("prompt>")`
- **Pattern matching** — regex or literal string matching on terminal output

### How it works

1. Spawn `smith` in a PTY
2. Wait for initial screen state
3. Send keystrokes via `send()`
4. Assert on screen content via `expect()` or `read_until()`
5. Kill process, verify exit code

### Example

```rust
use expectrl::{spawn, Regex, Eof};

#[tokio::test]
async fn test_smith_startup() {
    let mut p = spawn("cargo run --bin smith").unwrap();
    
    // Wait for TUI to render
    p.expect(Regex::new("smith").unwrap()).await.unwrap();
    
    // Send quit key
    p.send("q").await.unwrap();
    
    // Verify clean exit
    p.expect(Eof).await.unwrap();
    assert!(p.wait().unwrap().success());
}
```

### Limitations

- **Slower** than TestBackend snapshots (~100ms-1s per test vs ~1ms)
- **Flaky** — timing-dependent, requires retries
- **Platform-specific** — terminal emulation differences
- **Not for CI fast tier** — use for medium tier (every PR)

### When to use

| Test type | Tool | Speed |
|-----------|------|-------|
| Widget rendering | TestBackend + insta | ~1ms |
| Layout composition | TestBackend + insta | ~1ms |
| Full TUI flows | expectrl | ~100ms-1s |
| Mouse interactions | expectrl | ~100ms-1s |
| Terminal capability detection | expectrl | ~100ms-1s |

---

## 7. CLI Integration Testing: assert_cmd + assert_fs

### assert_cmd

- **Spawn binaries** — `Command::cargo_bin("smith")`
- **Assertions** — `.assert().success()`, `.stdout(predicates::str::contains(...))`
- **Stdin piping** — `.write_stdin("input")`

### assert_fs

- **Temp directories** — `TempDir::new()`
- **File fixtures** — `ChildPath` with assertion methods
- **Predicates** — file content matching

### Example

```rust
use assert_cmd::Command;
use assert_fs::prelude::*;
use predicates::prelude::*;

#[test]
fn test_smith_read_file() {
    let temp = assert_fs::TempDir::new().unwrap();
    temp.child("src/main.rs").write_str("fn main() {}").unwrap();
    
    let mut cmd = Command::cargo_bin("smith").unwrap();
    cmd.current_dir(&temp)
       .arg("read")
       .arg("src/main.rs");
    
    cmd.assert()
       .success()
       .stdout(predicate::str::contains("fn main()"));
}
```

---

## 8. Performance Benchmarking: criterion

### Why criterion

- **Statistics-driven** — runs enough iterations for statistical significance
- **Regression detection** — compares against saved baseline
- **HTML reports** — `target/criterion/report/index.html`
- **Stable Rust** — no nightly required

### Benchmark targets for smith

| Benchmark | What | Threshold |
|-----------|------|-----------|
| `session_encode` | Encode 1000 SessionEntry to CBOR | ±5% |
| `session_decode` | Decode 1000 SessionEntry from CBOR | ±5% |
| `widget_render` | Render conversation widget (100 lines) | ±5% |
| `agent_loop_turn` | Single agent turn (mock provider) | ±10% |
| `config_resolve` | Resolve model alias through 3-level chain | ±5% |
| `trace_filter` | Filter 10000 TraceEntry to SessionEntry | ±5% |
| `plugin_load` | Load + register 10 Lua plugins | ±10% |

### Configuration

```rust
// benches/session_codec.rs
use criterion::{criterion_group, criterion_main, Criterion};
use smith_core::{SessionCodec, SessionEntry};

fn bench_encode(c: &mut Criterion) {
    let entries = generate_test_entries(1000);
    c.bench_function("session_encode_1000", |b| {
        b.iter(|| SessionCodec::encode(&entries).unwrap())
    });
}

criterion_group!(benches, bench_encode);
criterion_main!(benches);
```

### CI regression gating

```bash
# On main branch: save baseline
cargo bench -- --save-baseline main

# On PR: compare against baseline
cargo bench -- --baseline main
# If any benchmark regresses > threshold, exit non-zero
```

### criterion thresholds

```toml
# Cargo.toml
[package.metadata.criterion]
significance_level = 0.05  # 95% confidence
noise_threshold = 0.02     # 2% variance is noise
```

---

## 9. Test Categorization by Speed/Cost

### Fast tests (< 10ms each)

- Unit tests on pure functions
- Property tests with small input spaces
- Snapshot tests with TestBackend
- **Run:** Every commit, local dev, pre-push hook

### Medium tests (10ms - 1s each)

- CLI integration tests (assert_cmd)
- TUI integration tests (expectrl)
- Session integration tests
- Plugin loading tests
- **Run:** Every PR, post-merge on main

### Slow tests (1s - 60min)

- Mutation testing (cargo-mutants)
- Benchmarks (criterion)
- Full integration suite
- **Run:** Nightly, release candidates

---

## 10. Test Data Strategy

### Fixtures

`tests/fixtures/`:
```
fixtures/
├── sessions/
│   ├── simple.cbor          # 3-turn session
│   ├── with_compaction.cbor # Session with compaction entry
│   └── corrupted.cbor       # Intentionally corrupted for fault tolerance tests
├── configs/
│   ├── minimal.lua
│   ├── full.lua
│   └── invalid.lua
├── plugins/
│   ├── hello.lua
│   ├── tool_plugin.lua
│   └── event_plugin.lua
└── providers/
    ├── anthropic_response.json
    └── openai_response.json
```

### Generators

For property tests and large-scale integration tests:

```rust
// Generate arbitrary valid SessionEntry
impl Arbitrary for SessionEntry {
    fn arbitrary(g: &mut Gen) -> Self {
        // Use prop_oneof! to pick variant weighted by frequency
    }
}
```

### Determinism

- All tests use fixed RNG seeds where applicable
- `chrono::Utc::now()` mocked via `mock_instant` or similar
- File system operations use `tempfile::TempDir`
- Async tests use `tokio::test` with single-threaded runtime where order matters

---

## 11. Mocking Strategy

### Provider mocking

```rust
// Mock StreamFn for agent loop tests
fn mock_provider(responses: Vec<ProviderEvent>) -> StreamFn {
    Box::new(move |_request| {
        let stream = tokio_stream::iter(responses.clone());
        Box::pin(stream)
    })
}
```

### Secret proxy mocking

```rust
struct MockSecretProxy {
    secrets: HashMap<String, String>,
}

impl SecretProxy for MockSecretProxy {
    fn get(&self, id: &str) -> Option<String> {
        self.secrets.get(id).cloned()
    }
}
```

### Time mocking

```rust
// For deterministic replay tests
struct MockClock {
    current: AtomicU64,
}

impl MockClock {
    fn now_ns(&self) -> u64 {
        self.current.fetch_add(1_000_000, Ordering::Relaxed)
    }
}
```

---

## 12. Async Test Patterns

### Single-threaded runtime (for order-dependent tests)

```rust
#[tokio::test(flavor = "current_thread")]
async fn test_agent_event_ordering() {
    // Events processed in deterministic order
}
```

### Multi-threaded runtime (for concurrency tests)

```rust
#[tokio::test]
async fn test_concurrent_tool_execution() {
    // Tools run in parallel
}
```

### Timeout

```rust
#[tokio::test]
#[timeout(Duration::from_secs(5))]  // tokio::time::timeout wrapper
async fn test_provider_stream() {
    // Fails if stream doesn't complete in 5s
}
```

### Stream testing

```rust
use tokio_stream::StreamExt;

let events: Vec<AgentEvent> = agent_stream.collect().await;
assert_matches!(events[0], AgentEvent::AgentStart);
assert_matches!(events[1], AgentEvent::TurnStart { turn_index: 0 });
```

---

## 13. Flaky Test Prevention

### Causes of flakiness in smith

1. **Timing-dependent** — TUI rendering, provider timeouts
2. **Global state** — Lua runtime, tokio runtime
3. **File system** — temp directory collisions
4. **Network** — provider integration tests

### Prevention

| Cause | Prevention |
|-------|------------|
| Timing | Use `tokio::time::pause()` for deterministic async timing |
| Global state | nextest per-process isolation; fresh Lua state per test |
| File system | `tempfile::TempDir` with random names |
| Network | Mock providers; network tests behind `#[cfg(feature = "network-tests")]` |

### Retry policy

```toml
# .config/nextest.toml
[profile.ci]
retries = { backoff = "fixed", count = 2, delay = "1s" }

# Only retry known-flaky tests
[[profile.ci.overrides]]
filter = 'test(tui::) or test(integration::provider)'
retries = 3
```

---

## 14. Summary: Test Tool Matrix

| Concern | Tool | Crate | Scope | Speed | CI Tier |
|---------|------|-------|-------|-------|---------|
| Runner | nextest | cargo-nextest | All | — | Every commit |
| Coverage | tarpaulin | cargo-tarpaulin | All | minutes | Every PR |
| Mutation | mutants | cargo-mutants | All | minutes-hours | Nightly/PR-advisory |
| Property | proptest | proptest | Core/Types | ms | Every commit |
| Snapshot | insta | insta | TUI/Types | ms | Every commit |
| Widget | TestBackend | ratatui | TUI | ms | Every commit |
| CLI integ | assert_cmd | assert_cmd | CLI | 100ms | Every PR |
| TUI integ | expectrl | expectrl | CLI/TUI | 100ms-1s | Every PR |
| Benchmark | criterion | criterion | Hot paths | seconds | Nightly |
| Fixture | assert_fs | assert_fs | All | — | Every PR |
