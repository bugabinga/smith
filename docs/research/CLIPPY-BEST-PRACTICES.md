# Clippy Best Practices for Cross-Platform Rust TUIs

> **Status: research candidates, non-canonical.** The canonical lint policy is
> `docs/SPEC.md` §3.2/§3.3 (mirrored in `.cargo/config.toml`). Lints listed
> here beyond that set are candidates for post-v1 escalation, not requirements.

**Date:** 2026-05-22  
**Scope:** Lint configuration, zero-warning policy, cross-platform TUI enforcement, unsafe restrictions, rustdoc rules.

## 1. Philosophy: Zero Warnings as Quality Gate

A warning is a bug that hasn't been prioritized. In a TUI codebase where terminal state corruption is catastrophic, warnings are unacceptable.

**Rule:** `-D warnings` in `.cargo/config.toml`. CI fails on any warning. Local dev uses same flags so surprises are impossible.

**Why not just `cargo clippy -- -D warnings`?** Because `cargo build` and `cargo check` must also fail on warnings. The rustflags approach ensures every compilation path enforces the same standard.

## 2. Lint Group Strategy

| Group | Level | Rationale |
|-------|-------|-----------|
| `clippy::all` | deny | Core lints — no debate |
| `clippy::pedantic` | deny | Style, API misuse, subtle bugs |
| `clippy::suspicious` | deny | Likely bugs (off-by-one, useless conversions) |
| `clippy::complexity` | deny | Maintainability |
| `clippy::perf` | deny | Performance |
| `clippy::style` | deny | Consistency |
| `clippy::correctness` | deny | Actual bugs |
| `clippy::nursery` | warn | Experimental — review periodically, promote to deny |
| `clippy::restriction` | selective | Too opinionated for blanket enable |

### Selected Restriction Lints (deny)

```rust
// In .cargo/config.toml or crate-level attributes:
-D clippy::unwrap_used           // Use ? or match in libraries
-D clippy::expect_used            // Document invariant if truly guaranteed
-D clippy::panic                 // No panic in libraries (use Result)
-D clippy::print_stdout          // No println! in libraries (use tracing)
-D clippy::print_stderr          // No eprintln! in libraries
-D clippy::todo                 // No TODO in shipped code
-D clippy::unimplemented        // No unimplemented! in shipped code
-D clippy::missing_docs_in_private_items // All items documented
-D clippy::missing_inline_in_public_items // Small fns should be inline
-D clippy::exhaustive_enums      // Force #[non_exhaustive] on public enums
-D clippy::impl_trait_in_params  // Explicit types in public APIs
```

### Why These Restriction Lints?

- **`unwrap_used`/`expect_used`**: Forces explicit error handling. In a TUI, a panic corrupts terminal state (raw mode, alternate screen). Never acceptable.
- **`print_stdout`/`print_stderr`**: Library code must use `tracing` for structured logging. Direct stdout/stderr writes bypass the TUI's output management.
- **`todo`/`unimplemented`**: Prevents shipping stub code. Agents especially must not commit TODOs.
- **`missing_docs_in_private_items`**: Private code is read more than written. Documentation aids agents and future maintainers.
- **`exhaustive_enums`**: Public enums without `#[non_exhaustive]` are breaking-change hazards. Force explicit opt-in to extensibility.

## 3. Cross-Platform TUI Enforcement

### Platform-Specific Code Detection

```rust
// Deny unconditional platform-specific code outside cfg-gated modules
-D clippy::cfg_not_test          // Ensure cfg tests cover all paths
-W clippy::missing_const_for_fn   // Platform fns should be const where possible
```

### Async/Sync Boundary Lints

TUI code has critical async/sync boundaries:

```rust
// In .cargo/config.toml:
-D clippy::await_holding_lock     // Never hold MutexGuard across .await
-D clippy::async_yields_async     // Don't return futures from async fns
```

**Rationale:** Holding a lock across an await point in tokio can deadlock or panic (tokio::sync::Mutex panics). The crossterm event poller runs on a blocking thread — never await while holding state locks.

### Terminal State Safety

```rust
// Force RAII patterns for terminal state
-D clippy::drop_non_drop           // Ensure TerminalGuard implements Drop
-W clippy::significant_drop_tightening // Catch held guards across await
```

## 4. Unsafe Rust Policy

### `#![forbid(unsafe_code)]` — Default for All Library Crates

```rust
// smith/src/lib.rs
#![forbid(unsafe_code)]
#![warn(missing_docs)]
```

### Exception: smith-cli Binary

`smith-cli` MAY use unsafe for OS-specific terminal manipulation ONLY when:
1. No safe alternative exists in the ecosystem
2. Wrapped in a safe abstraction with `// SAFETY:` comment
3. The safe wrapper is unit-tested independently
4. Documented in PROJECT-INVARIANTS with approval

### Clippy Unsafe Lints

```rust
-D clippy::undocumented_unsafe_blocks    // Every unsafe block needs SAFETY comment
-W clippy::unsafe_derive_deserialize     // Review auto-generated unsafe
```

## 5. Rustdoc Documentation Rules

### Required Lints

```rust
// In .cargo/config.toml rustflags:
-D missing_docs                    // All public items must have doc comments
-D rustdoc::missing_crate_level_docs // Crate root must have module docs
-D rustdoc::broken_intra_doc_links  // All doc links must resolve
-W rustdoc::invalid_html_tags       // Malformed HTML in docs
-W rustdoc::bare_urls               // URLs should be proper links
```

### Documentation Quality Standards

Every public item must answer:
- **What** does this do? (one-line summary)
- **Why** would I use it? (context/purpose)
- **How** do I use it? (example for complex types)
- **When** does it panic/error? (invariants, error conditions)

### Example: Good Doc Comment

```rust
/// A length-prefixed CBOR-seq codec for session persistence.
///
/// The wire format is `[u32 BE len][CBOR entry bytes]...` repeated.
/// Fault tolerance rules:
/// - Truncated entry → stop, prior entries intact
/// - Corrupt CBOR → log warning, skip (advance by len), continue
/// - Unknown entry type → keep as `SessionEntry::Unknown`
///
/// # Example
/// ```
/// let entries = SessionCodec::decode(&data)?;
/// ```
///
/// # Errors
/// Returns `DecodeError` if no entries could be decoded.
pub struct SessionCodec;
```

## 6. Escape Hatch Policy

### `#[allow(...)]` — Permitted Only With Documented Reason

```rust
// BAD — no reason, will rot
#[allow(clippy::unwrap_used)]

// GOOD — reason documented, #[expect] preferred
#[expect(clippy::unwrap_used, reason = "mutex is never poisoned — this is the only accessor")]
let guard = mutex.lock().unwrap();
```

### `#[expect(...)]` vs `#[allow(...)]`

Rust 1.81+ introduced `#[expect(lint)]` which:
1. Suppresses the lint (like `allow`)
2. **Warns if the lint is NOT triggered** (catches stale allows)

**Preferred:** Use `#[expect(...)]` everywhere. Only use `#[allow(...)]` for macro-generated code where the lint trigger is outside your control.

### Exception Registry

If a lint is allowed/expected project-wide (not per-site), document it in `.clippy.toml` with rationale. Do not scatter `#[allow]` attributes.

## 7. CI Integration

### Fast Path (every commit)

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

### Thorough Path (CI gate)

```bash
# Full pedantic + nursery
cargo clippy --workspace --all-targets --all-features \
  -- -D warnings -W clippy::nursery \
     -D clippy::unwrap_used -D clippy::expect_used \
     -D clippy::todo -D clippy::unimplemented

# Doc checks
cargo doc --workspace --no-deps
```

### xtask Integration

```rust
// xtask/src/lint.rs
fn lint() {
    let status = std::process::Command::new("cargo")
        .args(["clippy", "--workspace", "--all-targets", "--all-features",
               "--", "-D", "warnings",
               "-D", "clippy::unwrap_used",
               "-D", "clippy::expect_used",
               "-D", "clippy::todo",
               "-D", "clippy::unimplemented",
               "-D", "clippy::print_stdout",
               "-D", "clippy::print_stderr",
               "-D", "missing_docs"])
        .status()
        .expect("clippy failed");
    assert!(status.success(), "clippy found violations");
}
```

## 8. Recommended Crates for Lint-Assisted TUI Development

| Crate | Purpose | Clippy Integration |
|-------|---------|-------------------|
| `tracing` | Structured logging | `print_stdout` lint ensures no raw prints |
| `thiserror` | Error types | `unwrap_used` forces proper error propagation |
| `ratatui` | TUI framework | TestBackend for snapshot testing |
| `crossterm` | Terminal I/O | Platform-agnostic — no cfg needed |
| `tokio` | Async runtime | `await_holding_lock` prevents deadlocks |

## 9. References

- [Clippy Lint List](https://rust-lang.github.io/rust-clippy/master/index.html)
- [Rustdoc Lints](https://doc.rust-lang.org/rustdoc/lints.html)
- [The Rust Performance Book — Clippy Perf Lints](https://nnethercote.github.io/perf-book/build-configuration.html)
- [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)
