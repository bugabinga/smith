//! Prototype: zstd compressed trace codec.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct TraceEntry {
    timestamp: u64,
    event_type: u8,
    data: Vec<u8>,
}

fn main() {
    let entries: Vec<TraceEntry> = (0..100).map(|i| TraceEntry {
        timestamp: 1715000000 + i as u64,
        event_type: if i % 3 == 0 { 0 } else { 1 },
        data: format!("event {} padding for compression test..........", i).into_bytes(),
    }).collect();

    let mut cbor = Vec::new();
    for e in &entries { ciborium::ser::into_writer(e, &mut cbor).unwrap(); }
    eprintln!("CBOR: {} bytes", cbor.len());

    let compressed = zstd::encode_all(&cbor[..], 3).expect("compress");
    eprintln!("ZSTD: {} bytes ({:.1}%)", compressed.len(), compressed.len() as f64 / cbor.len() as f64 * 100.0);

    let decomp = zstd::decode_all(&compressed[..]).expect("decompress");
    assert_eq!(decomp, cbor);
    eprintln!("ZSTD roundtrip OK");

    // Decode all entries from concatenated CBOR
    let mut cursor = &decomp[..];
    let mut count = 0u32;
    while !cursor.is_empty() {
        let entry: TraceEntry = ciborium::de::from_reader(&mut cursor).expect("decode");
        assert_eq!(entry, entries[count as usize]);
        count += 1;
    }
    assert_eq!(count, 100);
    eprintln!("Trace codec OK: {} entries", count);
}
