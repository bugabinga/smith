//! Explicit-state model checker for the smith Agentic Development Workflow.
//!
//! It models one work item's life as a PR flows through the ADW: pushes, CI,
//! the two label-driven review verdicts, the security escalation, the needs:spec
//! escape valve, and GitHub's native auto-merge released by the `merge-gate`.
//! Then it exhaustively explores every reachable state (bounded by a small push
//! count) and checks safety and liveness properties.
//!
//! The point is to *verify the plan*, and to prove the audit's holes are real:
//! toggling a fix off in [`Config`] makes the checker find a concrete
//! counterexample — merged-broken-code (no CI gate) or merged-unreviewed-code
//! (no stale-label reset).

// Report/State fields are read across the crate boundary by the `p36` binary and
// the tests; the lib alone doesn't read them all, so silence dead_code here.
#![allow(dead_code, missing_docs)]

use std::collections::{HashSet, VecDeque};

/// Bound on pushes (revisions). Keeps the state space finite; 3 is enough to
/// exercise a review → revise → re-review cycle and a stale-label window.
pub const MAX_HEAD: u8 = 3;

/// Which fixes are enabled. The audit's holes are exactly these toggles.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// The `main` ruleset requires a *fresh, green* CI check (issue #17).
    pub require_ci: bool,
    /// `adw-review` strips verdict labels on every push (issue #3), so a verdict
    /// only ever applies to the head it was earned on.
    pub reset_on_push: bool,
}

impl Config {
    /// The workflow as it should be once #17 lands: both fixes on.
    pub const FIXED: Config = Config { require_ci: true, reset_on_push: true };
    /// The hole from issue #17: labels gate the merge, nothing checks the build.
    pub const NO_CI: Config = Config { require_ci: false, reset_on_push: true };
    /// The hole from issue #3: a stale `reviewed` survives a new push.
    pub const NO_RESET: Config = Config { require_ci: true, reset_on_push: false };
}

/// `0` encodes "none"; `1..=MAX_HEAD` a concrete head. Kept as a byte so [`State`]
/// stays `Hash + Eq` and cheap to enumerate.
type Head = u8;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct State {
    pub opened: bool,
    pub head: Head,
    // — labels the merge-gate reads —
    pub reviewed: bool,
    pub security_cleared: bool,
    pub changes_requested: bool,
    pub risk_high: bool,
    pub blocked: bool, // needs:spec
    // — the CI check —
    pub ci_head: Head, // head CI last reported for (0 = none)
    pub ci_green: bool,
    pub merged: bool,
    // — ground truth, hidden from the gate; this is what the labels *claim* —
    pub code_ok: bool,       // does the current head actually build/pass?
    pub reviewed_head: Head, // head a reviewer actually inspected (0 = none)
}

impl State {
    fn initial() -> State {
        State {
            opened: false,
            head: 0,
            reviewed: false,
            security_cleared: false,
            changes_requested: false,
            risk_high: false,
            blocked: false,
            ci_head: 0,
            ci_green: false,
            merged: false,
            code_ok: false,
            reviewed_head: 0,
        }
    }

    /// The `merge-gate` predicate: exactly what `adw-gate.yml` + the ruleset
    /// require. Reads only labels and the CI check — never ground truth.
    pub fn gate_green(&self, cfg: Config) -> bool {
        self.opened
            && self.reviewed
            && self.security_cleared
            && !self.changes_requested
            && !self.risk_high
            && !self.blocked
            && (!cfg.require_ci || (self.ci_head == self.head && self.ci_green))
    }

    /// All states reachable in one step, applying each enabled ADW event.
    fn successors(&self, cfg: Config) -> Vec<State> {
        let mut out = Vec::new();
        if self.merged {
            return out; // terminal
        }
        if !self.opened {
            // builder opens the PR at head 1; its code may or may not be correct.
            for code_ok in [true, false] {
                let mut s = self.clone();
                s.opened = true;
                s.head = 1;
                s.code_ok = code_ok;
                out.push(s);
            }
            return out;
        }

        // builder revises (push): new head, possibly different code quality.
        if self.head < MAX_HEAD {
            for code_ok in [true, false] {
                let mut s = self.clone();
                s.head += 1;
                s.code_ok = code_ok;
                // a push invalidates CI (ci_head now trails head) and, with the
                // fix, strips the stale verdict labels.
                if cfg.reset_on_push {
                    s.reviewed = false;
                    s.security_cleared = false;
                    s.changes_requested = false;
                }
                out.push(s);
            }
        }

        // CI reports for the current head (green iff the code is actually ok).
        if self.ci_head != self.head {
            let mut s = self.clone();
            s.ci_head = self.head;
            s.ci_green = self.code_ok;
            out.push(s);
        }

        // reviewer approves — an LLM verdict, independent of ground truth.
        {
            let mut s = self.clone();
            s.reviewed = true;
            s.reviewed_head = self.head;
            s.changes_requested = false;
            out.push(s);
        }
        // reviewer requests changes.
        {
            let mut s = self.clone();
            s.changes_requested = true;
            s.reviewed = false;
            out.push(s);
        }
        // security clears.
        {
            let mut s = self.clone();
            s.security_cleared = true;
            out.push(s);
        }
        // security escalates.
        {
            let mut s = self.clone();
            s.risk_high = true;
            s.security_cleared = false;
            out.push(s);
        }
        // any agent raises the escape valve (needs:spec).
        {
            let mut s = self.clone();
            s.blocked = true;
            out.push(s);
        }
        // owner resolves the spec question / clears risk.
        {
            let mut s = self.clone();
            s.blocked = false;
            out.push(s);
        }
        {
            let mut s = self.clone();
            s.risk_high = false;
            out.push(s);
        }

        // native auto-merge fires the instant the gate is green.
        if self.gate_green(cfg) {
            let mut s = self.clone();
            s.merged = true;
            out.push(s);
        }

        out
    }
}

/// Result of exhaustively exploring the ADW state space under one [`Config`].
#[derive(Debug)]
pub struct Report {
    pub states: usize,
    /// A reachable state that merged **broken** code (`merged && !code_ok`).
    pub merged_broken: Option<State>,
    /// A reachable state that merged code whose current head was never reviewed.
    pub merged_unreviewed: Option<State>,
    /// A reachable state that merged while a blocking label was set.
    pub merged_while_blocked: Option<State>,
    /// Liveness: some reachable state reached a clean merge.
    pub clean_merge_reachable: bool,
    /// Escape valve works: `blocked` is reachable, and never co-occurs with merge.
    pub blocked_reachable: bool,
}

/// Breadth-first exploration of every reachable state, checking the invariants.
pub fn explore(cfg: Config) -> Report {
    let mut seen: HashSet<State> = HashSet::new();
    let mut queue: VecDeque<State> = VecDeque::new();
    let start = State::initial();
    seen.insert(start.clone());
    queue.push_back(start);

    let mut report = Report {
        states: 0,
        merged_broken: None,
        merged_unreviewed: None,
        merged_while_blocked: None,
        clean_merge_reachable: false,
        blocked_reachable: false,
    };

    while let Some(s) = queue.pop_front() {
        if s.blocked {
            report.blocked_reachable = true;
        }
        if s.merged {
            if !s.code_ok && report.merged_broken.is_none() {
                report.merged_broken = Some(s.clone());
            }
            if s.reviewed_head != s.head && report.merged_unreviewed.is_none() {
                report.merged_unreviewed = Some(s.clone());
            }
            if (s.blocked || s.risk_high || s.changes_requested)
                && report.merged_while_blocked.is_none()
            {
                report.merged_while_blocked = Some(s.clone());
            }
            if s.code_ok && s.reviewed_head == s.head && !s.blocked && !s.risk_high {
                report.clean_merge_reachable = true;
            }
        }
        for next in s.successors(cfg) {
            if seen.insert(next.clone()) {
                queue.push_back(next);
            }
        }
    }

    report.states = seen.len();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With both fixes on, the merge-gate is sound and the cycle is live.
    #[test]
    fn fixed_config_is_safe_and_live() {
        let r = explore(Config::FIXED);
        assert!(r.states > 0);
        // safety: no reachable state merges broken, unreviewed, or blocked code.
        assert!(r.merged_broken.is_none(), "merged broken code: {:?}", r.merged_broken);
        assert!(
            r.merged_unreviewed.is_none(),
            "merged an unreviewed head: {:?}",
            r.merged_unreviewed
        );
        assert!(
            r.merged_while_blocked.is_none(),
            "merged while blocked/risky/changes-requested: {:?}",
            r.merged_while_blocked
        );
        // liveness: a clean merge is still reachable (the gate isn't a deadlock),
        // and the escape valve can actually engage.
        assert!(r.clean_merge_reachable, "no clean merge reachable — gate deadlocks");
        assert!(r.blocked_reachable, "needs:spec never reachable");
    }

    /// Issue #17: without a required CI check, the gate merges broken code — the
    /// checker must find that counterexample, proving the hole is real.
    #[test]
    fn no_ci_gate_merges_broken_code() {
        let r = explore(Config::NO_CI);
        let cx = r.merged_broken.expect("expected a merged-broken-code counterexample");
        assert!(cx.merged && !cx.code_ok);
    }

    /// Issue #3: without stripping stale verdict labels on push, the gate merges
    /// a head no reviewer looked at.
    #[test]
    fn stale_labels_merge_unreviewed_head() {
        let r = explore(Config::NO_RESET);
        let cx = r
            .merged_unreviewed
            .expect("expected a merged-unreviewed-head counterexample");
        assert!(cx.merged && cx.reviewed_head != cx.head);
    }

    /// A blocking label and a merge can never co-occur under any config — the
    /// gate structurally forbids it regardless of the fix toggles.
    #[test]
    fn blocking_labels_never_merge() {
        for cfg in [Config::FIXED, Config::NO_CI, Config::NO_RESET] {
            let r = explore(cfg);
            assert!(
                r.merged_while_blocked.is_none(),
                "{cfg:?}: merged with a blocking label set"
            );
        }
    }
}

