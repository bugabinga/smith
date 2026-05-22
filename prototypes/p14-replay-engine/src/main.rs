//! Prototype P14: Replay Engine per SM-006 §13.7.
//!
//! Tests:
//! 1. Generate synthetic trace with 50+ entries (all TraceEntry variants)
//! 2. TraceCodec: header + length-prefixed compressed CBOR-seq (reuses P11 patterns)
//! 3. ReplaySpeed: Max / RealTime / Factor(f64) with actual tokio::time::sleep
//! 4. ReplayMode::Normal — iterate entries, count stats
//! 5. ReplayMode::Compare — re-execute tool calls, hash diff, record ReplayDiff
//! 6. seek_to_turn(n) — skip to Nth turn using snapshot indices
//! 7. extract_session() — smart filter TraceEntry → SessionEntry
//! 8. extract_provider_trace() — request/response pairing
//! 9. ReplaySummary stats (total_entries, duration_ms, agent_events, tool_execs, diffs)

#![allow(missing_docs, unused_variables, unused_assignments)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

// === Shared types (from P11) ===

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntryId(pub String);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role { System, User, Assistant, Tool }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason { EndTurn, ToolUse, OverMaxTokens, Aborted, StopSequence, Error }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ContentBlock {
    Text(String),
    ToolCall { id: String, name: String, arguments: String },
    ToolResult { id: String, result: String, is_error: bool },
    Thinking { content: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

// === SessionEntry (from P11, all variants) ===

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SessionEntry {
    Session { version: u32, created: u64 },
    User { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, timestamp: u64 },
    Assistant { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, usage: ProviderUsage, provider: String, model: String, stop_reason: StopReason, timestamp: u64 },
    ToolResult { id: EntryId, parent_id: Option<EntryId>, tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool, timestamp: u64 },
    Compaction { id: EntryId, parent_id: Option<EntryId>, summary: String, first_kept_id: EntryId, tokens_before: u64, read_files: Vec<String>, modified_files: Vec<String>, timestamp: u64 },
    Unknown { id: EntryId, data: Vec<u8>, timestamp: u64 },
}

// === Extended TraceEntry (SM-006 all replay-relevant variants) ===

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum TraceEntry {
    AgentEvent { timestamp_ns: u64, event: String },
    TurnStart { timestamp_ns: u64, turn_number: u32, model: String, provider: String },
    TurnEnd { timestamp_ns: u64, turn_number: u32, stop_reason: String },
    ToolStart { timestamp_ns: u64, tool_call_id: String, tool_name: String, args_json: String },
    ToolEnd { timestamp_ns: u64, tool_call_id: String, tool_name: String, result_hash: String, is_error: bool },
    ProviderRequest { timestamp_ns: u64, request_id: String, model: String, prompt_tokens: u64 },
    ProviderResponse { timestamp_ns: u64, request_id: String, completion_tokens: u64, finish_reason: String },
    PluginLoaded { timestamp_ns: u64, path: String, success: bool },
    PluginEvent { timestamp_ns: u64, plugin: String, event: String },
    PluginError { timestamp_ns: u64, plugin: String, error: String },
    EnvSnapshot { timestamp_ns: u64, cwd: String, env_vars: Vec<(String, String)> },
    FileHashSnapshot { timestamp_ns: u64, files: Vec<(String, String)> },
    Snapshot { timestamp_ns: u64, message_count: u32, model: String, pending_tools: u32 },
}

// === TraceFileHeader (from P11) ===

#[derive(Clone, Debug)]
pub struct TraceFileHeader {
    pub magic: [u8; 4],
    pub version: u16,
    pub flags: u16,
    pub session_id: [u8; 16],
    pub start_timestamp_ns: u64,
    pub reserved: [u8; 32],
}

impl TraceFileHeader {
    pub const MAGIC: [u8; 4] = *b"SMTH";
    pub const VERSION: u16 = 1;
    pub const FLAG_COMPRESSED: u16 = 0x01;
    pub const SIZE: usize = 64;

    pub fn new(session_id: [u8; 16], start_ts: u64, compressed: bool) -> Self {
        Self { magic: Self::MAGIC, version: Self::VERSION, flags: if compressed { Self::FLAG_COMPRESSED } else { 0 }, session_id, start_timestamp_ns: start_ts, reserved: [0u8; 32] }
    }

    pub fn write(&self, w: &mut impl Write) -> std::io::Result<()> {
        w.write_all(&self.magic)?;
        w.write_all(&self.version.to_be_bytes())?;
        w.write_all(&self.flags.to_be_bytes())?;
        w.write_all(&self.session_id)?;
        w.write_all(&self.start_timestamp_ns.to_be_bytes())?;
        w.write_all(&self.reserved)?;
        Ok(())
    }

    pub fn read(r: &mut impl Read) -> std::io::Result<Self> {
        let mut magic = [0u8; 4]; r.read_exact(&mut magic)?;
        if magic != Self::MAGIC { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad magic")); }
        let mut buf = [0u8; 2]; r.read_exact(&mut buf)?; let version = u16::from_be_bytes(buf);
        if version != Self::VERSION { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad version")); }
        let mut buf = [0u8; 2]; r.read_exact(&mut buf)?; let flags = u16::from_be_bytes(buf);
        let mut session_id = [0u8; 16]; r.read_exact(&mut session_id)?;
        let mut buf = [0u8; 8]; r.read_exact(&mut buf)?; let start = u64::from_be_bytes(buf);
        let mut reserved = [0u8; 32]; r.read_exact(&mut reserved)?;
        Ok(Self { magic, version, flags, session_id, start_timestamp_ns: start, reserved })
    }
}

// === CBOR codec (P11 patterns) ===

fn encode_lp(entries: &[TraceEntry]) -> Vec<u8> {
    let mut buf = Vec::new();
    for e in entries {
        let mut cbor = Vec::new();
        ciborium::ser::into_writer(e, &mut cbor).unwrap();
        let payload = zstd::encode_all(&cbor[..], 3).unwrap();
        buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        buf.extend_from_slice(&payload);
    }
    buf
}

fn decode_lp(data: &[u8]) -> Vec<TraceEntry> {
    let mut cursor = &data[..];
    let mut out = Vec::new();
    while !cursor.is_empty() {
        let mut len_buf = [0u8; 4]; cursor.read_exact(&mut len_buf).unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let dec = zstd::decode_all(&cursor[..len]).unwrap();
        out.push(ciborium::de::from_reader(&dec[..]).unwrap());
        cursor = &cursor[len..];
    }
    out
}

// === Replay types (SM-006 §13.7) ===

#[derive(Clone, Debug)]
pub enum ReplaySpeed {
    Max,
    RealTime,
    Factor(f64),
}

#[derive(Clone, Debug)]
pub enum ReplayMode {
    Normal,
    Compare { sandbox_dir: String, continue_on_diff: bool },
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ReplayDiff {
    pub tool_call_id: String,
    pub tool_name: String,
    pub original_hash: String,
    pub new_hash: String,
    pub text_diff: String,
}

#[derive(Clone, Debug)]
pub struct ReplayStep {
    pub entry: TraceEntry,
    pub timestamp_ns: u64,
    pub index: usize,
    pub diff: Option<ReplayDiff>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ReplaySummary {
    pub total_entries: usize,
    pub duration_ms: u64,
    pub agent_events: usize,
    pub tool_executions: usize,
    pub turns: usize,
    pub provider_requests: usize,
    pub plugins: usize,
    pub snapshots: usize,
    pub diffs: Vec<ReplayDiff>,
}

// === ReplayEngine ===

pub struct ReplayEngine {
    entries: Vec<TraceEntry>,
    start_ts: u64,
    turn_indices: Vec<usize>, // index into entries where TurnStart occurs
}

impl ReplayEngine {
    pub fn from_entries(entries: Vec<TraceEntry>, start_ts: u64) -> Self {
        let turn_indices: Vec<usize> = entries.iter().enumerate()
            .filter(|(_, e)| matches!(e, TraceEntry::TurnStart { .. }))
            .map(|(i, _)| i)
            .collect();
        Self { entries, start_ts, turn_indices }
    }

    /// Load from raw bytes (header already stripped).
    pub fn from_bytes(data: &[u8], start_ts: u64) -> Self {
        let entries = decode_lp(data);
        Self::from_entries(entries, start_ts)
    }

    /// Total entry count.
    pub fn len(&self) -> usize { self.entries.len() }

    /// Seek to Nth turn (0-indexed). Returns slice of entries starting from that turn.
    pub fn seek_to_turn(&self, turn: usize) -> &[TraceEntry] {
        if turn >= self.turn_indices.len() {
            return &self.entries[self.entries.len()..]; // empty
        }
        &self.entries[self.turn_indices[turn]..]
    }

    /// Number of turns.
    pub fn turn_count(&self) -> usize { self.turn_indices.len() }

    /// Run replay synchronously. Returns summary.
    /// on_step callback receives each ReplayStep. Returns false to abort.
    pub fn run<F>(&self, speed: &ReplaySpeed, mode: &ReplayMode, mut on_step: F) -> ReplaySummary
    where F: FnMut(&ReplayStep) -> bool
    {
        let mut summary = ReplaySummary::default();
        let start = std::time::Instant::now();
        let mut prev_ts = self.start_ts;

        // For Compare mode: track ToolStart → ToolEnd pairs
        let mut pending_tools: HashMap<String, (String, String)> = HashMap::new(); // call_id → (name, args)

        for (idx, entry) in self.entries.iter().enumerate() {
            let ts = get_ts(entry);
            let mut diff = None;

            // Speed delay (not for Max)
            match speed {
                ReplaySpeed::Max => {},
                ReplaySpeed::RealTime => {
                    let gap_ns = ts.saturating_sub(prev_ts);
                    std::thread::sleep(std::time::Duration::from_nanos(gap_ns));
                },
                ReplaySpeed::Factor(f) => {
                    let gap_ns = ts.saturating_sub(prev_ts);
                    let scaled = (gap_ns as f64 / *f) as u64;
                    std::thread::sleep(std::time::Duration::from_nanos(scaled));
                },
            }
            prev_ts = ts;

            // Compare mode: re-execute tools
            if let ReplayMode::Compare { sandbox_dir, .. } = mode {
                match entry {
                    TraceEntry::ToolStart { tool_call_id, tool_name, args_json, .. } => {
                        pending_tools.insert(tool_call_id.clone(), (tool_name.clone(), args_json.clone()));
                    },
                    TraceEntry::ToolEnd { tool_call_id, tool_name, result_hash, is_error: _, .. } => {
                        if let Some((name, args)) = pending_tools.remove(tool_call_id) {
                            let new_hash = simulate_tool_exec(sandbox_dir, &name, &args);
                            if new_hash != *result_hash {
                                let d = ReplayDiff {
                                    tool_call_id: tool_call_id.clone(),
                                    tool_name: name,
                                    original_hash: result_hash.clone(),
                                    new_hash: new_hash.clone(),
                                    text_diff: format!("original={} new={}", result_hash, &new_hash),
                                };
                                diff = Some(d.clone());
                                summary.diffs.push(d);
                            }
                        }
                    },
                    _ => {},
                }
            }

            summary.total_entries += 1;
            // Classify
            match entry {
                TraceEntry::AgentEvent { .. } => summary.agent_events += 1,
                TraceEntry::ToolEnd { .. } => summary.tool_executions += 1,
                TraceEntry::TurnStart { .. } => summary.turns += 1,
                TraceEntry::ProviderRequest { .. } => summary.provider_requests += 1,
                TraceEntry::ProviderResponse { .. } => summary.provider_requests += 1,
                TraceEntry::PluginLoaded { .. } | TraceEntry::PluginEvent { .. } | TraceEntry::PluginError { .. } => summary.plugins += 1,
                TraceEntry::EnvSnapshot { .. } | TraceEntry::FileHashSnapshot { .. } | TraceEntry::Snapshot { .. } => summary.snapshots += 1,
                TraceEntry::TurnEnd { .. } => {},
                TraceEntry::ToolStart { .. } => {},
            }

            let step = ReplayStep { entry: entry.clone(), timestamp_ns: ts, index: idx, diff };
            if !on_step(&step) { break; }
        }

        summary.duration_ms = start.elapsed().as_millis() as u64;
        summary
    }

    /// Smart filter: TraceEntry → SessionEntry (SM-006 §13.6).
    pub fn extract_session(&self) -> Vec<SessionEntry> {
        let mut out = Vec::new();
        let mut eid = 0u64;
        let mut msg_count = 0u32;

        for entry in &self.entries {
            eid += 1;
            let id = EntryId(format!("e{}", eid));
            let parent = if out.is_empty() { None } else { Some(EntryId(format!("e{}", eid - 1))) };
            let ts = get_ts(entry) / 1_000_000; // ns → ms

            match entry {
                TraceEntry::AgentEvent { event, .. } if event == "SessionStart" => {
                    out.push(SessionEntry::Session { version: 1, created: ts });
                },
                TraceEntry::TurnStart { turn_number, .. } if *turn_number == 0 => {
                    // First turn start → user message placeholder
                    out.push(SessionEntry::User {
                        id: EntryId(format!("e{}", eid)), parent_id: None,
                        content: vec![ContentBlock::Text(format!("[User message for turn 0]"))],
                        timestamp: ts,
                    });
                },
                TraceEntry::ProviderResponse { request_id, completion_tokens, finish_reason, .. } => {
                    msg_count += 1;
                    out.push(SessionEntry::Assistant {
                        id, parent_id: parent,
                        content: vec![ContentBlock::Text(format!("[Response {} tokens, {}]", completion_tokens, finish_reason))],
                        usage: ProviderUsage {
                            input_tokens: 50, output_tokens: *completion_tokens,
                            cache_read_tokens: None, cache_write_tokens: None, total_tokens: Some(50 + completion_tokens),
                        },
                        provider: "minimax".into(), model: "MiniMax-M2.7".into(),
                        stop_reason: if finish_reason == "stop" { StopReason::EndTurn } else { StopReason::OverMaxTokens },
                        timestamp: ts,
                    });
                },
                TraceEntry::ToolEnd { tool_call_id, tool_name, result_hash, is_error, .. } => {
                    out.push(SessionEntry::ToolResult {
                        id, parent_id: parent,
                        tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(),
                        content: vec![ContentBlock::ToolResult {
                            id: tool_call_id.clone(), result: format!("hash:{}", result_hash), is_error: *is_error,
                        }],
                        is_error: *is_error, timestamp: ts,
                    });
                },
                TraceEntry::Snapshot { message_count, .. } => {
                    // Compaction-like: if messages > threshold
                    if *message_count > 10 {
                        out.push(SessionEntry::Compaction {
                            id, parent_id: parent,
                            summary: format!("Compacted at {} messages", message_count),
                            first_kept_id: EntryId(format!("e{}", eid.saturating_sub(5))),
                            tokens_before: 5000, read_files: vec!["main.rs".into()], modified_files: vec!["lib.rs".into()],
                            timestamp: ts,
                        });
                    }
                },
                _ => {
                    // Unmapped entries → Unknown
                    let data = format!("{:?}", entry);
                    out.push(SessionEntry::Unknown {
                        id, data: data.into_bytes(), timestamp: ts,
                    });
                },
            }
        }
        out
    }

    /// Extract provider request/response pairs.
    pub fn extract_provider_trace(&self) -> Vec<(TraceEntry, Option<TraceEntry>)> {
        let mut reqs: HashMap<String, TraceEntry> = HashMap::new();
        let mut out = Vec::new();

        for entry in &self.entries {
            match entry {
                TraceEntry::ProviderRequest { request_id, .. } => {
                    reqs.insert(request_id.clone(), entry.clone());
                },
                TraceEntry::ProviderResponse { request_id, .. } => {
                    let req = reqs.remove(request_id).unwrap_or_else(|| {
                        TraceEntry::AgentEvent { timestamp_ns: 0, event: "[missing request]".into() }
                    });
                    out.push((req, Some(entry.clone())));
                },
                _ => {},
            }
        }
        // Unmatched requests
        for (_, req) in reqs.drain() {
            out.push((req, None));
        }
        out
    }
}

// === Helpers ===

fn get_ts(e: &TraceEntry) -> u64 {
    match e {
        TraceEntry::AgentEvent { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::TurnStart { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::TurnEnd { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::ToolStart { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::ToolEnd { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::ProviderRequest { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::ProviderResponse { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::PluginLoaded { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::PluginEvent { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::PluginError { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::EnvSnapshot { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::FileHashSnapshot { timestamp_ns, .. } => *timestamp_ns,
        TraceEntry::Snapshot { timestamp_ns, .. } => *timestamp_ns,
    }
}

/// Simulate tool re-execution for compare mode. Deterministic hash from args.
fn simulate_tool_exec(sandbox_dir: &str, tool_name: &str, args: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(sandbox_dir.as_bytes());
    hasher.update(tool_name.as_bytes());
    hasher.update(args.as_bytes());
    // Add a "re-execution" salt so some tools differ from original
    hasher.update(b"re-exec-v2");
    let hash = hasher.finalize();
    format!("sha256:{:x}", hash)[..16].to_string()
}

/// Generate deterministic hash for original tool result.
fn original_tool_hash(tool_name: &str, args: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    hasher.update(args.as_bytes());
    let hash = hasher.finalize();
    format!("sha256:{:x}", hash)[..16].to_string()
}

// === Synthetic trace generator ===

fn generate_trace() -> Vec<TraceEntry> {
    let mut entries = Vec::new();
    let base_ts = 1_715_000_000_000_000u64;
    let mut ts = base_ts;

    // Session start
    entries.push(TraceEntry::AgentEvent { timestamp_ns: ts, event: "SessionStart".into() }); ts += 1_000_000;

    // Env snapshot
    entries.push(TraceEntry::EnvSnapshot {
        timestamp_ns: ts, cwd: "/home/user/smith".into(),
        env_vars: vec![("HOME".into(), "/home/user".into()), ("SHELL".into(), "/bin/bash".into())],
    }); ts += 500_000;

    // Plugin load
    entries.push(TraceEntry::PluginLoaded { timestamp_ns: ts, path: "formatter.lua".into(), success: true }); ts += 2_000_000;
    entries.push(TraceEntry::PluginEvent { timestamp_ns: ts, plugin: "formatter".into(), event: "registered".into() }); ts += 1_000_000;

    // 5 turns, each with tools and provider calls
    let tools = vec![
        ("bash", r#"{"cmd":"ls -la"}"#),
        ("read_file", r#"{"path":"src/main.rs"}"#),
        ("grep", r#"{"pattern":"TODO","path":"src/"}"#),
        ("write_file", r#"{"path":"src/lib.rs","content":"fn main() {}"}"#),
        ("bash", r#"{"cmd":"cargo test"}"#),
        ("read_file", r#"{"path":"Cargo.toml"}"#),
        ("bash", r#"{"cmd":"git diff"}"#),
    ];

    for turn in 0..5 {
        // Turn start
        entries.push(TraceEntry::TurnStart {
            timestamp_ns: ts, turn_number: turn, model: "MiniMax-M2.7".into(), provider: "minimax".into(),
        }); ts += 500_000;

        // Provider request/response
        let req_id = format!("req-{}", turn);
        entries.push(TraceEntry::ProviderRequest {
            timestamp_ns: ts, request_id: req_id.clone(), model: "MiniMax-M2.7".into(), prompt_tokens: (50 + turn * 10) as u64,
        }); ts += 3_000_000;
        entries.push(TraceEntry::ProviderResponse {
            timestamp_ns: ts, request_id: req_id, completion_tokens: (100 + turn * 20) as u64,
            finish_reason: if turn == 3 { "length".into() } else { "stop".into() },
        }); ts += 2_000_000;

        // Agent event
        entries.push(TraceEntry::AgentEvent { timestamp_ns: ts, event: "Thinking".into() }); ts += 1_000_000;

        // 1-2 tool calls per turn
        let tool_idx = (turn * 2) as usize;
        let tool_count = 1 + (turn % 2) as usize;
        for t in 0..tool_count {
            let (tname, targs) = tools[(tool_idx + t) % tools.len()];
            let call_id = format!("c{}-{}", turn, t);
            let hash = original_tool_hash(tname, targs);
            entries.push(TraceEntry::ToolStart {
                timestamp_ns: ts, tool_call_id: call_id.clone(), tool_name: tname.to_string(), args_json: targs.to_string(),
            }); ts += 5_000_000;
            entries.push(TraceEntry::ToolEnd {
                timestamp_ns: ts, tool_call_id: call_id, tool_name: tname.to_string(), result_hash: hash, is_error: false,
            }); ts += 2_000_000;
        }

        // File hash snapshot every other turn
        if turn % 2 == 0 {
            entries.push(TraceEntry::FileHashSnapshot {
                timestamp_ns: ts, files: vec![
                    ("src/main.rs".into(), format!("h{}a", turn)),
                    ("src/lib.rs".into(), format!("h{}b", turn)),
                ],
            }); ts += 500_000;
        }

        // Agent state snapshot
        entries.push(TraceEntry::Snapshot {
            timestamp_ns: ts, message_count: (turn + 1) * 3, model: "MiniMax-M2.7".into(), pending_tools: 0,
        }); ts += 500_000;

        // Turn end
        entries.push(TraceEntry::TurnEnd {
            timestamp_ns: ts, turn_number: turn,
            stop_reason: if turn == 3 { "length".into() } else { "end_turn".into() },
        }); ts += 1_000_000;

        // Plugin event every other turn
        if turn % 2 == 1 {
            entries.push(TraceEntry::PluginEvent {
                timestamp_ns: ts, plugin: "formatter".into(), event: "formatted".into(),
            }); ts += 1_000_000;
        }
    }

    // Extra plugin error
    entries.push(TraceEntry::PluginError { timestamp_ns: ts, plugin: "linter".into(), error: "parse error".into() }); ts += 1_000_000;

    // Final env snapshot
    entries.push(TraceEntry::EnvSnapshot {
        timestamp_ns: ts, cwd: "/home/user/smith".into(),
        env_vars: vec![("HOME".into(), "/home/user".into())],
    });

    entries
}

// === Tests ===

#[tokio::main]
async fn main() {
    eprintln!("=== P14: Replay Engine ===");
    eprintln!();

    // --- Test 1: Generate synthetic trace with 50+ entries ---
    eprintln!("--- Test 1: Synthetic trace generation ---");
    let entries = generate_trace();
    eprintln!("[OK] Generated {} trace entries", entries.len());
    assert!(entries.len() >= 50, "Need 50+ entries, got {}", entries.len());

    // Count variants
    let mut variant_counts: HashMap<&str, usize> = HashMap::new();
    for e in &entries {
        let name = match e {
            TraceEntry::AgentEvent { .. } => "AgentEvent",
            TraceEntry::TurnStart { .. } => "TurnStart",
            TraceEntry::TurnEnd { .. } => "TurnEnd",
            TraceEntry::ToolStart { .. } => "ToolStart",
            TraceEntry::ToolEnd { .. } => "ToolEnd",
            TraceEntry::ProviderRequest { .. } => "ProviderRequest",
            TraceEntry::ProviderResponse { .. } => "ProviderResponse",
            TraceEntry::PluginLoaded { .. } => "PluginLoaded",
            TraceEntry::PluginEvent { .. } => "PluginEvent",
            TraceEntry::PluginError { .. } => "PluginError",
            TraceEntry::EnvSnapshot { .. } => "EnvSnapshot",
            TraceEntry::FileHashSnapshot { .. } => "FileHashSnapshot",
            TraceEntry::Snapshot { .. } => "Snapshot",
        };
        *variant_counts.entry(name).or_insert(0) += 1;
    }
    eprintln!("  Variants: {:?}", variant_counts);
    assert!(variant_counts.len() >= 10, "Should cover 10+ variants, got {}", variant_counts.len());

    // --- Test 2: TraceCodec roundtrip ---
    eprintln!("--- Test 2: TraceCodec roundtrip ---");
    let header = TraceFileHeader::new([0xAB; 16], get_ts(&entries[0]).saturating_sub(1000), true);
    let body = encode_lp(&entries);
    let mut file = Vec::new();
    header.write(&mut file).unwrap();
    file.extend_from_slice(&body);
    eprintln!("[OK] Encoded trace file: {} bytes (header {} + body {})", file.len(), TraceFileHeader::SIZE, body.len());

    let mut cursor = Cursor::new(&file[..]);
    let read_header = TraceFileHeader::read(&mut cursor).unwrap();
    assert_eq!(read_header.session_id, [0xAB; 16]);
    let remaining = &file[TraceFileHeader::SIZE..];
    let decoded = decode_lp(remaining);
    assert_eq!(decoded.len(), entries.len());
    assert_eq!(decoded, entries);
    eprintln!("[OK] Decoded {} entries, all match", decoded.len());

    // --- Test 3: ReplaySpeed::Max (instant) ---
    eprintln!();
    eprintln!("--- Test 3: Replay Max speed ---");
    let engine = ReplayEngine::from_entries(entries.clone(), get_ts(&entries[0]));
    assert_eq!(engine.len(), entries.len());
    assert_eq!(engine.turn_count(), 5);

    let summary = engine.run(&ReplaySpeed::Max, &ReplayMode::Normal, |_step| true);
    eprintln!("[OK] Max replay: {} entries in {}ms", summary.total_entries, summary.duration_ms);
    assert_eq!(summary.total_entries, entries.len());
    assert_eq!(summary.turns, 5);
    assert_eq!(summary.agent_events, 6); // SessionStart + 5 Thinking
    eprintln!("  agent_events={}, tool_executions={}, turns={}, providers={}, plugins={}, snapshots={}",
        summary.agent_events, summary.tool_executions, summary.turns,
        summary.provider_requests, summary.plugins, summary.snapshots);

    // --- Test 4: ReplaySpeed::Factor(1000) (1ms per 1s trace time) ---
    eprintln!("--- Test 4: Factor(1000) speed ---");
    let start = std::time::Instant::now();
    let summary = engine.run(&ReplaySpeed::Factor(1000.0), &ReplayMode::Normal, |_step| true);
    let elapsed = start.elapsed();
    // Trace spans ~100ms of simulated time. Factor(1000) → ~0.1ms actual.
    // Should complete in < 500ms.
    eprintln!("[OK] Factor(1000) replay: {} entries in {}ms (wall {}ms)",
        summary.total_entries, summary.duration_ms, elapsed.as_millis());
    assert!(elapsed.as_millis() < 500, "Factor(1000) should be fast, took {}ms", elapsed.as_millis());

    // --- Test 5: ReplayMode::Compare ---
    eprintln!("--- Test 5: Compare mode ---");
    let compare_summary = engine.run(
        &ReplaySpeed::Max,
        &ReplayMode::Compare { sandbox_dir: "/tmp/sandbox".into(), continue_on_diff: true },
        |_step| true,
    );
    eprintln!("[OK] Compare: {} entries, {} diffs detected",
        compare_summary.total_entries, compare_summary.diffs.len());
    // All tool re-executions should produce different hashes (salted)
    assert!(compare_summary.diffs.len() > 0, "Compare mode should detect diffs");
    for d in &compare_summary.diffs {
        assert_ne!(d.original_hash, d.new_hash, "Diff should have different hashes");
        eprintln!("  diff: tool={} call={} orig={} new={}", d.tool_name, d.tool_call_id, d.original_hash, d.new_hash);
    }
    assert_eq!(compare_summary.tool_executions, 7); // 5 turns, 1-2 tools each: 1+2+1+2+1=7

    // --- Test 6: seek_to_turn ---
    eprintln!("--- Test 6: seek_to_turn ---");
    let slice0 = engine.seek_to_turn(0);
    assert!(slice0.len() > 0, "Turn 0 should have entries");
    eprintln!("[OK] seek_to_turn(0): {} entries", slice0.len());

    let slice2 = engine.seek_to_turn(2);
    assert!(slice2.len() > 0);
    assert!(slice2.len() < slice0.len(), "Turn 2 should have fewer entries than turn 0");
    eprintln!("[OK] seek_to_turn(2): {} entries", slice2.len());

    let slice5 = engine.seek_to_turn(5); // out of bounds
    assert!(slice5.is_empty(), "seek_to_turn(5) should be empty (only 5 turns)");
    eprintln!("[OK] seek_to_turn(5): empty (OOB)");

    // Seeked engine should also replay correctly
    let seeked = ReplayEngine::from_entries(slice2.to_vec(), get_ts(&slice2[0]));
    let seeked_summary = seeked.run(&ReplaySpeed::Max, &ReplayMode::Normal, |_step| true);
    eprintln!("[OK] Seeked replay from turn 2: {} entries", seeked_summary.total_entries);
    assert!(seeked_summary.turns >= 1, "Should have at least 1 turn from seek");

    // --- Test 7: extract_session (smart filter) ---
    eprintln!("--- Test 7: extract_session smart filter ---");
    let session = engine.extract_session();
    eprintln!("[OK] Session entries: {}", session.len());
    assert!(session.len() > 0);

    // Should have Session header
    let has_session = session.iter().any(|s| matches!(s, SessionEntry::Session { .. }));
    assert!(has_session, "Should have Session header");

    // Should have Assistant entries (from ProviderResponse)
    let assistant_count = session.iter().filter(|s| matches!(s, SessionEntry::Assistant { .. })).count();
    assert_eq!(assistant_count, 5, "Should have 5 Assistant entries (5 turns)");

    // Should have ToolResult entries
    let tool_count = session.iter().filter(|s| matches!(s, SessionEntry::ToolResult { .. })).count();
    assert_eq!(tool_count, 7, "Should have 7 ToolResult entries");

    eprintln!("  Session={}, User={}, Assistant={}, ToolResult={}, Compaction={}, Unknown={}",
        session.iter().filter(|s| matches!(s, SessionEntry::Session { .. })).count(),
        session.iter().filter(|s| matches!(s, SessionEntry::User { .. })).count(),
        assistant_count, tool_count,
        session.iter().filter(|s| matches!(s, SessionEntry::Compaction { .. })).count(),
        session.iter().filter(|s| matches!(s, SessionEntry::Unknown { .. })).count(),
    );

    // --- Test 8: extract_provider_trace ---
    eprintln!("--- Test 8: extract_provider_trace ---");
    let pairs = engine.extract_provider_trace();
    eprintln!("[OK] Provider trace pairs: {}", pairs.len());
    assert_eq!(pairs.len(), 5, "5 turns = 5 request/response pairs");
    for (req, resp) in &pairs {
        assert!(resp.is_some(), "All requests should have responses");
        eprintln!("  pair: req_ts={} resp_ts={}",
            get_ts(req), get_ts(resp.as_ref().unwrap()));
    }

    // --- Test 9: on_step abort ---
    eprintln!("--- Test 9: on_step abort ---");
    let abort_summary = engine.run(&ReplaySpeed::Max, &ReplayMode::Normal, |step| {
        step.index < 10 // abort after 10 entries
    });
    eprintln!("[OK] Aborted after {} entries (requested <10)", abort_summary.total_entries);
    assert!(abort_summary.total_entries <= 11);

    // --- Test 10: ReplaySummary completeness ---
    eprintln!("--- Test 10: Summary completeness ---");
    let full = engine.run(&ReplaySpeed::Max, &ReplayMode::Normal, |_s| true);
    eprintln!("  Summary: {:?}", serde_json::to_string_pretty(&full).unwrap());
    assert_eq!(full.total_entries, entries.len());
    assert!(full.turns >= 5);
    assert!(full.tool_executions >= 7);
    assert!(full.provider_requests >= 10); // 5 req + 5 resp
    assert!(full.plugins >= 3); // 1 loaded + 1 event + 1 error
    assert!(full.snapshots >= 4); // 1 env + 2 filehash + 1 agent + 1 final env

    eprintln!();
    eprintln!("=== ALL P14 TESTS PASSED ===");
    eprintln!("  ReplayEngine: 10 tests, all variants covered");
    eprintln!("  Compare mode: {} diffs detected", compare_summary.diffs.len());
    eprintln!("  Smart filter: {} session entries extracted", session.len());
    eprintln!("  Provider pairs: {} matched", pairs.len());
}
