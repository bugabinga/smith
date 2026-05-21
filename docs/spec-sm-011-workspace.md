# SM-011: Cargo Workspace + xtask

Create the Cargo workspace configuration and xtask build tooling.

## Context

Sets up the workspace after SM-006, SM-007, SM-008 complete.
Runs in parallel with SM-009/SM-010.

## Key Design Decisions

xTasks must include:
- `fetch-providers` — fetch from pi.dev + catwalk, generate providers.json
- `doc-test` — extract @usage + guide code blocks, run in Lua VM
- `verify-docs` — completeness checks (every API has docs)
- `doc-gen` — generate man pages + docs bundle from annotations

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
rust-version = "1.85"
edition = "2024"

[workspace.dependencies]
# Shared dependency versions
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
mlua-pkg = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
crossterm = "0.28"
ratatui = "0.29"
minicbor = { version = "0.25", features = ["derive"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = "0.3"
reqwest = { version = "0.12", features = ["json", "stream"] }
futures = "0.3"
unicode-width = "0.2"
unicode-segmentation = "1"
url = "2"
oauth2 = "4"
insta = "1"
dirs = "5"
jsonschema = "0.28"
uuid = { version = "1", features = ["v7"] }
assert_cmd = "2"
```

### 2. xtask Structure

```
xtask/
├── Cargo.toml
└── src/
    ├── main.rs
    ├── fetch_providers.rs    — fetch from pi.dev + catwalk
    ├── doc_test.rs           — extract + run code blocks
    ├── verify_docs.rs        — completeness checks
    └── doc_gen.rs            — generate man pages + docs bundle
```

### 3. xtask Commands

```bash
cargo run -p xtask -- fetch-providers    # Generate providers.json
cargo run -p xtask -- doc-test           # Run doc tests
cargo run -p xtask -- verify-docs        # Completeness checks
cargo run -p xtask -- doc-gen            # Generate docs + man pages
cargo run -p xtask -- lint               # clippy + luacheck
cargo run -p xtask -- test               # all tests
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

    // 3. Merge (pi is primary, catwalk fills gaps)
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

## Tests

- Workspace compiles: `cargo check --workspace`
- `fetch-providers` generates valid JSON
- `doc-test` runs without failures
- `verify-docs` passes on well-documented SDK
- `doc-gen` generates man pages and bundle

## Steps

- [ ] Create workspace `Cargo.toml` with all members + shared deps
- [ ] Create `xtask/Cargo.toml`
- [ ] Create `xtask/src/main.rs` with command dispatch
- [ ] Implement `fetch_providers.rs`
- [ ] Implement `doc_test.rs`
- [ ] Implement `verify_docs.rs`
- [ ] Implement `doc_gen.rs`
- [ ] Verify: `cargo check --workspace`
- [ ] Verify: `cargo run -p xtask -- fetch-providers`
- [ ] Verify: `cargo run -p xtask -- doc-test`
- [ ] Verify: `cargo run -p xtask -- verify-docs`
- [ ] Verify: `cargo run -p xtask -- doc-gen`
- [ ] Commit: `jj describe -m "feat(SM-011): workspace + xtask (fetch-providers, doc-test, verify-docs, doc-gen)"`
