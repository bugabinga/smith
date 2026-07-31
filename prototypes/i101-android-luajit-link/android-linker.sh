#!/usr/bin/env bash
# Linker wrapper for aarch64-linux-android.
#
# Rust links with `-nodefaultlibs`, so the NDK clang driver does NOT add its
# compiler-rt resource directory to the linker search path. The normative
# `.cargo/config.toml` flag `-lclang_rt.builtins-aarch64-android` (SPEC §3.2)
# therefore cannot resolve on its own. This wrapper adds the search path that
# the NDK *does* ship the library in, then defers to the real NDK clang. The
# `-L` is the toolchain-supplied half; the `-l` is the spec-pinned half.
set -euo pipefail
: "${NDK_CLANG:?NDK_CLANG must point at the NDK aarch64 clang wrapper}"
: "${NDK_RTLIB_DIR:?NDK_RTLIB_DIR must point at the NDK clang-rt lib dir}"
exec "$NDK_CLANG" -L "$NDK_RTLIB_DIR" "$@"
