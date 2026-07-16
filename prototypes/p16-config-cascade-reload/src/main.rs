//! p16-config-cascade-reload
//!
//! Proves or disproves docs/SPEC.md §5.6 (five-layer config cascade) and
//! §9.19 (host configuration reload: validate fully, swap atomically, roll
//! back on failure, minimal changed-keypath diff, CLI layer persists).
//!
//! Key unknown under test: cross-layer merge granularity for nested tables.
//! Implements leaf-field recursive merge (the §7.3 pattern) and contrasts it
//! with whole-key layer-replace.
//!
//! Verify: `cargo run -- cascade|reload-ok|reload-invalid-keeps-active|`
//! `plugin-reload-reevaluates|all` — exit 0 with PASS lines.

use mlua::{Lua, Table, Value};
use std::collections::btree_map::Entry;
use std::collections::BTreeMap;

const LAYER_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/layers");

// ---------------------------------------------------------------- values

/// Config value tree. Maps merge recursively under leaf-merge; everything
/// else (scalars AND lists) is a leaf.
#[derive(Clone, Debug, PartialEq)]
enum CVal {
    Str(String),
    Num(f64),
    Bool(bool),
    List(Vec<CVal>),
    Map(BTreeMap<String, CVal>),
}

type Map = BTreeMap<String, CVal>;

fn type_of(v: &CVal) -> &'static str {
    match v {
        CVal::Str(_) => "string",
        CVal::Num(_) => "number",
        CVal::Bool(_) => "boolean",
        CVal::List(_) => "list",
        CVal::Map(_) => "table",
    }
}

fn to_json(v: &CVal) -> serde_json::Value {
    match v {
        CVal::Str(s) => serde_json::Value::String(s.clone()),
        CVal::Num(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        CVal::Bool(b) => serde_json::Value::Bool(*b),
        CVal::List(xs) => serde_json::Value::Array(xs.iter().map(to_json).collect()),
        CVal::Map(m) => serde_json::Value::Object(
            m.iter().map(|(k, v)| (k.clone(), to_json(v))).collect(),
        ),
    }
}

fn lua_to_cval(v: &Value) -> Result<CVal, String> {
    match v {
        Value::String(s) => Ok(CVal::Str(
            s.to_str().map_err(|e| e.to_string())?.to_string(),
        )),
        Value::Integer(i) => Ok(CVal::Num(*i as f64)),
        Value::Number(n) => Ok(CVal::Num(*n)),
        Value::Boolean(b) => Ok(CVal::Bool(*b)),
        Value::Table(t) => {
            let len = t.raw_len();
            if len > 0 {
                let mut xs = Vec::with_capacity(len);
                for i in 1..=len {
                    let item: Value = t.raw_get(i as i64).map_err(|e| e.to_string())?;
                    xs.push(lua_to_cval(&item)?);
                }
                Ok(CVal::List(xs))
            } else {
                let mut m = Map::new();
                for pair in t.clone().pairs::<Value, Value>() {
                    let (k, v) = pair.map_err(|e| e.to_string())?;
                    let Value::String(ks) = k else {
                        return Err(format!("non-string table key: {k:?}"));
                    };
                    m.insert(
                        ks.to_str().map_err(|e| e.to_string())?.to_string(),
                        lua_to_cval(&v)?,
                    );
                }
                Ok(CVal::Map(m))
            }
        }
        other => Err(format!("unsupported config value type: {}", other.type_name())),
    }
}

// ---------------------------------------------------------------- merging

#[derive(Clone, Copy, PartialEq)]
enum MergePolicy {
    /// §7.3-style recursive leaf-field merge (maps merge, leaves replace).
    LeafMerge,
    /// Whole-key replacement: a layer that sets a key replaces its entire
    /// subtree. Demonstrated only to show what §5.6 must NOT mean.
    LayerReplace,
}

fn leaf_merge(base: &mut Map, over: Map) {
    for (k, v) in over {
        match base.entry(k) {
            Entry::Occupied(mut e) => match (e.get_mut(), v) {
                (CVal::Map(bm), CVal::Map(om)) => leaf_merge(bm, om),
                (slot, v) => *slot = v,
            },
            Entry::Vacant(e) => {
                e.insert(v);
            }
        }
    }
}

fn apply_layer(base: &mut Map, over: Map, policy: MergePolicy) {
    match policy {
        MergePolicy::LeafMerge => leaf_merge(base, over),
        MergePolicy::LayerReplace => {
            for (k, v) in over {
                base.insert(k, v);
            }
        }
    }
}

// ---------------------------------------------------------------- Lua layers

/// Restricted environment for config chunks: pure data + a few safe globals.
/// No io/os/debug, per §5.5.
fn restricted_env(lua: &Lua) -> mlua::Result<Table> {
    let env = lua.create_table()?;
    let g = lua.globals();
    for name in ["string", "table", "math", "pairs", "ipairs", "tostring", "tonumber"] {
        env.set(name, g.get::<Value>(name)?)?;
    }
    Ok(env)
}

fn eval_layer(lua: &Lua, file: &str) -> Result<Map, String> {
    let path = format!("{LAYER_DIR}/{file}");
    let src = std::fs::read_to_string(&path).map_err(|e| format!("{file}: {e}"))?;
    let env = restricted_env(lua).map_err(|e| e.to_string())?;
    let v: Value = lua
        .load(&src)
        .set_name(format!("layers/{file}"))
        .set_environment(env)
        .eval()
        .map_err(|e| format!("evaluation of {file} failed: {e}"))?;
    match lua_to_cval(&v)? {
        CVal::Map(m) => Ok(m),
        other => Err(format!("{file}: layer must return a table, got {}", type_of(&other))),
    }
}

// ---------------------------------------------------------------- schema

/// Layer 1: Rust type defaults (§5.6 layer 1).
fn rust_defaults() -> Map {
    let mut kb = Map::new();
    kb.insert("ctrl+c".into(), CVal::Str("abort".into()));
    let mut aliases = Map::new();
    aliases.insert("sonnet".into(), CVal::Str("anthropic/claude-sonnet-4".into()));
    let mut models = Map::new();
    models.insert("aliases".into(), CVal::Map(aliases));
    let mut m = Map::new();
    m.insert("theme".into(), CVal::Str("default".into()));
    m.insert("keybindings".into(), CVal::Map(kb));
    m.insert("tools".into(), CVal::List(vec![CVal::Str("read".into())]));
    m.insert("model".into(), CVal::Str("sonnet".into()));
    m.insert("compaction_threshold".into(), CVal::Num(0.85));
    m.insert("models".into(), CVal::Map(models));
    m
}

/// Validate against the Rust schema. Errors carry exact key paths.
/// Unknown keys: warn at top level, fail inside the strict `models` context
/// (§5.6: "warn or fail according to the schema context").
fn validate(cfg: &Map) -> (Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let expect = |path: String, want: &str, got: &CVal, errors: &mut Vec<String>| {
        if type_of(got) != want {
            errors.push(format!("{path}: expected {want}, got {}", type_of(got)));
        }
    };
    for (k, v) in cfg {
        match k.as_str() {
            "theme" | "model" => expect(k.clone(), "string", v, &mut errors),
            "compaction_threshold" => expect(k.clone(), "number", v, &mut errors),
            "keybindings" => match v {
                CVal::Map(kb) => {
                    for (key, action) in kb {
                        expect(format!("keybindings.{key}"), "string", action, &mut errors);
                    }
                }
                other => errors.push(format!("keybindings: expected table, got {}", type_of(other))),
            },
            "tools" => match v {
                CVal::List(xs) => {
                    for (i, x) in xs.iter().enumerate() {
                        expect(format!("tools[{i}]"), "string", x, &mut errors);
                    }
                }
                other => errors.push(format!("tools: expected list, got {}", type_of(other))),
            },
            "models" => match v {
                CVal::Map(mm) => {
                    for (mk, mv) in mm {
                        if mk == "aliases" {
                            match mv {
                                CVal::Map(am) => {
                                    for (a, t) in am {
                                        expect(
                                            format!("models.aliases.{a}"),
                                            "string",
                                            t,
                                            &mut errors,
                                        );
                                    }
                                }
                                other => errors.push(format!(
                                    "models.aliases: expected table, got {}",
                                    type_of(other)
                                )),
                            }
                        } else {
                            errors.push(format!(
                                "models.{mk}: unknown key (strict schema context: fail)"
                            ));
                        }
                    }
                }
                other => errors.push(format!("models: expected table, got {}", type_of(other))),
            },
            unknown => warnings.push(format!(
                "{unknown}: unknown key (top-level schema context: warn)"
            )),
        }
    }
    (errors, warnings)
}

// ---------------------------------------------------------------- resolution

fn alias_map(cfg: &Map) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(CVal::Map(models)) = cfg.get("models") {
        if let Some(CVal::Map(aliases)) = models.get("aliases") {
            for (k, v) in aliases {
                if let CVal::Str(s) = v {
                    out.insert(k.clone(), s.clone());
                }
            }
        }
    }
    out
}

/// Whole-graph cycle detection (§5.7: "cycles detected at config load").
/// Chasing only the active model's chain would let a CLI flag mask a latent
/// cycle — so every alias chain is walked.
fn check_alias_cycles(aliases: &BTreeMap<String, String>) -> Result<(), String> {
    for start in aliases.keys() {
        let mut path: Vec<&str> = vec![start];
        let mut cur = start.as_str();
        while let Some(next) = aliases.get(cur) {
            if next.contains('/') {
                break;
            }
            if path.contains(&next.as_str()) {
                path.push(next);
                return Err(format!("models.aliases: alias cycle: {}", path.join(" -> ")));
            }
            path.push(next);
            cur = next;
        }
    }
    Ok(())
}

/// Mini §5.7 resolution: follow aliases until a concrete `provider/model`.
fn resolve_model(name: &str, aliases: &BTreeMap<String, String>) -> Result<String, String> {
    let mut path: Vec<String> = vec![name.to_string()];
    let mut cur = name.to_string();
    loop {
        if cur.contains('/') {
            return Ok(cur);
        }
        match aliases.get(&cur) {
            Some(next) => {
                if path.contains(next) {
                    path.push(next.clone());
                    return Err(format!("model: alias cycle: {}", path.join(" -> ")));
                }
                path.push(next.clone());
                cur = next.clone();
            }
            None => {
                return Err(format!(
                    "model: `{name}` unresolvable at `{cur}` (path: {})",
                    path.join(" -> ")
                ))
            }
        }
    }
}

// ---------------------------------------------------------------- diffing

fn flatten(prefix: &str, m: &Map, out: &mut BTreeMap<String, String>) {
    for (k, v) in m {
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        match v {
            CVal::Map(sub) => flatten(&path, sub, out),
            leaf => {
                out.insert(path, to_json(leaf).to_string());
            }
        }
    }
}

/// Minimal changed-leaf-path diff between two effective configs.
fn diff(old: &Map, new: &Map) -> Vec<String> {
    let (mut fo, mut fn_) = (BTreeMap::new(), BTreeMap::new());
    flatten("", old, &mut fo);
    flatten("", new, &mut fn_);
    let mut changed: Vec<String> = fo
        .keys()
        .chain(fn_.keys())
        .filter(|k| fo.get(*k) != fn_.get(*k))
        .cloned()
        .collect();
    changed.sort();
    changed.dedup();
    changed
}

// ---------------------------------------------------------------- reload host

#[derive(Debug)]
enum ReloadError {
    Eval(String),
    Validate(Vec<String>),
    Resolve(String),
}

impl std::fmt::Display for ReloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReloadError::Eval(e) => write!(f, "eval: {e}"),
            ReloadError::Validate(es) => write!(f, "validate: {}", es.join("; ")),
            ReloadError::Resolve(e) => write!(f, "resolve: {e}"),
        }
    }
}

#[derive(Clone)]
struct LayerSet {
    builtin: &'static str,
    plugins: Vec<&'static str>,
    user: &'static str,
}

/// Build a candidate config from layers 1-4 plus the fixed CLI layer 5,
/// validate fully, and resolve the effective model. Never touches any
/// active config — the caller swaps on success (§9.19 steps 1-3).
fn build_candidate(
    lua: &Lua,
    layers: &LayerSet,
    cli: &Map,
    policy: MergePolicy,
) -> Result<(Map, String, Vec<String>), ReloadError> {
    // Layer 1: Rust defaults.
    let mut cand = rust_defaults();
    // Layers 2-4: Lua data tables.
    let mut files: Vec<&str> = vec![layers.builtin];
    files.extend(layers.plugins.iter().copied());
    files.push(layers.user);
    for file in files {
        let layer = eval_layer(lua, file).map_err(ReloadError::Eval)?;
        apply_layer(&mut cand, layer, policy);
    }
    // Layer 5: CLI flags — a Rust map, fixed for the process lifetime.
    apply_layer(&mut cand, cli.clone(), policy);

    let (errors, warnings) = validate(&cand);
    if !errors.is_empty() {
        return Err(ReloadError::Validate(errors));
    }
    let aliases = alias_map(&cand);
    check_alias_cycles(&aliases).map_err(ReloadError::Resolve)?;
    let CVal::Str(model_name) = cand.get("model").cloned().unwrap() else {
        unreachable!("validated as string");
    };
    let resolved = resolve_model(&model_name, &aliases).map_err(ReloadError::Resolve)?;
    Ok((cand, resolved, warnings))
}

struct Host {
    active: Map,
    resolved_model: String,
    cli: Map,
}

impl Host {
    fn load(lua: &Lua, layers: &LayerSet, cli: Map) -> Result<Self, ReloadError> {
        let (active, resolved_model, _) =
            build_candidate(lua, layers, &cli, MergePolicy::LeafMerge)?;
        Ok(Host { active, resolved_model, cli })
    }

    /// §9.19 sequence: rebuild layers 1-4, keep CLI layer, validate +
    /// re-resolve; on ANY failure keep the active config; on success swap
    /// atomically and return the changed key paths.
    fn reload(&mut self, lua: &Lua, layers: &LayerSet) -> Result<Vec<String>, ReloadError> {
        let (cand, resolved, _) = build_candidate(lua, layers, &self.cli, MergePolicy::LeafMerge)?;
        let changed = diff(&self.active, &cand);
        self.active = cand;
        self.resolved_model = resolved;
        println!(
            "apply effects: theme -> keybindings -> tools -> model; event config_changed: {}",
            serde_json::to_string(&changed).unwrap()
        );
        Ok(changed)
    }
}

fn get_path<'a>(m: &'a Map, path: &str) -> Option<&'a CVal> {
    let mut parts = path.split('.');
    let mut cur = m.get(parts.next()?)?;
    for p in parts {
        let CVal::Map(sub) = cur else { return None };
        cur = sub.get(p)?;
    }
    Some(cur)
}

fn str_at<'a>(m: &'a Map, path: &str) -> Option<&'a str> {
    match get_path(m, path) {
        Some(CVal::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn cli_overrides() -> Map {
    let mut m = Map::new();
    m.insert("model".into(), CVal::Str("anthropic/claude-opus-4".into()));
    m
}

fn base_layers() -> LayerSet {
    LayerSet {
        builtin: "builtin.lua",
        plugins: vec!["plugin-a.lua", "plugin-b.lua"],
        user: "user.lua",
    }
}

// ---------------------------------------------------------------- scenarios

struct T {
    pass: bool,
}

impl T {
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

fn scenario_cascade(t: &mut T, lua: &Lua) {
    println!("--- cascade ---");
    let layers = base_layers();
    let (cfg, resolved, warnings) =
        build_candidate(lua, &layers, &cli_overrides(), MergePolicy::LeafMerge)
            .expect("cascade builds");

    t.check(
        "layer 4 over layer 2: theme = catppuccin",
        str_at(&cfg, "theme") == Some("catppuccin"),
    );
    t.check(
        "leaf-merge: user overriding ONE keybinding keeps builtin ctrl+c=abort",
        str_at(&cfg, "keybindings.ctrl+c") == Some("abort"),
    );
    t.check(
        "leaf-merge: user override wins for keybindings.ctrl+l",
        str_at(&cfg, "keybindings.ctrl+l") == Some("cycle_model"),
    );
    t.check(
        "layer 3 contribution present: keybindings.ctrl+p from plugin-a",
        str_at(&cfg, "keybindings.ctrl+p") == Some("plugin_a_palette"),
    );
    t.check(
        "layer 3 ordering: later plugin-b overrides plugin-a for ctrl+g",
        str_at(&cfg, "keybindings.ctrl+g") == Some("plugin_b_goto"),
    );
    t.check(
        "lists are leaves: plugin-a's tools list replaces builtin's wholesale",
        get_path(&cfg, "tools")
            == Some(&CVal::List(vec![
                CVal::Str("read".into()),
                CVal::Str("grep".into()),
                CVal::Str("ls".into()),
                CVal::Str("plugin_a_tool".into()),
            ])),
    );
    t.check(
        "layer 5 CLI flag overrides user model",
        str_at(&cfg, "model") == Some("anthropic/claude-opus-4")
            && resolved == "anthropic/claude-opus-4",
    );
    t.check(
        "unknown top-level key warns with exact path",
        warnings.iter().any(|w| w.starts_with("experimental_shimmer:")),
    );
    for w in &warnings {
        println!("  warning: {w}");
    }

    // Without CLI: user's model alias resolves through plugin + builtin
    // alias contributions (quick -> fast -> anthropic/claude-haiku-4).
    let (_, resolved_nocli, _) =
        build_candidate(lua, &layers, &Map::new(), MergePolicy::LeafMerge).expect("builds");
    t.check(
        "multi-hop alias resolution across layers: quick -> anthropic/claude-haiku-4",
        resolved_nocli == "anthropic/claude-haiku-4",
    );

    // Contrast: what layer-replace would do differently.
    let replaced = build_candidate(lua, &layers, &cli_overrides(), MergePolicy::LayerReplace)
        .expect("replace-policy still validates");
    t.check(
        "layer-replace CONTRAST: user's one-binding table wipes builtin ctrl+c (abort lost)",
        str_at(&replaced.0, "keybindings.ctrl+c").is_none()
            && str_at(&replaced.0, "keybindings.ctrl+l") == Some("cycle_model")
            && str_at(&replaced.0, "keybindings.ctrl+p").is_none(),
    );
    println!(
        "  evidence: leaf-merge keybindings = {}",
        to_json(get_path(&cfg, "keybindings").unwrap())
    );
    println!(
        "  evidence: layer-replace keybindings = {}",
        to_json(get_path(&replaced.0, "keybindings").unwrap())
    );
    // Under layer-replace the plugin's `models` table also clobbers builtin
    // aliases, so without the CLI flag the user's model no longer resolves.
    let replaced_nocli = build_candidate(lua, &layers, &Map::new(), MergePolicy::LayerReplace);
    let broke = matches!(&replaced_nocli, Err(ReloadError::Resolve(e)) if e.contains("quick"));
    if let Err(e) = &replaced_nocli {
        println!("  evidence: layer-replace breaks resolution: {e}");
    }
    t.check(
        "layer-replace CONTRAST: plugin alias table clobbers builtin aliases, model unresolvable",
        broke,
    );

    // §5.5 restricted environment: config chunks cannot reach os/io.
    let env = restricted_env(lua).unwrap();
    let os_probe: mlua::Result<Value> = lua
        .load("return os.getenv('HOME')")
        .set_environment(env)
        .eval();
    t.check("restricted env: os unavailable in layer chunks", os_probe.is_err());
}

fn scenario_reload_ok(t: &mut T, lua: &Lua) {
    println!("--- reload-ok ---");
    let layers = base_layers();
    let mut host = Host::load(lua, &layers, cli_overrides()).expect("initial load");
    let theme_before = str_at(&host.active, "theme").unwrap().to_string();

    // user.lua edited between loads: point layer 4 at the v2 file.
    let mut layers_v2 = layers.clone();
    layers_v2.user = "user-v2.lua";
    let changed = host.reload(lua, &layers_v2).expect("reload succeeds");

    let expected = vec![
        "compaction_threshold".to_string(),
        "keybindings.ctrl+t".to_string(),
        "theme".to_string(),
    ];
    t.check(
        "diff is exactly the changed leaf paths (sorted, minimal)",
        changed == expected,
    );
    t.check(
        "diff excludes `model`: user changed it but CLI layer masks it (effective value unchanged)",
        !changed.iter().any(|p| p == "model"),
    );
    t.check(
        "swap applied: theme catppuccin -> nord",
        theme_before == "catppuccin" && str_at(&host.active, "theme") == Some("nord"),
    );
    t.check(
        "CLI layer persists over reloaded layers",
        str_at(&host.active, "model") == Some("anthropic/claude-opus-4")
            && host.resolved_model == "anthropic/claude-opus-4",
    );
    t.check(
        "leaf-merge held across reload: builtin ctrl+c still bound",
        str_at(&host.active, "keybindings.ctrl+c") == Some("abort"),
    );

    // Reloading identical layers must yield an empty diff (minimality).
    let changed2 = host.reload(lua, &layers_v2).expect("idempotent reload");
    t.check("idempotent reload yields empty diff", changed2.is_empty());
}

fn scenario_reload_invalid(t: &mut T, lua: &Lua) {
    println!("--- reload-invalid-keeps-active ---");
    let layers = base_layers();
    let mut host = Host::load(lua, &layers, cli_overrides()).expect("initial load");
    let mut snapshot = BTreeMap::new();
    flatten("", &host.active, &mut snapshot);
    let resolved_before = host.resolved_model.clone();

    // (a) type errors: validation must report every exact key path.
    let mut bad = layers.clone();
    bad.user = "user-bad-type.lua";
    let err = host.reload(lua, &bad).expect_err("bad types rejected");
    println!("  diagnostic: {err}");
    let paths_ok = match &err {
        ReloadError::Validate(es) => {
            es.iter().any(|e| e.starts_with("compaction_threshold: expected number, got string"))
                && es.iter().any(|e| e.starts_with("keybindings.ctrl+x: expected string, got number"))
        }
        _ => false,
    };
    t.check("bad type rejected with exact key paths (both errors reported)", paths_ok);

    // (b) alias cycle: resolution failure with the full cycle path, even
    // though the EFFECTIVE model is the concrete CLI value.
    let mut cyc = layers.clone();
    cyc.user = "user-cycle.lua";
    let err = host.reload(lua, &cyc).expect_err("cycle rejected");
    println!("  diagnostic: {err}");
    let cycle_ok = matches!(&err, ReloadError::Resolve(e)
        if e.contains("loopy -> swoopy -> loopy") || e.contains("swoopy -> loopy -> swoopy"));
    t.check(
        "alias cycle rejected with full path despite CLI masking the active model",
        cycle_ok,
    );

    // (c) evaluation failure (Lua syntax error).
    let mut syn = layers.clone();
    syn.user = "user-syntax-error.lua";
    let err = host.reload(lua, &syn).expect_err("syntax error rejected");
    println!("  diagnostic: {err}");
    t.check(
        "evaluation failure rejected (§9.19 step 2 covers eval too)",
        matches!(err, ReloadError::Eval(_)),
    );

    // Active config untouched by ALL three failures.
    let mut now = BTreeMap::new();
    flatten("", &host.active, &mut now);
    t.check(
        "active config byte-identical after all failed reloads (rollback, nothing partial)",
        now == snapshot && host.resolved_model == resolved_before,
    );

    // Host is not poisoned: a valid reload still succeeds afterwards.
    let mut ok = layers.clone();
    ok.user = "user-v2.lua";
    t.check(
        "valid reload succeeds after failures (no poisoned state)",
        host.reload(lua, &ok).is_ok(),
    );
}

fn scenario_plugin_reload(t: &mut T, lua: &Lua) {
    println!("--- plugin-reload-reevaluates ---");
    let layers = base_layers();
    let mut host = Host::load(lua, &layers, cli_overrides()).expect("initial load");

    // §9.16 plugin reload swaps plugin-a's domain; §9.19 then re-evaluates
    // the cascade with the new layer-3 contribution.
    let mut swapped = layers.clone();
    swapped.plugins = vec!["plugin-a-v2.lua", "plugin-b.lua"];
    let changed = host.reload(lua, &swapped).expect("cascade re-evaluates");

    let expected = vec!["keybindings.ctrl+p".to_string(), "tools".to_string()];
    t.check(
        "diff shows exactly the plugin-contributed changes",
        changed == expected,
    );
    t.check(
        "new plugin contribution active: ctrl+p -> plugin_a_palette_v2, tools grew",
        str_at(&host.active, "keybindings.ctrl+p") == Some("plugin_a_palette_v2")
            && matches!(get_path(&host.active, "tools"), Some(CVal::List(xs))
                if xs.contains(&CVal::Str("plugin_a_extra".into()))),
    );
    t.check(
        "later layers still mask plugin: user theme wins, so `theme` not in diff",
        str_at(&host.active, "theme") == Some("catppuccin")
            && !changed.iter().any(|p| p == "theme"),
    );
    t.check(
        "intra-layer order preserved: plugin-b still overrides ctrl+g, not in diff",
        str_at(&host.active, "keybindings.ctrl+g") == Some("plugin_b_goto")
            && !changed.iter().any(|p| p == "keybindings.ctrl+g"),
    );
    t.check(
        "CLI layer persists across plugin-triggered re-evaluation",
        str_at(&host.active, "model") == Some("anthropic/claude-opus-4"),
    );
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let lua = Lua::new();
    let mut t = T { pass: true };
    match cmd.as_str() {
        "cascade" => scenario_cascade(&mut t, &lua),
        "reload-ok" => scenario_reload_ok(&mut t, &lua),
        "reload-invalid-keeps-active" => scenario_reload_invalid(&mut t, &lua),
        "plugin-reload-reevaluates" => scenario_plugin_reload(&mut t, &lua),
        "all" => {
            scenario_cascade(&mut t, &lua);
            scenario_reload_ok(&mut t, &lua);
            scenario_reload_invalid(&mut t, &lua);
            scenario_plugin_reload(&mut t, &lua);
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
    if !t.pass {
        std::process::exit(1);
    }
    println!("OK: {cmd}");
}
