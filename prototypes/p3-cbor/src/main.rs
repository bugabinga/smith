//! test
#![allow(missing_docs)]
use minicbor::{Encode, Decode};

#[derive(Encode, Decode, Debug)]
enum Msg { #[n(0)] Hello, #[n(1)] World(u32) }

fn main() {
    let buf = minicbor::to_vec(&Msg::Hello).unwrap();
    let d: Msg = minicbor::decode(&buf).unwrap();
    eprintln!("unit variant OK: {:?}", d);

    let buf2 = minicbor::to_vec(&Msg::World(42)).unwrap();
    let d2: Msg = minicbor::decode(&buf2).unwrap();
    eprintln!("tuple variant OK: {:?}", d2);
}