//! p12-session-tree-fold
//!
//! Proves or disproves docs/SPEC.md §6.5 (session tree: implicit fork points,
//! leaf-switch metadata entries, effective-leaf-on-load) and §6.9 (compaction
//! as an assembly-time fold: span collapse, trim stubs, recency window,
//! verbatim survivors), including their interaction across branches and the
//! §6.6 recovery boundaries (p06 codec pattern).
//!
//! Edge hunting (the point of this prototype):
//!   (a) a summary whose covered span crosses a fork point,
//!   (b) nested summaries (a later summary covering an earlier one),
//!   (c) a leaf-switch entry inside a covered span.
//!
//! Verify:
//!   cargo run -- tree
//!   cargo run -- leaf-persist
//!   cargo run -- fold
//!   cargo run -- branch-past-compaction
//!   cargo run -- all
//! Each exits 0 with PASS lines when expectations hold.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

type EntryId = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SessionEntry {
    id: EntryId,
    parent: Option<EntryId>,
    kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum Kind {
    User { text: String },
    Assistant { text: String },
    ToolCall { name: String },
    ToolResult { output: String },
    /// §6.5 tree navigation, recorded append-only.
    LeafSwitch { target: EntryId },
    /// §6.9 fold marker: collapses [from..to] on any path running through it.
    CompactionSummary { from: EntryId, to: EntryId, summary: String },
    /// §6.7: the one entry kind holding plaintext; survives folding verbatim.
    SecretRegistration { label: String, plaintext: String },
}

fn tag(k: &Kind) -> &'static str {
    match k {
        Kind::User { .. } => "user",
        Kind::Assistant { .. } => "asst",
        Kind::ToolCall { .. } => "call",
        Kind::ToolResult { .. } => "result",
        Kind::LeafSwitch { .. } => "switch",
        Kind::CompactionSummary { .. } => "summary",
        Kind::SecretRegistration { .. } => "secret",
    }
}

fn user(t: &str) -> Kind { Kind::User { text: t.into() } }
fn asst(t: &str) -> Kind { Kind::Assistant { text: t.into() } }
fn call(name: &str) -> Kind { Kind::ToolCall { name: name.into() } }
fn result(out: &str) -> Kind { Kind::ToolResult { output: out.into() } }

// ---------------------------------------------------------------- session

#[derive(Default)]
struct Session {
    entries: Vec<SessionEntry>,
    leaf: Option<EntryId>,
    next_id: EntryId,
}

impl Session {
    /// §6.5 append: child of the current leaf; leaf advances. Appending while
    /// the leaf sits on a non-leaf entry IS the implicit fork — same code path,
    /// no explicit branch operation exists.
    fn append(&mut self, kind: Kind) -> EntryId {
        self.next_id += 1;
        let id = self.next_id;
        self.entries.push(SessionEntry { id, parent: self.leaf, kind });
        self.leaf = Some(id);
        id
    }

    /// §6.5 switch leaf: recorded by appending a leaf-switch metadata entry
    /// (child of the branch tip being left), then the leaf moves to the target.
    fn switch_leaf(&mut self, target: EntryId) -> EntryId {
        assert!(self.get(target).is_some(), "switch target must exist");
        let sw = self.append(Kind::LeafSwitch { target });
        self.leaf = Some(target);
        sw
    }

    fn get(&self, id: EntryId) -> Option<&SessionEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn children(&self, id: EntryId) -> Vec<EntryId> {
        self.entries.iter().filter(|e| e.parent == Some(id)).map(|e| e.id).collect()
    }

    fn path_to(&self, id: EntryId) -> Vec<EntryId> {
        let mut p = Vec::new();
        let mut cur = Some(id);
        while let Some(c) = cur {
            p.push(c);
            cur = self.get(c).expect("path entry exists").parent;
        }
        p.reverse();
        p
    }

    /// §6.5 read path: root→leaf. Sibling branches are invisible.
    fn path(&self) -> Vec<EntryId> {
        self.leaf.map(|l| self.path_to(l)).unwrap_or_default()
    }

    /// Rebuild from loaded entries. Effective leaf by REPLAY in file order:
    /// a normal entry moves the leaf to itself (it was an append), a
    /// leaf-switch moves it to its target. Net effect: the last surviving
    /// entry decides. This is NOT the literal §6.5 wording — see
    /// `spec_literal_leaf` and the leaf-persist scenario.
    fn from_loaded(entries: Vec<SessionEntry>) -> (Self, Vec<String>) {
        let mut diags = Vec::new();
        let known: BTreeSet<EntryId> = entries.iter().map(|e| e.id).collect();
        for e in &entries {
            if let Some(p) = e.parent {
                if !known.contains(&p) {
                    diags.push(format!("entry {} ORPHANED: parent {} missing (skipped/corrupt frame)", e.id, p));
                }
            }
        }
        let mut leaf = None;
        for e in &entries {
            match e.kind {
                Kind::LeafSwitch { target } => {
                    if known.contains(&target) {
                        leaf = Some(target);
                    } else {
                        diags.push(format!(
                            "leaf-switch {} DANGLING: target {} missing; switch ignored on replay",
                            e.id, target
                        ));
                    }
                }
                _ => leaf = Some(e.id),
            }
        }
        let next_id = entries.iter().map(|e| e.id).max().unwrap_or(0);
        (Session { entries, leaf, next_id }, diags)
    }
}

/// The LITERAL §6.5 load rule: "the last leaf-switch entry's target, or the
/// last appended entry if none exists". Wrong whenever appends follow the
/// last switch — kept here to demonstrate the wording defect.
fn spec_literal_leaf(entries: &[SessionEntry]) -> Option<EntryId> {
    entries
        .iter()
        .rev()
        .find_map(|e| if let Kind::LeafSwitch { target } = e.kind { Some(target) } else { None })
        .or_else(|| entries.last().map(|e| e.id))
}

// ------------------------------------------------------------------ codec
// §6.6 length-prefixed CBOR (p06 pattern): u32 BE len | CBOR entry bytes | ...

fn cbor(e: &SessionEntry) -> Vec<u8> {
    let mut b = Vec::new();
    ciborium::ser::into_writer(e, &mut b).expect("encode");
    b
}

fn append_raw(out: &mut Vec<u8>, raw: &[u8]) {
    out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
    out.extend_from_slice(raw);
}

fn encode(entries: &[SessionEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries {
        append_raw(&mut out, &cbor(e));
    }
    out
}

#[derive(Debug, PartialEq)]
enum Warn {
    CorruptEntrySkipped { frame: usize },
    TruncatedTail { at_frame: usize },
}

/// Recovering reader (p06-proven boundaries): truncated tail stops parsing,
/// a corrupt BODY under an intact prefix is skipped precisely with a warning.
fn load_recovering(bytes: &[u8]) -> (Vec<SessionEntry>, Vec<Warn>) {
    let mut entries = Vec::new();
    let mut warns = Vec::new();
    let mut pos = 0usize;
    let mut frame = 0usize;
    while pos < bytes.len() {
        if bytes.len() - pos < 4 {
            warns.push(Warn::TruncatedTail { at_frame: frame });
            break;
        }
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let body_start = pos + 4;
        if len > bytes.len() - body_start {
            warns.push(Warn::TruncatedTail { at_frame: frame });
            break;
        }
        let body = &bytes[body_start..body_start + len];
        // Two-stage decode per §6.6; unknown-variant preservation is p06's
        // subject, so typed-decode failure counts as corrupt here.
        match ciborium::de::from_reader::<ciborium::Value, _>(body)
            .ok()
            .and_then(|v| v.deserialized::<SessionEntry>().ok())
        {
            Some(e) => entries.push(e),
            None => warns.push(Warn::CorruptEntrySkipped { frame }),
        }
        pos = body_start + len;
        frame += 1;
    }
    (entries, warns)
}

// ------------------------------------------------------------------- fold
// §6.9: compaction is a mask applied at context-assembly time. Storage never
// changes; the fold walks the read path and collapses covered spans.

#[derive(Debug)]
enum FoldItem<'a> {
    /// On the path, shown to the model as-is.
    Verbatim(&'a SessionEntry),
    /// Verbatim survivor pulled out of a collapsed span (secret registration).
    Hoisted(&'a SessionEntry),
    /// A covered span rendered as its summary, at the span's path position.
    Summary { id: EntryId, from: EntryId, to: EntryId, text: &'a str },
    /// Trim ladder step 1: old tool-result body outside the recency window.
    Stub { id: EntryId, elided_bytes: usize },
}

/// Fold a root→leaf path. `recency` = number of most-recent folded items that
/// survive verbatim (stand-in for §6.9's token-budget recency window).
fn fold_path<'a>(
    s: &'a Session,
    path: &[EntryId],
    recency: usize,
) -> (Vec<FoldItem<'a>>, Vec<String>) {
    let pos: BTreeMap<EntryId, usize> = path.iter().enumerate().map(|(i, &e)| (e, i)).collect();
    let n = path.len();
    // cover[i] = path index of the summary entry that swallows path[i].
    // Later summaries overwrite earlier ones → on nesting, outermost wins.
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
                (Some(_), Some(_)) => {
                    diags.push(format!(
                        "summary {eid} IGNORED: span [{from}..{to}] is not an ancestor segment preceding it on the path"
                    ));
                    dropped.insert(pi);
                }
                _ => {
                    diags.push(format!(
                        "summary {eid} IGNORED: span [{from}..{to}] endpoint(s) not on this path — span crosses a fork point; history shown raw"
                    ));
                    dropped.insert(pi);
                }
            }
        }
    }
    for &pi in &applied {
        if let Some(outer) = cover[pi] {
            diags.push(format!(
                "summary {} SUBSUMED by later summary {} (nested spans; outermost wins)",
                path[pi], path[outer]
            ));
        }
    }

    let mut out: Vec<FoldItem> = Vec::new();
    let mut emitted: BTreeSet<usize> = BTreeSet::new();
    for i in 0..n {
        if let Some(spos) = cover[i] {
            if emitted.insert(spos) {
                // §6.9 "survives verbatim, always": hoist secret registrations
                // out of the whole covered region, ahead of the summary.
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
            continue; // covered cell collapses into its summary
        }
        if applied.contains(&i) {
            continue; // summary entry already rendered at its span's position
        }
        if dropped.contains(&i) {
            continue; // inapplicable summary: dropped from context, diagnosed
        }
        out.push(FoldItem::Verbatim(s.get(path[i]).expect("path entry exists")));
    }

    // Trim ladder step 1: stub old tool-result bodies outside the recency
    // window. Summaries, hoisted secrets, and the window survive untouched.
    let cut = out.len().saturating_sub(recency);
    for item in out.iter_mut().take(cut) {
        let repl = if let FoldItem::Verbatim(e) = &*item {
            if let Kind::ToolResult { output } = &e.kind { Some((e.id, output.len())) } else { None }
        } else {
            None
        };
        if let Some((id, bytes)) = repl {
            diags.push(format!("tool-result {id} outside recency window: stubbed ({bytes} bytes elided)"));
            *item = FoldItem::Stub { id, elided_bytes: bytes };
        }
    }
    (out, diags)
}

fn sig(items: &[FoldItem]) -> Vec<String> {
    items
        .iter()
        .map(|it| match it {
            FoldItem::Verbatim(e) => format!("{}#{}", tag(&e.kind), e.id),
            FoldItem::Hoisted(e) => format!("hoist-{}#{}", tag(&e.kind), e.id),
            FoldItem::Summary { id, from, to, .. } => format!("summary#{id}[{from}..{to}]"),
            FoldItem::Stub { id, elided_bytes } => format!("stub#{id}({elided_bytes}B)"),
        })
        .collect()
}

fn show(label: &str, items: &[FoldItem], diags: &[String]) {
    println!("  {label}: {}", sig(items).join(" | "));
    for it in items {
        if let FoldItem::Summary { id, text, .. } = it {
            println!("    summary#{id} text: \"{text}\"");
        }
    }
    for d in diags {
        println!("    diag: {d}");
    }
}

// -------------------------------------------------------------- scenarios

struct Checker {
    pass: bool,
}

impl Checker {
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

fn scenario_tree(c: &mut Checker) {
    println!("== tree: §6.5 append / implicit fork / switch-leaf / read-path ==");
    let mut s = Session::default();
    let e1 = s.append(user("A"));
    let e2 = s.append(asst("B"));
    let e3 = s.append(user("C"));
    c.check(
        "append advances leaf; read path = root→leaf",
        s.leaf == Some(e3) && s.path() == vec![e1, e2, e3],
    );

    let s1 = s.switch_leaf(e2);
    let sw = s.get(s1).unwrap().clone();
    c.check(
        "switch-leaf appends a leaf-switch metadata entry (append-only) and moves the leaf",
        s.entries.len() == 4
            && sw.parent == Some(e3)
            && matches!(sw.kind, Kind::LeafSwitch { target } if target == e2)
            && s.leaf == Some(e2),
    );

    let e4 = s.append(user("C'"));
    c.check(
        "append at non-leaf entry forks implicitly: e2 gains a second child, no explicit branch op",
        s.get(e4).unwrap().parent == Some(e2) && s.children(e2) == vec![e3, e4],
    );
    c.check(
        "read path follows the new branch; sibling branch (incl. its leaf-switch entry) invisible",
        s.path() == vec![e1, e2, e4],
    );
    c.check(
        "history immutable: all 5 entries retained append-only, ids monotone",
        s.entries.len() == 5 && s.entries.windows(2).all(|w| w[0].id < w[1].id),
    );
    println!();
}

fn scenario_leaf_persist(c: &mut Checker) {
    println!("== leaf-persist: §6.5 effective leaf on load × §6.6 recovery ==");
    // Case A: appends AFTER the last leaf-switch.
    let mut s = Session::default();
    let _e1 = s.append(user("A"));
    let e2 = s.append(asst("B"));
    let _e3 = s.append(user("C"));
    let _s1 = s.switch_leaf(e2);
    let _e4 = s.append(asst("B' (regenerated)"));
    let e5 = s.append(user("ok"));

    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/target");
    std::fs::create_dir_all(dir).expect("mkdir target");
    let file = format!("{dir}/p12-leaf.session");
    let bytes = encode(&s.entries);
    std::fs::write(&file, &bytes).expect("write session file");
    let rb = std::fs::read(&file).expect("read session file");

    let (loaded, warns) = load_recovering(&rb);
    let (ls, diags) = Session::from_loaded(loaded);
    c.check(
        "persist + reload roundtrip: 6 entries, no warnings, no diagnostics",
        ls.entries.len() == 6 && warns.is_empty() && diags.is_empty(),
    );
    c.check(
        "effective leaf on load = last append AFTER the switch (replay rule: last entry decides)",
        ls.leaf == Some(e5),
    );
    let literal = spec_literal_leaf(&ls.entries);
    c.check(
        "DEFECT §6.5: literal wording 'last leaf-switch entry's target' yields the WRONG leaf (e2, not e5) once appends follow a switch",
        literal == Some(e2) && literal != ls.leaf,
    );
    println!(
        "  note: literal-rule leaf = {:?}, replay-rule leaf = {:?} — §6.5 must say 'replay appends and switches in file order' (equivalently: the last surviving entry decides).",
        literal, ls.leaf
    );

    // Case B: file ENDS in a leaf-switch — both rules agree.
    let mut t = Session::default();
    let _f1 = t.append(user("A"));
    let f2 = t.append(asst("B"));
    let f3 = t.append(user("C"));
    let _sw = t.switch_leaf(f2);
    let tbytes = encode(&t.entries);
    let (tl, twarns) = load_recovering(&tbytes);
    let (ts, _) = Session::from_loaded(tl);
    c.check(
        "file ending in a leaf-switch: effective leaf = switch target",
        twarns.is_empty() && ts.leaf == Some(f2) && spec_literal_leaf(&ts.entries) == Some(f2),
    );

    // Case C: tail truncated MID-FRAME (crash during the switch's write).
    let cutbytes = &tbytes[..tbytes.len() - 3];
    let (cl, cwarns) = load_recovering(cutbytes);
    let (cs, cdiags) = Session::from_loaded(cl);
    c.check(
        "tail truncated mid-frame (§6.6): switch entry lost, prior entries survive, leaf falls back to last surviving append",
        cs.entries.len() == 3
            && matches!(cwarns[..], [Warn::TruncatedTail { at_frame: 3 }])
            && cdiags.is_empty()
            && cs.leaf == Some(f3),
    );

    // Case D: corrupt BODY of an entry that is both a parent and a switch
    // target (§6.6 precise skip × §6.5 tree integrity).
    let frames: Vec<Vec<u8>> = t.entries.iter().map(cbor).collect();
    let mut cb = Vec::new();
    for (i, f) in frames.iter().enumerate() {
        if i == 1 {
            append_raw(&mut cb, &vec![0xFF; f.len()]); // garbage, not valid CBOR
        } else {
            append_raw(&mut cb, f);
        }
    }
    let (dl, dwarns) = load_recovering(&cb);
    let (ds, ddiags) = Session::from_loaded(dl);
    c.check(
        "corrupt BODY of a switch target (§6.6 skip): orphaned child + dangling switch detected; replay leaf falls back to last intact append",
        ds.entries.len() == 3
            && matches!(dwarns[..], [Warn::CorruptEntrySkipped { frame: 1 }])
            && ddiags.len() == 2
            && ds.leaf == Some(f3),
    );
    for d in &ddiags {
        println!("  diag: {d}");
    }
    println!("  note: §6.6's precise corrupt-entry skip breaks §6.5 tree integrity — SPEC defines no rule for orphaned children or dangling leaf-switch targets.");
    println!();
}

fn scenario_fold(c: &mut Checker) {
    println!("== fold: §6.9 assembly-time fold — span collapse, verbatim survivors, trim stubs ==");
    let mut s = Session::default();
    let e1 = s.append(user("investigate the flaky test"));
    let e2 = s.append(Kind::SecretRegistration { label: "github-token".into(), plaintext: "ghp_XYZ".into() });
    let _e3 = s.append(asst("reading the test file"));
    let _e4 = s.append(call("read"));
    let e5 = s.append(result(&"x".repeat(2000)));
    let e6 = s.append(asst("found a race in setup"));
    let e7 = s.append(user("fix it"));
    let sum1 = s.append(Kind::CompactionSummary {
        from: e1,
        to: e5,
        summary: "user asked to investigate a flaky test; test file read; race found in setup".into(),
    });
    let e8 = s.append(call("edit"));
    let e9 = s.append(result(&"y".repeat(500)));
    let e10 = s.append(asst("patched"));
    let e11 = s.append(user("run the tests"));

    let raw_before = encode(&s.entries);
    let (folded, diags) = fold_path(&s, &s.path(), 2);
    let raw_after = encode(&s.entries);
    show("folded", &folded, &diags);

    c.check(
        "storage untouched by fold: session bytes identical, all 12 entries verbatim on disk",
        raw_before == raw_after && s.entries.len() == 12,
    );
    let expected = vec![
        format!("hoist-secret#{e2}"),
        format!("summary#{sum1}[{e1}..{e5}]"),
        format!("asst#{e6}"),
        format!("user#{e7}"),
        format!("call#{e8}"),
        format!("stub#{e9}(500B)"),
        format!("asst#{e10}"),
        format!("user#{e11}"),
    ];
    c.check(
        "covered span [e1..e5] collapses into the summary at the span's path position; summary entry not duplicated at path end",
        sig(&folded) == expected,
    );
    c.check(
        "secret registration inside the covered span survives verbatim (hoisted ahead of the summary, plaintext+label intact)",
        matches!(&folded[0], FoldItem::Hoisted(e)
            if matches!(&e.kind, Kind::SecretRegistration { label, plaintext }
                if label == "github-token" && plaintext == "ghp_XYZ")),
    );
    c.check(
        "old tool-result outside the recency window stubbed; window (last 2) verbatim; 2000B result inside the span swallowed by it, not stubbed",
        matches!(folded[5], FoldItem::Stub { id, elided_bytes: 500 } if id == e9)
            && !sig(&folded).iter().any(|t| t == &format!("result#{e5}") || t == &format!("stub#{e5}(2000B)")),
    );
    println!("  note: §6.9 'secret registrations survive verbatim' is a §6.7 CONTRADICTION if the folded path is provider-visible as-is: the registration entry holds plaintext. Provider rendering must mask/exclude it; the fold preserves it structurally.");

    // Edge (c): a leaf-switch entry INSIDE a covered span.
    println!("-- edge (c): leaf-switch entry inside a covered span --");
    let mut t = Session::default();
    let g1 = t.append(user("start"));
    let g2 = t.append(asst("step 1"));
    let g3 = t.append(user("go on"));
    let _g4 = t.append(asst("step 2"));
    let _g5 = t.append(user("hmm"));
    let sw1 = t.switch_leaf(g3); // child of g5, leaf → g3
    let _sw2 = t.switch_leaf(sw1); // child of g3, leaf → sw1: a switch entry becomes path material
    let g6 = t.append(asst("continuing from the navigation point"));
    let tsum = t.append(Kind::CompactionSummary { from: g2, to: sw1, summary: "steps 1-2 done, user navigated".into() });
    let (tf, tdiags) = fold_path(&t, &t.path(), 10);
    show("folded", &tf, &tdiags);
    c.check(
        "edge (c): leaf-switch entry inside the covered span folds away like content (no special case, no residue)",
        sig(&tf) == vec![format!("user#{g1}"), format!("summary#{tsum}[{g2}..{sw1}]"), format!("asst#{g6}")],
    );
    let (tl, _) = Session::from_loaded(load_recovering(&encode(&t.entries)).0);
    c.check(
        "edge (c): leaf replay reads RAW storage, never the folded path — swallowing the switch is harmless to leaf resolution",
        tl.leaf == Some(tsum),
    );
    println!("  note: RULE for §6.9 — leaf-switch (and other metadata) entries inside a covered span are foldable; §6.5 leaf resolution operates on raw entries only.");

    // Edge (a): a summary whose span crosses a fork point.
    println!("-- edge (a): covered span crossing a fork point --");
    let mut u = Session::default();
    let h1 = u.append(user("root"));
    let h2 = u.append(asst("branch A work"));
    let _h3 = u.append(user("more branch A"));
    let _usw = u.switch_leaf(h1);
    let h4 = u.append(asst("branch B work")); // implicit fork at h1
    let bad = u.append(Kind::CompactionSummary { from: h2, to: h4, summary: "bogus cross-fork span".into() });
    let (uf, udiags) = fold_path(&u, &u.path(), 10);
    show("folded", &uf, &udiags);
    c.check(
        "edge (a): span with an endpoint on a sibling branch is DETECTED and the summary ignored — raw history shown, diagnostic emitted",
        sig(&uf) == vec![format!("user#{h1}"), format!("asst#{h4}")]
            && udiags.iter().any(|d| d.contains(&format!("summary {bad} IGNORED")) && d.contains("fork")),
    );
    println!("  note: RULE for §6.9 — a covered span MUST be a contiguous ancestor segment of the appending path (from ancestor-of to, to ancestor-of the summary entry). Well-formed compaction cannot create a cross-fork span (a summary's ancestors always include its span), so violations are file damage: fold must ignore the summary with a diagnostic, never guess.");
    println!();
}

fn scenario_branch_past_compaction(c: &mut Checker) {
    println!("== branch-past-compaction: §6.5 × §6.9 — masks ride the path ==");
    let mut s = Session::default();
    let e1 = s.append(user("goal: refactor the parser"));
    let e2 = s.append(asst("looking at the grammar"));
    let e3 = s.append(call("read"));
    let e4 = s.append(result(&"g".repeat(800)));
    let _e5 = s.append(asst("grammar is LL(1)"));
    let e6 = s.append(user("proceed"));
    let e7 = s.append(asst("refactoring"));
    let e8 = s.append(user("status?"));
    let sum1 = s.append(Kind::CompactionSummary {
        from: e1,
        to: e6,
        summary: "user wants parser refactor; grammar read, it is LL(1); user said proceed".into(),
    });
    let e9 = s.append(asst("halfway done"));
    let raw_before = encode(&s.entries);

    let (f1, d1) = fold_path(&s, &s.path(), 10);
    show("compaction branch", &f1, &d1);
    c.check(
        "fold on the compaction branch masks the covered span",
        sig(&f1) == vec![
            format!("summary#{sum1}[{e1}..{e6}]"),
            format!("asst#{e7}"),
            format!("user#{e8}"),
            format!("asst#{e9}"),
        ],
    );

    // Switch the leaf to a PRE-compaction entry (inside the covered span).
    let _sw1 = s.switch_leaf(e4);
    let (f2, d2) = fold_path(&s, &s.path(), 10);
    show("pre-compaction leaf", &f2, &d2);
    c.check(
        "leaf switched to a pre-compaction entry: folded path is FULL history — no summary on the path, nothing masked",
        sig(&f2) == vec![
            format!("user#{e1}"),
            format!("asst#{e2}"),
            format!("call#{e3}"),
            format!("result#{e4}"),
        ] && d2.is_empty(),
    );

    // Branch there and RE-compact: produces a sibling summary, not a nested one.
    let e10 = s.append(asst("alternate approach: recursive descent"));
    let sum2 = s.append(Kind::CompactionSummary {
        from: e1,
        to: e4,
        summary: "parser refactor goal; grammar read".into(),
    });
    let (f3, d3) = fold_path(&s, &s.path(), 10);
    show("re-compacted pre-branch", &f3, &d3);
    c.check(
        "pre-compaction branch is independently re-compactable: new summary lives on the new branch (SIBLING, not nested)",
        sig(&f3) == vec![format!("summary#{sum2}[{e1}..{e4}]"), format!("asst#{e10}")],
    );

    // Branch created AFTER the compaction point inherits the mask.
    let _sw2 = s.switch_leaf(e9);
    let e11 = s.append(user("new question on the compacted branch")); // implicit fork at e9
    let (f4, d4) = fold_path(&s, &s.path(), 10);
    show("post-compaction branch", &f4, &d4);
    c.check(
        "branch created after the compaction point inherits the mask (summary rides the shared path prefix)",
        sig(&f4) == vec![
            format!("summary#{sum1}[{e1}..{e6}]"),
            format!("asst#{e7}"),
            format!("user#{e8}"),
            format!("asst#{e9}"),
            format!("user#{e11}"),
        ],
    );

    // Edge (b): NESTED summaries — re-compaction on the SAME branch must cover
    // the earlier summary entry (it sits inside any older span).
    println!("-- edge (b): nested summaries (re-compaction on the same branch) --");
    let sum3 = s.append(Kind::CompactionSummary {
        from: e1,
        to: e9,
        summary: "parser refactor: grammar analyzed, refactor halfway done".into(),
    });
    let (f5, d5) = fold_path(&s, &s.path(), 10);
    show("nested fold", &f5, &d5);
    c.check(
        "edge (b): later summary covering the earlier summary folds OUTERMOST-WINS; inner summary subsumed with diagnostic",
        sig(&f5) == vec![format!("summary#{sum3}[{e1}..{e9}]"), format!("user#{e11}")]
            && d5.iter().any(|d| d.contains(&format!("summary {sum1} SUBSUMED by later summary {sum3}"))),
    );
    println!("  note: RULE for §6.9 — summaries DO nest: re-compaction on an already-compacted path always covers the prior summary entry. Fold rule: outermost (latest) span wins; 'existing compaction summary entries survive verbatim' can only mean they survive the TRIM LADDER (they are summarizer input), not that they escape a later covering span at fold time. Re-compaction after a pre-compaction leaf-switch instead yields a SIBLING summary on the new branch (no nesting).");

    let raw_now = encode(&s.entries);
    c.check(
        "storage grew append-only through every fold/switch/compaction: original bytes are a strict prefix of the file",
        raw_now.len() > raw_before.len() && raw_now[..raw_before.len()] == raw_before[..],
    );
    println!();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut c = Checker { pass: true };
    match arg.as_str() {
        "tree" => scenario_tree(&mut c),
        "leaf-persist" => scenario_leaf_persist(&mut c),
        "fold" => scenario_fold(&mut c),
        "branch-past-compaction" => scenario_branch_past_compaction(&mut c),
        "all" => {
            scenario_tree(&mut c);
            scenario_leaf_persist(&mut c);
            scenario_fold(&mut c);
            scenario_branch_past_compaction(&mut c);
        }
        other => return Err(format!("unknown scenario: {other} (use tree|leaf-persist|fold|branch-past-compaction|all)").into()),
    }
    if c.pass {
        println!("p12 RESULT: all expectations hold");
        Ok(())
    } else {
        Err("p12 RESULT: expectation failed".into())
    }
}
