//! p21-compaction-round
//!
//! Proves or disproves docs/SPEC.md §6.9 — the compaction ROUND (the fold
//! itself is p12-proven; its tree+fold model is copied here):
//!   - trigger: before each provider request, estimated folded-path tokens
//!     (chars/4, §6.9) vs threshold = fraction of context_window minus the
//!     output-token reserve (named config values),
//!   - trim ladder order: mask old tool-result bodies → mask old thinking
//!     blocks → LLM-summarize the oldest span (mock deterministic summarizer),
//!   - summary entry appended; repeat until fit or iteration limit,
//!   - recency window (token-budget fraction of the context window) never
//!     touched by any ladder step,
//!   - summarizer requests tracked as cost.
//!
//! Edge hunting (the point of this prototype):
//!   (a) trigger off-by-one at threshold±1 token; reserve arithmetic,
//!   (b) iteration limit with a summarizer that doesn't shrink enough,
//!   (c) livelock: recency window ≥ threshold — trimming can never help;
//!       the round must detect and report, not spin,
//!   (d) re-entry impossibility by construction,
//!   (e) nested summary CREATION: the new span covers the prior summary
//!       entry and the summarizer input includes the inner summary text
//!       (§6.9 "existing compaction summary entries ... are summarizer input").
//!
//! Verify:
//!   cargo run -- trigger-math
//!   cargo run -- round
//!   cargo run -- iteration-limit
//!   cargo run -- livelock-guard
//!   cargo run -- all
//! Each exits 0 with PASS lines + token numbers when expectations hold.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

type EntryId = u64;

// --------------------------------------------------- session model (p12)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SessionEntry {
    id: EntryId,
    parent: Option<EntryId>,
    kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum Kind {
    /// §6.8 / §6.9: system prompt snapshot — survives the trim ladder.
    SystemPrompt { text: String },
    User { text: String },
    Assistant { text: String },
    /// Trim ladder step 2 target.
    Thinking { text: String },
    ToolCall { name: String },
    /// Trim ladder step 1 target (dominant bytes).
    ToolResult { output: String },
    /// §6.9 fold marker: collapses [from..to] on any path through it.
    CompactionSummary { from: EntryId, to: EntryId, summary: String },
    /// §6.7: holds plaintext; hoisted structurally, masked toward providers.
    SecretRegistration { label: String, plaintext: String },
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

    /// §6.5 read path: root→leaf.
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

/// Deterministic storage encoding (length-prefixed frames) so scenarios can
/// byte-compare the file image across a round. Stands in for §6.6 CBOR; the
/// codec itself is p06/p12-proven and not under test here.
fn encode(entries: &[SessionEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries {
        let b = format!("{e:?}").into_bytes();
        out.extend_from_slice(&(b.len() as u32).to_be_bytes());
        out.extend_from_slice(&b);
    }
    out
}

// ------------------------------------------------------------ fold (p12)

/// Assembly-time trim masks accumulated by rounds. §6.9: a mask, never a
/// storage mutation — fold applies it; the file never changes.
#[derive(Default)]
struct TrimState {
    stubbed_results: BTreeSet<EntryId>,
    masked_thinking: BTreeSet<EntryId>,
}

#[derive(Debug)]
enum FoldItem<'a> {
    Verbatim(&'a SessionEntry),
    /// Secret registration hoisted out of a collapsed span (p12).
    Hoisted(&'a SessionEntry),
    Summary { id: EntryId, from: EntryId, to: EntryId, text: &'a str },
    ResultStub { id: EntryId, elided: usize },
    ThinkingStub { id: EntryId, elided: usize },
}

/// p12's fold (span collapse, outermost-wins nesting, secret hoisting) plus
/// application of the round's trim masks.
fn fold_path<'a>(
    s: &'a Session,
    path: &[EntryId],
    trims: &TrimState,
) -> (Vec<FoldItem<'a>>, Vec<String>) {
    let pos: BTreeMap<EntryId, usize> = path.iter().enumerate().map(|(i, &e)| (e, i)).collect();
    let n = path.len();
    let mut cover: Vec<Option<usize>> = vec![None; n];
    let mut applied: BTreeSet<usize> = BTreeSet::new();
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
                _ => diags.push(format!(
                    "summary {eid} IGNORED: span [{from}..{to}] not an ancestor segment (p12 rule)"
                )),
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
        if applied.contains(&i) {
            continue;
        }
        let e = s.get(path[i]).expect("path entry exists");
        let item = match &e.kind {
            Kind::ToolResult { output } if trims.stubbed_results.contains(&e.id) => {
                FoldItem::ResultStub { id: e.id, elided: output.len() }
            }
            Kind::Thinking { text } if trims.masked_thinking.contains(&e.id) => {
                FoldItem::ThinkingStub { id: e.id, elided: text.len() }
            }
            _ => FoldItem::Verbatim(e),
        };
        out.push(item);
    }
    (out, diags)
}

/// Provider-visible rendering of a folded item (secrets masked per §6.7).
fn render(it: &FoldItem) -> String {
    fn entry_text(e: &SessionEntry) -> String {
        match &e.kind {
            Kind::SystemPrompt { text }
            | Kind::User { text }
            | Kind::Assistant { text }
            | Kind::Thinking { text } => text.clone(),
            Kind::ToolCall { name } => name.clone(),
            Kind::ToolResult { output } => output.clone(),
            Kind::CompactionSummary { summary, .. } => summary.clone(),
            Kind::SecretRegistration { label, .. } => format!("<secret: {label}>"),
        }
    }
    match it {
        FoldItem::Verbatim(e) | FoldItem::Hoisted(e) => entry_text(e),
        FoldItem::Summary { text, .. } => (*text).to_string(),
        FoldItem::ResultStub { elided, .. } => format!("[tool result elided: {elided} bytes]"),
        FoldItem::ThinkingStub { .. } => "[thinking elided]".to_string(),
    }
}

/// §6.9 v1 token estimator: chars/4 (rounded up per item).
fn item_tokens(it: &FoldItem) -> u64 {
    (render(it).len() as u64).div_ceil(4)
}

fn estimate(items: &[FoldItem]) -> u64 {
    items.iter().map(item_tokens).sum()
}

fn sig(items: &[FoldItem]) -> Vec<String> {
    items
        .iter()
        .map(|it| match it {
            FoldItem::Verbatim(e) => format!("{}#{}", tag(&e.kind), e.id),
            FoldItem::Hoisted(e) => format!("hoist-{}#{}", tag(&e.kind), e.id),
            FoldItem::Summary { id, from, to, .. } => format!("summary#{id}[{from}..{to}]"),
            FoldItem::ResultStub { id, elided } => format!("rstub#{id}({elided}B)"),
            FoldItem::ThinkingStub { id, elided } => format!("tstub#{id}({elided}B)"),
        })
        .collect()
}

fn tag(k: &Kind) -> &'static str {
    match k {
        Kind::SystemPrompt { .. } => "sys",
        Kind::User { .. } => "user",
        Kind::Assistant { .. } => "asst",
        Kind::Thinking { .. } => "think",
        Kind::ToolCall { .. } => "call",
        Kind::ToolResult { .. } => "result",
        Kind::CompactionSummary { .. } => "summary",
        Kind::SecretRegistration { .. } => "secret",
    }
}

// ----------------------------------------------------------------- config

/// Named config values per §6.9 / §5.6 / §5.7. Fractions are the named
/// config keys; the window and reserve come from `ModelMetadata`.
#[derive(Clone)]
struct Config {
    /// `AgentLoopConfig.model_metadata.context_window`
    context_window: u64,
    /// output-token reserve = `ModelMetadata.max_output_tokens`
    output_reserve_tokens: u64,
    /// named key `compaction.threshold_fraction`
    threshold_fraction: f64,
    /// named key `compaction.recency_fraction` (token-budget based, §6.9)
    recency_fraction: f64,
    /// named key `compaction.iteration_limit`
    iteration_limit: u32,
    /// mock summarizer knob: output size = ratio × input size (chars)
    summary_ratio: f64,
}

impl Config {
    /// §6.9: "a fraction of context_window minus the output-token reserve".
    fn threshold_tokens(&self) -> u64 {
        ((self.threshold_fraction * self.context_window as f64).floor() as u64)
            .saturating_sub(self.output_reserve_tokens)
    }

    fn recency_budget(&self) -> u64 {
        (self.recency_fraction * self.context_window as f64).floor() as u64
    }

    fn reserve_fraction(&self) -> f64 {
        self.output_reserve_tokens as f64 / self.context_window as f64
    }

    /// THE RULE §6.9 needs (this prototype's livelock-guard finding):
    /// the recency window must be strictly smaller than the threshold,
    /// i.e. recency_fraction + reserve_fraction < threshold_fraction.
    /// Otherwise a triggered round can never reach the threshold (the
    /// protected window alone can hold >= threshold tokens and no ladder
    /// step may touch it) — a config-level livelock.
    fn validate(&self) -> Result<(), String> {
        let rb = self.recency_budget();
        let th = self.threshold_tokens();
        if rb >= th {
            return Err(format!(
                "config invalid: recency budget ({rb} tok) >= compaction threshold ({th} tok); \
                 rule: compaction.recency_fraction + reserve_fraction < compaction.threshold_fraction \
                 ({:.2} + {:.2} = {:.2} !< {:.2})",
                self.recency_fraction,
                self.reserve_fraction(),
                self.recency_fraction + self.reserve_fraction(),
                self.threshold_fraction,
            ));
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ round

#[derive(Default)]
struct Cost {
    summarizer_requests: u32,
    input_tokens: u64,
    output_tokens: u64,
    /// mock ProviderUsage × ModelMetadata.cost (2 µ$/in-tok, 10 µ$/out-tok)
    microdollars: u64,
}

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    NotTriggered,
    Fits,
    IterationLimit,
    /// Runtime detection of the livelock config: the recency-protected
    /// suffix alone holds >= threshold tokens; no ladder step may touch it,
    /// so no sequence of steps can ever fit. Reported, never spun.
    RecencyDominates { protected: u64 },
    /// A full ladder pass reduced nothing (e.g. summarizer output >= input).
    NoProgress,
}

#[derive(Debug, Clone)]
struct SummaryInfo {
    id: EntryId,
    from: EntryId,
    to: EntryId,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Debug, Clone)]
struct PassReport {
    step1_saved: u64,
    tokens_after_step1: u64,
    step2_saved: u64,
    tokens_after_step2: u64,
    summary: Option<SummaryInfo>,
    tokens_after: u64,
}

#[derive(Debug, Clone)]
struct RoundReport {
    triggered: bool,
    tokens_before: u64,
    threshold: u64,
    protected_tokens: u64,
    passes: Vec<PassReport>,
    outcome: Outcome,
    tokens_after: u64,
}

/// Recency window per §6.9: the most recent folded items whose cumulative
/// estimate fits the token budget (adapts to model size). Returns protected
/// indices and the protected token total. The item that would overflow the
/// budget is NOT protected (documented choice; SPEC is silent).
fn protected_indices(items: &[FoldItem], budget: u64) -> (BTreeSet<usize>, u64) {
    let mut prot = BTreeSet::new();
    let mut cum = 0u64;
    for i in (0..items.len()).rev() {
        let t = item_tokens(&items[i]);
        if cum + t <= budget {
            cum += t;
            prot.insert(i);
        } else {
            break;
        }
    }
    (prot, cum)
}

enum MaskStep {
    ToolResults,
    Thinking,
}

struct Engine {
    session: Session,
    cfg: Config,
    trims: TrimState,
    cost: Cost,
    /// Re-entry guard (belt and braces — see `maybe_compact` for why
    /// re-entry is already impossible by construction).
    in_round: bool,
    provider_requests: u32,
    summary_seq: u32,
    /// Kept so scenarios can assert on summarizer request assembly.
    summarizer_inputs: Vec<String>,
}

impl Engine {
    fn new(cfg: Config) -> Self {
        Engine {
            session: Session::default(),
            cfg,
            trims: TrimState::default(),
            cost: Cost::default(),
            in_round: false,
            provider_requests: 0,
            summary_seq: 0,
            summarizer_inputs: Vec::new(),
        }
    }

    fn folded_tokens(&self) -> u64 {
        let path = self.session.path();
        let (items, _) = fold_path(&self.session, &path, &self.trims);
        estimate(&items)
    }

    /// The mock provider request. §6.9: the trigger check runs HERE,
    /// synchronously, before the request is sent.
    fn provider_request(&mut self) -> RoundReport {
        let report = self.maybe_compact();
        // ... mock provider call would consume the folded context here ...
        self.provider_requests += 1;
        report
    }

    /// One compaction round. RE-ENTRY IS IMPOSSIBLE BY CONSTRUCTION:
    ///  1. the round runs synchronously inside `provider_request`, which
    ///     takes `&mut self` — while it runs, the exclusive borrow means no
    ///     other code can call `provider_request` (the only trigger site);
    ///  2. the summarizer is invoked as a plain function over text, NOT via
    ///     `provider_request`, so summarizer calls never pass the trigger
    ///     check — a summarizer request cannot start a nested round;
    ///  3. the `in_round` assert is a runtime witness of 1+2, not the
    ///     mechanism itself.
    fn maybe_compact(&mut self) -> RoundReport {
        assert!(!self.in_round, "compaction round re-entered: construction broken");
        self.in_round = true;

        let threshold = self.cfg.threshold_tokens();
        let budget = self.cfg.recency_budget();
        let (tokens_before, protected_tokens) = {
            let path = self.session.path();
            let (items, _) = fold_path(&self.session, &path, &self.trims);
            let (_, pt) = protected_indices(&items, budget);
            (estimate(&items), pt)
        };
        let mut report = RoundReport {
            triggered: false,
            tokens_before,
            threshold,
            protected_tokens,
            passes: Vec::new(),
            outcome: Outcome::NotTriggered,
            tokens_after: tokens_before,
        };
        // Trigger: strictly EXCEED the threshold (§6.9 "exceed").
        if tokens_before <= threshold {
            self.in_round = false;
            return report;
        }
        report.triggered = true;

        // Runtime livelock detection (config validation is the real guard;
        // this catches a bypassed/stale config): the protected window can
        // only grow during a round, so protected >= threshold proves no
        // ladder step sequence can ever fit. Report instead of spinning.
        if protected_tokens >= threshold {
            report.outcome = Outcome::RecencyDominates { protected: protected_tokens };
            self.in_round = false;
            return report;
        }

        let mut tokens = tokens_before;
        let mut outcome = None;
        while report.passes.len() < self.cfg.iteration_limit as usize && outcome.is_none() {
            let pass_start = tokens;

            // Step 1: mask old tool-result bodies (cheapest, dominant bytes).
            let step1_saved = self.mask_step(MaskStep::ToolResults);
            tokens = self.folded_tokens();
            let tokens_after_step1 = tokens;
            if tokens <= threshold {
                report.passes.push(PassReport {
                    step1_saved,
                    tokens_after_step1,
                    step2_saved: 0,
                    tokens_after_step2: tokens,
                    summary: None,
                    tokens_after: tokens,
                });
                outcome = Some(Outcome::Fits);
                break;
            }

            // Step 2: mask old thinking blocks.
            let step2_saved = self.mask_step(MaskStep::Thinking);
            tokens = self.folded_tokens();
            let tokens_after_step2 = tokens;
            if tokens <= threshold {
                report.passes.push(PassReport {
                    step1_saved,
                    tokens_after_step1,
                    step2_saved,
                    tokens_after_step2,
                    summary: None,
                    tokens_after: tokens,
                });
                outcome = Some(Outcome::Fits);
                break;
            }

            // Step 3: LLM-summarize the oldest span (mock summarizer;
            // usage tracked as normal cost).
            let summary = self.summarize_step();
            tokens = self.folded_tokens();
            report.passes.push(PassReport {
                step1_saved,
                tokens_after_step1,
                step2_saved,
                tokens_after_step2,
                summary: summary.clone(),
                tokens_after: tokens,
            });
            if summary.is_none() {
                outcome = Some(Outcome::NoProgress); // nothing summarizable
            } else if tokens <= threshold {
                outcome = Some(Outcome::Fits);
            } else if tokens >= pass_start {
                outcome = Some(Outcome::NoProgress); // pass reduced nothing
            }
        }
        report.outcome = outcome.unwrap_or(Outcome::IterationLimit);
        report.tokens_after = tokens;
        self.in_round = false;
        report
    }

    /// Trim ladder steps 1/2: mask every eligible entry OUTSIDE the recency
    /// window. Ladder survivors (§6.9: secret registrations, system prompt
    /// snapshot, existing summaries) are never ToolResult/Thinking, so they
    /// are untouchable by kind; the recency window is enforced explicitly.
    fn mask_step(&mut self, step: MaskStep) -> u64 {
        let budget = self.cfg.recency_budget();
        let path = self.session.path();
        let (before, ids) = {
            let (items, _) = fold_path(&self.session, &path, &self.trims);
            let (prot, _) = protected_indices(&items, budget);
            let mut ids = Vec::new();
            for (i, it) in items.iter().enumerate() {
                if prot.contains(&i) {
                    continue; // recency window: never touched
                }
                if let FoldItem::Verbatim(e) = it {
                    match (&step, &e.kind) {
                        (MaskStep::ToolResults, Kind::ToolResult { .. })
                        | (MaskStep::Thinking, Kind::Thinking { .. }) => ids.push(e.id),
                        _ => {}
                    }
                }
            }
            (estimate(&items), ids)
        };
        for id in ids {
            match step {
                MaskStep::ToolResults => self.trims.stubbed_results.insert(id),
                MaskStep::Thinking => self.trims.masked_thinking.insert(id),
            };
        }
        before.saturating_sub(self.folded_tokens())
    }

    /// Trim ladder step 3: summarize the oldest span — the contiguous run of
    /// folded items after the system prompt snapshot (a ladder survivor) up
    /// to the last item outside the recency window. The summarizer input is
    /// the provider rendering of those items, so a prior summary's text IS
    /// summarizer input (§6.9) and secrets go in masked (§6.7). The covered
    /// span's raw endpoints include the prior summary ENTRY, creating the
    /// nesting p12 proved the fold handles.
    fn summarize_step(&mut self) -> Option<SummaryInfo> {
        let budget = self.cfg.recency_budget();
        let path = self.session.path();
        let (from, to, input) = {
            let (items, _) = fold_path(&self.session, &path, &self.trims);
            let (prot, _) = protected_indices(&items, budget);
            let start = items.iter().position(|it| {
                !matches!(it, FoldItem::Verbatim(e) if matches!(e.kind, Kind::SystemPrompt { .. }))
            })?;
            let end = (0..items.len()).rev().find(|i| !prot.contains(i))?;
            if start > end {
                return None; // everything after the snapshot is protected
            }
            let pos: BTreeMap<EntryId, usize> =
                path.iter().enumerate().map(|(i, &e)| (e, i)).collect();
            // Raw bounds represented by a folded item: a Summary item spans
            // from its covered `from` up to the summary ENTRY itself.
            let bounds = |it: &FoldItem| -> (EntryId, EntryId) {
                match it {
                    FoldItem::Verbatim(e) | FoldItem::Hoisted(e) => (e.id, e.id),
                    FoldItem::Summary { id, from, .. } => (*from, *id),
                    FoldItem::ResultStub { id, .. } | FoldItem::ThinkingStub { id, .. } => (*id, *id),
                }
            };
            let region = &items[start..=end];
            let from = region.iter().map(|it| bounds(it).0).min_by_key(|id| pos[id])?;
            let to = region.iter().map(|it| bounds(it).1).max_by_key(|id| pos[id])?;
            let input = region.iter().map(render).collect::<Vec<_>>().join("\n");
            (from, to, input)
        };
        self.summary_seq += 1;
        let summary = mock_summarize(self.summary_seq, &input, self.cfg.summary_ratio);
        let input_tokens = (input.len() as u64).div_ceil(4);
        let output_tokens = (summary.len() as u64).div_ceil(4);
        self.cost.summarizer_requests += 1;
        self.cost.input_tokens += input_tokens;
        self.cost.output_tokens += output_tokens;
        self.cost.microdollars += input_tokens * 2 + output_tokens * 10;
        self.summarizer_inputs.push(input);
        // §6.9: the pass APPENDS a summary entry; storage grows, never shrinks.
        let id = self.session.append(Kind::CompactionSummary { from, to, summary });
        Some(SummaryInfo { id, from, to, input_tokens, output_tokens })
    }
}

/// Mock summarizer: deterministic, output size = ratio × input size (chars).
/// The `[S<n>...]` marker lets scenarios detect a summary's text inside a
/// later summarizer input (nested-summary probe).
fn mock_summarize(seq: u32, input: &str, ratio: f64) -> String {
    let target = ((input.len() as f64) * ratio).round() as usize;
    let mut s = format!("[S{seq}<-{}ch] ", input.len());
    if s.len() < target {
        let pad = target - s.len();
        s.push_str(&"x".repeat(pad));
    }
    s
}

// -------------------------------------------------------------- reporting

fn print_report(label: &str, r: &RoundReport) {
    println!(
        "  {label}: {} tokens vs threshold {} (protected {}) -> {:?}",
        r.tokens_before, r.threshold, r.protected_tokens, r.outcome
    );
    for (i, p) in r.passes.iter().enumerate() {
        let s = match &p.summary {
            Some(si) => format!(
                "summary#{} [{}..{}] (in {} tok, out {} tok)",
                si.id, si.from, si.to, si.input_tokens, si.output_tokens
            ),
            None => "no summary".into(),
        };
        println!(
            "    pass {}: step1 -{} -> {} | step2 -{} -> {} | step3 {} -> {} tokens",
            i + 1,
            p.step1_saved,
            p.tokens_after_step1,
            p.step2_saved,
            p.tokens_after_step2,
            s,
            p.tokens_after
        );
    }
}

struct Checker {
    pass: bool,
}

impl Checker {
    fn check(&mut self, label: &str, ok: bool) {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        self.pass &= ok;
    }
}

fn text(n: usize) -> String {
    "x".repeat(n)
}

// -------------------------------------------------------------- scenarios

fn scenario_trigger_math(c: &mut Checker) {
    println!("== trigger-math: §6.9 trigger boundary, chars/4 estimator, output reserve ==");
    // W=1000, threshold_fraction=0.8, reserve=200 -> threshold = 800-200 = 600.
    let cfg = Config {
        context_window: 1000,
        output_reserve_tokens: 200,
        threshold_fraction: 0.8,
        recency_fraction: 0.2,
        iteration_limit: 5,
        summary_ratio: 0.5,
    };
    c.check("config valid (recency 200 < threshold 600)", cfg.validate().is_ok());
    println!(
        "  threshold = floor({:.1} * {}) - {} = {} tokens; estimator = chars/4",
        cfg.threshold_fraction,
        cfg.context_window,
        cfg.output_reserve_tokens,
        cfg.threshold_tokens()
    );
    c.check("threshold arithmetic: 600 tokens", cfg.threshold_tokens() == 600);

    let run = |cfg: &Config, chars: usize| -> (RoundReport, Engine) {
        let mut e = Engine::new(cfg.clone());
        e.session.append(Kind::User { text: text(chars) });
        let r = e.provider_request();
        (r, e)
    };

    // Exactly AT the threshold: 2400 chars = 600 tokens. "Exceed" is strict.
    let (at, e_at) = run(&cfg, 2400);
    print_report("at threshold (2400ch=600tok)", &at);
    c.check(
        "AT threshold (600 == 600): does NOT fire ('exceed' is strictly greater)",
        !at.triggered && at.tokens_before == 600,
    );
    c.check(
        "untriggered round is a no-op: no entries appended, no summarizer cost",
        e_at.session.entries.len() == 1 && e_at.cost.summarizer_requests == 0,
    );

    // threshold+1 token = +4 chars.
    let (over, _) = run(&cfg, 2404);
    print_report("threshold+1 (2404ch=601tok)", &over);
    c.check("threshold+1 (601 > 600): fires", over.triggered && over.tokens_before == 601);

    // threshold-1 token.
    let (under, _) = run(&cfg, 2396);
    print_report("threshold-1 (2396ch=599tok)", &under);
    c.check("threshold-1 (599 < 600): does not fire", !under.triggered && under.tokens_before == 599);

    // Reserve respected: zero the reserve -> threshold rises to 800.
    let mut cfg0 = cfg.clone();
    cfg0.output_reserve_tokens = 0;
    println!(
        "  reserve=0 -> threshold = floor(0.8 * 1000) - 0 = {} tokens",
        cfg0.threshold_tokens()
    );
    let (r800, _) = run(&cfg0, 3200); // 800 tokens
    let (r801, _) = run(&cfg0, 3204); // 801 tokens
    let (r601, _) = run(&cfg0, 2404); // 601 tokens: fires with reserve, not without
    c.check(
        "reserve respected: same 601-token path fires at reserve=200 (thr 600), not at reserve=0 (thr 800)",
        cfg0.threshold_tokens() == 800 && over.triggered && !r601.triggered,
    );
    c.check(
        "reserve=0 boundary re-probed: 800 no, 801 yes",
        !r800.triggered && r800.tokens_before == 800 && r801.triggered && r801.tokens_before == 801,
    );
    println!();
}

fn scenario_round(c: &mut Checker) {
    println!("== round: §6.9 full ladder on a realistic over-budget path ==");
    // W=2000, fraction 0.8, reserve 400 -> threshold 1200; recency 0.25 -> 500.
    let cfg = Config {
        context_window: 2000,
        output_reserve_tokens: 400,
        threshold_fraction: 0.8,
        recency_fraction: 0.25,
        iteration_limit: 5,
        summary_ratio: 0.1,
    };
    c.check("config valid", cfg.validate().is_ok());
    println!(
        "  threshold = {} tokens, recency budget = {} tokens",
        cfg.threshold_tokens(),
        cfg.recency_budget()
    );

    let mut e = Engine::new(cfg);
    e.session.append(Kind::SystemPrompt { text: text(100) });
    e.session.append(Kind::User { text: text(200) });
    let _sec = e.session.append(Kind::SecretRegistration {
        label: "github-token".into(),
        plaintext: "ghp_XYZ".into(),
    });
    let t1 = e.session.append(Kind::Thinking { text: text(1200) });
    e.session.append(Kind::ToolCall { name: "read".into() });
    let r1 = e.session.append(Kind::ToolResult { output: text(2400) });
    e.session.append(Kind::Assistant { text: text(4000) });
    e.session.append(Kind::User { text: text(200) });
    let t2 = e.session.append(Kind::Thinking { text: text(800) });
    e.session.append(Kind::ToolCall { name: "edit".into() });
    let r2 = e.session.append(Kind::ToolResult { output: text(1600) });
    e.session.append(Kind::Assistant { text: text(400) });
    e.session.append(Kind::User { text: text(100) });
    e.session.append(Kind::ToolCall { name: "test".into() });
    let r3 = e.session.append(Kind::ToolResult { output: text(800) }); // in recency window

    let bytes_before = encode(&e.session.entries);
    let entries_before = e.session.entries.len();

    let rep = e.provider_request();
    print_report("round 1", &rep);

    c.check(
        &format!("trigger fired: {} tokens > threshold {}", rep.tokens_before, rep.threshold),
        rep.triggered && rep.tokens_before > rep.threshold,
    );
    let p = &rep.passes[0];
    c.check(
        &format!(
            "trim step 1 (tool results) saved {} tokens ({} -> {}), still over threshold",
            p.step1_saved, rep.tokens_before, p.tokens_after_step1
        ),
        p.step1_saved > 0 && p.tokens_after_step1 > rep.threshold,
    );
    c.check(
        &format!(
            "trim step 2 (thinking) saved {} tokens ({} -> {}), still over threshold",
            p.step2_saved, p.tokens_after_step1, p.tokens_after_step2
        ),
        p.step2_saved > 0 && p.tokens_after_step2 > rep.threshold,
    );
    let n_summaries = e
        .session
        .entries
        .iter()
        .filter(|x| matches!(x.kind, Kind::CompactionSummary { .. }))
        .count();
    c.check(
        &format!(
            "step 3 appended exactly ONE summary entry; folded tokens {} <= threshold {} in one pass",
            rep.tokens_after, rep.threshold
        ),
        rep.passes.len() == 1
            && p.summary.is_some()
            && n_summaries == 1
            && rep.outcome == Outcome::Fits
            && rep.tokens_after <= rep.threshold,
    );

    // Recency window never touched by any ladder step.
    let prot_ok = !e.trims.stubbed_results.contains(&r3)
        && e.trims.stubbed_results.contains(&r1)
        && e.trims.stubbed_results.contains(&r2)
        && e.trims.masked_thinking.contains(&t1)
        && e.trims.masked_thinking.contains(&t2);
    let path = e.session.path();
    let (items, _) = fold_path(&e.session, &path, &e.trims);
    let final_sig = sig(&items);
    println!("  folded: {}", final_sig.join(" | "));
    c.check(
        "recency window untouched: recent tool result stays verbatim (800B); old results/thinking masked",
        prot_ok && final_sig.iter().any(|s| s == &format!("result#{r3}")),
    );

    // Storage untouched by the trim ladder; the summary is APPEND-only.
    let bytes_after = encode(&e.session.entries);
    c.check(
        &format!(
            "storage byte-compare: original {} bytes are a strict prefix of {} bytes; exactly one entry appended",
            bytes_before.len(),
            bytes_after.len()
        ),
        bytes_after.len() > bytes_before.len()
            && bytes_after[..bytes_before.len()] == bytes_before[..]
            && e.session.entries.len() == entries_before + 1,
    );

    // Summarizer request assembly + cost.
    c.check(
        &format!(
            "summarizer tracked as cost: 1 request, {} in + {} out tokens, {} microdollars",
            e.cost.input_tokens, e.cost.output_tokens, e.cost.microdollars
        ),
        e.cost.summarizer_requests == 1 && e.cost.input_tokens > 0 && e.cost.output_tokens > 0,
    );
    c.check(
        "summarizer input is the provider rendering: secret goes in MASKED (plaintext absent, §6.7)",
        e.summarizer_inputs[0].contains("<secret: github-token>")
            && !e.summarizer_inputs[0].contains("ghp_XYZ"),
    );

    // Re-entry: the round ran synchronously before the (single) provider
    // request; the summarizer request did not pass through provider_request.
    c.check(
        "re-entry impossible by construction: round guard clear; 1 provider request; summarizer bypassed the trigger site (&mut self exclusivity + summarizer-as-function, see maybe_compact doc)",
        !e.in_round && e.provider_requests == 1 && e.cost.summarizer_requests == 1,
    );

    // ---- phase 2: nested summary CREATION on re-trigger ----
    println!("-- nested: second round summarizes a span containing the first summary --");
    let s1_id = p.summary.as_ref().unwrap().id;
    e.session.append(Kind::Assistant { text: text(3600) });
    e.session.append(Kind::User { text: text(200) });
    e.session.append(Kind::Thinking { text: text(800) });
    e.session.append(Kind::ToolCall { name: "run".into() });
    e.session.append(Kind::ToolResult { output: text(1200) });

    let rep2 = e.provider_request();
    print_report("round 2", &rep2);
    c.check(
        &format!("second trigger: {} tokens > {}", rep2.tokens_before, rep2.threshold),
        rep2.triggered && rep2.outcome == Outcome::Fits && rep2.tokens_after <= rep2.threshold,
    );
    let s2 = rep2.passes[0].summary.as_ref().expect("round 2 summary");
    let path2 = e.session.path();
    let pos: BTreeMap<EntryId, usize> = path2.iter().enumerate().map(|(i, &x)| (x, i)).collect();
    c.check(
        &format!(
            "nested span covers the prior summary ENTRY: from {} <= S1 {} <= to {} (path positions)",
            s2.from, s1_id, s2.to
        ),
        pos[&s2.from] <= pos[&s1_id] && pos[&s1_id] <= pos[&s2.to],
    );
    c.check(
        "summarizer input includes the inner summary text (§6.9 'summaries are summarizer input')",
        e.summarizer_inputs[1].contains("[S1<-"),
    );
    let (items2, diags2) = fold_path(&e.session, &path2, &e.trims);
    let sig2 = sig(&items2);
    println!("  folded: {}", sig2.join(" | "));
    for d in &diags2 {
        println!("  diag: {d}");
    }
    c.check(
        "fold applies the outermost summary; inner S1 subsumed with diagnostic (p12 rule holds on round-created nesting)",
        sig2.iter().filter(|s| s.starts_with("summary#")).count() == 1
            && sig2.iter().any(|s| s.starts_with(&format!("summary#{}", s2.id)))
            && diags2.iter().any(|d| d.contains("SUBSUMED")),
    );
    let bytes_final = encode(&e.session.entries);
    c.check(
        "storage still append-only across both rounds: round-1 image is a strict prefix",
        bytes_final[..bytes_after.len()] == bytes_after[..],
    );
    println!();
}

fn scenario_iteration_limit(c: &mut Checker) {
    println!("== iteration-limit: §6.9 ladder stops at the configured limit, never spins ==");
    // W=2000, fraction 0.25, reserve 400 -> threshold 100; recency 0.02 -> 40.
    // Summarizer only shrinks to 90% — can never reach 100 tokens in 3 passes.
    let cfg = Config {
        context_window: 2000,
        output_reserve_tokens: 400,
        threshold_fraction: 0.25,
        recency_fraction: 0.02,
        iteration_limit: 3,
        summary_ratio: 0.9,
    };
    c.check(
        "config valid (recency 40 < threshold 100; 0.02 + 0.20 = 0.22 < 0.25)",
        cfg.validate().is_ok() && cfg.threshold_tokens() == 100 && cfg.recency_budget() == 40,
    );

    let mut e = Engine::new(cfg);
    e.session.append(Kind::SystemPrompt { text: text(40) });
    e.session.append(Kind::User { text: text(400) });
    e.session.append(Kind::Assistant { text: text(1200) });
    e.session.append(Kind::User { text: text(400) });
    e.session.append(Kind::Assistant { text: text(100) }); // recency window

    let rep = e.provider_request();
    print_report("round", &rep);

    c.check(
        &format!("trigger fired: {} tokens > threshold {}", rep.tokens_before, rep.threshold),
        rep.triggered,
    );
    c.check(
        &format!(
            "loop stopped at the configured limit: {} passes == limit 3, outcome IterationLimit, {} tokens still > {}",
            rep.passes.len(),
            rep.tokens_after,
            rep.threshold
        ),
        rep.passes.len() == 3
            && rep.outcome == Outcome::IterationLimit
            && rep.tokens_after > rep.threshold,
    );
    let toks: Vec<u64> = std::iter::once(rep.tokens_before)
        .chain(rep.passes.iter().map(|p| p.tokens_after))
        .collect();
    c.check(
        &format!("monotone progress every pass (no spin): {toks:?} strictly decreasing"),
        toks.windows(2).all(|w| w[1] < w[0]),
    );
    let summaries: Vec<&SessionEntry> = e
        .session
        .entries
        .iter()
        .filter(|x| matches!(x.kind, Kind::CompactionSummary { .. }))
        .collect();
    c.check(
        "one summary appended per pass: 3 nested summaries in storage",
        summaries.len() == 3 && rep.passes.iter().all(|p| p.summary.is_some()),
    );
    // Nesting chain: each later span covers the previous summary entry.
    let path = e.session.path();
    let pos: BTreeMap<EntryId, usize> = path.iter().enumerate().map(|(i, &x)| (x, i)).collect();
    let chain_ok = rep.passes.windows(2).all(|w| {
        let (prev, next) = (w[0].summary.as_ref().unwrap(), w[1].summary.as_ref().unwrap());
        pos[&next.from] <= pos[&prev.id] && pos[&prev.id] <= pos[&next.to]
    });
    c.check("each pass's span covers the previous pass's summary entry (nesting created correctly)", chain_ok);
    c.check(
        "each summarizer input contains the previous summary's text",
        e.summarizer_inputs[1].contains("[S1<-") && e.summarizer_inputs[2].contains("[S2<-"),
    );
    let (items, _) = fold_path(&e.session, &path, &e.trims);
    let fsig = sig(&items);
    println!("  folded: {}", fsig.join(" | "));
    c.check(
        "fold shows only the outermost summary after the limit stop",
        fsig.iter().filter(|s| s.starts_with("summary#")).count() == 1,
    );
    c.check(
        &format!(
            "all 3 summarizer requests tracked as cost: {} in + {} out tokens, {} microdollars",
            e.cost.input_tokens, e.cost.output_tokens, e.cost.microdollars
        ),
        e.cost.summarizer_requests == 3,
    );
    println!();
}

fn scenario_livelock_guard(c: &mut Checker) {
    println!("== livelock-guard: recency window >= threshold must be a CONFIG ERROR ==");
    // W=1000, fraction 0.8, reserve 200 -> threshold 600 (reserve_fraction 0.2).
    let base = Config {
        context_window: 1000,
        output_reserve_tokens: 200,
        threshold_fraction: 0.8,
        recency_fraction: 0.7, // budget 700 >= threshold 600
        iteration_limit: 5,
        summary_ratio: 0.5,
    };
    let err = base.validate().unwrap_err();
    println!("  validation: {err}");
    c.check(
        "recency 0.7: rejected at config validation (budget 700 >= threshold 600) with the arithmetic rule",
        err.contains("recency budget (700 tok) >= compaction threshold (600 tok)")
            && err.contains("0.70 + 0.20 = 0.90 !< 0.80"),
    );

    // EQUALITY is also a livelock: protected content can reach exactly the
    // threshold and any summary entry adds > 0 tokens on top -> the rule is
    // STRICT: recency_fraction + reserve_fraction < threshold_fraction.
    let mut eq = base.clone();
    eq.recency_fraction = 0.6; // budget 600 == threshold 600
    c.check(
        "recency 0.6 (budget == threshold): rejected — the rule is strict '<', equality still livelocks",
        eq.validate().is_err(),
    );
    let mut ok = base.clone();
    ok.recency_fraction = 0.59; // budget 590 < 600
    c.check(
        "recency 0.59 (budget 590 < 600): accepted (0.59 + 0.20 = 0.79 < 0.80)",
        ok.validate().is_ok(),
    );

    // Bypass validation to prove the ROUND still detects the livelock at
    // runtime and reports instead of spinning: a 600-token recent entry is
    // fully protected; protected >= threshold -> no ladder step can help.
    println!("-- validation bypassed: runtime detection --");
    let mut e = Engine::new(eq);
    e.session.append(Kind::User { text: text(1200) }); // 300 tok, old
    e.session.append(Kind::Assistant { text: text(2400) }); // 600 tok, protected
    let rep = e.provider_request();
    print_report("bypassed config", &rep);
    c.check(
        &format!(
            "round detects recency domination: protected {} >= threshold {}; 0 passes, 0 summaries, 0 cost — reported, not spun",
            rep.protected_tokens, rep.threshold
        ),
        rep.outcome == Outcome::RecencyDominates { protected: 600 }
            && rep.passes.is_empty()
            && e.cost.summarizer_requests == 0
            && e.session.entries.len() == 2,
    );
    println!(
        "  arithmetic: no ladder step may touch the recency window, and the window only grows \
         during a round, so protected ({}) >= threshold ({}) proves tokens can never drop to \
         threshold. Static form: recency_fraction + reserve_fraction < threshold_fraction.",
        rep.protected_tokens, rep.threshold
    );

    // Defense in depth: a VALID config but a useless summarizer (output >=
    // input). The no-progress guard aborts after one pass instead of burning
    // the full iteration limit.
    println!("-- no-progress guard: valid config, summarizer that does not shrink --");
    let np = Config {
        context_window: 1000,
        output_reserve_tokens: 200,
        threshold_fraction: 0.8,
        recency_fraction: 0.2,
        iteration_limit: 5,
        summary_ratio: 1.0,
    };
    c.check("no-progress config itself is valid (recency 200 < threshold 600)", np.validate().is_ok());
    let mut e2 = Engine::new(np);
    e2.session.append(Kind::User { text: text(1200) }); // 300 tok
    e2.session.append(Kind::User { text: text(1200) }); // 300 tok
    e2.session.append(Kind::Assistant { text: text(700) }); // 175 tok, protected
    let rep2 = e2.provider_request();
    print_report("no-shrink summarizer", &rep2);
    c.check(
        &format!(
            "pass reduced nothing ({} -> {} tokens): NoProgress after 1 pass, not {} passes",
            rep2.tokens_before,
            rep2.tokens_after,
            5
        ),
        rep2.outcome == Outcome::NoProgress && rep2.passes.len() == 1,
    );
    println!();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut c = Checker { pass: true };
    match arg.as_str() {
        "trigger-math" => scenario_trigger_math(&mut c),
        "round" => scenario_round(&mut c),
        "iteration-limit" => scenario_iteration_limit(&mut c),
        "livelock-guard" => scenario_livelock_guard(&mut c),
        "all" => {
            scenario_trigger_math(&mut c);
            scenario_round(&mut c);
            scenario_iteration_limit(&mut c);
            scenario_livelock_guard(&mut c);
        }
        other => {
            return Err(format!(
                "unknown scenario: {other} (use trigger-math|round|iteration-limit|livelock-guard|all)"
            )
            .into())
        }
    }
    if c.pass {
        println!("p21 RESULT: all expectations hold");
        Ok(())
    } else {
        Err("p21 RESULT: expectation failed".into())
    }
}
