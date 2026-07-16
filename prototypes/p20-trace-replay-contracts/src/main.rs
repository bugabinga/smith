//! p20-trace-replay-contracts
//!
//! Proves or disproves docs/SPEC.md §6.11 (trace and replay) against the
//! campaign-2/3 contracts it postdates:
//! - a scripted deterministic p14-style agent loop exercising ALL new entry
//!   kinds — normal turns, a steer with skipped synthetics (§6.1), an abort
//!   leaving a dangling tool-call tail (§6.1), leaf switches + implicit forks
//!   (§6.5), a compaction summary span folded at context assembly (§6.9), and
//!   secret registration + masked content (§6.7) — recorded BOTH as a §6.6
//!   session file and as a §6.11 trace file (header magic/version/session-id,
//!   CBOR entries),
//! - `reconstruct`: max-speed replay of the trace into a fresh state; the
//!   final state (current leaf, folded-path rendering, transcript, queue
//!   snapshot at abort, full entry list) must deep-equal the live run's,
//! - `compare`: re-executes the deterministic mock tools during replay, with
//!   one tool deliberately drifted to prove divergence is CAUGHT and
//!   reported; `smith:sec:N` placeholders in tool args rehydrate from the
//!   SESSION's registration entries (§6.7) — the trace file itself stays
//!   masked (byte-scanned for the plaintext to prove absence),
//! - `compression`: per-entry zstd vs block-level zstd with a min-size
//!   threshold and raw fallback, measured on the small recorded trace, a
//!   ~1000-entry synthetic trace, and an incompressible trace — producing
//!   the threshold rule §6.11 should pin.
//!
//! Edge hunting:
//! - does the abort dangling tail round-trip through the trace exactly?
//! - do leaf-switch entries replay to the same effective leaf under the
//!   §6.5 replay rule (append moves leaf to itself, switch to its target)?
//! - which campaign-2 event kinds are UNREPRESENTABLE in §6.11's literal
//!   trace entry list (provider requests/events, tool calls/results, TUI
//!   events, plugin events, VCS op ids, agent state snapshots)? This
//!   prototype needs a `SessionAppend` trace entry kind BEYOND that list to
//!   round-trip leaf switches, compaction spans, secret registrations, and
//!   steer/follow-up deliveries — a spec finding, demonstrated by attempting
//!   reconstruction from the literal kinds only.
//!
//! Verify: `cargo run -- record|reconstruct|compare|compression|all`
//! (each exits 0 with PASS lines).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const SECRET_PLAINTEXT: &str = "tok-SUPERSECRET-9000";
const SESSION_ID: &str = "p20-scripted-session";
const TRACE_MAGIC: &[u8; 8] = b"SMTRACE1";
const TRACE_VERSION: u32 = 1;
const BLOCK_TARGET: usize = 4096; // flush a block once buffered frames reach this
const MIN_COMPRESS: usize = 64; // never compress a unit smaller than this
const ZLEVEL: i32 = 3;

// ------------------------------------------------------ session model (§6.5)

type EntryId = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ToolCallSpec {
    id: String,
    name: String,
    args: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum Kind {
    User { text: String },
    Assistant { text: String, calls: Vec<ToolCallSpec> },
    ToolResult { call_id: String, output: String, is_error: bool, synthetic: bool },
    LeafSwitch { target: EntryId },
    CompactionSummary { from: EntryId, to: EntryId, summary: String },
    /// §6.7: the ONE entry kind holding plaintext (in the session file only;
    /// the trace carries a redacted copy).
    SecretRegistration { secret_id: u64, label: String, plaintext: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SessionEntry {
    id: EntryId,
    parent: Option<EntryId>,
    kind: Kind,
}

fn tag(k: &Kind) -> &'static str {
    match k {
        Kind::User { .. } => "user",
        Kind::Assistant { .. } => "asst",
        Kind::ToolResult { .. } => "result",
        Kind::LeafSwitch { .. } => "switch",
        Kind::CompactionSummary { .. } => "summary",
        Kind::SecretRegistration { .. } => "secret",
    }
}

#[derive(Default)]
struct Session {
    entries: Vec<SessionEntry>,
    leaf: Option<EntryId>,
    next_id: EntryId,
}

impl Session {
    fn append(&mut self, kind: Kind) -> EntryId {
        self.next_id += 1;
        let id = self.next_id;
        self.entries.push(SessionEntry { id, parent: self.leaf, kind });
        self.leaf = Some(id);
        id
    }

    fn get(&self, id: EntryId) -> Option<&SessionEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn path(&self) -> Vec<EntryId> {
        let mut p = Vec::new();
        let mut cur = self.leaf;
        while let Some(c) = cur {
            p.push(c);
            cur = self.get(c).expect("path entry exists").parent;
        }
        p.reverse();
        p
    }
}

/// §6.5 replay rule (p12-proven): an append moves the leaf to itself, a
/// leaf-switch moves it to its target — the last surviving entry decides.
fn replay_leaf(entries: &[SessionEntry]) -> Option<EntryId> {
    let mut leaf = None;
    for e in entries {
        match e.kind {
            Kind::LeafSwitch { target } => leaf = Some(target),
            _ => leaf = Some(e.id),
        }
    }
    leaf
}

// ------------------------------------------------------------- fold (§6.9)

#[derive(Debug)]
enum FoldItem<'a> {
    Verbatim(&'a SessionEntry),
    /// Secret registration hoisted out of a collapsed span (§6.9 survivor).
    Hoisted(&'a SessionEntry),
    Summary { id: EntryId, from: EntryId, to: EntryId, text: &'a str },
}

fn fold_path<'a>(s: &'a Session, path: &[EntryId]) -> (Vec<FoldItem<'a>>, Vec<String>) {
    let pos: BTreeMap<EntryId, usize> = path.iter().enumerate().map(|(i, &e)| (e, i)).collect();
    let n = path.len();
    let mut cover: Vec<Option<usize>> = vec![None; n];
    let mut applied: BTreeSet<usize> = BTreeSet::new();
    let mut dropped: BTreeSet<usize> = BTreeSet::new();
    let mut diags = Vec::new();

    for (pi, &eid) in path.iter().enumerate() {
        let entry = s.get(eid).expect("path entry exists");
        if let Kind::CompactionSummary { from, to, .. } = entry.kind {
            match (pos.get(&from), pos.get(&to)) {
                (Some(&fi), Some(&ti)) if fi <= ti && ti < pi => {
                    for c in &mut cover[fi..=ti] {
                        *c = Some(pi);
                    }
                    applied.insert(pi);
                }
                _ => {
                    diags.push(format!("summary {eid} IGNORED: span not an ancestor segment of this path"));
                    dropped.insert(pi);
                }
            }
        }
    }

    let mut out: Vec<FoldItem> = Vec::new();
    let mut emitted: BTreeSet<usize> = BTreeSet::new();
    for i in 0..n {
        if let Some(spos) = cover[i] {
            if emitted.insert(spos) {
                for j in i..n {
                    if cover[j] == Some(spos) {
                        let e = s.get(path[j]).expect("path entry exists");
                        if matches!(e.kind, Kind::SecretRegistration { .. }) {
                            out.push(FoldItem::Hoisted(e));
                        }
                    }
                }
                let se = s.get(path[spos]).expect("summary entry exists");
                if let Kind::CompactionSummary { from, to, ref summary } = se.kind {
                    out.push(FoldItem::Summary { id: se.id, from, to, text: summary });
                }
            }
            continue;
        }
        if applied.contains(&i) || dropped.contains(&i) {
            continue;
        }
        out.push(FoldItem::Verbatim(s.get(path[i]).expect("path entry exists")));
    }
    (out, diags)
}

fn fold_sig(items: &[FoldItem]) -> Vec<String> {
    items
        .iter()
        .map(|it| match it {
            FoldItem::Verbatim(e) => format!("{}#{}", tag(&e.kind), e.id),
            FoldItem::Hoisted(e) => format!("hoist-{}#{}", tag(&e.kind), e.id),
            FoldItem::Summary { id, from, to, .. } => format!("summary#{id}[{from}..{to}]"),
        })
        .collect()
}

/// Provider rendering of a folded path (§6.9): summaries render, secret
/// registrations are EXCLUDED (they hold plaintext, §6.7), metadata skipped.
fn render_items(items: &[FoldItem]) -> Vec<Msg> {
    items
        .iter()
        .filter_map(|it| match it {
            FoldItem::Hoisted(_) => None,
            FoldItem::Summary { text, .. } => {
                Some(Msg { role: "summary".into(), content: (*text).to_string() })
            }
            FoldItem::Verbatim(e) => match &e.kind {
                Kind::User { text } => Some(Msg { role: "user".into(), content: text.clone() }),
                Kind::Assistant { text, calls } => {
                    let mut c = text.clone();
                    for tc in calls {
                        c.push_str(&format!(" [call {} {}({})]", tc.id, tc.name, tc.args));
                    }
                    Some(Msg { role: "assistant".into(), content: c })
                }
                Kind::ToolResult { call_id, output, is_error, .. } => Some(Msg {
                    role: "tool".into(),
                    content: format!("{call_id}:{output}{}", if *is_error { " (error)" } else { "" }),
                }),
                _ => None,
            },
        })
        .collect()
}

// ----------------------------------------------------- secret proxy (§6.7)

#[derive(Default, Clone)]
struct SecretTable {
    entries: Vec<(u64, String, String)>, // id, label, plaintext
}

impl SecretTable {
    fn register(&mut self, plaintext: &str, label: &str) -> u64 {
        if let Some((id, _, _)) = self.entries.iter().find(|(_, _, p)| p == plaintext) {
            return *id;
        }
        let id = self.entries.iter().map(|(i, _, _)| *i).max().unwrap_or(0) + 1;
        self.entries.push((id, label.to_string(), plaintext.to_string()));
        id
    }

    /// Rebuild from session registration entries (§6.7 resume rule).
    fn from_entries(entries: &[SessionEntry]) -> Self {
        let mut t = SecretTable::default();
        for e in entries {
            if let Kind::SecretRegistration { secret_id, label, plaintext } = &e.kind {
                t.entries.push((*secret_id, label.clone(), plaintext.clone()));
            }
        }
        t
    }

    /// Longest-match-first single left-to-right pass (p13 rule).
    fn mask(&self, s: &str) -> String {
        let mut ordered: Vec<&(u64, String, String)> = self.entries.iter().collect();
        ordered.sort_by(|a, b| b.2.len().cmp(&a.2.len()));
        let mut out = String::new();
        let mut i = 0;
        'outer: while i < s.len() {
            for (id, _, pt) in &ordered {
                if !pt.is_empty() && s[i..].starts_with(pt.as_str()) {
                    out.push_str(&format!("smith:sec:{id}"));
                    i += pt.len();
                    continue 'outer;
                }
            }
            let ch = s[i..].chars().next().expect("char boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
        out
    }

    /// Single pass; unknown ids pass through untouched (§6.7). Placeholder
    /// ids parse as the maximal digit run (p13).
    fn rehydrate(&self, s: &str) -> String {
        let mut out = String::new();
        let mut rest = s;
        while let Some(p) = rest.find("smith:sec:") {
            out.push_str(&rest[..p]);
            let after = &rest[p + 10..];
            let dlen = after.chars().take_while(|c| c.is_ascii_digit()).count();
            if dlen == 0 {
                out.push_str("smith:sec:");
                rest = after;
                continue;
            }
            let id: u64 = after[..dlen].parse().expect("digit run");
            match self.entries.iter().find(|(i, _, _)| *i == id) {
                Some((_, _, pt)) => out.push_str(pt),
                None => out.push_str(&rest[p..p + 10 + dlen]),
            }
            rest = &after[dlen..];
        }
        out.push_str(rest);
        out
    }
}

// ------------------------------------------------------- trace model (§6.11)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Msg {
    role: String,
    content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum PEvent {
    TextDelta { text: String },
    ToolCall { id: String, name: String, args: String },
    Done { stop: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum TraceEntry {
    /// §6.11 "provider requests" — the folded, masked context as sent.
    ProviderRequest { seq: u32, messages: Vec<Msg> },
    /// §6.11 "provider events".
    ProviderEvent { seq: u32, event: PEvent },
    /// §6.11 "tool calls" (recorded at execution decision; skipped=true for
    /// steering synthetics that never executed).
    ToolCall { call_id: String, name: String, args: String, skipped: bool },
    /// §6.11 "tool results" (masked).
    ToolResult { call_id: String, output: String, is_error: bool },
    /// §6.11 "agent state snapshots" (here: at every run end/abort).
    StateSnapshot {
        leaf: Option<EntryId>,
        steer_queue: Vec<String>,
        followup_queue: Vec<String>,
        aborted: bool,
    },
    /// EXTENSION — NOT in §6.11's entry list. Required to round-trip the
    /// session tree: leaf switches, compaction summary spans, secret
    /// registrations (redacted), and steer/follow-up deliveries all live
    /// only in session entries. This is the coverage-gap finding.
    SessionAppend { entry: SessionEntry },
}

/// The trace never carries secret plaintext (§6.7): registration entries are
/// redacted before entering the trace. Rehydration during compare reads the
/// SESSION file's registration entries instead.
fn redact_entry(e: &SessionEntry) -> SessionEntry {
    let mut e = e.clone();
    if let Kind::SecretRegistration { plaintext, .. } = &mut e.kind {
        if !plaintext.starts_with("<redacted:") {
            *plaintext = format!("<redacted:{}B>", plaintext.len());
        }
    }
    e
}

// --------------------------------------------------- deterministic mock tools

/// Deterministic: same inputs → same outputs. `replay_drift` flips ONLY the
/// `lookup` tool to a divergent (still deterministic) implementation, the
/// planted drift that §6.11 compare mode must catch.
fn execute_tool(name: &str, id: &str, args: &str, replay_drift: bool) -> String {
    match name {
        "read_log" => format!("log tail for {args}: timeout connecting to db ({id})"),
        "lookup" => {
            if replay_drift {
                format!("lookup[{args}]: api at 10.0.0.7 port 8443 (v2 resolver)")
            } else {
                format!("lookup[{args}]: api at 10.0.0.7 port 443")
            }
        }
        "deploy" => {
            let token = args
                .split(';')
                .find_map(|kv| kv.strip_prefix("token="))
                .unwrap_or("");
            if token.contains("smith:sec:") {
                format!("deploy FAILED: token UNREHYDRATED ({token})")
            } else {
                format!("deployed to prod using {token} status=ok")
            }
        }
        "check" => format!("check[{args}]: ok"),
        "verify" => format!("verify[{args}]: pass"),
        other => format!("unknown tool {other}"),
    }
}

// ------------------------------------------------- scripted live run (§6.1)

#[derive(Clone, Copy, PartialEq)]
enum InputKind {
    Steer,
    Followup,
}

struct World {
    session: Session,
    trace: Vec<TraceEntry>,
    secrets: SecretTable,
    steer_q: VecDeque<String>,
    followup_q: VecDeque<String>,
    aborted: bool,
    req_seq: u32,
}

impl World {
    fn new() -> Self {
        World {
            session: Session::default(),
            trace: Vec::new(),
            secrets: SecretTable::default(),
            steer_q: VecDeque::new(),
            followup_q: VecDeque::new(),
            aborted: false,
            req_seq: 0,
        }
    }

    fn append(&mut self, kind: Kind) -> EntryId {
        let id = self.session.append(kind);
        let e = self.session.entries.last().expect("just appended").clone();
        self.trace.push(TraceEntry::SessionAppend { entry: redact_entry(&e) });
        id
    }

    /// §6.5: switch is recorded by appending a leaf-switch entry, then the
    /// leaf moves to the target.
    fn switch_leaf(&mut self, target: EntryId) -> EntryId {
        let sw = self.append(Kind::LeafSwitch { target });
        self.session.leaf = Some(target);
        sw
    }

    fn snapshot(&mut self) {
        self.trace.push(TraceEntry::StateSnapshot {
            leaf: self.session.leaf,
            steer_queue: self.steer_q.iter().cloned().collect(),
            followup_queue: self.followup_q.iter().cloned().collect(),
            aborted: self.aborted,
        });
    }

    fn render_context(&self) -> Vec<Msg> {
        let path = self.session.path();
        let (items, _diags) = fold_path(&self.session, &path);
        render_items(&items)
    }
}

/// p14-style deterministic loop, sequential mode: scripted provider turns,
/// arrivals fire when the named tool call completes, abort delivered at a
/// tool boundary leaves a dangling tail (§6.1).
fn run_agent(
    w: &mut World,
    prompt: &str,
    turns: &[Vec<PEvent>],
    mut arrivals: Vec<(&str, InputKind, &str)>,
    abort_at: Option<&str>,
) {
    let masked = w.secrets.mask(prompt);
    w.append(Kind::User { text: masked });

    let mut ti = 0;
    'outer: while ti < turns.len() {
        let req = w.render_context();
        w.req_seq += 1;
        let seq = w.req_seq;
        w.trace.push(TraceEntry::ProviderRequest { seq, messages: req });

        let evs = turns[ti].clone();
        ti += 1;
        let mut text = String::new();
        let mut calls: Vec<ToolCallSpec> = Vec::new();
        let mut stop = "end_turn".to_string();
        for ev in evs {
            w.trace.push(TraceEntry::ProviderEvent { seq, event: ev.clone() });
            match ev {
                PEvent::TextDelta { text: t } => text.push_str(&t),
                PEvent::ToolCall { id, name, args } => {
                    calls.push(ToolCallSpec { id, name, args })
                }
                PEvent::Done { stop: s } => stop = s,
            }
        }
        w.append(Kind::Assistant { text, calls: calls.clone() });

        let mut pending: VecDeque<ToolCallSpec> = calls.into();
        while let Some(c) = pending.pop_front() {
            if !w.steer_q.is_empty() {
                // §6.1: never-started calls resolve as error-flagged
                // synthetic results ("skipped: user steered").
                w.trace.push(TraceEntry::ToolCall {
                    call_id: c.id.clone(),
                    name: c.name.clone(),
                    args: c.args.clone(),
                    skipped: true,
                });
                let out = "skipped: user steered".to_string();
                w.append(Kind::ToolResult {
                    call_id: c.id.clone(),
                    output: out.clone(),
                    is_error: true,
                    synthetic: true,
                });
                w.trace.push(TraceEntry::ToolResult {
                    call_id: c.id,
                    output: out,
                    is_error: true,
                });
                continue;
            }
            w.trace.push(TraceEntry::ToolCall {
                call_id: c.id.clone(),
                name: c.name.clone(),
                args: c.args.clone(),
                skipped: false,
            });
            // §6.7: rehydration happens at exactly one layer — immediately
            // before tool execution. Live runs never drift.
            let rehydrated = w.secrets.rehydrate(&c.args);
            let out = execute_tool(&c.name, &c.id, &rehydrated, false);
            let masked_out = w.secrets.mask(&out);
            w.append(Kind::ToolResult {
                call_id: c.id.clone(),
                output: masked_out.clone(),
                is_error: false,
                synthetic: false,
            });
            w.trace.push(TraceEntry::ToolResult {
                call_id: c.id.clone(),
                output: masked_out,
                is_error: false,
            });

            // Tool completion is a safe boundary (§6.1): arrivals fire now.
            let mut k = 0;
            while k < arrivals.len() {
                if arrivals[k].0 == c.id {
                    let (_, kind, txt) = arrivals.remove(k);
                    match kind {
                        InputKind::Steer => w.steer_q.push_back(txt.to_string()),
                        InputKind::Followup => w.followup_q.push_back(txt.to_string()),
                    }
                } else {
                    k += 1;
                }
            }
            if abort_at == Some(c.id.as_str()) {
                w.aborted = true;
                // §6.1 abort: run ends NOW; remaining calls get NO synthetic
                // results — the dangling tail. Queues stay intact.
                break 'outer;
            }
        }

        if !w.steer_q.is_empty() {
            // Drain steers FIFO as user messages before the next provider
            // call. NOTE: recorded as plain user entries — steer provenance
            // exists nowhere in §6.5/§6.11 (finding).
            while let Some(stx) = w.steer_q.pop_front() {
                let m = w.secrets.mask(&stx);
                w.append(Kind::User { text: m });
            }
            continue;
        }
        if stop == "tool_use" {
            continue;
        }
        if let Some(f) = w.followup_q.pop_front() {
            let m = w.secrets.mask(&f);
            w.append(Kind::User { text: m });
            continue;
        }
        break;
    }
    w.snapshot();
}

fn text(t: &str) -> PEvent {
    PEvent::TextDelta { text: t.into() }
}
fn tcall(id: &str, name: &str, args: &str) -> PEvent {
    PEvent::ToolCall { id: id.into(), name: name.into(), args: args.into() }
}
fn done(stop: &str) -> PEvent {
    PEvent::Done { stop: stop.into() }
}

struct Anchors {
    summary_entry: EntryId,
    dangling_assistant: EntryId,
}

/// The full scripted session. Deterministic: no clock, no RNG, no I/O.
fn live_run() -> (World, Anchors) {
    let mut w = World::new();

    // Run 1: two normal turns with two executed tool calls (t2 `lookup` is
    // the tool that will drift in compare mode).
    run_agent(
        &mut w,
        "investigate deploy failure",
        &[
            vec![
                text("checking logs"),
                tcall("t1", "read_log", "path=/var/log/app"),
                tcall("t2", "lookup", "service=api"),
                done("tool_use"),
            ],
            vec![text("logs show timeout"), done("end_turn")],
        ],
        vec![],
        None,
    );

    // Explicit secret registration (§6.7 `/secret` path). The session entry
    // holds plaintext; the trace copy is redacted.
    let sid = w.secrets.register(SECRET_PLAINTEXT, "api-token");
    w.append(Kind::SecretRegistration {
        secret_id: sid,
        label: "api-token".into(),
        plaintext: SECRET_PLAINTEXT.into(),
    });

    // Run 2: masked user content, rehydrating deploy call, then a steer
    // arriving while t4 runs — t5/t6 skip as synthetics, steer delivers.
    run_agent(
        &mut w,
        &format!("deploy with token {SECRET_PLAINTEXT}"),
        &[
            vec![
                text("deploying"),
                tcall("t3", "deploy", "token=smith:sec:1;target=prod"),
                done("tool_use"),
            ],
            vec![
                text("verifying"),
                tcall("t4", "check", "env=prod-a"),
                tcall("t5", "check", "env=prod-b"),
                tcall("t6", "check", "env=prod-c"),
                done("tool_use"),
            ],
            vec![text("staging checked"), done("end_turn")],
        ],
        vec![("t4", InputKind::Steer, "also check staging")],
        None,
    );
    // The steer-delivered user entry is the last User entry so far.
    let steer_user_entry = w
        .session
        .entries
        .iter()
        .rev()
        .find(|e| matches!(&e.kind, Kind::User { text } if text == "also check staging"))
        .expect("steer entry")
        .id;

    // Compaction pass (§6.9): summary covering entry 1 .. the registration
    // entry — so the registration sits INSIDE the covered span (hoisting).
    let first = w.session.entries.first().expect("entries").id;
    let reg = w
        .session
        .entries
        .iter()
        .find(|e| matches!(e.kind, Kind::SecretRegistration { .. }))
        .expect("registration")
        .id;
    let summary_entry = w.append(Kind::CompactionSummary {
        from: first,
        to: reg,
        summary: "deploy failure investigated: logs show db timeout; api at 10.0.0.7; api-token registered".into(),
    });

    // Leaf switch #1: back to the steer user entry → run 3 forks there.
    w.switch_leaf(steer_user_entry);
    run_agent(
        &mut w,
        "try alternative approach",
        &[vec![text("alternative noted"), done("end_turn")]],
        vec![],
        None,
    );

    // Leaf switch #2: back to the summary entry → the final run forks there
    // and its path keeps the fold.
    w.switch_leaf(summary_entry);

    // Run 4: abort while t7 runs, with a steer + follow-up queued at the
    // same boundary. t7 completes (real result); t8 dangles; queues survive.
    run_agent(
        &mut w,
        "run full verification",
        &[vec![
            text("running checks"),
            tcall("t7", "verify", "suite=integration"),
            tcall("t8", "verify", "suite=e2e"),
            done("tool_use"),
        ]],
        vec![
            ("t7", InputKind::Steer, "pending steer"),
            ("t7", InputKind::Followup, "pending follow-up"),
        ],
        Some("t7"),
    );
    let dangling_assistant = w
        .session
        .entries
        .iter()
        .rev()
        .find(|e| matches!(e.kind, Kind::Assistant { .. }))
        .expect("assistant")
        .id;

    let anchors = Anchors { summary_entry, dangling_assistant };
    (w, anchors)
}

// -------------------------------------------------------------- final state

#[derive(Debug, PartialEq)]
struct FinalState {
    leaf: Option<EntryId>,
    fold_sig: Vec<String>,
    transcript: Vec<Msg>,
    entries: Vec<SessionEntry>, // registration plaintext redacted on BOTH sides
    steer_queue: Vec<String>,
    followup_queue: Vec<String>,
    aborted: bool,
}

fn final_state(
    session: &Session,
    steer_queue: Vec<String>,
    followup_queue: Vec<String>,
    aborted: bool,
) -> FinalState {
    let path = session.path();
    let (items, _diags) = fold_path(session, &path);
    FinalState {
        leaf: session.leaf,
        fold_sig: fold_sig(&items),
        transcript: render_items(&items),
        entries: session.entries.iter().map(redact_entry).collect(),
        steer_queue,
        followup_queue,
        aborted,
    }
}

fn live_final_state(w: &World) -> FinalState {
    final_state(
        &w.session,
        w.steer_q.iter().cloned().collect(),
        w.followup_q.iter().cloned().collect(),
        w.aborted,
    )
}

fn compare_states(live: &FinalState, replay: &FinalState) -> bool {
    let mut ok = true;
    macro_rules! field {
        ($name:ident) => {
            if live.$name != replay.$name {
                ok = false;
                println!("  DIFF {}:", stringify!($name));
                println!("    live:   {:?}", live.$name);
                println!("    replay: {:?}", replay.$name);
            }
        };
    }
    field!(leaf);
    field!(fold_sig);
    field!(transcript);
    field!(entries);
    field!(steer_queue);
    field!(followup_queue);
    field!(aborted);
    ok
}

// -------------------------------------------------- codec: framing + zstd

fn cbor<T: Serialize>(v: &T) -> Vec<u8> {
    let mut b = Vec::new();
    ciborium::ser::into_writer(v, &mut b).expect("cbor encode");
    b
}

/// §6.6-style length-prefixed framing: u32 BE len | bytes | ...
fn frames_concat(bufs: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for b in bufs {
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
        out.extend_from_slice(b);
    }
    out
}

fn split_frames(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        if bytes.len() - pos < 4 {
            return Err(format!("truncated length prefix at {pos}"));
        }
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().expect("4 bytes")) as usize;
        pos += 4;
        if len > bytes.len() - pos {
            return Err(format!("truncated frame body at {pos}"));
        }
        out.push(bytes[pos..pos + len].to_vec());
        pos += len;
    }
    Ok(out)
}

fn zc(b: &[u8]) -> Vec<u8> {
    zstd::bulk::compress(b, ZLEVEL).expect("zstd compress")
}
fn zd(b: &[u8], cap: usize) -> Vec<u8> {
    zstd::bulk::decompress(b, cap).expect("zstd decompress")
}

/// Unit frame: [flag u8][u32 stored_len][u32 raw_len][payload]. flag=1 →
/// payload is zstd; flag=0 → raw. 9 bytes fixed overhead per unit.
const UNIT_HEADER: usize = 9;

fn push_unit(out: &mut Vec<u8>, raw: &[u8], force_compress: bool, allow_compress: bool) {
    let comp = if force_compress {
        Some(zc(raw))
    } else if allow_compress && raw.len() >= MIN_COMPRESS {
        let c = zc(raw);
        if c.len() < raw.len() {
            Some(c)
        } else {
            None // raw fallback: never exceed uncompressed payload size
        }
    } else {
        None
    };
    match comp {
        Some(c) => {
            out.push(1);
            out.extend_from_slice(&(c.len() as u32).to_be_bytes());
            out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
            out.extend_from_slice(&c);
        }
        None => {
            out.push(0);
            out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
            out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
            out.extend_from_slice(raw);
        }
    }
}

fn read_units(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        if bytes.len() - pos < UNIT_HEADER {
            return Err(format!("truncated unit header at {pos}"));
        }
        let flag = bytes[pos];
        let stored =
            u32::from_be_bytes(bytes[pos + 1..pos + 5].try_into().expect("4 bytes")) as usize;
        let raw =
            u32::from_be_bytes(bytes[pos + 5..pos + 9].try_into().expect("4 bytes")) as usize;
        pos += UNIT_HEADER;
        if stored > bytes.len() - pos {
            return Err(format!("truncated unit body at {pos}"));
        }
        let payload = &bytes[pos..pos + stored];
        pos += stored;
        out.push(match flag {
            1 => zd(payload, raw),
            0 => payload.to_vec(),
            f => return Err(format!("bad unit flag {f}")),
        });
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Codec {
    Raw = 0,
    PerEntryAlways = 1,
    PerEntryThreshold = 2,
    Block = 3,
}

fn encode_body(codec: Codec, bufs: &[Vec<u8>]) -> Vec<u8> {
    match codec {
        Codec::Raw => frames_concat(bufs),
        Codec::PerEntryAlways => {
            let mut out = Vec::new();
            for b in bufs {
                push_unit(&mut out, b, true, true);
            }
            out
        }
        Codec::PerEntryThreshold => {
            let mut out = Vec::new();
            for b in bufs {
                push_unit(&mut out, b, false, true);
            }
            out
        }
        Codec::Block => {
            // Block-level: buffer whole §6.6-style frames, flush a unit once
            // BLOCK_TARGET bytes accumulate; raw fallback per block.
            let mut out = Vec::new();
            let mut chunk: Vec<u8> = Vec::new();
            for b in bufs {
                chunk.extend_from_slice(&(b.len() as u32).to_be_bytes());
                chunk.extend_from_slice(b);
                if chunk.len() >= BLOCK_TARGET {
                    push_unit(&mut out, &chunk, false, true);
                    chunk.clear();
                }
            }
            if !chunk.is_empty() {
                push_unit(&mut out, &chunk, false, true);
            }
            out
        }
    }
}

fn decode_body(codec: Codec, body: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    match codec {
        Codec::Raw => split_frames(body),
        Codec::PerEntryAlways | Codec::PerEntryThreshold => read_units(body),
        Codec::Block => {
            let blocks = read_units(body)?;
            let mut all = Vec::new();
            for b in &blocks {
                all.extend_from_slice(b);
            }
            split_frames(&all)
        }
    }
}

fn count_blocks(body: &[u8]) -> usize {
    let mut n = 0;
    let mut pos = 0usize;
    while pos + UNIT_HEADER <= body.len() {
        let stored =
            u32::from_be_bytes(body[pos + 1..pos + 5].try_into().expect("4 bytes")) as usize;
        pos += UNIT_HEADER + stored;
        n += 1;
    }
    n
}

// --------------------------------------------------------- trace file (§6.11)

fn write_trace_file(path: &str, entries: &[TraceEntry], codec: Codec) {
    let bufs: Vec<Vec<u8>> = entries.iter().map(cbor).collect();
    let mut out = Vec::new();
    out.extend_from_slice(TRACE_MAGIC);
    out.extend_from_slice(&TRACE_VERSION.to_be_bytes());
    out.extend_from_slice(&(SESSION_ID.len() as u32).to_be_bytes());
    out.extend_from_slice(SESSION_ID.as_bytes());
    out.push(codec as u8);
    out.extend_from_slice(&encode_body(codec, &bufs));
    std::fs::write(path, &out).expect("write trace file");
}

fn read_trace_file(path: &str) -> Result<(String, Vec<TraceEntry>), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 17 || &bytes[..8] != TRACE_MAGIC {
        return Err("bad magic".into());
    }
    let version = u32::from_be_bytes(bytes[8..12].try_into().expect("4 bytes"));
    if version != TRACE_VERSION {
        return Err(format!("bad version {version}"));
    }
    let sl = u32::from_be_bytes(bytes[12..16].try_into().expect("4 bytes")) as usize;
    let sid = String::from_utf8(bytes[16..16 + sl].to_vec()).map_err(|e| e.to_string())?;
    let codec = match bytes[16 + sl] {
        0 => Codec::Raw,
        1 => Codec::PerEntryAlways,
        2 => Codec::PerEntryThreshold,
        3 => Codec::Block,
        c => return Err(format!("bad codec {c}")),
    };
    let bufs = decode_body(codec, &bytes[17 + sl..])?;
    let mut entries = Vec::new();
    for b in &bufs {
        let e: TraceEntry =
            ciborium::de::from_reader(b.as_slice()).map_err(|e| e.to_string())?;
        entries.push(e);
    }
    Ok((sid, entries))
}

fn write_session_file(path: &str, entries: &[SessionEntry]) {
    let bufs: Vec<Vec<u8>> = entries.iter().map(cbor).collect();
    std::fs::write(path, frames_concat(&bufs)).expect("write session file");
}

fn read_session_file(path: &str) -> Result<Vec<SessionEntry>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for b in &split_frames(&bytes)? {
        let e: SessionEntry =
            ciborium::de::from_reader(b.as_slice()).map_err(|e| e.to_string())?;
        entries.push(e);
    }
    Ok(entries)
}

fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn work_dir() -> String {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/target");
    std::fs::create_dir_all(dir).expect("mkdir target");
    dir.to_string()
}

// ------------------------------------------------------------ reconstruction

struct Reconstructed {
    session: Session,
    steer_queue: Vec<String>,
    followup_queue: Vec<String>,
    aborted: bool,
    snapshot_leaf: Option<EntryId>,
}

/// Max-speed replay: apply trace entries in order into fresh state. Session
/// tree from SessionAppend (leaf per §6.5 replay rule); queues/abort from
/// the final agent state snapshot.
fn reconstruct(trace: &[TraceEntry]) -> Reconstructed {
    let mut session = Session::default();
    let mut steer_queue = Vec::new();
    let mut followup_queue = Vec::new();
    let mut aborted = false;
    let mut snapshot_leaf = None;
    for te in trace {
        match te {
            TraceEntry::SessionAppend { entry } => {
                session.entries.push(entry.clone());
                session.next_id = session.next_id.max(entry.id);
                match entry.kind {
                    Kind::LeafSwitch { target } => session.leaf = Some(target),
                    _ => session.leaf = Some(entry.id),
                }
            }
            TraceEntry::StateSnapshot {
                leaf,
                steer_queue: sq,
                followup_queue: fq,
                aborted: ab,
            } => {
                snapshot_leaf = *leaf;
                steer_queue = sq.clone();
                followup_queue = fq.clone();
                aborted = *ab;
            }
            _ => {}
        }
    }
    Reconstructed { session, steer_queue, followup_queue, aborted, snapshot_leaf }
}

// ------------------------------------------------------------------ checker

struct Checker {
    pass: bool,
}

impl Checker {
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

// ----------------------------------------------------------------- scenarios

fn scenario_record(c: &mut Checker) {
    println!("== record: live scripted run → §6.6 session file + §6.11 trace file ==");
    let (w, a) = live_run();
    let dir = work_dir();
    let spath = format!("{dir}/p20.session");
    let tpath = format!("{dir}/p20.trace");
    write_session_file(&spath, &w.session.entries);
    write_trace_file(&tpath, &w.trace, Codec::Block);

    // Session file roundtrip + §6.5 leaf replay.
    let loaded = read_session_file(&spath).expect("session file loads");
    c.check(
        "session file (§6.6 length-prefixed CBOR) roundtrips all entries",
        loaded == w.session.entries,
    );
    c.check(
        "§6.5 replay rule on the loaded file resolves the live leaf (appends after both switches decide)",
        replay_leaf(&loaded) == w.session.leaf,
    );

    // Trace file roundtrip.
    let (sid, tloaded) = read_trace_file(&tpath).expect("trace file loads");
    c.check(
        "trace file header (magic/version/session-id) + block-zstd body roundtrips all entries",
        sid == SESSION_ID && tloaded == w.trace,
    );

    // Structural coverage: every new entry kind present.
    let n_switch = w.session.entries.iter().filter(|e| matches!(e.kind, Kind::LeafSwitch { .. })).count();
    let n_summary = w.session.entries.iter().filter(|e| matches!(e.kind, Kind::CompactionSummary { .. })).count();
    let n_reg = w.session.entries.iter().filter(|e| matches!(e.kind, Kind::SecretRegistration { .. })).count();
    let n_synth = w.session.entries.iter().filter(|e| matches!(e.kind, Kind::ToolResult { synthetic: true, .. })).count();
    c.check(
        "scripted session exercises all kinds: 2 leaf switches, 1 compaction summary, 1 secret registration, 2 skipped synthetics",
        n_switch == 2 && n_summary == 1 && n_reg == 1 && n_synth == 2,
    );

    // Dangling tail (§6.1 abort): assistant has t7+t8 calls, only t7 answered.
    let dangling = w.session.get(a.dangling_assistant).expect("dangling assistant");
    let t8_answered = w
        .session
        .entries
        .iter()
        .any(|e| matches!(&e.kind, Kind::ToolResult { call_id, .. } if call_id == "t8"));
    c.check(
        "abort leaves a dangling tail: last assistant carries calls [t7,t8], t7 answered, t8 has NO result (no synthetic)",
        matches!(&dangling.kind, Kind::Assistant { calls, .. }
            if calls.iter().map(|c| c.id.as_str()).collect::<Vec<_>>() == ["t7", "t8"])
            && !t8_answered,
    );
    c.check(
        "queues survive the abort (ephemeral, snapshot only): steer + follow-up still queued, never session entries",
        w.steer_q == ["pending steer"]
            && w.followup_q == ["pending follow-up"]
            && !w.session.entries.iter().any(
                |e| matches!(&e.kind, Kind::User { text } if text.contains("pending")),
            ),
    );

    // Fold signature of the final path (summary + hoisted registration).
    let live = live_final_state(&w);
    println!("  final fold: {}", live.fold_sig.join(" | "));
    let reg_id = w.session.entries.iter().find(|e| matches!(e.kind, Kind::SecretRegistration { .. })).expect("reg").id;
    c.check(
        "final folded path: registration hoisted out of the covered span, summary collapses run 1, both forks invisible",
        live.fold_sig.first() == Some(&format!("hoist-secret#{reg_id}"))
            && live.fold_sig.get(1) == Some(&format!("summary#{}[1..{reg_id}]", a.summary_entry))
            && !live.fold_sig.iter().any(|s| s.starts_with("switch#")),
    );

    let ssz = std::fs::metadata(&spath).expect("session meta").len();
    let tsz = std::fs::metadata(&tpath).expect("trace meta").len();
    println!(
        "  recorded: {} session entries ({} B), {} trace entries ({} B, block-zstd) at {dir}/",
        w.session.entries.len(),
        ssz,
        w.trace.len(),
        tsz
    );
    println!();
}

fn scenario_reconstruct(c: &mut Checker) {
    println!("== reconstruct: max-speed replay into fresh state == live final state ==");
    let (w, a) = live_run();
    let dir = work_dir();
    let tpath = format!("{dir}/p20.trace");
    write_trace_file(&tpath, &w.trace, Codec::Block);
    let (_sid, trace) = read_trace_file(&tpath).expect("trace file loads");

    let r = reconstruct(&trace);
    let live = live_final_state(&w);
    let replay = final_state(&r.session, r.steer_queue.clone(), r.followup_queue.clone(), r.aborted);

    let eq = compare_states(&live, &replay);
    c.check(
        "reconstructed final state deep-equals live (leaf, folded rendering, transcript, entries, queue snapshot, abort flag)",
        eq,
    );
    c.check(
        "§6.5 replay rule: leaf-switch trace entries replay to the same effective leaf (switch→target, append→self)",
        r.session.leaf == w.session.leaf && r.snapshot_leaf == w.session.leaf,
    );

    // EDGE: the dangling tail must round-trip EXACTLY — t8 present as a call,
    // absent as a result, and no synthetic invented during replay.
    let live_dangling = w.session.get(a.dangling_assistant).expect("live dangling");
    let replay_dangling = r.session.get(a.dangling_assistant).expect("replay dangling");
    let replay_t8_results = r
        .session
        .entries
        .iter()
        .filter(|e| matches!(&e.kind, Kind::ToolResult { call_id, .. } if call_id == "t8"))
        .count();
    c.check(
        "abort dangling tail round-trips exactly: replay shows t8 called, unanswered, no synthetic invented",
        live_dangling == replay_dangling && replay_t8_results == 0,
    );

    // EDGE (finding): reconstruction using ONLY §6.11's literal entry kinds.
    let literal: Vec<TraceEntry> = trace
        .iter()
        .filter(|t| !matches!(t, TraceEntry::SessionAppend { .. }))
        .cloned()
        .collect();
    let rl = reconstruct(&literal);
    c.check(
        "FINDING §6.11: literal entry list (provider req/events, tool calls/results, snapshots) rebuilds ZERO session entries — leaf switches, fold spans, secret registrations, steer deliveries are unrepresentable",
        rl.session.entries.is_empty() && rl.session.leaf.is_none() && rl.snapshot_leaf == w.session.leaf,
    );
    println!("  note: the snapshot names leaf id {:?} but no literal entry kind carries the", rl.snapshot_leaf);
    println!("  entry GRAPH it points into; transcripts inside ProviderRequest entries are the");
    println!("  folded provider rendering, so tree, spans, and registrations cannot be derived.");
    println!("  This prototype adds a SessionAppend trace entry kind; §6.11 should adopt it.");
    println!();
}

fn scenario_compare(c: &mut Checker) {
    println!("== compare: replay re-executes tools, rehydrating §6.7 placeholders; drifted tool caught ==");
    let (w, _a) = live_run();
    let dir = work_dir();
    let spath = format!("{dir}/p20.session");
    let tpath = format!("{dir}/p20.trace");
    write_session_file(&spath, &w.session.entries);
    write_trace_file(&tpath, &w.trace, Codec::Block);

    // §6.7: the trace stays masked — rehydration reads the SESSION file's
    // registration entries.
    let session_entries = read_session_file(&spath).expect("session file loads");
    let secrets = SecretTable::from_entries(&session_entries);
    c.check(
        "secret table rebuilt from session registration entries (1 secret, plaintext intact in session file only)",
        secrets.entries.len() == 1 && secrets.entries[0].2 == SECRET_PLAINTEXT,
    );

    let (_sid, trace) = read_trace_file(&tpath).expect("trace file loads");
    let mut recorded: BTreeMap<String, String> = BTreeMap::new();
    let mut calls: Vec<(String, String, String, bool)> = Vec::new();
    for te in &trace {
        match te {
            TraceEntry::ToolCall { call_id, name, args, skipped } => {
                calls.push((call_id.clone(), name.clone(), args.clone(), *skipped))
            }
            TraceEntry::ToolResult { call_id, output, is_error } => {
                if !*is_error {
                    recorded.insert(call_id.clone(), output.clone());
                }
            }
            _ => {}
        }
    }

    let mut executed = 0usize;
    let mut skipped = 0usize;
    let mut divergences: Vec<(String, String, String)> = Vec::new();
    let mut deploy_rehydrated_ok = false;
    for (id, name, args, was_skipped) in &calls {
        if *was_skipped {
            skipped += 1;
            println!("  skip {id} ({name}): steering synthetic — never executed live, not re-executed");
            continue;
        }
        // §6.7 rehydration at the one layer: immediately before execution.
        let rehydrated = secrets.rehydrate(args);
        if name == "deploy" {
            deploy_rehydrated_ok = rehydrated != *args
                && !rehydrated.contains("smith:sec:")
                && rehydrated.contains(SECRET_PLAINTEXT);
        }
        let out = secrets.mask(&execute_tool(name, id, &rehydrated, true));
        executed += 1;
        let rec = recorded.get(id).expect("recorded result for executed call");
        if &out != rec {
            divergences.push((id.clone(), rec.clone(), out));
        }
    }

    c.check(
        "re-executed 5 recorded calls (t1,t2,t3,t4,t7); 2 steering synthetics (t5,t6) not re-executed; dangling t8 has no ToolCall trace entry",
        executed == 5 && skipped == 2 && calls.len() == 7 && !calls.iter().any(|(id, ..)| id == "t8"),
    );
    c.check(
        "deploy args rehydrated from registration entries (placeholder → plaintext) before execution",
        deploy_rehydrated_ok,
    );
    c.check(
        "compare CATCHES the planted drift: exactly one divergence, the drifted `lookup` (t2); deterministic tools match",
        divergences.len() == 1 && divergences[0].0 == "t2",
    );
    for (id, old, new) in &divergences {
        println!("  DIVERGENCE {id} (§6.11 compare mode report):");
        println!("    recorded: {old}");
        println!("    replayed: {new}");
    }

    // Byte-scan proof: plaintext absent from the trace (raw file bytes AND
    // fully decompressed body); present in the session file (registration
    // entry only); absent from every OTHER session entry.
    let traw = std::fs::read(&tpath).expect("read trace");
    let bufs: Vec<Vec<u8>> = trace.iter().map(cbor).collect();
    let tdecomp = frames_concat(&bufs);
    c.check(
        "byte-scan: secret plaintext ABSENT from trace file (compressed bytes and decompressed entries)",
        !contains_bytes(&traw, SECRET_PLAINTEXT.as_bytes())
            && !contains_bytes(&tdecomp, SECRET_PLAINTEXT.as_bytes()),
    );
    let sraw = std::fs::read(&spath).expect("read session");
    let non_reg_leak = session_entries
        .iter()
        .filter(|e| !matches!(e.kind, Kind::SecretRegistration { .. }))
        .any(|e| contains_bytes(&cbor(e), SECRET_PLAINTEXT.as_bytes()));
    c.check(
        "byte-scan: plaintext present in session file ONLY inside the registration entry (masking at ingestion held)",
        contains_bytes(&sraw, SECRET_PLAINTEXT.as_bytes()) && !non_reg_leak,
    );
    println!();
}

struct Sizes {
    n: usize,
    raw: usize,
    pe_always: usize,
    pe_thresh: usize,
    block: usize,
    nblocks: usize,
    inflated: usize,
}

fn measure(bufs: &[Vec<u8>]) -> Sizes {
    let raw = frames_concat(bufs).len();
    let pe_always = encode_body(Codec::PerEntryAlways, bufs).len();
    let pe_thresh = encode_body(Codec::PerEntryThreshold, bufs).len();
    let block_body = encode_body(Codec::Block, bufs);
    let inflated = bufs
        .iter()
        .filter(|b| zc(b).len() + UNIT_HEADER > b.len() + 4)
        .count();
    Sizes {
        n: bufs.len(),
        raw,
        pe_always,
        pe_thresh,
        block: block_body.len(),
        nblocks: count_blocks(&block_body),
        inflated,
    }
}

fn print_sizes(label: &str, s: &Sizes) {
    println!(
        "  {label}: n={} raw={}B per-entry-always={}B per-entry-thresh({}B)={}B block({}B,{} blocks)={}B",
        s.n, s.raw, s.pe_always, MIN_COMPRESS, s.pe_thresh, BLOCK_TARGET, s.nblocks, s.block
    );
    println!(
        "    per-entry inflates {}/{} entries individually; block/raw ratio {:.2}",
        s.inflated,
        s.n,
        s.block as f64 / s.raw as f64
    );
}

fn synthetic_trace(base: &[TraceEntry], n: usize) -> Vec<TraceEntry> {
    let mut v = base.to_vec();
    let mut i = 0u32;
    while v.len() < n {
        i += 1;
        v.push(TraceEntry::ProviderEvent {
            seq: 100 + i,
            event: PEvent::TextDelta {
                text: format!("synthetic delta {i}: scanning module {} for regressions", i * 7 % 13),
            },
        });
        v.push(TraceEntry::ToolCall {
            call_id: format!("s{i}"),
            name: "check".into(),
            args: format!("env=synth-{i}"),
            skipped: false,
        });
        v.push(TraceEntry::ToolResult {
            call_id: format!("s{i}"),
            output: format!("check[env=synth-{i}]: ok"),
            is_error: false,
        });
    }
    v.truncate(n);
    v
}

fn scenario_compression(c: &mut Checker) {
    println!("== compression: per-entry vs block-level zstd, min-size threshold, raw fallback ==");
    let (w, _a) = live_run();
    let small: Vec<Vec<u8>> = w.trace.iter().map(cbor).collect();
    let large_entries = synthetic_trace(&w.trace, 1000);
    let large: Vec<Vec<u8>> = large_entries.iter().map(cbor).collect();

    // Roundtrips for every codec on both traces.
    let mut rt = true;
    for bufs in [&small, &large] {
        for codec in [Codec::Raw, Codec::PerEntryAlways, Codec::PerEntryThreshold, Codec::Block] {
            rt &= decode_body(codec, &encode_body(codec, bufs)).expect("decode") == *bufs;
        }
    }
    c.check("all codecs roundtrip both the recorded and the 1000-entry synthetic trace", rt);

    let ss = measure(&small);
    let ls = measure(&large);
    print_sizes("recorded trace", &ss);
    print_sizes("synthetic trace (1000 entries)", &ls);

    c.check(
        "per-entry-always inflates a majority of the small trace's entries individually (the §6.11 'p11 evidence' claim, now actually measured)",
        ss.inflated * 2 > ss.n,
    );
    c.check(
        "block-level beats both per-entry variants on the SMALL trace",
        ss.block < ss.pe_always && ss.block < ss.pe_thresh,
    );
    c.check(
        "block-level beats both per-entry variants on the LARGE trace",
        ls.block < ls.pe_always && ls.block < ls.pe_thresh,
    );
    c.check(
        "block-level never exceeds the uncompressed framing by more than the 9B/block header (raw-fallback bound)",
        ss.block <= ss.raw + UNIT_HEADER * ss.nblocks && ls.block <= ls.raw + UNIT_HEADER * ls.nblocks,
    );

    // Worst case: incompressible entries — raw fallback must engage.
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let noise: Vec<Vec<u8>> = (0..10)
        .map(|_| (0..120).map(|_| (rnd() & 0xff) as u8).collect())
        .collect();
    let ns = measure(&noise);
    print_sizes("incompressible trace (10 x 120B noise)", &ns);
    c.check(
        "incompressible small trace: every block falls back to raw; total = raw + 9B/block, never larger",
        decode_body(Codec::Block, &encode_body(Codec::Block, &noise)).expect("decode") == noise
            && ns.block == ns.raw + UNIT_HEADER * ns.nblocks,
    );

    // Min-entry-size sweep: where does zstd stop inflating a lone unit?
    println!("  min-size sweep (repetitive text payload, zstd level {ZLEVEL}, 9B unit header):");
    let sample = "the agent loop wrote a tool result entry; ".repeat(200);
    let mut crossover = None;
    for size in [16usize, 32, 48, 64, 96, 128, 192, 256, 512, 1024] {
        let payload = sample.as_bytes()[..size].to_vec();
        let comp = zc(&payload).len() + UNIT_HEADER;
        let raw = payload.len() + 4;
        println!(
            "    {size:>5}B entry: framed-raw={raw}B compressed-unit={comp}B {}",
            if comp < raw { "→ compression wins" } else { "→ inflates" }
        );
        if comp < raw && crossover.is_none() {
            crossover = Some(size);
        }
    }
    c.check(
        "sub-64B entries inflate under per-entry compression; crossover measured (evidence for MIN_COMPRESS=64)",
        crossover.map(|s| s >= 32 && s <= 128).unwrap_or(false),
    );
    println!("  RULE for §6.11 to pin: block-level compression with BLOCK_TARGET=4096B,");
    println!("  MIN_COMPRESS=64B, and per-unit raw fallback (flag byte). Guarantee wording:");
    println!("  a trace never exceeds its uncompressed framed size by more than the fixed");
    println!("  9B-per-block header (~0.22% ceiling at 4KiB blocks) — 'never exceed their");
    println!("  uncompressed size' is unachievable verbatim once any container header exists.");
    println!();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut c = Checker { pass: true };
    match arg.as_str() {
        "record" => scenario_record(&mut c),
        "reconstruct" => scenario_reconstruct(&mut c),
        "compare" => scenario_compare(&mut c),
        "compression" => scenario_compression(&mut c),
        "all" => {
            scenario_record(&mut c);
            scenario_reconstruct(&mut c);
            scenario_compare(&mut c);
            scenario_compression(&mut c);
        }
        other => {
            return Err(format!(
                "unknown scenario: {other} (use record|reconstruct|compare|compression|all)"
            )
            .into())
        }
    }
    if c.pass {
        println!("p20 RESULT: scenario '{arg}' holds");
        Ok(())
    } else {
        Err(format!("p20 RESULT: scenario '{arg}' failed").into())
    }
}
