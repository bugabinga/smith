# Prototype Verification Report

**Generated**: 2026-05-22
**Status**: COMPLETE — all prototypes tested, fixes applied
**Environment**: rustc 1.95.0, aarch64-unknown-linux (Termux/Android)
**Last verified**: 2026-05-23 (cargo check + cargo run for all prototypes in report table)

## Results

| # | Prototype | Status | Summary |
|---|-----------|--------|---------|
| P1 | Workspace deps (22 crates) | ✅ PASS | All deps resolve and compile. |
| P2 | mlua vendored LuaJIT | INACTIVE (SUPERSEDED) | Historical prototype only. Android link failed due to missing compiler-rt builtins; canonical follow-up is P2d. |
| P2b | mlua non-JIT comparison prototype | ✅ SUPERSEDED | Proved mlua sandbox behavior, coroutines, serde, and error propagation on Android. Alternate runtime path removed; P2d is canonical. |
| P2d | mlua vendored LuaJIT static ARM | ✅ PASS | Static vendored LuaJIT works on Android/Termux when linking `libclang_rt.builtins-aarch64-android.a` for `__clear_cache`. |
| P3 | CBOR session codec (minicbor) | INACTIVE (SUPERSEDED) | Historical prototype only. Enum derive was broken; canonical replacement is P3b. |
| P3b | CBOR session codec (ciborium) | ✅ PASS | All 4 SessionEntry variants + TraceEntry roundtrip. |
| P4 | ratatui TUI + mouse | ✅ PASS | Fixed unused imports. Compiles clean. |
| P5 | Provider trait + MuxProvider | ✅ PASS | Fixed with async-trait crate. Failover + circuit breaker work. |
| P6 | Config parsing + CBOR | ✅ PASS | Fixed with ciborium. Config roundtrip OK (146 bytes). |
| P7 | zstd trace codec | ✅ PASS | Fixed with ciborium+serde. 100 entries, 4.4% compression ratio. |
| P8 | Terminal cap detection | ✅ PASS | Fixed with `unsafe extern "C"`. Truecolor, size detection work. |
| P9 | SSE stream parser | ✅ PASS | Parse, [DONE], multi-line data all pass. |
| P10 | xtask release (tar/zip/sha256) | ✅ PASS | Fixed with `SimpleFileOptions`. tar.gz + zip + checksums. |
| P11 | Trace roundtrip (CBOR+zstd+header) | ✅ PASS | All 7 integration tests: SessionEntry CBOR-seq, TraceEntry CBOR-seq, zstd compress/decompress, length-prefixed (uncompressed + compressed), TraceFileHeader binary, full trace file roundtrip. |
| P12 | Real LLM streaming (MiniMax API) | ✅ PASS (live) | Real SSE streaming confirmed with Token Plan endpoint (`api.minimax.io/v1/chat/completions`, model `MiniMax-M2.7`). 5 chunks received, content-length finish_reason. Mock SSE also passes. |
| P13 | Harness reload timing | ✅ PASS | 100 cycles: P50=0.4ms, P99=0.6ms, 2040 reloads/sec. Init+warmup+teardown all sub-ms. |
| P14 | Replay engine validation | ✅ PASS | Trace replay semantics, turn seek, speed modes, compare mode, and smart filtering are all validated. |
| P15 | Hot reload | ✅ PASS | Plugin load/reload/rollback, session persistence, and trace event continuity are validated. |
| P16 | syntastica syntax highlighting | ✅ PASS | 9/9 tests on Android/Termux. Rust/Lua/JS/TS highlighting, themes, HTML render, Processor reuse, zero C deps via `runtime-c2rust`. |
| P17 | VCS SDK + Lua plugins | ✅ PASS | `smith.vcs.*` primitives exposed to Lua. Time-travel, slash commands, and VCS tools implemented as Lua plugins; Rust core stays primitive-only. |
| P18 | Architecture contract | ✅ PASS | Data-only crate graph, dependency boundaries, ownership map, and async boundaries verified. |
| P19 | CLI smoke | ✅ PASS | SM-010 subcommand coverage and parsing behavior verified with clap. |
| P20 | Testing methodology meta | ✅ PASS | SM-012 coverage gates, tier gates, and evidence mapping checks are codified and validated. |
| **Total** | **23 prototypes** (incl. 2 inactive historical) | **21/21 active build+run** | **100% active build+run, 91% historical build+run, 23/23 historical check** |

## Prototype → Spec Mapping

| Prototype | Spec(s) Covered | Aspect Verified |
|-----------|----------------|----------------|
| P1 | SM-003 | Workspace deps (22 crates) resolve & compile |
| P2 | SM-009 | Historical/inactive superseded: original LuaJIT attempt (archived only) |
| P2b | SM-009 | Historical/inactive superseded non-JIT sandbox behavior comparison |
| P2d | SM-009 | Canonical vendored static LuaJIT on ARM/Android with compiler-rt builtins link |
| P3 | SM-005, SM-006 | Historical/inactive superseded: minicbor enum derivation attempt |
| P3b | SM-005, SM-006 | Canonical proof for CBOR codec using ciborium (SessionEntry/TraceEntry) |
| P4 | SM-008 | ratatui + crossterm TUI, mouse events |
| P5 | SM-007 | Provider trait, async dyn, MuxProvider failover + circuit breaker |
| P6 | SM-005 | Config parsing (SmithConfig structure) + CBOR roundtrip |
| P7 | SM-006 | zstd compressed trace codec, CBOR stream decode |
| P8 | SM-008 | Terminal cap detection (isatty, truecolor, size) |
| P9 | SM-007 | SSE stream parser, [DONE], multi-line data |
| P10 | SM-003, SM-011 | xtask release build (tar/zip/sha256) |
| P11 | SM-005, SM-006 | CBOR+zstd trace codec integration (SessionEntry + TraceEntry + TraceFileHeader roundtrip) |
| P12 | SM-007 | Real LLM API streaming (reqwest + SSE parse, Token Plan endpoint) |
| P13 | SM-009 | Harness init/warmup/teardown reload timing (Lua + CBOR + config) |
| P16 | SM-008 | Syntax highlighting with syntastica (`runtime-c2rust`), themes, file type detection, terminal/HTML render |
| P17 | SM-006, SM-009, SM-010 | VCS primitives (`smith.vcs.*`) plus Lua plugins for time-travel, `/undo`/`/redo`, and VCS tools |
| P14 | SM-006 | Replay engine behavior and session reconstruction |
| P15 | SM-009 | Hot reload lifecycle, rollback, and session continuity |
| P18 | SM-004 | Crate graph, ownership map, plugin-only feature ownership, async boundary assertions |
| P19 | SM-010 | clap command matrix, global flags, replay speed semantics, and eval JSON parsing |
| P20 | SM-012 | Test tiers, gates, required cases, and evidence coverage checks |

### Specs Without Dedicated Prototypes

| Spec | Reason |
|------|--------|
| *(none)* | All canonical specs now have dedicated prototype evidence (P18, P19, P20). |

**Pass rate**: **21/21 build+run** (active only), **23/23 check** (historical total). Historical build+run remains 21/23 (91%) because P2 and P3 are inactive superseded entries. P3 is superseded by P3b (ciborium). P2 is superseded by P2d, which proves vendored static LuaJIT works on Android/Termux.

**Integration prototypes** (P11, P12, P17) cross subsystem boundaries:
- P11 validates SM-005 shared types + SM-006 core TraceCodec work together end-to-end
- P12 validates SM-007 Provider network I/O with SSE parsing (mock-verified, real API needs valid key)
- P17 validates SM-009 Lua plugin features over SM-006/SM-010 VCS/session primitives
- P18 validates SM-004 canonical architecture boundaries
- P19 validates SM-010 CLI surface and argument behavior
- P20 validates SM-012 testing gates and required case coverage

---

## Fixes Applied

| Prototype | Original Issue | Fix Applied |
|-----------|---------------|-------------|
| P2 | `lua.load(code, None)` — 2 args | `lua.load(code)` — 1 arg (mlua 0.10 API). Linker still fails on Android. |
| P4 | Unused imports `KeyEvent`, `MouseEvent`, `Clear` | Removed from use statements. |
| P5 | `async fn` in trait not dyn-compatible | Added `async-trait = "0.1"` crate + `#[async_trait]` annotation. |
| P6 | minicbor enum broken + unused vars | Switched to ciborium, replaced broken TOML parser with direct JSON. |
| P7 | minicbor enum broken + `is_finished()` | Rewrote with ciborium+serde. Uses cursor-based CBOR stream decode. |
| P8 | `extern "C"` blocks need `unsafe` | Added `unsafe` keyword. |
| P10 | zip 2.x `FileOptions` | Changed to `SimpleFileOptions::default()`. |

---

## Critical Issues

### P0-1: minicbor enum derive broken — switch to ciborium

**Spec**: SM-005/SM-006 define CBOR session types using minicbor with `#[derive(Encode, Decode)]`
**Problem**: minicbor-derive generates `Encode<Ctx>`/`Decode<Ctx>` for enums where `Ctx=()` does NOT satisfy. Structs work. Enums fail.
**Impact**: CBOR session encoding/decoding completely blocked.
**Resolution**: P3b proves ciborium (serde-based) handles all SessionEntry and TraceEntry enum variants correctly. P6 and P7 also validate ciborium for config and trace encoding.

**Spec changes needed**:
| File | Current | Correct |
|------|---------|--------|
| SM-003 | `minicbor = { version = "0.25", features = ["std", "derive"] }` | `ciborium = "0.2"` + `serde = { version = "1", features = ["derive"] }` |
| SM-011 | Same workspace dep change | Same |
| SM-005 | `#[derive(minicbor::Encode, minicbor::Decode)]` on enums | `#[derive(serde::Serialize, serde::Deserialize)]` |
| SM-006 | `minicbor::to_vec(val)` / `minicbor::decode(&buf)` | `ciborium::ser::into_writer(val, &mut buf)` / `ciborium::de::from_reader(&buf[..])` |
| SM-006 | `#[cbor(n(0))]` field annotations | Plain serde — field order determines encoding |

### ~~P0-2~~: `async fn` in Provider trait — NOT A SPEC ISSUE

**Original claim**: SM-007 uses `async fn stream(...)` which is not dyn-compatible.
**Actual**: SM-007 uses `fn stream(&self, request: ProviderRequest) -> Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>`. This IS dyn-compatible — no async-trait needed in the spec.
**Resolution**: P5 prototype used `async fn` as a simplified design choice, but the actual spec already uses the correct `Pin<Box<dyn Stream>>` pattern. No spec change needed.

### ~~P0-3~~: mlua 0.10 `load()` API — NOT A SPEC ISSUE

**Original claim**: SM-009 uses `lua.load(code, None)` (two args) which fails in mlua 0.10.
**Actual**: SM-009 already uses `lua.load(&source).eval()?` — the correct single-arg API.
**Resolution**: Prototype P2's original code used the old API and was fixed. The spec is already correct. No spec change needed.

### P0-4: LuaJIT vendored Android/Termux linker issue — RESOLVED

**Spec**: SM-009 specifies `mlua = { features = ["luajit", "vendored"] }`
**Problem**: LuaJIT's JIT compiler calls `__clear_cache`; Rust's Android link path did not include compiler-rt builtins.
**Impact**: Original P2 failed to link on Android/Termux.
**Resolution**: P2d proves vendored static LuaJIT works on Android/Termux when linking `libclang_rt.builtins-aarch64-android.a`.
**Required link input**: add Android target rustflags or build-script detection for compiler-rt builtins, e.g. `-lclang_rt.builtins-aarch64-android`.
**Spec change**: None to Lua runtime choice. Keep single canonical runtime: `mlua` + vendored LuaJIT.

---

## Moderate Issues

### P2-1: `extern "C"` blocks require `unsafe`

**Spec**: SM-008 termcap detection uses `extern "C" { fn isatty(...) -> i32; }`
**Problem**: Rust 2024 edition requires `unsafe extern "C" { ... }`.
**Fix**: Add `unsafe` keyword. Or use `libc::isatty()`.
**Spec change**: SM-008 — use `libc::isatty()` instead of raw FFI.

### ~~P2-2~~: zip 2.x `start_file` type change — NOT A SPEC ISSUE

**Original claim**: SM-003 uses `FileOptions::default()` which is removed in zip 2.x.
**Actual**: SM-003 already uses `zip::write::SimpleFileOptions::default()`.
**Resolution**: Prototype P10's original code used the old API and was fixed. The spec is already correct.

### P2-3: Zero-warnings policy + third-party derive macros

**Problem**: minicbor-derive, serde_derive, and async-trait generate code that may trigger warnings. `-D warnings` in workspace Cargo.toml applies to all crates.
**Fix**: `#[allow(dead_code)]` on enums with unused variants, `#![allow(...)]` in crate roots.
**Spec change**: PROJECT-INVARIANTS — document `#[allow]` strategy for proc-macro output.

### P2-4: P5 unused dependencies (FIXED)

**Problem**: P5 `Cargo.toml` included 4 unused deps: `reqwest`, `futures`, `serde_json`, `uuid`. Adds unnecessary compile time.
**Impact**: Minor bloat in prototype. Not a design issue — real smith-ai may use reqwest.
**Fix applied**: Removed all 4 unused deps. Verified clean build.

---

## Spec Corrections Summary

| Priority | Issue | Specs Affected | Action |
|----------|-------|---------------|--------|
| P0 | Switch minicbor → ciborium | SM-003, SM-005, SM-006, SM-004, SM-011 | Replace CBOR crate and all Encode/Decode usage |
| P0 | LuaJIT vendored on Android | SM-003, SM-011 | RESOLVED by P2d: link compiler-rt builtins; keep vendored LuaJIT only |
| ~~P0~~ | ~~Provider trait async dyn~~ | ~~SM-003, SM-007~~ | ~~NOT A SPEC ISSUE — spec uses Pin<Box<dyn Stream>>~~ |
| ~~P0~~ | ~~mlua 0.10 load() API~~ | ~~SM-009~~ | ~~NOT A SPEC ISSUE — spec already correct~~ |
| ~~P2~~ | ~~extern "C" unsafe~~ | ~~SM-008~~ | ~~NOT A SPEC ISSUE — spec uses crossterm~~ |
| ~~P2~~ | ~~zip 2.x API~~ | ~~SM-003~~ | ~~NOT A SPEC ISSUE — spec already correct~~ |
| P2 | Zero-warnings + macros | PROJECT-INVARIANTS | Document #[allow] strategy |

---

## Verified Working

| Component | Crate | Version | Verified By |
|-----------|-------|---------|-------------|
| mlua + LuaJIT (vendored) | mlua | 0.10.5 | P2d ✅ static on Android/Termux with compiler-rt builtins link |
| mlua non-JIT comparison prototype | mlua | 0.10.5 | P2b ✅ behavior proven, superseded by P2d |
| ratatui + crossterm | ratatui | 0.29.0 | P4 ✅ |
| crossterm | crossterm | 0.28.1 | P4, P8 ✅ |
| ciborium (serde CBOR) | ciborium | 0.2.2 | P3b, P6, P7 ✅ |
| async-trait | async-trait | 0.1 | P5 ✅ |
| SSE parser (hand-rolled) | — | — | P9 ✅ |
| tar.gz / zip / sha256 | tar, zip, sha2 | 0.4, 2.x, 0.10 | P10 ✅ |
| tokio async runtime | tokio | 1.x | P5 ✅ |
| thiserror | thiserror | 2 | P5, P6 ✅ |
| zstd compression | zstd | 0.13 | P7 ✅ (4.4% ratio) |
| flate2 gzip | flate2 | 1.x | P10 ✅ |
| serde JSON roundtrip | serde_json | 1.x | P6 ✅ |

---

## Integration Prototype Findings

### P11: Trace Roundtrip (CBOR + zstd + TraceFileHeader)

**What it tests**: SM-005 SessionEntry enum + SM-006 TraceEntry enum + TraceFileHeader binary layout + zstd compression + length-prefixed CBOR-seq encoding.

**All 7 tests pass:**
1. SessionEntry CBOR-seq roundtrip (6 variants, 655 bytes)
2. TraceEntry CBOR-seq roundtrip (4 entries, 335 bytes)
3. zstd compress/decompress (69.0% ratio)
4. Length-prefixed encoding (uncompressed)
5. Length-prefixed encoding (per-entry zstd compressed)
6. TraceFileHeader binary write/read (64 bytes)
7. Full trace file roundtrip (header + compressed body)

**Key finding**: Per-entry zstd compression is **115.5% of raw CBOR** for small traces (4 entries). The spec claims "60-70% size reduction" but that only applies to larger traces with more repetitive data. Small entries have too much zstd header overhead per entry.

**Recommendation**: Consider block-level compression (compress N entries together) for traces with < 50 entries, and per-entry compression for larger traces. Or use a minimum entry size threshold before compressing.

### P12: Real LLM Streaming

**What it tests**: reqwest HTTP client + SSE stream parsing + JSON deserialization + error handling.

**Mock SSE test passes**: 4 chunks parsed, content="Hello world", finish_reason=stop.

**Real API test**: MiniMax Token Plan endpoint confirmed working. `api.minimax.io/v1/chat/completions`, model `MiniMax-M2.7`. HTTP 200 + `content-type: text/event-stream`. Received 5 SSE chunks, `finish_reason=length` (hit max_tokens=50). Full content received.

**Key findings**:
- Token Plan uses `api.minimax.io` (NOT `api.minimax.chat`). Key prefix `sk-cp-` = Token Plan.
- Model `MiniMax-M2.7` replaces deprecated `MiniMax-Text-01`.
- Endpoint is OpenAI-compatible `/v1/chat/completions`.
- MiniMax returns errors as non-streaming JSON with HTTP 200 — error detection must check body format.

**Verified working:**
- reqwest streaming (bytes_stream)
- SSE line parsing (event:, data:, multi-line, [DONE])
- ChatCompletion JSON deserialization
- Real Token Plan authentication

### P13: Harness Reload Timing

**What it tests**: SM-009 harness integration — init/teardown/reinit cycle timing for Lua runtime + CBOR codec + config + provider registry.

**All 6 tests pass:**
1. Harness init: 0.9ms (first run)
2. Warmup (sandbox + 2 plugin stubs + CBOR encode): 0.3ms
3. Verify operational (Lua eval + config + codec + providers)
4. Teardown (drop): 0.1ms
5. 100 consecutive reload cycles
6. Statistics + assertions

**Results (100 cycles on Android/Termux aarch64):**
| Metric | Value |
|--------|-------|
| P50 reload | 0.4ms |
| P95 reload | 0.5ms |
| P99 reload | 0.6ms |
| Throughput | 2040 reloads/sec |
| Total 100 cycles | 49.0ms |

**Key finding**: Harness reload is extremely fast — 0.4ms median. Lua runtime init is 0.2ms P50, CBOR config roundtrip is sub-ms. Fast enough for hot-reload on plugin change without perceptible delay. No need for lazy init or connection pooling for the Lua subsystem.

---

## P16: Syntax Highlighting (syntastica)

**What it tests**: syntastica with `runtime-c2rust` on Android/Termux, exercising Rust/Lua/JavaScript/TypeScript highlighting, theme switching, custom themes, file type detection, Processor reuse, and HTML output.

**Key findings**:
- `runtime-c2rust` avoids C runtime dependencies; no Oniguruma or `libtree-sitter` dynamic link.
- Terminal truecolor ANSI output and HTML rendering both work.
- TOML support is not required for v1; use explicit language selection where file type detection is incomplete.

---

## P17: VCS SDK + Lua Plugins

**What it tests**: Rust exposes only `smith.vcs.*` and `smith.shortcut.*` primitives through mlua; features are Lua plugins.

**All feature flows pass through Lua plugins:**
1. `time-travel.lua` — timeline/op inspection/diff/undo flow over `smith.vcs.*`.
2. `commands.lua` — `/undo`, `/redo`, history commands.
3. `vcs-tools.lua` — status, diff, history, restore, annotate-style tool surfaces.

**Key findings**:
- Architectural rule holds: built-in features are Lua plugins; Rust core provides minimal primitives.
- jj operation history can back undo/redo and time-travel without custom file snapshot stacks.
- Plugin-facing VCS APIs need validated inputs, structured outputs, and mode-aware shortcuts.

---

## Recommendations

1. **Accept ciborium over minicbor** — Proven in 3 prototypes (P3b, P6, P7). Eliminates all minicbor-related issues. Adds serde dependency (already needed for JSON config). Tradeoff: slightly larger binary, no zero-copy decode. Acceptable.

2. **Use one Lua runtime path** — P2d proves `mlua` with `luajit` + `vendored` compiles, links, and runs on Android/Termux when compiler-rt builtins are linked. Keep LuaJIT as the only supported runtime path; remove alternate runtime features.

3. **Document `#[allow]` strategy** — Proc-macro derive output (serde, ciborium) may trigger warnings under `-D warnings` policy. Create a PROJECT-INVARIANTS section on allow-lint strategy.

4. **Revisit zstd per-entry compression** — P11 shows per-entry zstd is 115% of raw CBOR for small traces. Consider block-level compression or minimum entry size threshold. Update SM-006 §13.3 compression trade-off note.

5. **Handle non-SSE error responses** — P12 shows MiniMax returns errors as plain JSON (HTTP 200) not SSE. SM-007 Provider implementations must detect non-streaming JSON and convert to `ProviderEvent::Error`.

6. **Keep Rust core primitive-only** — P17 validates the target architecture: Rust exposes SDK primitives (`smith.vcs.*`, `smith.shortcut.*`, `smith.tui.*`), while user-facing features are Lua plugins. Built-in plugins and user plugins must use the same interface.

~~The following were initially flagged but verified as NOT spec issues:~~

~~- Add async-trait crate (SM-007 already uses Pin<Box<dyn Stream>>)~~
~~- Fix mlua load() API (SM-009 already uses correct single-arg form)~~
~~- Use libc for FFI (SM-008 uses crossterm, not raw extern "C")~~
~~- Update zip API (SM-003 already uses SimpleFileOptions)~~

---

## Post-Audit Fixes

### Audit Fix 1: P6 mlua dead dependency (APPLIED)

**Found**: P6 `Cargo.toml` listed `mlua = { version = "0.10", features = ["luajit", "vendored", "serialize"] }` but source never used mlua. Vendored LuaJIT fails to link on Android/Termux (same `__clear_cache` as P2).
**Impact**: P6 could not build on this platform despite code being correct.
**Fix applied**: Removed mlua from P6 Cargo.toml. Verified clean build.

### Audit Fix 2: P5 unused dependencies (APPLIED)

**Found**: P5 `Cargo.toml` had 4 unused deps: `futures`, `reqwest`, `serde_json`, `uuid`. Report only flagged `reqwest`.
**Fix applied**: Removed all 4. Verified clean build.
