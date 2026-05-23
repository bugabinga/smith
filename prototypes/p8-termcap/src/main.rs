//! Prototype: Terminal capability detection.
#![allow(dead_code)]

unsafe extern "C" { fn isatty(fd: i32) -> i32; }

fn main() {
    let is_term = unsafe { isatty(1) != 0 };
    eprintln!("TTY: {}", is_term);
    eprintln!("TERM={:?}", std::env::var("TERM"));
    eprintln!("COLORTERM={:?}", std::env::var("COLORTERM"));
    let ct = std::env::var("COLORTERM").unwrap_or_default();
    eprintln!("Truecolor: {}", ct.contains("truecolor") || ct.contains("24bit"));
    eprintln!("Size: {:?}", crossterm::terminal::size().ok());
    eprintln!("Termcap OK");
}