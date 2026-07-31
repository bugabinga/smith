//! Minimal program that links and drives vendored LuaJIT through mlua.
//!
//! The point of the prototype is the *cross-build*: producing this binary for
//! `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` from a Linux host
//! forces the whole chain — Rust MSVC codegen, clang-cl compiling the LuaJIT C
//! sources, lld-link against Microsoft's CRT/SDK — to complete. Running it (on
//! the host or under an emulator) is a bonus sanity check, not the proof; the
//! proof is that the MSVC-ABI PE binaries exist and import the MSVC runtime.
//!
//! It exercises LuaJIT specifically (reads the `jit` table's version) so a
//! successful link cannot be a plain-PUC-Lua or stub build.

use mlua::Lua;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let lua = Lua::new();

    // Arithmetic through the VM proves the interpreter is live, not just linked.
    let sum: i64 = lua.load("local s = 0 for i = 1, 100 do s = s + i end return s").eval()?;
    assert_eq!(sum, 5050, "LuaJIT arithmetic returned the wrong value");

    // `jit.version` only exists on LuaJIT; PUC Lua has no `jit` table. Reading it
    // proves the vendored build that got statically linked is genuinely LuaJIT.
    let jit_version: String = lua.load("return jit and jit.version or 'NO-JIT'").eval()?;
    assert!(jit_version.starts_with("LuaJIT"), "expected LuaJIT, got {jit_version}");

    println!("smith i120: {jit_version}; sum(1..100)={sum}");
    Ok(())
}
