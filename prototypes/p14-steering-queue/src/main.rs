//! p14-steering-queue
//!
//! Proves or disproves docs/SPEC.md §6.1 steering/follow-up claims (with
//! §5.3 ToolExecutionMode and §12 abort in view):
//! - steers deliver at the next safe boundary (stream end / current tool
//!   completion),
//! - pending not-yet-executed tool calls resolve as synthetic error results
//!   (`skipped: user steered`), every call has a result on the wire,
//! - queued steers drain FIFO as user messages before the next provider call,
//! - follow-ups dequeue instead of `agent_end` (FIFO, one per run-end),
//! - session entries are recorded at DELIVERY time only, never when queued,
//! - a delivered abort ends the run; whatever remains queued stays queued.
//!
//! Extends the p07 pattern: scripted StreamFn, deterministic AgentEvent
//! sequences, expect() comparisons, PASS/FAIL output. Parallel execution is
//! simulated with a deterministic completion order — concurrency changes
//! timing, not the boundary semantics under test.
//!
//! Decisions this prototype makes where §6.1 is silent or ambiguous (all
//! reported as spec issues):
//! - steer-mid-stream: a steer that arrives while the assistant message is
//!   still streaming is delivered after the stream completes; at that point
//!   NO call from that message has started executing, so ALL of its calls
//!   are pending and resolve as synthetic skipped results. The model
//!   re-plans with the steer visible.
//! - parallel boundary: "after the currently executing tool finishes" is
//!   ambiguous with N tools in flight. Implemented rule:
//!   WAIT-FOR-ALL-IN-FLIGHT — every already-started call runs to completion
//!   (real results, completion order), no new call starts once a steer is
//!   queued, never-started calls resolve skipped. The alternative
//!   (first-completion) would deliver the steer while sibling calls are
//!   still executing — their results would race the steer message or force
//!   mid-execution cancellation, which §6.1 has no vocabulary for.
//! - synthetic-result ordering: skipped synthetics appear in the transcript
//!   AFTER all real results of the batch, in original call order; the steer
//!   user message follows them; the next provider request sees all of it.
//! - skipped calls emit ToolExecutionStart/End (is_error=true) mirroring the
//!   §6.4 blocked-call contract, so the UI can render them.
//! - abort (§12) ends the run with NO synthetic results for unexecuted
//!   calls: there is no next provider request to need them; the queues are
//!   surfaced to the TUI instead (§6.1).
//!
//! Verify: `cargo run -- steer-mid-stream|steer-mid-tools|steer-parallel-tools|followup|abort-keeps-queue|all`
//! (exit 0 each).

use serde_json::{json, Value};
use std::collections::VecDeque;

// ---- smith/ shared types (miniature, mirroring SPEC §5.2–§5.4) ----

#[derive(Debug, Clone, PartialEq)]
enum StopReason {
    EndTurn,
    ToolUse,
}

#[derive(Debug, Clone)]
enum ProviderEvent {
    TextDelta(String),
    ToolCall { id: String, name: String, args: Value },
    Done { stop: StopReason },
}

#[derive(Debug, Clone)]
struct Message {
    role: &'static str,
    content: String,
}

#[derive(Debug, Clone)]
struct ProviderRequest {
    messages: Vec<Message>,
}

/// SPEC §5.4: input ProviderRequest, output stream of ProviderEvent.
type StreamFn = Box<dyn FnMut(&ProviderRequest) -> Vec<ProviderEvent>>;

// ---- smith-core/ agent events (miniature, SPEC §6.2 + steering) ----

#[derive(Debug, Clone, PartialEq)]
enum AgentEvent {
    AgentStart,
    TurnStart(u32),
    MessageStart,
    TextDelta(String),
    MessageEnd,
    ToolExecutionStart { id: String, name: String },
    ToolExecutionEnd { id: String, output: String, is_error: bool },
    /// A queued steer delivered as a user message (safe boundary reached).
    SteerDelivered(String),
    /// A queued follow-up delivered instead of `agent_end`.
    FollowupDelivered(String),
    /// §12: a delivered abort ends the run.
    RunAborted,
    TurnEnd(u32),
    AgentEnd,
}

// ---- input scripting: deterministic arrival points ----

#[derive(Debug, Clone, Copy, PartialEq)]
enum InputKind {
    Steer,
    Followup,
}

/// Deterministic simulation points at which external input can arrive.
#[derive(Debug, Clone, PartialEq)]
enum Point {
    /// Queued before the run starts (already-buffered input).
    BeforeRun,
    /// Arrives while the provider stream of `turn` is mid-flight, right
    /// after the stream event with this index was processed.
    DuringStream { turn: u32, after_event: usize },
    /// Arrives while tool `id` is executing — becomes visible at the moment
    /// that call completes (the earliest boundary at which the loop can
    /// observe it, in both sequential and parallel mode).
    WhileToolRuns { id: String },
}

struct Arrival {
    at: Point,
    kind: InputKind,
    text: &'static str,
}

/// SPEC §5.3 ToolExecutionMode, miniature. Parallel carries the simulated
/// deterministic completion order of in-flight calls.
#[derive(Debug, Clone, PartialEq)]
enum ExecMode {
    Sequential,
    Parallel { window: usize, completion_order: Vec<&'static str> },
}

/// Session entry recorded at DELIVERY time only (§6.1: "queued messages
/// become session entries when delivered, never when queued").
#[derive(Debug, Clone)]
struct Entry {
    tick: u64,
    kind: &'static str, // user | assistant | tool_result | steer | followup
    text: String,
}

struct RunResult {
    events: Vec<AgentEvent>,
    messages: Vec<Message>,
    entries: Vec<Entry>,
    steer_queue: Vec<String>,
    followup_queue: Vec<String>,
    /// (text, tick at which the input ARRIVED — i.e. was queued).
    arrival_ticks: Vec<(String, u64)>,
}

fn fire_arrivals(
    point: &Point,
    arrivals: &mut Vec<Arrival>,
    steer_q: &mut VecDeque<String>,
    followup_q: &mut VecDeque<String>,
    arrival_ticks: &mut Vec<(String, u64)>,
    tick: u64,
) {
    let mut i = 0;
    while i < arrivals.len() {
        if arrivals[i].at == *point {
            let a = arrivals.remove(i);
            arrival_ticks.push((a.text.to_string(), tick));
            match a.kind {
                InputKind::Steer => steer_q.push_back(a.text.to_string()),
                InputKind::Followup => followup_q.push_back(a.text.to_string()),
            }
        } else {
            i += 1;
        }
    }
}

fn abort_fires(point: &Point, abort_at: &mut Option<Point>) -> bool {
    if abort_at.as_ref() == Some(point) {
        *abort_at = None;
        true
    } else {
        false
    }
}

/// Mock tool: every call succeeds deterministically.
fn execute_tool(_name: &str, id: &str, _args: &Value) -> String {
    format!("done:{id}")
}

/// Pending not-yet-executed calls resolve as synthetic error results, in
/// ORIGINAL call order, after all real results of the batch (§6.1 rule
/// under test). Mirrors the §6.4 blocked-call contract: Start/End events
/// still emitted so the UI can show the skip.
#[allow(clippy::too_many_arguments)]
fn skip_pending(
    pending: &mut VecDeque<(String, String, Value)>,
    events: &mut Vec<AgentEvent>,
    messages: &mut Vec<Message>,
    entries: &mut Vec<Entry>,
    tick: &mut u64,
) {
    while let Some((id, name, _args)) = pending.pop_front() {
        *tick += 1;
        events.push(AgentEvent::ToolExecutionStart { id: id.clone(), name });
        events.push(AgentEvent::ToolExecutionEnd {
            id: id.clone(),
            output: "skipped: user steered".into(),
            is_error: true,
        });
        messages.push(Message { role: "tool", content: format!("{id}:skipped: user steered") });
        entries.push(Entry { tick: *tick, kind: "tool_result", text: format!("{id}:skipped: user steered") });
    }
}

/// Miniature agent loop per SPEC §6.1: outer loop = turns + follow-ups,
/// inner loop = provider streaming, tool calls, steering.
fn agent_loop(
    mut stream: StreamFn,
    mode: ExecMode,
    mut arrivals: Vec<Arrival>,
    mut abort_at: Option<Point>,
    user_prompt: &str,
) -> RunResult {
    let mut events = vec![AgentEvent::AgentStart];
    let mut messages = vec![Message { role: "user", content: user_prompt.into() }];
    let mut entries: Vec<Entry> = Vec::new();
    let mut steer_q: VecDeque<String> = VecDeque::new();
    let mut followup_q: VecDeque<String> = VecDeque::new();
    let mut arrival_ticks: Vec<(String, u64)> = Vec::new();
    let mut tick: u64 = 0;
    let mut aborted = false;

    entries.push(Entry { tick, kind: "user", text: user_prompt.into() });
    fire_arrivals(&Point::BeforeRun, &mut arrivals, &mut steer_q, &mut followup_q, &mut arrival_ticks, tick);

    let mut turn = 0u32;
    'outer: loop {
        turn += 1;
        if turn > 50 {
            break; // max_turns_per_user_message guard (§6.1)
        }
        events.push(AgentEvent::TurnStart(turn));
        events.push(AgentEvent::MessageStart);
        let req = ProviderRequest { messages: messages.clone() };
        let mut pending: VecDeque<(String, String, Value)> = VecDeque::new();
        let mut stop = StopReason::EndTurn;
        let mut text = String::new();
        // The stream is NOT interrupted by a steer: §6.1 delivers at the
        // next safe boundary, which is stream end at the earliest.
        for (i, ev) in stream(&req).into_iter().enumerate() {
            tick += 1;
            match ev {
                ProviderEvent::TextDelta(t) => {
                    text.push_str(&t);
                    events.push(AgentEvent::TextDelta(t));
                }
                ProviderEvent::ToolCall { id, name, args } => pending.push_back((id, name, args)),
                ProviderEvent::Done { stop: s } => stop = s,
            }
            let p = Point::DuringStream { turn, after_event: i };
            fire_arrivals(&p, &mut arrivals, &mut steer_q, &mut followup_q, &mut arrival_ticks, tick);
            if abort_fires(&p, &mut abort_at) {
                aborted = true;
            }
        }
        events.push(AgentEvent::MessageEnd);
        tick += 1;
        messages.push(Message { role: "assistant", content: text.clone() });
        entries.push(Entry { tick, kind: "assistant", text });

        if aborted {
            events.push(AgentEvent::RunAborted);
            break 'outer;
        }

        // ---- tool phase ----
        if !pending.is_empty() {
            if !steer_q.is_empty() {
                // Steer arrived mid-stream: delivered after stream end. No
                // call of this assistant message has started; all are
                // "pending not-yet-executed" and resolve skipped (§6.1).
                skip_pending(&mut pending, &mut events, &mut messages, &mut entries, &mut tick);
            } else {
                let window = match &mode {
                    ExecMode::Sequential => 1,
                    ExecMode::Parallel { window, .. } => *window,
                };
                let order: Vec<&'static str> = match &mode {
                    ExecMode::Sequential => Vec::new(),
                    ExecMode::Parallel { completion_order, .. } => completion_order.clone(),
                };
                let mut in_flight: Vec<(String, String, Value)> = Vec::new();
                while in_flight.len() < window && !pending.is_empty() {
                    let c = pending.pop_front().unwrap();
                    tick += 1;
                    events.push(AgentEvent::ToolExecutionStart { id: c.0.clone(), name: c.1.clone() });
                    in_flight.push(c);
                }
                while !in_flight.is_empty() {
                    // Deterministic simulated completion: next scripted id
                    // that is in flight, else FIFO.
                    let idx = order
                        .iter()
                        .find_map(|oid| in_flight.iter().position(|c| c.0 == *oid))
                        .unwrap_or(0);
                    let (id, name, args) = in_flight.remove(idx);
                    let output = execute_tool(&name, &id, &args);
                    tick += 1;
                    events.push(AgentEvent::ToolExecutionEnd {
                        id: id.clone(),
                        output: output.clone(),
                        is_error: false,
                    });
                    messages.push(Message { role: "tool", content: format!("{id}:{output}") });
                    entries.push(Entry { tick, kind: "tool_result", text: format!("{id}:{output}") });

                    // A tool completion is a safe boundary (§6.1): input that
                    // arrived while this call ran becomes visible now.
                    let p = Point::WhileToolRuns { id: id.clone() };
                    fire_arrivals(&p, &mut arrivals, &mut steer_q, &mut followup_q, &mut arrival_ticks, tick);
                    if abort_fires(&p, &mut abort_at) {
                        // §12/§6.1: delivered abort ends the run NOW. No
                        // synthetic results — there is no next provider
                        // request. Queues stay intact for the TUI.
                        events.push(AgentEvent::RunAborted);
                        break 'outer;
                    }
                    if steer_q.is_empty() {
                        // No steer visible: keep the window full.
                        while in_flight.len() < window && !pending.is_empty() {
                            let c = pending.pop_front().unwrap();
                            tick += 1;
                            events.push(AgentEvent::ToolExecutionStart { id: c.0.clone(), name: c.1.clone() });
                            in_flight.push(c);
                        }
                    }
                    // Steer visible: WAIT-FOR-ALL-IN-FLIGHT rule — calls that
                    // already started keep draining (loop continues), but no
                    // new call starts.
                }
                if !steer_q.is_empty() && !pending.is_empty() {
                    skip_pending(&mut pending, &mut events, &mut messages, &mut entries, &mut tick);
                }
            }
        }
        events.push(AgentEvent::TurnEnd(turn));

        // ---- boundary delivery: steers drain FIFO before next provider call ----
        if !steer_q.is_empty() {
            while let Some(s) = steer_q.pop_front() {
                tick += 1;
                events.push(AgentEvent::SteerDelivered(s.clone()));
                messages.push(Message { role: "user", content: s.clone() });
                // Session entry written at DELIVERY time only (§6.1).
                entries.push(Entry { tick, kind: "steer", text: s });
            }
            continue 'outer;
        }
        if stop == StopReason::ToolUse {
            continue 'outer;
        }
        // Run would otherwise end: follow-up dequeues instead of agent_end.
        if let Some(f) = followup_q.pop_front() {
            tick += 1;
            events.push(AgentEvent::FollowupDelivered(f.clone()));
            messages.push(Message { role: "user", content: f.clone() });
            entries.push(Entry { tick, kind: "followup", text: f });
            continue 'outer;
        }
        break 'outer;
    }
    events.push(AgentEvent::AgentEnd);

    RunResult {
        events,
        messages,
        entries,
        steer_queue: steer_q.into_iter().collect(),
        followup_queue: followup_q.into_iter().collect(),
        arrival_ticks,
    }
}

// ---- scripted mock streams ----

/// Turn 1: one text delta + `n_calls` tool calls, stop=ToolUse.
/// Turn 2+: echoes what the request transcript proves — how many tool
/// results it can see and whether the last message is a user message
/// (the delivered steer), then stops.
fn script_batch(first_text: &'static str, n_calls: usize) -> StreamFn {
    let mut call = 0usize;
    Box::new(move |req| {
        call += 1;
        if call == 1 {
            let mut evs = vec![ProviderEvent::TextDelta(first_text.into())];
            for i in 1..=n_calls {
                evs.push(ProviderEvent::ToolCall {
                    id: format!("t{i}"),
                    name: "work".into(),
                    args: json!({}),
                });
            }
            evs.push(ProviderEvent::Done { stop: StopReason::ToolUse });
            evs
        } else {
            let results = req.messages.iter().filter(|m| m.role == "tool").count();
            let steer_last = req.messages.last().map(|m| m.role == "user").unwrap_or(false);
            vec![
                ProviderEvent::TextDelta(format!("resumed: results={results} steer_last={steer_last}")),
                ProviderEvent::Done { stop: StopReason::EndTurn },
            ]
        }
    })
}

/// Every turn: text answer quoting the last user message, stop=EndTurn.
/// Proves each follow-up was delivered as a fresh user message.
fn script_turns() -> StreamFn {
    let mut call = 0usize;
    Box::new(move |req| {
        call += 1;
        let last_user = req
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        vec![
            ProviderEvent::TextDelta(format!("turn{call} answer to '{last_user}'")),
            ProviderEvent::Done { stop: StopReason::EndTurn },
        ]
    })
}

// ---- assertions (p07 style) ----

fn expect(label: &str, got: &[AgentEvent], want: &[AgentEvent]) -> bool {
    let ok = got == want;
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        println!("  want: {want:?}");
        println!("  got:  {got:?}");
    }
    ok
}

fn check(label: &str, ok: bool) -> bool {
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    ok
}

fn dump(events: &[AgentEvent]) {
    println!("  exact sequence:");
    for e in events {
        println!("    {e:?}");
    }
}

fn tool_msgs(msgs: &[Message]) -> Vec<String> {
    msgs.iter().filter(|m| m.role == "tool").map(|m| m.content.clone()).collect()
}

/// §6.1 delivery-time-only recording: the steer's session entry exists
/// exactly once and was written strictly AFTER the input arrived (queued).
fn check_delivery_time_entry(r: &RunResult, kind: &str, text: &str) -> bool {
    let arrival = r.arrival_ticks.iter().find(|(t, _)| t == text).map(|(_, tk)| *tk);
    let entry_ticks: Vec<u64> =
        r.entries.iter().filter(|e| e.kind == kind && e.text == text).map(|e| e.tick).collect();
    let one_entry = entry_ticks.len() == 1;
    let after_arrival = match (arrival, entry_ticks.first()) {
        (Some(a), Some(d)) => *d > a,
        _ => false,
    };
    check(
        &format!("entry for '{text}' recorded once, at delivery tick (> arrival tick)"),
        one_entry && after_arrival,
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let scenarios: Vec<&str> = if scenario == "all" {
        vec!["steer-mid-stream", "steer-mid-tools", "steer-parallel-tools", "followup", "abort-keeps-queue"]
    } else {
        vec![scenario.as_str()]
    };

    let mut all_ok = true;
    for s in &scenarios {
        println!("== scenario {s} ==");
        all_ok &= run_scenario(s);
        println!();
    }

    if all_ok {
        println!("p14 RESULT: scenario '{scenario}' holds");
        Ok(())
    } else {
        Err(format!("p14 RESULT: scenario '{scenario}' failed").into())
    }
}

fn run_scenario(name: &str) -> bool {
    use AgentEvent::*;
    let skip = |i: u32| -> [AgentEvent; 2] {
        [
            ToolExecutionStart { id: format!("t{i}"), name: "work".into() },
            ToolExecutionEnd { id: format!("t{i}"), output: "skipped: user steered".into(), is_error: true },
        ]
    };
    let real_end = |i: u32| ToolExecutionEnd {
        id: format!("t{i}"),
        output: format!("done:t{i}"),
        is_error: false,
    };
    let start = |i: u32| ToolExecutionStart { id: format!("t{i}"), name: "work".into() };

    match name {
        // Steer arrives while the assistant message streams: delivered after
        // stream end; ALL tool calls of that message are pending → skipped.
        "steer-mid-stream" => {
            let arrivals = vec![Arrival {
                at: Point::DuringStream { turn: 1, after_event: 0 },
                kind: InputKind::Steer,
                text: "change of plan",
            }];
            let r = agent_loop(script_batch("planning", 2), ExecMode::Sequential, arrivals, None, "go");
            let mut want = vec![AgentStart, TurnStart(1), MessageStart, TextDelta("planning".into()), MessageEnd];
            want.extend(skip(1));
            want.extend(skip(2));
            want.extend([
                TurnEnd(1),
                SteerDelivered("change of plan".into()),
                TurnStart(2),
                MessageStart,
                TextDelta("resumed: results=2 steer_last=true".into()),
                MessageEnd,
                TurnEnd(2),
                AgentEnd,
            ]);
            let seq = expect("steer-mid-stream: steer delivered after stream end; both calls skipped", &r.events, &want);
            dump(&r.events);
            let order = check(
                "transcript: skipped synthetics in original call order, steer user message after them",
                tool_msgs(&r.messages)
                    == vec!["t1:skipped: user steered".to_string(), "t2:skipped: user steered".to_string()]
                    && r.messages.iter().position(|m| m.content == "change of plan")
                        > r.messages.iter().rposition(|m| m.role == "tool"),
            );
            let seen = check(
                "next provider request sees 2 results + steer as latest user message",
                r.events.iter().any(|e| matches!(e, TextDelta(t) if t == "resumed: results=2 steer_last=true")),
            );
            let entry = check_delivery_time_entry(&r, "steer", "change of plan");
            seq && order && seen && entry
        }

        // 6-call sequential batch; steer arrives while call 3 executes:
        // calls 1–3 real, 4–6 skipped, steer next, before provider call.
        "steer-mid-tools" => {
            let arrivals = vec![Arrival {
                at: Point::WhileToolRuns { id: "t3".into() },
                kind: InputKind::Steer,
                text: "stop drilling",
            }];
            let r = agent_loop(script_batch("running batch", 6), ExecMode::Sequential, arrivals, None, "go");
            let mut want = vec![AgentStart, TurnStart(1), MessageStart, TextDelta("running batch".into()), MessageEnd];
            for i in 1..=3 {
                want.push(start(i));
                want.push(real_end(i));
            }
            for i in 4..=6 {
                want.extend(skip(i));
            }
            want.extend([
                TurnEnd(1),
                SteerDelivered("stop drilling".into()),
                TurnStart(2),
                MessageStart,
                TextDelta("resumed: results=6 steer_last=true".into()),
                MessageEnd,
                TurnEnd(2),
                AgentEnd,
            ]);
            let seq = expect(
                "steer-mid-tools: current tool (t3) completes, t4–t6 skipped, steer precedes next provider request",
                &r.events,
                &want,
            );
            dump(&r.events);
            let order = check(
                "transcript: real results t1–t3 then skipped t4–t6 in original order, steer after",
                tool_msgs(&r.messages)
                    == vec![
                        "t1:done:t1".to_string(),
                        "t2:done:t2".to_string(),
                        "t3:done:t3".to_string(),
                        "t4:skipped: user steered".to_string(),
                        "t5:skipped: user steered".to_string(),
                        "t6:skipped: user steered".to_string(),
                    ],
            );
            let seen = check(
                "next provider request sees all 6 results + steer last",
                r.events.iter().any(|e| matches!(e, TextDelta(t) if t == "resumed: results=6 steer_last=true")),
            );
            let entry = check_delivery_time_entry(&r, "steer", "stop drilling");
            seq && order && seen && entry
        }

        // 5-call batch, parallel window 3: t1–t3 in flight concurrently
        // (simulated completion order t2,t1,t3); steer arrives while t2
        // executes. WAIT-FOR-ALL-IN-FLIGHT: t1,t3 still complete (real);
        // t4,t5 never start → skipped; steer after.
        "steer-parallel-tools" => {
            let arrivals = vec![Arrival {
                at: Point::WhileToolRuns { id: "t2".into() },
                kind: InputKind::Steer,
                text: "new priority",
            }];
            let mode = ExecMode::Parallel { window: 3, completion_order: vec!["t2", "t1", "t3"] };
            let r = agent_loop(script_batch("running parallel batch", 5), mode, arrivals, None, "go");
            let mut want = vec![
                AgentStart,
                TurnStart(1),
                MessageStart,
                TextDelta("running parallel batch".into()),
                MessageEnd,
                start(1),
                start(2),
                start(3),
                real_end(2),
                real_end(1),
                real_end(3),
            ];
            want.extend(skip(4));
            want.extend(skip(5));
            want.extend([
                TurnEnd(1),
                SteerDelivered("new priority".into()),
                TurnStart(2),
                MessageStart,
                TextDelta("resumed: results=5 steer_last=true".into()),
                MessageEnd,
                TurnEnd(2),
                AgentEnd,
            ]);
            let seq = expect(
                "steer-parallel-tools: all in-flight (t1,t2,t3) finish, t4/t5 never start and skip",
                &r.events,
                &want,
            );
            dump(&r.events);
            let order = check(
                "transcript: real results in completion order (t2,t1,t3), skipped t4,t5 in original order, steer after",
                tool_msgs(&r.messages)
                    == vec![
                        "t2:done:t2".to_string(),
                        "t1:done:t1".to_string(),
                        "t3:done:t3".to_string(),
                        "t4:skipped: user steered".to_string(),
                        "t5:skipped: user steered".to_string(),
                    ],
            );
            let seen = check(
                "next provider request sees all 5 results + steer last",
                r.events.iter().any(|e| matches!(e, TextDelta(t) if t == "resumed: results=5 steer_last=true")),
            );
            let entry = check_delivery_time_entry(&r, "steer", "new priority");
            println!("REPORT parallel boundary ambiguity (§6.1 x §5.3):");
            println!("  steer became visible when t2 completed while t1,t3 were still in flight.");
            println!("  first-completion rule: deliver at t2's completion — t1/t3 are neither");
            println!("  'currently executing' (finished) nor 'pending not-yet-executed' (started);");
            println!("  their results would land AFTER the steer user message or require");
            println!("  mid-execution cancellation. Ill-defined under §6.1's vocabulary.");
            println!("  wait-for-all-in-flight rule (implemented): every started call runs to");
            println!("  completion, no new call starts once a steer is queued, never-started");
            println!("  calls resolve skipped. This is the rule §6.1 should pin.");
            seq && order && seen && entry
        }

        // Two follow-ups queued before the run: each consumed at run-end
        // instead of agent_end, FIFO, delivered as fresh user messages.
        "followup" => {
            let arrivals = vec![
                Arrival { at: Point::BeforeRun, kind: InputKind::Followup, text: "first follow-up" },
                Arrival { at: Point::BeforeRun, kind: InputKind::Followup, text: "second follow-up" },
            ];
            let r = agent_loop(script_turns(), ExecMode::Sequential, arrivals, None, "go");
            let want = vec![
                AgentStart,
                TurnStart(1),
                MessageStart,
                TextDelta("turn1 answer to 'go'".into()),
                MessageEnd,
                TurnEnd(1),
                FollowupDelivered("first follow-up".into()),
                TurnStart(2),
                MessageStart,
                TextDelta("turn2 answer to 'first follow-up'".into()),
                MessageEnd,
                TurnEnd(2),
                FollowupDelivered("second follow-up".into()),
                TurnStart(3),
                MessageStart,
                TextDelta("turn3 answer to 'second follow-up'".into()),
                MessageEnd,
                TurnEnd(3),
                AgentEnd,
            ];
            let seq = expect("followup: dequeued instead of agent_end, one per run-end, FIFO", &r.events, &want);
            dump(&r.events);
            let fifo = {
                let ticks: Vec<u64> =
                    r.entries.iter().filter(|e| e.kind == "followup").map(|e| e.tick).collect();
                check("followup entries FIFO by delivery tick", ticks.len() == 2 && ticks[0] < ticks[1])
            };
            let e1 = check_delivery_time_entry(&r, "followup", "first follow-up");
            let e2 = check_delivery_time_entry(&r, "followup", "second follow-up");
            let drained = check("both queues empty at agent_end", r.steer_queue.is_empty() && r.followup_queue.is_empty());
            seq && fifo && e1 && e2 && drained
        }

        // Abort delivered mid-batch (while t2 of 4 runs, with a steer and a
        // follow-up queued at the same point): run ends immediately after
        // the current tool; queues stay intact; nothing queued was recorded.
        "abort-keeps-queue" => {
            let arrivals = vec![
                Arrival { at: Point::WhileToolRuns { id: "t2".into() }, kind: InputKind::Steer, text: "queued steer" },
                Arrival {
                    at: Point::WhileToolRuns { id: "t2".into() },
                    kind: InputKind::Followup,
                    text: "queued follow-up",
                },
            ];
            let abort_at = Some(Point::WhileToolRuns { id: "t2".into() });
            let r = agent_loop(script_batch("running batch", 4), ExecMode::Sequential, arrivals, abort_at, "go");
            let want = vec![
                AgentStart,
                TurnStart(1),
                MessageStart,
                TextDelta("running batch".into()),
                MessageEnd,
                start(1),
                real_end(1),
                start(2),
                real_end(2),
                RunAborted,
                AgentEnd,
            ];
            let seq = expect("abort-keeps-queue: run ends after current tool (t2); t3/t4 never resolve", &r.events, &want);
            dump(&r.events);
            let queues = check(
                "queue snapshot intact after abort",
                r.steer_queue == vec!["queued steer".to_string()]
                    && r.followup_queue == vec!["queued follow-up".to_string()],
            );
            println!("REPORT queue snapshot at abort:");
            println!("  steer_queue    = {:?}", r.steer_queue);
            println!("  followup_queue = {:?}", r.followup_queue);
            let no_entries = check(
                "no session entry for queued-but-undelivered messages (delivery-time-only recording)",
                !r.entries.iter().any(|e| e.kind == "steer" || e.kind == "followup"),
            );
            let no_synth = check(
                "no synthetic results after abort (no next provider request to feed)",
                tool_msgs(&r.messages) == vec!["t1:done:t1".to_string(), "t2:done:t2".to_string()],
            );
            seq && queues && no_entries && no_synth
        }

        other => {
            println!("unknown scenario {other}");
            false
        }
    }
}
