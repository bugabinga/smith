//! Prototype P2b: mlua vendored Lua 5.4 sandbox on Android/Termux.
//! Validates SM-009 Lua plugin architecture with actual Lua execution.
//!
//! P2 used LuaJIT which fails to link on Android (__clear_cache).
//! P2b uses Lua 5.4 (pure C) which should compile+link+run everywhere.
//!
//! Tests:
//! 1. Basic eval and return values
//! 2. Sandboxed globals (block os.execute, io.open)
//! 3. Lua table → Rust deserialization (mlua serialize)
//! 4. Rust → Lua value passing
//! 5. Coroutine creation and resume
//! 6. Error propagation Lua → Rust

use mlua::{Lua, Result, Value};
use std::time::Instant;

fn main() -> Result<()> {
    let lua = Lua::new();

    // === Test 1: Basic eval ===
    test_basic_eval(&lua)?;
    // === Test 2: Sandbox globals ===
    test_sandbox(&lua)?;
    // === Test 3: Table serialization ===
    test_table_serialize(&lua)?;
    // === Test 4: Rust → Lua values ===
    test_rust_to_lua(&lua)?;
    // === Test 5: Coroutines ===
    test_coroutines(&lua)?;
    // === Test 6: Error propagation ===
    test_error_propagation(&lua)?;

    // === Test 7: Coroutine benchmark ===
    bench_coroutines(&lua)?;

    eprintln!();
    eprintln!("=== ALL P2b TESTS PASSED (7/7) ===");
    Ok(())
}

fn test_basic_eval(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 1: Basic eval ---");
    let result: i32 = lua.load("return 2 + 3").eval()?;
    assert_eq!(result, 5);
    eprintln!("[OK] eval: 2+3 = {}", result);

    let s: String = lua.load("return 'hello'").eval()?;
    assert_eq!(s, "hello");
    eprintln!("[OK] eval string: {:?}", s);
    Ok(())
}

fn test_sandbox(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 2: Sandbox globals ---");

    // Setup sandbox: override os and io with stubs
    lua.load(r#"
        local raw_os = os
        local raw_io = io
        local blocked = { execute = true, exit = true, remove = true, rename = true }
        os = setmetatable({}, {
            __index = function(_, k)
                if blocked[k] then return nil end
                return raw_os[k]
            end,
            __newindex = function(_, k) error("sandbox: cannot set os." .. k) end
        })
        local io_blocked = { open = true, popen = true, read = true, write = true }
        io = setmetatable({}, {
            __index = function(_, k)
                if io_blocked[k] then return nil end
                return raw_io[k]
            end,
            __newindex = function(_, k) error("sandbox: cannot set io." .. k) end
        })
    "#).exec()?;

    // Verify os.execute is blocked
    let res = lua.load(r#"return os.execute("echo pwned")"#).eval::<Value>();
    match res {
        Err(_) => eprintln!("[OK] sandbox blocked os.execute"),
        Ok(v) => panic!("Sandbox FAILED: os.execute returned {:?}", v),
    }

    // Verify io.open is blocked
    let res = lua.load(r#"return io.open("/etc/passwd", "r")"#).eval::<Value>();
    match res {
        Err(_) => eprintln!("[OK] sandbox blocked io.open"),
        Ok(v) => panic!("Sandbox FAILED: io.open returned {:?}", v),
    }

    // Verify safe operations still work
    let result: i32 = lua.load(r#"return math.floor(3.7)"#).eval()?;
    assert_eq!(result, 3);
    eprintln!("[OK] sandbox allows math.floor(3.7) = {}", result);

    Ok(())
}

fn test_table_serialize(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 3: Table serialization ---");
    let code = r#"return { name = "test", count = 42, items = {1, 2, 3} }"#;
    let val: Value = lua.load(code).eval()?;

    let tbl = match &val {
        Value::Table(t) => t.clone(),
        _ => panic!("Expected table, got {:?}", val),
    };

    let name: String = tbl.get("name")?;
    let count: i32 = tbl.get("count")?;
    assert_eq!(name, "test");
    assert_eq!(count, 42);
    eprintln!("[OK] table: name={:?}, count={}", name, count);

    // mlua serialize: Lua table → serde_json Value (via intermediate)
    let lua_tbl: mlua::Table = lua.load(code).eval()?;
    // Convert table to serde Value via manual extraction
    let json_name: String = lua_tbl.get("name")?;
    let json_count: i32 = lua_tbl.get("count")?;
    let json_items: mlua::Table = lua_tbl.get("items")?;
    let mut items = Vec::new();
    for pair in json_items.sequence_values::<i32>() {
        items.push(pair?);
    }
    let json_val = serde_json::json!({
        "name": json_name,
        "count": json_count,
        "items": items
    });
    assert_eq!(json_val["name"], "test");
    assert_eq!(json_val["count"], 42);
    eprintln!("[OK] serde roundtrip: {:?}", json_val);
    Ok(())
}

fn test_rust_to_lua(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 4: Rust → Lua values ---");
    let globals = lua.globals();

    let data = lua.create_table()?;
    data.set("key", "value")?;
    data.set("num", 99)?;
    globals.set("rust_data", data)?;

    let key: String = lua.load(r#"return rust_data.key"#).eval()?;
    let num: i32 = lua.load(r#"return rust_data.num"#).eval()?;
    assert_eq!(key, "value");
    assert_eq!(num, 99);
    eprintln!("[OK] rust→lua: key={:?}, num={}", key, num);
    Ok(())
}

fn test_coroutines(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 5: Coroutines ---");
    let gen_fn: mlua::Function = lua.load(r#"
        local function gen(n)
            local co = coroutine.create(function()
                for i = 1, n do coroutine.yield(i) end
            end)
            local results = {}
            while true do
                local ok, val = coroutine.resume(co)
                if not ok or not val then break end
                results[#results + 1] = val
            end
            return results
        end
        return gen
    "#).eval()?;

    let results: Vec<i32> = gen_fn.call(3)?;
    assert_eq!(results, vec![1, 2, 3]);
    eprintln!("[OK] coroutine generator: {:?}", results);
    Ok(())
}

fn test_error_propagation(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 6: Error propagation ---");
    let res = lua.load(r#"error("code=42 msg=boom")"#).eval::<Value>();
    match res {
        Err(e) => {
            let msg = e.to_string();
            assert!(msg.contains("42"), "error should contain code 42, got: {}", msg);
            assert!(msg.contains("boom"), "error should contain boom, got: {}", msg);
            eprintln!("[OK] error propagated: {}", msg);
        }
        Ok(v) => panic!("Expected error, got {:?}", v),
    }
    Ok(())
}

#[allow(dead_code)]
fn assert_eq<T: std::fmt::Debug + PartialEq>(a: T, b: T) {
    assert!(a == b, "assertion failed: {:?} != {:?}", a, b);
}

fn bench_coroutines(lua: &Lua) -> Result<()> {
    eprintln!("--- Test 7: Coroutine benchmark ---");

    let warmup: Vec<i32> = lua.load(r#"
        local function gen(n)
            local co = coroutine.create(function()
                for i = 1, n do coroutine.yield(i) end
            end)
            local results = {}
            while true do
                local ok, val = coroutine.resume(co)
                if not ok or not val then break end
                results[#results + 1] = val
            end
            return results
        end
        return gen(100)
    "#).eval()?;
    assert_eq!(warmup.len(), 100);

    let n = 100_000;
    let bench_fn: mlua::Function = lua.load(r#"
        local function bench(n)
            local total = 0
            for _ = 1, n do
                local co = coroutine.create(function()
                    coroutine.yield(1)
                    coroutine.yield(2)
                    coroutine.yield(3)
                end)
                local ok, v = coroutine.resume(co)
                if ok then total = total + v end
                ok, v = coroutine.resume(co)
                if ok then total = total + v end
                ok, v = coroutine.resume(co)
                if ok then total = total + v end
            end
            return total
        end
        return bench
    "#).eval()?;

    let start = Instant::now();
    let total: i64 = bench_fn.call(n)?;
    let elapsed = start.elapsed();

    assert_eq!(total, n as i64 * 6);
    let us_per_yield = elapsed.as_micros() as f64 / (n as f64 * 3.0);
    eprintln!("[OK] {} coroutines × 3 yields = {} total in {:?}", n, total, elapsed);
    eprintln!("[OK] {:.2} μs per yield", us_per_yield);
    Ok(())
}
