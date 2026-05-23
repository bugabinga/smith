# Project Invariants

These invariants govern the smith codebase. They are non-negotiable rules that every contributor, tool, and agent must follow. Violations require explicit approval to override.

## 1. Cargo Is the Sole Build System and Entry Point

**Invariant:** `cargo` is the only build system. No `make`, `just`, `npm`, `pnpm`, or custom scripts outside of cargo.

**Implication:** Every developer-facing task must be reachable via `cargo`:
- Build: `cargo build`, `cargo check`
- Test: `cargo test`, `cargo nextest run`
- Lint: `cargo clippy`, `cargo fmt`
- Docs: `cargo doc`
- Custom tasks: `cargo run -p xtask -- <cmd>`

**xtask boundary:** Any task not handled natively by cargo lives in the `xtask/` workspace crate. xtask is the single extension point for custom automation.

**Prohibited:**
- Makefile, justfile, package.json, build.sh
- Shell scripts in repo root or scripts/
- Any build step that requires tools not installable via `cargo install`

## 2. Directory Separation: Code vs. Project Management

```
smith/                          # ← code (crates, Cargo, .rs)
├── Cargo.toml                  # workspace root
├── smith/
├── smith-core/
├── smith-ai/
├── smith-tui/
├── smith-harness/
├── smith-cli/
├── xtask/
├── .gitignore
├── rust-toolchain.toml
└── ...

docs/                           # ← project management (specs, research)
├── specs/                      # canonical subsystem specs
│   ├── spec-sm-003-scaffolding.md
│   ├── spec-sm-004-architecture.md
│   ├── spec-sm-005-shared-types.md
│   ├── spec-sm-006-core.md
│   ├── spec-sm-007-ai.md
│   ├── spec-sm-008-tui.md
│   ├── spec-sm-009-harness.md
│   ├── spec-sm-010-cli.md
│   ├── spec-sm-011-workspace.md
│   └── spec-sm-012-testing.md
├── research/                   # ecosystem research, tool analysis
│   ├── RESEARCH-NOTES.md
│   ├── TERMINAL-CAPABILITIES-RESEARCH.md
│   ├── TESTING-STRATEGY-RESEARCH.md
│   ├── CI-PATTERNS-RESEARCH.md
│   └── CRATE-ECOSYSTEM-RESEARCH.md
├── design/                     # subsystem design documents
│   ├── TUI-CRATE-DESIGN.md
│   ├── PLUGIN-SDK-DESIGN.md
│   └── AI-CRATE-DESIGN.md
├── plans/                      # task breakdowns, documentation plans
│   ├── TASK-BREAKDOWN.md
│   └── PLUGIN-DOC-PLAN.md
└── PROJECT-INVARIANTS.md       # this file
```

**Rule:** Code review gates on `src/`, `Cargo.toml`, `tests/`. Project management review gates on `docs/`. No code in `docs/`, no specs in `src/`.

## 3. Build Invariants

### 3.1 Rust Toolchain

**Policy:** Smith follows latest stable Rust. Do not pin a numeric MSRV in docs or manifests unless release engineering later creates a formal support window.

```toml
# rust-toolchain.toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

### 3.2 Clippy — Zero Warning Policy

**Invariant:** All workspace crates compile with zero warnings. No exceptions for shipped code.

#### Configuration Files

```toml
# .cargo/config.toml
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

# Required for vendored LuaJIT on Android/Termux ARM64.
[target.aarch64-linux-android]
rustflags = ["-C", "link-args=-lclang_rt.builtins-aarch64-android"]
```

```toml
# .clippy.toml — project-wide lint configuration
# NOTE: clippy.toml only supports configuration VALUES.
# Lint enablement/disablement is in .cargo/config.toml rustflags.

cognitive-complexity-threshold = 25
# No msrv key: lint policy follows latest stable Rust.
```

#### Command

```bash
cargo clippy --workspace --all-targets --all-features
```

#### Escape Hatch Policy

`#[allow(...)]` is permitted **only** with a documented reason:

```rust
// BAD — no reason, will rot
#[allow(clippy::unwrap_used)]

// GOOD — reason documented, #[expect] preferred (Rust 1.81+)
#[expect(clippy::unwrap_used, reason = "mutex never poisoned — sole accessor")]
let guard = mutex.lock().unwrap();
```

**Preferred:** Use `#[expect(lint, reason = "...")]` (Rust 1.81+). It suppresses the lint AND warns if the lint is not actually triggered, catching stale allows.

**Registry:** Project-wide exceptions are documented in `.clippy.toml` with rationale. No scattered `#[allow]` attributes.

**Proc-macro output:** Derive macros (serde/ciborium and similar) may trigger warnings under `-D warnings` from generated code or intentionally generated fields. Use `#[expect(..., reason = "...")]` on the deriving item or narrowest containing module. Do not edit generated output or silence warnings crate-wide.

### 3.3 Format — Enforced
```bash
cargo fmt --check
```
CI fails on unformatted code. No manual formatting debates — rustfmt is the authority.

### 3.4 Unsafe Code — Forbidden by Default

```rust
// Every lib.rs in workspace crates:
#![forbid(unsafe_code)]
```

**Exception:** `smith-cli` binary crate may use `unsafe` for OS-specific terminal manipulation **only** when:
1. No safe alternative exists in the ecosystem
2. Wrapped in a safe abstraction with `// SAFETY:` comment
3. The safe wrapper is unit-tested independently
4. Approved in PROJECT-INVARIANTS with documented rationale

**Clippy enforcement:**
```rust
-D clippy::undocumented_unsafe_blocks
```

Every `unsafe` block must have a `// SAFETY:` comment explaining:
- What invariant makes this safe
- Why no safe alternative exists
- What could go wrong if the invariant is violated

### 3.5 unwrap, expect, panic — Prohibited in Libraries

Enforced by clippy:
```rust
-D clippy::unwrap_used
-D clippy::expect_used
-D clippy::panic
```

| Context | `unwrap()` | `expect()` | `panic!()` |
|---------|-----------|-----------|-----------|
| Library code (`smith/`, `smith-core/`, etc.) | **Prohibited** — use `?` or `match` | **Allowed only** with message explaining guaranteed invariant | **Prohibited** — use `Result` |
| Test code | **Allowed** | **Allowed** | **Allowed** |
| `smith-cli` / `xtask` | **Allowed** with justification comment | **Allowed** with justification comment | **Allowed** with justification comment |

**Rationale:** In a TUI, a panic corrupts terminal state (raw mode, alternate screen). Never acceptable in library code.

### 3.6 Documentation — Required and Enforced

```bash
cargo doc --workspace --no-deps
```

**Lint flags (in .cargo/config.toml rustflags):**
```rust
-D missing_docs
-D rustdoc::missing_crate_level_docs
-D rustdoc::broken_intra_doc_links
-W rustdoc::invalid_html_tags
-W rustdoc::bare_urls
```

**Standard:** Every public item must answer:
- **What** does this do? (one-line summary)
- **Why** would I use it? (context/purpose)
- **How** do I use it? (example for complex types)
- **When** does it panic/error? (invariants, error conditions)

**All library crates:** `#![warn(missing_docs)]` in `lib.rs`.

### 3.7 Dependency Audit
```bash
cargo deny check
```
Run via CI. Forbids:
- Duplicate versions of the same crate (without explicit exception)
- Unmaintained crates (`cargo-deny` advisory-db)
- Crates with incompatible licenses

## 4. xtask Responsibilities

xtask is the single extension point for tasks cargo does not handle natively.

### Required Commands

| Command | Purpose | Frequency |
|---------|---------|-----------|
| `cargo run -p xtask -- check` | Full CI check: fmt, clippy, test, doc | CI |
| `cargo run -p xtask -- test` | Run all tests (delegates to `cargo nextest run`) | Every commit |
| `cargo run -p xtask -- lint` | Clippy + rustfmt check | Every commit |
| `cargo run -p xtask -- fmt` | Auto-format (delegates to `cargo fmt`) | On demand |
| `cargo run -p xtask -- fetch-providers` | Fetch pi.dev + catwalk → `providers.json` | On demand |
| `cargo run -p xtask -- doc-test` | Extract + run Lua code blocks from docs | CI |
| `cargo run -p xtask -- verify-docs` | Completeness checks (every API documented) | CI |
| `cargo run -p xtask -- doc-gen` | Generate man pages + docs bundle | Release |
| `cargo run -p xtask -- spec-verify` | Verify spec cross-references, check for stale links | CI |
| `cargo run -p xtask -- audit` | `cargo deny check` + security audit | CI |
| `cargo run -p xtask -- bench` | Run criterion benchmarks | Nightly |
| `cargo run -p xtask -- coverage` | Generate coverage report (tarpaulin) | CI |
| `cargo run -p xtask -- mutants` | Run mutation testing (cargo-mutants) | Nightly |
| `cargo run -p xtask -- release` | Build release binary for all targets, archive + checksum | Release |

### xtask Implementation Rule
xtask commands must be thin orchestrators. They delegate to cargo, nextest, clippy, etc. No heavy logic in xtask. No business logic. Just task coordination.

## 5. Agent Boundary Contract

Files that coding agents MUST NOT modify without explicit user approval:
- `docs/PROJECT-INVARIANTS.md`
- `docs/specs/` (specs are source of truth — agents read, don't edit)
- `Cargo.toml` workspace root (agents read dependencies, don't add/remove)
- `.cargo/config.toml`
- `rust-toolchain.toml`

Files that coding agents MAY modify freely:
- `*/src/*.rs` (implementation)
- `*/tests/*.rs` (tests)
- `xtask/src/*.rs` (xtask commands)
- `benches/*.rs` (benchmarks)

Files that coding agents SHOULD read before modifying:
- `docs/specs/spec-sm-NNN-*.md` (the spec for the subsystem being changed)
- `AGENTS.md` (project overview)

## 6. Spec-Code Relationship

1. **Spec before code.** No `.rs` changes without a corresponding spec update (or documented exception).
2. **Specs live in `docs/specs/`.** Code lives in crate directories.
3. **Cross-references are unidirectional:** specs reference code (`see smith-core/src/agent.rs`), code does NOT reference specs.
4. **Spec changes require `cargo run -p xtask -- spec-verify`.**

## 7. Version Control

- **VCS:** jj (Jujutsu) — modern DVCS with git compatibility.
- **No merge commits:** Use `jj squash` or `jj rebase` for linear history.
- **Commit messages:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Branch naming:** Not applicable with jj (bookmarks), but if using git: `feature/description`, `fix/description`.

## 8. Performance Invariants

- **Binary size:** Release binary < 20MB (stripped).
- **Startup time:** `smith --help` < 100ms.
- **TUI frame time:** `terminal.draw()` < 2ms (16ms budget for 60fps).
- **Session encode:** 1000 entries < 5ms.
- **Agent loop turn:** LLM call + tool execution < 30s (with timeout).

Benchmarks tracked with criterion. Baselines stored in `target/criterion/`. Regressions > 10% fail CI.

## 8a. Release Artifact Invariants

### Target Platforms

| Platform | Triple | Rust Tier | Status |
|----------|--------|-----------|--------|
| Windows x86_64 | `x86_64-pc-windows-msvc` | Tier 1 | Required |
| Windows ARM64 | `aarch64-pc-windows-msvc` | Tier 1 | Required |
| macOS Intel | `x86_64-apple-darwin` | Tier 2 | Required |
| macOS Apple Silicon | `aarch64-apple-darwin` | Tier 1 | Required |
| Linux x86_64 (glibc) | `x86_64-unknown-linux-gnu` | Tier 1 | Required |
| Linux ARM64 (glibc) | `aarch64-unknown-linux-gnu` | Tier 1 | Required |
| Linux x86_64 (musl) | `x86_64-unknown-linux-musl` | Tier 2 | Required (static) |
| Linux ARM64 (musl) | `aarch64-unknown-linux-musl` | Tier 2 | Required (static) |
| OpenBSD x86_64 | `x86_64-unknown-openbsd` | Tier 3 | Best-effort |

**Development environment note:** Android/Termux on `aarch64-linux-android` is a supported development environment, not a release artifact target. Vendored LuaJIT requires compiler-rt builtins linked for `__clear_cache`; see `.cargo/config.toml`.

### Artifact Format

Each release produces:
- `smith-{triple}-v{version}.{ext}` — platform-specific archive (zip for Windows, tar.gz for Unix)
- `checksums-sha256.txt` — SHA256 checksums of all archives

Nothing else. No install scripts, no package manifests, no distribution metadata.

### Release Profile

```toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = "symbols"
panic = "abort"
```

No debug info in release builds. Debug symbols are produced only by the default (dev) profile.

### Release Pipeline

1. `cargo run -p xtask -- release` — builds all targets via cargo-zigbuild, creates archives, generates checksums.
2. OpenBSD (Tier 3) is best-effort — build natively if possible, skip otherwise.

No CI, no automated distribution, no code signing yet. These are deferred.

See `docs/research/RELEASE-BUILD-RESEARCH.md` for cross-platform build tooling analysis.

## 9. Testing Invariants

See `docs/specs/spec-sm-012-testing.md` for comprehensive testing strategy. Invariants here:

- **100% unit coverage** for `smith/` (pure types, no I/O).
- **≥ 95% coverage** for `smith-core/`.
- **≥ 90% coverage** for `smith-ai/`.
- **≥ 85% coverage** for `smith-tui/` (widget rendering via TestBackend).
- **≥ 90% coverage** for `smith-harness/`.
- **≥ 80% coverage** for `smith-cli/`.
- **Mutation score > 80%** caught by tests (nightly gate).
- **All benchmarks pass** without regression > 10% (nightly gate).

## 10. Cargo Workspace Structure

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
```

- `smith/`: Foundation crate — shared types, config, errors, Lua runtime.
- `smith-core/`: Agent loop, session management, tool registry, compaction.
- `smith-ai/`: Provider implementations, model registry, auth, streaming.
- `smith-tui/`: Terminal UI — widgets, layout, theme, event handling.
- `smith-harness/`: Plugin system, SDK, event bridge, commands.
- `smith-cli/`: Binary entry point, argument parsing, session CLI.
- `xtask/`: Build automation, task orchestration.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-22 | Initial invariants | smith-spec |
