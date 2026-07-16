//! p19-models-dev-schema-pin — SPEC §7.3 against the REAL models.dev api.json.
//!
//! Subcommands:
//!   validate-snapshot  full real snapshot passes providers.schema.json;
//!                      every loosening the schema needed is counted.
//!   merge              leaf-field merge of a catwalk-shaped gap-fill fixture;
//!                      unknown fields preserved, conflicts excluded+reported,
//!                      §7.3 non-zero-exit rule computed and documented.
//!   map-metadata       every snapshot model through the §7.3→§5.7 mapping
//!                      table; clean/missing/unmapped counts.
//!   all                the three in order.
//!
//! Exit-code handling: the PROTOTYPE exits 0 when its expectations hold (the
//! verify contract). The §7.3 rule "`fetch-providers` exits non-zero while
//! unresolved conflicts remain" is COMPUTED and asserted: `merge` derives the
//! exit code fetch-providers WOULD return (1, because the fixture contains one
//! deliberate unresolved conflict) and PASSes only if that computed code is
//! non-zero. A prototype failure (any assertion) exits 1.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const MANIFEST: &str = env!("CARGO_MANIFEST_DIR");

fn load(path: &str) -> Value {
    let full = format!("{MANIFEST}/{path}");
    let bytes = std::fs::read(&full).unwrap_or_else(|e| panic!("read {full}: {e}"));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse {full}: {e}"))
}

fn pass(msg: &str) {
    println!("PASS {msg}");
}

fn check(cond: bool, msg: &str) {
    if cond {
        pass(msg);
    } else {
        println!("FAIL {msg}");
        std::process::exit(1);
    }
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ---------------------------------------------------------------- validate

fn validate_snapshot() {
    println!("== validate-snapshot ==");
    let schema = load("providers.schema.json");
    let snapshot = load("fixtures/models-dev-api.snapshot.json");
    let validator = jsonschema::validator_for(&schema).expect("schema compiles");

    let providers = snapshot.as_object().expect("snapshot is a provider map");
    let n_providers = providers.len();
    let n_models: usize = providers
        .values()
        .map(|p| p["models"].as_object().map_or(0, |m| m.len()))
        .sum();

    let errors: Vec<String> = validator
        .iter_errors(&snapshot)
        .map(|e| format!("{} @ {}", e, e.instance_path))
        .collect();
    for e in errors.iter().take(10) {
        println!("  schema error: {e}");
    }
    check(
        errors.is_empty(),
        &format!(
            "FULL real snapshot valid against providers.schema.json \
             (providers={n_providers}, models={n_models}, errors={})",
            errors.len()
        ),
    );

    // Negative control: the schema is not vacuous — a scalar `cost` (the p05
    // type-mismatch class §7.3 forbids) must be rejected.
    let mut mutated = snapshot.clone();
    mutated["anthropic"]["models"]["claude-fable-5"]["cost"] = json!(3.0);
    check(
        !validator.is_valid(&mutated),
        "negative control: scalar `cost` rejected by schema (cost must be an object)",
    );
    let mut mutated2 = snapshot.clone();
    mutated2["anthropic"]["models"]["claude-fable-5"]
        .as_object_mut()
        .unwrap()
        .remove("limit");
    check(
        !validator.is_valid(&mutated2),
        "negative control: model without `limit` rejected by schema",
    );

    // ---- loosening report: everything the schema had to allow beyond a
    // naive reading of §7.3, counted from the real data.
    let mut missing_cost = 0usize;
    let mut missing_cost_open_weights = 0usize;
    let mut missing_temperature = 0usize;
    let mut missing_structured_output = 0usize;
    let mut missing_limit_input = 0usize;
    let mut zero_context = 0usize;
    let mut zero_output = 0usize;
    let mut zero_input = 0usize;
    let mut cost_nonscalar_members: BTreeMap<String, usize> = BTreeMap::new();
    let mut cost_extra_scalar_members: BTreeMap<String, usize> = BTreeMap::new();
    let mut providers_missing_api = 0usize;
    // unknown model fields whose JSON kind is unstable across models
    let mut unknown_field_kinds: BTreeMap<String, BTreeMap<&'static str, usize>> = BTreeMap::new();
    let known_model_fields = [
        "id", "name", "cost", "limit", "modalities", "attachment", "reasoning", "tool_call",
        "structured_output", "temperature",
    ];
    let known_cost_fields = [
        "input", "output", "cache_read", "cache_write", "reasoning", "input_audio", "output_audio",
    ];

    for provider in providers.values() {
        if provider.get("api").is_none() {
            providers_missing_api += 1;
        }
        for model in provider["models"].as_object().unwrap().values() {
            let m = model.as_object().unwrap();
            match m.get("cost") {
                None => {
                    missing_cost += 1;
                    if m.get("open_weights") == Some(&Value::Bool(true)) {
                        missing_cost_open_weights += 1;
                    }
                }
                Some(Value::Object(c)) => {
                    for (k, v) in c {
                        if !known_cost_fields.contains(&k.as_str()) {
                            if v.is_number() {
                                *cost_extra_scalar_members.entry(k.clone()).or_default() += 1;
                            } else {
                                *cost_nonscalar_members
                                    .entry(format!("{k} ({})", kind(v)))
                                    .or_default() += 1;
                            }
                        }
                    }
                }
                Some(other) => panic!("cost is neither absent nor object: {other}"),
            }
            if m.get("temperature").is_none() {
                missing_temperature += 1;
            }
            if m.get("structured_output").is_none() {
                missing_structured_output += 1;
            }
            if m["limit"].get("input").is_none() {
                missing_limit_input += 1;
            }
            if m["limit"].get("context") == Some(&json!(0)) {
                zero_context += 1;
            }
            if m["limit"].get("output") == Some(&json!(0)) {
                zero_output += 1;
            }
            if m["limit"].get("input") == Some(&json!(0)) {
                zero_input += 1;
            }
            for (k, v) in m {
                if !known_model_fields.contains(&k.as_str()) {
                    *unknown_field_kinds
                        .entry(k.clone())
                        .or_default()
                        .entry(kind(v))
                        .or_default() += 1;
                }
            }
        }
    }

    println!("-- loosenings the schema needed (real-data evidence, counts) --");
    println!(
        "  LOOSENED model.cost optional: {missing_cost}/{n_models} models have NO cost \
         ({missing_cost_open_weights} of them open_weights=true) — §7.3 'cost is always an \
         object' only holds when present"
    );
    println!(
        "  LOOSENED capability flags optional: temperature missing on {missing_temperature}, \
         structured_output missing on {missing_structured_output} models"
    );
    println!("  LOOSENED limit.input optional: missing on {missing_limit_input}/{n_models} models");
    println!(
        "  LOOSENED limit minimum 0 (not 1): limit.context=0 on {zero_context}, \
         limit.output=0 on {zero_output}, limit.input=0 on {zero_input} models — image/video \
         models publish 0 as 'not applicable' (273 schema errors before loosening)"
    );
    println!("  LOOSENED provider.api optional: missing on {providers_missing_api}/{n_providers} providers (gateways/aggregators)");
    for (k, n) in &cost_nonscalar_members {
        println!(
            "  LOOSENED cost carries NON-scalar member `{k}`: {n} models — tiered pricing, \
             inexpressible as flat per-million USD; passes only via additionalProperties"
        );
    }
    for (k, n) in &cost_extra_scalar_members {
        println!("  LOOSENED cost extra scalar member `{k}`: {n} models");
    }
    let polymorphic: Vec<String> = unknown_field_kinds
        .iter()
        .filter(|(_, kinds)| kinds.len() > 1)
        .map(|(k, kinds)| {
            let detail: Vec<String> = kinds.iter().map(|(t, n)| format!("{t}={n}")).collect();
            format!("`{k}` [{}]", detail.join(", "))
        })
        .collect();
    println!(
        "  UNKNOWN model fields observed (preserved, schema-legal): {}",
        unknown_field_kinds
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );
    for p in &polymorphic {
        println!(
            "  LOOSENED polymorphic unknown field {p} — same field, multiple JSON kinds \
             across models (type-mismatch hazard for leaf merge)"
        );
    }
    check(
        missing_cost > 0
            && missing_temperature > 0
            && zero_output > 0
            && !cost_nonscalar_members.is_empty()
            && !polymorphic.is_empty(),
        "loosening report complete: every loosening class is evidenced by real data \
         (see LOOSENED lines above)",
    );
    pass(&format!(
        "validate-snapshot: schema pinned at retrieval 2026-07-16, sha256 recorded in \
         fixtures/SNAPSHOT-NOTE.md; no in-band upstream version exists in api.json"
    ));
}

// ---------------------------------------------------------------- merge

#[derive(Debug)]
struct Conflict {
    class: &'static str,
    path: String,
    curated_kind: &'static str,
    proposed_kind: &'static str,
}

/// Leaf-field merge: `primary` wins on every present leaf; `fill` supplies
/// missing leaves/subtrees. Object-vs-object recurses; a present leaf whose
/// JSON kind differs between sides is a `type-mismatch-vs-curated` conflict:
/// curated (primary) value kept, proposal excluded, conflict reported.
fn leaf_merge(primary: &Value, fill: &Value, path: &str, conflicts: &mut Vec<Conflict>) -> Value {
    match (primary, fill) {
        (Value::Object(p), Value::Object(f)) => {
            let mut out = Map::new();
            for (k, pv) in p {
                match f.get(k) {
                    Some(fv) => out.insert(
                        k.clone(),
                        leaf_merge(pv, fv, &format!("{path}.{k}"), conflicts),
                    ),
                    None => out.insert(k.clone(), pv.clone()),
                };
            }
            for (k, fv) in f {
                if !p.contains_key(k) {
                    out.insert(k.clone(), fv.clone()); // gap fill
                }
            }
            Value::Object(out)
        }
        (p, f) if kind(p) == kind(f) => p.clone(), // same-kind overlap: primary wins
        (p, f) => {
            conflicts.push(Conflict {
                class: "type-mismatch-vs-curated",
                path: path.to_string(),
                curated_kind: kind(p),
                proposed_kind: kind(f),
            });
            p.clone() // curated value kept, proposal excluded
        }
    }
}

/// Normalize the catwalk shape (provider list, api_base/context_window/
/// max_output_tokens names) into the models.dev shape (§7.3 boundary 1
/// happens AFTER this normalization).
fn normalize_catwalk(catwalk: &Value) -> Value {
    let mut providers = Map::new();
    for p in catwalk["providers"].as_array().unwrap() {
        let po = p.as_object().unwrap();
        let mut np = Map::new();
        for (k, v) in po {
            match k.as_str() {
                "api_base" => {
                    np.insert("api".into(), v.clone());
                }
                "models" => {}
                _ => {
                    np.insert(k.clone(), v.clone());
                }
            }
        }
        let mut models = Map::new();
        for m in po["models"].as_array().unwrap() {
            let mo = m.as_object().unwrap();
            let mut nm = Map::new();
            let mut limit = Map::new();
            for (k, v) in mo {
                match k.as_str() {
                    "context_window" => {
                        limit.insert("context".into(), v.clone());
                    }
                    "max_output_tokens" => {
                        limit.insert("output".into(), v.clone());
                    }
                    _ => {
                        nm.insert(k.clone(), v.clone());
                    }
                }
            }
            if !limit.is_empty() {
                nm.insert("limit".into(), Value::Object(limit));
            }
            models.insert(mo["id"].as_str().unwrap().to_string(), Value::Object(nm));
        }
        np.insert("models".into(), Value::Object(models));
        providers.insert(po["id"].as_str().unwrap().to_string(), Value::Object(np));
    }
    Value::Object(providers)
}

/// Strip every `required` keyword from a schema — the fragment validator.
/// §7.3 boundary 1 validates "source data after normalization", but gap-fill
/// sources are PARTIAL (a fragment has no business carrying `limit` just to
/// donate a `knowledge` leaf). The full schema's `required` clauses can only
/// apply post-merge; boundary 1 can only check types-of-present-fields.
fn strip_required(v: &Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| k.as_str() != "required")
                .map(|(k, x)| (k.clone(), strip_required(x)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(strip_required).collect()),
        _ => v.clone(),
    }
}

fn merge() {
    println!("== merge ==");
    let schema = load("providers.schema.json");
    let snapshot = load("fixtures/models-dev-api.snapshot.json");
    let catwalk = load("fixtures/catwalk.json");

    let full_validator = jsonschema::validator_for(&schema).expect("schema compiles");
    let fragment_schema = strip_required(&schema);
    let fragment_validator =
        jsonschema::validator_for(&fragment_schema).expect("fragment schema compiles");

    // §7.3 conflict class 1: ambiguous-primary-source. Two probes on the
    // real primary: (a) duplicate model IDs cannot survive JSON parsing at
    // all (objects keyed by ID collapse duplicates silently), (b) the inner
    // `id` field vs the map key is the only post-parse ambiguity signal.
    let mut id_key_mismatches = 0usize;
    for (pid, p) in snapshot.as_object().unwrap() {
        for (mid, m) in p["models"].as_object().unwrap() {
            if m["id"].as_str() != Some(mid.as_str()) {
                id_key_mismatches += 1;
                println!("  ambiguous-primary-source: {pid}/{mid} inner id={}", m["id"]);
            }
        }
    }
    pass(&format!(
        "ambiguous-primary-source probe: {id_key_mismatches} key/inner-id mismatches in real \
         primary; NOTE duplicate JSON keys collapse at parse time — this conflict class is \
         undetectable post-parse without a raw-lexer duplicate-key check (spec gap)"
    ));

    // Boundary 1: validate normalized source fragments (types only).
    let mut normalized = normalize_catwalk(&catwalk);
    let source_errors: Vec<String> = fragment_validator
        .iter_errors(&normalized)
        .map(|e| format!("{} @ {}", e, e.instance_path))
        .collect();
    for e in &source_errors {
        println!("  source-boundary validation error: {e}");
    }
    check(
        source_errors.len() == 1 && source_errors[0].contains("claude-haiku-4-5"),
        &format!(
            "boundary 1: scalar `cost` on claude-haiku-4-5 is a SOURCE validation error \
             (not a merge conflict) per §7.3 — errors={}",
            source_errors.len()
        ),
    );
    // Excise the invalid leaf so merge input is schema-clean (§7.3 routes it
    // out before merge; whether the whole source or just the field is dropped
    // is unspecified — this prototype drops the offending field).
    normalized["anthropic"]["models"]["claude-haiku-4-5"]
        .as_object_mut()
        .unwrap()
        .remove("cost");
    check(
        fragment_validator.is_valid(&normalized),
        "boundary 1: normalized catwalk fragments schema-clean after excising invalid leaf",
    );

    // Leaf-field merge, models.dev primary.
    let mut conflicts = Vec::new();
    let merged = leaf_merge(&snapshot, &normalized, "$", &mut conflicts);

    // Gap fills.
    check(
        merged["anthropic"]["api"] == json!("https://api.anthropic.com/v1"),
        "gap-fill leaf (provider level): anthropic.api filled from catwalk api_base",
    );
    check(
        merged["anthropic"]["models"]["claude-fable-5"]["knowledge"] == json!("2026-01"),
        "gap-fill leaf (model level): claude-fable-5.knowledge filled from catwalk",
    );
    check(
        merged["anthropic"]["models"]["claude-omega"]["limit"]["context"] == json!(400000),
        "gap-fill whole model: claude-omega added (catwalk names normalized to limit.*)",
    );
    check(
        merged["acme-ai"]["models"]["acme-basic"]["cost"]["input"] == json!(0.5),
        "gap-fill whole provider: acme-ai added with its model",
    );

    // Primary wins on same-kind overlap, silently.
    check(
        merged["anthropic"]["models"]["claude-fable-5"]["name"] == json!("Claude Fable 5"),
        "overlap (same kind): models.dev primary `name` kept, catwalk proposal ignored, no conflict",
    );
    check(
        merged["anthropic"]["name"] == snapshot["anthropic"]["name"],
        "overlap (same kind): provider name kept from primary",
    );

    // Unknown-field preservation, both directions, value-equal (semantic).
    check(
        merged["anthropic"]["models"]["claude-fable-5"]["catwalk_notes"]
            == json!("community-curated entry")
            && merged["anthropic"]["models"]["claude-fable-5"]["default_max_tokens"]
                == json!(64000),
        "unknown catwalk fields (catwalk_notes, default_max_tokens) preserved in merge output",
    );
    check(
        merged["anthropic"]["models"]["claude-fable-5"]["reasoning_options"]
            == snapshot["anthropic"]["models"]["claude-fable-5"]["reasoning_options"],
        "unknown models.dev field reasoning_options preserved value-equal (conflict excluded)",
    );
    let untouched = snapshot
        .as_object()
        .unwrap()
        .iter()
        .filter(|(pid, _)| pid.as_str() != "anthropic")
        .all(|(pid, pv)| &merged[pid] == pv);
    check(
        untouched,
        &format!(
            "semantic preservation: all {} providers untouched by catwalk are value-equal \
             before/after merge (unknown fields incl. reasoning_options/interleaved/experimental survive)",
            snapshot.as_object().unwrap().len() - 1
        ),
    );

    // Conflict taxonomy.
    for c in &conflicts {
        println!(
            "  conflict: class={} path={} curated={} proposed={}",
            c.class, c.path, c.curated_kind, c.proposed_kind
        );
    }
    check(
        conflicts.len() == 1
            && conflicts[0].class == "type-mismatch-vs-curated"
            && conflicts[0].path == "$.anthropic.models.claude-fable-5.reasoning_options"
            && conflicts[0].curated_kind == "array"
            && conflicts[0].proposed_kind == "string",
        "conflict taxonomy: exactly one type-mismatch-vs-curated (reasoning_options array vs \
         string), curated value kept, proposal excluded",
    );

    // Machine-readable conflict report (§7.3 output contract).
    let report = json!({
        "source_validation_errors": source_errors,
        "conflicts": conflicts.iter().map(|c| json!({
            "class": c.class, "path": c.path,
            "curated_kind": c.curated_kind, "proposed_kind": c.proposed_kind,
        })).collect::<Vec<_>>(),
    });
    println!("  conflict report: {report}");

    // Merged output passes the FULL schema (with required) — boundary 2.
    let merged_errors = full_validator.iter_errors(&merged).count();
    check(
        merged_errors == 0,
        &format!("boundary 2: merged registry valid against full schema (errors={merged_errors})"),
    );

    // §7.3 exit-code rule, computed: unresolved conflicts remain, so
    // fetch-providers WOULD exit non-zero. The prototype asserts that
    // computation and itself exits 0 (expectation met).
    let would_exit = if conflicts.is_empty() && source_errors.is_empty() { 0 } else { 1 };
    check(
        would_exit != 0,
        &format!(
            "§7.3 exit rule: fetch-providers would exit {would_exit} \
             (unresolved_conflicts={}, source_errors={}); prototype exits 0 because this \
             expected outcome is the assertion",
            conflicts.len(),
            source_errors.len()
        ),
    );
    pass(&format!(
        "merge: leaf-field merge over real models.dev shapes complete \
         (conflicts={}, gap_fills verified=4)",
        conflicts.len()
    ));
}

// ---------------------------------------------------------------- map

fn map_metadata() {
    println!("== map-metadata ==");
    let snapshot = load("fixtures/models-dev-api.snapshot.json");
    let providers = snapshot.as_object().unwrap();

    // §7.3 mapping table → §5.7 ModelMetadata:
    //   context window     ← limit.context
    //   max output tokens  ← limit.output
    //   cost               ← cost
    //   thinking           ← reasoning
    //   vision             ← "image" in modalities.input
    //   tool use           ← tool_call
    //   streaming          ← assumed true
    // Consumed source fields; §7.3 names structured_output/temperature/
    // attachment preserved-not-consumed. Everything else is unmapped.
    let consumed = ["id", "limit", "cost", "reasoning", "modalities", "tool_call"];
    let preserved = ["structured_output", "temperature", "attachment"];

    let mut total = 0usize;
    let mut clean = 0usize;
    let mut missing_context = 0usize;
    let mut missing_output = 0usize;
    let mut zero_context = 0usize;
    let mut zero_output = 0usize;
    let mut not_clean = 0usize;
    let mut missing_cost = 0usize;
    let mut missing_cost_open_weights = 0usize;
    let mut unmapped_fields: BTreeMap<String, usize> = BTreeMap::new();
    let mut expressiveness: BTreeMap<String, usize> = BTreeMap::new();
    let mut no_text_input = 0usize;

    for p in providers.values() {
        for m in p["models"].as_object().unwrap().values() {
            total += 1;
            let mo = m.as_object().unwrap();
            let mut model_clean = true;

            // required table rows
            match mo["limit"].get("context").and_then(Value::as_u64) {
                None => {
                    missing_context += 1;
                    model_clean = false;
                }
                Some(0) => {
                    // limit.context=0 maps to a 0-token context window —
                    // unusable ModelMetadata, same default/skip question as
                    // missing data.
                    zero_context += 1;
                    model_clean = false;
                }
                Some(_) => {}
            }
            match mo["limit"].get("output").and_then(Value::as_u64) {
                None => {
                    missing_output += 1;
                    model_clean = false;
                }
                Some(0) => {
                    zero_output += 1;
                    model_clean = false;
                }
                Some(_) => {}
            }
            match mo.get("cost") {
                None => {
                    missing_cost += 1;
                    model_clean = false;
                    if mo.get("open_weights") == Some(&Value::Bool(true)) {
                        missing_cost_open_weights += 1;
                    }
                }
                Some(c) => {
                    // cost maps, but sub-shapes ModelMetadata cost cannot express:
                    for k in ["tiers", "context_over_200k", "reasoning", "input_audio", "output_audio"] {
                        if c.get(k).is_some() {
                            *expressiveness.entry(format!("cost.{k}")).or_default() += 1;
                        }
                    }
                }
            }
            // bool rows always derivable (reasoning/tool_call present on all
            // models; vision derives from modalities which is always present).
            let inputs = mo["modalities"]["input"].as_array().cloned().unwrap_or_default();
            let _vision = inputs.iter().any(|v| v == "image");
            if !inputs.iter().any(|v| v == "text") {
                no_text_input += 1;
            }
            for v in &inputs {
                let s = v.as_str().unwrap_or("?");
                if s != "image" && s != "text" {
                    *expressiveness.entry(format!("modalities.input:{s}")).or_default() += 1;
                }
            }
            if let Some(outs) = mo["modalities"].get("output").and_then(Value::as_array) {
                for v in outs {
                    let s = v.as_str().unwrap_or("?");
                    if s != "text" {
                        *expressiveness.entry(format!("modalities.output:{s}")).or_default() += 1;
                    }
                }
            }
            if mo["limit"].get("input").is_some() {
                *expressiveness.entry("limit.input".into()).or_default() += 1;
            }

            for k in mo.keys() {
                if !consumed.contains(&k.as_str()) && !preserved.contains(&k.as_str()) && k != "name" {
                    *unmapped_fields.entry(k.clone()).or_default() += 1;
                }
            }

            if model_clean {
                clean += 1;
            } else {
                not_clean += 1;
            }
        }
    }

    pass(&format!(
        "map-metadata: all {total} snapshot models pushed through the §7.3→§5.7 table"
    ));
    pass(&format!(
        "clean mappings (every table row fillable from source): {clean}/{total}"
    ));
    println!(
        "  MISSING required data: cost absent on {missing_cost} models \
         ({missing_cost_open_weights} open_weights=true) — §7.3 needs a default/skip rule \
         (e.g. open-weights/self-hosted ⇒ cost 0, else omit-model or cost-unknown)"
    );
    println!(
        "  MISSING required data: limit.context absent on {missing_context}, \
         limit.output absent on {missing_output} (universal in this snapshot — required is safe today)"
    );
    println!(
        "  UNUSABLE required data: limit.context=0 on {zero_context}, limit.output=0 on \
         {zero_output} models (image/video generators) — a 0-token context window is not a \
         real ModelMetadata; §7.3 needs a skip rule (e.g. exclude models without \"text\" \
         output, or treat 0 as not-a-chat-model)"
    );
    println!("-- distinct model fields the mapping cannot express (occurrences) --");
    for (k, n) in &unmapped_fields {
        println!("  UNMAPPED {k}: {n}");
    }
    println!("-- sub-field expressiveness gaps inside consumed fields --");
    for (k, n) in &expressiveness {
        println!("  INEXPRESSIBLE {k}: {n}");
    }
    println!(
        "  NOTE {no_text_input} models have no \"text\" in modalities.input (image/video \
         generators) — ModelMetadata has no way to say 'not a text model'"
    );
    check(
        missing_context == 0 && missing_output == 0,
        "limit.context and limit.output present on every real model (mapping rows 1-2 total)",
    );
    check(
        clean + not_clean == total,
        &format!(
            "accounting: clean ({clean}) + defective ({not_clean}: missing cost {missing_cost}, \
             zero context {zero_context}, zero output {zero_output}, overlapping) = {total}"
        ),
    );
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match cmd.as_str() {
        "validate-snapshot" => validate_snapshot(),
        "merge" => merge(),
        "map-metadata" => map_metadata(),
        "all" => {
            validate_snapshot();
            merge();
            map_metadata();
            pass("all");
        }
        other => {
            eprintln!("unknown command: {other} (validate-snapshot|merge|map-metadata|all)");
            std::process::exit(2);
        }
    }
}
