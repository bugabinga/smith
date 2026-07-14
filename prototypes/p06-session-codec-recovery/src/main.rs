//! p06-session-codec-recovery
//!
//! Proves or disproves docs/SPEC.md §6.6 recovery claims for length-prefixed
//! CBOR session sequences:
//! - truncated tail stops parsing (prior entries survive),
//! - corrupt entry: skip + warn if possible,
//! - unknown future entry: preserve when round-tripping.
//!
//! Verify: `cargo run` — exits 0 with PASS lines when all expectations hold.

use serde::{Deserialize, Serialize};

/// v1 entry set — what the current reader knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum EntryV1 {
    User { id: u64, text: String },
    Assistant { id: u64, text: String },
    ToolCall { id: u64, name: String, args: String },
    ToolResult { id: u64, output: String },
}

/// v2 entry set — a future Smith writing a variant v1 does not know.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum EntryV2 {
    User { id: u64, text: String },
    Assistant { id: u64, text: String },
    ToolCall { id: u64, name: String, args: String },
    ToolResult { id: u64, output: String },
    /// Future variant, unknown to v1.
    HologramSnapshot { id: u64, blob: Vec<u8> },
}

/// What the recovering reader produces per frame.
#[derive(Debug, Clone, PartialEq)]
enum Recovered {
    Known(EntryV1),
    /// Well-formed CBOR whose variant tag v1 does not know: preserved raw.
    Unknown(Vec<u8>),
}

/// Diagnostics emitted during a read pass.
#[derive(Debug, PartialEq)]
enum Warn {
    CorruptEntrySkipped { frame: usize },
    TruncatedTail { at_frame: usize, missing: usize },
    /// A length prefix produced an implausible frame; framing is lost from here.
    FramingLost { at_frame: usize, claimed_len: usize, remaining: usize },
}

fn encode<T: Serialize>(entries: &[T]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries {
        let mut buf = Vec::new();
        ciborium::ser::into_writer(e, &mut buf).expect("encode");
        out.extend_from_slice(&(buf.len() as u32).to_be_bytes());
        out.extend_from_slice(&buf);
    }
    out
}

fn append_raw(out: &mut Vec<u8>, raw: &[u8]) {
    out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
    out.extend_from_slice(raw);
}

/// The recovering reader. Never panics, never loses entries before a fault.
fn read_recovering(bytes: &[u8]) -> (Vec<Recovered>, Vec<Warn>) {
    let mut entries = Vec::new();
    let mut warns = Vec::new();
    let mut pos = 0usize;
    let mut frame = 0usize;
    while pos < bytes.len() {
        if bytes.len() - pos < 4 {
            warns.push(Warn::TruncatedTail { at_frame: frame, missing: 4 - (bytes.len() - pos) });
            break;
        }
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let body_start = pos + 4;
        if len > bytes.len() - body_start {
            // Either a truncated tail (last frame cut mid-body) or a corrupted
            // length prefix. The codec cannot distinguish them; everything from
            // here on is unreadable.
            if frame == 0 || len <= 16 * 1024 * 1024 {
                warns.push(Warn::TruncatedTail { at_frame: frame, missing: len - (bytes.len() - body_start) });
            } else {
                warns.push(Warn::FramingLost { at_frame: frame, claimed_len: len, remaining: bytes.len() - body_start });
            }
            break;
        }
        let body = &bytes[body_start..body_start + len];
        // Two-stage decode: well-formed CBOR? then: known variant?
        match ciborium::de::from_reader::<ciborium::Value, _>(body) {
            Err(_) => warns.push(Warn::CorruptEntrySkipped { frame }),
            Ok(val) => match val.deserialized::<EntryV1>() {
                Ok(e) => entries.push(Recovered::Known(e)),
                Err(_) => entries.push(Recovered::Unknown(body.to_vec())),
            },
        }
        pos = body_start + len;
        frame += 1;
    }
    (entries, warns)
}

fn sample_v1() -> Vec<EntryV1> {
    vec![
        EntryV1::User { id: 1, text: "hello".into() },
        EntryV1::Assistant { id: 2, text: "hi, running a tool".into() },
        EntryV1::ToolCall { id: 3, name: "read".into(), args: "{\"path\":\"a.rs\"}".into() },
        EntryV1::ToolResult { id: 4, output: "fn main() {}".into() },
        EntryV1::Assistant { id: 5, text: "done".into() },
    ]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut pass = true;
    let mut check = |label: &str, ok: bool| {
        println!("{} {label}", if ok { "PASS" } else { "FAIL" });
        pass &= ok;
    };

    // 1. Normal roundtrip.
    let entries = sample_v1();
    let bytes = encode(&entries);
    let (rec, warns) = read_recovering(&bytes);
    check(
        &format!("normal roundtrip: {}/{} entries, no warnings", rec.len(), entries.len()),
        rec.len() == 5
            && warns.is_empty()
            && rec.iter().zip(&entries).all(|(r, e)| matches!(r, Recovered::Known(k) if k == e)),
    );

    // 2a. Truncated mid-body (crash during write): prior entries survive.
    let cut = bytes.len() - 7;
    let (rec, warns) = read_recovering(&bytes[..cut]);
    check(
        &format!("truncated mid-body: {} prior entries recovered, tail reported", rec.len()),
        rec.len() == 4 && warns == vec![Warn::TruncatedTail { at_frame: 4, missing: 7 }],
    );

    // 2b. Truncated mid-length-prefix: prior entries survive.
    let frames: Vec<Vec<u8>> = entries.iter().map(|e| {
        let mut b = Vec::new();
        ciborium::ser::into_writer(e, &mut b).unwrap();
        b
    }).collect();
    let mut t = Vec::new();
    for f in &frames[..4] { append_raw(&mut t, f); }
    t.extend_from_slice(&[0u8, 0]); // 2 bytes of a 4-byte length prefix
    let (rec, warns) = read_recovering(&t);
    check(
        &format!("truncated mid-prefix: {} prior entries recovered", rec.len()),
        rec.len() == 4 && matches!(warns[..], [Warn::TruncatedTail { at_frame: 4, missing: 2 }]),
    );

    // 3. Corrupt entry BODY (length intact): skipped with warning, all other
    //    entries survive — framing makes the skip precise.
    let mut c = Vec::new();
    for (i, f) in frames.iter().enumerate() {
        if i == 2 {
            let mut bad = f.clone();
            for b in bad.iter_mut() { *b = 0xFF; } // garbage, not valid CBOR
            append_raw(&mut c, &bad);
        } else {
            append_raw(&mut c, f);
        }
    }
    let (rec, warns) = read_recovering(&c);
    check(
        &format!("corrupt body skipped: {}/5 survive, skip warned", rec.len()),
        rec.len() == 4
            && warns == vec![Warn::CorruptEntrySkipped { frame: 2 }]
            && matches!(&rec[2], Recovered::Known(EntryV1::ToolResult { id: 4, .. })),
    );

    // 4. Corrupt LENGTH PREFIX: framing desynchronizes; everything from the
    //    corrupt frame on is lost. SPEC's "skip + warn if possible" must not
    //    promise more than this.
    let mut c = Vec::new();
    for (i, f) in frames.iter().enumerate() {
        if i == 2 {
            c.extend_from_slice(&0xDEAD_BEEFu32.to_be_bytes()); // absurd length
            c.extend_from_slice(f);
        } else {
            append_raw(&mut c, f);
        }
    }
    let (rec, warns) = read_recovering(&c);
    check(
        &format!("corrupt length prefix: {} prior entries survive, framing loss reported", rec.len()),
        rec.len() == 2
            && matches!(warns[..], [Warn::FramingLost { at_frame: 2, claimed_len: 0xDEAD_BEEF, .. }]),
    );

    // 5. Unknown future entry: v2 writes, v1 reads + preserves + rewrites,
    //    v2 reads back the future variant intact.
    let v2_entries = vec![
        EntryV2::User { id: 1, text: "hello".into() },
        EntryV2::HologramSnapshot { id: 2, blob: vec![9, 9, 9] },
        EntryV2::Assistant { id: 3, text: "future done".into() },
    ];
    let v2_bytes = encode(&v2_entries);
    let (rec, warns) = read_recovering(&v2_bytes);
    let unknown_preserved = matches!(&rec[1], Recovered::Unknown(_));
    check(
        "v1 reads v2 file: known entries decode, unknown preserved, no warnings",
        rec.len() == 3 && warns.is_empty() && unknown_preserved,
    );

    // v1 rewrites the session (roundtrip), preserving the unknown frame raw.
    let mut rewritten = Vec::new();
    for r in &rec {
        match r {
            Recovered::Known(e) => {
                let mut b = Vec::new();
                ciborium::ser::into_writer(e, &mut b)?;
                append_raw(&mut rewritten, &b);
            }
            Recovered::Unknown(raw) => append_raw(&mut rewritten, raw),
        }
    }
    let mut back = Vec::new();
    let mut pos = 0usize;
    while pos < rewritten.len() {
        let len = u32::from_be_bytes(rewritten[pos..pos + 4].try_into()?) as usize;
        let body = &rewritten[pos + 4..pos + 4 + len];
        back.push(ciborium::de::from_reader::<ciborium::Value, _>(body)?.deserialized::<EntryV2>()?);
        pos += 4 + len;
    }
    check(
        "v2 reads v1-rewritten file: future variant survives roundtrip",
        back == v2_entries,
    );

    println!();
    if pass {
        println!("p06 RESULT: all expectations hold");
        Ok(())
    } else {
        Err("p06 RESULT: expectation failed".into())
    }
}
