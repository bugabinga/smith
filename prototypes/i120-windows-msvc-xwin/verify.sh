#!/usr/bin/env bash
# Verify the issue-#120 claim: does `cargo-xwin` cross-build BOTH Windows MSVC
# triples from one Linux host with LLVM/clang, *including vendored LuaJIT via
# mlua*? This script proves the answer is NO for the LuaJIT half and YES for the
# rest, so every PASS line below asserts a piece of that split verdict. It exits
# 0 when the evidence matches the recorded disproof.
#
# Prerequisites (host, one-time): clang/clang-cl, lld-link, llvm-lib, llvm-readobj
# (apt: clang lld llvm), `cargo install cargo-xwin`, and
# `rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc`.
# cargo-xwin downloads Microsoft's CRT + Windows SDK on first build (accepting
# Microsoft's licence, an owner-approved condition — PROJECT-INVARIANTS §4).
set -uo pipefail
cd "$(dirname "$0")"
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$HOME/.cache/xwin}"

fail() { echo "FAIL: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing prerequisite: $1"; }

# clang-cl may only exist as a versioned binary; expose it under the bare name.
if ! command -v clang-cl >/dev/null 2>&1; then
  cc="$(command -v clang-cl-18 || command -v clang-cl-17 || true)"
  [ -n "$cc" ] && ln -sf "$cc" "$(dirname "$cc")/clang-cl" 2>/dev/null || true
fi
for t in cargo clang-cl lld-link llvm-lib llvm-readobj cargo-xwin; do need "$t"; done
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc >/dev/null 2>&1

TARGETS="x86_64-pc-windows-msvc aarch64-pc-windows-msvc"

# 1. CONTROL: Rust + a cc-crate C dependency must cross-build to MSVC-ABI for
#    both triples. This proves the cargo-xwin toolchain itself is capable, so the
#    LuaJIT failure below cannot be blamed on the host or on cargo-xwin.
for tgt in $TARGETS; do
  ( cd control && cargo xwin build --release --target "$tgt" ) \
    || fail "control failed to cross-build for $tgt (toolchain broken, not the claim)"
  exe="control/target/$tgt/release/i120-control.exe"
  [ -f "$exe" ] || fail "no control artifact for $tgt"

  case "$tgt" in
    x86_64-*) want_machine="IMAGE_FILE_MACHINE_AMD64" ;;
    aarch64-*) want_machine="IMAGE_FILE_MACHINE_ARM64" ;;
  esac
  llvm-readobj --file-headers "$exe" | grep -q "$want_machine" \
    || fail "$exe is not $want_machine"
  # MSVC ABI: imports the MSVC/UCRT runtime, never mingw's msvcrt.dll + libgcc.
  imports="$(llvm-readobj --coff-imports "$exe")"
  echo "$imports" | grep -qi "VCRUNTIME140.dll" || fail "$exe does not import VCRUNTIME140 (not MSVC ABI)"
  echo "$imports" | grep -qi "api-ms-win-crt" || fail "$exe does not import the UCRT (not MSVC ABI)"
  echo "$imports" | grep -qi "^\s*Name: msvcrt.dll" && fail "$exe imports mingw msvcrt.dll (GNU ABI, forbidden by SPEC §14)"
  echo "PASS: cargo-xwin cross-built MSVC-ABI $want_machine PE (Rust + cc-crate C) for $tgt"
done

# 2. CLAIM UNDER TEST: the exact locked feature set (mlua luajit+vendored) must
#    FAIL to cross-build, and fail specifically inside luajit-src looking for
#    cl.exe — proving the vendored-LuaJIT half of the claim is false.
log="$(mktemp)"
if ( cargo xwin build --release --target x86_64-pc-windows-msvc ) >"$log" 2>&1; then
  cat "$log"; fail "mlua vendored LuaJIT unexpectedly cross-built — claim may now hold; re-evaluate"
fi
grep -q "luajit-src" "$log" || { cat "$log"; fail "build failed, but not in luajit-src as expected"; }
grep -qi "failed to find cl" "$log" || { cat "$log"; fail "luajit-src failed, but not on the missing cl.exe as expected"; }
echo "PASS: mlua vendored LuaJIT cross-build FAILS in luajit-src build_msvc (\"failed to find cl\") for x86_64-pc-windows-msvc"

# 3. ROOT CAUSE: luajit-src routes every *-msvc target to msvcbuild.bat, a Windows
#    batch file driving cl/link/lib — a path no Linux LLVM/clang host can satisfy.
bat="$(find "$HOME/.cargo/registry/src" -path '*luajit2/src/msvcbuild.bat' 2>/dev/null | head -1)"
[ -n "$bat" ] || fail "could not locate luajit-src msvcbuild.bat to confirm root cause"
grep -qiE 'set LJCOMPILE=cl ' "$bat" || fail "msvcbuild.bat does not drive cl as expected"
echo "PASS: root cause confirmed — luajit-src build_msvc shells msvcbuild.bat (cl/link/lib), ignoring clang-cl"

echo
echo "VERDICT: DISPROVED — cargo-xwin cross-builds MSVC-ABI Rust+C for both triples,"
echo "but NOT mlua's vendored LuaJIT: luajit-src demands Windows-native cl.exe/msvcbuild.bat."
