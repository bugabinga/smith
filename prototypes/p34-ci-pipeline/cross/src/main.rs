// Minimal exercise of the two native trees so the cross-build actually links
// and runs the C code, not just compiles a stub. Prints proof the vendored
// LuaJIT VM initialized and gix's object hashing is reachable on the target.

fn main() {
    let lua = mlua::Lua::new();
    let v: String = lua
        .load("return _VERSION .. ' ok'")
        .eval()
        .expect("luajit eval");
    println!("lua: {v}");

    // Touch gix so its object/hash code is linked into the target binary.
    let oid = gix::hash::ObjectId::empty_blob(gix::hash::Kind::Sha1);
    println!("gix empty-blob oid: {oid}");
}
