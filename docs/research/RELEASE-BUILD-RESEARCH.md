# Release Build Research: Cross-Platform Rust CLI Distribution

## 1. Target Platforms

| Platform | Target Triple | Rust Tier | Build Strategy | Notes |
|----------|--------------|-----------|----------------|-------|
| Windows x86_64 | `x86_64-pc-windows-msvc` | Tier 1 | Native MSVC or cross | Primary Windows target |
| Windows ARM64 | `aarch64-pc-windows-msvc` | Tier 1 | Native or cross | Surface Pro, Snapdragon laptops |
| macOS Intel | `x86_64-apple-darwin` | Tier 2 | Native Xcode | Intel Macs (declining) |
| macOS Apple Silicon | `aarch64-apple-darwin` | Tier 1 | Native Xcode | Primary Mac target |
| Linux x86_64 (glibc) | `x86_64-unknown-linux-gnu` | Tier 1 | Native or cross | Primary Linux desktop |
| Linux ARM64 (glibc) | `aarch64-unknown-linux-gnu` | Tier 1 | Native or cross | Raspberry Pi 4/5, AWS Graviton |
| Linux x86_64 (musl) | `x86_64-unknown-linux-musl` | Tier 2 | cargo-zigbuild | Static binary, Alpine/containers |
| Linux ARM64 (musl) | `aarch64-unknown-linux-musl` | Tier 2 | cargo-zigbuild | Static ARM64, containers |
| OpenBSD x86_64 | `x86_64-unknown-openbsd` | Tier 3 | Native build only | No cross-image available |

**OpenBSD is Tier 3** — Rust project does not build or test it automatically. `rustup target add` works but std may have bugs. No Docker cross-image from cross-rs. Must build natively or via zig (experimental).

## 2. Release Profile Optimization

Industry-standard `[profile.release]` for Rust CLI tools:

```toml
[profile.release]
opt-level = 3               # max speed (use "s" for size-constrained)
lto = "thin"                # thin LTO — good speed/compile-time balance
codegen-units = 1           # max optimization (single codegen unit)
strip = "symbols"           # strip all symbols for smaller binary
panic = "abort"             # no unwinding — smaller binary, faster startup
```

**Size impact** (typical Rust CLI with these flags):
- Default release: ~15-30MB
- + thin LTO: -10-15%
- + codegen-units=1: -3-5%
- + strip symbols: -50-60%
- + panic=abort: -5-10%
- **Combined: ~5-12MB** (well under 20MB invariant)

**Startup impact:**
- `panic = "abort"` removes unwinding tables → faster startup
- `lto = "thin"` enables cross-crate inlining → faster hot paths
- `strip = "symbols"` removes symbol table → faster binary loading

## 3. Cross-Compilation Tools

### cargo-zigbuild
- Zig as universal cross-linker (no Docker needed)
- Supports all Tier 1/2 targets + FreeBSD/OpenBSD (experimental)
- `cargo zigbuild --release --target x86_64-unknown-linux-musl`
- Works with mlua vendored LuaJIT (C compiler via cc crate + zig cc)
- **Recommended for smith:** single tool builds all targets locally

### cross
- Docker containers with QEMU + cross toolchain
- No OpenBSD images
- Heavy (pulls Docker images)
- `cross build --target aarch64-unknown-linux-gnu`

### Recommendation
- **cargo-zigbuild** for all local cross-builds — one tool, all targets
- **Native build** for OpenBSD (Tier 3, no reliable cross support yet)
- No CI pipeline yet — deferred

## 4. Static Linking: glibc vs musl

| Approach | Binary Size | Portability | DNS/TLS | Use Case |
|----------|-------------|-------------|---------|----------|
| glibc (dynamic) | ~5-8MB | Glibc version compat | System resolver, OpenSSL | Desktop Linux |
| musl (static) | ~8-12MB | Fully portable | Built-in resolver, rustls | Containers, Alpine, portable |

**Recommendation:** Ship **both** for Linux. musl for containers/Alpine/portable, glibc for desktop. One extra build target.

## 5. Artifact Format

```
smith-v0.1.0/
├── smith-x86_64-pc-windows-msvc.zip
├── smith-aarch64-pc-windows-msvc.zip
├── smith-x86_64-apple-darwin.tar.gz
├── smith-aarch64-apple-darwin.tar.gz
├── smith-x86_64-unknown-linux-gnu.tar.gz
├── smith-aarch64-unknown-linux-gnu.tar.gz
├── smith-x86_64-unknown-linux-musl.tar.gz
├── smith-aarch64-unknown-linux-musl.tar.gz
├── smith-x86_64-unknown-openbsd.tar.gz
└── checksums-sha256.txt
```

## 6. Key Dependency: mlua + LuaJIT

`mlua` with `vendored` feature builds LuaJIT from C source. Critical for cross-compilation:
- **Works with all targets** (C compiler needed via cc crate)
- **zig provides C cross-compiler** — cargo-zigbuild handles this
- **cross Docker images** include C toolchain
- **macOS**: system clang works
- **Windows MSVC**: needs cl.exe (CI provides this). **Known limitation**: cargo-zigbuild cross-compiling to `*-windows-msvc` from Linux/macOS may lack Windows import libraries (`.lib` files) for some Win32 APIs. Mitigations: (1) build Windows targets on native Windows CI runners, (2) fall back to `*-windows-gnu` targets for cross-builds (zig has better MinGW support), or (3) ship Windows CI-built artifacts only.

### Android/Termux ARM64 linker note

P2d proved vendored LuaJIT can link on Android/Termux ARM64. The missing symbol
from the original failed static build was `__clear_cache`, provided by
compiler-rt builtins. Rust's linker path may need the Android compiler-rt
builtins library that clang normally adds automatically:

```toml
[target.aarch64-linux-android]
rustflags = ["-C", "link-args=-lclang_rt.builtins-aarch64-android"]
```

This keeps the preferred release path as `mlua` + `luajit` + `vendored` rather
than falling back to a non-JIT Lua runtime.

## 7. Key Dependency: syntastica

P16 verified `syntastica` with `runtime-c2rust` on Android/Termux. This avoids a
`libtree-sitter` C runtime and avoids `syntect`'s Oniguruma dependency. Release
builds should measure grammar-set size, but the dependency is Android-safe and
fits the v1 syntax-highlighting requirement.

## 8. OpenBSD Strategy

Options for Tier 3 target:
1. **cargo-zigbuild** — zig ships cross-linker for OpenBSD (experimental, may work)
2. **Native build** — build on actual OpenBSD VM/machine (most reliable)
3. **Best-effort** — document as "community supported, no CI"

**Recommendation:** Start with option 3 (best-effort). Add native OpenBSD CI runner if user demand warrants it.

## 9. Tool Matrix

| Tool | Scope | OpenBSD | Docker | Best For |
|------|-------|---------|--------|----------|
| cargo-zigbuild | Local cross-build | Maybe | No | One-machine builds, all targets |
| cross | Docker cross | No | Required | CI cross-testing |
| rustup | Native cross | Yes (Tier 3) | No | Simple same-OS cross |

## 10. References

- cargo-zigbuild: https://github.com/rust-cross/cargo-zigbuild
- cross: https://github.com/cross-rs/cross
- Rust Platform Support: https://doc.rust-lang.org/nightly/rustc/platform-support.html
- LuaJIT build: https://luajit.org/install.html
