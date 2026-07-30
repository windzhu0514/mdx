use mdxnote_lib::{push_recent_entry, RecentFileEntry, MAX_RECENT_FILES};

#[test]
fn deduplicates_by_identity_and_keeps_only_fifty() {
    let mut entries = Vec::new();
    for index in 0..52 {
        entries = push_recent_entry(
            entries,
            format!("note-{index}.mdx"),
            format!("N{index}"),
            format!("{index:02}"),
        )
        .unwrap();
    }

    entries =
        push_recent_entry(entries, "note-20.mdx".into(), "Latest".into(), "99".into()).unwrap();

    assert_eq!(entries.len(), MAX_RECENT_FILES);
    assert_eq!(entries[0].title, "Latest");
    assert_eq!(
        entries.iter().filter(|item| item.title == "Latest").count(),
        1
    );
}

#[test]
fn accepts_markdown_paths_without_changing_the_extension() {
    let entries = push_recent_entry(
        Vec::new(),
        "notes/readme.md".into(),
        "Readme".into(),
        "now".into(),
    )
    .unwrap();

    assert!(entries[0].path.ends_with("readme.md"));
}

#[test]
fn recent_entry_includes_current_availability() {
    let entries = push_recent_entry(
        Vec::<RecentFileEntry>::new(),
        "missing-note.mdx".into(),
        "Missing".into(),
        "now".into(),
    )
    .unwrap();

    assert!(!entries[0].available);
}

#[test]
fn rereading_history_refreshes_file_availability() {
    let dir = std::env::temp_dir().join(format!("mora-recent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let note_path = dir.join("note.md");
    let history_path = dir.join("recent-files.json");
    let entries = vec![RecentFileEntry {
        path: note_path.to_string_lossy().to_string(),
        title: "Note".into(),
        last_opened_at: "now".into(),
        available: false,
    }];
    std::fs::write(&history_path, serde_json::to_string(&entries).unwrap()).unwrap();
    std::fs::write(&note_path, "content").unwrap();

    assert!(mdxnote_lib::read_recent_file(&history_path).unwrap()[0].available);

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rereading_history_deduplicates_equivalent_paths_keeping_the_most_recent_entry() {
    let dir = std::env::temp_dir().join(format!("mora-recent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let note_path = dir.join("note.md");
    let history_path = dir.join("recent-files.json");
    std::fs::write(&note_path, "content").unwrap();
    let entries = vec![
        RecentFileEntry {
            path: dir.join(".").join("note.md").to_string_lossy().to_string(),
            title: "Latest".into(),
            last_opened_at: "newer".into(),
            available: false,
        },
        RecentFileEntry {
            path: note_path.to_string_lossy().to_string(),
            title: "Older duplicate".into(),
            last_opened_at: "older".into(),
            available: false,
        },
    ];
    std::fs::write(&history_path, serde_json::to_string(&entries).unwrap()).unwrap();

    let entries = mdxnote_lib::read_recent_file(&history_path).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].title, "Latest");
    assert!(entries[0].available);

    std::fs::remove_dir_all(dir).unwrap();
}
