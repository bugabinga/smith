//! Test ciborium as minicbor alternative — serde-based CBOR with enum support.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct ToolCall {
    id: String,
    name: String,
    args: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct ToolResult {
    call_id: String,
    content: String,
    is_error: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
enum SessionEntry {
    User(UserMsg),
    Assistant(AssistantMsg),
    ToolResult(ToolResultEntry),
    System(SystemEntry),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct UserMsg { content: String }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct AssistantMsg { content: String, tool_calls: Vec<ToolCall> }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct ToolResultEntry { result: ToolResult }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct SystemEntry { content: String }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
enum TraceEntry {
    Start(TraceStart),
    Event(TraceEvent),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct TraceStart { session_id: String, timestamp: u64 }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct TraceEvent { timestamp: u64, entry: SessionEntry }

fn main() {
    let entry = SessionEntry::Assistant(AssistantMsg {
        content: "thinking...".into(),
        tool_calls: vec![ToolCall { id: "c1".into(), name: "bash".into(), args: r#"{"cmd":"ls"}"#.into() }],
    });

    let mut buf = Vec::new();
    ciborium::ser::into_writer(&entry, &mut buf).expect("serialize");
    let decoded: SessionEntry = ciborium::de::from_reader(&buf[..]).expect("deserialize");
    eprintln!("CBOR roundtrip OK: {:?} ({} bytes)", decoded, buf.len());
    assert_eq!(entry, decoded);

    // All 4 variants
    let all = vec![
        SessionEntry::User(UserMsg { content: "hi".into() }),
        SessionEntry::System(SystemEntry { content: "init".into() }),
        SessionEntry::ToolResult(ToolResultEntry { result: ToolResult { call_id: "c1".into(), content: "out".into(), is_error: false } }),
        entry,
    ];
    for (i, e) in all.iter().enumerate() {
        let mut b = Vec::new();
        ciborium::ser::into_writer(e, &mut b).unwrap();
        let d: SessionEntry = ciborium::de::from_reader(&b[..]).unwrap();
        assert_eq!(*e, d, "variant {} mismatch", i);
    }
    eprintln!("All 4 CBOR enum variants roundtrip OK");

    // Trace
    let trace = TraceEntry::Event(TraceEvent { timestamp: 1715000000, entry: all[0].clone() });
    let mut tb = Vec::new();
    ciborium::ser::into_writer(&trace, &mut tb).unwrap();
    let td: TraceEntry = ciborium::de::from_reader(&tb[..]).unwrap();
    assert_eq!(trace, td);
    eprintln!("Trace CBOR OK ({} bytes)", tb.len());

    eprintln!("ALL CIBORIUM TESTS PASSED");
}