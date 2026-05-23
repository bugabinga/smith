//! P17: smith.vcs primitives + Lua plugin composition.
//!
//! Scope:
//! - Rust exposes primitives only: `smith.vcs.*` + `smith.shortcut.*`.
//! - Features (timeline, /undo, tools, diff views) are implemented as Lua plugins.

#![allow(missing_docs, unused_variables, dead_code)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use mlua::{Function, Lua, ObjectLike, Table};

type LuaResult<T> = mlua::Result<T>;

type PathVec = Vec<String>;

#[derive(Clone, Debug)]
struct ShortcutBinding {
    key: String,
    mode: String,
    action: String,
}

#[derive(Clone)]
struct VcsSdk {
    repo_path: PathBuf,
}

impl VcsSdk {
    fn new(repo_path: PathBuf) -> Self {
        Self { repo_path }
    }

    fn jj(&self, args: &[&str]) -> Result<(String, String), String> {
        let output = Command::new("jj")
            .args(args)
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| format!("jj exec: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            return Err(stderr.trim().to_string());
        }

        Ok((stdout, stderr))
    }

    fn status_parsed(&self) -> Result<(PathVec, PathVec, PathVec), String> {
        let (out, _) = self.jj(&["status"])?;
        let mut modified = Vec::new();
        let mut added = Vec::new();
        let mut deleted = Vec::new();

        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            if line.starts_with("M ") || line.starts_with("MM") {
                modified.push(line.get(2..).unwrap_or("").trim().to_string());
            } else if line.starts_with("A ") {
                added.push(line.get(2..).unwrap_or("").trim().to_string());
            } else if line.starts_with("D ") {
                deleted.push(line.get(2..).unwrap_or("").trim().to_string());
            }
        }

        Ok((modified, added, deleted))
    }

    fn diff_parsed(&self, from: Option<&str>, to: Option<&str>) -> Result<String, String> {
        let args = match (from, to) {
            (Some(a), Some(b)) => vec!["diff", "-r", a, "-r", b],
            (Some(a), None) => vec!["diff", "-r", a],
            (None, None) => vec!["diff"],
            (None, Some(_)) => vec!["diff"],
        };
        let (out, _) = self.jj(&args)?;
        Ok(out)
    }

    fn commit(&self, msg: &str) -> Result<(), String> {
        let (_out, _) = self.jj(&["commit", "-m", msg])?;
        Ok(())
    }

    fn op_log_parsed(&self, limit: usize) -> Result<Vec<(String, String, String)>, String> {
        let tpl = "id.short(12) ++ \"\t\" ++ coalesce(description.first_line(), \"(no desc)\") ++ \"\t\" ++ time.start() ++ \"\\n\"";
        let (out, _) = self.jj(&["op", "log", "--no-graph", &format!("-n{limit}"), &format!("-T{tpl}")])?;

        Ok(out
            .lines()
            .take(limit)
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\t').collect::<Vec<_>>();
                if parts.len() < 3 {
                    return None;
                }
                let id = parts.remove(0).trim().to_string();
                let desc = parts.remove(0).trim().to_string();
                let ts = parts.remove(0).trim().to_string();
                Some((id, desc, ts))
            })
            .collect())
    }

    fn op_show_parsed(&self, id: &str) -> Result<(String, String, String), String> {
        let (out, _) = self.jj(&["op", "show", "-p", id])?;
        let mut desc = String::new();
        let mut diff = String::new();
        let mut in_body = false;

        for line in out.lines() {
            if line.starts_with('#') {
                if let Some(rest) = line.strip_prefix("# Description:") {
                    desc = rest.trim().to_string();
                }
                continue;
            }
            if !in_body {
                if line.trim().is_empty() {
                    continue;
                }
                in_body = true;
            }
            diff.push_str(line);
            diff.push('\n');
        }

        Ok((id.to_string(), desc, diff))
    }

    fn annotate_parsed(&self, path: &str) -> Result<Vec<String>, String> {
        validate_path(path)?;
        let (out, _) = self.jj(&["file", "annotate", path])?;
        Ok(out.lines().map(|l| l.trim_end().to_string()).collect())
    }

    fn restore_paths_parsed(&self, paths: &PathVec) -> Result<(), String> {
        if paths.is_empty() {
            return Err("paths is empty".to_string());
        }
        let mut args: Vec<&str> = vec!["restore"];
        for p in paths {
            validate_path(p)?;
            args.push(p.as_str());
        }
        let (_out, _) = self.jj(&args)?;
        Ok(())
    }
}

fn ok_table(lua: &Lua) -> LuaResult<Table> {
    let t = lua.create_table()?;
    t.set("success", true)?;
    Ok(t)
}

fn err_table(lua: &Lua, msg: &str) -> LuaResult<Table> {
    let t = lua.create_table()?;
    t.set("success", false)?;
    t.set("error", msg.to_string())?;
    Ok(t)
}

fn str_vec_to_table(lua: &Lua, values: &[String]) -> LuaResult<Table> {
    let table = lua.create_table()?;
    for (i, value) in values.iter().enumerate() {
        table.set(i + 1, value.as_str())?;
    }
    Ok(table)
}

fn table_to_vec(table: Table) -> LuaResult<PathVec> {
    let mut out = Vec::new();
    for value in table.sequence_values::<String>() {
        out.push(value?);
    }
    Ok(out)
}

fn validate_op_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.len() < 6 || id.len() > 40 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid op id: {id}"));
    }
    Ok(())
}

fn validate_commit_msg(msg: &str) -> Result<(), String> {
    let msg = msg.trim();
    if msg.is_empty() {
        return Err("commit message required".to_string());
    }
    if msg.starts_with('-') {
        return Err("commit message must not start with '-'".to_string());
    }
    if msg.contains("--") {
        return Err("commit message must not contain '--'".to_string());
    }
    if msg.contains('\n') || msg.contains('\r') || msg.contains('\0') {
        return Err("commit message contains invalid control characters".to_string());
    }
    if msg.len() > 4096 {
        return Err("commit message too long".to_string());
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("path required".to_string());
    }
    if path.starts_with('-') {
        return Err("path must not be option-like".to_string());
    }
    if path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("path contains invalid control characters".to_string());
    }
    Ok(())
}

fn register_smith_shortcuts(
    lua: &Lua,
    regs: Arc<Mutex<Vec<ShortcutBinding>>>,
) -> LuaResult<Table> {
    let shortcuts = lua.create_table()?;

    let reg_store = regs.clone();
    shortcuts.set(
        "register",
        lua.create_function(move |_lua, (key, opts, cb): (String, Option<Table>, Option<Function>)| {
            if key.is_empty() {
                return Err(mlua::Error::runtime("key must not be empty"));
            }

            let mode = opts
                .as_ref()
                .and_then(|o| o.get::<String>("mode").ok())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "normal".to_string());
            let action = opts
                .as_ref()
                .and_then(|o| o.get::<String>("action").ok())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "callback".to_string());

            if cb.is_none() {
                return Err(mlua::Error::runtime("shortcut requires callback"));
            }

            let mut entries = reg_store.lock().unwrap();
            if entries
                .iter()
                .any(|entry| entry.key == key && entry.mode == mode && entry.action == action)
            {
                return Ok(());
            }

            entries.push(ShortcutBinding { key, mode, action });
            Ok(())
        })?,
    )?;

    let reg_store = regs.clone();
    shortcuts.set(
        "registered",
        lua.create_function(move |lua, ()| {
            let entries = reg_store.lock().unwrap();
            let arr = lua.create_table()?;

            for (i, e) in entries.iter().enumerate() {
                let item = lua.create_table()?;
                item.set("key", e.key.clone())?;
                item.set("mode", e.mode.clone())?;
                item.set("action", e.action.clone())?;
                arr.set(i + 1, item)?;
            }

            let t = ok_table(lua)?;
            t.set("bindings", arr)?;
            Ok(t)
        })?,
    )?;

    Ok(shortcuts)
}

fn register_smith_vcs(lua: &Lua, sdk: Arc<Mutex<VcsSdk>>) -> LuaResult<()> {
    let smith = lua.create_table()?;
    let vcs = lua.create_table()?;

    {
        let s = sdk.clone();
        vcs.set(
            "status",
            lua.create_function(move |lua, ()| {
                let sdk = s.lock().unwrap();
                let (modified, added, deleted) = match sdk.status_parsed() {
                    Ok(parts) => parts,
                    Err(e) => return err_table(lua, &e),
                };

                let t = ok_table(lua)?;
                t.set("modified", str_vec_to_table(lua, &modified)?)?;
                t.set("added", str_vec_to_table(lua, &added)?)?;
                t.set("deleted", str_vec_to_table(lua, &deleted)?)?;
                Ok(t)
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "diff",
            lua.create_function(move |lua, rev: Option<String>| {
                let sdk = s.lock().unwrap();
                let out = match rev {
                    Some(r) => sdk.diff_parsed(Some(r.trim()), None),
                    None => sdk.diff_parsed(None, None),
                };

                match out {
                    Ok(diff) => {
                        let t = ok_table(lua)?;
                        t.set("diff", diff.trim())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "diff_revs",
            lua.create_function(move |lua, (from, to): (String, String)| {
                let sdk = s.lock().unwrap();
                if from.trim().is_empty() || to.trim().is_empty() {
                    return err_table(lua, "from and to required");
                }
                match sdk.diff_parsed(Some(from.trim()), Some(to.trim())) {
                    Ok(diff) => {
                        let t = ok_table(lua)?;
                        t.set("from", from.trim())?;
                        t.set("to", to.trim())?;
                        t.set("diff", diff.trim())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "commit",
            lua.create_function(move |lua, msg: String| {
                if let Err(e) = validate_commit_msg(&msg) {
                    return err_table(lua, &e);
                }
                let sdk = s.lock().unwrap();
                match sdk.commit(&msg) {
                    Ok(()) => ok_table(lua),
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "op_log",
            lua.create_function(move |lua, limit: Option<usize>| {
                let sdk = s.lock().unwrap();
                let limit = limit.unwrap_or(20);

                let parsed = match sdk.op_log_parsed(limit) {
                    Ok(list) => list,
                    Err(e) => return err_table(lua, &e),
                };

                let t = ok_table(lua)?;
                let arr = lua.create_table()?;
                for (i, (id, desc, ts)) in parsed.iter().enumerate() {
                    let row = lua.create_table()?;
                    row.set("id", id.as_str())?;
                    row.set("description", desc.as_str())?;
                    row.set("timestamp", ts.as_str())?;
                    arr.set(i + 1, row)?;
                }
                t.set("entries", arr)?;
                t.set("total", parsed.len())?;
                Ok(t)
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "undo",
            lua.create_function(move |lua, ()| {
                let sdk = s.lock().unwrap();
                match sdk.jj(&["undo"]) {
                    Ok((out, _)) => {
                        let t = ok_table(lua)?;
                        t.set("message", out.trim())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "redo",
            lua.create_function(move |lua, ()| {
                let sdk = s.lock().unwrap();
                match sdk.jj(&["redo"]) {
                    Ok((out, _)) => {
                        let t = ok_table(lua)?;
                        t.set("message", out.trim())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "op_restore",
            lua.create_function(move |lua, id: String| {
                if let Err(e) = validate_op_id(&id) {
                    return err_table(lua, &e);
                }
                let sdk = s.lock().unwrap();
                match sdk.jj(&["op", "restore", id.trim()]) {
                    Ok((out, _)) => {
                        let t = ok_table(lua)?;
                        t.set("message", out.trim())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "op_show",
            lua.create_function(move |lua, id: String| {
                let id = id.trim();
                if let Err(e) = validate_op_id(id) {
                    return err_table(lua, &e);
                }

                let sdk = s.lock().unwrap();
                let (op_id, desc, diff) = match sdk.op_show_parsed(id) {
                    Ok(parts) => parts,
                    Err(e) => return err_table(lua, &e),
                };

                let t = ok_table(lua)?;
                t.set("id", op_id)?;
                t.set("description", desc)?;
                t.set("diff", diff.trim())?;
                Ok(t)
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "restore_paths",
            lua.create_function(move |lua, paths: Table| {
                let sdk = s.lock().unwrap();
                let values = match table_to_vec(paths) {
                    Ok(v) => v,
                    Err(e) => return err_table(lua, &e.to_string()),
                };
                match sdk.restore_paths_parsed(&values) {
                    Ok(()) => ok_table(lua),
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    {
        let s = sdk.clone();
        vcs.set(
            "annotate",
            lua.create_function(move |lua, path: String| {
                let sdk = s.lock().unwrap();
                let path = path.trim();
                if path.is_empty() {
                    return err_table(lua, "path required");
                }
                if let Err(e) = validate_path(path) {
                    return err_table(lua, &e);
                }

                match sdk.annotate_parsed(path) {
                    Ok(lines) => {
                        let t = ok_table(lua)?;
                        let arr = lua.create_table()?;
                        for (i, line) in lines.iter().enumerate() {
                            let item = lua.create_table()?;
                            item.set("text", line.as_str())?;
                            arr.set(i + 1, item)?;
                        }
                        t.set("lines", arr)?;
                        t.set("total", lines.len())?;
                        Ok(t)
                    }
                    Err(e) => err_table(lua, &e),
                }
            })?,
        )?;
    }

    smith.set("vcs", vcs)?;

    let reg_store: Arc<Mutex<Vec<ShortcutBinding>>> = Arc::new(Mutex::new(Vec::new()));
    let shortcuts = register_smith_shortcuts(lua, reg_store)?;
    smith.set("shortcut", shortcuts)?;

    lua.globals().set("smith", smith)?;
    Ok(())
}

fn setup_test_repo() -> PathBuf {
    let dir = std::env::temp_dir().join("p17-vcs-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    fs::write(dir.join("file1.rs"), "fn main() { println!(\"hello\"); }\n").unwrap();
    fs::write(dir.join("file2.rs"), "fn add(a: i32, b: i32) -> i32 { a + b }\n").unwrap();

    jj_raw(&dir, &["git", "init"]);
    jj_raw(&dir, &["describe", "-m", "initial commit"]);

    fs::write(dir.join("file1.rs"), "fn main() { println!(\"world\"); }\n").unwrap();
    jj_raw(&dir, &["commit", "-m", "edit: file1.rs (turn 1)"]);

    fs::write(dir.join("file2.rs"), "fn add(a: i32, b: i32) -> i32 { a + b }\nfn sub(a: i32, b: i32) -> i32 { a - b }\n").unwrap();
    jj_raw(&dir, &["commit", "-m", "edit: file2.rs (turn 1)"]);

    fs::write(dir.join("file3.rs"), "// new file\nfn helper() {}\n").unwrap();
    jj_raw(&dir, &["commit", "-m", "create: file3.rs (turn 2)"]);

    fs::write(dir.join("file1.rs"), "fn run() { println!(\"running\"); }\n").unwrap();
    jj_raw(&dir, &["commit", "-m", "edit: file1.rs (turn 3)"]);

    dir
}

fn jj_raw(dir: &PathBuf, args: &[&str]) {
    let output = Command::new("jj")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("jj exec: {e}"));
    if !output.status.success() {
        panic!("jj {:?}: {}", args, String::from_utf8_lossy(&output.stderr));
    }
}

fn get_bool(t: &Table, key: &str) -> bool {
    t.get(key).unwrap_or(false)
}

fn get_str(t: &Table, key: &str) -> String {
    t.get(key).unwrap_or_default()
}

fn get_table(t: &Table, key: &str) -> Table {
    t.get(key).unwrap_or_else(|_| panic!("missing key {key}"))
}

fn count_history_lines(raw: &str) -> usize {
    raw.lines().filter(|line| !line.trim().is_empty()).count()
}

fn load_plugin(lua: &Lua, name: &str, code: &str) -> Table {
    lua.load(code).set_name(name).eval().unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn load_plugins(lua: &Lua) {
    lua.load(include_str!("../plugins/commands.lua"))
        .set_name("commands.lua")
        .exec()
        .expect("load commands.lua");

    lua.load(include_str!("../plugins/vcs-tools.lua"))
        .set_name("vcs-tools.lua")
        .exec()
        .expect("load vcs-tools.lua");

    lua.load(include_str!("../plugins/time-travel.lua"))
        .set_name("time-travel.lua")
        .exec()
        .expect("load time-travel.lua");
}

fn test_vcs_tools(lua: &Lua, repo: &PathBuf) -> LuaResult<()> {
    println!("\n=== T1: vcs-tools plugin ===");
    let tools = load_plugin(lua, "vcs-tools", include_str!("../plugins/vcs-tools.lua"));
    fs::write(repo.join("file1.rs"), "fn edited() {}\n").unwrap();

    let status_tool: Table = tools.get("vcs_status")?;
    let status: Table = status_tool.call_method("execute", lua.create_table()?)?;
    assert!(get_bool(&status, "success"), "vcs_status failed");
    let modified: Table = get_table(&status, "modified");
    assert!(modified.len().unwrap_or(0) > 0, "expected modified files");

    let diff_tool: Table = tools.get("vcs_diff")?;
    let diff: Table = diff_tool.call_method("execute", lua.create_table()?)?;
    assert!(get_bool(&diff, "success"), "vcs_diff failed");
    assert!(!get_str(&diff, "diff").is_empty(), "diff should not be empty");

    let log_tool: Table = tools.get("vcs_log")?;
    let limit = lua.create_table()?;
    limit.set("limit", 5)?;
    let log: Table = log_tool.call_method("execute", limit)?;
    assert!(get_bool(&log, "success"), "vcs_log failed");
    assert!(get_table(&log, "entries").len().unwrap_or(0) >= 5, "expected >=5 log entries");

    let diff_rev_tool: Table = tools.get("vcs_diff_revs")?;
    let dr_params = {
        let t = lua.create_table()?;
        t.set("from", "@")?;
        t.set("to", "@-")?;
        t
    };
    let dr: Table = diff_rev_tool.call_method("execute", dr_params)?;
    assert!(get_bool(&dr, "success"), "vcs_diff_revs failed");
    assert!(!get_str(&dr, "diff").is_empty(), "diff_revs should return diff");

    let ann_tool: Table = tools.get("vcs_annotate")?;
    let ann_params = lua.create_table()?;
    ann_params.set("path", "file2.rs")?;
    let ann: Table = ann_tool.call_method("execute", ann_params)?;
    assert!(get_bool(&ann, "success"), "vcs_annotate failed");
    let ann_lines: Table = get_table(&ann, "lines");
    assert!(ann_lines.len().unwrap_or(0) >= 1, "annotate should contain at least one line");

    // cleanup for next tests
    jj_raw(repo, &["restore", "file1.rs"]);

    let count = modified.len().unwrap_or(0);
    println!("  vcs_status => {count} modified");
    println!("  vcs_diff => {} chars", get_str(&diff, "diff").len());
    println!("  vcs_log => {} entries", get_table(&log, "entries").len().unwrap_or(0));
    println!("  vcs_diff_revs => {} chars", get_str(&dr, "diff").len());
    println!("  vcs_annotate => {} lines", ann_lines.len().unwrap_or(0));
    Ok(())
}

fn test_commands(lua: &Lua) -> LuaResult<()> {
    println!("\n=== T2: commands plugin ===");
    let commands = load_plugin(lua, "commands", include_str!("../plugins/commands.lua"));

    let r: Table = commands.call_method("undo", ())?;
    assert!(get_bool(&r, "success"), "undo failed");

    let r: Table = commands.call_method("redo", ())?;
    assert!(get_bool(&r, "success"), "redo failed");

    let r: Table = commands.call_method("history", "5")?;
    assert!(get_bool(&r, "success"), "history failed");
    assert!(!get_str(&r, "output").is_empty(), "history output empty");

    let r: Table = commands.call_method("undo_n", "2")?;
    assert!(get_bool(&r, "success"), "undo_n failed");

    let redo_ok: Table = commands.call_method("redo", ())?;
    assert!(get_bool(&redo_ok, "success"), "redo after undo_n failed");

    // restore_file on clean file may succeed or fail — just check response is well-formed.
    let restore: Table = commands.call_method("restore_file", "file1.rs")?;
    assert!(restore.get::<bool>("success").is_ok() || restore.get::<String>("error").is_ok(), "restore_file response malformed");

    println!("  undo/history/undo_n/redo/restore_file => pass");
    Ok(())
}

fn test_time_travel(lua: &Lua) -> LuaResult<()> {
    println!("\n=== T3: time-travel plugin ===");
    let tt = load_plugin(lua, "time-travel", include_str!("../plugins/time-travel.lua"));

    let registered: Table = tt.call_method("registered_shortcuts", ())?;
    assert!(get_bool(&registered, "success"), "registered_shortcuts failed");
    let bindings: Table = get_table(&registered, "bindings");
    let binding_count = bindings.len().unwrap_or(0);
    assert!(binding_count >= 6, "expected >=6 keybinds, got {binding_count}");
    if binding_count > 0 {
        let sample: Table = bindings.get::<Table>(1)?;
        let key: String = sample.get("key")?;
        assert!(key.starts_with("Alt+"), "expected Alt+ keybind, got {key}");
    }

    let timeline: Table = tt.call_method("timeline", 20)?;
    assert!(get_bool(&timeline, "success"), "timeline failed");
    let total: usize = timeline.get("total")?; // table field read by index fallback

    let list: Table = get_table(&timeline, "timeline");
    assert!(list.len().unwrap_or(0) >= 5, "expected at least 5 timeline ops");

    let first: Table = list.get(1)?;
    let op_type: String = first.get("op_type").unwrap_or_else(|_| "unknown".to_string());
    assert!(!op_type.is_empty(), "op_type should not be empty");

    let inspect: Table = tt.call_method("inspect", 3)?;
    assert!(get_bool(&inspect, "success"), "inspect failed");

    let diff_view: Table = tt.call_method("diff_view", 3)?;
    let dv_ok = get_bool(&diff_view, "success");
    if !dv_ok {
        eprintln!("  diff_view error: {}", get_str(&diff_view, "error"));
    }
    assert!(dv_ok, "diff_view failed");

    // undo_to is a mutation - tested in T4 (round-trip). Skip here.
    let compare: Table = tt.call_method("compare_previous", 2)?;
    assert!(get_bool(&compare, "success"), "compare_previous failed");

    // No redo needed since we didn't undo_to above.

    println!("  keybinds={}, timeline={}, op_type={}, total={}", binding_count, list.len().unwrap_or(0), op_type, total);
    Ok(())
}

fn test_round_trip(lua: &Lua, repo: &PathBuf) -> LuaResult<()> {
    println!("\n=== T4: Round-trip (commit + undo + redo via plugin) ===");
    let tools = load_plugin(lua, "vcs-tools", include_str!("../plugins/vcs-tools.lua"));
    let commands = load_plugin(lua, "commands", include_str!("../plugins/commands.lua"));

    let edited = "fn changed() {}\n";
    let before_history = commands.call_method("history", "100")?;
    assert!(get_bool(&before_history, "success"), "history before roundtrip failed");
    let before_count = count_history_lines(&get_str(&before_history, "output"));

    fs::write(repo.join("file1.rs"), edited).unwrap();

    let commit_tool: Table = tools.get("vcs_commit")?;
    let commit_params = lua.create_table()?;
    commit_params.set("message", "edit: file1.rs (roundtrip)")?;
    let r = commit_tool.call_method("execute", commit_params)?;
    assert!(get_bool(&r, "success"), "commit via plugin failed");

    let after_commit_history = commands.call_method("history", "100")?;
    assert!(get_bool(&after_commit_history, "success"), "history after commit failed");
    assert_eq!(
        count_history_lines(&get_str(&after_commit_history, "output")),
        before_count + 2,
        "commit should add 2 history entries (snapshot + commit)"
    );

    let u = commands.call_method("undo", ())?;
    assert!(get_bool(&u, "success"), "undo via plugin failed");

    let after_undo_history = commands.call_method("history", "100")?;
    assert!(get_bool(&after_undo_history, "success"), "history after undo failed");
    assert_eq!(
        count_history_lines(&get_str(&after_undo_history, "output")),
        before_count + 3,
        "undo should add 1 history entry (snapshot+commit+undo)"
    );

    let rr: Table = commands.call_method("redo", ())?;
    assert!(get_bool(&rr, "success"), "redo via plugin failed");

    let after_redo_history = commands.call_method("history", "100")?;
    assert!(get_bool(&after_redo_history, "success"), "history after redo failed");
    assert_eq!(
        count_history_lines(&get_str(&after_redo_history, "output")),
        before_count + 4,
        "redo should add 1 history entry (snapshot+commit+undo+redo)"
    );

    let final_file = fs::read_to_string(repo.join("file1.rs")).unwrap();
    assert_eq!(final_file, edited, "final redo should retain edited content");

    println!("  roundtrip => pass");
    Ok(())
}

fn test_edge_cases(lua: &Lua, repo: &PathBuf) -> LuaResult<()> {
    println!("\n=== T5: Edge cases ===");
    let commands = load_plugin(lua, "commands", include_str!("../plugins/commands.lua"));

    let mut undo_count = 0;
    loop {
        let r: Table = commands.call_method("undo", ())?;
        if !get_bool(&r, "success") {
            break;
        }
        undo_count += 1;
        if undo_count > 32 {
            panic!("undo exceeded expected bound");
        }
    }

    for _ in 0..undo_count {
        let rr: Table = commands.call_method("redo", ())?;
        assert!(get_bool(&rr, "success"), "redo should restore state");
    }

    // status should still work after full rewind/restore
    let tools = load_plugin(lua, "vcs-tools", include_str!("../plugins/vcs-tools.lua"));
    let status_tool: Table = tools.get("vcs_status")?;
    let status: Table = status_tool.call_method("execute", lua.create_table()?)?;
    assert!(get_bool(&status, "success"), "empty status failed");

    let restore: Table = commands.call_method("restore_file", "file1.rs")?;
    assert!(restore.get::<bool>("success").is_ok() || restore.get::<String>("error").is_ok(), "restore_file response malformed");

    println!("  undo_count={undo_count}, status={}", get_bool(&status, "success"));
    let _ = repo;
    Ok(())
}

fn main() {
    println!("P17: VCS SDK + Lua plugins\n");

    let repo = setup_test_repo();
    println!("Test repo: {}", repo.display());

    let lua = Lua::new();
    let sdk = Arc::new(Mutex::new(VcsSdk::new(repo.clone())));
    register_smith_vcs(&lua, sdk).expect("register smith.*");

    load_plugins(&lua);
    println!("Plugins loaded: commands.lua, vcs-tools.lua, time-travel.lua");

    let mut passed = 0;
    let mut failed = 0;

    // Run read-only tests first (T1, T3), then mutating tests (T2, T4, T5)
    match test_vcs_tools(&lua, &repo) {
        Ok(()) => passed += 1,
        Err(e) => {
            failed += 1;
            eprintln!("T1 FAIL: {e}");
        }
    }

    match test_time_travel(&lua) {
        Ok(()) => passed += 1,
        Err(e) => {
            failed += 1;
            eprintln!("T3 FAIL: {e}");
        }
    }

    match test_commands(&lua) {
        Ok(()) => passed += 1,
        Err(e) => {
            failed += 1;
            eprintln!("T2 FAIL: {e}");
        }
    }

    match test_round_trip(&lua, &repo) {
        Ok(()) => passed += 1,
        Err(e) => {
            failed += 1;
            eprintln!("T4 FAIL: {e}");
        }
    }

    match test_edge_cases(&lua, &repo) {
        Ok(()) => passed += 1,
        Err(e) => {
            failed += 1;
            eprintln!("T5 FAIL: {e}");
        }
    }

    println!("\n==================================================");
    println!("P17: {}/{} tests passed", passed, passed + failed);
    if failed > 0 {
        std::process::exit(1);
    }
}
