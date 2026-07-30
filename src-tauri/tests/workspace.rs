use mdxnote_lib::{disk_revision, scan_folder};
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
