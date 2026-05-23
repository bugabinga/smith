//! P2d: Vendored (static) LuaJIT on ARM64/Android.

fn main() {
    let lua = mlua::Lua::new();
    let val: i32 = lua.load("return 1 + 1").eval().unwrap();
    println!("luajit vendored: 1+1 = {val}");

    // Test JIT is actually working
    let code = r#"
        local function add(a, b) return a + b end
        local sum = 0
        for i = 1, 100000 do sum = add(sum, i) end
        return sum
    "#;
    let sum: i64 = lua.load(code).eval().unwrap();
    println!("luajit vendored JIT: sum(1..100000) = {sum}");
    println!("PASS: vendored (static) LuaJIT works on ARM64/Android");
}
