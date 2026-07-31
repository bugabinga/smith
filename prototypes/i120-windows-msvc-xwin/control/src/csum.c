/* Trivial C translation unit compiled by the `cc` crate, to prove cargo-xwin
 * cross-compiles C to the MSVC ABI. The `cc` crate honours cargo-xwin's
 * clang-cl/target env, unlike luajit-src's msvcbuild.bat path. */
long long csum_1_to(long long n) {
    long long s = 0;
    for (long long i = 1; i <= n; i++) s += i;
    return s;
}
