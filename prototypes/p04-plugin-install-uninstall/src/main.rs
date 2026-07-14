//! p04-plugin-install-uninstall
//!
//! Proves or disproves docs/SPEC.md §9.2/§9.3/§9.5 install semantics:
//! - v1 install sources: local path and git URL only,
//! - names are `<org>/<name>`, `smith/*` reserved,
//! - manifests are mandatory Lua data files evaluated in a RESTRICTED
//!   environment (no io/os/require) and must return a pure data table,
//! - `smith_api` optional, defaults to generation 1,
//! - install never executes plugin entry code,
//! - duplicates refused without `--force`,
//! - uninstall keeps `data_dir/smith/data/<org>/<name>/` unless `--purge-data`,
//!   and never removes project plugins.
//!
//! Git URL install is simulated with a local bare repo + shell-out to
//! /usr/bin/git. The real gix-vs-shell-out boundary decision (SPEC §9.5)
//! is intentionally NOT settled here.
//!
//! Verify (each exits 0, printing checked filesystem assertions):
//!   cargo run -- install-local
//!   cargo run -- install-git
//!   cargo run -- reject-bad-name
//!   cargo run -- reject-smith-namespace
//!   cargo run -- uninstall-keeps-data
//!   cargo run -- uninstall-purge-data

use mlua::{Lua, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const MANIFEST_FILE: &str = "smith-plugin.lua";
const SUPPORTED_API_GENERATION: i64 = 1;

// ---------------------------------------------------------------------------
// Manifest: restricted-environment loading + validation (SPEC §9.2, §9.3)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Manifest {
    name: String,
    org: String,
    plugin: String,
    version: String,
    entry: String,
    smith_api: i64,
}

/// Evaluate a manifest chunk with an EMPTY environment table so the chunk
/// cannot reach `io`, `os`, `require`, or any other global (SPEC §9.2:
/// "restricted manifest environment with no Smith SDK and no host I/O").
fn eval_manifest_restricted(lua: &Lua, src: &str, chunk_name: &str) -> Result<mlua::Table, String> {
    let env = lua
        .create_table()
        .map_err(|e| format!("create env: {e}"))?;
    let value: Value = lua
        .load(src)
        .set_name(chunk_name)
        .set_environment(env)
        .eval()
        .map_err(|e| format!("manifest evaluation failed: {e}"))?;
    match value {
        Value::Table(t) => Ok(t),
        other => Err(format!(
            "manifest must return a table, got {}",
            other.type_name()
        )),
    }
}

/// Reject non-data values so the manifest is a pure data table.
fn assert_pure_data(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Nil | Value::Boolean(_) | Value::Integer(_) | Value::Number(_) | Value::String(_) => Ok(()),
        Value::Table(t) => {
            for pair in t.clone().pairs::<Value, Value>() {
                let (k, v) = pair.map_err(|e| format!("{path}: {e}"))?;
                let key = match &k {
                    Value::String(s) => s.to_string_lossy().to_string(),
                    other => format!("[{}]", other.type_name()),
                };
                assert_pure_data(&v, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        other => Err(format!(
            "{path}: manifest must be pure data, found {}",
            other.type_name()
        )),
    }
}

fn valid_name_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn load_manifest(lua: &Lua, plugin_dir: &Path) -> Result<Manifest, String> {
    let path = plugin_dir.join(MANIFEST_FILE);
    let src = fs::read_to_string(&path)
        .map_err(|e| format!("missing mandatory manifest {}: {e}", path.display()))?;
    let table = eval_manifest_restricted(lua, &src, &path.display().to_string())?;
    assert_pure_data(&Value::Table(table.clone()), "manifest")?;

    let name: String = table
        .get::<Option<String>>("name")
        .map_err(|e| format!("manifest.name: {e}"))?
        .ok_or("manifest.name is required")?;
    let version: String = table
        .get::<Option<String>>("version")
        .map_err(|e| format!("manifest.version: {e}"))?
        .ok_or("manifest.version is required")?;
    let entry: String = table
        .get::<Option<String>>("entry")
        .map_err(|e| format!("manifest.entry: {e}"))?
        .ok_or("manifest.entry is required")?;
    // SPEC §9.3: smith_api optional, defaults to generation 1.
    let smith_api: i64 = table
        .get::<Option<i64>>("smith_api")
        .map_err(|e| format!("manifest.smith_api: {e}"))?
        .unwrap_or(1);

    let (org, plugin) = name
        .split_once('/')
        .ok_or_else(|| format!("plugin name '{name}' must be <org>/<name>"))?;
    if !valid_name_part(org) || !valid_name_part(plugin) {
        return Err(format!(
            "plugin name '{name}' invalid: org/name must match [a-z0-9_-]+"
        ));
    }
    Ok(Manifest {
        name: name.clone(),
        org: org.to_string(),
        plugin: plugin.to_string(),
        version,
        entry,
        smith_api,
    })
}

// ---------------------------------------------------------------------------
// Install / uninstall (SPEC §9.5)
// ---------------------------------------------------------------------------

enum Source {
    LocalPath(PathBuf),
    GitUrl(String),
}

struct Ctx {
    data_dir: PathBuf,
    project_dir: PathBuf,
}

impl Ctx {
    fn plugins_root(&self) -> PathBuf {
        self.data_dir.join("smith").join("plugins")
    }
    fn data_root(&self) -> PathBuf {
        self.data_dir.join("smith").join("data")
    }
    fn installed_dir(&self, m: &Manifest) -> PathBuf {
        self.plugins_root().join(&m.org).join(&m.plugin)
    }
    fn plugin_data_dir(&self, org: &str, name: &str) -> PathBuf {
        self.data_root().join(org).join(name)
    }
    fn project_plugin_dir(&self, org: &str, name: &str) -> PathBuf {
        self.project_dir
            .join(".smith")
            .join("plugins")
            .join(org)
            .join(name)
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".git" {
            continue; // install layout holds plugin files, not VCS metadata
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// `smith install <path-or-git-url>` per SPEC §9.5. Resolves the source,
/// validates the manifest in a restricted env, validates namespace + API
/// generation, copies/clones into data_dir/smith/plugins/<org>/<name>/,
/// refuses duplicates unless `force`, and never runs plugin entry code.
fn install(lua: &Lua, ctx: &Ctx, source: Source, force: bool) -> Result<Manifest, String> {
    // 1. resolve the source into a local staging directory
    let staging_guard; // keeps clone tempdir alive until copy completes
    let staged: PathBuf = match source {
        Source::LocalPath(p) => {
            if !p.is_dir() {
                return Err(format!("local source {} is not a directory", p.display()));
            }
            p
        }
        Source::GitUrl(url) => {
            // Simulated git implementation boundary: shell out to git(1).
            // A production Smith would hide gix-or-shell-out behind this
            // same boundary (SPEC §9.5); the decision is not settled here.
            let staging = TempDir::new("git-staging")?;
            let status = Command::new("/usr/bin/git")
                .args(["clone", "--quiet", "--depth", "1", &url])
                .arg(&staging.path)
                .status()
                .map_err(|e| format!("spawn git: {e}"))?;
            if !status.success() {
                return Err(format!("git clone of {url} failed: {status}"));
            }
            let p = staging.path.clone();
            staging_guard = staging;
            let _ = &staging_guard;
            p
        }
    };

    // 2. read + validate the manifest (restricted env, pure data, name rules)
    let manifest = load_manifest(lua, &staged)?;

    // 3. namespace + API compatibility (SPEC §9.2, §9.3)
    if manifest.org == "smith" {
        return Err(format!(
            "namespace 'smith/*' is reserved for built-in plugins; refusing '{}'",
            manifest.name
        ));
    }
    if manifest.smith_api > SUPPORTED_API_GENERATION {
        return Err(format!(
            "plugin '{}' requires smith_api generation {} but this Smith supports {}",
            manifest.name, manifest.smith_api, SUPPORTED_API_GENERATION
        ));
    }
    if !staged.join(&manifest.entry).is_file() {
        return Err(format!(
            "manifest entry '{}' does not exist in source",
            manifest.entry
        ));
    }

    // 4. duplicate handling: refuse unless --force (SPEC §9.5)
    let dest = ctx.installed_dir(&manifest);
    if dest.exists() {
        if !force {
            return Err(format!(
                "plugin '{}' already installed at {}; use --force to overwrite",
                manifest.name,
                dest.display()
            ));
        }
        fs::remove_dir_all(&dest).map_err(|e| format!("remove old install: {e}"))?;
    }

    // 5. copy into place. NOTE: no Lua execution of entry code anywhere here.
    copy_dir_recursive(&staged, &dest)?;
    Ok(manifest)
}

/// `smith uninstall <org>/<name>` per SPEC §9.5. Removes installed plugin
/// code, keeps plugin data unless `purge_data`, never touches project plugins
/// (it only ever operates under the GLOBAL plugins/data roots).
fn uninstall(ctx: &Ctx, name: &str, purge_data: bool) -> Result<(), String> {
    let (org, plugin) = name
        .split_once('/')
        .ok_or_else(|| format!("'{name}' must be <org>/<name>"))?;
    if org == "smith" {
        return Err("cannot uninstall built-in smith/* plugins".to_string());
    }
    let code_dir = ctx.plugins_root().join(org).join(plugin);
    if !code_dir.exists() {
        return Err(format!("plugin '{name}' is not installed globally"));
    }
    fs::remove_dir_all(&code_dir).map_err(|e| format!("remove {}: {e}", code_dir.display()))?;
    if purge_data {
        let data_dir = ctx.plugin_data_dir(org, plugin);
        if data_dir.exists() {
            fs::remove_dir_all(&data_dir)
                .map_err(|e| format!("purge {}: {e}", data_dir.display()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

/// Unique temp dir under std::env::temp_dir(), removed on drop.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "p04-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&path).map_err(|e| format!("mkdir {}: {e}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct Checker {
    pass: bool,
}

impl Checker {
    fn new() -> Self {
        Self { pass: true }
    }
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
    fn check_fs(&mut self, label: &str, path: &Path, should_exist: bool) {
        let exists = path.exists();
        println!(
            "{} {label}: {} {}",
            if exists == should_exist { "PASS" } else { "FAIL" },
            path.display(),
            if exists { "exists" } else { "absent" },
        );
        self.pass &= exists == should_exist;
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn make_ctx(label: &str) -> Result<(TempDir, Ctx), String> {
    let tmp = TempDir::new(label)?;
    let ctx = Ctx {
        data_dir: tmp.path.join("data_dir"),
        project_dir: tmp.path.join("project"),
    };
    fs::create_dir_all(&ctx.data_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&ctx.project_dir).map_err(|e| e.to_string())?;
    Ok((tmp, ctx))
}

/// Set a side-effect marker path in the environment. If install ever executes
/// the fixture's entry code, init.lua writes this file.
fn arm_side_effect(tmp: &TempDir) -> PathBuf {
    let marker = tmp.path.join("side-effect-marker");
    std::env::set_var("P04_SIDE_EFFECT_FILE", &marker);
    marker
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

fn scenario_install_local(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (tmp, ctx) = make_ctx("install-local")?;
    let marker = arm_side_effect(&tmp);

    // fresh install from a local directory path
    let m = install(lua, &ctx, Source::LocalPath(fixtures().join("good-plugin")), false)?;
    c.check(
        &format!("manifest parsed in restricted env: name={} version={}", m.name, m.version),
        m.name == "acme/good-plugin" && m.version == "0.1.0" && m.entry == "init.lua",
    );
    c.check(
        &format!("smith_api absent defaults to generation {}", m.smith_api),
        m.smith_api == 1,
    );
    let dest = ctx.installed_dir(&m);
    c.check_fs("installed under data_dir/smith/plugins/<org>/<name>", &dest, true);
    c.check_fs("manifest copied", &dest.join(MANIFEST_FILE), true);
    c.check_fs("entry file copied", &dest.join("init.lua"), true);
    c.check_fs("entry code NOT executed during install (no side-effect marker)", &marker, false);

    // duplicate refused without --force
    let dup = install(lua, &ctx, Source::LocalPath(fixtures().join("good-plugin")), false);
    match &dup {
        Err(e) => println!("     refusal: {e}"),
        Ok(_) => {}
    }
    c.check(
        "duplicate install refused without --force",
        matches!(&dup, Err(e) if e.contains("already installed")),
    );

    // duplicate accepted with --force
    let forced = install(lua, &ctx, Source::LocalPath(fixtures().join("good-plugin")), true);
    c.check("duplicate install succeeds with --force", forced.is_ok());
    c.check_fs("plugin still present after --force reinstall", &dest.join(MANIFEST_FILE), true);

    // restricted manifest environment: os.getenv and require must fail
    let evil_os = load_manifest(lua, &fixtures().join("evil-os"));
    if let Err(e) = &evil_os {
        println!("     evil-os error: {}", e.lines().next().unwrap_or(""));
    }
    c.check(
        "manifest using os.getenv fails in restricted env",
        matches!(&evil_os, Err(e) if e.contains("manifest evaluation failed")),
    );
    let evil_req = load_manifest(lua, &fixtures().join("evil-require"));
    if let Err(e) = &evil_req {
        println!("     evil-require error: {}", e.lines().next().unwrap_or(""));
    }
    c.check(
        "manifest using require fails in restricted env",
        matches!(&evil_req, Err(e) if e.contains("manifest evaluation failed")),
    );

    // manifest must be a pure data table: functions are rejected
    let fn_dir = tmp.path.join("fn-manifest");
    fs::create_dir_all(&fn_dir).map_err(|e| e.to_string())?;
    fs::write(
        fn_dir.join(MANIFEST_FILE),
        "return { name = \"acme/fn\", version = \"0.1.0\", entry = \"init.lua\", hook = function() end }",
    )
    .map_err(|e| e.to_string())?;
    let fn_manifest = load_manifest(lua, &fn_dir);
    if let Err(e) = &fn_manifest {
        println!("     fn-manifest error: {e}");
    }
    c.check(
        "manifest containing a function rejected (pure data only)",
        matches!(&fn_manifest, Err(e) if e.contains("pure data")),
    );

    // API generation newer than supported does not install (SPEC §9.3)
    let api_dir = tmp.path.join("api2");
    fs::create_dir_all(&api_dir).map_err(|e| e.to_string())?;
    fs::write(
        api_dir.join(MANIFEST_FILE),
        "return { name = \"acme/future\", version = \"0.1.0\", entry = \"init.lua\", smith_api = 2 }",
    )
    .map_err(|e| e.to_string())?;
    fs::write(api_dir.join("init.lua"), "return {}").map_err(|e| e.to_string())?;
    let api2 = install(lua, &ctx, Source::LocalPath(api_dir), false);
    if let Err(e) = &api2 {
        println!("     refusal: {e}");
    }
    c.check(
        "smith_api=2 refused (supported generation is 1)",
        matches!(&api2, Err(e) if e.contains("generation 2")),
    );
    c.check_fs(
        "future-api plugin not written to plugins dir",
        &ctx.plugins_root().join("acme").join("future"),
        false,
    );
    Ok(())
}

fn scenario_install_git(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (tmp, ctx) = make_ctx("install-git")?;
    let marker = arm_side_effect(&tmp);

    // Build a local bare repo containing the good plugin, then install from
    // its file:// URL. Git operations shell out to /usr/bin/git; the real
    // gix-vs-shell-out boundary decision (SPEC §9.5) still stands.
    let work = tmp.path.join("git-work");
    copy_dir_recursive(&fixtures().join("good-plugin"), &work)?;
    let run = |args: &[&str], cwd: &Path| -> Result<(), String> {
        let status = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "p04")
            .env("GIT_AUTHOR_EMAIL", "p04@example.invalid")
            .env("GIT_COMMITTER_NAME", "p04")
            .env("GIT_COMMITTER_EMAIL", "p04@example.invalid")
            .status()
            .map_err(|e| format!("spawn git: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("git {args:?} failed: {status}"))
        }
    };
    run(&["init", "--quiet"], &work)?;
    run(&["add", "-A"], &work)?;
    run(&["commit", "--quiet", "-m", "plugin v0.1.0"], &work)?;
    let bare = tmp.path.join("good-plugin.git");
    run(
        &["clone", "--quiet", "--bare", work.to_str().unwrap(), bare.to_str().unwrap()],
        &tmp.path,
    )?;
    let url = format!("file://{}", bare.display());
    println!("     simulated git URL: {url}");

    let m = install(lua, &ctx, Source::GitUrl(url), false)?;
    c.check(
        &format!("git-URL install resolved manifest: {} {}", m.name, m.version),
        m.name == "acme/good-plugin",
    );
    let dest = ctx.installed_dir(&m);
    c.check_fs("cloned into data_dir/smith/plugins/<org>/<name>", &dest, true);
    c.check_fs("manifest present after git install", &dest.join(MANIFEST_FILE), true);
    c.check_fs("entry file present after git install", &dest.join("init.lua"), true);
    c.check_fs("no .git metadata in installed plugin", &dest.join(".git"), false);
    c.check_fs("entry code NOT executed during git install", &marker, false);
    println!("     note: git implemented via shell-out to /usr/bin/git in this prototype;");
    println!("     note: gix-vs-shell-out remains an open boundary decision per SPEC §9.5.");
    Ok(())
}

fn scenario_reject_bad_name(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (_tmp, ctx) = make_ctx("reject-bad-name")?;
    let res = install(lua, &ctx, Source::LocalPath(fixtures().join("bad-name")), false);
    if let Err(e) = &res {
        println!("     refusal: {e}");
    }
    c.check(
        "install refused: 'Acme/Bad.Plugin' violates [a-z0-9_-] name rule",
        matches!(&res, Err(e) if e.contains("invalid")),
    );
    c.check_fs(
        "plugins root untouched after rejection",
        &ctx.plugins_root(),
        false,
    );
    Ok(())
}

fn scenario_reject_smith_namespace(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (_tmp, ctx) = make_ctx("reject-smith-namespace")?;
    let res = install(lua, &ctx, Source::LocalPath(fixtures().join("reserved-smith")), false);
    if let Err(e) = &res {
        println!("     refusal: {e}");
    }
    c.check(
        "install refused: 'smith/evil' uses reserved smith/* namespace",
        matches!(&res, Err(e) if e.contains("reserved")),
    );
    c.check_fs(
        "no smith/ directory created under plugins root",
        &ctx.plugins_root().join("smith"),
        false,
    );
    Ok(())
}

fn scenario_uninstall_keeps_data(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (_tmp, ctx) = make_ctx("uninstall-keeps-data")?;
    let m = install(lua, &ctx, Source::LocalPath(fixtures().join("good-plugin")), false)?;
    let code_dir = ctx.installed_dir(&m);

    // plugin wrote data during use
    let data_dir = ctx.plugin_data_dir("acme", "good-plugin");
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    fs::write(data_dir.join("state.txt"), "precious user data\n").map_err(|e| e.to_string())?;

    // a same-named PROJECT plugin exists and must survive
    let project_plugin = ctx.project_plugin_dir("acme", "good-plugin");
    fs::create_dir_all(&project_plugin).map_err(|e| e.to_string())?;
    fs::write(project_plugin.join(MANIFEST_FILE), "return { name = \"acme/good-plugin\", version = \"0.2.0\", entry = \"init.lua\" }")
        .map_err(|e| e.to_string())?;

    uninstall(&ctx, "acme/good-plugin", false)?;
    c.check_fs("plugin code removed", &code_dir, false);
    c.check_fs("plugin data KEPT by default", &data_dir.join("state.txt"), true);
    c.check_fs(
        "project plugin never removed by uninstall",
        &project_plugin.join(MANIFEST_FILE),
        true,
    );

    // uninstalling again fails cleanly
    let again = uninstall(&ctx, "acme/good-plugin", false);
    if let Err(e) = &again {
        println!("     refusal: {e}");
    }
    c.check(
        "second uninstall reports not installed",
        matches!(&again, Err(e) if e.contains("not installed")),
    );
    Ok(())
}

fn scenario_uninstall_purge_data(lua: &Lua, c: &mut Checker) -> Result<(), String> {
    let (_tmp, ctx) = make_ctx("uninstall-purge-data")?;
    let m = install(lua, &ctx, Source::LocalPath(fixtures().join("good-plugin")), false)?;
    let code_dir = ctx.installed_dir(&m);
    let data_dir = ctx.plugin_data_dir("acme", "good-plugin");
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    fs::write(data_dir.join("state.txt"), "disposable data\n").map_err(|e| e.to_string())?;

    // unrelated plugin data must survive a targeted purge
    let other_data = ctx.plugin_data_dir("acme", "other-plugin");
    fs::create_dir_all(&other_data).map_err(|e| e.to_string())?;
    fs::write(other_data.join("keep.txt"), "unrelated\n").map_err(|e| e.to_string())?;

    uninstall(&ctx, "acme/good-plugin", true)?;
    c.check_fs("plugin code removed", &code_dir, false);
    c.check_fs("plugin data PURGED with --purge-data", &data_dir, false);
    c.check_fs("unrelated plugin data untouched", &other_data.join("keep.txt"), true);
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_default();
    let lua = Lua::new();
    let mut c = Checker::new();
    println!("p04 scenario: {scenario}");
    match scenario.as_str() {
        "install-local" => scenario_install_local(&lua, &mut c)?,
        "install-git" => scenario_install_git(&lua, &mut c)?,
        "reject-bad-name" => scenario_reject_bad_name(&lua, &mut c)?,
        "reject-smith-namespace" => scenario_reject_smith_namespace(&lua, &mut c)?,
        "uninstall-keeps-data" => scenario_uninstall_keeps_data(&lua, &mut c)?,
        "uninstall-purge-data" => scenario_uninstall_purge_data(&lua, &mut c)?,
        other => {
            return Err(format!(
                "unknown scenario '{other}'; expected install-local | install-git | \
                 reject-bad-name | reject-smith-namespace | uninstall-keeps-data | \
                 uninstall-purge-data"
            )
            .into())
        }
    }
    println!();
    if c.pass {
        println!("p04 RESULT: {scenario} — all assertions hold");
        Ok(())
    } else {
        Err(format!("p04 RESULT: {scenario} — assertion failed").into())
    }
}
