use std::fs;

use mdxnote_lib::{
    delete_draft_file, read_latest_draft_file, validate_draft_key, write_draft_file,
};
use serde_json::json;
use uuid::Uuid;

fn test_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mora-draft-test-{}", Uuid::new_v4()))
}

#[test]
fn validates_draft_keys() {
    assert!(validate_draft_key("note-deadbeef").is_ok());
    assert!(validate_draft_key("../draft").is_err());
    assert!(validate_draft_key("C:/draft").is_err());
    assert!(validate_draft_key("").is_err());
}

#[test]
fn writes_reads_latest_and_deletes_drafts() {
    let dir = test_dir();
    write_draft_file(
        &dir,
        "note-old",
        &json!({"title":"旧","updatedAt":"2026-07-20T09:00:00Z"}),
    )
    .unwrap();
    write_draft_file(
        &dir,
        "note-new",
        &json!({"title":"新","updatedAt":"2026-07-20T10:00:00Z"}),
    )
    .unwrap();

    let latest = read_latest_draft_file(&dir).unwrap().unwrap();
    assert_eq!(latest["title"], "新");

    delete_draft_file(&dir, "note-new").unwrap();
    let remaining = read_latest_draft_file(&dir).unwrap().unwrap();
    assert_eq!(remaining["title"], "旧");

    fs::remove_dir_all(dir).unwrap();
}
