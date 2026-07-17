//! p25-git-boundary — measure the §9.5 git-install boundary decision.
//!
//! SPEC §9.5 leaves the git-URL plugin install implementation ("gix" vs
//! system-git shell-out) as "release engineering's choice, hidden behind the
//! boundary". gix is ALREADY a §2.3 dependency for VCS queries
//! (blame/blob-diff/revision). The real, never-measured question is the
//! INCREMENTAL cost of turning on gix's clone/fetch features on top of that
//! baseline, versus a runtime dependency on the `git` binary.
//!
//! Scenarios (each exits 0 with PASS lines + measured numbers):
//!   gix-clone-local      clone a local bare repo at a named ref via gix, strip
//!                        .git, and byte-compare tracked files against a
//!                        shell-out clone of the same ref.
//!   shellout-clone-local same clone via std::process::Command("git").
//!   gix-clone-https      best-effort https clone through $HTTPS_PROXY (only
//!                        when built with --features https); PASS-with-note on
//!                        any network/proxy/transport failure.
//!   deps-report          THE deliverable: crate-count / clean-build-time /
//!                        binary-size deltas of the clone and https feature sets
//!                        OVER the §2.3 baseline, measured by driving cargo.
//!
//! Build notes:
//!   default features = ["https"] so the plain verify commands
//!   (`cargo run -- gix-clone-local`) compile the clone path out of the box.
//!   deps-report drives cargo itself with explicit --no-default-features /
//!   --features flags, so it does not depend on how THIS process was built.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// ------- tiny self-cleaning temp dir (no extra crates, like p04) -------

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Result<TempDir, String> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let uniq = format!("p25-{tag}-{}-{nanos}-{n}", std::process::id());
        let path = std::env::temp_dir().join(uniq);
        std::fs::create_dir_all(&path).map_err(|e| format!("mkdir {}: {e}", path.display()))?;
        Ok(TempDir { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ------- git shell-out helper (fixture construction + shell-out arm) -------

fn git(args: &[&str], cwd: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "p25")
        .env("GIT_AUTHOR_EMAIL", "p25@example.invalid")
        .env("GIT_COMMITTER_NAME", "p25")
        .env("GIT_COMMITTER_EMAIL", "p25@example.invalid")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .status()
        .map_err(|e| format!("spawn git {args:?}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?} failed: {status}"))
    }
}

/// The named ref the clone scenarios target.
const CLONE_REF: &str = "release";

/// Build a local bare repo with two branches so cloning "at a named ref" is a
/// meaningful test: `main` lacks VERSION, `release` (the target) has it.
/// Returns (guard, bare_repo_path).
fn build_bare_repo(tag: &str) -> Result<(TempDir, PathBuf), String> {
    let tmp = TempDir::new(tag)?;
    let work = tmp.path.join("work");
    std::fs::create_dir_all(work.join("src")).map_err(|e| e.to_string())?;
    std::fs::write(work.join("README.md"), b"# demo plugin\nline two\n").map_err(|e| e.to_string())?;
    std::fs::write(work.join("src/lib.lua"), b"return { hello = true }\n").map_err(|e| e.to_string())?;

    git(&["init", "--quiet", "-b", "main"], &work)?;
    git(&["add", "-A"], &work)?;
    git(&["commit", "--quiet", "-m", "main commit"], &work)?;
    // release branch adds a file, so a wrong-ref checkout is detectable.
    git(&["checkout", "--quiet", "-b", CLONE_REF], &work)?;
    std::fs::write(work.join("VERSION"), b"1.0.0\n").map_err(|e| e.to_string())?;
    git(&["add", "-A"], &work)?;
    git(&["commit", "--quiet", "-m", "release commit"], &work)?;
    git(&["checkout", "--quiet", "main"], &work)?;

    let bare = tmp.path.join("demo.git");
    git(
        &[
            "clone", "--quiet", "--bare",
            work.to_str().ok_or("non-utf8 path")?,
            bare.to_str().ok_or("non-utf8 path")?,
        ],
        &tmp.path,
    )?;
    Ok((tmp, bare))
}

// ------- tree walking + comparison -------

/// Recursively collect every tracked file (relative path -> bytes), excluding
/// any `.git` directory. Used to prove the stripped snapshot equivalence.
fn walk_tracked(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut out = BTreeMap::new();
    walk_into(root, root, &mut out)?;
    Ok(out)
}

fn walk_into(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("readdir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_name() == *".git" {
            continue;
        }
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            walk_into(root, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            out.insert(rel, bytes);
        }
    }
    Ok(())
}

fn strip_dot_git(root: &Path) -> Result<(), String> {
    let dot = root.join(".git");
    if dot.exists() {
        std::fs::remove_dir_all(&dot).map_err(|e| format!("strip .git: {e}"))?;
    }
    Ok(())
}

// ------- gix clone arm (only under the `clone` feature) -------

#[cfg(feature = "clone")]
fn gix_clone_at_ref(url: &str, dst: &Path, ref_name: &str) -> Result<(), String> {
    use gix::interrupt::IS_INTERRUPTED;
    let mut prepare = gix::prepare_clone(url, dst)
        .map_err(|e| format!("gix prepare_clone: {e}"))?
        .with_ref_name(Some(ref_name))
        .map_err(|e| format!("gix with_ref_name: {e}"))?;
    let (mut checkout, _fetch_out) = prepare
        .fetch_then_checkout(gix::progress::Discard, &IS_INTERRUPTED)
        .map_err(|e| format!("gix fetch_then_checkout: {e}"))?;
    let (_repo, _co_out) = checkout
        .main_worktree(gix::progress::Discard, &IS_INTERRUPTED)
        .map_err(|e| format!("gix main_worktree (checkout): {e}"))?;
    Ok(())
}

#[cfg(not(feature = "clone"))]
fn gix_clone_at_ref(_url: &str, _dst: &Path, _ref_name: &str) -> Result<(), String> {
    Err("built without the `clone` feature (gix blocking-network-client + worktree-mutation)".into())
}

// ------- scenarios -------

fn shellout_clone_at_ref(url: &str, dst: &Path, ref_name: &str) -> Result<(), String> {
    // Clone directly at the named ref; single-branch keeps it a pure snapshot.
    git(
        &[
            "clone", "--quiet", "--single-branch", "--branch", ref_name,
            url, dst.to_str().ok_or("non-utf8 path")?,
        ],
        &std::env::temp_dir(),
    )
}

fn scenario_gix_clone_local() -> Result<(), String> {
    println!("== gix-clone-local ==");
    let (_guard, bare) = build_bare_repo("gix-local")?;
    let url = format!("file://{}", bare.display());
    println!("   bare repo: {url} (ref: {CLONE_REF})");

    let out = TempDir::new("gix-out")?;
    let dst = out.path.join("snap");
    gix_clone_at_ref(&url, &dst, CLONE_REF)?;
    strip_dot_git(&dst)?;
    let gix_tree = walk_tracked(&dst)?;

    // Reference: shell-out clone of the same ref, .git stripped.
    let sh_out = TempDir::new("gix-ref")?;
    let sh_dst = sh_out.path.join("snap");
    shellout_clone_at_ref(&url, &sh_dst, CLONE_REF)?;
    strip_dot_git(&sh_dst)?;
    let sh_tree = walk_tracked(&sh_dst)?;

    let total_bytes: usize = gix_tree.values().map(|v| v.len()).sum();
    assert_true(gix_tree.contains_key("VERSION"), "named ref honored (VERSION from `release` present)")?;
    assert_true(gix_tree.contains_key("README.md"), "README.md checked out")?;
    assert_true(gix_tree.contains_key("src/lib.lua"), "src/lib.lua checked out")?;
    assert_true(!dst.join(".git").exists(), ".git stripped -> pure file snapshot (§9.5)")?;
    assert_true(gix_tree == sh_tree, "gix snapshot byte-identical to shell-out snapshot")?;
    println!("   PASS gix clone at ref, .git stripped, {} tracked files, {total_bytes} bytes", gix_tree.len());
    println!("   PASS byte-identical to /usr/bin/git clone (walked both trees)");
    Ok(())
}

fn git_version() -> Option<String> {
    let out = Command::new("/usr/bin/git").arg("--version").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().replace("git version ", ""))
}

fn scenario_shellout_clone_local() -> Result<(), String> {
    println!("== shellout-clone-local ==");
    let (_guard, bare) = build_bare_repo("sh-local")?;
    let url = format!("file://{}", bare.display());
    println!("   bare repo: {url} (ref: {CLONE_REF})");

    let out = TempDir::new("sh-out")?;
    let dst = out.path.join("snap");
    shellout_clone_at_ref(&url, &dst, CLONE_REF)?;
    strip_dot_git(&dst)?;
    let tree = walk_tracked(&dst)?;
    let total_bytes: usize = tree.values().map(|v| v.len()).sum();

    assert_true(tree.contains_key("VERSION"), "named ref honored (VERSION present)")?;
    assert_true(tree.contains_key("README.md"), "README.md checked out")?;
    assert_true(!dst.join(".git").exists(), ".git stripped -> pure file snapshot (§9.5)")?;
    println!("   PASS shell-out clone at ref, .git stripped, {} tracked files, {total_bytes} bytes", tree.len());
    println!("   note: 0 added crates; runtime cost is a `git` binary on PATH (/usr/bin/git {})",
        git_version().unwrap_or_else(|| "unknown".into()));
    Ok(())
}

#[cfg(feature = "https")]
fn scenario_gix_clone_https() -> Result<(), String> {
    use gix::interrupt::IS_INTERRUPTED;
    println!("== gix-clone-https ==");
    let url = "https://github.com/octocat/Hello-World.git";
    println!("   attempting https clone of {url}");
    println!("   best-effort through $HTTPS_PROXY={:?}", std::env::var("HTTPS_PROXY").ok());
    let out = TempDir::new("https-out")?;
    let dst = out.path.join("snap");

    let attempt = (|| -> Result<usize, String> {
        let mut prepare = gix::prepare_clone(url, &dst).map_err(|e| format!("prepare_clone: {e}"))?;
        let (mut checkout, _) = prepare
            .fetch_then_checkout(gix::progress::Discard, &IS_INTERRUPTED)
            .map_err(|e| format!("fetch_then_checkout: {e}"))?;
        let (_repo, _) = checkout
            .main_worktree(gix::progress::Discard, &IS_INTERRUPTED)
            .map_err(|e| format!("main_worktree: {e}"))?;
        strip_dot_git(&dst)?;
        Ok(walk_tracked(&dst)?.len())
    })();

    match attempt {
        Ok(n) => println!("   PASS https clone succeeded via gix reqwest-rustls transport, {n} tracked files"),
        Err(e) => {
            println!("   PASS-with-note: https clone did not complete (network/proxy/transport)");
            println!("   error: {e}");
            println!("   (viability rests on the local case; this arm never fails the run)");
        }
    }
    Ok(())
}

#[cfg(not(feature = "https"))]
fn scenario_gix_clone_https() -> Result<(), String> {
    println!("== gix-clone-https ==");
    println!("   PASS-with-note: built without --features https; gix has no https transport in this binary.");
    println!("   gix 0.83 https transports: blocking-http-transport-{{reqwest*,curl*}}.");
    Ok(())
}

// ------- deps-report: THE deliverable -------

struct ConfigMeasure {
    label: String,
    features_flag: Vec<String>,
    crate_count: usize,
    build_secs: f64,
    binary_bytes: u64,
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn scratch_dir() -> PathBuf {
    std::env::var("P25_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("p25-deps-report"))
}

fn crate_name_set(features_flag: &[String]) -> Result<std::collections::BTreeSet<String>, String> {
    let mut args = vec![
        "tree".to_string(),
        "--no-default-features".to_string(),
        "-e".to_string(),
        "normal".to_string(),
        "--prefix".to_string(),
        "none".to_string(),
    ];
    args.extend(features_flag.iter().cloned());
    let out = Command::new("cargo")
        .args(&args)
        .current_dir(manifest_dir())
        .output()
        .map_err(|e| format!("spawn cargo tree: {e}"))?;
    if !out.status.success() {
        return Err(format!("cargo tree failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names = std::collections::BTreeSet::new();
    for line in text.lines() {
        // "name vX.Y.Z ..." possibly with trailing " (*)"
        let name = line.trim().split_whitespace().next().unwrap_or("");
        if !name.is_empty() {
            names.insert(name.to_string());
        }
    }
    Ok(names)
}

fn clean_build(label: &str, features_flag: &[String]) -> Result<(f64, u64), String> {
    let target = scratch_dir().join(format!("target-{label}"));
    // Fresh target dir => genuinely clean build.
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let mut args = vec![
        "build".to_string(),
        "--release".to_string(),
        "--no-default-features".to_string(),
    ];
    args.extend(features_flag.iter().cloned());
    let start = Instant::now();
    let status = Command::new("cargo")
        .args(&args)
        .current_dir(manifest_dir())
        .env("CARGO_TARGET_DIR", &target)
        .status()
        .map_err(|e| format!("spawn cargo build: {e}"))?;
    let secs = start.elapsed().as_secs_f64();
    if !status.success() {
        return Err(format!("clean build of {label} failed"));
    }
    let bin = target.join("release").join("p25-git-boundary");
    let bytes = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    Ok((secs, bytes))
}

fn measure(label: &str, features_flag: &[&str]) -> Result<ConfigMeasure, String> {
    let flags: Vec<String> = features_flag.iter().map(|s| s.to_string()).collect();
    let names = crate_name_set(&flags)?;
    let (build_secs, binary_bytes) = clean_build(label, &flags)?;
    Ok(ConfigMeasure {
        label: label.to_string(),
        features_flag: flags,
        crate_count: names.len(),
        build_secs,
        binary_bytes,
    })
}

fn scenario_deps_report() -> Result<(), String> {
    println!("== deps-report ==");
    println!("   method: one Cargo.toml, three feature configs, driven via cargo from {}.", manifest_dir().display());
    println!("   baseline = §2.3 gix (blame,blob-diff,revision) + sha1 hash backend.");
    println!("   clone    = baseline + gix/blocking-network-client + gix/worktree-mutation (local file+git:// clone/checkout).");
    println!("   https    = clone + gix/blocking-http-transport-reqwest-rust-tls (real git-URL installs need this).");
    println!("   crate count via `cargo tree -e normal`; build time = clean build into a fresh CARGO_TARGET_DIR; size = release bin.");
    println!();

    let baseline = measure("baseline", &[])?;
    let clone = measure("clone", &["--features", "clone"])?;
    let https = measure("https", &["--features", "https"])?;

    let report = |m: &ConfigMeasure| {
        println!(
            "   {:9} crates={:3}  clean_build={:6.1}s  release_bin={:>8} bytes ({:.0} KiB)  [{}]",
            m.label,
            m.crate_count,
            m.build_secs,
            m.binary_bytes,
            m.binary_bytes as f64 / 1024.0,
            if m.features_flag.is_empty() { "--no-default-features".into() } else { m.features_flag.join(" ") },
        );
    };
    report(&baseline);
    report(&clone);
    report(&https);
    println!();

    let d_crates_clone = clone.crate_count as i64 - baseline.crate_count as i64;
    let d_crates_https = https.crate_count as i64 - baseline.crate_count as i64;
    let d_time_clone = clone.build_secs - baseline.build_secs;
    let d_time_https = https.build_secs - baseline.build_secs;
    let d_size_clone = clone.binary_bytes as i64 - baseline.binary_bytes as i64;
    let d_size_https = https.binary_bytes as i64 - baseline.binary_bytes as i64;

    let base_set = crate_name_set(&[])?;
    let clone_set = crate_name_set(&["--features".into(), "clone".into()])?;
    let https_set = crate_name_set(&["--features".into(), "https".into()])?;
    let added_clone: Vec<_> = clone_set.difference(&base_set).cloned().collect();
    let added_https: Vec<_> = https_set.difference(&base_set).cloned().collect();
    let heavy: Vec<&str> = [
        "reqwest", "hyper", "h2", "rustls", "aws-lc-sys", "aws-lc-rs", "tokio",
        "openssl-sys", "curl-sys", "tower", "hyper-util",
    ]
    .into_iter()
    .filter(|h| added_https.iter().any(|c| c == h))
    .collect();

    println!("   INCREMENTAL over §2.3 baseline:");
    println!("     local clone  (+clone): +{d_crates_clone:2} crates, {d_time_clone:+.1}s clean build, {d_size_clone:+} bytes bin");
    println!("       added: {}", added_clone.join(", "));
    println!("     https clone  (+https): +{d_crates_https:2} crates, {d_time_https:+.1}s clean build, {d_size_https:+} bytes bin");
    println!("       notable heavy crates: {}", if heavy.is_empty() { "(none)".into() } else { heavy.join(", ") });
    println!("       total added crates: {} (TLS + async network stack)", added_https.len());
    println!();
    println!("   shell-out arm: +0 crates, +0.0s, +0 bytes; runtime cost = `git` binary on PATH.");
    println!("   PASS deps-report emitted real numbers for baseline / clone / https.");
    Ok(())
}

// ------- harness -------

fn assert_true(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        println!("   PASS {msg}");
        Ok(())
    } else {
        Err(format!("ASSERT FAILED: {msg}"))
    }
}

fn run(scenario: &str) -> Result<(), String> {
    match scenario {
        "gix-clone-local" => scenario_gix_clone_local(),
        "shellout-clone-local" => scenario_shellout_clone_local(),
        "gix-clone-https" => scenario_gix_clone_https(),
        "deps-report" => scenario_deps_report(),
        "all" => {
            scenario_gix_clone_local()?;
            println!();
            scenario_shellout_clone_local()?;
            println!();
            scenario_gix_clone_https()?;
            println!();
            scenario_deps_report()
        }
        other => Err(format!("unknown scenario: {other}")),
    }
}

fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match run(&scenario) {
        Ok(()) => println!("\nOK ({scenario})"),
        Err(e) => {
            eprintln!("\nFAIL ({scenario}): {e}");
            std::process::exit(1);
        }
    }
}
