#!/usr/bin/env bash
# Validation for the merge gate's label contract.
#
# Two things can silently break it. The label sets can drift between the shared
# source and the bootstrap fallbacks that adw-gate and adw-jam-detector carry for
# a base that predates the file — drift there is invisible until a PR is judged
# by the wrong rules. And the gate decision itself can invert on a label whose
# meaning changed, which is how `stalled` came to block the merge it diagnosed.
#
# Run: bash .github/adw/gate-labels.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

failures=0
check() {
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$3" "$2"
    failures=$((failures + 1))
  fi
}

. .github/adw/gate-labels.sh

# --- the gate decision, replicating adw-gate.yml's logic exactly -------------
gate() {
  local csv=",$1," held="" waiting="" b p
  for b in $BLOCKING_GATE_LABELS; do
    case "$csv" in *",$b,"*) held="$held $b";; esac
  done
  for p in $REQUIRED_GATE_LABELS; do
    case "$csv" in *",$p,"*) ;; *) waiting="$waiting $p";; esac
  done
  if [ -n "$held" ]; then echo "held"; return; fi
  if [ -n "$waiting" ]; then echo "waiting"; return; fi
  echo "green"
}

check "both verdicts, nothing else -> green" \
  "$(gate 'reviewed,security-cleared')" green
check "unrelated labels do not hold" \
  "$(gate 'reviewed,security-cleared,codex-reviewed,size:s')" green
# The regression this whole change exists for: the sweeper's diagnosis must not
# be the reason a finished PR cannot merge.
check "stalled does NOT hold a fully approved PR" \
  "$(gate 'reviewed,security-cleared,stalled')" green
check "missing security verdict waits" \
  "$(gate 'reviewed')" waiting
check "missing correctness verdict waits" \
  "$(gate 'security-cleared')" waiting
check "no labels at all waits" \
  "$(gate '')" waiting

for blocker in risk:high blocked changes-requested needs:info needs:spec needs:prototype; do
  check "$blocker holds even with both verdicts" \
    "$(gate "reviewed,security-cleared,$blocker")" held
done

# --- the bootstrap fallbacks must equal the shared source --------------------
# Both readers inline a copy for a base that lacks this file. A copy that drifts
# is worse than no copy: the gate would judge PRs by rules nobody edited.
fallback_of() {
  sed -n "s/^ *\(${2}\)=\"\(.*\)\"$/\2/p" "$1" | head -1
}
for wf in .github/workflows/adw-gate.yml .github/workflows/adw-jam-detector.yml; do
  check "$(basename "$wf") required fallback matches source" \
    "$(fallback_of "$wf" REQUIRED_GATE_LABELS)" "$REQUIRED_GATE_LABELS"
  check "$(basename "$wf") blocking fallback matches source" \
    "$(fallback_of "$wf" BLOCKING_GATE_LABELS)" "$BLOCKING_GATE_LABELS"
done

# --- the reviewers' verdict assertion ---------------------------------------
# Mirrors the accept/reject arms in adw-review.yml. The no-verdict case is #114:
# a job that returned success having applied nothing at all.
verdict() {
  case ",$1," in
    *",$2,"*|*",$3,"*) echo accept ;;
    *) echo reject ;;
  esac
}
check "reviewer accepts an approval"        "$(verdict 'reviewed,security-cleared' reviewed changes-requested)" accept
check "reviewer accepts a change-request"   "$(verdict 'changes-requested' reviewed changes-requested)" accept
check "reviewer rejects a silent no-op"     "$(verdict 'security-cleared' reviewed changes-requested)" reject
check "security accepts a clearance"        "$(verdict 'reviewed,security-cleared' security-cleared risk:high)" accept
check "security accepts an escalation"      "$(verdict 'risk:high' security-cleared risk:high)" accept
check "security rejects a silent no-op"     "$(verdict 'reviewed' security-cleared risk:high)" reject

if [ "$failures" -ne 0 ]; then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall checks passed\n'
