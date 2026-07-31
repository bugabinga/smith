#!/usr/bin/env bash
# Verify the SPEC §14 Android artifact claim: the workspace's Android target
# (`aarch64-linux-android`) cross-compiles with vendored mlua+LuaJIT and links
# into a valid Android aarch64 executable, and the SPEC §3.2 flag
# `-lclang_rt.builtins-aarch64-android` (pinned in the repo-root
# `.cargo/config.toml`) is load-bearing — the link fails without it.
#
# Exits 0 with PASS lines only when every check holds.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- Resolve the NDK toolchain (record what supplies the builtins) ----------
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK:-}}}"
[[ -n "$NDK" && -d "$NDK" ]] || fail "no Android NDK (set ANDROID_NDK_HOME)"
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
# Pick the lowest installed API clang wrapper — API level is irrelevant to the
# link claim, so take whatever the NDK ships.
NDK_CLANG=$(ls "$BIN"/aarch64-linux-android[0-9]*-clang 2>/dev/null | sort -V | head -1)
[[ -x "$NDK_CLANG" ]] || fail "no aarch64-linux-android*-clang in $BIN"
RTLIB=$(find "$NDK" -name 'libclang_rt.builtins-aarch64-android.a' 2>/dev/null | head -1)
[[ -f "$RTLIB" ]] || fail "NDK ships no libclang_rt.builtins-aarch64-android.a"
NDK_RTLIB_DIR=$(dirname "$RTLIB")

echo "PASS: NDK $(basename "$NDK") supplies $(basename "$RTLIB") ($NDK_RTLIB_DIR)"

export PATH="$BIN:$PATH"
export NDK_CLANG NDK_RTLIB_DIR
export CC_aarch64_linux_android="$NDK_CLANG"
export AR_aarch64_linux_android="$BIN/llvm-ar"
export TARGET_AR="$BIN/llvm-ar rcus"   # luajit-src mis-detects the archiver
NM="$BIN/llvm-nm"

# --- Positive: flag + toolchain search path => a real Android artifact ------
rm -rf target target-control
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$PWD/android-linker.sh" \
  cargo build --release --target aarch64-linux-android \
  || fail "cross-build with the §3.2 flag did not link"

BINOUT="target/aarch64-linux-android/release/i101-android-luajit-link"
file "$BINOUT" | grep -q 'ELF 64-bit LSB.*ARM aarch64' \
  || fail "artifact is not an ARM aarch64 ELF"
file "$BINOUT" | grep -q 'interpreter /system/bin/linker64' \
  || fail "artifact is not an Android (linker64) binary"
echo "PASS: linked $(file -b "$BINOUT" | cut -d, -f1-3)"

# Capture the symbol table once (grep -q on the live pipe would SIGPIPE nm and
# trip pipefail).
SYMS=$("$NM" "$BINOUT")
grep -qiE '(t|T) __clear_cache$' <<<"$SYMS" \
  || fail "__clear_cache (the compiler-rt builtin) is not in the artifact"
echo "PASS: __clear_cache resolved from libclang_rt.builtins (the §3.2 flag)"

grep -q 'T luaL_newstate' <<<"$SYMS" || fail "LuaJIT (luaL_newstate) not linked in"
grep -q 'T lua_pcall' <<<"$SYMS" || fail "LuaJIT (lua_pcall) missing"
echo "PASS: vendored LuaJIT is linked in (luaL_newstate, lua_pcall present)"

# --- Control: strip the flag + withhold builtins => must fail ---------------
if CARGO_TARGET_DIR=target-control \
   CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$PWD/android-linker-nobuiltins.sh" \
   cargo build --release --target aarch64-linux-android 2>control.log; then
  fail "control linked without the builtins — flag is NOT load-bearing"
fi
grep -q 'undefined symbol: __clear_cache' control.log \
  || fail "control failed for the wrong reason (expected undefined __clear_cache)"
echo "PASS: without the §3.2 flag the link fails (undefined __clear_cache)"

rm -f control.log
echo "ALL PASS"
