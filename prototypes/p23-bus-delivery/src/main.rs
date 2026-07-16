//! p23-bus-delivery
//!
//! Proves or disproves docs/SPEC.md §9.18 delivery semantics beyond the token
//! teardown p11 covered:
//! - synchronous delivery in registration order across plugin domains,
//! - emit-during-delivery enqueues (global FIFO, no re-entry),
//! - subscriber errors isolated (§9.17),
//! - teardown mid-dispatch: condemned immediately, dropped deferred (the
//!   §9.16×§9.18 interaction rule, incl. self-teardown from inside a handler),
//! - payloads are plain data — functions/threads/userdata/cycles rejected at
//!   the emit boundary; topics validated against the §9.2 charset.
//!
//! Verify: `cargo run -- order|reentrancy|error-isolation|teardown-mid-dispatch|non-data|all`

use mlua::{Function, Lua, MultiValue, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

/// Harness-neutral plain-data payload — the only shape that crosses the bus.
#[derive(Debug, Clone)]
enum Data {
    Nil,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Arr(Vec<Data>),
    Map(Vec<(String, Data)>),
}

struct Sub {
    id: u64,
    topic: String,
    domain: String,
    gen: u64,
    func: Function,
    /// Target state for payload conversion.
    lua: Lua,
}

#[derive(Default)]
struct BusState {
    subs: Vec<Sub>,
    pending: VecDeque<(String, Data)>,
    dispatching: bool,
    /// Domains condemned during the current dispatch: deliveries skip them,
    /// the actual drop is deferred to the drain epilogue.
    condemned: HashSet<String>,
    deferred_teardown: Vec<String>,
    gens: HashMap<String, u64>,
    next_id: u64,
    logs: Vec<String>,
    diags: Vec<String>,
    enqueued_during_dispatch: u64,
    max_depth: u64,
    depth: u64,
}

type Bus = Rc<RefCell<BusState>>;
type Luas = Rc<RefCell<HashMap<String, Lua>>>;

fn valid_topic(t: &str) -> bool {
    let mut parts = t.splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some(org), Some(name)) if !org.is_empty() && !name.is_empty() => [org, name]
            .iter()
            .all(|p| p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')),
        _ => false,
    }
}

/// Lua value → Data. Rejects functions, threads, userdata, non-data keys, and
/// cycles (path-tracked so DAG sharing still converts, as copies).
fn lua_to_data(v: &Value, path: &mut HashSet<usize>) -> Result<Data, String> {
    match v {
        Value::Nil => Ok(Data::Nil),
        Value::Boolean(b) => Ok(Data::Bool(*b)),
        Value::Integer(i) => Ok(Data::Int(*i)),
        Value::Number(n) => Ok(Data::Num(*n)),
        Value::String(s) => Ok(Data::Str(s.to_str().map_err(|e| e.to_string())?.to_owned())),
        Value::Table(t) => {
            let ptr = t.to_pointer() as usize;
            if !path.insert(ptr) {
                return Err("payload contains a cycle".into());
            }
            // Array part first, then string-keyed pairs.
            let len = t.raw_len();
            let mut out = if len > 0 {
                let mut arr = Vec::with_capacity(len);
                for i in 1..=len {
                    let item: Value = t.raw_get(i).map_err(|e| e.to_string())?;
                    arr.push(lua_to_data(&item, path)?);
                }
                Data::Arr(arr)
            } else {
                Data::Map(Vec::new())
            };
            if len == 0 {
                let mut map = Vec::new();
                for pair in t.clone().pairs::<Value, Value>() {
                    let (k, val) = pair.map_err(|e| e.to_string())?;
                    let key = match k {
                        Value::String(s) => s.to_str().map_err(|e| e.to_string())?.to_owned(),
                        other => {
                            return Err(format!(
                                "payload key must be a string, got {}",
                                other.type_name()
                            ))
                        }
                    };
                    map.push((key, lua_to_data(&val, path)?));
                }
                map.sort_by(|a, b| a.0.cmp(&b.0));
                out = Data::Map(map);
            }
            path.remove(&ptr);
            Ok(out)
        }
        other => Err(format!(
            "payload must be plain data, found {}",
            other.type_name()
        )),
    }
}

fn data_to_lua(lua: &Lua, d: &Data) -> mlua::Result<Value> {
    Ok(match d {
        Data::Nil => Value::Nil,
        Data::Bool(b) => Value::Boolean(*b),
        Data::Int(i) => Value::Integer(*i),
        Data::Num(n) => Value::Number(*n),
        Data::Str(s) => Value::String(lua.create_string(s)?),
        Data::Arr(items) => {
            let t = lua.create_table()?;
            for (i, item) in items.iter().enumerate() {
                t.raw_set(i + 1, data_to_lua(lua, item)?)?;
            }
            Value::Table(t)
        }
        Data::Map(entries) => {
            let t = lua.create_table()?;
            for (k, v) in entries {
                t.raw_set(k.as_str(), data_to_lua(lua, v)?)?;
            }
            Value::Table(t)
        }
    })
}

/// Drain the pending queue. Called only when `dispatching` was false.
/// Runs the deferred-teardown epilogue before returning.
fn drain(bus: &Bus, luas: &Luas) {
    {
        let mut b = bus.borrow_mut();
        if b.dispatching {
            return; // never re-enter — callers enqueue instead
        }
        b.dispatching = true;
    }
    loop {
        let msg = bus.borrow_mut().pending.pop_front();
        let Some((topic, data)) = msg else { break };
        // Snapshot current subscribers for this topic in registration order.
        let targets: Vec<(u64, String, u64, Function, Lua)> = bus
            .borrow()
            .subs
            .iter()
            .filter(|s| s.topic == topic)
            .map(|s| (s.id, s.domain.clone(), s.gen, s.func.clone(), s.lua.clone()))
            .collect();
        for (id, domain, gen, func, lua) in targets {
            {
                let mut b = bus.borrow_mut();
                b.depth += 1;
                b.max_depth = b.max_depth.max(b.depth);
                let current_gen = b.gens.get(&domain).copied();
                let condemned = b.condemned.contains(&domain);
                if condemned || current_gen != Some(gen) {
                    b.diags.push(format!(
                        "delivery of '{topic}' to sub#{id} skipped: domain '{domain}' {}",
                        if condemned { "condemned mid-dispatch" } else { "stale generation" }
                    ));
                    b.depth -= 1;
                    continue;
                }
                drop(b);
            }
            let arg = match data_to_lua(&lua, &data) {
                Ok(v) => v,
                Err(e) => {
                    let mut b = bus.borrow_mut();
                    b.diags.push(format!("payload conversion failed: {e}"));
                    b.depth -= 1;
                    continue;
                }
            };
            // No BusState borrow is held across the call — the handler may
            // emit, subscribe, unsubscribe, or request teardown.
            if let Err(e) = func.call::<()>(arg) {
                bus.borrow_mut().diags.push(format!(
                    "subscriber #{id} ({domain}) error isolated: {}",
                    e.to_string().lines().next().unwrap_or("")
                ));
            }
            bus.borrow_mut().depth -= 1;
        }
    }
    // Epilogue: perform deferred teardowns now that no handler is executing.
    let doomed: Vec<String> = {
        let mut b = bus.borrow_mut();
        b.dispatching = false;
        b.deferred_teardown.drain(..).collect()
    };
    for name in doomed {
        teardown_now(bus, luas, &name);
    }
}

fn teardown_now(bus: &Bus, luas: &Luas, name: &str) {
    {
        let mut b = bus.borrow_mut();
        b.subs.retain(|s| s.domain != name);
        b.gens.remove(name);
        b.condemned.remove(name);
        b.logs.push(format!("[host] domain '{name}' torn down"));
    }
    luas.borrow_mut().remove(name);
}

/// Request a teardown from anywhere. Mid-dispatch: condemn now, drop later.
fn request_teardown(bus: &Bus, luas: &Luas, name: &str) {
    let defer = {
        let mut b = bus.borrow_mut();
        if !b.gens.contains_key(name) {
            b.diags.push(format!("teardown of unknown/gone domain '{name}' ignored"));
            return;
        }
        if b.dispatching {
            b.condemned.insert(name.to_owned());
            b.deferred_teardown.push(name.to_owned());
            b.logs.push(format!("[host] domain '{name}' condemned; drop deferred past dispatch"));
            true
        } else {
            false
        }
    };
    if !defer {
        teardown_now(bus, luas, name);
    }
}

fn make_domain(bus: &Bus, luas: &Luas, name: &str, source_path: &str) -> mlua::Result<()> {
    let lua = Lua::new();
    let gen = {
        let mut b = bus.borrow_mut();
        let gen = b.next_id;
        b.next_id += 1;
        b.gens.insert(name.to_owned(), gen);
        gen
    };
    let smith = lua.create_table()?;

    let (b1, n1) = (bus.clone(), name.to_owned());
    smith.set(
        "log",
        lua.create_function(move |_, msg: String| {
            b1.borrow_mut().logs.push(format!("[{n1}] {msg}"));
            Ok(())
        })?,
    )?;

    let bus_t = lua.create_table()?;
    let (b2, n2, l2) = (bus.clone(), name.to_owned(), lua.clone());
    bus_t.set(
        "on",
        lua.create_function(move |_, (topic, func): (String, Function)| {
            if !valid_topic(&topic) {
                return Err(mlua::Error::RuntimeError(format!(
                    "invalid topic '{topic}': must be <org>/<topic>, charset [a-z0-9_-]"
                )));
            }
            let mut b = b2.borrow_mut();
            let id = b.next_id;
            b.next_id += 1;
            let gen = b.gens[&n2];
            b.subs.push(Sub { id, topic, domain: n2.clone(), gen, func, lua: l2.clone() });
            Ok(id)
        })?,
    )?;

    let (b3, luas3) = (bus.clone(), luas.clone());
    bus_t.set(
        "emit",
        lua.create_function(move |_, (topic, payload): (String, Value)| {
            if !valid_topic(&topic) {
                return Err(mlua::Error::RuntimeError(format!(
                    "invalid topic '{topic}': must be <org>/<topic>, charset [a-z0-9_-]"
                )));
            }
            let data = lua_to_data(&payload, &mut HashSet::new())
                .map_err(mlua::Error::RuntimeError)?;
            let was_dispatching = {
                let mut b = b3.borrow_mut();
                b.pending.push_back((topic, data));
                if b.dispatching {
                    b.enqueued_during_dispatch += 1;
                }
                b.dispatching
            };
            if !was_dispatching {
                drain(&b3, &luas3);
            }
            Ok(())
        })?,
    )?;

    let b4 = bus.clone();
    bus_t.set(
        "off",
        lua.create_function(move |_, id: u64| {
            let mut b = b4.borrow_mut();
            let before = b.subs.len();
            b.subs.retain(|s| s.id != id);
            Ok(b.subs.len() < before)
        })?,
    )?;
    smith.set("bus", bus_t)?;

    let test_t = lua.create_table()?;
    let (b5, luas5) = (bus.clone(), luas.clone());
    test_t.set(
        "teardown",
        lua.create_function(move |_, target: String| {
            request_teardown(&b5, &luas5, &target);
            Ok(())
        })?,
    )?;
    smith.set("test", test_t)?;

    lua.globals().set("smith", smith)?;
    lua.load(&std::fs::read_to_string(source_path).expect("plugin source"))
        .set_name(source_path)
        .exec()?;
    luas.borrow_mut().insert(name.to_owned(), lua);
    let _ = gen;
    Ok(())
}

struct World {
    bus: Bus,
    luas: Luas,
}

impl World {
    fn new() -> Self {
        let bus: Bus = Rc::new(RefCell::new(BusState::default()));
        let luas: Luas = Rc::new(RefCell::new(HashMap::new()));
        make_domain(&bus, &luas, "alpha", "plugins/listener.lua").expect("alpha");
        make_domain(&bus, &luas, "beta", "plugins/emitter.lua").expect("beta");
        World { bus, luas }
    }
    fn call(&self, domain: &str, func: &str) {
        let lua = self.luas.borrow().get(domain).expect("domain").clone();
        let f: Function = lua.globals().get(func).expect("global fn");
        f.call::<()>(()).expect("scenario call");
    }
    fn call_probe(&self, domain: &str, func: &str) -> (bool, String) {
        let lua = self.luas.borrow().get(domain).expect("domain").clone();
        let f: Function = lua.globals().get(func).expect("global fn");
        let mv: MultiValue = f.call(()).expect("probe call");
        let mut it = mv.into_iter();
        let ok = matches!(it.next(), Some(Value::Boolean(true)));
        let err = match it.next() {
            Some(Value::String(s)) => s.to_str().map(|s| s.to_owned()).unwrap_or_default(),
            _ => String::new(),
        };
        (ok, err)
    }
    fn logs(&self) -> Vec<String> {
        self.bus.borrow().logs.clone()
    }
    fn diags(&self) -> Vec<String> {
        self.bus.borrow().diags.clone()
    }
}

fn check(pass: &mut bool, label: &str, ok: bool) {
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    *pass &= ok;
}

fn seq_in_order(logs: &[String], needles: &[&str]) -> bool {
    let mut idx = 0;
    for l in logs {
        if idx < needles.len() && l.contains(needles[idx]) {
            idx += 1;
        }
    }
    idx == needles.len()
}

fn scenario_order(pass: &mut bool) {
    let w = World::new();
    w.call("alpha", "setup_order_first");
    w.call("beta", "setup_order_second");
    w.call("alpha", "setup_order_third");
    let lua = w.luas.borrow().get("beta").unwrap().clone();
    let f: Function = lua.globals().get("emit_order").unwrap();
    f.call::<()>(7).unwrap();
    let logs = w.logs();
    check(pass, "order: registration order across domains, synchronous", seq_in_order(&logs, &[
        "before emit count=7",
        "sub1 count=7 tag2=y",
        "sub2 count=7",
        "sub3 count=7",
        "after emit count=7",
    ]));
    w.call("alpha", "drop_sub3");
    f.call::<()>(8).unwrap();
    let logs = w.logs();
    check(pass, "order: off() removes a subscriber",
        seq_in_order(&logs, &["sub1 count=8", "sub2 count=8"]) && !logs.iter().any(|l| l.contains("sub3 count=8")));
}

fn scenario_reentrancy(pass: &mut bool) {
    let w = World::new();
    w.call("alpha", "setup_reentry_same");
    w.call("beta", "setup_reentry_same_second");
    w.call("beta", "emit_ping");
    let logs = w.logs();
    check(pass, "reentrancy: inner same-topic emit runs AFTER current dispatch", seq_in_order(&logs, &[
        "R1 n=1", "R1 inner emit returned", "R2 n=1", "R1 n=2", "R2 n=2",
    ]));
    let b = w.bus.borrow();
    check(pass, "reentrancy: max dispatch depth is 1 (no re-entry)", b.max_depth <= 1);
    check(pass, "reentrancy: inner emits were enqueued", b.enqueued_during_dispatch >= 1);
    drop(b);

    let w2 = World::new();
    w2.call("alpha", "setup_reentry_cross");
    w2.call("beta", "setup_reentry_cross_second");
    w2.call("beta", "emit_cross");
    let logs = w2.logs();
    check(pass, "reentrancy: global FIFO across topics (b before second a)", seq_in_order(&logs, &[
        "A1 n=1", "A2 n=1", "B1 from=A1", "A1 n=2", "A2 n=2",
    ]));
}

fn scenario_error_isolation(pass: &mut bool) {
    let w = World::new();
    w.call("alpha", "setup_error_first");
    w.call("beta", "setup_error_second");
    w.call("alpha", "setup_error_third");
    w.call("beta", "emit_err");
    let logs = w.logs();
    let diags = w.diags();
    check(pass, "error-isolation: subscribers before and after the failure receive",
        seq_in_order(&logs, &["E1 got 5", "E3 got 5", "emit returned normally"]));
    check(pass, "error-isolation: failure captured as diagnostic",
        diags.iter().any(|d| d.contains("error isolated") && d.contains("boom")));
}

fn scenario_teardown(pass: &mut bool) {
    let w = World::new();
    w.call("alpha", "setup_teardown_first");
    w.call("beta", "setup_teardown_second");
    w.call("alpha", "emit_reload");
    let logs = w.logs();
    let diags = w.diags();
    // The drop is deferred past the DISPATCH (all deliveries done), and runs
    // in the drain epilogue — i.e. before emit() returns to the caller.
    check(pass, "teardown: requester's handler completes safely (T1 end logged)",
        seq_in_order(&logs, &["T1 start", "condemned; drop deferred", "T1 end", "domain 'beta' torn down", "emit_reload returned"]));
    check(pass, "teardown: condemned domain's pending delivery skipped with diagnostic",
        !logs.iter().any(|l| l.contains("T2 ran")) && diags.iter().any(|d| d.contains("condemned mid-dispatch")));
    check(pass, "teardown: drop deferred until after all deliveries (after T1 end, in the drain epilogue)", {
        let pos = |needle: &str| logs.iter().position(|l| l.contains(needle));
        matches!((pos("T1 end"), pos("torn down")), (Some(a), Some(b)) if a < b)
    });

    let w2 = World::new();
    w2.call("alpha", "setup_self_teardown");
    {
        let lua = w2.luas.borrow().get("beta").unwrap().clone();
        lua.load(r#"smith.bus.emit("acme/self", { x = 1 })"#).exec().unwrap();
    }
    let logs = w2.logs();
    check(pass, "self-teardown: handler survives its own domain's teardown request",
        seq_in_order(&logs, &["S1 requesting teardown", "S1 still executing safely", "domain 'alpha' torn down"]));
    check(pass, "self-teardown: same-dispatch sibling subscriber skipped",
        !logs.iter().any(|l| l.contains("S2 ran")));
}

fn scenario_non_data(pass: &mut bool) {
    let w = World::new();
    w.call("alpha", "setup_data_canary");
    for (probe, label, needle) in [
        ("emit_fn_payload", "function payload rejected", "function"),
        ("emit_nested_fn_payload", "nested function payload rejected", "function"),
        ("emit_thread_payload", "coroutine payload rejected", "thread"),
        ("emit_fn_key_payload", "function key rejected", "key"),
        ("emit_cyclic_payload", "cyclic payload rejected", "cycle"),
        ("emit_bad_topic", "bad-charset topic rejected", "invalid topic"),
        ("emit_unnamespaced_topic", "unnamespaced topic rejected", "invalid topic"),
        ("on_bad_topic", "subscribe to bad topic rejected", "invalid topic"),
    ] {
        let (ok, err) = w.call_probe("beta", probe);
        check(pass, &format!("non-data: {label}"), !ok && err.contains(needle));
    }
    w.call("beta", "emit_good_payload");
    check(pass, "non-data: plain data payload delivers with structure intact",
        w.logs().iter().any(|l| l.contains("canary got kind=good list_len=3 flag=true")));
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut pass = true;
    match scenario.as_str() {
        "order" => scenario_order(&mut pass),
        "reentrancy" => scenario_reentrancy(&mut pass),
        "error-isolation" => scenario_error_isolation(&mut pass),
        "teardown-mid-dispatch" => scenario_teardown(&mut pass),
        "non-data" => scenario_non_data(&mut pass),
        "all" => {
            scenario_order(&mut pass);
            scenario_reentrancy(&mut pass);
            scenario_error_isolation(&mut pass);
            scenario_teardown(&mut pass);
            scenario_non_data(&mut pass);
        }
        other => {
            println!("unknown scenario {other}");
            pass = false;
        }
    }
    println!();
    if pass {
        println!("p23 RESULT: scenario '{scenario}' holds");
        Ok(())
    } else {
        Err(format!("p23 RESULT: scenario '{scenario}' failed").into())
    }
}
