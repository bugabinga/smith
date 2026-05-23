//! Prototype: xtask release — build archive + checksum (SM-003/SM-011).

use sha2::{Sha256, Digest};
use std::path::Path;
use std::fs;

fn main() {
    let out = Path::new("target/dist/p10-test");
    let _ = fs::remove_dir_all(out);
    fs::create_dir_all(out).unwrap();

    // Create a fake binary
    let bin_path = out.join("smith");
    fs::write(&bin_path, b"#!/bin/sh\necho I am smith\n").unwrap();

    // Test tar.gz creation
    let tar_gz = out.join("smith-aarch64-unknown-linux-v0.1.0.tar.gz");
    create_tar_gz(out, &tar_gz, &["smith"]);
    assert!(tar_gz.exists());
    println!("tar.gz created: {} bytes", fs::metadata(&tar_gz).unwrap().len());

    // Test zip creation
    let zip_path = out.join("smith-x86_64-pc-windows-v0.1.0.zip");
    create_zip(out, &zip_path, &["smith"]);
    assert!(zip_path.exists());
    println!("zip created: {} bytes", fs::metadata(&zip_path).unwrap().len());

    // Test checksum generation
    let checksums = generate_checksums(out);
    assert!(!checksums.is_empty());
    println!("Checksums:\n{}", checksums);

    println!("xtask release prototype OK");
}

fn create_tar_gz(dir: &Path, out_path: &Path, files: &[&str]) {
    let file = fs::File::create(out_path).unwrap();
    let gz = flate2::GzBuilder::new().write(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    for f in files {
        tar.append_path_with_name(dir.join(f), f).unwrap();
    }
    let _ = tar.finish();
}

fn create_zip(dir: &Path, out_path: &Path, files: &[&str]) {
    let file = fs::File::create(out_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for f in files {
        let data = fs::read(dir.join(f)).unwrap();
        zip.start_file(f, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&data).unwrap();
    }
    zip.finish().unwrap();
}

use std::io::Write;

fn generate_checksums(dir: &Path) -> String {
    let mut lines = String::new();
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.is_empty() && ext != "txt" {
            let data = fs::read(&path).unwrap();
            let hash = format!("{:x}", Sha256::digest(&data));
            lines.push_str(&format!("{}  {}\n", hash, path.file_name().unwrap().to_str().unwrap()));
        }
    }
    let ck_path = dir.join("checksums-sha256.txt");
    fs::write(&ck_path, &lines).unwrap();
    lines
}
