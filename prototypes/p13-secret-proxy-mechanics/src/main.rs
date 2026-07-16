//! p13-secret-proxy-mechanics
//!
//! Proves or disproves docs/SPEC.md §6.7 (Secret Proxy):
//! - registry `SecretId → plaintext + label`; plaintext exists only in
//!   secret-registration session entries (§6.6 length-prefixed CBOR),
//! - ingestion masks by exact substring match, AFTER plugin
//!   `input`/`tool_result` hooks (§9.8 return shapes) — a value registered
//!   DURING a hook is masked in the very content that surfaced it,
//! - rehydration only immediately before tool execution (Rust and Lua alike);
//!   provider view keeps placeholders; unknown ids pass through untouched,
//! - resume rebuilds the table by backward scan over session entries,
//! - edge hunting: overlapping secrets (longest-match-first), a registered
//!   value that IS a placeholder string, hook transforms that hide the secret
//!   from the post-transform scan.
//!
//! Verify: `cargo run -- ingest|hook-order|rehydrate|resume|all`
//! Each exits 0 with PASS lines when the expectations hold.

use std::cell::RefCell;
use std::error::Error;
use std::io::Read as _;
use std::rc::Rc;

use mlua::{Function, Lua, Table, Value as LuaValue};
use serde::{Deserialize, Serialize};

const DETECTOR: &str = include_str!("../plugins/detector.lua");

// ---------------------------------------------------------------- registry

/// One registered secret: SecretId (numeric here; §5.1 SecretId(String) in
/// the real system) → plaintext + label. Placeholder text is `smith:sec:N`.
#[derive(Debug, Clone)]
struct SecretEntry {
    id: u64,
    value: String,
    label: String,
}

#[derive(Debug, Default)]
struct Registry {
    next_id: u64,
    entries: Vec<SecretEntry>,
}

impl Registry {
    fn new() -> Self {
        Registry { next_id: 1, entries: Vec::new() }
    }

    /// Register a value; idempotent on identical plaintext (a detector hook
    /// re-seeing the same token must not mint a new id). §6.7 is silent on
    /// duplicate registration — this is the behavior we report.
    fn register(&mut self, value: &str, label: &str) -> u64 {
        if let Some(e) = self.entries.iter().find(|e| e.value == value) {
            return e.id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push(SecretEntry { id, value: value.to_string(), label: label.to_string() });
        id
    }

    fn by_id(&self, id: u64) -> Option<&SecretEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn by_value(&self, value: &str) -> Option<&SecretEntry> {
        self.entries.iter().find(|e| e.value == value)
    }
}

fn placeholder(id: u64) -> String {
    format!("smith:sec:{id}")
}

// ------------------------------------------------------------------ masking

/// Ingestion scan: exact substring masking of ALL registered values.
/// Rule under test: LONGEST-MATCH-FIRST at each position, single
/// left-to-right pass. The pass never rescans emitted placeholder text, so
/// masking output cannot cascade into further matches.
fn mask(content: &str, reg: &Registry) -> String {
    let mut by_len: Vec<&SecretEntry> =
        reg.entries.iter().filter(|e| !e.value.is_empty()).collect();
    by_len.sort_by(|a, b| b.value.len().cmp(&a.value.len()));

    let mut out = String::new();
    let mut i = 0;
    while i < content.len() {
        if let Some(e) = by_len.iter().find(|e| content[i..].starts_with(&e.value)) {
            out.push_str(&placeholder(e.id));
            i += e.value.len();
        } else {
            let ch = content[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Deliberately WRONG masking used only to demonstrate the overlap hazard:
/// sequential whole-string replace, shortest value first.
fn naive_mask_shortest_first(content: &str, reg: &Registry) -> String {
    let mut by_len: Vec<&SecretEntry> =
        reg.entries.iter().filter(|e| !e.value.is_empty()).collect();
    by_len.sort_by(|a, b| a.value.len().cmp(&b.value.len()));
    let mut s = content.to_string();
    for e in by_len {
        s = s.replace(&e.value, &placeholder(e.id));
    }
    s
}

/// Rehydration: `smith:sec:` + maximal digit run → plaintext when the id is
/// registered; an unknown id passes through UNTOUCHED (never an error).
/// Single pass: rehydrated plaintext is never rescanned.
fn rehydrate(content: &str, reg: &Registry) -> String {
    const PREFIX: &str = "smith:sec:";
    let mut out = String::new();
    let mut rest = content;
    while let Some(pos) = rest.find(PREFIX) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + PREFIX.len()..];
        let digits_len = after.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits_len == 0 {
            out.push_str(PREFIX);
            rest = after;
            continue;
        }
        let digits = &after[..digits_len];
        match digits.parse::<u64>().ok().and_then(|id| reg.by_id(id)) {
            Some(e) => out.push_str(&e.value),
            None => {
                out.push_str(PREFIX);
                out.push_str(digits);
            }
        }
        rest = &after[digits_len..];
    }
    out.push_str(rest);
    out
}

// ------------------------------------------------------------ session codec

/// Session entries, §6.6 framing: `u32 BE len | CBOR entry bytes | ...`.
/// Plaintext is allowed in exactly one kind: `SecretRegistration`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum SessionEntry {
    SecretRegistration { id: u64, value: String, label: String },
    UserMessage { text: String },
    ToolCall { name: String, args_json: String },
    ToolResult { content: String },
}

fn entry_text(e: &SessionEntry) -> &str {
    match e {
        SessionEntry::SecretRegistration { value, .. } => value,
        SessionEntry::UserMessage { text } => text,
        SessionEntry::ToolCall { args_json, .. } => args_json,
        SessionEntry::ToolResult { content } => content,
    }
}

fn write_session(path: &std::path::Path, entries: &[SessionEntry]) -> Result<(), Box<dyn Error>> {
    let mut buf = Vec::new();
    for e in entries {
        let mut body = Vec::new();
        ciborium::ser::into_writer(e, &mut body)?;
        buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
        buf.extend_from_slice(&body);
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, buf)?;
    Ok(())
}

fn read_session(path: &std::path::Path) -> Result<Vec<SessionEntry>, Box<dyn Error>> {
    let bytes = std::fs::read(path)?;
    let mut cur = &bytes[..];
    let mut entries = Vec::new();
    while !cur.is_empty() {
        let mut len_buf = [0u8; 4];
        cur.read_exact(&mut len_buf)?;
        let len = u32::from_be_bytes(len_buf) as usize;
        let (body, rest) = cur.split_at(len);
        entries.push(ciborium::de::from_reader(body)?);
        cur = rest;
    }
    Ok(entries)
}

/// Resume: rebuild the table by scanning entries BACKWARD for registration
/// entries (most recent first; first occurrence of an id wins). The id
/// allocator must resume past the max id seen, or a post-resume registration
/// would mint a colliding id and silently alias old placeholders.
fn rebuild_registry(entries: &[SessionEntry]) -> Registry {
    let mut reg = Registry::new();
    let mut max_id = 0;
    for e in entries.iter().rev() {
        if let SessionEntry::SecretRegistration { id, value, label } = e {
            if reg.by_id(*id).is_none() {
                reg.entries.push(SecretEntry { id: *id, value: value.clone(), label: label.clone() });
            }
            max_id = max_id.max(*id);
        }
    }
    reg.next_id = max_id + 1;
    reg
}

// --------------------------------------------------------------- lua bridge

/// Fresh Lua with `smith.secret.register(value, label) -> placeholder`
/// bridged to the shared registry, plus the detector plugin's hook table.
fn setup_lua(reg: Rc<RefCell<Registry>>) -> mlua::Result<(Lua, Table)> {
    let lua = Lua::new();
    let smith = lua.create_table()?;
    let secret = lua.create_table()?;
    secret.set(
        "register",
        lua.create_function(move |_, (value, label): (String, String)| {
            let id = reg.borrow_mut().register(&value, &label);
            Ok(placeholder(id))
        })?,
    )?;
    smith.set("secret", secret)?;
    lua.globals().set("smith", smith)?;
    let hooks: Table = lua.load(DETECTOR).set_name("plugins/detector.lua").eval()?;
    Ok((lua, hooks))
}

#[derive(Clone, Copy)]
enum Channel {
    Input,
    ToolResult,
}

/// The §6.7 ingestion pipeline: raw content → plugin hook (§9.8 return
/// shapes) → ingestion scan over the POST-hook content → entry content.
fn ingest(
    lua: &Lua,
    hook: Option<&Function>,
    channel: Channel,
    raw: &str,
    reg: &Rc<RefCell<Registry>>,
) -> Result<String, Box<dyn Error>> {
    let post_hook = match hook {
        Some(f) => {
            let ev = lua.create_table()?;
            match channel {
                Channel::Input => {
                    ev.set("type", "input")?;
                    ev.set("text", raw)?;
                }
                Channel::ToolResult => {
                    ev.set("type", "tool_result")?;
                    ev.set("content", raw)?;
                }
            }
            let ret: LuaValue = f.call(ev)?;
            match (channel, ret) {
                // input → { action = "handled"|"continue", text = <transformed>? }
                (Channel::Input, LuaValue::Table(t)) => {
                    t.get::<Option<String>>("text")?.unwrap_or_else(|| raw.to_string())
                }
                // tool_result → { content = <replacement> } or nil (keep)
                (Channel::ToolResult, LuaValue::Table(t)) => {
                    t.get::<Option<String>>("content")?.unwrap_or_else(|| raw.to_string())
                }
                _ => raw.to_string(),
            }
        }
        None => raw.to_string(),
    };
    // Scan runs strictly AFTER the hook returned — this is the ordering
    // §6.7 promises, and why hook-registered values land masked.
    Ok(mask(&post_hook, &reg.borrow()))
}

// ------------------------------------------------------------------ helpers

struct Check {
    pass: bool,
}

impl Check {
    fn ok(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    haystack.windows(needle.len()).filter(|w| *w == needle).count()
}

fn session_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(name)
}

// ---------------------------------------------------------------- scenarios

fn scenario_ingest(c: &mut Check) -> Result<(), Box<dyn Error>> {
    println!("== ingest: masking at ingestion; plaintext only in registration entries ==");
    let reg = Rc::new(RefCell::new(Registry::new()));
    let id1 = reg.borrow_mut().register("hunter2-token", "db-pass");
    let mut entries = vec![SessionEntry::SecretRegistration {
        id: id1,
        value: "hunter2-token".into(),
        label: "db-pass".into(),
    }];

    let masked = mask("connect with hunter2-token now", &reg.borrow());
    c.ok(
        &format!("user message masked at ingestion: {masked:?}"),
        masked == "connect with smith:sec:1 now",
    );
    entries.push(SessionEntry::UserMessage { text: masked });

    let tr = mask("stdout: hunter2-token appears twice hunter2-token", &reg.borrow());
    c.ok(
        "tool result masked (every occurrence)",
        tr == "stdout: smith:sec:1 appears twice smith:sec:1",
    );
    entries.push(SessionEntry::ToolResult { content: tr });

    let path = session_path("p13-ingest.session");
    write_session(&path, &entries)?;
    let bytes = std::fs::read(&path)?;
    let n = count_occurrences(&bytes, b"hunter2-token");
    c.ok(
        &format!("session file bytes hold plaintext exactly once (found {n}, in the registration entry)"),
        n == 1,
    );
    let decoded = read_session(&path)?;
    let leak = decoded.iter().any(|e| {
        !matches!(e, SessionEntry::SecretRegistration { .. })
            && entry_text(e).contains("hunter2-token")
    });
    c.ok("decoded: no non-registration entry holds plaintext", !leak);

    // EDGE (a): overlapping secrets — one value is a substring of another.
    let id_short = reg.borrow_mut().register("abc", "short");
    let id_long = reg.borrow_mut().register("abc-123", "long");
    let m = mask("use abc-123 then abc alone", &reg.borrow());
    let want = format!("use smith:sec:{id_long} then smith:sec:{id_short} alone");
    c.ok(
        &format!("overlap: longest-match-first masks correctly: {m:?}"),
        m == want,
    );
    let naive = naive_mask_shortest_first("use abc-123 then abc alone", &reg.borrow());
    println!("     naive shortest-first output: {naive:?}");
    c.ok(
        "overlap: naive shortest-first corrupts — long secret never masked, '-123' residue leaks",
        naive.contains(&format!("smith:sec:{id_short}-123"))
            && !naive.contains(&placeholder(id_long)),
    );

    // EDGE (b): a registered value that IS a placeholder string.
    let id_ph = reg.borrow_mut().register("smith:sec:1", "placeholder-shaped");
    let m2 = mask("value smith:sec:1 here", &reg.borrow());
    c.ok(
        &format!("placeholder-shaped secret: legit placeholder text in fresh content is re-masked (aliased): {m2:?}"),
        m2 == format!("value smith:sec:{id_ph} here"),
    );
    let r1 = rehydrate(&m2, &reg.borrow());
    c.ok(
        "placeholder-shaped secret: single-pass rehydration yields the literal placeholder string, not secret 1 plaintext",
        r1 == "value smith:sec:1 here",
    );
    let r2 = rehydrate(&r1, &reg.borrow());
    println!("     a SECOND rehydration pass would yield: {r2:?} (secret 1 plaintext — recursion hazard if rehydration were not single-pass)");
    c.ok(
        "placeholder-shaped secret: double rehydration would expose secret 1 — single-pass rule is load-bearing",
        r2 == "value hunter2-token here",
    );
    Ok(())
}

fn scenario_hook_order(c: &mut Check) -> Result<(), Box<dyn Error>> {
    println!("== hook-order: ingestion scan runs AFTER plugin hooks ==");
    let reg = Rc::new(RefCell::new(Registry::new()));
    let (lua, hooks) = setup_lua(reg.clone())?;

    // Value registered DURING the tool_result hook is masked in the very
    // content that surfaced it.
    let tr_hook: Function = hooks.get("tool_result")?;
    let e1 = ingest(&lua, Some(&tr_hook), Channel::ToolResult, "deploy key: secret-A1B2C3 end", &reg)?;
    c.ok(
        &format!("tool_result: value registered DURING hook is masked in same content: {e1:?}"),
        e1 == "deploy key: smith:sec:1 end",
    );
    c.ok(
        "registry holds the hook-registered value with its label",
        reg.borrow().by_value("secret-A1B2C3").map(|e| e.label.clone())
            == Some("detected:A1B2C3".into()),
    );

    // input hook that registers AND transforms (§9.8 { action, text }):
    // the scan runs on the post-transform text; the value survives the
    // transform verbatim, so it is masked.
    let in_hook: Function = hooks.get("input")?;
    let e2 = ingest(&lua, Some(&in_hook), Channel::Input, "my token secret-DDDD here", &reg)?;
    c.ok(
        &format!("input: transform + register — scan masks post-transform content: {e2:?}"),
        e2 == "[seen] my token smith:sec:2 here",
    );

    // EDGE (c): hook transforms so the secret appears only in PRE-transform
    // text (uppercase re-encoding). Scan sees post-transform content only —
    // the derived form lands in the entry unmasked.
    let up_hook: Function = hooks.get("input_upper")?;
    let e3 = ingest(&lua, Some(&up_hook), Channel::Input, "escape secret-eee ok", &reg)?;
    println!("     post-transform entry content: {e3:?}");
    c.ok(
        "EDGE: transform re-encodes the secret — exact scan (post-transform only) misses it; derived plaintext lands in the entry",
        e3 == "ESCAPE SECRET-EEE OK" && reg.borrow().by_value("secret-eee").is_some(),
    );
    Ok(())
}

fn scenario_rehydrate(c: &mut Check) -> Result<(), Box<dyn Error>> {
    println!("== rehydrate: plaintext only at tool execution; unknown ids untouched ==");
    let mut reg = Registry::new();
    reg.register("hunter2-token", "db-pass"); // id 1
    // Force a two-digit id to prove maximal-digit-run parsing.
    reg.entries.push(SecretEntry { id: 12, value: "twelve-plain".into(), label: "twelve".into() });
    reg.next_id = 13;

    // The stored session entry (== provider view source): placeholders only,
    // including one UNKNOWN id.
    let stored_args =
        r#"{"cmd":"login --pass smith:sec:1 --extra smith:sec:999 --n smith:sec:12"}"#;
    let entry = SessionEntry::ToolCall { name: "shell".into(), args_json: stored_args.into() };

    // Provider view: the entry as stored — placeholders survive, no plaintext.
    let provider_view = entry_text(&entry).to_string();
    c.ok(
        "provider view keeps placeholders (no plaintext)",
        !provider_view.contains("hunter2-token") && provider_view.contains("smith:sec:1"),
    );
    c.ok(
        "provider view: unknown id smith:sec:999 present verbatim",
        provider_view.contains("smith:sec:999"),
    );

    // Execution view: rehydrated immediately before tool execute.
    let rehydrated = rehydrate(&provider_view, &reg);
    println!("     execute view: {rehydrated:?}");
    c.ok(
        "execute view: known placeholder rehydrated to plaintext",
        rehydrated.contains("--pass hunter2-token"),
    );
    c.ok(
        "execute view: unknown id smith:sec:999 passes through untouched (not an error)",
        rehydrated.contains("--extra smith:sec:999"),
    );
    c.ok(
        "maximal digit run: smith:sec:12 rehydrates as id 12, not id 1 + '2'",
        rehydrated.contains("--n twelve-plain") && !rehydrated.contains("hunter2-token2"),
    );

    // Rust tool execute fn receives the rehydrated args.
    let rust_execute = |args: &str| args.to_string();
    let seen = rust_execute(&rehydrated);
    c.ok("Rust tool execute receives plaintext", seen.contains("hunter2-token"));

    // Lua tool execute fn receives the same rehydrated args.
    let lua = Lua::new();
    let f: Function = lua
        .load("return function(args) return args.cmd end")
        .set_name("lua-tool-execute")
        .eval()?;
    let args_tbl = lua.create_table()?;
    let cmd: String = {
        // parse the JSON-ish cmd out for the Lua call; keep it trivial
        let start = rehydrated.find(":\"").unwrap() + 2;
        let end = rehydrated.rfind('"').unwrap();
        rehydrated[start..end].to_string()
    };
    args_tbl.set("cmd", cmd)?;
    let lua_seen: String = f.call(args_tbl)?;
    c.ok(
        "Lua tool execute receives plaintext, unknown id still verbatim",
        lua_seen.contains("hunter2-token") && lua_seen.contains("smith:sec:999"),
    );

    // The stored entry never changed: rehydration is a view at the execution
    // boundary, not a mutation.
    c.ok(
        "stored entry unchanged after rehydration (boundary, not mutation)",
        entry_text(&entry) == stored_args,
    );
    Ok(())
}

fn scenario_resume(c: &mut Check) -> Result<(), Box<dyn Error>> {
    println!("== resume: backward scan rebuilds the table; masking works immediately ==");
    let path = session_path("p13-resume.session");
    {
        let mut reg = Registry::new();
        let id1 = reg.register("hunter2-token", "db-pass");
        let id2 = reg.register("aws-KEYXYZ", "aws");
        let entries = vec![
            SessionEntry::SecretRegistration { id: id1, value: "hunter2-token".into(), label: "db-pass".into() },
            SessionEntry::SecretRegistration { id: id2, value: "aws-KEYXYZ".into(), label: "aws".into() },
            SessionEntry::UserMessage { text: mask("use hunter2-token and aws-KEYXYZ", &reg) },
        ];
        write_session(&path, &entries)?;
        // registry and entries drop here — everything in memory is gone
    }

    let entries = read_session(&path)?;
    c.ok(&format!("reloaded {} entries from session file", entries.len()), entries.len() == 3);
    let stored = entry_text(&entries[2]);
    c.ok(
        &format!("persisted message holds placeholders only: {stored:?}"),
        stored == "use smith:sec:1 and smith:sec:2",
    );

    let mut reg = rebuild_registry(&entries);
    c.ok(
        "backward scan rebuilt both registrations (plaintext + label)",
        reg.by_id(1).map(|e| e.value.as_str()) == Some("hunter2-token")
            && reg.by_id(2).map(|e| e.label.as_str()) == Some("aws"),
    );

    let m = mask("send aws-KEYXYZ please", &reg);
    c.ok(
        &format!("new message with a known secret is masked immediately with the ORIGINAL id: {m:?}"),
        m == "send smith:sec:2 please",
    );

    let new_id = reg.register("new-secret-value", "post-resume");
    c.ok(
        &format!("id allocator resumed past max seen id (new id {new_id}; a reused id would alias old placeholders)"),
        new_id == 3,
    );
    Ok(())
}

// --------------------------------------------------------------------- main

fn main() -> Result<(), Box<dyn Error>> {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut c = Check { pass: true };
    match cmd.as_str() {
        "ingest" => scenario_ingest(&mut c)?,
        "hook-order" => scenario_hook_order(&mut c)?,
        "rehydrate" => scenario_rehydrate(&mut c)?,
        "resume" => scenario_resume(&mut c)?,
        "all" => {
            scenario_ingest(&mut c)?;
            println!();
            scenario_hook_order(&mut c)?;
            println!();
            scenario_rehydrate(&mut c)?;
            println!();
            scenario_resume(&mut c)?;
        }
        other => {
            eprintln!("usage: p13 [ingest|hook-order|rehydrate|resume|all] (got {other:?})");
            std::process::exit(2);
        }
    }
    println!();
    if c.pass {
        println!("p13 RESULT ({cmd}): all expectations hold");
        Ok(())
    } else {
        Err(format!("p13 RESULT ({cmd}): expectation failed").into())
    }
}
