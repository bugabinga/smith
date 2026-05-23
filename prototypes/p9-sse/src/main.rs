//! Prototype: SSE parser.
#![allow(dead_code)]

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ChatChunk { choices: Vec<ChunkChoice> }
#[derive(Debug, Deserialize)]
struct ChunkChoice { delta: Delta, finish_reason: Option<String> }
#[derive(Debug, Deserialize)]
struct Delta { content: Option<String> }

fn parse_sse(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut etype = String::from("message");
    let mut buf = String::new();
    for line in text.lines() {
        let l = line.trim();
        if let Some(e) = l.strip_prefix("event:") { etype = e.trim().to_string(); }
        else if let Some(d) = l.strip_prefix("data:") {
            let d = d.trim();
            if d.is_empty() {
                if !buf.is_empty() { out.push((etype.clone(), Some(std::mem::take(&mut buf)))); }
            } else {
                if !buf.is_empty() { buf.push('\n'); }
                buf.push_str(d);
            }
        } else if l.is_empty() {
            if !buf.is_empty() { out.push((etype.clone(), Some(std::mem::take(&mut buf)))); }
        }
    }
    if !buf.is_empty() { out.push((etype, Some(buf))); }
    out
}

fn main() {
    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let events = parse_sse(sse);
    let mut full = String::new();
    for (_, data) in &events {
        let d = data.as_deref().unwrap_or("");
        if d == "[DONE]" { continue; }
        if let Ok(chunk) = serde_json::from_str::<ChatChunk>(d) {
            for c in &chunk.choices {
                if let Some(ref content) = c.delta.content { full.push_str(content); }
            }
        }
    }
    assert_eq!(full, "Hello world");
    eprintln!("SSE parse OK");

    let done = parse_sse("data: [DONE]\n\n");
    assert_eq!(done.len(), 1);
    eprintln!("SSE [DONE] OK");

    let multi = parse_sse("data: line1\ndata: line2\n\n");
    assert_eq!(multi[0].1.as_deref(), Some("line1\nline2"));
    eprintln!("SSE multi-line OK");
}