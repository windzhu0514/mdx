use std::io::{Cursor, Write};

use mdxnote_lib::validate_archive_bytes;
use zip::write::FileOptions;
use zip::ZipWriter;

fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    for (name, bytes) in entries {
        writer.start_file(*name, FileOptions::default()).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn rejects_duplicate_archive_entries() {
    let bytes = build_zip(&[("content.md", b"one"), ("content.md", b"two")]);
    assert!(validate_archive_bytes(&bytes).is_err());
}

#[test]
fn rejects_oversized_text_entries() {
    let content = vec![b'a'; 16 * 1024 * 1024 + 1];
    let bytes = build_zip(&[("content.md", &content)]);
    assert!(validate_archive_bytes(&bytes).is_err());
}

#[test]
fn accepts_a_small_safe_archive() {
    let bytes = build_zip(&[
        ("manifest.json", b"{}"),
        ("meta.json", b"{}"),
        ("content.md", b"hello"),
    ]);
    assert!(validate_archive_bytes(&bytes).is_ok());
}
