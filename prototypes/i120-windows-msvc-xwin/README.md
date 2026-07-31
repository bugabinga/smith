# i120 — Windows MSVC cross-build with `cargo-xwin` (SPEC §18)

One claim (issue #120): `cargo-xwin` cross-builds `x86_64-pc-windows-msvc` **and**
`aarch64-pc-windows-msvc` from one Linux host with LLVM/clang, **including
vendored LuaJIT via mlua**.

## Verdict: DISPROVED

- **The Rust + C(via `cc` crate) half works.** cargo-xwin cross-builds both MSVC
  triples to genuine MSVC-ABI PE binaries (`control/`).
- **The vendored-LuaJIT half does not.** `mlua { features=["luajit","vendored"] }`
  (the feature set locked in every other prototype / §2.3) fails to cross-build
  for *either* MSVC triple. `luajit-src` routes every `*-msvc` target to
  `build_msvc()`, which runs `luajit2/src/msvcbuild.bat` (a Windows `.bat`
  driving `cl`/`link`/`lib`) and resolves the compiler with
  `cc::windows_registry::find_tool(target, "cl.exe")`. On Linux that panics
  `failed to find cl`. The clang-cl toolchain cargo-xwin supplies is never
  consulted for LuaJIT — no LLVM/clang Linux host can satisfy this path.

So the claim, *as written* (one Linux host + LLVM/clang, vendored LuaJIT via
mlua), is contradicted. The contradiction is not a missing tool on this runner:
`cl.exe`/`msvcbuild.bat` are Windows-native and unavailable to *any* Linux host,
which is exactly what cargo-xwin is supposed to make unnecessary.

## Host prerequisites (all satisfiable on Linux)

- `clang` / `clang-cl`, `lld-link`, `llvm-lib`, `llvm-readobj` — apt: `clang lld llvm`.
- `cargo install cargo-xwin` (proven with 0.23.0).
- `rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc`.

## CRT / SDK acquisition

`cargo-xwin` downloads Microsoft's CRT + Windows SDK on first build into
`$XWIN_CACHE_DIR` (default `~/.cache/xwin`, ~1.1 GiB). Using it **accepts
Microsoft's licence** — an owner-approved condition of shipping Windows
artifacts (PROJECT-INVARIANTS §4). The cache carries both arches:
`xwin/crt/lib/{x86_64,aarch64}/vcruntime.lib`, plus the SDK `um`/`ucrt` libs. No
part of the failure is SDK acquisition — that half succeeds.

## Verify

```bash
cd prototypes/i120-windows-msvc-xwin
./verify.sh   # exits 0; PASS lines assert the split verdict
```

`verify.sh` (1) cross-builds `control/` for both triples and asserts each `.exe`
is the right machine type importing `VCRUNTIME140.dll` + `api-ms-win-crt-*` (MSVC
ABI, never mingw `msvcrt.dll`); (2) asserts the mlua build *fails* for both
triples inside `luajit-src` with `failed to find cl`; (3) asserts `msvcbuild.bat`
drives `cl`.

## Artifacts observed (MSVC-ABI PE, control crate)

| Triple | `file` | Machine | CRT imports |
|---|---|---|---|
| x86_64-pc-windows-msvc | PE32+ x86-64 | `IMAGE_FILE_MACHINE_AMD64` | `VCRUNTIME140.dll`, `api-ms-win-crt-*` |
| aarch64-pc-windows-msvc | PE32+ Aarch64 | `IMAGE_FILE_MACHINE_ARM64` | `VCRUNTIME140.dll`, `api-ms-win-crt-*` |

Neither imports `msvcrt.dll`/`libgcc` — the GNU ABI SPEC §14 forbids.

## What would need to change for the claim to hold

The blocker is `luajit-src`, not cargo-xwin. Candidate paths (each a spec/toolchain
decision, out of scope for this disposable proof — see the linked `needs:spec`):

- A `luajit-src` (mlua vendored) that builds LuaJIT for MSVC targets through
  clang-cl / the `cc` crate instead of `msvcbuild.bat` + registry `cl.exe`.
- Cross-compile LuaJIT via its GNU/`CROSS` makefile path to the MSVC ABI (LuaJIT
  upstream documents a mingw cross, not an lld-link/clang-cl MSVC cross).
- Build the Windows-MSVC artifacts on a native Windows runner (defeats "one
  Linux host") or a different Lua binding.
