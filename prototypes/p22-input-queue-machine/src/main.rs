//! p22-input-queue-machine
//!
//! Proves or disproves docs/SPEC.md §8.11 (Input Queue) with a deterministic
//! queue state machine + widget rendered via ratatui `TestBackend` (§17.7
//! styled-cell snapshot contract, per p08):
//!
//! - combined visual queue: follow-ups above steers, oldest→newest per kind,
//!   steers nearest the input; kinds visually distinct (prefix + style),
//! - promote/demote toggles a queued message between steer and follow-up,
//! - Up-arrow cycles newest→oldest across the visual queue; selecting an item
//!   edits it (it temporarily leaves the queue); re-send returns it to its
//!   previous position (best effort — the precise rule is implemented and
//!   reported); empty re-send deletes it,
//! - cancel keys pop the queue newest-to-oldest before aborting; empty queue
//!   → abort.
//!
//! §8.11 says "best effort" and "newest-to-oldest" without pinning three
//! rules. This prototype implements concrete rules and reports them:
//!
//! RULE A (promote/demote position): a promoted/demoted item moves to the
//!   NEWEST position of its new kind. Its enqueue-time position within the
//!   other kind's block is meaningless.
//! RULE B (edit best-effort reposition): on select-to-edit remember
//!   (kind, index-within-kind). On re-send: if the kind is unchanged, insert
//!   at min(remembered_index, kind_block_len); if the kind changed while the
//!   item was out of the queue (promote-while-editing), the remembered index
//!   is meaningless — append as the newest of the new kind (RULE A).
//! RULE C (cancel-pop order): "newest-to-oldest" is by ENQUEUE TIME across
//!   both kinds combined, not by visual-bottom-first. These diverge: the
//!   visual bottom is the newest steer, but a newer follow-up may exist
//!   above it. The divergence is demonstrated in `cancel-pop`.
//!
//! Verify: `cargo run -- ordering|promote-demote|edit-reposition|cancel-pop|all`
//! (exit 0, PASS lines; every scenario is run twice and all per-step styled
//! cell snapshots must be identical — determinism assert).

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Terminal;

// ---------------------------------------------------------------------------
// Queue state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    FollowUp,
    Steer,
}

impl Kind {
    fn toggled(self) -> Kind {
        match self {
            Kind::FollowUp => Kind::Steer,
            Kind::Steer => Kind::FollowUp,
        }
    }
}

#[derive(Debug, Clone)]
struct Item {
    #[allow(dead_code)]
    id: u32,
    /// Global enqueue-time counter. Survives promote/demote and edit
    /// round-trips: the enqueue time is when the user first submitted it.
    seq: u32,
    kind: Kind,
    text: String,
}

/// An item pulled out of the queue for editing (§8.11 "temporarily leaves
/// the queue"), plus what RULE B needs to reposition it on re-send.
#[derive(Debug, Clone)]
struct Edit {
    id: u32,
    seq: u32,
    orig_kind: Kind,
    kind: Kind, // may change via Promote while editing
    index_in_kind: usize,
    orig_text: String,
}

/// Deterministic key-event script steps.
#[derive(Debug, Clone)]
enum Step {
    /// Append text to the input line (clears any queue highlight).
    Type(&'static str),
    /// Plain Enter: re-send if editing; select-to-edit if an item is
    /// highlighted; otherwise submit input as a STEER (§6.1 default).
    Enter,
    /// Modified Enter: submit input as a FOLLOW-UP (§6.1/§8.11).
    ModEnter,
    /// Cycle the queue highlight newest→oldest across the visual queue
    /// (bottom-up), wrapping from the top back to the bottom.
    Up,
    /// Cycle back toward newest; past the newest clears the highlight.
    #[allow(dead_code)]
    Down,
    /// Toggle steer/follow-up of the highlighted item (RULE A), or of the
    /// item currently being edited (feeds RULE B's kind-changed branch).
    Promote,
    /// Cancel key (Ctrl+C/Esc): pop newest-by-enqueue-time if the queue is
    /// non-empty (RULE C); with an empty queue fire the abort action.
    CancelKey,
    /// While editing: replace the input with this text and re-send.
    EditResend(&'static str),
    /// While editing: clear the input and re-send (deletes the item).
    EditResendEmpty,
    /// Programmatic enqueue while the user is mid-edit — models
    /// `smith.send_message` from a plugin (§9.10), the only way items of
    /// the same kind appear/disappear while one is out of the queue.
    Inject(Kind, &'static str),
}

#[derive(Debug, Default)]
struct Machine {
    followups: Vec<Item>,
    steers: Vec<Item>,
    input: String,
    /// Highlight index into the visual list (0 = top = oldest follow-up).
    highlight: Option<usize>,
    editing: Option<Edit>,
    aborted: bool,
    next_id: u32,
    next_seq: u32,
}

impl Machine {
    fn visual(&self) -> Vec<&Item> {
        self.followups.iter().chain(self.steers.iter()).collect()
    }

    fn visual_len(&self) -> usize {
        self.followups.len() + self.steers.len()
    }

    fn kind_vec_mut(&mut self, kind: Kind) -> &mut Vec<Item> {
        match kind {
            Kind::FollowUp => &mut self.followups,
            Kind::Steer => &mut self.steers,
        }
    }

    fn enqueue(&mut self, kind: Kind, text: &str) {
        self.next_id += 1;
        self.next_seq += 1;
        let item = Item {
            id: self.next_id,
            seq: self.next_seq,
            kind,
            text: text.to_string(),
        };
        self.kind_vec_mut(kind).push(item);
    }

    /// Remove the item at visual index `i`; return it plus (kind, index
    /// within its kind block).
    fn remove_visual(&mut self, i: usize) -> (Item, Kind, usize) {
        if i < self.followups.len() {
            (self.followups.remove(i), Kind::FollowUp, i)
        } else {
            let j = i - self.followups.len();
            (self.steers.remove(j), Kind::Steer, j)
        }
    }

    /// RULE B: best-effort reposition on re-send.
    fn resend(&mut self) {
        let e = self.editing.take().expect("resend requires an active edit");
        let text = std::mem::take(&mut self.input);
        if text.trim().is_empty() {
            return; // §8.11: re-sending it empty removes it.
        }
        let item = Item { id: e.id, seq: e.seq, kind: e.kind, text };
        if e.kind != e.orig_kind {
            // Kind changed while the item was out of the queue: the
            // remembered index belongs to the other kind — meaningless.
            // RULE A applies: newest of the new kind.
            self.kind_vec_mut(e.kind).push(item);
        } else {
            let v = self.kind_vec_mut(e.kind);
            let idx = e.index_in_kind.min(v.len()); // clamp (RULE B)
            v.insert(idx, item);
        }
    }

    /// RULE C: pop the newest item by enqueue time across BOTH kinds.
    fn cancel(&mut self) {
        let fmax = self.followups.iter().map(|i| i.seq).max();
        let smax = self.steers.iter().map(|i| i.seq).max();
        match (fmax, smax) {
            (Some(f), Some(s)) if f > s => self.pop_max(Kind::FollowUp),
            (Some(_), Some(_)) => self.pop_max(Kind::Steer),
            (Some(_), None) => self.pop_max(Kind::FollowUp),
            (None, Some(_)) => self.pop_max(Kind::Steer),
            (None, None) => {
                if let Some(e) = self.editing.take() {
                    // Cancel the edit: the item returns unchanged (RULE B
                    // path with its original text).
                    self.input.clear();
                    let item = Item {
                        id: e.id,
                        seq: e.seq,
                        kind: e.orig_kind,
                        text: e.orig_text,
                    };
                    let idx = e.index_in_kind.min(self.kind_vec_mut(e.orig_kind).len());
                    self.kind_vec_mut(e.orig_kind).insert(idx, item);
                } else {
                    self.aborted = true; // §8.11: empty queue → abort (§12).
                }
            }
        }
        self.highlight = None;
    }

    fn pop_max(&mut self, kind: Kind) {
        let v = self.kind_vec_mut(kind);
        let (pos, _) = v
            .iter()
            .enumerate()
            .max_by_key(|(_, it)| it.seq)
            .expect("pop_max on empty kind vec");
        v.remove(pos);
    }

    fn apply(&mut self, step: &Step) {
        match step {
            Step::Type(s) => {
                self.input.push_str(s);
                if self.editing.is_none() {
                    self.highlight = None;
                }
            }
            Step::Enter => {
                if self.editing.is_some() {
                    self.resend();
                } else if let Some(i) = self.highlight.take() {
                    // §8.11: selecting a queued message edits it; it
                    // temporarily leaves the queue.
                    let (item, kind, idx) = self.remove_visual(i);
                    self.input = item.text.clone();
                    self.editing = Some(Edit {
                        id: item.id,
                        seq: item.seq,
                        orig_kind: kind,
                        kind,
                        index_in_kind: idx,
                        orig_text: item.text,
                    });
                } else if !self.input.trim().is_empty() {
                    let text = std::mem::take(&mut self.input);
                    self.enqueue(Kind::Steer, &text);
                }
            }
            Step::ModEnter => {
                if self.editing.is_some() {
                    self.resend();
                } else if !self.input.trim().is_empty() {
                    let text = std::mem::take(&mut self.input);
                    self.enqueue(Kind::FollowUp, &text);
                }
            }
            Step::Up => {
                if self.editing.is_none() {
                    let n = self.visual_len();
                    if n > 0 {
                        self.highlight = Some(match self.highlight {
                            None => n - 1,          // newest visual = bottom
                            Some(0) => n - 1,       // wrap top → bottom
                            Some(i) => i - 1,       // toward oldest (up)
                        });
                    }
                }
            }
            Step::Down => {
                if self.editing.is_none() {
                    let n = self.visual_len();
                    self.highlight = match self.highlight {
                        Some(i) if i + 1 < n => Some(i + 1),
                        _ => None, // past newest → back to plain input
                    };
                }
            }
            Step::Promote => {
                if let Some(e) = self.editing.as_mut() {
                    e.kind = e.kind.toggled();
                } else if let Some(i) = self.highlight {
                    // RULE A: move to the newest position of the new kind.
                    let (mut item, _, _) = self.remove_visual(i);
                    item.kind = item.kind.toggled();
                    let new_kind = item.kind;
                    self.kind_vec_mut(new_kind).push(item);
                    self.highlight = Some(match new_kind {
                        Kind::FollowUp => self.followups.len() - 1,
                        Kind::Steer => self.visual_len() - 1,
                    });
                }
            }
            Step::CancelKey => self.cancel(),
            Step::EditResend(s) => {
                assert!(self.editing.is_some(), "EditResend requires an active edit");
                self.input = s.to_string();
                self.resend();
            }
            Step::EditResendEmpty => {
                assert!(self.editing.is_some(), "EditResendEmpty requires an active edit");
                self.input.clear();
                self.resend();
            }
            Step::Inject(kind, s) => self.enqueue(*kind, s),
        }
    }
}

// ---------------------------------------------------------------------------
// Widget rendered via TestBackend (fixed 40x12), §17.7 styled-cell snapshots
// ---------------------------------------------------------------------------

const W: u16 = 40;
const H: u16 = 12;
const QH: u16 = 9; // bordered queue block rows 1..=9 → 7 inner item slots

const FOLLOWUP_STYLE: Style = Style::new().fg(Color::Cyan).add_modifier(Modifier::ITALIC);
const STEER_STYLE: Style = Style::new().fg(Color::Yellow);

fn render(m: &Machine) -> Buffer {
    let mut term = Terminal::new(TestBackend::new(W, H)).expect("test terminal");
    term.draw(|f| {
        let header =
            Paragraph::new(" p22 input queue").style(Style::default().add_modifier(Modifier::BOLD));
        f.render_widget(header, Rect::new(0, 0, W, 1));

        // Combined queue between history (above) and input (below), §8.11.
        let area = Rect::new(0, 1, W, QH);
        let block = Block::bordered().title("queue");
        let inner = block.inner(area);
        f.render_widget(block, area);
        for (i, item) in m.visual().iter().enumerate() {
            if (i as u16) >= inner.height {
                break;
            }
            // Kinds visually distinct: prefix AND style.
            let (prefix, mut style) = match item.kind {
                Kind::FollowUp => ("↑ ", FOLLOWUP_STYLE),
                Kind::Steer => ("» ", STEER_STYLE),
            };
            if m.highlight == Some(i) {
                style = style.add_modifier(Modifier::REVERSED);
            }
            let line = Paragraph::new(format!("{prefix}{}", item.text)).style(style);
            f.render_widget(line, Rect::new(inner.x, inner.y + i as u16, inner.width, 1));
        }

        let edit_tag = if m.editing.is_some() { " [edit]" } else { "" };
        let input = Paragraph::new(format!("> {}{edit_tag}", m.input));
        f.render_widget(input, Rect::new(0, 1 + QH, W, 1));

        let status_text = if m.aborted {
            " ABORT delivered (§12)".to_string()
        } else {
            format!(" F:{} S:{}", m.followups.len(), m.steers.len())
        };
        let status =
            Paragraph::new(status_text).style(Style::default().fg(Color::Black).bg(Color::Gray));
        f.render_widget(status, Rect::new(0, 1 + QH + 1, W, 1));
    })
    .expect("draw");
    term.backend().buffer().clone()
}

/// §17.7 snapshot contract: symbol plus full style per cell, not text alone.
fn buffer_cells(buf: &Buffer) -> Vec<(String, Style)> {
    let mut cells = Vec::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let c = buf.cell((x, y)).expect("cell in area");
            cells.push((c.symbol().to_string(), c.style()));
        }
    }
    cells
}

fn buffer_text(buf: &Buffer) -> String {
    let mut rows = Vec::new();
    for y in 0..buf.area.height {
        let mut row = String::new();
        for x in 0..buf.area.width {
            row.push_str(buf.cell((x, y)).expect("cell in area").symbol());
        }
        rows.push(row);
    }
    rows.join("\n")
}

/// Queue rows as trimmed text lines (inside the border), for order asserts.
fn queue_rows(buf: &Buffer) -> Vec<String> {
    let mut rows = Vec::new();
    for y in 2..2 + (QH - 2) {
        let mut row = String::new();
        for x in 1..W - 1 {
            row.push_str(buf.cell((x, y)).expect("cell").symbol());
        }
        let t = row.trim_end().to_string();
        if !t.is_empty() {
            rows.push(t);
        }
    }
    rows
}

/// Foreground of the first cell of queue row `i` (the kind prefix glyph).
fn queue_row_fg(buf: &Buffer, i: u16) -> Option<Color> {
    buf.cell((1, 2 + i)).map(|c| c.style().fg).flatten()
}

fn input_row(buf: &Buffer) -> String {
    let mut row = String::new();
    for x in 0..W {
        row.push_str(buf.cell((x, 10)).expect("cell").symbol());
    }
    row.trim_end().to_string()
}

fn status_row(buf: &Buffer) -> String {
    let mut row = String::new();
    for x in 0..W {
        row.push_str(buf.cell((x, 11)).expect("cell").symbol());
    }
    row.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

struct Ctx {
    ok: bool,
    /// One styled-cell snapshot per applied step (§17.7), for determinism.
    snaps: Vec<Vec<(String, Style)>>,
    m: Machine,
    quiet: bool,
}

impl Ctx {
    fn new(quiet: bool) -> Self {
        Ctx { ok: true, snaps: Vec::new(), m: Machine::default(), quiet }
    }

    /// Apply steps, snapshotting the styled buffer after each one.
    fn drive(&mut self, steps: &[Step]) -> Buffer {
        let mut last = render(&self.m);
        for s in steps {
            self.m.apply(s);
            last = render(&self.m);
            self.snaps.push(buffer_cells(&last));
        }
        last
    }

    fn check(&mut self, label: &str, cond: bool) {
        if !self.quiet {
            println!("{} {label}", if cond { "PASS" } else { "FAIL" });
        }
        self.ok &= cond;
    }

    fn check_rows(&mut self, label: &str, buf: &Buffer, expected: &[&str]) {
        let got = queue_rows(buf);
        let cond = got == expected;
        self.check(label, cond);
        if !cond && !self.quiet {
            println!("  expected: {expected:?}\n  got:      {got:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// Checked-in full-buffer snapshot for the ordering end state (layout-only
/// text form; the styled-cell form is asserted programmatically below).
const ORDERING_EXPECTED: &str = concat!(
    " p22 input queue                        \n",
    "┌queue─────────────────────────────────┐\n",
    "│↑ F1                                  │\n",
    "│↑ F2                                  │\n",
    "│» S1                                  │\n",
    "│» S2                                  │\n",
    "│                                      │\n",
    "│                                      │\n",
    "│                                      │\n",
    "└──────────────────────────────────────┘\n",
    ">                                       \n",
    " F:2 S:2                                ",
);

fn scenario_ordering(quiet: bool) -> Ctx {
    let mut c = Ctx::new(quiet);
    // Enqueue steer, follow-up, steer, follow-up.
    let buf = c.drive(&[
        Step::Type("S1"),
        Step::Enter,
        Step::Type("F1"),
        Step::ModEnter,
        Step::Type("S2"),
        Step::Enter,
        Step::Type("F2"),
        Step::ModEnter,
    ]);
    // §8.11: follow-ups above steers, oldest→newest per kind, steers at the
    // bottom (nearest the input).
    c.check_rows(
        "ordering: visual order [F1, F2, S1, S2] top-to-bottom",
        &buf,
        &["↑ F1", "↑ F2", "» S1", "» S2"],
    );
    let f_fg = queue_row_fg(&buf, 0);
    let s_fg = queue_row_fg(&buf, 2);
    c.check(
        "ordering: kinds visually distinct (follow-up style != steer style)",
        f_fg.is_some() && s_fg.is_some() && f_fg != s_fg,
    );
    c.check(
        "ordering: within-kind style uniform (F1==F2, S1==S2)",
        queue_row_fg(&buf, 0) == queue_row_fg(&buf, 1)
            && queue_row_fg(&buf, 2) == queue_row_fg(&buf, 3),
    );
    let text = buffer_text(&buf);
    let snap_ok = text == ORDERING_EXPECTED;
    c.check("ordering: full buffer equals checked-in snapshot", snap_ok);
    if !snap_ok && !quiet {
        println!("--- expected ---\n{ORDERING_EXPECTED}\n--- got ---\n{text}\n---");
    }
    c
}

fn scenario_promote_demote(quiet: bool) -> Ctx {
    let mut c = Ctx::new(quiet);
    let buf = c.drive(&[
        Step::Type("S1"),
        Step::Enter,
        Step::Type("S2"),
        Step::Enter,
        Step::Type("F1"),
        Step::ModEnter,
        Step::Type("F2"),
        Step::ModEnter,
    ]);
    c.check_rows("promote: initial [F1, F2, S1, S2]", &buf, &["↑ F1", "↑ F2", "» S1", "» S2"]);

    // Highlight the newest steer S2 (one Up from the input) and promote it.
    let buf = c.drive(&[Step::Up, Step::Promote]);
    // RULE A: S2 becomes the NEWEST follow-up.
    c.check_rows(
        "promote: S2 promoted → newest follow-up [F1, F2, S2, S1] (RULE A)",
        &buf,
        &["↑ F1", "↑ F2", "↑ S2", "» S1"],
    );
    c.check(
        "promote: promoted row restyled as follow-up",
        // Highlight adds REVERSED but fg still differs steer vs follow-up.
        queue_row_fg(&buf, 2) == queue_row_fg(&buf, 0),
    );

    // Demote it back: returns as the newest steer → original order restored
    // (S2 was the newest steer to begin with).
    let buf = c.drive(&[Step::Promote]);
    c.check_rows(
        "demote: S2 demoted back → order stable [F1, F2, S1, S2]",
        &buf,
        &["↑ F1", "↑ F2", "» S1", "» S2"],
    );

    // Consequence of RULE A worth pinning in §8.11: a promote→demote round
    // trip of a NON-newest item does NOT restore the original order.
    let buf = c.drive(&[Step::Up, Step::Promote, Step::Promote]);
    // Up moved the highlight from S2 to S1 (older); promote → newest
    // follow-up; demote → newest STEER, i.e. S1 now sits below S2.
    c.check_rows(
        "demote: round trip of non-newest S1 lands it newest [F1, F2, S2, S1] (RULE A consequence)",
        &buf,
        &["↑ F1", "↑ F2", "» S2", "» S1"],
    );
    c
}

fn scenario_edit_reposition(quiet: bool) -> Ctx {
    let mut c = Ctx::new(quiet);
    let buf = c.drive(&[
        Step::Type("S1"),
        Step::Enter,
        Step::Type("S2"),
        Step::Enter,
        Step::Type("S3"),
        Step::Enter,
        Step::Type("F1"),
        Step::ModEnter,
    ]);
    c.check_rows("edit: initial [F1, S1, S2, S3]", &buf, &["↑ F1", "» S1", "» S2", "» S3"]);

    // Up cycles newest→oldest across the visual queue: S3 (bottom), then S2.
    let buf = c.drive(&[Step::Up]);
    c.check(
        "edit: first Up highlights the newest visual item (S3, bottom)",
        c.m.highlight == Some(3),
    );
    let _ = buf;
    let buf = c.drive(&[Step::Up, Step::Enter]);
    // Selecting S2 edits it: it leaves the queue; its text is in the input.
    c.check_rows("edit: S2 left the queue [F1, S1, S3]", &buf, &["↑ F1", "» S1", "» S3"]);
    c.check("edit: input holds the edited text", input_row(&buf) == "> S2 [edit]");

    // Re-send returns it to its previous position among its kind.
    let buf = c.drive(&[Step::EditResend("S2x")]);
    c.check_rows(
        "edit: re-send returns to previous position [F1, S1, S2x, S3] (RULE B)",
        &buf,
        &["↑ F1", "» S1", "» S2x", "» S3"],
    );

    // THE EDGE: while edited, same-kind items are added/removed so the
    // previous position is gone.
    // Edge 1 — clamp still inside: edit S2x (steer index 1); pop F1 and S3
    // (cancel pops newest-by-seq: F1 seq4, then S3 seq3); inject S4.
    let buf = c.drive(&[
        Step::Up,
        Step::Up,
        Step::Enter, // edit S2x, remembered (Steer, index 1)
        Step::CancelKey, // pops F1 (newest seq in queue)
        Step::CancelKey, // pops S3
        Step::Inject(Kind::Steer, "S4"),
        Step::EditResend("S2y"),
    ]);
    c.check_rows(
        "edit edge: (Steer,1) still valid after churn → [S1, S2y, S4] (RULE B clamp no-op)",
        &buf,
        &["» S1", "» S2y", "» S4"],
    );

    // Edge 2 — previous position gone entirely: remembered (Steer, 1) but
    // the steer block shrinks to 0 while edited → clamp to len 0.
    let buf = c.drive(&[
        Step::Up,
        Step::Up,
        Step::Enter, // edit S2y, remembered (Steer, index 1)
        Step::CancelKey, // pops S4 (seq 6)
        Step::CancelKey, // pops S1 (seq 1) → steer block empty
        Step::EditResend("S2z"),
    ]);
    c.check_rows(
        "edit edge: remembered index 1, block now empty → clamp to 0 → [S2z] (RULE B clamp)",
        &buf,
        &["» S2z"],
    );

    // Edge 3 — kind changed while away (promote-while-editing): remembered
    // index belongs to the OLD kind, impossible to honor → RULE A: newest of
    // the new kind.
    let buf = c.drive(&[
        Step::Up,
        Step::Enter, // edit S2z, remembered (Steer, index 0)
        Step::Inject(Kind::FollowUp, "F9"),
        Step::Promote, // toggles the edited item's kind to FollowUp
        Step::EditResend("S2p"),
    ]);
    c.check_rows(
        "edit edge: promoted while away → newest follow-up [F9, S2p] (RULE B → RULE A)",
        &buf,
        &["↑ F9", "↑ S2p"],
    );
    c.check(
        "edit edge: repositioned item restyled as follow-up",
        queue_row_fg(&buf, 1) == queue_row_fg(&buf, 0),
    );

    // Empty re-send deletes (§8.11).
    let buf = c.drive(&[Step::Up, Step::Enter, Step::EditResendEmpty]);
    c.check_rows("edit: empty re-send deletes the item → [F9]", &buf, &["↑ F9"]);
    c.check("edit: input cleared after empty re-send", input_row(&buf) == ">");
    c
}

fn scenario_cancel_pop(quiet: bool) -> Ctx {
    let mut c = Ctx::new(quiet);
    // Interleave kinds so enqueue-time order and visual-bottom order differ.
    let buf = c.drive(&[
        Step::Type("S1"),
        Step::Enter, // seq 1
        Step::Type("F1"),
        Step::ModEnter, // seq 2
        Step::Type("S2"),
        Step::Enter, // seq 3
        Step::Type("F2"),
        Step::ModEnter, // seq 4 (newest by enqueue time)
    ]);
    c.check_rows("cancel: initial [F1, F2, S1, S2]", &buf, &["↑ F1", "↑ F2", "» S1", "» S2"]);

    // DIVERGENCE CASE (RULE C): visual bottom is S2 (newest steer), but the
    // newest item by enqueue time is F2. Enqueue-time rule removes F2.
    let buf = c.drive(&[Step::CancelKey]);
    c.check_rows(
        "cancel: pops F2 (newest by enqueue time), NOT visual-bottom S2 (RULE C divergence)",
        &buf,
        &["↑ F1", "» S1", "» S2"],
    );
    let buf = c.drive(&[Step::CancelKey]);
    c.check_rows("cancel: pops S2 (seq 3)", &buf, &["↑ F1", "» S1"]);
    let buf = c.drive(&[Step::CancelKey]);
    c.check_rows("cancel: pops F1 (seq 2)", &buf, &["» S1"]);
    let buf = c.drive(&[Step::CancelKey]);
    c.check("cancel: pops S1 (seq 1) → queue empty", queue_rows(&buf).is_empty());
    c.check(
        "cancel: no abort while the queue was non-empty",
        !c.m.aborted && status_row(&buf).trim() == "F:0 S:0",
    );

    // Only with an empty queue does the cancel key abort (§8.11/§12).
    let buf = c.drive(&[Step::CancelKey]);
    c.check(
        "cancel: empty queue → abort action fired",
        c.m.aborted && status_row(&buf).trim() == "ABORT delivered (§12)",
    );
    c
}

// ---------------------------------------------------------------------------
// Runner: each scenario runs twice; all per-step styled-cell snapshots must
// match exactly (§17.7 determinism).
// ---------------------------------------------------------------------------

fn run(name: &str, f: fn(bool) -> Ctx) -> bool {
    println!("== scenario: {name} ==");
    let first = f(false);
    let second = f(true); // quiet re-run for determinism comparison
    let mut ok = first.ok && second.ok;
    let det = first.snaps == second.snaps;
    println!(
        "{} determinism: {} per-step styled-cell snapshots identical across two runs",
        if det { "PASS" } else { "FAIL" },
        first.snaps.len()
    );
    ok &= det;
    println!();
    ok
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "all".to_string());
    let scenarios: &[(&str, fn(bool) -> Ctx)] = &[
        ("ordering", scenario_ordering),
        ("promote-demote", scenario_promote_demote),
        ("edit-reposition", scenario_edit_reposition),
        ("cancel-pop", scenario_cancel_pop),
    ];
    let mut ok = true;
    let mut matched = false;
    for (name, f) in scenarios {
        if arg == "all" || arg == *name {
            matched = true;
            ok &= run(name, *f);
        }
    }
    if !matched {
        eprintln!("unknown scenario {arg:?}; use ordering|promote-demote|edit-reposition|cancel-pop|all");
        std::process::exit(2);
    }
    if ok {
        println!("p22 RESULT: §8.11 queue machine claims hold under RULES A/B/C (see header comment)");
    } else {
        println!("p22 RESULT: FAIL");
        std::process::exit(1);
    }
}
