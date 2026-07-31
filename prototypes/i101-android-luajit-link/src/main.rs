//! Force the vendored LuaJIT runtime to be pulled into the link.
//!
//! Creating a `Lua` and running code touches LuaJIT's interpreter and its
//! trace/mcode machinery. On aarch64 that machinery references the
//! compiler-rt builtin `__clear_cache` (instruction-cache flush after LuaJIT
//! writes machine code). Bionic does not carry that builtin (SPEC §14), so the
//! link only resolves when `libclang_rt.builtins-aarch64-android` is supplied
//! via the `.cargo/config.toml` flag (SPEC §3.2). This binary is the payload
//! whose successful cross-link is the proof; it is not run on the host.
use mlua::Lua;

fn main() -> mlua::Result<()> {
    let lua = Lua::new();
    let sum: i64 = lua
        .load("local t = 0 for i = 1, 1000 do t = t + i end return t")
        .eval()?;
    // Reference __clear_cache-adjacent paths again via string libs.
    let jit: String = lua.load("return tostring(jit and jit.version)").eval()?;
    println!("sum={sum} jit={jit}");
    assert_eq!(sum, 500_500);
    Ok(())
}
