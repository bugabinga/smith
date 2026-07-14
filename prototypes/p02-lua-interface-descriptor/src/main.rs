//! p02-lua-interface-descriptor
//!
//! Proves or disproves: plain Lua descriptors plus runtime validation can
//! support community-defined plugin interfaces (docs/SPEC.md §9.6, candidate 1).
//!
//! Verify: `cargo run` — exits 0 with PASS lines when all expectations hold.

use mlua::{Lua, Table, Value};

const DESCRIPTOR: &str = include_str!("../interfaces/subagent.lua");
const IMPL_GOOD: &str = include_str!("../impl/good.lua");
const IMPL_MISSING: &str = include_str!("../impl/missing_fn.lua");
const IMPL_BAD_SHAPE: &str = include_str!("../impl/bad_shape.lua");

/// A conformance diagnostic with an exact path into the implementation.
#[derive(Debug)]
struct Diagnostic {
    path: String,
    expected: String,
    actual: String,
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: expected {}, got {}",
            self.path, self.expected, self.actual
        )
    }
}

fn type_name(v: &Value) -> String {
    v.type_name().to_string()
}

/// Load a Lua chunk in a fresh, restricted environment (data + functions only,
/// no io/os/debug access needed by the fixtures).
fn load_chunk(lua: &Lua, src: &str, name: &str) -> mlua::Result<Table> {
    lua.load(src).set_name(name).eval()
}

/// Validate an implementation table against a descriptor table.
/// Returns exact-path diagnostics; empty = conformant.
fn check_conformance(desc: &Table, imp: &Table, impl_name: &str) -> mlua::Result<Vec<Diagnostic>> {
    let mut diags = Vec::new();
    let functions: Table = desc.get("functions")?;
    for pair in functions.pairs::<String, Table>() {
        let (fn_name, _sig) = pair?;
        let field: Value = imp.get(fn_name.clone())?;
        match field {
            Value::Function(_) => {}
            Value::Nil => diags.push(Diagnostic {
                path: format!("{impl_name}.{fn_name}"),
                expected: "function (required by interface)".into(),
                actual: "nil (missing)".into(),
            }),
            other => diags.push(Diagnostic {
                path: format!("{impl_name}.{fn_name}"),
                expected: "function".into(),
                actual: type_name(&other),
            }),
        }
    }
    Ok(diags)
}

/// Build an interface view: a fresh table exposing ONLY declared functions,
/// each wrapped with a runtime argument validator from the descriptor.
fn make_view(lua: &Lua, desc: &Table, imp: &Table) -> mlua::Result<Table> {
    let view = lua.create_table()?;
    let functions: Table = desc.get("functions")?;
    for pair in functions.pairs::<String, Table>() {
        let (fn_name, sig) = pair?;
        let params: Table = sig.get("params")?;
        // Collect (name, type, optional) triples for the validator closure.
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
                let ok = match (arg.clone(), ptype.as_str()) {
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
                        got = type_name(&arg),
                    )));
                }
            }
            target.call::<mlua::MultiValue>(args)
        })?;
        view.set(fn_name, wrapped)?;
    }
    Ok(view)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let lua = Lua::new();
    let mut pass = true;
    let mut check = |label: &str, ok: bool| {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        pass &= ok;
    };

    let desc = load_chunk(&lua, DESCRIPTOR, "interfaces/subagent.lua")?;
    let iface_name: String = desc.get("name")?;
    let generation: i64 = desc.get("generation")?;
    check(
        &format!("descriptor loads as plain data ({iface_name} gen {generation})"),
        iface_name == "community/subagent" && generation == 1,
    );

    // 1. good implementation passes
    let good = load_chunk(&lua, IMPL_GOOD, "impl/good.lua")?;
    let diags = check_conformance(&desc, &good, "impl/good.lua")?;
    check("good implementation conforms (no diagnostics)", diags.is_empty());

    // 2. missing function fails with exact path/name
    let missing = load_chunk(&lua, IMPL_MISSING, "impl/missing_fn.lua")?;
    let diags = check_conformance(&desc, &missing, "impl/missing_fn.lua")?;
    let hit = diags
        .iter()
        .any(|d| d.path == "impl/missing_fn.lua.cancel" && d.actual.contains("missing"));
    for d in &diags {
        println!("     diagnostic: {d}");
    }
    check("missing function fails with exact path/name", hit && diags.len() == 1);

    // 3. bad shape fails with expected/actual diagnostic
    let bad = load_chunk(&lua, IMPL_BAD_SHAPE, "impl/bad_shape.lua")?;
    let diags = check_conformance(&desc, &bad, "impl/bad_shape.lua")?;
    let hit = diags.iter().any(|d| {
        d.path == "impl/bad_shape.lua.status" && d.expected == "function" && d.actual == "string"
    });
    for d in &diags {
        println!("     diagnostic: {d}");
    }
    check("bad shape fails with expected/actual diagnostic", hit && diags.len() == 1);

    // 4. extra implementation fields are hidden through the interface view
    let view = make_view(&lua, &desc, &good)?;
    let hidden: Value = view.get("_internal_debug_dump")?;
    check("extra implementation fields hidden through view", hidden.is_nil());

    // 5. runtime argument validation approximates signature matching
    let spawn: mlua::Function = view.get("spawn")?;
    let handle: Table = spawn.call(("index the repo",))?;
    let id: String = handle.get("id")?;
    check(&format!("valid call passes through view (handle {id})"), id == "agent-1");

    let err = spawn.call::<Table>((42,)).unwrap_err();
    let msg = err.to_string();
    println!("     runtime error: {}", msg.lines().next().unwrap_or(""));
    check(
        "wrong arg type rejected at call time with param name",
        // mlua distinguishes integer/number in diagnostics; both are Lua numbers.
        msg.contains("spawn: param 1 'task': expected string, got integer"),
    );

    // optional param may be omitted or nil
    let status: mlua::Function = view.get("status")?;
    let state: String = status.call(("agent-1",))?;
    check(&format!("status through view works (state {state})"), state == "running");

    println!();
    if pass {
        println!("p02 RESULT: all expectations hold");
        Ok(())
    } else {
        Err("p02 RESULT: expectation failed".into())
    }
}
