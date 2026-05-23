# SM-012: Testing Strategy

End-to-end testing strategy for smith. See research docs for detailed tool analysis and CI patterns.

## Reference Documents

- `docs/research/TESTING-STRATEGY-RESEARCH.md` — Testing tools, patterns, coverage goals, mutation testing, property testing, snapshot testing, TUI integration, performance benchmarking
- `docs/research/CI-PATTERNS-RESEARCH.md` — CI tiers, test gating, agent gating, hermeticity, rollback strategy
- `docs/research/CRATE-ECOSYSTEM-RESEARCH.md` — Crate evaluations, dependency decisions, Rust version policy

## Philosophy

smith is a CLI/TUI with deterministic I/O (text). This enables:
- **100% unit test coverage** target for pure types (`smith/`)
- **Mutation testing** (>80% mutants caught) for behavioral verification
- **Property tests** for codec roundtrips, config resolution, model resolver chains
- **Snapshot tests** for TUI widget rendering (ratatui TestBackend)
- **Integration tests** via CLI process API (assert_cmd) and TUI PTY flows (expectrl)
- **Performance benchmarks** (criterion) with regression gating

## Test Tiers

### Fast Tier (< 2 min) — Every Commit

Runs on every `git push` and in pre-push hook.

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --profile fast  # unit + property + snapshot
cargo test --doc
```

**Scope:**
- Unit tests on pure functions (all crates)
- Property tests (`proptest`) for `smith/` and `smith-core/` pure logic
- Snapshot tests (`insta` + `TestBackend`) for `smith-tui/` widgets
- Snapshot tests for `smith/` type serialization
- Doc tests

**Gating:** Block push if fail.

### Medium Tier (< 10 min) — Every PR

Runs on every pull request.

```bash
# Fast tier (re-run in CI for hermeticity)
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --profile default
cargo test --doc

# Coverage
cargo tarpaulin --out Lcov

# Integration tests
cargo nextest run --profile integration

# Documentation build
cargo doc --workspace --no-deps
```

**Scope:**
- CLI integration tests (`assert_cmd`) — argument parsing, subcommands, stdin piping
- Plugin integration tests — loading, registration, event dispatch
- Provider integration tests — mock provider streaming
- Session integration tests — create, resume, fork, persist
- TUI integration tests (`expectrl`) — PTY-driven flows
- Coverage gate: ≥ 85% overall, 100% on `smith/`

**Gating:** Block merge if fail. Coverage drop > 2% triggers warning.

### Slow Tier (< 2 hours) — Nightly + Release

Runs on schedule and release candidates.

```bash
# Full test suite
cargo nextest run --profile thorough

# Mutation testing
cargo mutants --test-tool=nextest

# Benchmarks with regression detection
cargo bench -- --baseline main
```

**Scope:**
- Full mutation testing (`cargo-mutants`) — >80% mutants caught target
- Performance benchmarks (`criterion`) — ±5% regression threshold
- Full platform matrix (Linux x86_64/aarch64, macOS aarch64, Windows x86_64)
- Network integration tests (behind `network-tests` feature flag)

**Gating:** Block release if mutation score < 80% or benchmark regresses.

## Coverage Goals

| Crate | Target | Rationale |
|-------|--------|-----------|
| `smith/` (types) | 100% | Pure data types, trivial to cover |
| `smith-core` | 95%+ | Agent loop is async, harder to fully cover |
| `smith-ai` | 90%+ | Provider streaming has edge cases |
| `smith-tui` | 85%+ | Rendering is visual, snapshot tests cover it |
| `smith-harness` | 90%+ | Plugin bridge has error paths |
| `smith-cli` | 80%+ | Argument parsing, main entry point |

## Test Runner Configuration

`.config/nextest.toml`:
```toml
[profile.default]
retries = 3
slow-timeout = "30s"
fail-fast = false

[profile.fast]
test-group = "fast"
retries = 0
fail-fast = true
slow-timeout = "5s"

[profile.integration]
filter = 'test(integration::) or test(cli::) or test(tui::)'
retries = 2
slow-timeout = "30s"

[profile.thorough]
retries = 1
slow-timeout = "120s"
```

## Mutation Testing

`.cargo/mutants.toml`:
```toml
exclude_re = ["^.*::new\\(\\)$", "^.*::default\\(\\)$"]
exclude_path = ["benches/", "tests/integration/"]
test_tool = "nextest"
```

**Targets:**
- 100% mutant catch rate on pure functions (config resolution, CBOR codec, model resolver)
- >80% overall
- Incremental on PRs (changed files only), full on main branch

## Property Testing

Use `proptest` for:
- `SessionCodec::encode` ↔ `decode` roundtrip
- `ModelResolver::resolve` determinism
- `Config::from_lua_table` — valid config → no error
- `TokenEstimator::estimate` monotonicity
- `AgentEvent::to_session_entry` — no panic on valid events
- `TraceEntry::to_session_entries` — filter preserves order

Commit `proptest-regressions/` files to prevent regressions.

## Snapshot Testing

Use `insta` + `TestBackend` for:
- TUI widget rendering (exact screen state)
- Config parsing output (serialized `Config`)
- Provider response normalization
- Error message formatting
- CLI `--help` output (catches flag changes)

Workflow: `cargo test` → `cargo insta review` → accept/reject.
CI: `INSTA_UPDATE=no cargo test` fails on pending snapshots.

## TUI Integration Testing

Use `expectrl` for:
- Full TUI startup/shutdown flows
- Mouse interaction sequences
- Terminal capability detection
- Plugin widget registration

Use `ratatui::backend::TestBackend` for:
- Individual widget rendering
- Layout composition
- Theme application

## Performance Benchmarks

`benches/` directory with `criterion`:

| Benchmark | Target | Threshold |
|-----------|--------|-----------|
| `session_encode_1000` | Encode 1000 SessionEntry | ±5% |
| `session_decode_1000` | Decode 1000 SessionEntry | ±5% |
| `widget_render_100` | Render 100-line conversation | ±5% |
| `agent_loop_turn` | Single turn with mock provider | ±10% |
| `config_resolve_3level` | Alias→group→member→provider→bucket | ±5% |
| `trace_filter_10000` | Filter 10000 TraceEntry | ±5% |
| `plugin_load_10` | Load + register 10 Lua plugins | ±10% |

Store baselines in CI artifacts. Compare PR against `main` baseline.

## Integration Test Cases

### CLI
- `smith` starts interactive mode
- `smith new test-session` creates named session
- `smith session list` lists sessions
- `smith session dump` outputs JSONL
- `smith replay <id>` replays session
- `smith eval "hello"` outputs text
- `smith eval --json "hello"` outputs valid JSON
- `smith help` lists topics
- `smith help <topic>` shows docs
- `smith --model claude-sonnet-4 --provider anthropic eval "test"`
- `smith --no-config eval "test"` skips config

### Plugins
- Load Lua plugin from `~/.smith/plugins/`
- Load Lua plugin from `.smith/plugins/`
- Plugin loading order: built-in → global → project
- `smith.tool.register` creates callable tool
- `smith.on("tool_call")` observes tool calls
- `smith.on("input")` transforms user input
- `smith.command.register` creates slash command
- `smith.provider.register` adds new provider
- `smith.provider.register` overrides existing
- `smith.alias.register` creates model alias
- `smith.group.register` creates model group
- `smith.bucket.register` creates provider bucket

### Providers
- Load bundled `providers.json`
- Register custom provider via Lua
- Override built-in provider settings
- API key auth from env var
- API key auth from auth.json
- OAuth flow (mock server)
- Provider streaming produces `ProviderEvent`s
- MuxProvider failover on RateLimit
- MuxProvider round-robin across accounts

### Sessions
- Create new session
- Resume session
- Fork session
- Session persistence across restarts
- Tree navigation
- Compaction triggers automatically
- Trace recording captures all events
- Replay at max speed produces identical results
- Replay compare mode detects output differences

### TUI
- Default layout renders
- Border layout with all panels
- Custom layout from Lua plugin
- Theme loading and switching
- Virtual scroll performance
- Mouse click-to-focus
- Scroll wheel routing
- Sticky widget rendering
- Terminal capability detection (kitty, ghostty, wezterm)
- Graceful degradation on basic terminals

### Docs
- `smith help` lists all topics
- `smith help <topic>` shows correct docs
- `smith help --search` finds results
- `smith help --examples` lists examples
- All `@usage` blocks execute
- All guide code blocks execute
- `cargo doc --workspace` builds without warnings

## Test Fixtures

```
tests/fixtures/
├── plugins/
│   ├── hello.lua
│   ├── tool.lua
│   ├── provider.lua
│   ├── layout.lua
│   └── alias_group_bucket.lua
├── sessions/
│   ├── simple.cbor
│   ├── with_compaction.cbor
│   └── corrupted.cbor
├── configs/
│   ├── minimal.lua
│   ├── full.lua
│   ├── with_aliases.lua
│   ├── with_groups.lua
│   ├── with_buckets.lua
│   └── invalid.lua
├── providers/
│   ├── anthropic_response.json
│   ├── openai_response.json
│   └── openai_streaming.json
└── traces/
    ├── simple.trace
    └── with_steering.trace
```

## Steps

- [ ] Add test dependencies to workspace: `insta`, `proptest`, `assert_cmd`, `assert_fs`, `expectrl`, `criterion`
- [ ] Configure `.config/nextest.toml`
- [ ] Configure `.cargo/mutants.toml`
- [ ] Configure `.tarpaulin.toml`
- [ ] Create `benches/` directory with criterion benchmarks
- [ ] Create `tests/fixtures/` directory structure
- [ ] Write property tests for `smith/` and `smith-core/` pure functions
- [ ] Write snapshot tests for `smith-tui/` widgets (TestBackend + insta)
- [ ] Write CLI integration tests (assert_cmd)
- [ ] Write plugin integration tests
- [ ] Write provider integration tests (mock streaming)
- [ ] Write session integration tests
- [ ] Write TUI integration tests (expectrl for PTY flows)
- [ ] Write doc integration tests
- [ ] Set up CI: fast tier on push, medium tier on PR, slow tier nightly
- [ ] Run full suite: `cargo nextest run`
- [ ] Run coverage: `cargo tarpaulin`
- [ ] Run mutation: `cargo mutants`
- [ ] Run benchmarks: `cargo bench`
- [ ] Commit: `jj describe -m "feat(SM-012): testing strategy — unit, property, snapshot, integration, mutation, benchmark"`
