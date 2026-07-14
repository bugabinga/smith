//! p07-streamfn-agent-loop
//!
//! Proves or disproves docs/SPEC.md §5.4 + §6.1–§6.4 claims:
//! - the agent loop drives behavior through `StreamFn` with no provider
//!   implementation dependency,
//! - text/tool/done provider events produce a deterministic `AgentEvent`
//!   sequence,
//! - `BeforeToolCall` hooks can allow/block/replace-args.
//!
//! Determinism is the claim under test, so the mock StreamFn is a scripted
//! iterator; async delivery does not change ordering semantics (noted in the
//! prototype report).
//!
//! Verify: `cargo run -- basic|tool|hook-block|hook-replace` (exit 0 each).

use serde_json::{json, Value};

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
/// The loop below has no knowledge of what implements this.
type StreamFn = Box<dyn FnMut(&ProviderRequest) -> Vec<ProviderEvent>>;

// ---- smith-core/ agent events + hooks (miniature, SPEC §6.2/§6.4) ----

#[derive(Debug, Clone, PartialEq)]
enum AgentEvent {
    AgentStart,
    TurnStart(u32),
    MessageStart,
    TextDelta(String),
    MessageEnd,
    ToolExecutionStart { id: String, name: String },
    ToolExecutionEnd { id: String, output: String, is_error: bool },
    TurnEnd(u32),
    AgentEnd,
}

enum BeforeToolCallResult {
    Allow,
    Block { reason: String },
    ReplaceArgs(Value),
}

type BeforeHook = Box<dyn Fn(&str, &Value) -> BeforeToolCallResult>;

struct ToolRegistry;

impl ToolRegistry {
    /// Mock `echo` tool: returns its args, uppercased text.
    fn execute(&self, name: &str, args: &Value) -> Result<String, String> {
        match name {
            "echo" => {
                let text = args["text"].as_str().unwrap_or_default();
                Ok(text.to_uppercase())
            }
            other => Err(format!("unknown tool {other}")),
        }
    }
}

/// Miniature agent loop: outer loop = turns, inner loop = provider events +
/// tool execution, per SPEC §6.1. Consumes only StreamFn.
fn agent_loop(
    mut stream: StreamFn,
    tools: &ToolRegistry,
    before_hook: &BeforeHook,
    user_prompt: &str,
    max_turns: u32,
) -> (Vec<AgentEvent>, Vec<Message>) {
    let mut events = vec![AgentEvent::AgentStart];
    let mut messages = vec![Message { role: "user", content: user_prompt.into() }];
    let mut turn = 0u32;
    loop {
        turn += 1;
        if turn > max_turns {
            break;
        }
        events.push(AgentEvent::TurnStart(turn));
        events.push(AgentEvent::MessageStart);
        let req = ProviderRequest { messages: messages.clone() };
        let mut pending_tools: Vec<(String, String, Value)> = Vec::new();
        let mut stop = StopReason::EndTurn;
        let mut text = String::new();
        for ev in stream(&req) {
            match ev {
                ProviderEvent::TextDelta(t) => {
                    text.push_str(&t);
                    events.push(AgentEvent::TextDelta(t));
                }
                ProviderEvent::ToolCall { id, name, args } => {
                    pending_tools.push((id, name, args));
                }
                ProviderEvent::Done { stop: s } => stop = s,
            }
        }
        events.push(AgentEvent::MessageEnd);
        messages.push(Message { role: "assistant", content: text });

        for (id, name, mut args) in pending_tools {
            // SPEC §6.4 BeforeToolCallResult: allow, block, replace args.
            match before_hook(&name, &args) {
                BeforeToolCallResult::Allow => {}
                BeforeToolCallResult::ReplaceArgs(new_args) => args = new_args,
                BeforeToolCallResult::Block { reason } => {
                    // Decision under test: a blocked call still emits
                    // ToolExecutionStart/End (is_error=true) and feeds an
                    // error tool result back to the provider. SPEC §6.4 does
                    // not state this; reported as a spec issue.
                    events.push(AgentEvent::ToolExecutionStart { id: id.clone(), name: name.clone() });
                    let output = format!("blocked: {reason}");
                    events.push(AgentEvent::ToolExecutionEnd {
                        id,
                        output: output.clone(),
                        is_error: true,
                    });
                    messages.push(Message { role: "tool", content: output });
                    continue;
                }
            }
            events.push(AgentEvent::ToolExecutionStart { id: id.clone(), name: name.clone() });
            let (output, is_error) = match tools.execute(&name, &args) {
                Ok(o) => (o, false),
                Err(e) => (e, true),
            };
            events.push(AgentEvent::ToolExecutionEnd { id, output: output.clone(), is_error });
            messages.push(Message { role: "tool", content: output });
        }

        events.push(AgentEvent::TurnEnd(turn));
        if stop == StopReason::EndTurn {
            break;
        }
    }
    events.push(AgentEvent::AgentEnd);
    (events, messages)
}

// ---- scripted mock streams ----

fn script_basic() -> StreamFn {
    Box::new(|_req| {
        vec![
            ProviderEvent::TextDelta("hello ".into()),
            ProviderEvent::TextDelta("world".into()),
            ProviderEvent::Done { stop: StopReason::EndTurn },
        ]
    })
}

/// Turn 1: text + tool call, stop=ToolUse. Turn 2: text, stop=EndTurn.
fn script_tool() -> StreamFn {
    let mut call = 0;
    Box::new(move |req| {
        call += 1;
        if call == 1 {
            vec![
                ProviderEvent::TextDelta("using a tool".into()),
                ProviderEvent::ToolCall {
                    id: "t1".into(),
                    name: "echo".into(),
                    args: json!({"text": "ping"}),
                },
                ProviderEvent::Done { stop: StopReason::ToolUse },
            ]
        } else {
            // The tool result must be visible in the second request.
            let saw_result = req.messages.iter().any(|m| m.role == "tool");
            vec![
                ProviderEvent::TextDelta(format!("tool result seen: {saw_result}")),
                ProviderEvent::Done { stop: StopReason::EndTurn },
            ]
        }
    })
}

fn expect(label: &str, got: &[AgentEvent], want: &[AgentEvent]) -> bool {
    let ok = got == want;
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        println!("  want: {want:?}");
        println!("  got:  {got:?}");
    }
    ok
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "basic".into());
    let tools = ToolRegistry;
    let allow: BeforeHook = Box::new(|_, _| BeforeToolCallResult::Allow);
    use AgentEvent::*;

    let ok = match scenario.as_str() {
        "basic" => {
            let (events, _) = agent_loop(script_basic(), &tools, &allow, "hi", 50);
            expect(
                "basic: deterministic text-only sequence",
                &events,
                &[
                    AgentStart,
                    TurnStart(1),
                    MessageStart,
                    TextDelta("hello ".into()),
                    TextDelta("world".into()),
                    MessageEnd,
                    TurnEnd(1),
                    AgentEnd,
                ],
            )
        }
        "tool" => {
            let (events, msgs) = agent_loop(script_tool(), &tools, &allow, "run echo", 50);
            let seq_ok = expect(
                "tool: tool call between turns, result fed back",
                &events,
                &[
                    AgentStart,
                    TurnStart(1),
                    MessageStart,
                    TextDelta("using a tool".into()),
                    MessageEnd,
                    ToolExecutionStart { id: "t1".into(), name: "echo".into() },
                    ToolExecutionEnd { id: "t1".into(), output: "PING".into(), is_error: false },
                    TurnEnd(1),
                    TurnStart(2),
                    MessageStart,
                    TextDelta("tool result seen: true".into()),
                    MessageEnd,
                    TurnEnd(2),
                    AgentEnd,
                ],
            );
            let fed = msgs.iter().any(|m| m.role == "tool" && m.content == "PING");
            println!("{} tool: PING result present in transcript", if fed { "PASS" } else { "FAIL" });
            seq_ok && fed
        }
        "hook-block" => {
            let block: BeforeHook = Box::new(|name, _| BeforeToolCallResult::Block {
                reason: format!("policy denies {name}"),
            });
            let (events, msgs) = agent_loop(script_tool(), &tools, &block, "run echo", 50);
            let has_exec_err = events.iter().any(|e| {
                matches!(e, ToolExecutionEnd { output, is_error: true, .. } if output == "blocked: policy denies echo")
            });
            let never_ran = !msgs.iter().any(|m| m.content == "PING");
            let provider_saw_block = events
                .iter()
                .any(|e| matches!(e, TextDelta(t) if t == "tool result seen: true"));
            println!("{} hook-block: blocked call surfaces as error tool result", if has_exec_err { "PASS" } else { "FAIL" });
            println!("{} hook-block: tool never executed", if never_ran { "PASS" } else { "FAIL" });
            println!("{} hook-block: provider receives block as tool result", if provider_saw_block { "PASS" } else { "FAIL" });
            has_exec_err && never_ran && provider_saw_block
        }
        "hook-replace" => {
            let replace: BeforeHook =
                Box::new(|_, _| BeforeToolCallResult::ReplaceArgs(json!({"text": "replaced"})));
            let (events, _) = agent_loop(script_tool(), &tools, &replace, "run echo", 50);
            let replaced = events.iter().any(|e| {
                matches!(e, ToolExecutionEnd { output, is_error: false, .. } if output == "REPLACED")
            });
            println!("{} hook-replace: tool executed with replaced args", if replaced { "PASS" } else { "FAIL" });
            replaced
        }
        other => {
            println!("unknown scenario {other}");
            false
        }
    };

    println!();
    if ok {
        println!("p07 RESULT: scenario '{scenario}' holds");
        Ok(())
    } else {
        Err(format!("p07 RESULT: scenario '{scenario}' failed").into())
    }
}
