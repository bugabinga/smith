#!/usr/bin/env bash
set -euo pipefail

if test -x /usr/bin/git; then
  git_path=/usr/bin/git
else
  git_path=$(command -v git)
fi
readonly git_path
readonly -a hardened_git=(
  "$git_path"
  -c core.hooksPath=/dev/null
  -c credential.helper=
  -c protocol.file.allow=never
  -c core.fsmonitor=false
)
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
export GIT_NO_REPLACE_OBJECTS=1

root=$(mktemp -d)
readonly root
trap 'rm -rf "$root"' EXIT
readonly checkout="$root/checkout"

"${hardened_git[@]}" init -q -b main "$checkout"
"${hardened_git[@]}" -C "$checkout" config user.name artifact-simulation
"${hardened_git[@]}" -C "$checkout" config user.email artifact-simulation@example.invalid
printf 'immutable target\n' > "$checkout/target.txt"
"${hardened_git[@]}" -C "$checkout" add target.txt
"${hardened_git[@]}" -C "$checkout" commit -q -m target
target_sha=$("${hardened_git[@]}" -C "$checkout" rev-parse HEAD)
readonly target_sha
"${hardened_git[@]}" -C "$checkout" pack-refs --all --prune
test -f "$checkout/.git/packed-refs"
test -z "$(find "$checkout/.git/refs" -type f -print -quit)"

archive_files() (
  cd "$1"
  find . \( -type f -o -type l \) -print0 |
    LC_ALL=C sort -z |
    tar --null --files-from=- -cf "$2"
)

archive_files "$checkout" "$root/packed-only.tar"
mkdir "$root/packed-only"
tar -C "$root/packed-only" -xf "$root/packed-only.tar"
test ! -e "$root/packed-only/.git/refs"
if "${hardened_git[@]}" -C "$root/packed-only" rev-parse --verify HEAD >/dev/null 2>&1; then
  printf 'packed-only artifact unexpectedly remained a repository\n' >&2
  exit 1
fi
printf 'packed-only artifact: not-a-repository\n'

"${hardened_git[@]}" -C "$checkout" update-ref --no-deref refs/heads/adw-target "$target_sha"
test "$("${hardened_git[@]}" -C "$checkout" rev-parse --verify 'refs/heads/adw-target^{commit}')" = "$target_sha"
archive_files "$checkout" "$root/transport-ref.tar"
mkdir "$root/transport-ref"
tar -C "$root/transport-ref" -xf "$root/transport-ref.tar"
test "$("${hardened_git[@]}" -C "$root/transport-ref" rev-parse --verify 'refs/heads/adw-target^{commit}')" = "$target_sha"
printf 'transport-ref artifact: verified\n'
