#!/usr/bin/env bash
# Control linker wrapper: strip the spec-pinned builtins flag AND withhold the
# clang-rt search path, so the compiler-rt builtins are entirely absent from
# the link. If Bionic carried `__clear_cache` this would still succeed; it does
# not, so the link must fail with an undefined reference. That failure is the
# proof that the SPEC §3.2 flag is load-bearing, not decorative.
set -euo pipefail
: "${NDK_CLANG:?NDK_CLANG must point at the NDK aarch64 clang wrapper}"
args=()
for a in "$@"; do
  [[ "$a" == "-lclang_rt.builtins-aarch64-android" ]] && continue
  args+=("$a")
done
exec "$NDK_CLANG" "${args[@]}"
