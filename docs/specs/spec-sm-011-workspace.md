# SM-011: Cargo Workspace + xtask

Create the Cargo workspace configuration and xtask build tooling.

## Context

Sets up the workspace after SM-006, SM-007, SM-008 complete.
Runs in parallel with SM-009/SM-010.

**Invariant reference:** See `docs/PROJECT-INVARIANTS.md` §4 for the complete
xtask command catalog and §10 for workspace structure.

## Key Design Decisions

xTasks must include all commands from PROJECT-INVARIANTS §4:
- `check` — full CI check (fmt + clippy + test)
- `test` — all tests via nextest
- `lint` — clippy + rustfmt check
- `fmt` — auto-format
- `fetch-providers` — fetch from pi.dev + catwalk, generate providers.json
- `doc-test` — extract @usage + guide code blocks, run in Lua VM
- `verify-docs` — completeness checks (every API has docs)
- `doc-gen` — generate man pages + docs bundle from annotations
- `spec-verify` — verify spec cross-references and check for stale links
- `audit` — `cargo deny check` + `cargo audit --deny warnings`
- `bench` — criterion benchmarks
- `coverage` — tarpaulin coverage report
- `mutants` — cargo-mutants mutation testing
- `release` — build release binary for all targets, archive + checksum

No Make/just/scripts are supported. Legacy command names map conceptually to
xtask commands only:
- `make check` → `cargo run -p xtask -- check`
- `make test` → `cargo run -p xtask -- test`
- `make lint` → `cargo run -p xtask -- lint`
- `make release` → `cargo run -p xtask -- release`

Do not add `Makefile`, `justfile`, root shell scripts, or package-manager
scripts. Cargo remains the single developer entry point.

## Deliverables

### 1. Workspace `Cargo.toml`

```toml
[workspace]
members = [
    "smith",
    "smith-core",
    "smith-ai",
    "smith-tui",
    "smith-harness",
    "smith-cli",
    "xtask",
]
resolver = "3"

[workspace.package]
edition = "2024"
version = "0.1.0"
license = "Apache-2.0"

[workspace.dependencies]
# Shared dependency versions
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
mlua-pkg = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
clap_complete = "4"
crossterm = "0.28"
ratatui = "0.29"
ciborium = "0.2"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
futures = "0.3"
unicode-width = "0.2"
unicode-segmentation = "1"
syntastica = { version = "0.6", default-features = false, features = ["runtime-c2rust"] }
syntastica-parsers = "0.6"
fuzzy-matcher = "0.3"
similar = "2"
ignore = "0.4"
grep = "0.4"
grep-regex = "0.1"
grep-searcher = "0.1"
gix = { version = "0.83", default-features = false, features = ["blame", "blob-diff", "revision"] }
url = "2"
oauth2 = "4"
insta = "1"
dirs = "5"
jsonschema = "0.28"
uuid = { version = "1", features = ["v7"] }
assert_cmd = "2"
assert_fs = "1"
proptest = "1"
expectrl = "0.9"
criterion = { version = "0.5", features = ["async_tokio"] }
zstd = "0.13"
sha2 = "0.10"
zip = { version = "2", default-features = false, features = ["deflate"] }
tar = "0.4"
flate2 = "1"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = "symbols"
panic = "abort"

[profile.release.package."*"]
opt-level = 3
```

### 2. xtask Structure

```
xtask/
├── Cargo.toml
└── src/
    ├── main.rs              — command dispatch (all 14 commands)
    ├── check.rs             — full CI check orchestrator
    ├── lint.rs              — clippy + fmt check
    ├── test.rs              — test runner (delegates to nextest)
    ├── fmt.rs               — auto-format
    ├── fetch_providers.rs   — fetch from pi.dev + catwalk
    ├── doc_test.rs          — extract + run code blocks
    ├── verify_docs.rs       — completeness checks
    ├── doc_gen.rs           — generate man pages + docs bundle
    ├── spec_verify.rs       — verify spec cross-references
    ├── audit.rs             — cargo deny check + cargo audit
    ├── bench.rs             — criterion benchmark runner
    ├── coverage.rs          — tarpaulin coverage
    ├── mutants.rs           — cargo-mutants runner
    └── release.rs           — release build + archive + checksum
```

### 3. xtask Commands

```bash
# Fast (every commit)
cargo run -p xtask -- check           # fmt + clippy + test
cargo run -p xtask -- test            # all tests via nextest
cargo run -p xtask -- lint            # clippy + rustfmt check
cargo run -p xtask -- fmt             # auto-format

# Medium (every PR / on demand)
cargo run -p xtask -- fetch-providers # Generate providers.json
cargo run -p xtask -- doc-test        # Run doc tests
cargo run -p xtask -- verify-docs     # Completeness checks
cargo run -p xtask -- doc-gen         # Generate docs + man pages
cargo run -p xtask -- spec-verify     # Verify spec cross-references
cargo run -p xtask -- audit           # cargo deny check + cargo audit --deny warnings

# Slow (nightly / release)
cargo run -p xtask -- bench           # criterion benchmarks
cargo run -p xtask -- coverage        # tarpaulin coverage report
cargo run -p xtask -- mutants         # mutation testing
cargo run -p xtask -- release         # build + archive + checksum
```

### 4. `fetch_providers.rs`

```rust
/// Fetch provider data from pi.dev and catwalk
/// Merge/deduplicate
/// Generate smith-ai/src/providers.json
pub fn fetch_providers() -> Result<()> {
    // 1. Fetch pi.dev's models.generated.js → parse models
    let pi_models = fetch_pi_models()?;

    // 2. Fetch catwalk provider configs → parse models
    let catwalk_models = fetch_catwalk_models()?;

    // 3. Merge (pi.dev is primary, catwalk fills gaps)
    let merged = merge_models(pi_models, catwalk_models);

    // 4. Generate providers.json
    let json = generate_provider_json(&merged);

    // 5. Write to smith-ai/src/providers.json
    write_providers_json(&json)?;
    Ok(())
}
```

### 5. `doc_test.rs`

```rust
/// Extract @usage blocks from SDK Lua files
/// Extract code blocks from guide Lua files
/// Extract full example files
/// Run all in sandboxed Lua VM
pub fn doc_test() -> Result<()> {
    let sdk_dir = Path::new("smith-harness/src/lua/sdk");

    // Collect all testable code
    let mut tests = Vec::new();

    // @usage blocks from SDK files
    for entry in fs::read_dir(sdk_dir)? {
        tests.extend(extract_usage_blocks(&entry.path())?);
    }

    // Code blocks from guides
    for entry in fs::read_dir(sdk_dir.join("guides"))? {
        tests.extend(extract_guide_code_blocks(&entry.path())?);
    }

    // Full example files
    for entry in fs::read_dir(sdk_dir.join("examples"))? {
        tests.push(read_example(&entry.path())?);
    }

    // Run each in sandboxed Lua
    let mut failures = 0;
    for test in &tests {
        if let Err(e) = run_lua_test(test) {
            eprintln!("FAIL: {} — {}", test.name, e);
            failures += 1;
        }
    }

    if failures > 0 { std::process::exit(1); }
    Ok(())
}
```

### 6. `verify_docs.rs`

```rust
/// Completeness verification
pub fn verify_docs() -> Result<()> {
    let mut errors = 0;

    // 1. Every Rust SDK function has a Lua binding
    // 2. Every Lua binding has ---@ annotations
    // 3. Every annotated function has @usage
    // 4. Every event appears in at least one example
    // 5. No documented function that doesn't exist in code
    // 6. No public SDK function without documentation

    // ... implementation ...

    if errors > 0 { std::process::exit(1); }
    Ok(())
}
```

### 7. `doc_gen.rs`

```rust
/// Generate documentation artifacts from SDK annotations
pub fn doc_gen() -> Result<()> {
    let sdk_dir = Path::new("smith-harness/src/lua/sdk");
    let output_dir = Path::new("docs/generated");

    // Parse all SDK files → structured data
    let docs = parse_sdk_docs(sdk_dir)?;

    // Generate man pages
    generate_man_pages(&docs, output_dir.join("man"))?;

    // Generate docs bundle (tar.gz)
    generate_docs_bundle(&docs, output_dir)?;

    Ok(())
}
```

### 8. `spec_verify.rs`

```rust
/// Verify spec cross-references and check for stale links
pub fn spec_verify() -> Result<()> {
    // 1. Every spec-sm-* file referenced in AGENTS.md exists
    // 2. Every cross-spec reference (e.g. "See SM-005 §3") points to valid section
    // 3. No orphaned spec file (in docs/specs/ but not in AGENTS.md)
    // 4. PROJECT-INVARIANTS.md is up to date

    // ... implementation ...

    Ok(())
}
```

### 9. `audit.rs`

```rust
/// Security and policy audit.
/// Requires Cargo-installable tools: cargo-deny and cargo-audit.
pub fn audit() -> Result<()> {
    run(["cargo", "deny", "check"])?;
    run(["cargo", "audit", "--deny", "warnings"])?;
    Ok(())
}
```

The command fails if either dependency policy checks or RustSec vulnerability
checks fail. CI must install both tools through `cargo install`.

## Tests

- Workspace compiles: `cargo check --workspace`
- `fetch-providers` generates valid JSON
- `doc-test` runs without failures
- `verify-docs` passes on well-documented SDK
- `doc-gen` generates man pages and bundle
- `spec-verify` passes on current spec set
- `audit` fails if `cargo deny check` or `cargo audit --deny warnings` fails

## Steps

- [ ] Create workspace `Cargo.toml` with all members + shared deps + [profile.release]
- [ ] Create `.cargo/config.toml` with rustflags
- [ ] Create `xtask/Cargo.toml`
- [ ] Create `xtask/src/main.rs` with command dispatch for all 14 commands
- [ ] Implement `check.rs` — full CI orchestrator
- [ ] Implement `lint.rs` — clippy + fmt check
- [ ] Implement `test.rs` — nextest runner
- [ ] Implement `fetch_providers.rs`
- [ ] Implement `doc_test.rs`
- [ ] Implement `verify_docs.rs`
- [ ] Implement `doc_gen.rs`
- [ ] Implement `spec_verify.rs`
- [ ] Implement `audit.rs`
- [ ] Implement `bench.rs`
- [ ] Implement `coverage.rs`
- [ ] Implement `mutants.rs`
- [ ] Implement `release.rs`
- [ ] Verify: `cargo check --workspace`
- [ ] Verify: `cargo run -p xtask -- check`
- [ ] Verify: `cargo run -p xtask -- fetch-providers`
- [ ] Verify: `cargo run -p xtask -- doc-test`
- [ ] Verify: `cargo run -p xtask -- verify-docs`
- [ ] Verify: `cargo run -p xtask -- doc-gen`
- [ ] Verify: `cargo run -p xtask -- spec-verify`
- [ ] Commit: `jj describe -m "feat(SM-011): workspace + xtask (14 commands)"`
