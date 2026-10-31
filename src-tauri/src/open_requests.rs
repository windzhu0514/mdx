use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct OpenRequests(pub Mutex<Vec<String>>);
pub fn file_arguments(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    let mut result = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let raw = PathBuf::from(arg);
        let path = if raw.is_absolute() {
            raw
        } else {
            cwd.join(raw)
        };
        if !path.is_file()
            || !path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
                ["md", "mdx", "markdown"]
                    .iter()
                    .any(|e| s.eq_ignore_ascii_case(e))
            })
        {
            continue;
        }
        if let Ok(path) = crate::normalize_path(&path) {
            let identity = crate::path_identity(Path::new(&path)).unwrap_or_else(|_| path.clone());
            if !result.iter().any(|p: &String| {
                crate::path_identity(Path::new(p)).ok().as_ref() == Some(&identity)
            }) {
                result.push(path);
            }
        }
    }
    result
}
#[tauri::command]
pub fn take_open_requests(state: tauri::State<OpenRequests>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}
pub fn enqueue(app: &tauri::AppHandle, args: Vec<String>, cwd: &Path) {
    let files = file_arguments(args, cwd);
    let state = app.state::<OpenRequests>();
    let mut queue = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for file in files {
        if !queue.contains(&file) {
            queue.push(file);
        }
    }
    drop(queue);
    let _ = app.emit("open-files-ready", ());
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_and_deduplicates_arguments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("中文 空格.md"), "body").unwrap();
        std::fs::write(dir.path().join("other.txt"), "body").unwrap();
        let files = file_arguments(
            [
                "--help",
                "中文 空格.md",
                "other.txt",
                "中文 空格.md",
                "missing.mdx",
            ]
            .map(str::to_string),
            dir.path(),
        );
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("中文 空格.md"));
    }

    #[test]
    fn preserves_multiple_supported_files_in_order() {
        let root = tempfile::tempdir().unwrap();
        for name in ["一 空格.MDX", "二.markdown"] {
            std::fs::write(root.path().join(name), "content").unwrap();
        }
        let files = file_arguments(
            ["一 空格.MDX", "二.markdown", "一 空格.MDX"].map(str::to_string),
            root.path(),
        );
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("一 空格.MDX"));
        assert!(files[1].ends_with("二.markdown"));
    }
}
