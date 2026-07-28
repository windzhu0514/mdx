use std::fs;

use mdxnote_lib::{list_index_entries, search_index_entries, upsert_index_entry, NoteIndexEntry};
use uuid::Uuid;

fn entry(path: &str, title: &str, content: &str) -> NoteIndexEntry {
    NoteIndexEntry {
        path: path.to_string(),
        title: title.to_string(),
        tags: vec!["工作".to_string()],
        summary: String::new(),
        updated_at: "2026-07-20T10:00:00Z".to_string(),
        content: content.to_string(),
    }
}

#[test]
fn updates_lists_and_searches_index_entries() {
    let dir = std::env::temp_dir().join(format!("mora-index-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notes.json");

    upsert_index_entry(&path, entry("a.mdx", "项目计划", "里程碑和任务")).unwrap();
    upsert_index_entry(&path, entry("b.mdx", "会议记录", "项目计划评审")).unwrap();

    assert_eq!(list_index_entries(&path).unwrap().len(), 2);
    let results = search_index_entries(&path, "项目计划").unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].path, "a.mdx");
    assert!(results[0].score > results[1].score);

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn damaged_index_falls_back_to_empty() {
    let dir = std::env::temp_dir().join(format!("mora-index-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notes.json");
    fs::write(&path, b"not-json").unwrap();

    assert!(list_index_entries(&path).unwrap().is_empty());
    assert!(search_index_entries(&path, "anything").unwrap().is_empty());

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unicode_case_expansion_keeps_snippet_on_character_boundaries() {
    let dir = std::env::temp_dir().join(format!("mora-index-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notes.json");

    upsert_index_entry(&path, entry("unicode.mdx", "Unicode", "İx目标内容")).unwrap();
    let results = search_index_entries(&path, "目标").unwrap();

    assert_eq!(results.len(), 1);
    assert!(results[0].snippet.contains("目标"));

    fs::remove_dir_all(dir).unwrap();
}
