#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$CALLS"
printf '\n' >> "$CALLS"
if [[ $1 == issue && $2 == list ]]; then
  [[ " $* " == *' --label ready '* && $(<"$LABELS") == *ready* ]] && printf '1\n'
  [[ " $* " == *' --label fallback:claude '* && $(<"$LABELS") == *fallback:claude* ]] && printf '1\n'
  exit 0
fi
if [[ $1 == issue && $2 == view ]]; then
  printf 'OPEN\t%s\n' "$(<"$LABELS")"
  exit 0
fi
if [[ $1 == issue && $2 == edit ]]; then
  if [[ " $* " == *' --remove-label ready '* ]]; then sed -i 's/^ready,//;s/,ready,/,/;s/,ready$//' "$LABELS"; fi
  if [[ " $* " == *' --add-label fallback:claude '* ]]; then printf ',fallback:claude' >> "$LABELS"; fi
  if [[ " $* " == *' --add-label codex '* ]]; then printf ',codex' >> "$LABELS"; fi
  exit 0
fi
if [[ $1 == api && $2 == user ]]; then printf 'smith[bot]\n'; exit 0; fi
if [[ $1 == api && $2 == repos/*/comments ]]; then
  if [[ -n ${COMMENTS:-} ]]; then
    printf '%s\n' "$COMMENTS"
  else
    printf '%s\n' '[{"id":1,"user":{"login":"smith[bot]"},"body":"<!-- smith:claude-attempt/v1 issue=1 branch=claude/issue-1 head=abc outcome=failure -->"}]'
  fi
  exit 0
fi
if [[ $1 == api && $2 == repos/*/git/ref/* ]]; then printf 'abc\n'; exit 0; fi
if [[ $1 == api && $2 == repos/*/pulls ]]; then exit 0; fi
if [[ $1 == api && $2 == --method && $3 == GET && $4 == repos/*/pulls ]]; then
  [[ ${FAIL_PULLS:-0} == 1 ]] && exit 1
  exit 0
fi
if [[ $1 == api && $2 == --method && $3 == POST ]]; then printf '42\n'; exit 0; fi
if [[ $1 == api && $2 == --method && $3 == PATCH ]]; then exit 0; fi
printf 'unexpected gh call: %s\n' "$*" >&2
exit 1
GH
chmod +x "$tmp/bin/gh"

run() {
  : > "$tmp/calls"
  printf '%s' "$1" > "$tmp/labels"
  PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" LABELS="$tmp/labels" COMMENTS="${2:-}" GH_TOKEN=x REPO=owner/repo APP_LOGIN='smith[bot]' \
    bash "$root/.github/adw/reconcile-builder-routes.sh"
}

run ready
grep -Eq 'api --method POST repos/owner/repo/issues/1/comments' "$tmp/calls"
grep -Eq 'issue edit 1 --repo owner/repo --remove-label ready' "$tmp/calls"
grep -Eq 'issue edit 1 --repo owner/repo --add-label fallback:claude' "$tmp/calls"
grep -Eq 'api --method PATCH repos/owner/repo/issues/comments/42' "$tmp/calls"
grep -Eq 'issue edit 1 --repo owner/repo --add-label codex' "$tmp/calls"

run 'fallback:claude' '[{"id":1,"user":{"login":"smith[bot]"},"body":"<!-- smith:builder-route/v1 issue=1 id=123e4567-e89b-12d3-a456-426614174000 source=claude/issue-1 target=codex/issue-1 phase=armed -->"},{"id":2,"user":{"login":"smith[bot]"},"body":"unrelated App comment"}]'
grep -Eq 'issue edit 1 --repo owner/repo --add-label codex' "$tmp/calls"

run 'ready,blocked'
if grep -Eq 'issue edit|--method POST|--method PATCH' "$tmp/calls"; then
  echo 'FAIL held issue mutated' >&2
  exit 1
fi

printf ready > "$tmp/labels"
if PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" LABELS="$tmp/labels" FAIL_PULLS=1 GH_TOKEN=x REPO=owner/repo APP_LOGIN='smith[bot]' \
  bash "$root/.github/adw/reconcile-builder-routes.sh"; then
  echo 'FAIL pull lookup failure was ignored' >&2
  exit 1
fi
grep -q 'MAX_ISSUES -le 100' "$root/.github/adw/reconcile-builder-routes.sh"
grep -q 'headRepository' "$root/.github/adw/reconcile-builder-routes.sh"
grep -q 'closingIssuesReferences' "$root/.github/adw/reconcile-builder-routes.sh"
echo 'PASS reconcile builder routes'
