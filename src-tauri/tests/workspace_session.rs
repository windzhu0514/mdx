use mdxnote_lib::{read_workspace_session_file, write_workspace_session_file};
use serde_json::json;
use uuid::Uuid;

fn test_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mora-workspace-session-test-{}", Uuid::new_v4()))
}

#[test]
fn writes_and_reads_version_one_session() {
    let dir = test_dir();
    let value = json!({"version": 1, "documents": [], "folderPaths": []});
    let path = dir.join("workspace-session.json");

    write_workspace_session_file(&path, &value).unwrap();
    let result = read_workspace_session_file(&path).unwrap();

    assert_eq!(result.session, Some(value));
    assert!(result.warning.is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn corrupt_session_falls_back_with_warning() {
    let path = test_dir().join("workspace-session.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{bad").unwrap();

    let result = read_workspace_session_file(&path).unwrap();

    assert!(result.session.is_none());
    assert!(result.warning.unwrap().contains("损坏"));
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn unsupported_session_version_falls_back_with_warning() {
    let path = test_dir().join("workspace-session.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{"version":2}"#).unwrap();

    let result = read_workspace_session_file(&path).unwrap();

    assert!(result.session.is_none());
    assert!(result.warning.unwrap().contains("不支持"));
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
