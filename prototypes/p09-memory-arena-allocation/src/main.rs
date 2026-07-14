//! p09-memory-arena-allocation
//!
//! Proves or disproves PLAN.md P09 candidate claims against the workload
//! baseline in docs/research/SMITH-MEMORY-ALLOCATION-PROFILE.md:
//! - Smith can load/replay large sessions without arena allocation,
//! - discovery of many sessions is O(session count + metadata), not O(corpus),
//! - virtual scroll bounds per-frame allocation by visible rows, not entries,
//! - phase-local `bumpalo` scratch may reduce allocation/allocator-call
//!   pressure and flatten the post-warmup memory profile for render/request,
//! - persisted/session data uses stable IDs and owned strings (no `&'arena`).
//!
//! DEVIATION from PLAN's artifact list (orchestrator-mandated): multi-MiB
//! fixtures are NOT committed. Synthetic sessions are generated at runtime
//! (deterministic xorshift seed, content-free filler text) into
//! `$TMPDIR/p09-fixtures/`, matching PLAN's measured shapes:
//!   small 36 entries ~88 KiB, p95 822 ~3.1 MiB, p99 1,930 ~9.2 MiB,
//!   pathological 5,157 ~29 MiB with one ~4.6 MiB message.
//! For `discover`, 535 session files are synthesized: the 4 shaped fixtures
//! plus 531 small header-bearing files (header line + one tiny message).
//! Discovery reads only the header line of each file, so body size cannot
//! influence its cost; corpus-vs-bytes-read is asserted explicitly.
//!
//! The ONLY unsafe code is the counting `GlobalAlloc` measurement harness
//! required by PLAN ("use a counting global allocator"). No unsafe in any
//! workload or arena code. No arena reference crosses a phase boundary:
//! every `Bump` is created inside its phase function and only owned
//! values/counts are returned (asserted by construction / borrow checker).
//!
//! Verify: `cargo run --release -- discover|load-replay|render-window|`
//! `request-build|arena-scratch|all` (exit 0 each). Numbers quoted in the
//! prototype report are from `--release`; debug also runs but its allocator
//! counts and timings are not meaningful for the keep/drop decision.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

use bumpalo::Bump;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Counting global allocator (measurement harness; the only unsafe code)
// ---------------------------------------------------------------------------

static ALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static DEALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static REALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static BYTES_ALLOCATED: AtomicUsize = AtomicUsize::new(0); // cumulative
static LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);
static PEAK_LIVE: AtomicUsize = AtomicUsize::new(0);

struct CountingAlloc;

fn live_add(n: usize) {
    let live = LIVE_BYTES.fetch_add(n, Relaxed) + n;
    PEAK_LIVE.fetch_max(live, Relaxed);
}

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            ALLOC_CALLS.fetch_add(1, Relaxed);
            BYTES_ALLOCATED.fetch_add(layout.size(), Relaxed);
            live_add(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        DEALLOC_CALLS.fetch_add(1, Relaxed);
        LIVE_BYTES.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            REALLOC_CALLS.fetch_add(1, Relaxed);
            if new_size > layout.size() {
                BYTES_ALLOCATED.fetch_add(new_size - layout.size(), Relaxed);
                live_add(new_size - layout.size());
            } else {
                LIVE_BYTES.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

#[derive(Clone, Copy)]
struct Snap {
    allocs: usize,
    deallocs: usize,
    reallocs: usize,
    bytes: usize,
    live: usize,
}

fn snap() -> Snap {
    Snap {
        allocs: ALLOC_CALLS.load(Relaxed),
        deallocs: DEALLOC_CALLS.load(Relaxed),
        reallocs: REALLOC_CALLS.load(Relaxed),
        bytes: BYTES_ALLOCATED.load(Relaxed),
        live: LIVE_BYTES.load(Relaxed),
    }
}

fn reset_peak() {
    PEAK_LIVE.store(LIVE_BYTES.load(Relaxed), Relaxed);
}

/// RSS from /proc/self/statm (Linux); pages * 4096. None elsewhere.
fn rss_bytes() -> Option<usize> {
    let s = fs::read_to_string("/proc/self/statm").ok()?;
    let resident: usize = s.split_whitespace().nth(1)?.parse().ok()?;
    Some(resident * 4096)
}

struct PhaseStats {
    allocs: usize,
    deallocs: usize,
    reallocs: usize,
    calls: usize,
    bytes: usize,
    live_delta: i64,
    peak_delta: usize,
    elapsed: Duration,
    rss_end: Option<usize>,
}

fn measure<T>(f: impl FnOnce() -> T) -> (T, PhaseStats) {
    reset_peak();
    let s0 = snap();
    let t0 = Instant::now();
    let out = f();
    let elapsed = t0.elapsed();
    let s1 = snap();
    let peak = PEAK_LIVE.load(Relaxed);
    (
        out,
        PhaseStats {
            allocs: s1.allocs - s0.allocs,
            deallocs: s1.deallocs - s0.deallocs,
            reallocs: s1.reallocs - s0.reallocs,
            calls: (s1.allocs - s0.allocs) + (s1.deallocs - s0.deallocs) + (s1.reallocs - s0.reallocs),
            bytes: s1.bytes - s0.bytes,
            live_delta: s1.live as i64 - s0.live as i64,
            peak_delta: peak.saturating_sub(s0.live),
            elapsed,
            rss_end: rss_bytes(),
        },
    )
}

fn fmt_bytes(n: usize) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    if n as f64 >= MIB {
        format!("{:.2} MiB", n as f64 / MIB)
    } else if n >= 1024 {
        format!("{:.1} KiB", n as f64 / 1024.0)
    } else {
        format!("{} B", n)
    }
}

fn fmt_rss(r: Option<usize>) -> String {
    r.map(fmt_bytes).unwrap_or_else(|| "n/a".into())
}

fn print_phase(label: &str, st: &PhaseStats) {
    println!(
        "  {label}: allocs={} reallocs={} deallocs={} allocator_calls={} \
         bytes_allocated={} live_delta={}{} peak_delta={} elapsed={:.1?} rss={}",
        st.allocs,
        st.reallocs,
        st.deallocs,
        st.calls,
        fmt_bytes(st.bytes),
        if st.live_delta < 0 { "-" } else { "" },
        fmt_bytes(st.live_delta.unsigned_abs() as usize),
        fmt_bytes(st.peak_delta),
        st.elapsed,
        fmt_rss(st.rss_end),
    );
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift64*), content-free filler
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next() as usize) % (hi - lo).max(1)
    }
}

/// JSON-safe ASCII filler pattern (letters/digits/space/dash only).
fn build_pattern(rng: &mut Rng) -> String {
    const WORDS: &[&str] = &[
        "alloc", "arena", "scratch", "filler", "synthetic", "render", "token",
        "smith", "buffer", "phase", "entry", "window", "session", "stream",
        "block-7", "delta-42", "frame", "context",
    ];
    let mut s = String::with_capacity(8300);
    while s.len() < 8192 {
        s.push_str(WORDS[rng.range(0, WORDS.len())]);
        s.push(' ');
    }
    s.truncate(8192);
    s
}

// ---------------------------------------------------------------------------
// Fixture generation (runtime, deterministic; see DEVIATION note in header)
// ---------------------------------------------------------------------------

const KIB: usize = 1024;
const MIB: usize = 1024 * 1024;
const SEED: u64 = 0x5EED_5EED_0009;
const META_SESSIONS: usize = 531; // + 4 shaped fixtures = 535 total
const MANIFEST: &str = "p09-fixtures-v1 sessions=535";

struct FixtureSpec {
    name: &'static str,
    messages: usize,          // + 1 header line = PLAN entry count
    target_bytes: usize,      // approximate file size target
    giant: Option<(usize, usize)>, // (message index, filler bytes)
}

fn fixture_specs() -> [FixtureSpec; 4] {
    [
        FixtureSpec { name: "small", messages: 35, target_bytes: 88 * KIB, giant: None },
        FixtureSpec { name: "p95", messages: 821, target_bytes: 3 * MIB + 104_858, giant: None },
        FixtureSpec { name: "p99", messages: 1929, target_bytes: 9 * MIB + 209_715, giant: None },
        FixtureSpec {
            name: "pathological",
            messages: 5156,
            target_bytes: 29 * MIB,
            giant: Some((2500, 4_823_000)), // ~4.6 MiB single message line
        },
    ]
}

fn fixtures_dir() -> PathBuf {
    std::env::temp_dir().join("p09-fixtures")
}

fn write_filler(w: &mut impl Write, pattern: &str, len: usize, start: usize) -> std::io::Result<()> {
    let pat = pattern.as_bytes();
    let mut off = start % pat.len();
    let mut left = len;
    while left > 0 {
        let take = left.min(pat.len() - off);
        w.write_all(&pat[off..off + take])?;
        off = 0;
        left -= take;
    }
    Ok(())
}

fn gen_session(
    path: &Path,
    session_no: usize,
    spec_messages: usize,
    target_bytes: usize,
    giant: Option<(usize, usize)>,
    pattern: &str,
    rng: &mut Rng,
) -> std::io::Result<u64> {
    let mut w = BufWriter::new(File::create(path)?);
    writeln!(
        w,
        "{{\"type\":\"session\",\"id\":\"sess-{session_no:04}\",\"title\":\"synthetic p09 session {session_no}\",\"created\":\"2026-07-01T00:00:00Z\"}}"
    )?;
    const OVERHEAD: usize = 105; // approx JSON envelope bytes per message line
    const USER_LEN: usize = 300; // research: user messages mean ~303 chars
    let n_user = (0..spec_messages).filter(|i| i % 10 == 0).count();
    let n_giant = if giant.is_some() { 1 } else { 0 };
    let giant_bytes = giant.map(|(_, b)| b + OVERHEAD).unwrap_or(0);
    let n_norm = spec_messages - n_user - n_giant;
    let budget = target_bytes
        .saturating_sub(100 + giant_bytes + n_user * (USER_LEN + OVERHEAD) + n_norm * OVERHEAD);
    let norm_mean = (budget / n_norm.max(1)).max(64);
    for i in 0..spec_messages {
        let (role, len) = if giant.map(|(gi, _)| gi == i).unwrap_or(false) {
            ("toolResult", giant.unwrap().1)
        } else if i % 10 == 0 {
            ("user", USER_LEN)
        } else if i % 2 == 1 {
            ("assistant", rng.range(norm_mean * 7 / 10, norm_mean * 13 / 10))
        } else {
            ("toolResult", rng.range(norm_mean * 7 / 10, norm_mean * 13 / 10))
        };
        write!(
            w,
            "{{\"type\":\"message\",\"id\":\"m-{session_no:04}-{i:06}\",\"role\":\"{role}\",\"content\":[{{\"type\":\"text\",\"text\":\""
        )?;
        write_filler(&mut w, pattern, len, rng.range(0, 8192))?;
        w.write_all(b"\"}]}\n")?;
    }
    w.flush()?;
    Ok(fs::metadata(path)?.len())
}

/// Ensure fixtures exist; generate deterministically if absent. Returns dir.
fn ensure_fixtures() -> PathBuf {
    let dir = fixtures_dir();
    let manifest = dir.join("MANIFEST");
    if fs::read_to_string(&manifest).map(|s| s == MANIFEST).unwrap_or(false) {
        println!("fixtures: reusing {} (manifest ok)", dir.display());
        return dir;
    }
    let t0 = Instant::now();
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create fixtures dir");
    let mut rng = Rng::new(SEED);
    let pattern = build_pattern(&mut rng);
    println!("fixtures: generating into {} (runtime deviation; not committed)", dir.display());
    for (n, spec) in fixture_specs().iter().enumerate() {
        let path = dir.join(format!("session-{n:04}-{}.jsonl", spec.name));
        let size = gen_session(&path, n, spec.messages, spec.target_bytes, spec.giant, &pattern, &mut rng)
            .expect("generate fixture");
        let dev = (size as f64 / spec.target_bytes as f64 - 1.0) * 100.0;
        println!(
            "  {}: {} entries, {} (target {}, {:+.1}%)",
            spec.name,
            spec.messages + 1,
            fmt_bytes(size as usize),
            fmt_bytes(spec.target_bytes),
            dev
        );
        assert!(dev.abs() < 10.0, "fixture size off target by >10%");
    }
    for m in 0..META_SESSIONS {
        let n = 4 + m;
        let path = dir.join(format!("session-{n:04}-meta.jsonl", n = n));
        gen_session(&path, n, 2, 700, None, &pattern, &mut rng).expect("generate meta fixture");
    }
    fs::write(&manifest, MANIFEST).expect("write manifest");
    println!("  535 session files ready in {:.1?}", t0.elapsed());
    dir
}

// ---------------------------------------------------------------------------
// Smith-like session model (owned strings + stable IDs; no arena references)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SessionHeader {
    id: String,
    title: String,
    created: String,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct MessageEntry {
    id: String,
    role: String,
    content: Vec<Block>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum SessionEntry {
    #[serde(rename = "session")]
    Session(SessionHeader),
    #[serde(rename = "message")]
    Message(MessageEntry),
    #[serde(other)]
    Unknown,
}

struct LoadedSession {
    name: &'static str,
    file_bytes: u64,
    entries: Vec<SessionEntry>,
    index: HashMap<String, usize>, // stable ID -> position (replay index)
    max_block_bytes: usize,
}

fn load_session(name: &'static str, path: &Path) -> LoadedSession {
    let file_bytes = fs::metadata(path).expect("stat").len();
    // Whole-file read then per-line decode; the transient file String shows
    // up in peak_delta but not live_delta (freed before return).
    let raw = fs::read_to_string(path).expect("read session");
    let mut entries: Vec<SessionEntry> = Vec::new();
    for line in raw.lines() {
        entries.push(serde_json::from_str(line).expect("valid entry"));
    }
    // Replay: rebuild the stable-ID index exactly as a session restore would.
    let mut index = HashMap::with_capacity(entries.len());
    let mut max_block_bytes = 0usize;
    for (i, e) in entries.iter().enumerate() {
        match e {
            SessionEntry::Session(h) => {
                index.insert(h.id.clone(), i);
            }
            SessionEntry::Message(m) => {
                index.insert(m.id.clone(), i);
                for b in &m.content {
                    max_block_bytes = max_block_bytes.max(b.text.len());
                }
            }
            SessionEntry::Unknown => {}
        }
    }
    LoadedSession { name, file_bytes, entries, index, max_block_bytes }
}

fn load_shaped(dir: &Path) -> Vec<LoadedSession> {
    fixture_specs()
        .iter()
        .enumerate()
        .map(|(n, s)| load_session(s.name, &dir.join(format!("session-{n:04}-{}.jsonl", s.name))))
        .collect()
}

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

struct Check {
    name: String,
    pass: bool,
    detail: String,
}

fn check(checks: &mut Vec<Check>, name: &str, pass: bool, detail: String) {
    println!("  [{}] {name}: {detail}", if pass { "PASS" } else { "FAIL" });
    checks.push(Check { name: name.into(), pass, detail });
}

// ---------------------------------------------------------------------------
// Workload 1: discover — scan 535 session headers without full load
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct SessionMeta {
    id: String,
    title: String,
    created: String,
    file_bytes: u64,
}

fn wl_discover(dir: &Path) -> Vec<Check> {
    println!("\n== discover: 535 session headers, metadata only ==");
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .expect("read fixtures dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    paths.sort();
    let corpus_bytes: u64 = paths.iter().map(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum();

    let ((metas, bytes_read), st) = measure(|| {
        let mut metas: Vec<SessionMeta> = Vec::new();
        let mut bytes_read = 0u64;
        let mut buf = String::new();
        for p in &paths {
            let file_bytes = fs::metadata(p).expect("stat").len();
            let mut r = BufReader::new(File::open(p).expect("open"));
            buf.clear();
            r.read_line(&mut buf).expect("header line");
            bytes_read += buf.len() as u64;
            let h: SessionHeader = serde_json::from_str(buf.trim_end()).expect("header json");
            metas.push(SessionMeta { id: h.id, title: h.title, created: h.created, file_bytes });
        }
        (metas, bytes_read)
    });
    print_phase("discover", &st);
    println!(
        "  sessions={} corpus={} bytes_read={} ({:.2}% of corpus) allocs/session={:.1} bytes_allocated/session={}",
        metas.len(),
        fmt_bytes(corpus_bytes as usize),
        fmt_bytes(bytes_read as usize),
        bytes_read as f64 / corpus_bytes as f64 * 100.0,
        st.allocs as f64 / metas.len() as f64,
        fmt_bytes(st.bytes / metas.len()),
    );
    let mut checks = Vec::new();
    check(&mut checks, "session-count", metas.len() == 535, format!("{} sessions discovered", metas.len()));
    check(
        &mut checks,
        "discovery-O(sessions)-not-O(corpus)",
        bytes_read * 10 < corpus_bytes && st.allocs <= metas.len() * 64,
        format!(
            "read {} of {} corpus ({:.2}%); {:.1} allocs/session (bound 64)",
            fmt_bytes(bytes_read as usize),
            fmt_bytes(corpus_bytes as usize),
            bytes_read as f64 / corpus_bytes as f64 * 100.0,
            st.allocs as f64 / metas.len() as f64
        ),
    );
    check(
        &mut checks,
        "discovery-metadata-live",
        st.live_delta < (256 * KIB) as i64,
        format!("live_delta {} for 535 metas (bound 256 KiB)", fmt_bytes(st.live_delta.max(0) as usize)),
    );
    checks
}

// ---------------------------------------------------------------------------
// Workload 2: load-replay — full decode into Smith-like SessionEntry values
// ---------------------------------------------------------------------------

fn wl_load_replay(dir: &Path) -> (Vec<Check>, Vec<LoadedSession>) {
    println!("\n== load-replay: full decode + stable-ID index rebuild ==");
    // Research bands (resident session upper bounds, MiB):
    // p50 <1 (small), p95 4-8, p99 12-20, max 30-45.
    let band_upper_mib = [("small", 1.5), ("p95", 8.0), ("p99", 20.0), ("pathological", 45.0)];
    let mut checks = Vec::new();
    let mut sessions = Vec::new();
    for (n, spec) in fixture_specs().iter().enumerate() {
        let path = dir.join(format!("session-{n:04}-{}.jsonl", spec.name));
        let (s, st) = measure(|| load_session(spec.name, &path));
        print_phase(spec.name, &st);
        let live = st.live_delta.max(0) as usize;
        let upper = (band_upper_mib[n].1 * MIB as f64) as usize;
        let lower = (s.file_bytes as f64 * 0.8) as usize;
        check(
            &mut checks,
            &format!("load-band-{}", spec.name),
            live <= upper && live >= lower,
            format!(
                "{} entries, file {}, resident {} (band {}..{} = 0.8*file..research upper), peak {} (incl. transient file buffer)",
                s.entries.len(),
                fmt_bytes(s.file_bytes as usize),
                fmt_bytes(live),
                fmt_bytes(lower),
                fmt_bytes(upper),
                fmt_bytes(st.peak_delta)
            ),
        );
        check(
            &mut checks,
            &format!("replay-index-{}", spec.name),
            s.index.len() == s.entries.len(),
            format!("stable-ID index has {} entries (owned Strings, no arena refs)", s.index.len()),
        );
        sessions.push(s);
    }
    let patho = &sessions[3];
    check(
        &mut checks,
        "pathological-giant-message",
        patho.max_block_bytes > 4 * MIB,
        format!("max single message block {}", fmt_bytes(patho.max_block_bytes)),
    );
    (checks, sessions)
}

// ---------------------------------------------------------------------------
// Workload 3: render-window — visible rows only, lazy wrap, virtual scroll
// ---------------------------------------------------------------------------

const VISIBLE_ROWS: usize = 40;
const WRAP_WIDTH: usize = 80;
const ITERS: usize = 50;
const WARMUP: usize = 10;

/// Baseline frame: materialize visible rows as owned Strings (simulating
/// styled/formatted TUI line output). Lazy wrap: stops at VISIBLE_ROWS, so a
/// 4.6 MiB message in view costs the same as any other row source.
fn render_frame_baseline(entries: &[SessionEntry], offset: usize) -> (usize, usize) {
    let mut lines: Vec<String> = Vec::new();
    let mut idx = offset;
    while lines.len() < VISIBLE_ROWS && idx < entries.len() {
        if let SessionEntry::Message(m) = &entries[idx] {
            lines.push(format!("[{}] {}", m.role, m.id));
            for b in &m.content {
                for chunk in b.text.as_bytes().chunks(WRAP_WIDTH) {
                    if lines.len() >= VISIBLE_ROWS {
                        break;
                    }
                    lines.push(std::str::from_utf8(chunk).expect("ascii fixture").to_string());
                }
            }
        }
        idx += 1;
    }
    (lines.len(), lines.iter().map(|l| l.len()).sum())
}

/// Bump frame: identical output shape, all scratch in the arena. Returns only
/// counts, so no `&'bump` value can escape the frame (borrow checker enforced).
fn render_frame_bump(entries: &[SessionEntry], offset: usize, bump: &Bump) -> (usize, usize) {
    let mut lines: bumpalo::collections::Vec<&str> = bumpalo::collections::Vec::new_in(bump);
    let mut idx = offset;
    while lines.len() < VISIBLE_ROWS && idx < entries.len() {
        if let SessionEntry::Message(m) = &entries[idx] {
            lines.push(bumpalo::format!(in bump, "[{}] {}", m.role, m.id).into_bump_str());
            for b in &m.content {
                for chunk in b.text.as_bytes().chunks(WRAP_WIDTH) {
                    if lines.len() >= VISIBLE_ROWS {
                        break;
                    }
                    lines.push(bump.alloc_str(std::str::from_utf8(chunk).expect("ascii fixture")));
                }
            }
        }
        idx += 1;
    }
    (lines.len(), lines.iter().map(|l| l.len()).sum())
}

struct PhaseRun {
    per_iter_calls: Vec<usize>,
    per_iter_allocs: Vec<usize>,
    per_iter_bytes: Vec<usize>,
    live_after: Vec<usize>,
    peak_delta: usize,
    elapsed: Duration,
    rss_end: Option<usize>,
}

fn run_iters(iters: usize, mut f: impl FnMut(usize)) -> PhaseRun {
    // Preallocate result vecs so harness pushes never allocate mid-frame.
    let mut per_iter_calls = Vec::with_capacity(iters);
    let mut per_iter_allocs = Vec::with_capacity(iters);
    let mut per_iter_bytes = Vec::with_capacity(iters);
    let mut live_after = Vec::with_capacity(iters);
    reset_peak();
    let live0 = LIVE_BYTES.load(Relaxed);
    let t0 = Instant::now();
    for i in 0..iters {
        let s0 = snap();
        f(i);
        let s1 = snap();
        per_iter_allocs.push(s1.allocs - s0.allocs);
        per_iter_calls
            .push((s1.allocs - s0.allocs) + (s1.deallocs - s0.deallocs) + (s1.reallocs - s0.reallocs));
        per_iter_bytes.push(s1.bytes - s0.bytes);
        live_after.push(s1.live);
    }
    let elapsed = t0.elapsed();
    PhaseRun {
        per_iter_calls,
        per_iter_allocs,
        per_iter_bytes,
        live_after,
        peak_delta: PEAK_LIVE.load(Relaxed).saturating_sub(live0),
        elapsed,
        rss_end: rss_bytes(),
    }
}

fn post_warmup_avg(v: &[usize]) -> f64 {
    let tail = &v[WARMUP.min(v.len())..];
    if tail.is_empty() {
        return 0.0;
    }
    tail.iter().sum::<usize>() as f64 / tail.len() as f64
}

/// (min, max, spread) of post-warmup live bytes — the memory plateau.
fn plateau(v: &[usize]) -> (usize, usize, usize) {
    let tail = &v[WARMUP.min(v.len())..];
    let mn = tail.iter().copied().min().unwrap_or(0);
    let mx = tail.iter().copied().max().unwrap_or(0);
    (mn, mx, mx - mn)
}

fn offset_for(i: usize, n_entries: usize) -> usize {
    (i * 13) % n_entries.saturating_sub(5).max(1)
}

fn render_run_baseline(s: &LoadedSession) -> PhaseRun {
    run_iters(ITERS, |i| {
        let out = render_frame_baseline(&s.entries, offset_for(i, s.entries.len()));
        std::hint::black_box(out);
    })
}

/// Phase fn owning the Bump: created here, reset per frame, never escapes.
fn render_run_bump(s: &LoadedSession) -> PhaseRun {
    let mut bump = Bump::new();
    run_iters(ITERS, |i| {
        let out = render_frame_bump(&s.entries, offset_for(i, s.entries.len()), &bump);
        std::hint::black_box(out);
        bump.reset();
    })
}

fn print_run(label: &str, r: &PhaseRun) {
    let (mn, mx, spread) = plateau(&r.live_after);
    println!(
        "  {label}: post-warmup/iter allocs={:.1} calls={:.1} bytes={} | plateau live {}..{} (spread {}) | peak_delta={} total_elapsed={:.1?} ({:.1} us/iter) rss={}",
        post_warmup_avg(&r.per_iter_allocs),
        post_warmup_avg(&r.per_iter_calls),
        fmt_bytes(post_warmup_avg(&r.per_iter_bytes) as usize),
        fmt_bytes(mn),
        fmt_bytes(mx),
        fmt_bytes(spread),
        fmt_bytes(r.peak_delta),
        r.elapsed,
        r.elapsed.as_micros() as f64 / ITERS as f64,
        fmt_rss(r.rss_end),
    );
}

fn wl_render_window(sessions: &[LoadedSession]) -> Vec<Check> {
    println!("\n== render-window: {VISIBLE_ROWS} visible rows, {ITERS} scrolled frames/session ==");
    let mut checks = Vec::new();
    let mut per_frame: Vec<(usize, f64)> = Vec::new(); // (entries, avg allocs/frame)
    for s in sessions {
        let r = render_run_baseline(s);
        print_run(s.name, &r);
        per_frame.push((s.entries.len(), post_warmup_avg(&r.per_iter_allocs)));
        let (_, _, spread) = plateau(&r.live_after);
        check(
            &mut checks,
            &format!("render-plateau-{}", s.name),
            spread < 64 * KIB,
            format!("post-warmup live spread {} (bound 64 KiB)", fmt_bytes(spread)),
        );
    }
    let min_a = per_frame.iter().map(|x| x.1).fold(f64::MAX, f64::min);
    let max_a = per_frame.iter().map(|x| x.1).fold(0.0, f64::max);
    let entry_ratio = per_frame.iter().map(|x| x.0).max().unwrap() as f64
        / per_frame.iter().map(|x| x.0).min().unwrap() as f64;
    check(
        &mut checks,
        "render-O(visible-rows)",
        max_a / min_a.max(1.0) <= 2.5,
        format!(
            "allocs/frame {:.1}..{:.1} ({:.2}x) while entry counts span {:.0}x — bounded by rows, not entries",
            min_a,
            max_a,
            max_a / min_a.max(1.0),
            entry_ratio
        ),
    );
    // Frame positioned directly on the ~4.6 MiB message (entry idx 2501).
    let patho = &sessions[3];
    let giant_idx = 2501.min(patho.entries.len() - 1);
    let (out, st) = measure(|| render_frame_baseline(&patho.entries, giant_idx));
    check(
        &mut checks,
        "render-giant-message-window",
        out.0 == VISIBLE_ROWS && (st.allocs as f64) <= max_a * 3.0,
        format!(
            "frame on 4.6 MiB message: {} rows, {} allocs (bound 3x normal frame {:.1}) — lazy wrap holds",
            out.0, st.allocs, max_a
        ),
    );
    checks
}

// ---------------------------------------------------------------------------
// Workload 4: request-build — provider request near 250k-token context
// ---------------------------------------------------------------------------

const TOKEN_BUDGET_CHARS: usize = 1_000_000; // ~250k tokens at ~4 chars/token

#[derive(Serialize)]
struct ReqMessageOwned {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ReqOwned {
    model: &'static str,
    max_tokens: u32,
    messages: Vec<ReqMessageOwned>,
}

fn build_request_baseline(entries: &[SessionEntry]) -> (usize, usize, usize) {
    let mut messages: Vec<ReqMessageOwned> = Vec::new();
    let mut chars = 0usize;
    for e in entries.iter().rev() {
        if let SessionEntry::Message(m) = e {
            let mut content = String::new();
            for (bi, b) in m.content.iter().enumerate() {
                if bi > 0 {
                    content.push('\n');
                }
                content.push_str(&b.text);
            }
            chars += content.len();
            messages.push(ReqMessageOwned { role: m.role.clone(), content });
            if chars >= TOKEN_BUDGET_CHARS {
                break;
            }
        }
    }
    messages.reverse();
    let n = messages.len();
    let json = serde_json::to_string(&ReqOwned { model: "provider-x", max_tokens: 8192, messages })
        .expect("serialize");
    (json.len(), chars / 4, n)
}

#[derive(Serialize)]
struct ReqMessageRef<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ReqRef<'a> {
    model: &'static str,
    max_tokens: u32,
    messages: &'a [ReqMessageRef<'a>],
}

/// Scratch (joined content + message list) lives in the Bump; the serialized
/// request String is owned — nothing borrowed crosses out of this fn.
fn build_request_bump(entries: &[SessionEntry], bump: &Bump) -> (usize, usize, usize) {
    let mut messages: bumpalo::collections::Vec<ReqMessageRef> =
        bumpalo::collections::Vec::new_in(bump);
    let mut chars = 0usize;
    for e in entries.iter().rev() {
        if let SessionEntry::Message(m) = e {
            let mut content = bumpalo::collections::String::new_in(bump);
            for (bi, b) in m.content.iter().enumerate() {
                if bi > 0 {
                    content.push('\n');
                }
                content.push_str(&b.text);
            }
            chars += content.len();
            messages.push(ReqMessageRef { role: &m.role, content: content.into_bump_str() });
            if chars >= TOKEN_BUDGET_CHARS {
                break;
            }
        }
    }
    messages.reverse();
    let json = serde_json::to_string(&ReqRef {
        model: "provider-x",
        max_tokens: 8192,
        messages: &messages,
    })
    .expect("serialize");
    (json.len(), chars / 4, messages.len())
}

fn request_run_baseline(s: &LoadedSession) -> PhaseRun {
    run_iters(ITERS, |_| {
        let out = build_request_baseline(&s.entries);
        std::hint::black_box(out);
    })
}

fn request_run_bump(s: &LoadedSession) -> PhaseRun {
    let mut bump = Bump::new();
    run_iters(ITERS, |_| {
        let out = build_request_bump(&s.entries, &bump);
        std::hint::black_box(out);
        bump.reset();
    })
}

fn wl_request_build(sessions: &[LoadedSession]) -> Vec<Check> {
    let patho = &sessions[3];
    println!("\n== request-build: assemble provider request from pathological session, {ITERS} iterations ==");
    let ((json_len, tokens, n_msgs), st1) = measure(|| build_request_baseline(&patho.entries));
    println!(
        "  single build: {} messages, ~{} tokens (chars/4), request json {}",
        n_msgs,
        tokens,
        fmt_bytes(json_len)
    );
    print_phase("single-build", &st1);
    let r = request_run_baseline(patho);
    print_run("repeat-build", &r);
    let mut checks = Vec::new();
    check(
        &mut checks,
        "request-near-compaction-size",
        (200_000..=320_000).contains(&tokens),
        format!("~{tokens} tokens selected (research compaction band 247k-282k)"),
    );
    check(
        &mut checks,
        "request-peak-bounded",
        st1.peak_delta < 8 * MIB,
        format!(
            "peak_delta {} for a {} request (transient; ~2-3x selected context, bound 8 MiB)",
            fmt_bytes(st1.peak_delta),
            fmt_bytes(json_len)
        ),
    );
    let (_, _, spread) = plateau(&r.live_after);
    check(
        &mut checks,
        "request-plateau",
        spread < MIB,
        format!("post-warmup live spread {} across {} builds (bound 1 MiB)", fmt_bytes(spread), ITERS),
    );
    checks
}

// ---------------------------------------------------------------------------
// Workload 5: arena-scratch — baseline vs bumpalo, keep/drop per workload
// ---------------------------------------------------------------------------

fn verdict(workload: &str, base: &PhaseRun, bump: &PhaseRun, checks: &mut Vec<Check>) {
    let b_calls = post_warmup_avg(&base.per_iter_calls);
    let u_calls = post_warmup_avg(&bump.per_iter_calls);
    let b_bytes = post_warmup_avg(&base.per_iter_bytes);
    let u_bytes = post_warmup_avg(&bump.per_iter_bytes);
    let call_red = 1.0 - u_calls / b_calls.max(1.0);
    let bytes_red = 1.0 - u_bytes / b_bytes.max(1.0);
    let time_ratio = bump.elapsed.as_secs_f64() / base.elapsed.as_secs_f64().max(1e-9);
    let (_, _, b_spread) = plateau(&base.live_after);
    let (_, _, u_spread) = plateau(&bump.live_after);
    let peak_ok = bump.peak_delta as f64 <= base.peak_delta as f64 * 1.2 + (64 * KIB) as f64;
    let not_slower = time_ratio <= 1.10;
    let keep = (call_red >= 0.5 || time_ratio <= 0.90 || u_spread * 2 < b_spread.saturating_sub(32 * KIB))
        && peak_ok
        && not_slower;
    println!(
        "  {workload}: allocator-calls/iter {:.1} -> {:.1} ({:+.0}%), bytes/iter {} -> {} ({:+.0}%), elapsed x{:.2}, plateau spread {} -> {}, peak {} -> {}",
        b_calls,
        u_calls,
        -call_red * 100.0,
        fmt_bytes(b_bytes as usize),
        fmt_bytes(u_bytes as usize),
        -bytes_red * 100.0,
        time_ratio,
        fmt_bytes(b_spread),
        fmt_bytes(u_spread),
        fmt_bytes(base.peak_delta),
        fmt_bytes(bump.peak_delta),
    );
    let reason = if keep {
        format!(
            "scratch-only bumpalo wins: {:.0}% fewer allocator calls/iter, elapsed x{time_ratio:.2}, peak stable; costs one dependency + phase-lifetime discipline (no unsafe, no escaping refs)",
            call_red * 100.0
        )
    } else {
        format!(
            "baseline sufficient: call reduction {:.0}%, elapsed x{time_ratio:.2}, peak_ok={peak_ok} — win does not justify lifetime complexity + dependency",
            call_red * 100.0
        )
    };
    println!("  VERDICT {workload}: {} bumpalo — {reason}", if keep { "KEEP" } else { "DROP" });
    check(
        checks,
        &format!("arena-verdict-{workload}"),
        true, // the verdict itself is evidence, not a pass/fail gate
        format!("{} — {reason}", if keep { "KEEP" } else { "DROP" }),
    );
}

fn wl_arena_scratch(sessions: &[LoadedSession]) -> Vec<Check> {
    println!("\n== arena-scratch: Vec/String baseline vs bumpalo Bump (scratch only) ==");
    println!("  (Bump is created inside each phase fn and reset per iteration; only owned values/counts are returned — no arena ref crosses any boundary.)");
    let mut checks = Vec::new();

    let p99 = &sessions[2];
    println!("- render-window scratch (p99 session, {ITERS} frames):");
    let base_r = render_run_baseline(p99);
    print_run("baseline ", &base_r);
    let bump_r = render_run_bump(p99);
    print_run("bumpalo  ", &bump_r);
    verdict("render-window", &base_r, &bump_r, &mut checks);

    let patho = &sessions[3];
    println!("- request-build scratch (pathological session, {ITERS} builds):");
    let base_q = request_run_baseline(patho);
    print_run("baseline ", &base_q);
    let bump_q = request_run_bump(patho);
    print_run("bumpalo  ", &bump_q);
    verdict("request-build", &base_q, &bump_q, &mut checks);

    // Sanity: both variants produce identical output shape.
    let a = render_frame_baseline(&p99.entries, 42);
    let bump = Bump::new();
    let b = render_frame_bump(&p99.entries, 42, &bump);
    drop(bump);
    check(
        &mut checks,
        "arena-output-equivalence",
        a == b,
        format!("baseline frame {:?} == bump frame {:?}", a, b),
    );
    let qa = build_request_baseline(&patho.entries);
    let bump2 = Bump::new();
    let qb = build_request_bump(&patho.entries, &bump2);
    drop(bump2);
    check(
        &mut checks,
        "arena-request-equivalence",
        qa == qb,
        format!("baseline request {:?} == bump request {:?}", qa, qb),
    );
    checks
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: p09 <discover|load-replay|render-window|request-build|arena-scratch|all>");
        std::process::exit(2);
    });
    println!(
        "p09-memory-arena-allocation ({} build; keep/drop numbers meaningful in --release only)",
        if cfg!(debug_assertions) { "DEBUG" } else { "release" }
    );
    println!("startup rss={}", fmt_rss(rss_bytes()));
    let dir = ensure_fixtures();

    let mut checks: Vec<Check> = Vec::new();
    match cmd.as_str() {
        "discover" => checks.extend(wl_discover(&dir)),
        "load-replay" => {
            let (c, _) = wl_load_replay(&dir);
            checks.extend(c);
        }
        "render-window" => {
            let sessions = load_shaped(&dir);
            checks.extend(wl_render_window(&sessions));
        }
        "request-build" => {
            let sessions = load_shaped(&dir);
            checks.extend(wl_request_build(&sessions));
        }
        "arena-scratch" => {
            let sessions = load_shaped(&dir);
            checks.extend(wl_arena_scratch(&sessions));
        }
        "all" => {
            checks.extend(wl_discover(&dir));
            let (c, sessions) = wl_load_replay(&dir);
            checks.extend(c);
            checks.extend(wl_render_window(&sessions));
            checks.extend(wl_request_build(&sessions));
            checks.extend(wl_arena_scratch(&sessions));
        }
        other => {
            eprintln!("unknown workload: {other}");
            std::process::exit(2);
        }
    }

    let failed: Vec<&Check> = checks.iter().filter(|c| !c.pass).collect();
    println!(
        "\nP09 RESULT: {} ({}/{} checks passed) final rss={}",
        if failed.is_empty() { "PASS" } else { "FAIL" },
        checks.len() - failed.len(),
        checks.len(),
        fmt_rss(rss_bytes()),
    );
    for f in &failed {
        println!("  failed: {} — {}", f.name, f.detail);
    }
    if !failed.is_empty() {
        std::process::exit(1);
    }
}
