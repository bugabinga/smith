# SM-003: Project Initialization + Scaffolding

Create the Cargo workspace, jj repo, directory structure, and xtask build tooling.

## Context

No Rust code exists yet. This task creates the entire project skeleton that all
subsequent tasks (SM-005 through SM-012) build upon.

**Invariant reference:** See `docs/PROJECT-INVARIANTS.md` for build system rules,
xtask responsibilities, and directory separation.

## Deliverables

### 1. jj Repository

```bash
jj init --git smith
cd smith
```

### 2. Workspace Cargo.toml

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
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"

[workspace.dependencies]
# Lua
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
mlua-pkg = "0.2"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ciborium = "0.2"

# Async
tokio = { version = "1", features = ["full"] }
futures = "0.3"

# HTTP (for smith-ai)
reqwest = { version = "0.12", features = ["json", "stream"] }

# Search / filesystem tools
ignore = "0.4"
grep = "0.4"
grep-regex = "0.1"
grep-searcher = "0.1"

# CLI
clap = { version = "4", features = ["derive"] }
clap_complete = "4"

# TUI
crossterm = "0.28"
ratatui = "0.29"
unicode-width = "0.2"
unicode-segmentation = "1"
syntastica = { version = "0.6", default-features = false, features = ["runtime-c2rust"] }
syntastica-parsers = "0.6"
fuzzy-matcher = "0.3"
similar = "2"

# VCS primitives
# Feature-gate gix usage in implementation; keep Lua-facing API behind smith.vcs.*.
gix = { version = "0.83", default-features = false, features = ["blame", "blob-diff", "revision"] }

# Auth
oauth2 = "4"
url = "2"

# Compression
zstd = "0.13"

# Utilities
uuid = { version = "1", features = ["v7"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
sha2 = "0.10"
zip = { version = "2", default-features = false, features = ["deflate"] }
tar = "0.4"
flate2 = "1"
dirs = "5"
jsonschema = "0.28"

# Testing
insta = "1"
assert_cmd = "2"
assert_fs = "1"
proptest = "1"
expectrl = "0.9"

# Benchmarking
criterion = { version = "0.5", features = ["async_tokio"] }

# Build tooling (xtask deps)
```

### 2a. Release Profile

```toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = "symbols"
panic = "abort"

[profile.release.package."*"]
opt-level = 3
```

**Rationale:**
- `opt-level = 3`: maximum speed optimization
- `lto = "thin"`: cross-crate inlining without full LTO compile-time cost
- `codegen-units = 1`: maximum optimization (single codegen unit)
- `strip = "symbols"`: removes debug symbols (~50-60% size reduction)
- `panic = "abort"`: removes unwinding tables (~5-10% size reduction, faster startup)

**Expected binary size:** ~5-12MB stripped (well under 20MB invariant).

### 3. .cargo/config.toml

```toml
[build]
rustflags = [
    "-D", "warnings",
    "-D", "clippy::unwrap_used",
    "-D", "clippy::expect_used",
    "-D", "clippy::panic",
    "-D", "clippy::todo",
    "-D", "clippy::unimplemented",
    "-D", "clippy::print_stdout",
    "-D", "clippy::print_stderr",
    "-D", "missing_docs",
    "-D", "rustdoc::missing_crate_level_docs",
    "-D", "rustdoc::broken_intra_doc_links",
    "-W", "rustdoc::invalid_html_tags",
    "-W", "rustdoc::bare_urls",
]

[registries.crates-io]
protocol = "sparse"

# Required for vendored LuaJIT on Android/Termux ARM64. LuaJIT calls
# __clear_cache; compiler-rt provides it but rustc does not link it by default.
[target.aarch64-linux-android]
rustflags = ["-C", "link-args=-lclang_rt.builtins-aarch64-android"]
```

### 4. .gitignore

```
/target
*.swp
.DS_Store
*.log
*.trace
/.jj/
```

### 5. rust-toolchain.toml

Smith follows latest stable Rust. Keep `edition = "2024"`; do not pin a numeric `rust-version` unless release policy changes.

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

### 6. .clippy.toml — Lint Configuration

See `docs/research/CLIPPY-BEST-PRACTICES.md` for full rationale.

```toml
# .clippy.toml
# NOTE: clippy.toml only supports configuration VALUES.
# Lint enablement/disablement is in .cargo/config.toml rustflags.
# See docs/PROJECT-INVARIANTS.md §3.2 and docs/research/CLIPPY-BEST-PRACTICES.md.

cognitive-complexity-threshold = 25
# No msrv key: lint policy follows latest stable Rust.
```

### 7. Cargo deny config

```toml
# deny.toml
[graph]
targets = [
    { triple = "x86_64-unknown-linux-gnu" },
    { triple = "aarch64-unknown-linux-gnu" },
]

[advisories]
version = 2
yanked = "warn"

[licenses]
version = 2
allow = ["Apache-2.0", "MIT", "Unicode-DFS-2016"]

[bans]
multiple-versions = "warn"
wildcards = "allow"
```

### 8. Crate Skeletons (stub only — compile but empty)

Each crate gets:
- `Cargo.toml` with dependencies
- `src/lib.rs` (or `src/main.rs` for smith-cli) — empty, just `pub mod` stubs
- Compiles with `cargo check`

Every `lib.rs` must include:
```rust
#![forbid(unsafe_code)]
#![warn(missing_docs)]
```

Crate layout (see PROJECT-INVARIANTS §10 for full structure):
```
smith/
smith-core/
smith-ai/
smith-tui/
smith-harness/
smith-cli/
xtask/
```

### 9. xtask Skeleton

xtask implements all custom tasks. See `docs/PROJECT-INVARIANTS.md` §4 for the
full command catalog. The skeleton must include command dispatch for all 14 commands.

```rust
// xtask/src/main.rs
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("check") => check(),
        Some("test") => test(),
        Some("lint") => lint(),
        Some("fmt") => fmt(),
        Some("fetch-providers") => {
            eprintln!("fetch-providers: not yet implemented — see docs/specs/spec-sm-011-workspace.md");
        }
        Some("doc-test") => {
            eprintln!("doc-test: not yet implemented — see docs/specs/spec-sm-011-workspace.md");
        }
        Some("verify-docs") => {
            eprintln!("verify-docs: not yet implemented — see docs/specs/spec-sm-011-workspace.md");
        }
        Some("doc-gen") => {
            eprintln!("doc-gen: not yet implemented — see docs/specs/spec-sm-011-workspace.md");
        }
        Some("spec-verify") => {
            eprintln!("spec-verify: not yet implemented — validates spec cross-references");
        }
        Some("audit") => audit(),
        Some("bench") => bench(),
        Some("coverage") => coverage(),
        Some("mutants") => mutants(),
        Some("release") => release(),
        _ => {
            eprintln!("Usage: cargo run -p xtask -- <cmd>");
            eprintln!("Commands: check, test, lint, fmt, fetch-providers, doc-test, verify-docs,");
            eprintln!("          doc-gen, spec-verify, audit, bench, coverage, mutants, release");
        }
    }
}

fn check() {
    // 1. Format check
    let status = std::process::Command::new("cargo")
        .args(["fmt", "--", "--check"])
        .status()
        .expect("cargo fmt failed");
    assert!(status.success(), "fmt check failed");

    // 2. Clippy with full lint suite
    let status = std::process::Command::new("cargo")
        .args([
            "clippy", "--workspace", "--all-targets", "--all-features",
            "--", "-D", "warnings",
            "-D", "clippy::unwrap_used",
            "-D", "clippy::expect_used",
            "-D", "clippy::todo",
            "-D", "clippy::unimplemented",
            "-D", "clippy::print_stdout",
            "-D", "clippy::print_stderr",
            "-D", "clippy::panic",
            "-D", "missing_docs",
            "-D", "rustdoc::missing_crate_level_docs",
            "-D", "rustdoc::broken_intra_doc_links",
            "-W", "rustdoc::invalid_html_tags",
            "-W", "rustdoc::bare_urls",
        ])
        .status()
        .expect("clippy failed");
    assert!(status.success(), "clippy found violations");

    // 3. Doc build (catches rustdoc and missing_docs lints)
    let status = std::process::Command::new("cargo")
        .args(["doc", "--workspace", "--no-deps"])
        .status()
        .expect("cargo doc failed");
    assert!(status.success(), "doc build failed");

    // 4. Tests
    let status = std::process::Command::new("cargo")
        .args(["nextest", "run", "--workspace"])
        .status()
        .expect("tests failed");
    assert!(status.success(), "tests failed");
}

fn lint() {
    let status = std::process::Command::new("cargo")
        .args([
            "clippy", "--workspace", "--all-targets", "--all-features",
            "--", "-D", "warnings",
            "-D", "clippy::unwrap_used",
            "-D", "clippy::expect_used",
            "-D", "clippy::todo",
            "-D", "clippy::unimplemented",
            "-D", "clippy::print_stdout",
            "-D", "clippy::print_stderr",
            "-D", "clippy::panic",
            "-D", "missing_docs",
            "-D", "rustdoc::missing_crate_level_docs",
            "-D", "rustdoc::broken_intra_doc_links",
            "-W", "rustdoc::invalid_html_tags",
            "-W", "rustdoc::bare_urls",
        ])
        .status()
        .expect("clippy failed");
    assert!(status.success(), "clippy found violations — see docs/research/CLIPPY-BEST-PRACTICES.md");
}

fn test() {
    let status = std::process::Command::new("cargo")
        .args(["nextest", "run", "--workspace"])
        .status()
        .expect("tests failed");
    assert!(status.success());
}

fn fmt() {
    let status = std::process::Command::new("cargo")
        .args(["fmt"])
        .status()
        .expect("cargo fmt failed");
    assert!(status.success());
}

fn audit() {
    let deny = std::process::Command::new("cargo")
        .args(["deny", "check"])
        .status()
        .expect("cargo deny failed");
    assert!(deny.success(), "cargo deny check failed");

    let audit = std::process::Command::new("cargo")
        .args(["audit", "--deny", "warnings"])
        .status()
        .expect("cargo audit failed");
    assert!(audit.success(), "cargo audit found violations");
}

fn bench() {
    // --no-run compiles benchmarks without running them (useful for CI check)
    let status = std::process::Command::new("cargo")
        .args(["bench", "--workspace", "--no-run"])
        .status()
        .expect("benchmarks failed");
    assert!(status.success());
}

fn coverage() {
    // Clear RUSTFLAGS to avoid -D warnings interfering with instrumentation
    let status = std::process::Command::new("cargo")
        .env("RUSTFLAGS", "")
        .args(["tarpaulin", "--workspace", "--out", "Html"])
        .status()
        .expect("coverage failed");
    assert!(status.success());
}

fn mutants() {
    // --in-place runs only mutants in changed files (fast, PR-friendly)
    let status = std::process::Command::new("cargo")
        .args(["mutants", "--in-place"])
        .status()
        .expect("mutation testing failed");
    assert!(status.success());
}

fn release() {
    use std::path::Path;

    // Read smith-cli version from its Cargo.toml (not xtask's version)
    let version = std::fs::read_to_string("smith-cli/Cargo.toml")
        .map(|s| parse_version(&s))
        .expect("failed to read smith-cli/Cargo.toml");

    let out_dir = Path::new("target/dist").join(format!("smith-v{}", version));
    std::fs::create_dir_all(&out_dir).unwrap();

    // Default targets are required. Any failed required build aborts release.
    // Optional OpenBSD is Tier 3 and best-effort only when explicitly requested.
    let mut targets: Vec<(&str, &str, bool)> = vec![
        ("x86_64-pc-windows-msvc", "zip", true),
        ("aarch64-pc-windows-msvc", "zip", true),
        ("x86_64-apple-darwin", "tar.gz", true),
        ("aarch64-apple-darwin", "tar.gz", true),
        ("x86_64-unknown-linux-gnu", "tar.gz", true),
        ("aarch64-unknown-linux-gnu", "tar.gz", true),
        ("x86_64-unknown-linux-musl", "tar.gz", true),
        ("aarch64-unknown-linux-musl", "tar.gz", true),
    ];

    // OpenBSD is Tier 3 — only build if explicitly requested
    if std::env::args().any(|a| a == "--include-openbsd") {
        targets.push(("x86_64-unknown-openbsd", "tar.gz", false));
    }

    // Windows MSVC targets require native Windows build host (cross-build from
    // Linux/macOS lacks import libraries for Win32 APIs like crossterm uses).
    // Skip on non-Windows hosts. Build Windows artifacts on a Windows CI runner.
    if std::env::consts::OS != "windows" {
        targets.retain(|(t, _, _)| !t.contains("windows"));
        eprintln!("NOTE: Windows targets skipped — build on Windows host for MSVC artifacts");
    }

    for (target, ext, required) in &targets {
        let bin_name = if target.contains("windows") { "smith.exe" } else { "smith" };

        // Use cargo-zigbuild for cross-compilation — provides linkers for all targets
        let build_cmd = "zigbuild";

        let status = std::process::Command::new("cargo")
            .args([build_cmd, "--release", "-p", "smith-cli", "--target", target])
            .status()
            .unwrap_or_else(|e| panic!("release build failed for {}: {}", target, e));

        if !status.success() {
            if *required {
                panic!("required release build failed for {}", target);
            } else {
                eprintln!("WARN: optional build failed for {} — skipping artifact", target);
                continue;
            }
        }

        let artifact_name = format!("smith-{}-v{}.{}", target, version, ext);
        let artifact_path = out_dir.join(&artifact_name);
        let bin_path = Path::new("target").join(target).join("release").join(bin_name);

        if *ext == "zip" {
            // Create zip archive using the `zip` crate (portable, no external tool dependency).
            // xtask dev-dependency: zip = { version = "2", default-features = false, features = ["deflate"] }
            let file = std::fs::File::create(&artifact_path).expect("create zip");
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file(bin_name, zip::write::SimpleFileOptions::default())
                .expect("start zip entry");
            let mut bin = std::fs::File::open(&bin_path).expect("open binary");
            std::io::copy(&mut bin, &mut zip).expect("write zip entry");
            zip.finish().expect("finalize zip");
        } else {
            // Create tar.gz archive using Rust crates (portable, no external tool dependency).
            // xtask dev-dependencies: tar = "0.4", flate2 = "1"
            let file = std::fs::File::create(&artifact_path).expect("create tar.gz");
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            archive
                .append_path_with_name(&bin_path, bin_name)
                .expect("append binary to tar.gz");
            let encoder = archive.into_inner().expect("finish tar archive");
            encoder.finish().expect("finish gzip stream");
        }
    }

    // Generate SHA256 checksums using Rust (portable across all platforms)
    generate_checksums(&out_dir);

    println!("Release artifacts in: {}", out_dir.display());
}

/// Parse version from Cargo.toml text. Handles:
///   version = "0.1.0"
///   version = "0.1.0" # comment
///   version = { workspace = true }  (resolves via workspace root Cargo.toml)
fn parse_version(toml: &str) -> String {
    for line in toml.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("version") { continue; }
        if trimmed.contains("workspace") {
            let ws = std::fs::read_to_string("Cargo.toml")
                .expect("workspace Cargo.toml not found");
            return parse_version(&ws);
        }
        let rhs = line.split('=').nth(1).expect("version = ...");
        let ver = rhs.split('#').next().expect("before comment").trim().trim_matches('"');
        if !ver.is_empty() { return ver.to_string(); }
    }
    panic!("version not found in Cargo.toml")
}

/// Generate SHA256 checksums for all artifacts in the output directory.
fn generate_checksums(out_dir: &std::path::Path) {
    use std::io::Write;

    let checksum_path = out_dir.join("checksums-sha256.txt");
    let mut file = std::fs::File::create(&checksum_path).expect("create checksums file");

    for entry in std::fs::read_dir(out_dir).expect("read dist dir") {
        let entry = entry.expect("read dir entry");
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "gz" && ext != "zip" {
            continue;
        }

        let data = std::fs::read(&path).expect("read artifact");
        let hash = format!("{:x}", sha2::Sha256::digest(&data));
        let name = path.file_name().unwrap().to_string_lossy();
        writeln!(file, "{}  {}", hash, name).expect("write checksum");
    }
}
```

### 10. Stub Types (key shared types from SM-005 design)

Put enough in `smith/src/` that other crates compile. See SM-005 for canonical type definitions.

## Verification

After completion:
```bash
cargo check --workspace              # all crates compile — zero warnings
cargo nextest run --workspace        # no tests yet, but no build errors
cargo run -p xtask -- check          # fmt + clippy + doc + test all pass
cargo run -p xtask -- lint           # clippy passes with pedantic lints
cargo run -p xtask -- audit          # cargo deny passes
cargo run -p xtask -- release        # build release artifacts for all targets
# Optional: include OpenBSD (Tier 3, best-effort):
# cargo run -p xtask -- release -- --include-openbsd
```

Release policy: required targets abort the `release` command on build or archive
failure. Windows MSVC artifacts are required only on Windows runners. OpenBSD is
optional, Tier 3, and best-effort only when `--include-openbsd` is passed.

## Steps

- [ ] Initialize jj repo
- [ ] Create workspace Cargo.toml with [profile.release]
- [ ] Create .cargo/config.toml with rustflags and clippy lints
- [ ] Create .clippy.toml with project-wide lint configuration
- [ ] Create .config/nextest.toml with retry and slow-timeout profiles
- [ ] Create .gitignore, rust-toolchain.toml
- [ ] Create deny.toml (required for audit command)
- [ ] Create smith/ skeleton with stub types
- [ ] Create smith-core/ skeleton
- [ ] Create smith-ai/ skeleton
- [ ] Create smith-tui/ skeleton
- [ ] Create smith-harness/ skeleton
- [ ] Create smith-cli/ skeleton
- [ ] Create xtask/ skeleton with all 14 commands
- [ ] Install cross-compilation prerequisites: `rustup target add <all 9 triples>`, `cargo install cargo-zigbuild --version 0.19`
- [ ] Verify: `cargo check --workspace`
- [ ] Verify: `cargo run -p xtask -- check`
- [ ] Commit: `jj describe -m "feat(SM-003): project scaffolding — workspace, crates, xtask"`
