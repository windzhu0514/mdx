use std::fs;
use std::path::{Path, PathBuf};

use mdxnote_lib::{
    list_index_entries, refresh_workspace_index, search_index_entries, upsert_index_entry,
    NoteIndexEntry,
};
use uuid::Uuid;

fn test_dir() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mora-index-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn entry(path: &str, title: &str, content: &str) -> NoteIndexEntry {
    NoteIndexEntry {
        path: path.to_string(),
        title: title.to_string(),
        tags: vec!["工作".to_string()],
        summary: String::new(),
        updated_at: "2026-07-20T10:00:00Z".to_string(),
        content: content.to_string(),
        source_revision: None,
    }
}

fn loaded_entry(path: &Path) -> NoteIndexEntry {
    let title = path.file_stem().unwrap().to_string_lossy().to_string();
    entry(&path.to_string_lossy(), &title, &format!("{title} body"))
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

#[test]
fn batch_refresh_indexes_once_then_skips_unchanged_files() {
    let root = test_dir();
    let index = root.join("notes.json");
    let first = root.join("first.md");
    let second = root.join("second.md");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();

    let mut loads = 0;
    let initial = refresh_workspace_index(
        &index,
        &root,
        &[first.clone(), second.clone()],
        false,
        |path| {
            loads += 1;
            Ok(loaded_entry(path))
        },
    )
    .unwrap();

    assert_eq!(initial.discovered, 2);
    assert_eq!((initial.indexed, initial.unchanged, loads), (2, 0, 2));
    assert!(initial.failed.is_empty());

    let repeated = refresh_workspace_index(&index, &root, &[first, second], false, |_| {
        panic!("unchanged files must not be loaded")
    })
    .unwrap();

    assert_eq!((repeated.indexed, repeated.unchanged), (0, 2));
    assert_eq!(list_index_entries(&index).unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn batch_refresh_loads_only_added_and_changed_files_and_removes_deleted_files() {
    let root = test_dir();
    let index = root.join("notes.json");
    let changed = root.join("changed.md");
    let deleted = root.join("deleted.md");
    fs::write(&changed, "old").unwrap();
    fs::write(&deleted, "delete me").unwrap();
    refresh_workspace_index(
        &index,
        &root,
        &[changed.clone(), deleted.clone()],
        false,
        |path| Ok(loaded_entry(path)),
    )
    .unwrap();

    fs::write(&changed, "changed content with a new size").unwrap();
    fs::remove_file(&deleted).unwrap();
    let added = root.join("added.md");
    fs::write(&added, "added").unwrap();
    let mut loaded = Vec::new();

    let result = refresh_workspace_index(
        &index,
        &root,
        &[changed.clone(), added.clone()],
        false,
        |path| {
            loaded.push(path.file_name().unwrap().to_string_lossy().to_string());
            Ok(loaded_entry(path))
        },
    )
    .unwrap();

    loaded.sort();
    assert_eq!(loaded, ["added.md", "changed.md"]);
    assert_eq!(
        (result.indexed, result.removed, result.unchanged),
        (2, 1, 0)
    );
    let paths = list_index_entries(&index)
        .unwrap()
        .into_iter()
        .map(|item| {
            PathBuf::from(item.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(paths.len(), 2);
    assert!(paths.contains(&"added.md".to_string()));
    assert!(paths.contains(&"changed.md".to_string()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_changed_file_keeps_its_last_valid_index_entry() {
    let root = test_dir();
    let index = root.join("notes.json");
    let path = root.join("note.md");
    fs::write(&path, "old").unwrap();
    refresh_workspace_index(&index, &root, std::slice::from_ref(&path), false, |_| {
        Ok(entry(&path.to_string_lossy(), "Old title", "Old body"))
    })
    .unwrap();

    fs::write(&path, "new content with another size").unwrap();
    let result = refresh_workspace_index(&index, &root, std::slice::from_ref(&path), false, |_| {
        Err("文件暂时不可读".to_string())
    })
    .unwrap();

    assert_eq!(result.indexed, 0);
    assert_eq!(result.failed.len(), 1);
    let retained = list_index_entries(&index).unwrap();
    assert_eq!(retained[0].title, "Old title");
    assert_eq!(retained[0].content, "Old body");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn truncated_refresh_does_not_remove_unseen_entries() {
    let root = test_dir();
    let index = root.join("notes.json");
    let visible = root.join("visible.md");
    let unseen = root.join("unseen.md");
    fs::write(&visible, "visible").unwrap();
    fs::write(&unseen, "unseen").unwrap();
    refresh_workspace_index(&index, &root, &[visible.clone(), unseen], false, |path| {
        Ok(loaded_entry(path))
    })
    .unwrap();

    let result =
        refresh_workspace_index(&index, &root, std::slice::from_ref(&visible), true, |_| {
            panic!("the visible file is unchanged")
        })
        .unwrap();

    assert!(result.truncated);
    assert_eq!(result.removed, 0);
    assert_eq!(list_index_entries(&index).unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_entry_without_revision_is_upgraded_on_refresh() {
    let root = test_dir();
    let index = root.join("notes.json");
    let path = root.join("legacy.md");
    fs::write(&path, "legacy").unwrap();
    let legacy = serde_json::json!([{
        "path": path.to_string_lossy(),
        "title": "Legacy",
        "tags": [],
        "summary": "",
        "updatedAt": "2026-07-20T10:00:00Z",
        "content": "legacy"
    }]);
    fs::write(&index, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let result =
        refresh_workspace_index(&index, &root, std::slice::from_ref(&path), false, |path| {
            Ok(loaded_entry(path))
        })
        .unwrap();

    assert_eq!(result.indexed, 1);
    assert!(list_index_entries(&index).unwrap()[0]
        .source_revision
        .is_some());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn equivalent_windows_path_casing_does_not_duplicate_an_entry() {
    let root = test_dir();
    let index = root.join("notes.json");
    let path = root.join("Case.md");
    fs::write(&path, "same").unwrap();
    refresh_workspace_index(&index, &root, std::slice::from_ref(&path), false, |path| {
        Ok(loaded_entry(path))
    })
    .unwrap();

    let uppercase = PathBuf::from(path.to_string_lossy().to_uppercase());
    let result = refresh_workspace_index(&index, &root, &[uppercase], false, |_| {
        panic!("equivalent path casing must reuse the existing revision")
    })
    .unwrap();

    assert_eq!(result.unchanged, 1);
    assert_eq!(list_index_entries(&index).unwrap().len(), 1);
    fs::remove_dir_all(root).unwrap();
}
