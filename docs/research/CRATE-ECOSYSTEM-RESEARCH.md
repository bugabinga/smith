# Crate Ecosystem Research: smith

**Date:** 2026-05-21
**Status:** Research — informs Cargo.toml decisions and architecture

This document records crate evaluations, alternatives considered, and dependency tradeoffs for smith.

---

## 1. Async Runtime: tokio

### Decision: tokio (full feature set)

**Why:**
- De facto standard for Rust async
- `tokio::sync::mpsc` for agent-harness-TUI event channels
- `tokio::task::spawn_blocking` for crossterm polling
- `tokio::time::sleep` for tick-based TUI refresh
- `tokio::signal` for graceful shutdown

**Why not async-std:**
- Less ecosystem support, fewer integrations
- tokio is already used by reqwest (HTTP client)

**Why not smol:**
- Smaller ecosystem, less mature
- Good for embedded but overkill for smith's needs

**Version:** 1.43+ (for `tokio::sync::watch` improvements)

---

## 2. HTTP Client: reqwest

### Decision: reqwest

**Why:**
- Built on hyper (HTTP/2 support)
- Async-native with tokio integration
- SSE (Server-Sent Events) support via `reqwest::bytes_stream()` and a small parser
- Built-in JSON serialization via serde
- Proxy support (needed for secret proxy)

**Why not hyper directly:**
- reqwest is a higher-level wrapper; smith doesn't need raw HTTP control
- reqwest handles connection pooling, retries, timeouts

**Why not surf:**
- Part of async-std ecosystem; mismatch with tokio

**Version:** 0.12+ (for http 1.0 compatibility)

**SSE strategy:** Hand-rolled SSE parsing over `reqwest` streaming is the v1 path (P9). `reqwest-eventsource` or `eventsource-stream` remain viable v2 alternatives if parser complexity grows.

---

## 3. Serialization: serde + ciborium

### Decision: serde for JSON, ciborium for binary

**serde (JSON):**
- Config files, provider API payloads, tool arguments
- `serde_json` for JSON, `serde_lua` (future) for Lua tables

**ciborium (CBOR):**
- Session persistence, trace logs
- Compact, binary-safe, serde-native
- Proven by P3b/P6/P7/P11 prototypes with complex enums and trace/session roundtrips

**Why not MessagePack:**
- CBOR is an IETF standard (RFC 8949)
- Better forward/backward compatibility guarantees
- Used by WebAuthn, COSE — well-vetted

**Why not bincode:**
- bincode is Rust-specific; CBOR is language-agnostic
- CBOR has better schema evolution support

**Why not protobuf:**
- Overkill for smith's simple structs
- Requires code generation step
- CBOR with serde derives is zero-friction

**Why not mini-cbor:**
- P3 found derive friction for complex enums used by smith session/trace data.
- ciborium works directly with existing serde derives, avoiding duplicate serialization annotations.

**Versions:**
- `serde = "1"`, `serde_json = "1"`
- `ciborium = "0.2"`

---

## 4. TUI Framework: ratatui + crossterm

### Decision: ratatui with crossterm backend

**ratatui:**
- Widget framework with layout system
- `TestBackend` for snapshot testing
- 17 built-in widgets matching pi's component set
- Active development (0.29+), large community

**crossterm:**
- Cross-platform terminal control (Unix + Windows)
- Event polling (keyboard, mouse, resize)
- Raw mode, alternate screen, cursor control
- Kitty keyboard protocol support

**Why not tui-rs (deprecated):**
- ratatui is the actively maintained fork
- tui-rs is unmaintained

**Why not termion:**
- Unix-only; no Windows support
- Less featureful than crossterm

**Why not console:**
- console is simpler but lacks TUI framework
- Would require building widget system from scratch

**Versions:**
- `ratatui = "0.29"`
- `crossterm = "0.28"`

---

## 5. Lua Runtime: mlua (LuaJIT)

### Decision: mlua with LuaJIT feature

**Why mlua:**
- Safe Rust bindings to Lua/LuaJIT
- `mlua::Lua` manages Lua state lifetime
- `mlua::Function` for calling Lua from Rust
- `mlua::RegistryKey` for storing Lua references across calls
- `serde` integration for Lua table ↔ Rust struct conversion
- Lua coroutine support for plugin workflows

**Why LuaJIT:**
- JIT compilation → native code (fast)
- FFI for C libraries (future extensibility)
- Smaller memory footprint than standard Lua
- `mlua` feature flags: `features = ["luajit", "vendored", "serialize"]`

**Why not rlua:**
- rlua is unmaintained; mlua is the successor
- mlua has better async and serde support

**Why not wasmtime (WASM runtime):**
- WASM is future option (tier 2 plugins)
- LuaJIT is simpler for v1, better performance for plugin startup
- WASM has sandboxing advantages but higher complexity

**Why not Rhai:**
- Rhai is Rust-native but slower than LuaJIT
- Smaller ecosystem, fewer libraries
- Lua has better plugin developer familiarity

**Version:** `mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }`

**Android/Termux note:** Vendored LuaJIT on `aarch64-linux-android` needs compiler-rt builtins linked for `__clear_cache` (P2d): `-lclang_rt.builtins-aarch64-android`.

---

## 6. CLI Parser: clap

### Decision: clap v4 with derive feature

**Why:**
- Derive macros for declarative CLI definition
- Subcommands, flags, positional args, env var fallback
- Shell completion generation (bash, zsh, fish)
- Help text generation with formatting
- Validation (e.g., `value_parser = clap::value_parser!(u64)`)

**Why not structopt:**
- structopt is merged into clap v3+; no longer separate

**Why not argh:**
- argh is smaller but less featureful
- clap's ecosystem and documentation are superior

**Why not gumdrop:**
- gumdrop is unmaintained

**Version:** `clap = { version = "4", features = ["derive", "env", "cargo"] }`

---

## 7. Error Handling: thiserror + anyhow

### Decision: thiserror for library crates, anyhow for CLI/binary

**thiserror (smith, smith-core, smith-ai, smith-harness, smith-tui):**
- Structured error enums with `#[derive(Error)]`
- `#[from]` for automatic conversion
- `#[error("message")]` for Display formatting
- Perfect for library APIs

**anyhow (smith-cli):**
- Ergonomic error handling in application code
- `.context("...")` for adding context
- `Result<T>` type alias for simplicity

**Why not eyre:**
- eyre has color-eyre for pretty backtraces
- But smith is a TUI app — backtrace display is TUI-controlled, not terminal
- thiserror + anyhow is simpler

**Versions:**
- `thiserror = "2"`
- `anyhow = "1"`

---

## 8. Logging: tracing + tracing-subscriber

### Decision: tracing ecosystem

**Why tracing over log:**
- Structured logging with spans (track request lifecycle)
- Async-aware (spans follow tasks across threads)
- `tracing::info!`, `tracing::debug!` macros
- Compatible with `log` crate via `tracing-log`

**tracing-subscriber:**
- Formatter: `fmt::layer()` for pretty/colored output
- Filter: `EnvFilter` for `RUST_LOG=smith=debug`
- Layer composition: file + stdout simultaneously

**Why not env_logger:**
- env_logger is simpler but not async-aware
- tracing's span system is essential for tracking agent loop turns

**Why not slog:**
- slog is powerful but complex
- tracing is the modern standard

**Versions:**
- `tracing = "0.1"`
- `tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }`

---

## 9. Configuration: toml + serde

### Decision: Lua for user config, TOML for internal/metadata

**User config (`~/.smith/config.lua`):**
- Lua tables — users already write Lua for plugins
- Single language for config and plugins
- Dynamic: config can call functions, use conditionals

**Internal metadata (`Cargo.toml`, `providers.json`):**
- TOML for Cargo workspace
- JSON for provider registry (fetched from pi.dev + catwalk)

**Why not YAML:**
- YAML has too many footguns ( Norway problem, type coercion)
- TOML is simpler and unambiguous

**Why not JSON for user config:**
- JSON doesn't support comments
- Lua is more expressive (functions, conditionals)

**Why not KDL:**
- KDL is interesting but niche; no Lua integration

**Versions:**
- `toml = "0.8"` (for Cargo.toml parsing if needed)

---

## 10. XDG Directories: dirs

### Decision: dirs

**Why:**
- Cross-platform XDG directory resolution
- `dirs::config_dir()` → `~/.config/smith/` (Linux), `~/Library/Application Support/smith/` (macOS), `%APPDATA%\smith\` (Windows)
- `dirs::cache_dir()` for bytecode cache
- `dirs::data_dir()` for session storage

**Why not directories:**
- `directories` is the higher-level crate; `dirs` is lower-level
- `dirs` is sufficient for smith's needs

**Version:** `dirs = "5"`

---

## 11. UUID Generation: uuid

### Decision: uuid with v7 feature

**Why:**
- UUIDv7 is time-ordered (database-friendly, sortable)
- `uuid::Uuid::now_v7()` generates time-ordered UUIDs
- Used for `EntryId`, `SessionId`

**Why not ulid:**
- ULID is also time-ordered but less standard
- UUIDv7 is an IETF standard (RFC 9562)

**Version:** `uuid = { version = "1", features = ["v7"] }`

---

## 12. Process Spawning: tokio::process

### Decision: tokio::process::Command

**Why:**
- Async-aware process spawning
- `Command::spawn()` returns `Child` with async I/O
- Used by bash tool for async command execution
- Timeout support via `tokio::time::timeout`

**Why not std::process:**
- std::process is blocking; would block async runtime
- tokio::process integrates with tokio's I/O system

**Built into tokio** — no extra dependency.

---

## 13. Regular Expressions: regex

### Decision: regex

**Why:**
- Fast, safe regex engine (no catastrophic backtracking)
- Used by grep tool, provider response parsing
- `regex::Regex` is `Send + Sync`

**Why not fancy-regex:**
- fancy-regex supports backreferences but is slower
- smith doesn't need backreferences

**Why not ripgrep's regex engine:**
- ripgrep's regex-automata is lower-level
- `regex` crate is the standard, well-documented

**Version:** `regex = "1"`

---

## 14. Terminal Image Protocols

### Decision: kitty graphics protocol primary, sixel fallback

**Kitty graphics:**
- Modern, well-specified, supports PNG transmission
- Placement with z-index, cropping, animation
- Supported by kitty, ghostty, wezterm

**Sixel:**
- Older standard, widely supported
- Lower quality (256 colors), no alpha
- Fallback for terminals without kitty support

**No iTerm2 inline images:**
- iTerm2 protocol is macOS-specific
- Kitty protocol is more widely supported

**Implementation:** Custom escape sequence generation (no crate needed — simple string formatting).

---

## 15. Compression: zstd

### Decision: zstd

**Why:**
- Fast compression/decompression
- Dictionary support for small payloads
- Used for trace log compression (per-entry)
- Better ratio than gzip, faster than lz4 for medium payloads

**Why not gzip:**
- gzip is slower, worse ratio

**Why not lz4:**
- lz4 is faster but worse ratio
- zstd is the sweet spot for smith's trace entries

**Version:** `zstd = "0.13"`

---

## 16. Cryptographic Hashing: sha2

### Decision: sha2

**Why:**
- SHA-256 for provider payload hashing (privacy)
- SHA-256 for file hash snapshots (deterministic replay)
- `sha2::Sha256` from RustCrypto ecosystem

**Why not blake3:**
- blake3 is faster but less standard
- SHA-256 is universally recognized

**Version:** `sha2 = "0.10"`

---

## 17. Streaming: futures + tokio-stream

### Decision: tokio-stream

**Why:**
- `tokio_stream::iter()` for mock streams
- `tokio_stream::wrappers::ReceiverStream` for channel-backed streams
- `StreamExt` for `collect()`, `timeout()`, `fold()`

**Built on futures-core** — no extra dependency beyond tokio.

---

## 18. JSON Schema: jsonschema

### Decision: jsonschema (SUPERSEDED — active in v1 per SPEC §7.3)

**Why not yet:**
- Tool definition validation uses JSON Schema
- But mlua + manual validation is sufficient for v1
- Consider `jsonschema` crate for v2 if validation complexity grows

**Version:** `jsonschema = "0.28"` (workspace dep, deferred)

---

## 19. Terminal Size Detection

### Decision: crossterm

**Built into crossterm:**
- `crossterm::terminal::size()` → `(cols, rows)`
- `Resize` events via `crossterm::event::Event::Resize`
- No extra dependency needed

---

## 20. Signal Handling

### Decision: tokio::signal

**Why:**
- `tokio::signal::ctrl_c()` for SIGINT
- `tokio::signal::unix::signal()` for SIGTERM (Unix)
- Async-aware — doesn't block runtime
- Integrated with graceful shutdown flow

**Why not signal-hook:**
- signal-hook is good but tokio::signal is simpler when already using tokio

**Built into tokio** — no extra dependency.

---

## 21. Built-in Tool Search: ignore + ripgrep crates

### Decision: ignore for find, grep crates for grep

**Why `ignore`:**
- Same directory walking and `.gitignore` handling foundation used by ripgrep/fd.
- Handles gitignore negation, directory-only rules, hidden files, symlinks, glob overrides, max depth, and parallel traversal.
- Reimplementing this is non-product code with many cross-platform edge cases.

**Why `grep` + `grep-regex` + `grep-searcher`:**
- Ripgrep is exposed as a library ecosystem.
- `grep-searcher` handles efficient line search, binary detection, context, and memory mapping.
- `grep-regex` provides the regex matcher backend.
- `grep` provides the `Sink` abstraction used to stream structured matches into smith tool output.

**Why not shell out to `rg`/`fd`:**
- Library use gives structured results, timeout control, cancellation, and no text parsing.
- External commands remain available through the bash tool but are not the tool implementation substrate.

**Versions:**
- `ignore = "0.4"`
- `grep = "0.4"`, `grep-regex = "0.1"`, `grep-searcher = "0.1"`

---

## 22. TUI Feature Helpers: similar, syntastica, fuzzy-matcher

### Decision: focused crates for diff, syntax, and fuzzy filtering

**similar:**
- Provides line/word diffs, hunks, unified diff output, and similarity ratio.
- Used by replay compare mode, VCS/time-travel diff views, and tool result rendering.
- Reimplementing Myers/patience diff plus hunk formatting is complex and not smith-specific.

**syntastica + syntastica-parsers:**
- Tree-sitter-based syntax highlighting with `runtime-c2rust`, avoiding C runtime links.
- P16 verified ANSI terminal output, HTML output, custom themes, multiple languages, and Processor reuse on Android/Termux.
- Syntax highlighting is a TUI primitive; user-facing views remain Lua plugins.

**fuzzy-matcher:**
- Zero-dependency fuzzy scoring with match indices.
- Fits `SelectList`/timeline filtering: score candidates and highlight matched characters.
- `nucleo` is stronger for editor-scale fuzzy matching but overkill for smith v1.

**Versions:**
- `similar = "2"` (SPEC §2.3 canonical)
- `syntastica = { version = "0.6", default-features = false, features = ["runtime-c2rust"] }`
- `syntastica-parsers = "0.6"`
- `fuzzy-matcher = "0.3"`

---

## 23. CLI Completion: clap_complete

### Decision: clap_complete

**Why:**
- Generates shell completions from the same `clap` command definitions used by `smith-cli`.
- Keeps bash/zsh/fish completions in sync without hand-maintained scripts.
- Thin API, but maintenance savings are high and the crate is part of the clap ecosystem.

**Version:** `clap_complete = "4"`

---

## 24. VCS Primitives: jj CLI first, targeted gix when structured plugin queries land

### Decision: expose VCS as primitives; implement features as Lua plugins

**Architecture principle:**
- Rust core exposes primitives (`smith.vcs.*`, `smith.shortcut.*`, `smith.tui.*`).
- Built-in features are Lua plugins using the same SDK as user plugins.
- No feature gets a privileged Rust UI path unless it is a reusable primitive.

**jj role:**
- Operation log, undo/redo, restore, time-travel inspection, and interdiff are jj strengths.
- jj state can be relocated by symlinking `.jj` to XDG state and fixing `git_target` to an absolute path.
- P17 validates Lua plugins over `smith.vcs.*` primitives for time-travel, commands, and VCS tools.

**gix role:**
- Use targeted gix features for structured plugin query APIs where CLI parsing is fragile: status, revision resolution, blame/annotate, blob diffs, changed files.
- Do not expose gix itself to Lua; expose smith-owned data contracts.
- Avoid the full umbrella/default feature set unless a plugin API needs it.

**Version:** `gix = { version = "0.83", default-features = false, features = ["blame", "blob-diff", "revision"] }`

---

## 25. Summary: Dependency Count

| Category | Crates | Direct Deps |
|----------|--------|-------------|
| Async | tokio, tokio-stream | 2 |
| HTTP | reqwest | 1 |
| Serialization | serde, serde_json, ciborium | 3 |
| TUI | ratatui, crossterm | 2 |
| Lua | mlua | 1 |
| CLI | clap, clap_complete | 2 |
| Errors | thiserror, anyhow | 2 |
| Logging | tracing, tracing-subscriber | 2 |
| Tool search | ignore, grep, grep-regex, grep-searcher | 4 |
| TUI helpers | similar, syntastica, syntastica-parsers, fuzzy-matcher | 4 |
| VCS primitives | gix (targeted features) | 1 |
| System | dirs, uuid, regex, zstd, sha2 | 5 |
| **Total production** | | **~28** |
| **Dev/test** | insta, proptest, assert_cmd, assert_fs, expectrl, criterion, cargo-nextest, cargo-tarpaulin, cargo-mutants | 9 (tools) |

---

## 26. Rust Version Policy

**Current policy:** Latest stable Rust, edition 2024.

**Why rolling stable:**
- Smith is pre-1.0 and not yet bound by downstream library MSRV contracts.
- Current crate choices move quickly; pinning an old compiler blocks maintained dependencies.
- Edition 2024 stays fixed in manifests; compiler channel follows stable.

**Release policy:**
- Avoid setting `rust-version` in workspace manifests unless release policy requires it.
- `rust-toolchain.toml` uses `channel = "stable"`.
- If smith later needs long-term support, define a formal MSRV window then.

---

## 27. Cargo Workspace Structure

```toml
# Cargo.toml (workspace root)
[workspace]
members = ["smith", "smith-core", "smith-ai", "smith-tui", "smith-harness", "smith-cli"]
resolver = "3"

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"  # canonical per docs/SPEC.md §2.3 / PROJECT-INVARIANTS §10

[workspace.dependencies]
tokio = { version = "1.43", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ciborium = "0.2"
ratatui = "0.29"
crossterm = "0.28"
mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }
clap = { version = "4", features = ["derive", "env"] }
clap_complete = "4"
ignore = "0.4"
grep = "0.4"
grep-regex = "0.1"
grep-searcher = "0.1"
similar = "2"  # SPEC §2.3 pins 2; "3" here was stale
syntastica = { version = "0.6", default-features = false, features = ["runtime-c2rust"] }
syntastica-parsers = "0.6"
fuzzy-matcher = "0.3"
gix = { version = "0.83", default-features = false, features = ["blame", "blob-diff", "revision"] }
thiserror = "2"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
dirs = "5"
uuid = { version = "1", features = ["v7"] }
regex = "1"
zstd = "0.13"
sha2 = "0.10"
insta = "1"
proptest = "1.6"
assert_cmd = "2"
assert_fs = "1"
criterion = { version = "0.5", features = ["html_reports"] }
```

---

## 28. Rejected Crates (Documented for Future Reference)

| Crate | Why Rejected | Context |
|-------|-------------|---------|
| async-std | Ecosystem mismatch with tokio | Async runtime |
| smol | Too small, less mature | Async runtime |
| surf | async-std ecosystem | HTTP client |
| tui-rs | Unmaintained, superseded by ratatui | TUI framework |
| termion | Unix-only | Terminal control |
| rlua | Unmaintained, superseded by mlua | Lua bindings |
| wasmtime | Complexity, v2 consideration | Plugin runtime |
| Rhai | Slower, smaller ecosystem | Plugin runtime |
| structopt | Merged into clap | CLI parser |
| argh | Less featureful | CLI parser |
| eyre | Unnecessary complexity | Error handling |
| env_logger | Not async-aware | Logging |
| slog | Too complex | Logging |
| ulid | Less standard than UUIDv7 | ID generation |
| blake3 | Less standard than SHA-256 | Hashing |
| fancy-regex | Slower, backreferences not needed | Regex |
| jsonschema | Superseded: active in v1 (SPEC §2.3, §5.3, §7.3) | Validation |
| mini-cbor | Derive friction for complex enums; ciborium uses existing serde derives cleanly | CBOR serialization |
| color-eyre | Not selected for current dependency set | Error display |
| indicatif | Not selected for current dependency set | Progress bars |
| gix (full umbrella/default) | Deferred; use targeted features only behind `smith.vcs.*` structured query primitives | VCS integration |
| viuer | Deferred until multi-protocol image rendering is required; kitty-first custom rendering is enough for v1 | Terminal images |
| walkdir | Subsumed by `ignore`, which adds gitignore/glob/hidden-file semantics | File traversal |
| glob | Subsumed by `ignore`/`globset` behavior in the find tool path | Pattern matching |
| syntect | Oniguruma C dependency and regex-based highlighting; P16 proves syntastica with `runtime-c2rust` is Android-safe | Syntax highlighting |
| notify | Defer to v2; manual/plugin-triggered reload is enough for v1 | File watching |
| dashmap | Premature concurrency optimization; locks or actor ownership are clearer for smith's current maps | Concurrent maps |
| nucleo | Strong editor-scale fuzzy engine but overkill; `fuzzy-matcher` fits v1 SelectList filtering | Fuzzy matching |
