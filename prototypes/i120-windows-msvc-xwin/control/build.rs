fn main() {
    // The `cc` crate reads the target and cargo-xwin's clang-cl env, so this C
    // file compiles for the MSVC ABI without a Windows-native cl.exe.
    cc::Build::new().file("src/csum.c").compile("csum");
    println!("cargo:rerun-if-changed=src/csum.c");
}
