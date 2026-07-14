//! p05-provider-fetch-normalize
//!
//! Proves or disproves docs/SPEC.md §7.3 (Model Registry) claims:
//! - `providers.json` is runtime authority; `fetch-providers` only generates
//!   reviewable suggestions,
//! - pi.dev is primary, catwalk fills gaps,
//! - unknown registry fields are preserved through regeneration,
//! - correctness requires review (some conflicts must NOT be auto-merged).
//!
//! No network: fixtures/pi.json and fixtures/catwalk.json are fake source
//! shapes; fixtures/current-providers.json is the checked-in registry being
//! updated.
//!
//! Verify:
//!   cargo run -- generate        # merged suggestion + reviewable patch
//!   cargo run -- diff            # what would change vs current registry
//!   cargo run -- conflict-fails  # explicit report of non-auto-mergeable conflicts
//!
//! Exit-code choice for `conflict-fails`: exits 0 per PLAN.md — the command's
//! contract is to *demonstrate* conflict detection, and detection succeeding is
//! the pass condition. A production `fetch-providers` should instead exit
//! non-zero (e.g. 2) while unresolved conflicts remain so PR automation cannot
//! merge a corrupting suggestion. That distinction is reported as a SPEC gap.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::process::ExitCode;

const PI: &str = include_str!("../fixtures/pi.json");
const CATWALK: &str = include_str!("../fixtures/catwalk.json");
const CURRENT: &str = include_str!("../fixtures/current-providers.json");

/// Fields the normalizer understands at model level. Anything else found in
/// the current registry is "unknown" and must survive regeneration untouched.
const KNOWN_MODEL_FIELDS: &[&str] = &[
    "name",
    "context_window",
    "max_output_tokens",
    "cost",
    "reasoning",
];
/// Fields the normalizer understands at provider level (besides `models`).
const KNOWN_PROVIDER_FIELDS: &[&str] = &["name", "api_base"];

// ---------------------------------------------------------------------------
// Normalized source representation
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct SourceProvider {
    /// provider-level fields (name, api_base)
    fields: BTreeMap<String, Value>,
    /// model id -> known model fields
    models: BTreeMap<String, BTreeMap<String, Value>>,
}
type SourceMap = BTreeMap<String, SourceProvider>;

#[derive(Debug)]
enum Op {
    Add,
    Update,
}

/// One proposed registry change (reviewable unit).
struct Change {
    op: Op,
    path: String,
    old: Option<Value>,
    new: Value,
    source: String,
}

/// A pi/catwalk disagreement resolved by the "pi.dev primary" rule.
struct ResolvedConflict {
    path: String,
    pi: Value,
    catwalk: Value,
}

/// A conflict class that must NOT be auto-merged.
struct UnresolvableConflict {
    path: String,
    class: &'static str,
    reason: String,
    left_label: &'static str,
    left: Value,
    right_label: &'static str,
    right: Value,
    action: &'static str,
}

struct Outcome {
    current: Value,
    suggestion: Value,
    changes: Vec<Change>,
    resolved: Vec<ResolvedConflict>,
    unresolvable: Vec<UnresolvableConflict>,
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

fn fields_value(f: &BTreeMap<String, Value>) -> Value {
    Value::Object(f.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// pi.dev fake shape: flat `models` array with a `provider` field per entry.
/// Duplicate (provider, id) entries with conflicting metadata make the primary
/// source ambiguous: that model is excluded and reported as unresolvable.
fn normalize_pi(raw: &Value) -> (SourceMap, Vec<UnresolvableConflict>, BTreeSet<(String, String)>) {
    let mut map = SourceMap::new();
    let mut unresolvable = Vec::new();
    let mut poisoned: BTreeSet<(String, String)> = BTreeSet::new();
    for m in raw["models"].as_array().expect("pi.json: models array") {
        let pid = m["provider"].as_str().expect("pi model provider").to_string();
        let mid = m["id"].as_str().expect("pi model id").to_string();
        let mut fields = BTreeMap::new();
        for f in KNOWN_MODEL_FIELDS {
            if let Some(v) = m.get(*f) {
                fields.insert((*f).to_string(), v.clone());
            }
        }
        if poisoned.contains(&(pid.clone(), mid.clone())) {
            continue;
        }
        let prov = map.entry(pid.clone()).or_default();
        match prov.models.get(&mid) {
            Some(existing) if *existing != fields => {
                unresolvable.push(UnresolvableConflict {
                    path: format!("providers.{pid}.models.{mid}"),
                    class: "ambiguous-primary-source",
                    reason: "pi.dev (primary source) lists the same model twice with \
                             conflicting metadata; 'pi wins' cannot pick between two pi values"
                        .to_string(),
                    left_label: "pi.dev entry #1",
                    left: fields_value(existing),
                    right_label: "pi.dev entry #2",
                    right: fields_value(&fields),
                    action: "model excluded from suggestion; requires human review",
                });
                prov.models.remove(&mid);
                poisoned.insert((pid.clone(), mid.clone()));
            }
            Some(_) => {} // identical duplicate: harmless
            None => {
                prov.models.insert(mid, fields);
            }
        }
    }
    (map, unresolvable, poisoned)
}

/// catwalk fake shape: `providers` array, each with nested `models` array.
fn normalize_catwalk(raw: &Value) -> SourceMap {
    let mut map = SourceMap::new();
    for p in raw["providers"].as_array().expect("catwalk.json: providers array") {
        let pid = p["id"].as_str().expect("catwalk provider id").to_string();
        let prov = map.entry(pid).or_default();
        for f in KNOWN_PROVIDER_FIELDS {
            if let Some(v) = p.get(*f) {
                prov.fields.insert((*f).to_string(), v.clone());
            }
        }
        for m in p["models"].as_array().expect("catwalk models array") {
            let mid = m["id"].as_str().expect("catwalk model id").to_string();
            let mut fields = BTreeMap::new();
            for f in KNOWN_MODEL_FIELDS {
                if let Some(v) = m.get(*f) {
                    fields.insert((*f).to_string(), v.clone());
                }
            }
            prov.models.insert(mid, fields);
        }
    }
    map
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

fn jkind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// SPEC §7.3 merge rule: pi.dev primary, catwalk fills gaps.
fn pick(
    pi: Option<&Value>,
    cat: Option<&Value>,
    path: &str,
    resolved: &mut Vec<ResolvedConflict>,
) -> (Value, String) {
    match (pi, cat) {
        (Some(p), Some(c)) if p == c => (p.clone(), "pi.dev+catwalk (agree)".to_string()),
        (Some(p), Some(c)) => {
            resolved.push(ResolvedConflict {
                path: path.to_string(),
                pi: p.clone(),
                catwalk: c.clone(),
            });
            (p.clone(), "pi.dev (won conflict over catwalk)".to_string())
        }
        (Some(p), None) => (p.clone(), "pi.dev".to_string()),
        (None, Some(c)) => (c.clone(), "catwalk (fills gap)".to_string()),
        (None, None) => unreachable!("pick called with no source value"),
    }
}

/// Apply one proposed value onto the suggestion registry object.
/// Keys the sources do not mention (unknown fields) are never visited, so they
/// are preserved structurally byte-for-byte.
fn apply_field(
    obj: &mut Map<String, Value>,
    key: &str,
    new: &Value,
    src: &str,
    path: &str,
    changes: &mut Vec<Change>,
    unres: &mut Vec<UnresolvableConflict>,
) {
    match obj.get_mut(key) {
        None => {
            obj.insert(key.to_string(), new.clone());
            changes.push(Change {
                op: Op::Add,
                path: path.to_string(),
                old: None,
                new: new.clone(),
                source: src.to_string(),
            });
        }
        Some(cur) => apply_existing(cur, new, src, path, changes, unres),
    }
}

fn apply_existing(
    cur: &mut Value,
    new: &Value,
    src: &str,
    path: &str,
    changes: &mut Vec<Change>,
    unres: &mut Vec<UnresolvableConflict>,
) {
    if cur == new {
        return;
    }
    if jkind(cur) != jkind(new) {
        // Structural disagreement between generated data and the hand-curated
        // registry. "pi wins" is a precedence rule between *sources*; it does
        // not license clobbering a richer curated structure with a scalar.
        unres.push(UnresolvableConflict {
            path: path.to_string(),
            class: "type-mismatch-vs-curated-registry",
            reason: format!(
                "registry has hand-curated {} but source proposes {}; \
                 auto-merge would destroy curated structure",
                jkind(cur),
                jkind(new)
            ),
            left_label: "current registry value (kept)",
            left: cur.clone(),
            right_label: &"proposed by source",
            right: new.clone(),
            action: "field NOT auto-merged; registry value kept; requires human review",
        });
        return;
    }
    if cur.is_object() && new.is_object() {
        let cur_o = cur.as_object_mut().unwrap();
        for (k, v) in new.as_object().unwrap() {
            apply_field(cur_o, k, v, src, &format!("{path}.{k}"), changes, unres);
        }
        return;
    }
    changes.push(Change {
        op: Op::Update,
        path: path.to_string(),
        old: Some(cur.clone()),
        new: new.clone(),
        source: src.to_string(),
    });
    *cur = new.clone();
}

fn run_merge() -> Outcome {
    let current: Value = serde_json::from_str(CURRENT).expect("parse current-providers.json");
    let pi_raw: Value = serde_json::from_str(PI).expect("parse pi.json");
    let cat_raw: Value = serde_json::from_str(CATWALK).expect("parse catwalk.json");

    let (pi, mut unresolvable, poisoned) = normalize_pi(&pi_raw);
    let catwalk = normalize_catwalk(&cat_raw);

    let mut suggestion = current.clone();
    let mut changes = Vec::new();
    let mut resolved = Vec::new();

    let root = suggestion
        .as_object_mut()
        .expect("registry is object")
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap();

    let empty = SourceProvider::default();
    let provider_ids: BTreeSet<&String> = pi.keys().chain(catwalk.keys()).collect();
    for pid in provider_ids {
        let pi_p = pi.get(pid).unwrap_or(&empty);
        let cat_p = catwalk.get(pid).unwrap_or(&empty);

        let prov_obj = root
            .entry(pid.clone())
            .or_insert_with(|| json!({ "models": {} }))
            .as_object_mut()
            .unwrap();

        // provider-level fields
        let pfields: BTreeSet<&String> = pi_p.fields.keys().chain(cat_p.fields.keys()).collect();
        for f in pfields {
            let path = format!("providers.{pid}.{f}");
            let (val, src) = pick(pi_p.fields.get(f), cat_p.fields.get(f), &path, &mut resolved);
            apply_field(prov_obj, f, &val, &src, &path, &mut changes, &mut unresolvable);
        }

        // models
        let models_obj = prov_obj
            .entry("models".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap();
        let mids: BTreeSet<&String> = pi_p
            .models
            .keys()
            .chain(cat_p.models.keys())
            .filter(|m| !poisoned.contains(&(pid.clone(), (*m).clone())))
            .collect();
        for mid in mids {
            let model_obj = models_obj
                .entry(mid.clone())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap();
            let pi_m = pi_p.models.get(mid);
            let cat_m = cat_p.models.get(mid);
            let mfields: BTreeSet<&String> = pi_m
                .map(|m| m.keys().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .chain(cat_m.map(|m| m.keys().collect::<Vec<_>>()).unwrap_or_default())
                .collect();
            for f in mfields {
                let path = format!("providers.{pid}.models.{mid}.{f}");
                let (val, src) = pick(
                    pi_m.and_then(|m| m.get(f)),
                    cat_m.and_then(|m| m.get(f)),
                    &path,
                    &mut resolved,
                );
                apply_field(model_obj, f, &val, &src, &path, &mut changes, &mut unresolvable);
            }
        }
    }

    Outcome {
        current,
        suggestion,
        changes,
        resolved,
        unresolvable,
    }
}

// ---------------------------------------------------------------------------
// Helpers: path lookup, unknown-field scan, line diff
// ---------------------------------------------------------------------------

fn get<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(v, |acc, k| acc.get(k))
}

/// Every path in the current registry whose key the normalizer does not know.
/// These must be preserved exactly through the merge.
fn scan_unknown_paths(current: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let top = current.as_object().unwrap();
    for k in top.keys() {
        if k != "version" && k != "providers" {
            out.push(k.clone());
        }
    }
    if let Some(providers) = top.get("providers").and_then(Value::as_object) {
        for (pid, p) in providers {
            let po = p.as_object().unwrap();
            for k in po.keys() {
                if !KNOWN_PROVIDER_FIELDS.contains(&k.as_str()) && k != "models" {
                    out.push(format!("providers.{pid}.{k}"));
                }
            }
            if let Some(models) = po.get("models").and_then(Value::as_object) {
                for (mid, m) in models {
                    for k in m.as_object().unwrap().keys() {
                        if !KNOWN_MODEL_FIELDS.contains(&k.as_str()) {
                            out.push(format!("providers.{pid}.models.{mid}.{k}"));
                        }
                    }
                }
            }
        }
    }
    out
}

/// Minimal LCS line diff of two pretty-printed JSON documents.
fn diff_ops(a: &[&str], b: &[&str]) -> Vec<(char, String)> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < n && j < m {
        if a[i] == b[j] {
            out.push((' ', a[i].to_string()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            out.push(('-', a[i].to_string()));
            i += 1;
        } else {
            out.push(('+', b[j].to_string()));
            j += 1;
        }
    }
    while i < n {
        out.push(('-', a[i].to_string()));
        i += 1;
    }
    while j < m {
        out.push(('+', b[j].to_string()));
        j += 1;
    }
    out
}

/// Render a unified-style patch with 2 lines of context around changes.
fn render_patch(current: &Value, suggestion: &Value) -> String {
    let a = serde_json::to_string_pretty(current).unwrap();
    let b = serde_json::to_string_pretty(suggestion).unwrap();
    let al: Vec<&str> = a.lines().collect();
    let bl: Vec<&str> = b.lines().collect();
    let ops = diff_ops(&al, &bl);
    let mut keep = vec![false; ops.len()];
    for (i, (c, _)) in ops.iter().enumerate() {
        if *c != ' ' {
            let lo = i.saturating_sub(2);
            let hi = (i + 2).min(ops.len().saturating_sub(1));
            for k in keep.iter_mut().take(hi + 1).skip(lo) {
                *k = true;
            }
        }
    }
    let mut out = String::from("--- fixtures/current-providers.json (current)\n+++ suggested providers.json (generated, requires review)\n");
    let mut skipping = false;
    for (i, (c, l)) in ops.iter().enumerate() {
        if keep[i] {
            if skipping {
                out.push_str("@@ ... @@\n");
                skipping = false;
            }
            out.push_str(&format!("{c} {l}\n"));
        } else {
            skipping = true;
        }
    }
    if skipping {
        out.push_str("@@ ... @@\n");
    }
    out
}

fn print_unresolvable(u: &UnresolvableConflict) {
    println!("CONFLICT {}", u.path);
    println!("  class:  {}", u.class);
    println!("  reason: {}", u.reason);
    println!("  {}: {}", u.left_label, u.left);
    println!("  {}: {}", u.right_label, u.right);
    println!("  action: {}", u.action);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

struct Checker {
    pass: bool,
}
impl Checker {
    fn new() -> Self {
        Checker { pass: true }
    }
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

/// Assertions shared by all commands: the SPEC §7.3 pass evidence.
fn core_assertions(c: &mut Checker, o: &Outcome) {
    let s = &o.suggestion;

    // pi.dev wins conflicts (against catwalk 400000 / "(community listing)")
    c.check(
        "pi wins conflict: claude-omega.context_window = 500000 (pi) not 400000 (catwalk)",
        get(s, "providers.anthropic.models.claude-omega.context_window") == Some(&json!(500000)),
    );
    c.check(
        "pi wins conflict: claude-omega.name = \"Claude Omega\" (pi) not catwalk's listing name",
        get(s, "providers.anthropic.models.claude-omega.name") == Some(&json!("Claude Omega")),
    );
    c.check(
        "resolved-conflict log records both values for review",
        o.resolved.iter().any(|r| {
            r.path == "providers.anthropic.models.claude-omega.context_window"
                && r.pi == json!(500000)
                && r.catwalk == json!(400000)
        }),
    );

    // catwalk fills gaps
    c.check(
        "catwalk fills gap: claude-omega.reasoning = true (absent from pi)",
        get(s, "providers.anthropic.models.claude-omega.reasoning") == Some(&json!(true)),
    );
    c.check(
        "catwalk fills gap: claude-mini.max_output_tokens = 8192 (absent from pi)",
        get(s, "providers.anthropic.models.claude-mini.max_output_tokens") == Some(&json!(8192)),
    );
    c.check(
        "catwalk-only model claude-legacy added",
        get(s, "providers.anthropic.models.claude-legacy.cost.input") == Some(&json!(1.0)),
    );
    c.check(
        "catwalk-only provider mistral added with api_base",
        get(s, "providers.mistral.api_base") == Some(&json!("https://api.mistral.ai/v1"))
            && get(s, "providers.mistral.models.mistral-large-3").is_some(),
    );

    // unknown fields preserved
    let unknown = scan_unknown_paths(&o.current);
    let all_preserved = unknown.iter().all(|p| get(s, p) == get(&o.current, p));
    let untouched = unknown
        .iter()
        .all(|p| o.changes.iter().all(|ch| !ch.path.starts_with(p.as_str())));
    for p in &unknown {
        println!("     unknown field preserved: {p} = {}", get(s, p).map(|v| v.to_string()).unwrap_or_else(|| "<MISSING>".into()));
    }
    c.check(
        &format!("all {} unknown registry fields preserved semantically byte-for-byte", unknown.len()),
        unknown.len() == 4 && all_preserved && untouched,
    );

    // unresolvable conflicts are NOT auto-merged
    c.check(
        "type-mismatch conflict NOT merged: gpt-9.cost.input keeps curated object",
        get(s, "providers.openai.models.gpt-9.cost.input")
            == Some(&json!({ "cached": 2.5, "uncached": 10.0 })),
    );
    c.check(
        "ambiguous-primary conflict NOT merged: gpt-9-nano excluded from suggestion",
        get(s, "providers.openai.models.gpt-9-nano").is_none(),
    );
    c.check(
        "exactly 2 unresolvable conflicts reported explicitly",
        o.unresolvable.len() == 2,
    );

    // sanity: a compatible pi update to curated data IS proposed (that is the
    // tool's purpose) but only as a suggestion in the patch, not a silent write
    c.check(
        "pi updates stale registry value in suggestion: gpt-9.context_window 800000 -> 1000000",
        get(s, "providers.openai.models.gpt-9.context_window") == Some(&json!(1000000)),
    );
}

fn cmd_generate(o: &Outcome) -> bool {
    println!("== suggested providers.json (generated; current registry stays authoritative until a human commits this) ==");
    println!("{}", serde_json::to_string_pretty(&o.suggestion).unwrap());
    println!();
    println!("== reviewable patch ==");
    let patch = render_patch(&o.current, &o.suggestion);
    print!("{patch}");
    println!();
    println!("== pi/catwalk conflicts resolved by 'pi.dev primary' rule ({}) ==", o.resolved.len());
    for r in &o.resolved {
        println!("  {}: pi.dev {} beat catwalk {}", r.path, r.pi, r.catwalk);
    }
    println!();
    println!("== unresolvable conflicts excluded from patch ({}) — see `conflict-fails` ==", o.unresolvable.len());
    for u in &o.unresolvable {
        println!("  {} [{}]", u.path, u.class);
    }
    println!();

    let mut c = Checker::new();
    core_assertions(&mut c, o);
    let has = |sign: char, frag: &str| {
        patch
            .lines()
            .any(|l| l.starts_with(sign) && l.trim_start_matches([sign, ' ']).starts_with(frag))
    };
    c.check(
        "patch is reviewable: shows old and new values as -/+ lines",
        has('-', "\"context_window\": 300000,") && has('+', "\"context_window\": 500000,"),
    );
    c.check(
        "generate never writes files: current-providers.json is untouched (stdout only)",
        serde_json::from_str::<Value>(CURRENT).unwrap() == o.current,
    );
    println!();
    println!("p05 generate RESULT: {}", if c.pass { "all expectations hold" } else { "FAILED" });
    c.pass
}

fn cmd_diff(o: &Outcome) -> bool {
    println!("== changes vs fixtures/current-providers.json ({} field-level ops) ==", o.changes.len());
    for ch in &o.changes {
        match ch.op {
            Op::Add => println!("  + {} = {}   [{}]", ch.path, ch.new, ch.source),
            Op::Update => println!(
                "  ~ {}: {} -> {}   [{}]",
                ch.path,
                ch.old.as_ref().unwrap(),
                ch.new,
                ch.source
            ),
        }
    }
    println!();
    println!("== fields kept at current value due to unresolved conflicts ({}) ==", o.unresolvable.len());
    for u in &o.unresolvable {
        println!("  ! {} [{}] — {}", u.path, u.class, u.action);
    }
    println!();

    let mut c = Checker::new();
    core_assertions(&mut c, o);
    c.check(
        "diff lists stale-value update with old and new: claude-omega.context_window 300000 -> 500000",
        o.changes.iter().any(|ch| {
            matches!(ch.op, Op::Update)
                && ch.path == "providers.anthropic.models.claude-omega.context_window"
                && ch.old == Some(json!(300000))
                && ch.new == json!(500000)
        }),
    );
    c.check(
        "every change is attributed to a source (pi.dev / catwalk / both)",
        o.changes.iter().all(|ch| !ch.source.is_empty()),
    );
    c.check(
        "no change touches an unknown registry field",
        scan_unknown_paths(&o.current)
            .iter()
            .all(|p| o.changes.iter().all(|ch| !ch.path.starts_with(p.as_str()))),
    );
    println!();
    println!("p05 diff RESULT: {}", if c.pass { "all expectations hold" } else { "FAILED" });
    c.pass
}

fn cmd_conflict_fails(o: &Outcome) -> bool {
    println!("== explicit conflict report: classes that must NOT be auto-merged ==");
    println!();
    for u in &o.unresolvable {
        print_unresolvable(u);
        println!();
    }

    let mut c = Checker::new();
    core_assertions(&mut c, o);
    c.check(
        "report includes a type-mismatch-vs-curated-registry conflict at gpt-9.cost.input",
        o.unresolvable.iter().any(|u| {
            u.class == "type-mismatch-vs-curated-registry"
                && u.path == "providers.openai.models.gpt-9.cost.input"
        }),
    );
    c.check(
        "report includes an ambiguous-primary-source conflict at gpt-9-nano",
        o.unresolvable.iter().any(|u| {
            u.class == "ambiguous-primary-source"
                && u.path == "providers.openai.models.gpt-9-nano"
        }),
    );
    c.check(
        "every conflict entry states path, class, both values, and required action",
        o.unresolvable
            .iter()
            .all(|u| !u.path.is_empty() && !u.reason.is_empty() && !u.action.is_empty()),
    );
    println!();
    println!(
        "exit-code note: this command exits 0 because its contract (PLAN.md) is to \
         demonstrate that the conflict class is detected and NOT auto-merged — which succeeded. \
         A production `fetch-providers` should exit non-zero (e.g. 2) while unresolved \
         conflicts remain, so PR automation cannot silently merge a corrupting suggestion. \
         SPEC §7.3 does not currently specify this."
    );
    println!();
    println!("p05 conflict-fails RESULT: {}", if c.pass { "all expectations hold" } else { "FAILED" });
    c.pass
}

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let outcome = run_merge();
    let ok = match cmd.as_str() {
        "generate" => cmd_generate(&outcome),
        "diff" => cmd_diff(&outcome),
        "conflict-fails" => cmd_conflict_fails(&outcome),
        _ => {
            eprintln!("usage: cargo run -- <generate|diff|conflict-fails>");
            return ExitCode::from(2);
        }
    };
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
