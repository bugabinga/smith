//! Integration prototype: Session + Trace CBOR-seq with zstd roundtrip.
#![allow(missing_docs)]
//! Tests SM-005 shared types + SM-006 core TraceCodec + TraceFileHeader.
//!
//! Validates:
//! 1. SessionEntry enum (all variants) encode/decode via ciborium
//! 2. TraceEntry enum (nested) encode/decode via ciborium
//! 3. CBOR-seq concatenation + sequential decode
//! 4. zstd compress/decompress roundtrip on CBOR-seq
//! 5. Length-prefixed encoding matching spec TraceCodec layout
//! 6. TraceFileHeader binary write/read (64 bytes)

use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};

// === SM-005 Shared Types (subset) ===

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

// === SM-006 SessionEntry (all variants) ===

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SessionEntry {
    Session { version: u32, created: u64 },
    User { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, timestamp: u64 },
    Assistant { id: EntryId, parent_id: Option<EntryId>, content: Vec<ContentBlock>, usage: ProviderUsage, provider: String, model: String, stop_reason: StopReason, timestamp: u64 },
    ToolResult { id: EntryId, parent_id: Option<EntryId>, tool_call_id: String, tool_name: String, content: Vec<ContentBlock>, is_error: bool, timestamp: u64 },
    Compaction { id: EntryId, parent_id: Option<EntryId>, summary: String, first_kept_id: EntryId, tokens_before: u64, read_files: Vec<String>, modified_files: Vec<String>, timestamp: u64 },
    Unknown { id: EntryId, data: Vec<u8>, timestamp: u64 },
}

// === SM-006 TraceEntry (subset) ===

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum TraceEntry {
    AgentEvent { timestamp_ns: u64, event: String },
    ToolStart { timestamp_ns: u64, tool_call_id: String, tool_name: String, args_json: String },
    ToolEnd { timestamp_ns: u64, tool_call_id: String, tool_name: String, result_hash: String, is_error: bool },
    EnvSnapshot { timestamp_ns: u64, cwd: String, env_vars: Vec<(String, String)> },
}

// === SM-006 TraceFileHeader ===

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
        Self {
            magic: Self::MAGIC,
            version: Self::VERSION,
            flags: if compressed { Self::FLAG_COMPRESSED } else { 0 },
            session_id,
            start_timestamp_ns: start_ts,
            reserved: [0u8; 32],
        }
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
        let mut version_buf = [0u8; 2]; r.read_exact(&mut version_buf)?;
        let version = u16::from_be_bytes(version_buf);
        if version != Self::VERSION { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad version")); }
        let mut flags_buf = [0u8; 2]; r.read_exact(&mut flags_buf)?;
        let mut session_id = [0u8; 16]; r.read_exact(&mut session_id)?;
        let mut ts_buf = [0u8; 8]; r.read_exact(&mut ts_buf)?;
        let mut reserved = [0u8; 32]; r.read_exact(&mut reserved)?;
        Ok(Self { magic, version, flags: u16::from_be_bytes(flags_buf), session_id, start_timestamp_ns: u64::from_be_bytes(ts_buf), reserved })
    }
}

// === TraceCodec (simplified spec impl) ===

fn encode_cbor_seq<T: Serialize>(entries: &[T]) -> Vec<u8> {
    let mut buf = Vec::new();
    for e in entries { ciborium::ser::into_writer(e, &mut buf).unwrap(); }
    buf
}

fn decode_cbor_seq<T: for<'de> Deserialize<'de>>(data: &[u8]) -> Vec<T> {
    let mut cursor = &data[..];
    let mut out = Vec::new();
    while !cursor.is_empty() {
        let entry: T = ciborium::de::from_reader(&mut cursor).unwrap();
        out.push(entry);
    }
    out
}

fn encode_length_prefixed<T: Serialize>(entries: &[T], compressed: bool) -> Vec<u8> {
    let mut buf = Vec::new();
    for e in entries {
        let mut cbor = Vec::new();
        ciborium::ser::into_writer(e, &mut cbor).unwrap();
        let payload = if compressed {
            zstd::encode_all(&cbor[..], 3).unwrap()
        } else {
            cbor
        };
        buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        buf.extend_from_slice(&payload);
    }
    buf
}

fn decode_length_prefixed<T: for<'de> Deserialize<'de>>(data: &[u8]) -> Vec<T> {
    let mut cursor = &data[..];
    let mut out = Vec::new();
    while !cursor.is_empty() {
        let mut len_buf = [0u8; 4];
        cursor.read_exact(&mut len_buf).unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        // Try decompress; if fails, assume raw CBOR
        let entry: T = match zstd::decode_all(&cursor[..len]) {
            Ok(decompressed) => ciborium::de::from_reader(&decompressed[..]).unwrap(),
            Err(_) => ciborium::de::from_reader(&mut &cursor[..len]).unwrap(),
        };
        out.push(entry);
        cursor = &cursor[len..];
    }
    out
}

fn main() {
    // === Test 1: SessionEntry all variants CBOR roundtrip ===
    let session_entries = vec![
        SessionEntry::Session { version: 1, created: 1715000000 },
        SessionEntry::User {
            id: EntryId("e1".into()), parent_id: None,
            content: vec![ContentBlock::Text("Hello".into())],
            timestamp: 1715000001,
        },
        SessionEntry::Assistant {
            id: EntryId("e2".into()), parent_id: Some(EntryId("e1".into())),
            content: vec![ContentBlock::Text("Hi there".into()), ContentBlock::Thinking { content: "hmm".into() }],
            usage: ProviderUsage { input_tokens: 50, output_tokens: 10, cache_read_tokens: Some(5), cache_write_tokens: None, total_tokens: Some(60) },
            provider: "openai".into(), model: "gpt-4".into(), stop_reason: StopReason::EndTurn,
            timestamp: 1715000002,
        },
        SessionEntry::ToolResult {
            id: EntryId("e3".into()), parent_id: Some(EntryId("e2".into())),
            tool_call_id: "c1".into(), tool_name: "bash".into(),
            content: vec![ContentBlock::ToolResult { id: "c1".into(), result: "file.txt\nfile2.txt".into(), is_error: false }],
            is_error: false, timestamp: 1715000003,
        },
        SessionEntry::Compaction {
            id: EntryId("e4".into()), parent_id: Some(EntryId("e3".into())),
            summary: "Summarized".into(), first_kept_id: EntryId("e3".into()),
            tokens_before: 1000, read_files: vec!["a.rs".into()], modified_files: vec!["b.rs".into()],
            timestamp: 1715000004,
        },
        SessionEntry::Unknown { id: EntryId("e5".into()), data: vec![0xDE, 0xAD], timestamp: 1715000005 },
    ];

    let cbor = encode_cbor_seq(&session_entries);
    let decoded: Vec<SessionEntry> = decode_cbor_seq(&cbor);
    assert_eq!(decoded.len(), session_entries.len());
    for (i, (a, b)) in session_entries.iter().zip(decoded.iter()).enumerate() {
        assert_eq!(a, b, "SessionEntry mismatch at index {}", i);
    }
    eprintln!("[OK] SessionEntry CBOR-seq roundtrip: {} entries, {} bytes", session_entries.len(), cbor.len());

    // === Test 2: TraceEntry CBOR roundtrip ===
    let trace_entries = vec![
        TraceEntry::AgentEvent { timestamp_ns: 1715000000_000_000, event: "AgentStart".into() },
        TraceEntry::ToolStart { timestamp_ns: 1715000001_000_000, tool_call_id: "c1".into(), tool_name: "bash".into(), args_json: r#"{"cmd":"ls"}"#.into() },
        TraceEntry::ToolEnd { timestamp_ns: 1715000002_000_000, tool_call_id: "c1".into(), tool_name: "bash".into(), result_hash: "abc123".into(), is_error: false },
        TraceEntry::EnvSnapshot { timestamp_ns: 1715000003_000_000, cwd: "/home/user/project".into(), env_vars: vec![("HOME".into(), "/home/user".into()), ("SHELL".into(), "/bin/bash".into())] },
    ];

    let trace_cbor = encode_cbor_seq(&trace_entries);
    let trace_decoded: Vec<TraceEntry> = decode_cbor_seq(&trace_cbor);
    assert_eq!(trace_decoded, trace_entries);
    eprintln!("[OK] TraceEntry CBOR-seq roundtrip: {} entries, {} bytes", trace_entries.len(), trace_cbor.len());

    // === Test 3: zstd compress/decompress on CBOR-seq ===
    let compressed = zstd::encode_all(&trace_cbor[..], 3).expect("compress");
    let decompressed = zstd::decode_all(&compressed[..]).expect("decompress");
    assert_eq!(decompressed, trace_cbor);
    eprintln!("[OK] zstd roundtrip: {} -> {} -> {} bytes ({:.1}% ratio)",
        trace_cbor.len(), compressed.len(), decompressed.len(),
        compressed.len() as f64 / trace_cbor.len() as f64 * 100.0);

    // === Test 4: Length-prefixed encoding (uncompressed) ===
    let lp_uncompressed = encode_length_prefixed(&trace_entries, false);
    let lp_decoded: Vec<TraceEntry> = decode_length_prefixed(&lp_uncompressed);
    assert_eq!(lp_decoded, trace_entries);
    eprintln!("[OK] Length-prefixed (uncompressed): {} bytes", lp_uncompressed.len());

    // === Test 5: Length-prefixed encoding (compressed, per-entry) ===
    let lp_compressed = encode_length_prefixed(&trace_entries, true);
    let lp_compressed_decoded: Vec<TraceEntry> = decode_length_prefixed(&lp_compressed);
    assert_eq!(lp_compressed_decoded, trace_entries);
    eprintln!("[OK] Length-prefixed (zstd per-entry): {} bytes ({:.1}% of raw CBOR)",
        lp_compressed.len(), lp_compressed.len() as f64 / trace_cbor.len() as f64 * 100.0);

    // === Test 6: TraceFileHeader binary write/read ===
    let header = TraceFileHeader::new([0x01; 16], 1715000000_000_000, true);
    assert_eq!(std::mem::size_of_val(&header.magic) + 2 + 2 + 16 + 8 + 32, TraceFileHeader::SIZE);
    let mut header_bytes = Vec::new();
    header.write(&mut header_bytes).unwrap();
    assert_eq!(header_bytes.len(), TraceFileHeader::SIZE);
    let mut cursor = Cursor::new(&header_bytes[..]);
    let header_read = TraceFileHeader::read(&mut cursor).unwrap();
    assert_eq!(header_read.magic, TraceFileHeader::MAGIC);
    assert_eq!(header_read.version, 1);
    assert_eq!(header_read.flags, TraceFileHeader::FLAG_COMPRESSED);
    assert_eq!(header_read.session_id, [0x01; 16]);
    assert_eq!(header_read.start_timestamp_ns, 1715000000_000_000);
    eprintln!("[OK] TraceFileHeader: {} bytes, magic={:?}, version={}, flags=0x{:04x}",
        TraceFileHeader::SIZE, &header_read.magic[..], header_read.version, header_read.flags);

    // === Test 7: Full trace file roundtrip (header + length-prefixed compressed body) ===
    let mut full_file = Vec::new();
    header.write(&mut full_file).unwrap();
    let body = encode_length_prefixed(&trace_entries, true);
    full_file.extend_from_slice(&body);

    let mut file_cursor = Cursor::new(&full_file[..]);
    let read_header = TraceFileHeader::read(&mut file_cursor).unwrap();
    assert!(read_header.flags & TraceFileHeader::FLAG_COMPRESSED != 0);
    let remaining = &full_file[TraceFileHeader::SIZE..];
    let file_entries: Vec<TraceEntry> = decode_length_prefixed(remaining);
    assert_eq!(file_entries, trace_entries);
    eprintln!("[OK] Full trace file roundtrip: {} header + {} body = {} bytes, {} entries recovered",
        TraceFileHeader::SIZE, body.len(), full_file.len(), file_entries.len());

    eprintln!("\n=== ALL P11 INTEGRATION TESTS PASSED ===");
}
