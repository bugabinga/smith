#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
MAX_ISSUES=${MAX_ISSUES:-100}
[[ $MAX_ISSUES =~ ^[1-9][0-9]*$ && $MAX_ISSUES -le 100 ]] || {
  echo "MAX_ISSUES must be 1..100" >&2
  exit 2
}

APP_LOGIN=$(gh api user -q .login)
OWNER=${REPO%%/*}
HOLDS='blocked|risk:high|needs:info|needs:spec|needs:prototype|needs:breakdown'

live() {
  gh issue view "$1" --repo "$REPO" --json state,labels \
    --jq '[.state, ([.labels[].name] | join(","))] | @tsv'
}

open_unheld() {
  local state labels
  IFS=$'\t' read -r state labels <<< "$(live "$1")"
  [[ $state == OPEN ]] && ! [[ ,$labels, =~ ,($HOLDS), ]]
}

has_label() {
  [[ ,$2, == *",$1,"* ]]
}

comments() {
  gh api "repos/$REPO/issues/$1/comments" --paginate | jq -s 'add'
}

branch_head() {
  gh api "repos/$REPO/git/ref/heads/$1" -q .object.sha 2>/dev/null || printf absent
}

qualifying_pr() {
  local issue=$1 branch=$2 number qualifies numbers
  numbers=$(gh api --method GET "repos/$REPO/pulls" -f state=open \
              -f "head=$OWNER:$branch" --jq '.[].number') || return 2
  while IFS= read -r number; do
    [[ -n $number ]] || continue
    qualifies=$(gh pr view "$number" --repo "$REPO" \
      --json baseRefName,headRepository,closingIssuesReferences \
      --jq --arg repo "$REPO" --argjson issue "$issue" \
      '.baseRefName == "main" and
       ((.headRepository.nameWithOwner // "") == $repo) and
       any(.closingIssuesReferences[]?;
           (.repository.nameWithOwner // "") == $repo and .number == $issue)') || return 2
    [[ $qualifies == true ]] && return 0
  done <<< "$numbers"
  return 1
}

route_record() {
  local issue=$1 rows id body marker best=0
  rows=$(comments "$issue" | jq -r --arg app "$APP_LOGIN" \
    '.[] | select(.user.login == $app) | [.id, (.body | gsub("[\n\r\t]"; " "))] | @tsv')
  while IFS=$'\t' read -r id body; do
    marker=$(grep -oE "<!-- smith:builder-route/v1 issue=$issue id=[0-9a-f-]{36} source=claude/issue-$issue target=codex/issue-$issue phase=(prepared|armed|completed|cancelled) -->" <<< "$body" || true)
    [[ -n $marker && $id -gt $best ]] || continue
    best=$id
    printf '%s\t%s\n' "$id" "$marker"
  done <<< "$rows" | sort -n | tail -1
}

has_attempt() {
  local issue=$1 head=$2 rows
  rows=$(comments "$issue" | jq -r --arg app "$APP_LOGIN" \
    '.[] | select(.user.login == $app) | .body')
  grep -Fqx "<!-- smith:claude-attempt/v1 issue=$issue branch=claude/issue-$issue head=$head outcome=failed -->" <<< "$rows" ||
    grep -E -qx "<!-- smith:claude-attempt/v1 issue=$issue branch=claude/issue-$issue head=$head outcome=[^ ]+ -->" <<< "$rows"
}

set_phase() {
  local id=$1 marker=$2 phase=$3
  gh api --method PATCH "repos/$REPO/issues/comments/$id" \
    -f "body=${marker/phase=*/phase=$phase -->}" >/dev/null
}

create_route() {
  local issue=$1 id marker
  id=$(cat /proc/sys/kernel/random/uuid)
  marker="<!-- smith:builder-route/v1 issue=$issue id=$id source=claude/issue-$issue target=codex/issue-$issue phase=prepared -->"
  id=$(gh api --method POST "repos/$REPO/issues/$issue/comments" -f "body=$marker" -q .id)
  printf '%s\t%s\n' "$id" "$marker"
}

refresh_or_pause() {
  open_unheld "$1"
}

transition_prepared() {
  local issue=$1 id=$2 marker=$3 labels
  refresh_or_pause "$issue" || return 0
  IFS=$'\t' read -r _ labels <<< "$(live "$issue")"
  if has_label ready "$labels"; then
    gh issue edit "$issue" --repo "$REPO" --remove-label ready >/dev/null
  fi
  refresh_or_pause "$issue" || return 0
  IFS=$'\t' read -r _ labels <<< "$(live "$issue")"
  if ! has_label fallback:claude "$labels"; then
    gh issue edit "$issue" --repo "$REPO" --add-label fallback:claude >/dev/null
  fi
  refresh_or_pause "$issue" || return 0
  set_phase "$id" "$marker" armed
  marker=${marker/phase=prepared/phase=armed}
  refresh_or_pause "$issue" || return 0
  IFS=$'\t' read -r _ labels <<< "$(live "$issue")"
  if ! has_label codex "$labels"; then
    gh issue edit "$issue" --repo "$REPO" --add-label codex >/dev/null
  fi
}

reconcile() {
  local issue=$1 state labels source target head record id marker phase
  IFS=$'\t' read -r state labels <<< "$(live "$issue")"
  [[ $state == OPEN ]] || return 0
  [[ ,$labels, =~ ,($HOLDS), ]] && return 0
  source="claude/issue-$issue"
  target="codex/issue-$issue"
  head=$(branch_head "$source")
  record=$(route_record "$issue")
  if [[ -n $record ]]; then
    IFS=$'\t' read -r id marker <<< "$record"
    phase=${marker##*phase=}
    phase=${phase% -->}
    if [[ $phase == armed ]]; then
      if qualifying_pr "$issue" "$target"; then
        set_phase "$id" "$marker" completed
        return 0
      elif [[ $? -ne 1 ]]; then
        return 1
      fi
    fi
    if [[ $phase == prepared ]]; then
      if qualifying_pr "$issue" "$source"; then
        set_phase "$id" "$marker" cancelled
        has_label fallback:claude "$labels" && gh issue edit "$issue" --repo "$REPO" --remove-label fallback:claude >/dev/null
        return 0
      elif [[ $? -ne 1 ]]; then
        return 1
      fi
    fi
    [[ $phase == prepared ]] && transition_prepared "$issue" "$id" "$marker"
    return 0
  fi
  has_label ready "$labels" || return 0
  has_attempt "$issue" "$head" || return 0
  if qualifying_pr "$issue" "$source"; then
    return 0
  elif [[ $? -ne 1 ]]; then
    return 1
  fi
  IFS=$'\t' read -r id marker <<< "$(create_route "$issue")"
  transition_prepared "$issue" "$id" "$marker"
}

issues=$(
  {
    gh issue list --repo "$REPO" --state open --label ready --limit "$MAX_ISSUES" --json number --jq '.[].number'
    gh issue list --repo "$REPO" --state open --label codex --label fallback:claude --limit "$MAX_ISSUES" --json number --jq '.[].number'
  } | sort -nu | head -n "$MAX_ISSUES"
)
while IFS= read -r issue; do
  [[ -n $issue ]] && reconcile "$issue"
done <<< "$issues"
