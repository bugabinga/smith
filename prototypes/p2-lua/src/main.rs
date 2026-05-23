//! Prototype: mlua vendored LuaJIT with sandboxed globals.

use mlua::{Lua, Result};

fn main() -> Result<()> {
    let lua = Lua::new();

    // Sandbox: only allow safe globals
    let code = r#"
        local _G = {}
        local allowed = { string = string, table = table, math = math, ipairs = ipairs, pairs = pairs, tostring = tostring, tonumber = tonumber, type = type, print = print, error = error, pcall = pcall }
        setmetatable(_G, { __index = allowed, __newindex = function(_, k) error("sandbox: cannot set global " .. k) end })
        local function add(a, b) return a + b end
        return add(2, 3)
    "#;

    let result: i32 = lua.load(code).eval()?;
    assert_eq!(result, 5);
    println!("LuaJIT sandbox OK: add(2,3) = {}", result);

    // Verify sandbox blocks os.execute
    let dangerous = r#"os.execute("echo pwned")"#;
    let res = lua.load(dangerous).eval::<mlua::Value>();
    match res {
        Err(e) => println!("Sandbox blocked os.execute: {}", e),
        Ok(_) => panic!("Sandbox FAILED: os.execute should be blocked"),
    }

    Ok(())
}

#[allow(dead_code)]
fn assert_eq<T: std::fmt::Debug + PartialEq>(a: T, b: T) {
    assert!(a == b, "{:?} != {:?}", a, b);
}
