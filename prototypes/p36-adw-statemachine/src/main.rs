//! Human-readable report: explore the ADW state space under each config and
//! print what the checker proves. `cargo test` is the pass/fail gate; this is
//! the narrated evidence.

use p36_adw_statemachine::{Config, State, explore};

fn verdict(label: &str, cx: &Option<State>) {
    match cx {
        None => println!("    {label:<28} none reachable ✓"),
        Some(s) => println!(
            "    {label:<28} COUNTEREXAMPLE: head={} code_ok={} reviewed_head={} \
             risk_high={} blocked={}",
            s.head, s.code_ok, s.reviewed_head, s.risk_high, s.blocked
        ),
    }
}

fn run(name: &str, cfg: Config) {
    let r = explore(cfg);
    println!("\n[{name}] require_ci={} reset_on_push={}", cfg.require_ci, cfg.reset_on_push);
    println!("    reachable states           {}", r.states);
    verdict("merged broken code", &r.merged_broken);
    verdict("merged unreviewed head", &r.merged_unreviewed);
    verdict("merged while blocked/risky", &r.merged_while_blocked);
    println!(
        "    clean merge reachable      {} {}",
        r.clean_merge_reachable,
        if r.clean_merge_reachable { "✓" } else { "✗ DEADLOCK" }
    );
    println!("    escape valve reachable     {}", r.blocked_reachable);
}

fn main() {
    println!("ADW merge-gate + loops — bounded model check (MAX_HEAD=3)");
    run("FIXED  (as designed, post-#17)", Config::FIXED);
    run("NO_CI  (hole #17)", Config::NO_CI);
    run("NO_RESET (hole #3)", Config::NO_RESET);
    println!(
        "\nRead: FIXED has no unsafe merge and stays live; disabling either fix \
         surfaces the exact counterexample the audit predicted."
    );
}
