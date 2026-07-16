//! p18-model-resolver
//!
//! Proves or disproves docs/SPEC.md §5.7 (+§7.5, §6.9) claims:
//! - pure resolution: requested name → alias → group → bucket/account →
//!   provider/model metadata; no I/O by construction,
//! - cycles detected at config load with the full path; DAGs allowed,
//! - failover strategies ordered/round-robin hand Mux a deterministic
//!   attempt order; bucket account rotation composes with group failover,
//! - §6.9 `compaction_model` resolves through the same graph,
//! - Mux failover keyed by ProviderError kinds (§7.5).
//!
//! Round-robin is stateful; the resolver is pure. The split under test:
//! the resolver takes rotation cursors as an INPUT and reports which nodes
//! rotated; the mock Mux owns the cursors and advances them after each
//! request. See src/resolver.rs header for the full rule list.
//!
//! Verify: `cargo run -- resolve|cycles|failover-order|all` (exit 0 each).

mod resolver;

use resolver::{
    Candidate, Config, Cursors, LoadError, Resolution, Resolver,
};
use serde_json::{json, Value};

fn check(label: &str, ok: bool) -> bool {
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    ok
}

fn check_eq<T: PartialEq + std::fmt::Debug + ?Sized>(label: &str, got: &T, want: &T) -> bool {
    let ok = got == want;
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        println!("  want: {want:?}");
        println!("  got:  {got:?}");
    }
    ok
}

// ---- config builders ----

fn md(context_window: u64, thinking: bool) -> Value {
    json!({
        "context_window": context_window,
        "max_output_tokens": 8192,
        "input_cost_per_mtok": 3.0,
        "output_cost_per_mtok": 15.0,
        "thinking": thinking,
        "vision": true,
        "tool_use": true,
        "streaming": true,
    })
}

fn model(provider: &str, id: &str, context_window: u64, thinking: bool) -> Value {
    json!({ "provider": provider, "model": id, "metadata": md(context_window, thinking) })
}

fn load(v: Value) -> Result<Resolver, LoadError> {
    Resolver::load(serde_json::from_value::<Config>(v).expect("config deserializes"))
}

/// Base graph: alias→alias→group→{bucket,model}; two aliases share the group.
///
///   fast ──► default ──► main ──► anthro-bucket (rr: acct-1, acct-2) ──► claude-sonnet-4
///   smart ─────────────► main ──► gpt-4o
fn base_config() -> Value {
    json!({
        "aliases": { "fast": "default", "default": "main", "smart": "main" },
        "groups": { "main": { "strategy": "ordered", "members": ["anthro-bucket", "gpt-4o"] } },
        "buckets": { "anthro-bucket": {
            "model": "claude-sonnet-4", "strategy": "round-robin",
            "accounts": ["acct-1", "acct-2"] } },
        "models": {
            "claude-sonnet-4": model("anthropic", "claude-sonnet-4", 200000, true),
            "gpt-4o": model("openai", "gpt-4o", 128000, false),
        },
    })
}

fn labels(r: &Resolution) -> Vec<String> {
    r.candidates.iter().map(Candidate::label).collect()
}

// ---- mock Mux (SPEC §7.5): owns rotation state + failover behavior ----

#[derive(Debug, Clone, Copy, PartialEq)]
enum ProviderErrorKind {
    RateLimit,
    AuthFailed,
    Network,
    ServerError,
    InvalidRequest,
    ModelNotFound,
    Timeout,
}

struct MockMux {
    /// Round-robin state lives HERE, outside the pure resolver.
    cursors: Cursors,
    /// §7.5 "retry configured count then failover" for AuthFailed/Network/ServerError.
    retry_count: u32,
}

impl MockMux {
    fn new() -> Self {
        MockMux { cursors: Cursors::new(), retry_count: 2 }
    }

    /// One logical provider request: resolve a plan against the current
    /// cursors, advance the cursors of every rotation node the plan used,
    /// then walk candidates with §7.5 retry/failover semantics.
    /// Returns (attempt log, outcome).
    fn request(
        &mut self,
        resolver: &Resolver,
        name: &str,
        behave: &dyn Fn(&Candidate) -> Result<String, ProviderErrorKind>,
    ) -> (Vec<String>, Result<String, String>) {
        let plan = resolver.resolve(name, &self.cursors).expect("resolve");
        for node in &plan.rotation_nodes {
            *self.cursors.entry(node.clone()).or_insert(0) += 1;
        }
        let mut attempts = Vec::new();
        for cand in &plan.candidates {
            let mut tries = 0u32;
            loop {
                attempts.push(cand.label());
                tries += 1;
                match behave(cand) {
                    Ok(text) => return (attempts, Ok(text)),
                    Err(kind) => {
                        let extra_retries = match kind {
                            // §7.5: immediate failover, no retry.
                            ProviderErrorKind::RateLimit
                            | ProviderErrorKind::InvalidRequest
                            | ProviderErrorKind::ModelNotFound => 0,
                            // §7.5: retry once then failover.
                            ProviderErrorKind::Timeout => 1,
                            // §7.5: retry configured count then failover.
                            ProviderErrorKind::AuthFailed
                            | ProviderErrorKind::Network
                            | ProviderErrorKind::ServerError => self.retry_count,
                        };
                        if tries > extra_retries {
                            break; // failover to next candidate
                        }
                    }
                }
            }
        }
        (attempts, Err("providers exhausted -> ProviderEvent::Error".into()))
    }
}

// ---- scenarios ----

fn scenario_resolve() -> bool {
    let mut ok = true;
    let resolver = match load(base_config()) {
        Ok(r) => r,
        Err(e) => {
            ok &= check(&format!("resolve: base config loads ({e})"), false);
            return ok;
        }
    };
    ok &= check("resolve: base config (alias->alias->group->bucket/model DAG) loads", true);

    let cursors = Cursors::new();
    let r = resolver.resolve("fast", &cursors).expect("fast resolves");
    ok &= check_eq(
        "resolve: multi-hop fast->default->main->bucket/model flattens in order",
        &labels(&r)[..],
        &[
            "claude-sonnet-4@acct-1".to_string(),
            "claude-sonnet-4@acct-2".to_string(),
            "gpt-4o".to_string(),
        ][..],
    );
    let c0 = &r.candidates[0];
    ok &= check(
        "resolve: ResolvedModel carries metadata (provider=anthropic, ctx=200000, thinking)",
        c0.provider == "anthropic" && c0.metadata.context_window == 200000 && c0.metadata.thinking,
    );

    let r_smart = resolver.resolve("smart", &cursors).expect("smart resolves");
    ok &= check(
        "resolve: DAG sharing — 'smart' and 'fast' reach the same group, identical plan",
        r_smart.candidates == r.candidates,
    );

    // §6.9: compaction_model is just a config key holding a name; it goes
    // through the same graph. Here it is set to the alias "fast".
    let compaction_model = "fast";
    let r_comp = resolver.resolve(compaction_model, &cursors).expect("compaction resolves");
    ok &= check(
        "resolve: compaction_model (§6.9) = 'fast' resolves through the same alias graph",
        r_comp.candidates == r.candidates,
    );

    let r_again = resolver.resolve("fast", &cursors).expect("fast resolves again");
    ok &= check(
        "resolve: deterministic — same request + same cursors twice = identical Resolution",
        r_again == r,
    );

    ok &= check_eq(
        "resolve: unknown name is the only resolve-time error (all else load-time)",
        &resolver.resolve("ghost", &cursors).unwrap_err(),
        &resolver::ResolveError::UnknownName("ghost".into()),
    );

    // Purity by construction: the resolver module never imports I/O.
    // Scan resolver.rs source with comments stripped (the header comment
    // documents the banned names, which is not a violation).
    let src: String = include_str!("resolver.rs")
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let banned = ["std::fs", "std::net", "std::io", "std::process", "std::env", "std::time"];
    let clean = banned.iter().all(|b| !src.contains(b));
    ok &= check(
        "resolve: purity by construction — resolver.rs code contains no fs/net/io/process/env/time",
        clean,
    );
    ok
}

fn scenario_cycles() -> bool {
    let mut ok = true;

    // alias -> alias cycle.
    let err = load(json!({ "aliases": { "a": "b", "b": "a" } })).unwrap_err();
    ok &= check_eq(
        "cycles: alias cycle detected AT LOAD with full path",
        err.to_string().as_str(),
        "cycle detected at config load: a -> b -> a",
    );

    // group containing itself transitively (g1 -> g2 -> g1).
    let err = load(json!({
        "groups": {
            "g1": { "strategy": "ordered", "members": ["g2", "m"] },
            "g2": { "strategy": "ordered", "members": ["g1"] },
        },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: group transitively containing itself detected AT LOAD with full path",
        err.to_string().as_str(),
        "cycle detected at config load: g1 -> g2 -> g1",
    );

    // mixed alias -> group -> alias cycle.
    let err = load(json!({
        "aliases": { "x": "gx" },
        "groups": { "gx": { "strategy": "ordered", "members": ["x", "m"] } },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: mixed alias->group->alias cycle detected with full path",
        err.to_string().as_str(),
        "cycle detected at config load: x -> gx -> x",
    );

    // DAG sharing must NOT false-positive: two aliases reach 'shared', and
    // 'top' reaches 'shared' twice via both aliases (diamond).
    let dag = load(json!({
        "aliases": { "a1": "shared", "a2": "shared" },
        "groups": {
            "top": { "strategy": "ordered", "members": ["a1", "a2"] },
            "shared": { "strategy": "ordered", "members": ["m"] },
        },
        "models": { "m": model("p", "m", 1000, false) },
    }));
    ok &= check("cycles: diamond DAG (shared node reached twice) loads without false cycle", dag.is_ok());
    if let Ok(resolver) = dag {
        let r = resolver.resolve("top", &Cursors::new()).expect("top resolves");
        ok &= check_eq(
            "cycles: DAG flatten preserves both paths (duplicate candidate 'm' kept, not deduped)",
            &labels(&r)[..],
            &["m".to_string(), "m".to_string()][..],
        );
    }

    // ---- load-time edge rules §5.7 is silent on ----

    // (a) shadowing: same name as alias AND group.
    let err = load(json!({
        "aliases": { "dual": "m" },
        "groups": { "dual": { "strategy": "ordered", "members": ["m"] } },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: (edge a) name shadowing across kinds rejected at load, kinds named",
        err.to_string().as_str(),
        "name 'dual' defined as more than one kind: alias, group (shadowing rejected at load)",
    );

    // (b) empty group: load error, not resolve-time.
    let err = load(json!({ "groups": { "e": { "strategy": "ordered", "members": [] } } }))
        .unwrap_err();
    ok &= check_eq(
        "cycles: (edge b) empty group rejected at load",
        err.to_string().as_str(),
        "group 'e' has no members (rejected at load)",
    );

    // (c) group member that doesn't exist: load-time validation.
    let err = load(json!({ "groups": { "g": { "strategy": "ordered", "members": ["ghost"] } } }))
        .unwrap_err();
    ok &= check_eq(
        "cycles: (edge c) missing group member rejected at load with referrer",
        err.to_string().as_str(),
        "group 'g' references unknown name 'ghost'",
    );
    let err = load(json!({ "aliases": { "a": "ghost" } })).unwrap_err();
    ok &= check_eq(
        "cycles: (edge c) dangling alias target rejected at load with referrer",
        err.to_string().as_str(),
        "alias 'a' references unknown name 'ghost'",
    );

    // (d) duplicate names within one group list: rejected (ambiguous).
    let err = load(json!({
        "groups": { "g": { "strategy": "ordered", "members": ["m", "m"] } },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: (edge d) duplicate member in one group rejected at load",
        err.to_string().as_str(),
        "group 'g' lists member 'm' more than once (rejected at load)",
    );

    // empty bucket accounts + bucket pointing at a non-model: also load errors.
    let err = load(json!({
        "buckets": { "b": { "model": "m", "strategy": "round-robin", "accounts": [] } },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: empty bucket account list rejected at load",
        err.to_string().as_str(),
        "bucket 'b' has no accounts (rejected at load)",
    );
    let err = load(json!({
        "aliases": { "al": "m" },
        "buckets": { "b": { "model": "al", "strategy": "round-robin", "accounts": ["a1"] } },
        "models": { "m": model("p", "m", 1000, false) },
    }))
    .unwrap_err();
    ok &= check_eq(
        "cycles: bucket must reference a concrete model, alias target rejected at load",
        err.to_string().as_str(),
        "bucket 'b' must reference a concrete model, 'al' is not one",
    );

    ok
}

fn failover_config() -> Value {
    json!({
        "groups": {
            "ord3": { "strategy": "ordered", "members": ["m1", "m2", "m3"] },
            "rr3": { "strategy": "round-robin", "members": ["m1", "m2", "m3"] },
            "combo": { "strategy": "ordered", "members": ["bkt", "m2"] },
            "combo-sticky": { "strategy": "ordered", "members": ["sbkt", "m2"] },
        },
        "buckets": {
            "bkt": { "model": "m1", "strategy": "round-robin", "accounts": ["a1", "a2"] },
            "sbkt": { "model": "m1", "strategy": "sticky", "accounts": ["a1", "a2"] },
        },
        "models": {
            "m1": model("p1", "m1", 1000, false),
            "m2": model("p2", "m2", 1000, false),
            "m3": model("p3", "m3", 1000, false),
        },
    })
}

fn scenario_failover() -> bool {
    let mut ok = true;
    let resolver = load(failover_config()).expect("failover config loads");
    let s = |v: &[&str]| -> Vec<String> { v.iter().map(|x| x.to_string()).collect() };
    let all_ratelimit = |_: &Candidate| -> Result<String, ProviderErrorKind> {
        Err(ProviderErrorKind::RateLimit)
    };

    // Ordered: exact configured order, stateless across calls.
    let mut mux = MockMux::new();
    let (att1, _) = mux.request(&resolver, "ord3", &all_ratelimit);
    ok &= check_eq(
        "failover-order: ordered strategy hands Mux the exact configured order",
        &att1[..],
        &s(&["m1", "m2", "m3"])[..],
    );
    let (att2, _) = mux.request(&resolver, "ord3", &all_ratelimit);
    ok &= check(
        "failover-order: ordered is stateless — repeated requests get identical order",
        att2 == att1,
    );

    // Round-robin: deterministic rotation across calls; state in Mux cursors.
    let mut mux = MockMux::new();
    let (r1, _) = mux.request(&resolver, "rr3", &all_ratelimit);
    let (r2, _) = mux.request(&resolver, "rr3", &all_ratelimit);
    let (r3, _) = mux.request(&resolver, "rr3", &all_ratelimit);
    let (r4, _) = mux.request(&resolver, "rr3", &all_ratelimit);
    let rotated = r1 == s(&["m1", "m2", "m3"])
        && r2 == s(&["m2", "m3", "m1"])
        && r3 == s(&["m3", "m1", "m2"])
        && r4 == r1;
    ok &= check(
        "failover-order: round-robin rotates deterministically across calls (wraps after n)",
        rotated,
    );
    // Purity of round-robin: resolver alone never advances anything.
    let frozen = Cursors::new();
    let p1 = resolver.resolve("rr3", &frozen).expect("rr3");
    let p2 = resolver.resolve("rr3", &frozen).expect("rr3");
    ok &= check(
        "failover-order: rotation state lives in Mux — resolver with same cursors never rotates",
        p1 == p2 && p1.rotation_nodes == vec!["rr3".to_string()],
    );

    // Bucket account rotation composes with group failover.
    let mut mux = MockMux::new();
    let (c1, _) = mux.request(&resolver, "combo", &all_ratelimit);
    let (c2, _) = mux.request(&resolver, "combo", &all_ratelimit);
    ok &= check_eq(
        "failover-order: bucket accounts exhaust before group fails over (call 1)",
        &c1[..],
        &s(&["m1@a1", "m1@a2", "m2"])[..],
    );
    ok &= check_eq(
        "failover-order: bucket rotation composes — call 2 starts at rotated account",
        &c2[..],
        &s(&["m1@a2", "m1@a1", "m2"])[..],
    );

    // Sticky bucket: never rotates across calls.
    let mut mux = MockMux::new();
    let (s1, _) = mux.request(&resolver, "combo-sticky", &all_ratelimit);
    let (s2, _) = mux.request(&resolver, "combo-sticky", &all_ratelimit);
    ok &= check(
        "failover-order: sticky bucket strategy never rotates across calls",
        s1 == s(&["m1@a1", "m1@a2", "m2"]) && s2 == s1,
    );

    // §7.5 ProviderError-keyed behavior (retry_count = 2).
    let mut mux = MockMux::new();
    let (att, res) = mux.request(&resolver, "ord3", &|c| match c.model.as_str() {
        "m1" => Err(ProviderErrorKind::RateLimit),
        "m2" => Err(ProviderErrorKind::Network),
        _ => Ok("done".into()),
    });
    ok &= check_eq(
        "failover-order: §7.5 RateLimit fails over immediately; Network retries 2 then fails over",
        &att[..],
        &s(&["m1", "m2", "m2", "m2", "m3"])[..],
    );
    ok &= check("failover-order: §7.5 mixed-error request ultimately succeeds on m3", res == Ok("done".into()));

    let mut mux = MockMux::new();
    let (att, _) = mux.request(&resolver, "ord3", &|c| match c.model.as_str() {
        "m1" => Err(ProviderErrorKind::Timeout),
        _ => Ok("done".into()),
    });
    ok &= check_eq(
        "failover-order: §7.5 Timeout retries exactly once then fails over",
        &att[..],
        &s(&["m1", "m1", "m2"])[..],
    );

    let mut mux = MockMux::new();
    let (att, _) = mux.request(&resolver, "ord3", &|c| match c.model.as_str() {
        "m1" => Err(ProviderErrorKind::InvalidRequest),
        "m2" => Err(ProviderErrorKind::ModelNotFound),
        _ => Ok("done".into()),
    });
    ok &= check_eq(
        "failover-order: §7.5 InvalidRequest/ModelNotFound fail over immediately, no retry",
        &att[..],
        &s(&["m1", "m2", "m3"])[..],
    );

    let mut mux = MockMux::new();
    let (att, _) = mux.request(&resolver, "ord3", &|c| match c.model.as_str() {
        "m1" => Err(ProviderErrorKind::AuthFailed),
        "m2" => Err(ProviderErrorKind::ServerError),
        _ => Ok("done".into()),
    });
    ok &= check_eq(
        "failover-order: §7.5 AuthFailed/ServerError retry configured count (2) then fail over",
        &att[..],
        &s(&["m1", "m1", "m1", "m2", "m2", "m2", "m3"])[..],
    );

    let mut mux = MockMux::new();
    let (_, res) = mux.request(&resolver, "ord3", &all_ratelimit);
    ok &= check(
        "failover-order: §7.5 exhausted candidates surface as ProviderEvent::Error analog",
        res == Err("providers exhausted -> ProviderEvent::Error".into()),
    );

    ok
}

fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let ok = match scenario.as_str() {
        "resolve" => scenario_resolve(),
        "cycles" => scenario_cycles(),
        "failover-order" => scenario_failover(),
        "all" => {
            let a = scenario_resolve();
            let b = scenario_cycles();
            let c = scenario_failover();
            a && b && c
        }
        other => {
            eprintln!("unknown scenario '{other}' (use resolve|cycles|failover-order|all)");
            false
        }
    };
    std::process::exit(if ok { 0 } else { 1 });
}
