//! p24-rpc-surface-projection
//!
//! Tests docs/SPEC.md §10.2's deferral note: the `smith rpc` JSON-RPC method
//! catalog "is expected to mirror the Lua SDK surface (§9.10), with
//! mode-specific additions and omissions, rather than define an independent
//! API." The suspected finding under test: the catalog is
//! MIRROR-minus-callbacks-plus-driver-methods, and every §9.10 function that
//! takes a Lua callback (`tool.register`'s `execute`, `on`-event handlers,
//! command handlers) cannot serialize across a stdio boundary as data — it
//! needs BIDIRECTIONAL JSON-RPC where the server calls back into the client.
//!
//! Transport model. JSON-RPC 2.0, LINE-DELIMITED JSON framing (one object per
//! `\n`-terminated line). This is the deliberate framing choice: it is the
//! simplest thing that matches `smith rpc`'s stdio (server reads its stdin,
//! writes stdout; client mirrors). `Content-Length:`-prefixed framing (the
//! LSP style) is the documented alternative — it removes the "no embedded
//! newline" constraint at the cost of a header parse; nothing here depends on
//! the choice. No async runtime: the two directions are two `std::sync::mpsc`
//! channels of framed lines, and each peer is a real thread demuxing its
//! inbox. Threads (not tokio) give genuine bidirectional concurrency while
//! keeping the scenarios scripted and deterministic.
//!
//! Verify: `cargo run -- <scenario>` for scenario in
//! data-method|command-method|event-notification|register-tool-callback|classify|all
//! (exit 0 each).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

// ---------------------------------------------------------------------------
// Minimal bidirectional JSON-RPC 2.0 peer.
//
// One `Endpoint` per side. Both sides can originate REQUESTs (id + method) and
// answer with RESPONSEs (id + result|error); either side may send
// NOTIFICATIONs (method, no id). A dedicated reader thread demultiplexes the
// inbox into: inbound requests (dispatched to a handler on a worker thread so a
// handler is free to originate its own nested request), inbound notifications
// (handed to a sink), and inbound responses (routed to the waiting caller by
// id). This is exactly what makes a server->client callback possible.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RpcError {
    code: i64,
    message: String,
}

type Handler = Arc<dyn Fn(&Arc<Endpoint>, &str, Value) -> Result<Value, RpcError> + Send + Sync>;
type NotifySink = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct Endpoint {
    out: Mutex<Sender<String>>, // outbound framed lines (this peer's "stdout")
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Result<Value, RpcError>>>>,
}

impl Endpoint {
    fn new(out: Sender<String>) -> Arc<Self> {
        Arc::new(Endpoint {
            out: Mutex::new(out),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Spawn the reader thread. `inbound` is this peer's "stdin".
    fn start(self: &Arc<Self>, inbound: Receiver<String>, handler: Handler, notify: NotifySink) {
        let ep = self.clone();
        thread::spawn(move || {
            for line in inbound {
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if msg.get("method").is_some() {
                    let method = msg["method"].as_str().unwrap_or("").to_string();
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    match msg.get("id").and_then(Value::as_u64) {
                        // inbound REQUEST -> dispatch on a worker so the handler
                        // may itself originate a nested request without stalling
                        // this reader (the reader must stay free to route the
                        // nested response).
                        Some(id) => {
                            let ep2 = ep.clone();
                            let h = handler.clone();
                            thread::spawn(move || {
                                let res = h(&ep2, &method, params);
                                ep2.send_response(id, res);
                            });
                        }
                        // inbound NOTIFICATION (no id).
                        None => notify(&method, params),
                    }
                } else if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                    // inbound RESPONSE -> wake the waiting caller.
                    let res = match msg.get("error") {
                        Some(err) => Err(RpcError {
                            code: err.get("code").and_then(Value::as_i64).unwrap_or(-1),
                            message: err
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                        }),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(tx) = ep.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(res);
                    }
                }
            }
        });
    }

    /// Originate a request and block for its response (correlated by id).
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.send(req);
        rx.recv().unwrap_or(Err(RpcError {
            code: -32000,
            message: "transport closed".into(),
        }))
    }

    /// Server->client (or client->server) NOTIFICATION: no id, no reply.
    fn notify(&self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn send_response(&self, id: u64, res: Result<Value, RpcError>) {
        let msg = match res {
            Ok(v) => json!({"jsonrpc": "2.0", "id": id, "result": v}),
            Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": e.code, "message": e.message}}),
        };
        self.send(msg);
    }

    fn send(&self, v: Value) {
        // One line per message (line-delimited framing).
        let _ = self.out.lock().unwrap().send(v.to_string());
    }
}

// ---------------------------------------------------------------------------
// Mock engine (server side): a tiny session, a command registry, an event
// emitter gated by subscriptions, and a registry of CLIENT-provided tools.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Engine {
    subscribers: Vec<String>,  // event types the client asked to receive
    client_tools: Vec<String>, // tools registered by the client (callback-backed)
}

/// Emit a core event (§9.8) to the client as a NOTIFICATION, iff subscribed.
fn emit(ep: &Arc<Endpoint>, engine: &Arc<Mutex<Engine>>, event: &str, payload: Value) {
    let subscribed = engine
        .lock()
        .unwrap()
        .subscribers
        .iter()
        .any(|s| s == event || s == "*");
    if subscribed {
        ep.notify(event, payload);
    }
}

/// The scripted agent loop behind `prompt/submit`. If a client tool is
/// registered, the loop "decides" to call it once. Executing it is a
/// server->client REQUEST `tool/execute`; the reply feeds back as the tool
/// result. This is the load-bearing bidirectional step.
fn run_agent_loop(
    ep: &Arc<Endpoint>,
    engine: &Arc<Mutex<Engine>>,
    params: Value,
) -> Result<Value, RpcError> {
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    let tool = engine.lock().unwrap().client_tools.first().cloned();
    let mut transcript = vec![json!({"role": "user", "text": text})];
    let mut tool_output = Value::Null;

    if let Some(tool_name) = tool {
        emit(ep, engine, "tool_execution_start", json!({"id": "call-1", "name": tool_name}));
        // server -> client REQUEST: hand execution to the client's handler.
        let reply = ep.call(
            "tool/execute",
            json!({"name": tool_name, "input": {"text": "ping"}}),
        )?;
        let out = reply
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        tool_output = json!(out);
        emit(
            ep,
            engine,
            "tool_execution_end",
            json!({"id": "call-1", "name": tool_name, "is_error": false, "output": out}),
        );
        transcript.push(json!({"role": "tool", "name": tool_name, "output": out}));
        transcript.push(json!({"role": "assistant", "text": format!("tool said: {out}")}));
    } else {
        transcript.push(json!({"role": "assistant", "text": "no tools registered; done"}));
    }

    let final_text = transcript
        .last()
        .and_then(|m| m.get("text"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({"final_text": final_text, "tool_output": tool_output, "transcript": transcript}))
}

fn server_handler(engine: Arc<Mutex<Engine>>) -> Handler {
    Arc::new(move |ep, method, params| match method {
        // ---- data methods: mirror of §9.10 read/query surfaces ----
        "session/list" => Ok(json!({"sessions": [
            // §6.5 entries: id/name/cwd/leaf/entry_count; a tiny two-session set.
            {"id": "01HSESSMAIN", "name": "main", "cwd": "/home/user/proj",
             "entry_count": 4, "leaf": "e4"},
            {"id": "01HSESSSPIKE", "name": "spike", "cwd": "/home/user/proj",
             "entry_count": 2, "leaf": "e2"}
        ]})),
        "vcs/status" => Ok(json!({
            // §9.13 status shape.
            "modified": ["src/main.rs"], "added": ["README.md"],
            "deleted": [], "renamed": []
        })),

        // ---- command method ----
        "command/run" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            match name {
                "greet" => {
                    let who = params
                        .get("args")
                        .and_then(|a| a.get("who"))
                        .and_then(Value::as_str)
                        .unwrap_or("world");
                    Ok(json!({"output": format!("hello {who}"), "handled": true}))
                }
                // Emits a core event mid-handling to prove out-of-band delivery.
                "noisy" => {
                    emit(
                        ep,
                        &engine,
                        "tool_execution_end",
                        json!({"id": "noisy-1", "name": "noisy", "is_error": false, "output": "tick"}),
                    );
                    Ok(json!({"output": "noise emitted", "handled": true}))
                }
                other => Err(RpcError {
                    code: -32601,
                    message: format!("unknown command {other}"),
                }),
            }
        }

        // ---- driver / lifecycle methods (RPC-only additions) ----
        "session/open" => Ok(json!({"session_id": "01HNEWSESS", "leaf": Value::Null})),
        "session/subscribe" => {
            let mut e = engine.lock().unwrap();
            if let Some(arr) = params.get("events").and_then(Value::as_array) {
                for ev in arr {
                    if let Some(s) = ev.as_str() {
                        e.subscribers.push(s.to_string());
                    }
                }
            }
            Ok(json!({"ok": true}))
        }
        "prompt/submit" => run_agent_loop(ep, &engine, params),

        // ---- callback registration + config ----
        "tool/register" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            engine.lock().unwrap().client_tools.push(name.clone());
            Ok(json!({"ok": true, "registered": name}))
        }
        "config/reload" => Ok(json!({"changed": ["model.default"]})),

        other => Err(RpcError {
            code: -32601,
            message: format!("method not found: {other}"),
        }),
    })
}

// ---------------------------------------------------------------------------
// Mock client: answers server->client `tool/execute` requests and records
// out-of-band notifications.
// ---------------------------------------------------------------------------

type Log = Arc<Mutex<Vec<Value>>>;
type Notes = Arc<Mutex<Vec<(String, Value)>>>;

fn client_handler(invocations: Log) -> Handler {
    Arc::new(move |_ep, method, params| match method {
        "tool/execute" => {
            invocations.lock().unwrap().push(params.clone());
            let text = params
                .get("input")
                .and_then(|i| i.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({"content": [{"type": "text", "text": format!("PONG:{text}")}]}))
        }
        other => Err(RpcError {
            code: -32601,
            message: format!("client exposes no method {other}"),
        }),
    })
}

/// Wire a server and a client over two line-delimited channels; return the
/// client endpoint plus the client's notification log and tool-invocation log.
fn harness() -> (Arc<Endpoint>, Notes, Log) {
    let (c2s_tx, c2s_rx) = channel::<String>(); // client -> server
    let (s2c_tx, s2c_rx) = channel::<String>(); // server -> client

    let server = Endpoint::new(s2c_tx);
    let client = Endpoint::new(c2s_tx);

    let engine = Arc::new(Mutex::new(Engine::default()));
    server.start(
        c2s_rx,
        server_handler(engine),
        Arc::new(|_m, _p| {}), // the server ignores inbound notifications here
    );

    let notes: Notes = Arc::new(Mutex::new(Vec::new()));
    let invocations: Log = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let notes = notes.clone();
        let sink: NotifySink = Arc::new(move |m, p| notes.lock().unwrap().push((m.to_string(), p)));
        sink
    };
    client.start(s2c_rx, client_handler(invocations.clone()), sink);

    (client, notes, invocations)
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

fn check(label: &str, cond: bool) -> bool {
    println!("{} {label}", if cond { "PASS" } else { "FAIL" });
    cond
}

fn scn_data() -> bool {
    let (c, _n, _i) = harness();
    let sess = c.call("session/list", Value::Null).expect("session/list");
    let ok1 = check(
        "data-method: session/list round-trips §6.5 entries (id/leaf/entry_count)",
        sess.get("sessions").and_then(Value::as_array).is_some_and(|a| {
            !a.is_empty()
                && a[0].get("leaf").is_some()
                && a[0].get("entry_count").is_some()
                && a[0].get("id").is_some()
        }),
    );
    let vcs = c.call("vcs/status", Value::Null).expect("vcs/status");
    let ok2 = check(
        "data-method: vcs/status returns §9.13 {modified,added,deleted,renamed}",
        ["modified", "added", "deleted", "renamed"]
            .iter()
            .all(|k| vcs.get(*k).is_some_and(Value::is_array)),
    );
    ok1 && ok2
}

fn scn_command() -> bool {
    let (c, _n, _i) = harness();
    let r = c
        .call("command/run", json!({"name": "greet", "args": {"who": "smith"}}))
        .expect("command/run");
    check(
        "command-method: command/run { name, args } executes and returns its result",
        r.get("output").and_then(Value::as_str) == Some("hello smith")
            && r.get("handled").and_then(Value::as_bool) == Some(true),
    )
}

fn scn_event() -> bool {
    let (c, notes, _i) = harness();
    // Subscribe, then trigger an emit inside an UNRELATED request. On one
    // ordered channel the notification line precedes the command/run response
    // line, so by the time the call returns the client has already recorded it
    // out-of-band (no id) via the notification sink, not as a response.
    c.call("session/subscribe", json!({"events": ["tool_execution_end"]}))
        .expect("subscribe");
    let r = c.call("command/run", json!({"name": "noisy"})).expect("noisy");
    let notes = notes.lock().unwrap();
    let got = notes.iter().any(|(m, _)| m == "tool_execution_end");
    let ok1 = check(
        "event-notification: core event (§9.8) delivered as server->client NOTIFICATION (no id)",
        got,
    );
    let ok2 = check(
        "event-notification: notification arrived out-of-band, distinct from the command/run response",
        got && r.get("output").is_some(),
    );
    ok1 && ok2
}

fn scn_register_tool() -> bool {
    let (c, notes, inv) = harness();
    c.call("session/subscribe", json!({"events": ["tool_execution_start", "tool_execution_end"]}))
        .expect("subscribe");
    c.call("tool/register", json!({"name": "client_echo", "parameters": {"type": "object"}}))
        .expect("tool/register");
    // Driving the loop makes the server issue a server->client REQUEST to run
    // the client's tool; the client's reply feeds back as the tool result.
    let r = c
        .call("prompt/submit", json!({"text": "use client_echo"}))
        .expect("prompt/submit");

    let ok1 = check(
        "register-tool-callback: server issued a server->client tool/execute REQUEST",
        inv.lock().unwrap().len() == 1,
    );
    let ok2 = check(
        "register-tool-callback: client's reply fed back into the loop as the tool result",
        r.get("tool_output").and_then(Value::as_str) == Some("PONG:ping"),
    );
    let notes = notes.lock().unwrap();
    let ok3 = check(
        "register-tool-callback: loop emitted tool_execution_start + _end notifications",
        notes.iter().any(|(m, _)| m == "tool_execution_start")
            && notes.iter().any(|(m, _)| m == "tool_execution_end"),
    );
    ok1 && ok2 && ok3
}

/// Every §9.10 namespace/primitive, one tag each. ADDED is reserved for
/// RPC-only driver methods (printed separately) — by definition no §9.10
/// primitive is ADDED, since ADDED are exactly the surfaces §9.10 lacks.
fn scn_classify() -> bool {
    // (primitive, tag, one-clause justification)
    let rows: &[(&str, &str, &str)] = &[
        ("fs", "MIRRORED", "file read/query/write are request->response data ops"),
        ("search", "MIRRORED", "query in, ranked matches out; pure data"),
        ("env", "MIRRORED", "get/set environment values as data"),
        ("time", "MIRRORED", "clock reads return scalar data"),
        ("log", "MIRRORED", "a log line is a one-way data method (fire-and-forget)"),
        ("tool", "CALLBACK", "register carries an `execute` callback; execution is a server->client tool/execute request"),
        ("command", "CALLBACK", "register carries handler/autocomplete callbacks; invoking is the ADDED command/run driver whose dispatch is server->client"),
        ("provider", "MIRRORED", "register/unregister mutate provider config from a data table, no callback"),
        ("alias", "MIRRORED", "alias definitions are data config mutations"),
        ("group", "MIRRORED", "group definitions are data config mutations"),
        ("bucket", "MIRRORED", "bucket definitions are data config mutations"),
        ("tui", "OMITTED", "in-process ratatui widget/layout registration; a headless RPC peer has no terminal to render into"),
        ("vcs", "MIRRORED", "status/diff are data reads, commit/undo are command methods; all request->response"),
        ("bus", "CALLBACK", "on(topic,handler) subscription: non-blocking events project to notifications, blocking events (§9.8 tool_call/session_before_*) need server->client requests"),
        ("config", "MIRRORED", "config reads plus config/reload (§9.19) are data/command methods"),
        ("secret", "MIRRORED", "register(value,label)/list return ids/labels; plaintext-as-data crosses once, masking is engine-side"),
        ("shortcut", "OMITTED", "keyboard-shortcut registration with a handler; no keyboard in a headless RPC peer"),
        ("active_tools", "MIRRORED", "get/all/set the active tool set as data"),
        ("send_message", "MIRRORED", "inject steer/followUp text; a data method that doubles as a driver action"),
        ("abort", "MIRRORED", "abort the current run; parameterless command method"),
        ("shutdown", "MIRRORED", "shut the engine down; command method"),
        ("getContextUsage", "MIRRORED", "returns token-usage data"),
        // present in §9.10 beyond the task's list, included for completeness:
        ("credentials", "MIRRORED", "get/set over the §7.4 auth store as data (sensitive but serializable)"),
        ("send_user_message", "MIRRORED", "inject a user message; data method / driver action"),
    ];

    println!("-- §9.10 primitive classification (framing: line-delimited JSON) --");
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (name, tag, why) in rows {
        *counts.entry(tag).or_default() += 1;
        println!("  {name:<18} {tag:<9} {why}");
    }
    println!();
    println!(
        "  tally: MIRRORED={} CALLBACK={} OMITTED={} (ADDED=0 among §9.10 primitives, by definition)",
        counts.get("MIRRORED").copied().unwrap_or(0),
        counts.get("CALLBACK").copied().unwrap_or(0),
        counts.get("OMITTED").copied().unwrap_or(0),
    );

    // ADDED driver methods: RPC-only, no §9.10 equivalent. An RPC client drives
    // a whole session with these; Lua never needs them because it already runs
    // INSIDE a live session.
    let added: &[(&str, &str)] = &[
        ("session/open", "start a new session; Lua has no open primitive (it runs inside one)"),
        ("session/attach", "attach to an existing session by id/name"),
        ("session/list", "enumerate sessions; §9.10 exposes only ctx.session (the current one)"),
        ("session/dump", "export entries (CLI `smith session dump`), no SDK equivalent"),
        ("session/fork", "fork a session; §9.10 has only the session_before_fork event"),
        ("session/subscribe", "declare event interest so the engine streams notifications; Lua uses in-process bus.on/event handlers"),
        ("prompt/submit", "submit a user prompt and run a turn; the run-and-stream driver has no §9.10 call"),
        ("command/run", "invoke a registered command; Lua registers, the TUI/user runs"),
    ];
    println!();
    println!("-- ADDED driver methods (RPC-only, no §9.10 equivalent) --");
    for (m, why) in added {
        println!("  {m:<18} {why}");
    }
    println!("  note: config/reload is the ONE method §10.2 names; it MIRRORS smith.config.reload, not ADDED.");
    println!();

    let ok1 = check(
        "classify: 22 task-listed primitives + 2 extra §9.10 (credentials, send_user_message) tagged",
        rows.len() == 24,
    );
    let ok2 = check(
        "classify: callback-taking primitives (tool, command, bus) tagged CALLBACK",
        rows.iter()
            .filter(|(_, t, _)| *t == "CALLBACK")
            .map(|(n, _, _)| *n)
            .collect::<Vec<_>>()
            == vec!["tool", "command", "bus"],
    );
    let ok3 = check(
        "classify: driver methods enumerated as ADDED (session lifecycle + prompt submit)",
        added.iter().any(|(m, _)| *m == "session/open")
            && added.iter().any(|(m, _)| *m == "prompt/submit")
            && added.iter().any(|(m, _)| *m == "session/subscribe"),
    );
    ok1 && ok2 && ok3
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let run = |name: &str| -> bool {
        match name {
            "data-method" => scn_data(),
            "command-method" => scn_command(),
            "event-notification" => scn_event(),
            "register-tool-callback" => scn_register_tool(),
            "classify" => scn_classify(),
            other => {
                println!("unknown scenario {other}");
                false
            }
        }
    };

    let ok = if scenario == "all" {
        let names = [
            "data-method",
            "command-method",
            "event-notification",
            "register-tool-callback",
            "classify",
        ];
        let mut all = true;
        for n in names {
            println!("== {n} ==");
            all &= run(n);
            println!();
        }
        all
    } else {
        run(&scenario)
    };

    println!();
    if ok {
        println!("p24 RESULT: '{scenario}' holds");
        Ok(())
    } else {
        Err(format!("p24 RESULT: '{scenario}' failed").into())
    }
}
