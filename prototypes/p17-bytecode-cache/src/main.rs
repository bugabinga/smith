//! p17-bytecode-cache
//!
//! Proves or disproves docs/SPEC.md §5.5 (Bytecode cache):
//!   - Smith compiles `.lua` to bytecode on first load.
//!   - Cache key includes source hash.
//!   - Smith never loads bytecode it did not compile.
//!
//! Investigated in order:
//!   1. Does `Function::dump` exist and work under mlua 0.10 + luajit + vendored?
//!   2. Does `lua.load` of dumped bytecode work (ChunkMode gating)?
//!   3. Full roundtrip through an on-disk cache keyed by sha256(source) + version tag.
//!   4. MEASUREMENT: is the cache worth anything? LuaJIT compiles fast; a null
//!      result is a valid disproof of the cache's premise.
//!
//! Safety probe: LuaJIT has NO bytecode verifier. Corrupted/hostile bytecode is
//! fed to `lua.load` in a SUBPROCESS so a segfault/abort is observed and
//! reported instead of killing the harness. That crash evidence is exactly why
//! "never loads bytecode it did not compile" must be enforced BEFORE lua.load.
//!
//! Verify (each exits 0 with PASS lines + measured numbers):
//!   cargo run -- roundtrip
//!   cargo run -- stale-invalidation
//!   cargo run -- foreign-rejected
//!   cargo run -- all

use mlua::{ChunkMode, Function, Lua};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Cache format
//
// Provenance mechanism (what makes "never loads foreign bytecode" enforceable):
//   1. The cache dir is created and owned by smith (0700 on unix here);
//      nothing else is expected to write into it.
//   2. Filenames are derived, never attacker-chosen: lookup for source S under
//      version tag T only ever opens `<hex(sha256(S))>.<hex8(sha256(T))>.smithbc`.
//   3. Every file carries a header written only by this process:
//      magic | version tag | sha256(source) | sha256(payload) | payload len.
//      All header fields are re-verified against the CURRENT source and tag
//      before the payload is allowed anywhere near lua.load.
//   4. Any mismatch (magic, tag, source hash, payload hash, length) rejects the
//      file BEFORE lua.load and falls back to compiling from source.
// ---------------------------------------------------------------------------

const MAGIC: &[u8; 8] = b"SMITHBC\x01";

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Version tag: smith version + LuaJIT version. LuaJIT bytecode is
/// version-fragile, so the runtime version must be part of the key.
fn version_tag(lua: &Lua) -> String {
    let jit: String = lua
        .load("return (jit and jit.version) or _VERSION")
        .eval()
        .unwrap_or_else(|_| "unknown".into());
    format!("smith-proto-{}/{}", env!("CARGO_PKG_VERSION"), jit)
}

#[derive(Debug, PartialEq)]
enum Rejection {
    BadMagic,
    WrongVersionTag { found: String },
    SourceHashMismatch,
    PayloadHashMismatch,
    Truncated,
}

struct CacheStats {
    compiles: u32,
    hits: u32,
    binary_loads: u32, // times bytecode actually reached lua.load
    rejections: Vec<Rejection>,
}

struct BytecodeCache {
    dir: PathBuf,
    tag: String,
    stats: CacheStats,
}

impl BytecodeCache {
    fn new(dir: &Path, tag: &str) -> Self {
        fs::create_dir_all(dir).expect("create cache dir");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        BytecodeCache {
            dir: dir.to_path_buf(),
            tag: tag.to_string(),
            stats: CacheStats { compiles: 0, hits: 0, binary_loads: 0, rejections: Vec::new() },
        }
    }

    /// Cache key = sha256(source) + version tag, both in the filename.
    fn path_for(&self, source: &[u8]) -> PathBuf {
        self.path_for_hash(&sha256(source))
    }

    fn path_for_hash(&self, source_hash: &[u8; 32]) -> PathBuf {
        let tag = hex(&sha256(self.tag.as_bytes()));
        self.dir.join(format!("{}.{}.smithbc", hex(source_hash), &tag[..8]))
    }

    fn encode(&self, source_hash: &[u8; 32], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(payload.len() + 128);
        out.extend_from_slice(MAGIC);
        let tag = self.tag.as_bytes();
        out.extend_from_slice(&(tag.len() as u32).to_le_bytes());
        out.extend_from_slice(tag);
        out.extend_from_slice(source_hash);
        out.extend_from_slice(&sha256(payload));
        out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Verify provenance. Returns the payload only if every field matches the
    /// current source + tag. This runs BEFORE lua.load ever sees the bytes.
    fn verify(&self, file: &[u8], source_hash: &[u8; 32]) -> Result<Vec<u8>, Rejection> {
        let mut at = 0usize;
        let take = |at: &mut usize, n: usize| -> Result<&[u8], Rejection> {
            if *at + n > file.len() {
                return Err(Rejection::Truncated);
            }
            let s = &file[*at..*at + n];
            *at += n;
            Ok(s)
        };
        if take(&mut at, 8)? != MAGIC {
            return Err(Rejection::BadMagic);
        }
        let tag_len = u32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap()) as usize;
        if tag_len > 4096 {
            return Err(Rejection::Truncated);
        }
        let tag = take(&mut at, tag_len)?.to_vec();
        if tag != self.tag.as_bytes() {
            return Err(Rejection::WrongVersionTag { found: String::from_utf8_lossy(&tag).into() });
        }
        if take(&mut at, 32)? != source_hash {
            return Err(Rejection::SourceHashMismatch);
        }
        let payload_hash: [u8; 32] = take(&mut at, 32)?.try_into().unwrap();
        let payload_len = u64::from_le_bytes(take(&mut at, 8)?.try_into().unwrap()) as usize;
        let payload = take(&mut at, payload_len)?.to_vec();
        if at != file.len() {
            return Err(Rejection::Truncated); // trailing garbage
        }
        if sha256(&payload) != payload_hash {
            return Err(Rejection::PayloadHashMismatch);
        }
        Ok(payload)
    }

    /// The §5.5 load path: cache hit (verified) → load bytecode; otherwise
    /// compile from source (ChunkMode::Text, so source can never smuggle
    /// bytecode) and populate the cache.
    fn load(&mut self, lua: &Lua, name: &str, source: &str) -> mlua::Result<Function> {
        let source_hash = sha256(source.as_bytes());
        let path = self.path_for_hash(&source_hash);
        if let Ok(file) = fs::read(&path) {
            match self.verify(&file, &source_hash) {
                Ok(payload) => {
                    self.stats.hits += 1;
                    self.stats.binary_loads += 1;
                    return lua
                        .load(&payload[..])
                        .set_name(name)
                        .set_mode(ChunkMode::Binary)
                        .into_function();
                }
                Err(rej) => self.stats.rejections.push(rej),
            }
        }
        // Compile from source. ChunkMode::Text: a .lua file that actually
        // contains bytecode must be rejected, not silently loaded (mlua's
        // default mode is "bt" — it would accept binary!).
        let f = lua
            .load(source)
            .set_name(name)
            .set_mode(ChunkMode::Text)
            .into_function()?;
        self.stats.compiles += 1;
        let payload = f.dump(true);
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, self.encode(&source_hash, &payload)).expect("write cache tmp");
        fs::rename(&tmp, &path).expect("atomic rename into cache");
        Ok(f)
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODULE_V1: &str = r#"
local M = {}
function M.version() return "v1" end
function M.greet(name) return "hello, " .. name end
function M.sum(n)
  local acc = 0
  for i = 1, n do acc = acc + i end
  return acc
end
return M
"#;

const MODULE_V2: &str = r#"
local M = {}
function M.version() return "v2" end
function M.greet(name) return "hello, " .. name end
function M.sum(n)
  local acc = 0
  for i = 1, n do acc = acc + i end
  return acc
end
return M
"#;

/// Generate a realistically sized plugin-ish Lua module (~2000 lines):
/// many small handler functions, string formatting, table constructors,
/// a dispatch table — the shape of a real smith plugin, not a toy loop.
fn big_module() -> String {
    let mut s = String::with_capacity(120_000);
    s.push_str("local M = {}\nlocal handlers = {}\n");
    for i in 0..160 {
        s.push_str(&format!(
            r#"
function M.handler_{i}(ev)
  local parts = {{}}
  for k = 1, 8 do
    parts[k] = string.format("%s:%d:%d", ev.kind or "none", k, {i})
  end
  local joined = table.concat(parts, "|")
  local acc = 0
  for k = 1, #joined do
    acc = (acc + string.byte(joined, k) * {i}) % 65521
  end
  return {{ id = {i}, tag = "handler_{i}", checksum = acc, text = joined }}
end
handlers[{i} + 1] = M.handler_{i}
"#
        ));
    }
    s.push_str(
        r#"
function M.dispatch(ev)
  local total = 0
  for _, h in ipairs(handlers) do
    local r = h(ev)
    total = (total + r.checksum) % 65521
  end
  return total
end
return M
"#,
    );
    s
}

fn scratch_dir() -> PathBuf {
    let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/p17-scratch");
    fs::create_dir_all(&d).expect("scratch dir");
    d
}

fn fresh_cache_dir(name: &str) -> PathBuf {
    let d = scratch_dir().join(name);
    let _ = fs::remove_dir_all(&d);
    d
}

fn call_module(lua: &Lua, f: &Function) -> (String, String, i64) {
    let m: mlua::Table = f.call(()).expect("module chunk returns table");
    let version: String = m.get::<Function>("version").unwrap().call(()).unwrap();
    let greet: String = m.get::<Function>("greet").unwrap().call("smith").unwrap();
    let sum: i64 = m.get::<Function>("sum").unwrap().call(100).unwrap();
    let _ = lua;
    (version, greet, sum)
}

fn pass(msg: &str) {
    println!("PASS: {msg}");
}

// ---------------------------------------------------------------------------
// Scenario: roundtrip (+ measurement)
// ---------------------------------------------------------------------------

fn roundtrip() {
    println!("== roundtrip ==");
    let dir = fresh_cache_dir("roundtrip");

    // (1) Function::dump availability under luajit+vendored.
    let lua = Lua::new();
    let tag = version_tag(&lua);
    println!("version tag: {tag}");
    let f = lua
        .load(MODULE_V1)
        .set_mode(ChunkMode::Text)
        .into_function()
        .expect("compile from source");
    let dumped = f.dump(true);
    assert!(!dumped.is_empty(), "dump returned empty bytecode");
    assert_eq!(&dumped[..3], b"\x1bLJ", "LuaJIT bytecode signature (ESC 'L' 'J')");
    pass(&format!(
        "Function::dump works under mlua 0.10 + luajit + vendored: {} bytes, signature 1b 4c 4a ('\\x1bLJ')",
        dumped.len()
    ));

    // (2) lua.load of dumped bytecode: ChunkMode gating.
    let via_bc = lua
        .load(&dumped[..])
        .set_mode(ChunkMode::Binary)
        .into_function()
        .expect("load binary chunk");
    let (v, _, _) = call_module(&lua, &via_bc);
    assert_eq!(v, "v1");
    pass("lua.load(bytecode).set_mode(ChunkMode::Binary) loads and executes");

    // mlua's DEFAULT mode is None => luaL_loadbufferx mode \"bt\": binary is
    // auto-detected and ACCEPTED. Demonstrate, then show Text-mode rejects it.
    lua.load(&dumped[..])
        .into_function()
        .expect("default mode auto-accepts binary chunks");
    let err = lua
        .load(&dumped[..])
        .set_mode(ChunkMode::Text)
        .into_function()
        .expect_err("Text mode must reject a binary chunk");
    pass(&format!(
        "default lua.load mode is 'bt' (accepts foreign bytecode!); ChunkMode::Text rejects it: {}",
        first_line(&err.to_string())
    ));

    // (3) Full roundtrip through the on-disk cache into a FRESH Lua state.
    let mut cache_a = BytecodeCache::new(&dir, &tag);
    let lua_a = Lua::new();
    let fa = cache_a.load(&lua_a, "mod_v1", MODULE_V1).unwrap();
    let res_a = call_module(&lua_a, &fa);
    assert_eq!(cache_a.stats.compiles, 1, "first load compiles");
    assert_eq!(cache_a.stats.hits, 0);

    let lua_b = Lua::new(); // fresh state, fresh cache handle: only the file survives
    let mut cache_b = BytecodeCache::new(&dir, &version_tag(&lua_b));
    let fb = cache_b.load(&lua_b, "mod_v1", MODULE_V1).unwrap();
    let res_b = call_module(&lua_b, &fb);
    assert_eq!(cache_b.stats.compiles, 0, "second load must not compile");
    assert_eq!(cache_b.stats.hits, 1, "second load is a cache hit");
    assert_eq!(res_a, res_b, "bytecode behavior == source behavior");
    pass(&format!(
        "roundtrip: compile→dump→cache file→fresh Lua state→load bytecode→execute; identical results {res_a:?}; compiles={},hits={}",
        cache_b.stats.compiles, cache_b.stats.hits
    ));

    // (4) MEASUREMENT — is the cache worth anything?
    measure(&dir);
}

fn measure(dir: &Path) {
    println!("-- measurement: compile-from-source vs load-from-bytecode --");
    let src = big_module();
    let lines = src.lines().count();
    println!("module: {} lines, {} bytes of Lua source", lines, src.len());

    let lua = Lua::new();
    let tag = version_tag(&lua);

    // Correctness first: source and bytecode agree on the big module.
    let f_src = lua.load(&src).set_mode(ChunkMode::Text).into_function().unwrap();
    let bytecode = f_src.dump(true);
    println!("bytecode size (stripped): {} bytes ({:.1}% of source)", bytecode.len(), 100.0 * bytecode.len() as f64 / src.len() as f64);
    let m_src: mlua::Table = f_src.call(()).unwrap();
    let d_src: i64 = m_src.get::<Function>("dispatch").unwrap().call(lua.create_table().unwrap()).unwrap();
    let f_bc = lua.load(&bytecode[..]).set_mode(ChunkMode::Binary).into_function().unwrap();
    let m_bc: mlua::Table = f_bc.call(()).unwrap();
    let d_bc: i64 = m_bc.get::<Function>("dispatch").unwrap().call(lua.create_table().unwrap()).unwrap();
    assert_eq!(d_src, d_bc, "big module: source vs bytecode dispatch checksum");
    pass(&format!("2000-line module: source and bytecode execution agree (dispatch checksum {d_src})"));

    const N: u32 = 200;
    // Warmup.
    for _ in 0..10 {
        let _ = lua.load(&src).set_mode(ChunkMode::Text).into_function().unwrap();
        let _ = lua.load(&bytecode[..]).set_mode(ChunkMode::Binary).into_function().unwrap();
    }

    let t = Instant::now();
    for _ in 0..N {
        let f = lua.load(&src).set_mode(ChunkMode::Text).into_function().unwrap();
        std::hint::black_box(&f);
    }
    let compile_total = t.elapsed();

    let t = Instant::now();
    for _ in 0..N {
        let f = lua.load(&bytecode[..]).set_mode(ChunkMode::Binary).into_function().unwrap();
        std::hint::black_box(&f);
    }
    let bcload_total = t.elapsed();

    let t = Instant::now();
    for _ in 0..N {
        std::hint::black_box(sha256(src.as_bytes()));
    }
    let hash_total = t.elapsed();

    // The REAL cache path also pays: hash + open/read + header verify.
    let mut cache = BytecodeCache::new(dir, &tag);
    let _ = cache.load(&lua, "big", &src); // prime
    let t = Instant::now();
    for _ in 0..N {
        let f = cache.load(&lua, "big", &src).unwrap();
        std::hint::black_box(&f);
    }
    let cachepath_total = t.elapsed();
    assert_eq!(cache.stats.compiles, 1, "bench loop must be all cache hits");

    let per = |d: std::time::Duration| d.as_micros() as f64 / N as f64;
    let c = per(compile_total);
    let b = per(bcload_total);
    let h = per(hash_total);
    let full = per(cachepath_total);
    println!("MEASURED over N={N} iterations ({} lines):", lines);
    println!("  compile from source        : {c:>8.1} us/load");
    println!("  load stripped bytecode     : {b:>8.1} us/load");
    println!("  sha256(source) (key cost)  : {h:>8.1} us/load");
    println!("  full cache path (hash+read+verify+load): {full:>8.1} us/load");
    println!("  raw speedup compile/bytecode: {:.2}x; net saving vs full cache path: {:.1} us/load", c / b, c - full);
    let verdict = if c - full < 500.0 {
        "NEGLIGIBLE: per-plugin saving is well under a millisecond — LuaJIT parses fast; the cache buys ~nothing at plugin scale"
    } else {
        "MATERIAL: cache saves >0.5ms per module load"
    };
    println!("VERDICT: {verdict}");
    pass(&format!(
        "measured: compile={c:.1}us, bytecode-load={b:.1}us, full-cache-path={full:.1}us per load (N={N}); net saving {:.1}us/module",
        c - full
    ));
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or(s)
}

// ---------------------------------------------------------------------------
// Scenario: stale-invalidation
// ---------------------------------------------------------------------------

fn stale_invalidation() {
    println!("== stale-invalidation ==");
    let dir = fresh_cache_dir("stale");
    let lua = Lua::new();
    let tag = version_tag(&lua);
    let mut cache = BytecodeCache::new(&dir, &tag);

    // Load v1 twice: compile once, then hit.
    let f1 = cache.load(&lua, "mod", MODULE_V1).unwrap();
    assert_eq!(call_module(&lua, &f1).0, "v1");
    let f1b = cache.load(&lua, "mod", MODULE_V1).unwrap();
    assert_eq!(call_module(&lua, &f1b).0, "v1");
    assert_eq!((cache.stats.compiles, cache.stats.hits), (1, 1));
    let v1_path = cache.path_for(MODULE_V1.as_bytes());
    pass("v1: first load compiled (compiles=1), second load hit cache (hits=1)");

    // Edit the source → different hash → the v1 entry must NOT be used.
    let binary_loads_before = cache.stats.binary_loads;
    let f2 = cache.load(&lua, "mod", MODULE_V2).unwrap();
    let v2 = call_module(&lua, &f2);
    assert_eq!(v2.0, "v2", "edited source must yield v2 behavior — stale bytecode would say v1");
    assert_eq!(cache.stats.compiles, 2, "hash mismatch forces recompile");
    assert_eq!(cache.stats.hits, 1, "no cache hit for edited source");
    assert_eq!(
        cache.stats.binary_loads, binary_loads_before,
        "stale bytecode never reached lua.load (binary_loads unchanged)"
    );
    assert!(v1_path.exists(), "stale v1 entry still on disk — present but not consulted");
    pass("edit source → sha256 key mismatch → recompiled; stale v1 bytecode present on disk but NEVER passed to lua.load; result is v2");

    // Adversarial staleness: overwrite v2's cache entry with the v1 cache FILE
    // (stale bytecode planted at the current key path). The header source-hash
    // check must reject it before lua.load.
    let v2_path = cache.path_for(MODULE_V2.as_bytes());
    fs::copy(&v1_path, &v2_path).unwrap();
    let binary_loads_before = cache.stats.binary_loads;
    let f2 = cache.load(&lua, "mod", MODULE_V2).unwrap();
    assert_eq!(call_module(&lua, &f2).0, "v2");
    assert_eq!(cache.stats.binary_loads, binary_loads_before, "planted stale file never reached lua.load");
    assert!(
        matches!(cache.stats.rejections.last(), Some(Rejection::SourceHashMismatch)),
        "rejected with SourceHashMismatch, got {:?}",
        cache.stats.rejections.last()
    );
    pass("v1 cache file planted AT v2's key path → header source-hash mismatch → rejected BEFORE lua.load → recompiled to v2");
}

// ---------------------------------------------------------------------------
// Scenario: foreign-rejected
// ---------------------------------------------------------------------------

fn foreign_rejected() {
    println!("== foreign-rejected ==");
    let dir = fresh_cache_dir("foreign");
    let lua = Lua::new();
    let tag = version_tag(&lua);
    let mut cache = BytecodeCache::new(&dir, &tag);

    // Prime a valid entry.
    let _ = cache.load(&lua, "mod", MODULE_V1).unwrap();
    let path = cache.path_for(MODULE_V1.as_bytes());
    let valid = fs::read(&path).unwrap();

    // Case A: tampered payload bytes (bit flip deep in the bytecode).
    let mut tampered = valid.clone();
    let n = tampered.len();
    tampered[n - 16] ^= 0xff;
    fs::write(&path, &tampered).unwrap();
    let before = cache.stats.binary_loads;
    let f = cache.load(&lua, "mod", MODULE_V1).unwrap();
    assert_eq!(call_module(&lua, &f).0, "v1");
    assert_eq!(cache.stats.binary_loads, before, "tampered payload never reached lua.load");
    assert!(matches!(cache.stats.rejections.last(), Some(Rejection::PayloadHashMismatch)));
    pass("tampered bytecode (bit flip): payload sha256 mismatch → rejected BEFORE lua.load → recompiled from source");

    // Case B: wrong version tag — a well-formed file produced by a "different
    // smith/LuaJIT", planted at the current key path. Internally consistent
    // (hashes valid for ITS tag) but the tag differs.
    let foreign_tag = "smith-proto-9.9.9/LuaJIT 0.0.0-foreign";
    let foreign_cache = BytecodeCache::new(&dir, foreign_tag);
    let payload = lua
        .load(MODULE_V1)
        .set_mode(ChunkMode::Text)
        .into_function()
        .unwrap()
        .dump(true);
    let foreign_file = foreign_cache.encode(&sha256(MODULE_V1.as_bytes()), &payload);
    fs::write(&path, &foreign_file).unwrap(); // planted at OUR key path
    let before = cache.stats.binary_loads;
    let f = cache.load(&lua, "mod", MODULE_V1).unwrap();
    assert_eq!(call_module(&lua, &f).0, "v1");
    assert_eq!(cache.stats.binary_loads, before, "foreign-tag file never reached lua.load");
    match cache.stats.rejections.last() {
        Some(Rejection::WrongVersionTag { found }) => {
            pass(&format!("wrong-version-tag file (header tag {found:?}) → rejected BEFORE lua.load → recompiled"));
        }
        other => panic!("expected WrongVersionTag, got {other:?}"),
    }

    // Case C: garbage / raw foreign bytecode with no smith header at the key
    // path (e.g. someone drops a luajit -b output into the cache dir).
    let raw_bytecode = payload.clone(); // valid LuaJIT bytecode, but NOT a smith cache file
    fs::write(&path, &raw_bytecode).unwrap();
    let before = cache.stats.binary_loads;
    let f = cache.load(&lua, "mod", MODULE_V1).unwrap();
    assert_eq!(call_module(&lua, &f).0, "v1");
    assert_eq!(cache.stats.binary_loads, before);
    assert!(matches!(cache.stats.rejections.last(), Some(Rejection::BadMagic)));
    pass("raw LuaJIT bytecode dropped in cache dir (no smith header) → BadMagic → rejected BEFORE lua.load");

    // Note the filename-derivation guarantee too: a foreign file under any
    // OTHER name is simply never opened — lookup only reads path_for(source).
    fs::write(dir.join("evil.smithbc"), &payload).unwrap();
    let mut c2 = BytecodeCache::new(&dir, &tag);
    let _ = c2.load(&lua, "mod", MODULE_V2).unwrap();
    assert!(c2.stats.rejections.is_empty(), "unrelated files are never even opened");
    pass("foreign file under a non-derived name is never opened (lookup is by sha256-derived filename only)");

    // SAFETY PROBE: what if corrupted bytecode DID reach lua.load?
    // LuaJIT has no bytecode verifier. Each corrupted image is loaded AND
    // executed (module top-level + dispatch over every handler) in a
    // subprocess so a segfault/abort is observed instead of killing us.
    println!("-- safety probe: corrupted bytecode fed directly to lua.load (subprocess) --");
    let big = big_module();
    let f_big = lua.load(&big).set_mode(ChunkMode::Text).into_function().unwrap();
    let big_bc = f_big.dump(true);
    let m: mlua::Table = f_big.call(()).unwrap();
    let expected: i64 = m
        .get::<Function>("dispatch")
        .unwrap()
        .call(lua.create_table().unwrap())
        .unwrap();
    let scratch = scratch_dir();

    let mut variants: Vec<(String, Vec<u8>)> = vec![
        ("truncated-50%".into(), big_bc[..big_bc.len() / 2].to_vec()),
        ("zeroed-256-bytes".into(), {
            let mut v = big_bc.clone();
            let mid = v.len() / 3;
            for b in &mut v[mid..mid + 256] {
                *b = 0;
            }
            v
        }),
    ];
    // Seeded pseudo-random corruptions: flip 4 bytes past the 16-byte header,
    // deterministic across runs (simple LCG).
    for seed in 0u64..32 {
        let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut next = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) as usize
        };
        let mut v = big_bc.clone();
        for _ in 0..4 {
            let off = 16 + next() % (v.len() - 16);
            let mask = (next() % 255 + 1) as u8;
            v[off] ^= mask;
        }
        variants.push((format!("rand-4-byte-flips-seed{seed}"), v));
    }

    let exe = std::env::current_exe().unwrap();
    let (mut crashed, mut load_err, mut exec_err, mut silent_ok, mut silent_wrong) = (0, 0, 0, 0, 0);
    let mut crash_names: Vec<String> = Vec::new();
    for (name, bytes) in &variants {
        let p = scratch.join(format!("probe-{name}.bin"));
        fs::write(&p, bytes).unwrap();
        let out = Command::new(&exe)
            .arg("crash-probe")
            .arg(&p)
            .arg(expected.to_string())
            .output()
            .expect("spawn crash probe");
        let said = String::from_utf8_lossy(&out.stdout);
        let said = first_line(said.trim()).to_string();
        let outcome = if !out.status.success() && out.status.code().is_none() {
            crashed += 1;
            crash_names.push(name.clone());
            format!("VM KILLED: {}", describe_exit(&out.status))
        } else if said.starts_with("load-error") {
            load_err += 1;
            said
        } else if said.starts_with("exec-error") {
            exec_err += 1;
            said
        } else if said.starts_with("silent-correct") {
            silent_ok += 1;
            said
        } else if said.starts_with("silent-WRONG-RESULT") {
            silent_wrong += 1;
            said
        } else {
            crashed += 1;
            crash_names.push(name.clone());
            format!("abnormal: {} {said}", describe_exit(&out.status))
        };
        println!("  {name:<28} ({:>5} bytes): {outcome}", bytes.len());
    }
    let n = variants.len();
    println!(
        "  probe summary over {n} corrupted images: {crashed} killed the VM, {silent_wrong} executed silently with WRONG results, {silent_ok} executed silently (undetected), {exec_err} runtime-errored, {load_err} load-errored"
    );
    let undetected = crashed + silent_wrong + silent_ok;
    pass(&format!(
        "safety probe measured (N={n}): {crashed} VM kills{} + {} corrupted images accepted/misbehaving with NO Lua error — LuaJIT has no bytecode verifier, so provenance checks MUST run before lua.load",
        if crash_names.is_empty() { String::new() } else { format!(" ({})", crash_names.join(", ")) },
        undetected - crashed
    ));
}

#[cfg(unix)]
fn describe_exit(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(sig)) => {
            let name = match sig {
                4 => " (SIGILL)",
                6 => " (SIGABRT)",
                11 => " (SIGSEGV)",
                _ => "",
            };
            format!("KILLED by signal {sig}{name}")
        }
        _ => "unknown exit".into(),
    }
}

#[cfg(not(unix))]
fn describe_exit(status: &std::process::ExitStatus) -> String {
    format!("{status}")
}

/// Child mode: load a (corrupted) bytecode file straight into lua.load,
/// run the module top-level AND dispatch through every handler function so
/// corrupted instruction streams actually execute. Either mlua returns a
/// graceful error, or LuaJIT takes the whole process down — the parent reads
/// our exit status.
fn crash_probe(path: &str, expected: i64) -> ! {
    let bytes = fs::read(path).expect("read probe file");
    let lua = Lua::new();
    let run = || -> mlua::Result<i64> {
        let f = lua
            .load(&bytes[..])
            .set_mode(ChunkMode::Binary)
            .into_function()
            .map_err(|e| mlua::Error::runtime(format!("LOAD:{e}")))?;
        let m: mlua::Table = f.call(())?;
        let dispatch: Function = m.get("dispatch")?;
        dispatch.call::<i64>(lua.create_table()?)
    };
    match run() {
        Ok(v) if v == expected => println!("silent-correct: executed, checksum {v} (corruption in dead bytes)"),
        Ok(v) => println!("silent-WRONG-RESULT: executed without error, checksum {v} != expected {expected}"),
        Err(e) => {
            let msg = e.to_string();
            let msg = first_line(&msg);
            if let Some(rest) = msg.strip_prefix("runtime error: LOAD:") {
                println!("load-error: {}", first_line(rest));
            } else {
                println!("exec-error: {msg}");
            }
        }
    }
    std::process::exit(0)
}

// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("roundtrip") => roundtrip(),
        Some("stale-invalidation") => stale_invalidation(),
        Some("foreign-rejected") => foreign_rejected(),
        Some("all") => {
            roundtrip();
            stale_invalidation();
            foreign_rejected();
            println!("PASS: all scenarios");
        }
        Some("crash-probe") => crash_probe(
            args.get(2).expect("crash-probe <file> <expected>"),
            args.get(3).expect("crash-probe <file> <expected>").parse().unwrap(),
        ),
        _ => {
            eprintln!("usage: p17-bytecode-cache <roundtrip|stale-invalidation|foreign-rejected|all>");
            std::process::exit(2);
        }
    }
}
