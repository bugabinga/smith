//! p03-subagent-ecosystem-simulation
//!
//! Proves or disproves (docs/SPEC.md §9.6, §9.7, §9.2): interface packages
//! prevent plugin ecosystem fragmentation — consumers target an interface,
//! users choose the implementation in config, and adapters normalize
//! incompatible implementations.
//!
//! A tiny plugin manager loads five plugins (interface package, Alice's
//! conforming implementation, Bob's incompatible implementation, a
//! Bob-to-interface adapter, and a UI consumer), then resolves the
//! `community/subagent` interface according to a user config chosen by the
//! CLI argument.
//!
//! Verify:
//!   cargo run -- alice            # UI backed by alice/subagents      -> exit 0
//!   cargo run -- bob-adapted      # UI backed by bob via adapter      -> exit 0
//!   cargo run -- bob-direct-fails # direct bob binding must be rejected
//!
//! Exit-code choice: `bob-direct-fails` is a scenario whose SUCCESS is the
//! interface error being raised. The binary exits 0 when the clear diagnostic
//! is produced as expected (the error text is printed as evidence), and
//! non-zero only if the misbinding were silently accepted.

use mlua::{Lua, Table, Value};

// Plugin sources: (directory, manifest, entry). Embedded so the simulation is
// hermetic; a real manager would read `data_dir/smith/plugins/<org>/<name>/`.
const PLUGIN_SOURCES: &[(&str, &str, &str)] = &[
    (
        "plugins/community-subagent-interface",
        include_str!("../plugins/community-subagent-interface/smith-plugin.lua"),
        include_str!("../plugins/community-subagent-interface/interface.lua"),
    ),
    (
        "plugins/alice-subagents",
        include_str!("../plugins/alice-subagents/smith-plugin.lua"),
        include_str!("../plugins/alice-subagents/init.lua"),
    ),
    (
        "plugins/bob-agents",
        include_str!("../plugins/bob-agents/smith-plugin.lua"),
        include_str!("../plugins/bob-agents/init.lua"),
    ),
    (
        "plugins/bob-to-subagent-adapter",
        include_str!("../plugins/bob-to-subagent-adapter/smith-plugin.lua"),
        include_str!("../plugins/bob-to-subagent-adapter/init.lua"),
    ),
    (
        "plugins/fancy-subagent-ui",
        include_str!("../plugins/fancy-subagent-ui/smith-plugin.lua"),
        include_str!("../plugins/fancy-subagent-ui/init.lua"),
    ),
];

const UI_ENTRY_SOURCE: &str = include_str!("../plugins/fancy-subagent-ui/init.lua");

const CONFIGS: &[(&str, &str, &str)] = &[
    ("alice", "configs/alice.lua", include_str!("../configs/alice.lua")),
    (
        "bob-adapted",
        "configs/bob-adapted.lua",
        include_str!("../configs/bob-adapted.lua"),
    ),
    (
        "bob-direct-fails",
        "configs/bob-direct-fails.lua",
        include_str!("../configs/bob-direct-fails.lua"),
    ),
];

const INTERFACE: &str = "community/subagent";

/// A loaded plugin: validated manifest plus the entry file's export table.
struct Plugin {
    name: String,
    version: String,
    dir: &'static str,
    manifest: Table,
    export: Table,
}

/// §9.2 name rule: `<org>/<name>`, lowercase ASCII letters, digits, `_`, `-`.
fn valid_plugin_name(name: &str) -> bool {
    let mut parts = name.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(org), Some(rest), None) => {
            let ok = |s: &str| {
                !s.is_empty()
                    && s.chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
            };
            ok(org) && ok(rest)
        }
        _ => false,
    }
}

fn load_chunk(lua: &Lua, src: &str, name: &str) -> mlua::Result<Table> {
    lua.load(src).set_name(name).eval()
}

/// Manifest-first loading (§9.4 phases 1-3, simplified): validate the
/// manifest as data, then evaluate the entry chunk for the export table.
fn load_plugin(lua: &Lua, dir: &'static str, manifest_src: &str, entry_src: &str) -> Result<Plugin, String> {
    let manifest = load_chunk(lua, manifest_src, &format!("{dir}/smith-plugin.lua"))
        .map_err(|e| format!("{dir}: manifest error: {e}"))?;
    let name: String = manifest
        .get("name")
        .map_err(|_| format!("{dir}: manifest missing `name`"))?;
    if !valid_plugin_name(&name) {
        return Err(format!("{dir}: invalid plugin name {name:?} (want <org>/<name>)"));
    }
    let version: String = manifest
        .get("version")
        .map_err(|_| format!("{dir}: manifest missing `version`"))?;
    let entry_name: String = manifest
        .get("entry")
        .map_err(|_| format!("{dir}: manifest missing `entry`"))?;
    let export = load_chunk(lua, entry_src, &format!("{dir}/{entry_name}"))
        .map_err(|e| format!("{dir}: entry error: {e}"))?;
    Ok(Plugin { name, version, dir, manifest, export })
}

fn find<'a>(plugins: &'a [Plugin], name: &str) -> Option<&'a Plugin> {
    plugins.iter().find(|p| p.name == name)
}

/// True if the manifest's list-valued `field` contains `value`.
fn manifest_lists(manifest: &Table, field: &str, value: &str) -> bool {
    if let Ok(list) = manifest.get::<Table>(field) {
        for v in list.sequence_values::<String>().flatten() {
            if v == value {
                return true;
            }
        }
    }
    false
}

/// Conformance diagnostics against the descriptor (p02's check, keyed by
/// plugin name instead of file path).
fn check_conformance(desc: &Table, imp: &Table, plugin_name: &str) -> mlua::Result<Vec<String>> {
    let mut diags = Vec::new();
    let functions: Table = desc.get("functions")?;
    for pair in functions.pairs::<String, Table>() {
        let (fn_name, _sig) = pair?;
        let field: Value = imp.get(fn_name.clone())?;
        match field {
            Value::Function(_) => {}
            Value::Nil => diags.push(format!(
                "{plugin_name}.{fn_name}: expected function (required by interface), got nil (missing)"
            )),
            other => diags.push(format!(
                "{plugin_name}.{fn_name}: expected function, got {}",
                other.type_name()
            )),
        }
    }
    diags.sort();
    Ok(diags)
}

/// Interface view: exposes ONLY the descriptor's functions, each wrapped with
/// runtime argument validation (proven in p02). Extra fields stay hidden.
fn make_view(lua: &Lua, desc: &Table, imp: &Table) -> mlua::Result<Table> {
    let view = lua.create_table()?;
    let functions: Table = desc.get("functions")?;
    for pair in functions.pairs::<String, Table>() {
        let (fn_name, sig) = pair?;
        let params: Table = sig.get("params")?;
        let mut spec: Vec<(String, String, bool)> = Vec::new();
        for p in params.sequence_values::<Table>() {
            let p = p?;
            spec.push((p.get("name")?, p.get("type")?, p.get("optional").unwrap_or(false)));
        }
        let target: mlua::Function = imp.get(fn_name.clone())?;
        let fname = fn_name.clone();
        let wrapped = lua.create_function(move |_, args: mlua::MultiValue| {
            for (i, (pname, ptype, optional)) in spec.iter().enumerate() {
                let arg = args.get(i).cloned().unwrap_or(Value::Nil);
                let ok = match (&arg, ptype.as_str()) {
                    (Value::Nil, _) => *optional,
                    (Value::String(_), "string") => true,
                    (Value::Integer(_) | Value::Number(_), "number") => true,
                    (Value::Boolean(_), "boolean") => true,
                    (Value::Table(_), "table") => true,
                    (Value::Function(_), "function") => true,
                    _ => false,
                };
                if !ok {
                    return Err(mlua::Error::RuntimeError(format!(
                        "{fname}: param {n} '{pname}': expected {ptype}, got {got}",
                        n = i + 1,
                        got = arg.type_name(),
                    )));
                }
            }
            target.call::<mlua::MultiValue>(args)
        })?;
        view.set(fn_name, wrapped)?;
    }
    Ok(view)
}

/// Resolve an interface to a validated view according to the user config.
///
/// Binding precedence (§9.7 applied to interfaces): explicit user-config
/// binding wins; otherwise the LAST loaded plugin declaring
/// `implements = { iface }` is the default (later registrations override
/// earlier ones).
///
/// If the bound plugin's export carries `adapts = "<org>/<name>"` plus a
/// `make` factory, the manager injects the wrapped plugin's export and uses
/// the factory result as the implementation (adapter normalization).
fn resolve(
    lua: &Lua,
    iface: &str,
    desc: &Table,
    config: &Table,
    plugins: &[Plugin],
) -> Result<(Table, String), String> {
    let bound: Option<String> = config
        .get::<Table>("interfaces")
        .ok()
        .and_then(|t| t.get::<String>(iface).ok());
    let (binding, source) = match bound {
        Some(b) => (b, "user config"),
        None => {
            let default = plugins
                .iter()
                .rev()
                .find(|p| manifest_lists(&p.manifest, "implements", iface))
                .map(|p| p.name.clone())
                .ok_or_else(|| format!("no plugin implements interface '{iface}'"))?;
            (default, "load-order default")
        }
    };
    let plugin = find(plugins, &binding)
        .ok_or_else(|| format!("config binds '{iface}' to unknown plugin '{binding}'"))?;

    let adapts: Option<String> = plugin.export.get("adapts").ok();
    let (imp, via) = match adapts {
        Some(target_name) => {
            let target = find(plugins, &target_name).ok_or_else(|| {
                format!("adapter '{}' wraps unknown plugin '{target_name}'", plugin.name)
            })?;
            let make: mlua::Function = plugin
                .export
                .get("make")
                .map_err(|_| format!("adapter '{}' has no `make` factory", plugin.name))?;
            let imp: Table = make
                .call((target.export.clone(),))
                .map_err(|e| format!("adapter '{}' factory failed: {e}", plugin.name))?;
            (imp, format!("{} (adapter over {}) [{source}]", plugin.name, target_name))
        }
        None => (plugin.export.clone(), format!("{} [{source}]", plugin.name)),
    };

    let diags = check_conformance(desc, &imp, &plugin.name).map_err(|e| e.to_string())?;
    if !diags.is_empty() {
        let mut msg = format!(
            "interface error: plugin '{}' does not conform to interface '{iface}' (generation {})",
            plugin.name,
            desc.get::<i64>("generation").unwrap_or(0),
        );
        for d in &diags {
            msg.push_str(&format!("\n  {d}"));
        }
        let mut provided: Vec<String> = imp
            .pairs::<String, Value>()
            .flatten()
            .map(|(k, v)| format!("{k} ({})", v.type_name()))
            .collect();
        provided.sort();
        msg.push_str(&format!("\n  provided exports: {}", provided.join(", ")));
        if !manifest_lists(&plugin.manifest, "implements", iface) {
            msg.push_str(&format!(
                "\n  note: manifest of '{}' does not declare implements = {{\"{iface}\"}}",
                plugin.name
            ));
        }
        if let Some(adapter) = plugins.iter().find(|p| {
            manifest_lists(&p.manifest, "implements", iface)
                && p.export.get::<String>("adapts").is_ok_and(|a| a == plugin.name)
        }) {
            msg.push_str(&format!(
                "\n  hint: adapter '{}' bridges '{}' to '{iface}'; bind the interface to it instead",
                adapter.name, plugin.name
            ));
        }
        return Err(msg);
    }

    let view = make_view(lua, desc, &imp).map_err(|e| e.to_string())?;
    Ok((view, via))
}

fn usage() -> ! {
    eprintln!("usage: cargo run -- <alice|bob-adapted|bob-direct-fails>");
    std::process::exit(2);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| usage());
    let (_, config_path, config_src) = CONFIGS
        .iter()
        .find(|(name, _, _)| *name == scenario)
        .copied()
        .unwrap_or_else(|| usage());

    let lua = Lua::new();
    let mut pass = true;
    let mut check = |label: &str, ok: bool| {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        pass &= ok;
    };

    // Load all plugins in registration order (§9.7: later overrides earlier).
    let mut plugins = Vec::new();
    for (dir, manifest_src, entry_src) in PLUGIN_SOURCES {
        let p = load_plugin(&lua, dir, manifest_src, entry_src)?;
        println!("loaded {: <24} v{: <6} from {}", p.name, p.version, p.dir);
        plugins.push(p);
    }
    check("all five plugin manifests validate (§9.2) and entries load", plugins.len() == 5);

    // The interface package exports the descriptor as plain data.
    let iface_pkg = find(&plugins, "community/subagent-interface")
        .ok_or("interface package not loaded")?;
    let desc = iface_pkg.export.clone();
    check(
        "interface package exports community/subagent descriptor",
        manifest_lists(&iface_pkg.manifest, "interfaces", INTERFACE)
            && desc.get::<String>("name")? == INTERFACE,
    );

    // The UI consumer never names an implementation: config is the only
    // per-scenario difference (pass evidence d).
    check(
        "UI plugin source references no implementation (only the interface)",
        !UI_ENTRY_SOURCE.contains("alice") && !UI_ENTRY_SOURCE.contains("bob"),
    );

    let config = load_chunk(&lua, config_src, config_path)?;
    println!("scenario '{scenario}': user config {config_path}");

    match resolve(&lua, INTERFACE, &desc, &config, &plugins) {
        Ok((view, via)) => {
            println!("resolved '{INTERFACE}' -> {via}");
            check(
                "misbinding scenario must fail, working scenarios must resolve",
                scenario != "bob-direct-fails",
            );

            // Implementation internals must be invisible through the view.
            let hidden: Value = view.get("_alice_internal_dump")?;
            let hidden2: Value = view.get("make")?;
            check("implementation/adapter internals hidden through view", hidden.is_nil() && hidden2.is_nil());

            // Hand the validated view to the UI consumer and run it.
            let ui = find(&plugins, "fancy/subagent-ui").ok_or("ui plugin not loaded")?;
            let run_demo: mlua::Function = ui.export.get("run_demo")?;
            let result: Table = run_demo.call((view,))?;
            let log: Table = result.get("log")?;
            for line in log.sequence_values::<String>() {
                println!("  ui: {}", line?);
            }
            check("UI drives spawn/status/cancel through the interface", result.get::<bool>("ok")?);

            // Cross-check the handle namespace proves which backend ran.
            let first: String = log.get(1)?;
            let expected_prefix = if scenario == "alice" { "alice-" } else { "bob-" };
            check(
                &format!("backend swapped by config alone (handles are {expected_prefix}*)"),
                first.contains(&format!("handle {expected_prefix}")),
            );
        }
        Err(msg) => {
            println!("{msg}");
            check(
                "misbinding scenario must fail, working scenarios must resolve",
                scenario == "bob-direct-fails",
            );
            check(
                "error names plugin, interface, and every missing function",
                msg.contains("bob/agents")
                    && msg.contains(INTERFACE)
                    && msg.contains("bob/agents.spawn")
                    && msg.contains("bob/agents.status")
                    && msg.contains("bob/agents.cancel"),
            );
            check(
                "error shows what the plugin actually provides",
                msg.contains("run_agent") && msg.contains("agent_state") && msg.contains("stop_agent"),
            );
            check(
                "error hints at the available adapter",
                msg.contains("hint: adapter 'bob/subagent-adapter'"),
            );
        }
    }

    println!();
    if pass {
        println!("p03 RESULT ({scenario}): all expectations hold");
        Ok(())
    } else {
        Err(format!("p03 RESULT ({scenario}): expectation failed").into())
    }
}
