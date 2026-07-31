//! Control binary: Rust + a `cc`-compiled C function, cross-built to MSVC.
//! Its purpose is to succeed where the LuaJIT crate fails, proving the
//! cargo-xwin toolchain itself is capable of MSVC-ABI C cross-compilation.

extern "C" {
    fn csum_1_to(n: i64) -> i64;
}

fn main() {
    let s = unsafe { csum_1_to(100) };
    assert_eq!(s, 5050);
    println!("smith i120 control: csum(1..100)={s}");
}
