# Single source of truth for the labels the merge gate reads.
#
# Sourced by adw-gate.yml (which decides mergeability) and adw-jam-detector.yml
# (which must predict the same decision to tell an expected red gate from a
# systemic one). These two agreed only by hand-copy until now; a divergence is
# silent in both directions — an unknown blocker reads every held PR as a jam,
# and an unknown verdict hides a real one.
#
# Both workflows read this from the BASE commit, never the PR head, so a PR
# cannot widen or narrow the gate that judges it.
#
# `stalled` is deliberately NOT blocking. It is the sweeper's diagnosis that a
# PR has stopped moving — a report, not a veto. Blocking on it made the sweeper's
# own label the reason the PR could not merge, and the next hourly sweep saw the
# same stuck PR and reapplied it. Anything that should genuinely hold a merge is
# in the blocking list below on its own merits.

REQUIRED_GATE_LABELS="reviewed security-cleared"
BLOCKING_GATE_LABELS="risk:high blocked changes-requested needs:info needs:spec needs:prototype"
