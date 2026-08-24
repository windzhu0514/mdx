use mdxnote_lib::{disk_revision, markdown_file_paths, scan_folder};
use std::fs;
use std::path::{Path, PathBuf};

fn test_dir() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mora-workspace-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn write(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
}

#[test]
fn scan_filters_hidden_symlink_and_non_markdown_entries() {
    let root = test_dir();
    write(&root.join("b.md"), "b");
    write(&root.join("a.mdx"), "a");
    write(&root.join("ignored.txt"), "x");
    fs::create_dir(root.join(".hidden")).unwrap();
    fs::create_dir(root.join("notes")).unwrap();
    write(&root.join("notes").join("nested.md"), "nested");

    #[cfg(windows)]
    {
        let link = root.join("linked.md");
        match std::os::windows::fs::symlink_file(root.join("a.mdx"), &link) {
            Ok(()) => {}
            Err(error)
                if error.raw_os_error() == Some(1314)
                    || error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("failed to create test symlink: {error}"),
        }
    }

    #[cfg(windows)]
    {
        let hidden = root.join("windows-hidden.md");
        write(&hidden, "hidden");
        let status = std::process::Command::new("attrib")
            .arg("+H")
            .arg(&hidden)
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[cfg(windows)]
    {
        let system = root.join("windows-system.md");
        write(&system, "system");
        let status = std::process::Command::new("attrib")
            .arg("+S")
            .arg(&system)
            .status()
            .unwrap();
        assert!(status.success());
    }

    let result = scan_folder(&root, 10_000).unwrap();
    assert_eq!(
        result
            .entries
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        ["notes", "a.mdx", "b.md"]
    );
    assert_eq!(result.entries[0].children[0].name, "nested.md");
    assert!(!result.truncated);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn collects_only_markdown_files_from_the_existing_scan_tree() {
    let root = test_dir();
    fs::create_dir(root.join("nested")).unwrap();
    write(&root.join("root.mdx"), "not parsed by this test");
    write(&root.join("nested").join("child.md"), "child");

    let scan = scan_folder(&root, 10_000).unwrap();
    fs::remove_dir_all(&root).unwrap();
    let files = markdown_file_paths(&scan);

    assert_eq!(files.len(), 2);
    assert!(files.iter().any(|path| path.ends_with("root.mdx")));
    assert!(files.iter().any(|path| path.ends_with("child.md")));
}

#[test]
fn scan_sorts_numeric_names_and_stops_at_the_entry_limit() {
    let root = test_dir();
    for name in ["note10.md", "note2.md", "note1.md", "note20.md", "note3.md"] {
        write(&root.join(name), "x");
    }

    let complete = scan_folder(&root, 10_000).unwrap();
    assert_eq!(
        complete
            .entries
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        ["note1.md", "note2.md", "note3.md", "note10.md", "note20.md"]
    );

    let limited = scan_folder(&root, 3).unwrap();
    assert_eq!(limited.entry_count, 3);
    assert!(limited.truncated);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn scan_limit_zero_does_not_truncate_empty_or_ignored_directories() {
    let empty_root = test_dir();
    let empty = scan_folder(&empty_root, 0).unwrap();
    assert!(empty.entries.is_empty());
    assert_eq!(empty.entry_count, 0);
    assert!(!empty.truncated);
    fs::remove_dir_all(empty_root).unwrap();

    let ignored_root = test_dir();
    fs::create_dir(ignored_root.join(".hidden")).unwrap();
    write(&ignored_root.join("ignored.txt"), "x");
    let ignored = scan_folder(&ignored_root, 0).unwrap();
    assert!(ignored.entries.is_empty());
    assert_eq!(ignored.entry_count, 0);
    assert!(!ignored.truncated);
    fs::remove_dir_all(ignored_root).unwrap();
}

#[cfg(windows)]
#[test]
fn scan_does_not_probe_directories_after_the_entry_budget_is_exhausted() {
    let zero_root = test_dir();
    let zero_blocked = zero_root.join("blocked");
    fs::create_dir(&zero_blocked).unwrap();
    write(&zero_blocked.join("note.md"), "x");
    deny_directory_listing(&zero_blocked);

    let zero_result = scan_folder(&zero_root, 0);
    allow_directory_listing(&zero_blocked);
    let zero_result = zero_result.unwrap();
    assert!(zero_result.entries.is_empty());
    assert_eq!(zero_result.entry_count, 0);
    assert!(zero_result.truncated);
    fs::remove_dir_all(zero_root).unwrap();

    let limited_root = test_dir();
    let visible = limited_root.join("01-visible");
    let blocked = limited_root.join("02-blocked");
    fs::create_dir(&visible).unwrap();
    fs::create_dir(&blocked).unwrap();
    write(&visible.join("note.md"), "x");
    write(&blocked.join("note.md"), "x");
    deny_directory_listing(&blocked);

    let limited_result = scan_folder(&limited_root, 1);
    allow_directory_listing(&blocked);
    let limited_result = limited_result.unwrap();
    assert_eq!(limited_result.entry_count, 1);
    assert!(limited_result.truncated);
    assert_eq!(limited_result.entries[0].name, "01-visible");
    fs::remove_dir_all(limited_root).unwrap();
}

#[cfg(windows)]
fn deny_directory_listing(path: &Path) {
    let username = std::env::var("USERNAME").unwrap();
    let status = std::process::Command::new("icacls")
        .arg(path)
        .arg("/deny")
        .arg(format!("{username}:(RD)"))
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(windows)]
fn allow_directory_listing(path: &Path) {
    let username = std::env::var("USERNAME").unwrap();
    let status = std::process::Command::new("icacls")
        .arg(path)
        .arg("/remove:d")
        .arg(username)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn revision_reports_size_mtime_and_missing_path() {
    let root = test_dir();
    let file = root.join("note.mdx");
    write(&file, "abc");

    let found = disk_revision(&file);
    assert!(found.available);
    let revision = found.revision.unwrap();
    assert_eq!(revision.size, 3);
    assert!(!disk_revision(&root.join("missing.mdx")).available);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn revisions_return_an_error_per_unavailable_path() {
    let root = test_dir();
    let available = root.join("available.md");
    let missing = root.join("missing.md");
    write(&available, "x");

    let revisions = mdxnote_lib::workspace::get_disk_revisions(vec![
        available.to_string_lossy().to_string(),
        missing.to_string_lossy().to_string(),
    ]);
    assert_eq!(revisions.len(), 2);
    assert!(revisions[0].available);
    assert!(!revisions[1].available);
    assert!(revisions[1].error.is_some());

    fs::remove_dir_all(root).unwrap();
}
