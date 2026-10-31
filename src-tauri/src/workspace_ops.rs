use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
static OPERATIONS: Mutex<()> = Mutex::new(());
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub root: String,
    pub path: String,
    pub target: Option<String>,
    pub action: String,
}
fn checked(root: &Path, path: &Path, existing: bool) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("路径不允许包含上级目录。".into());
    }
    let parent = path.parent().ok_or("路径缺少父目录。")?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let result = parent.join(path.file_name().ok_or("文件名无效。")?);
    if result == root || !result.starts_with(&root) {
        return Err("路径超出工作区或指向根目录。".into());
    }
    let mut component = root.clone();
    for part in result
        .strip_prefix(&root)
        .map_err(|e| e.to_string())?
        .components()
    {
        component.push(part);
        if let Ok(meta) = fs::symlink_metadata(&component) {
            if linked(&meta) {
                return Err("不支持符号链接或目录联接。".into());
            }
        }
    }
    // 同时检查词法路径，拒绝通过工作区内部链接进入其他路径。
    let mut original = PathBuf::new();
    for part in path.components() {
        original.push(part);
        if let Ok(meta) = fs::symlink_metadata(&original) {
            if linked(&meta) {
                return Err("不支持符号链接或目录联接。".into());
            }
        }
    }
    if existing && !result.exists() {
        return Err("源路径不存在。".into());
    }
    if !existing && fs::symlink_metadata(&result).is_ok() {
        return Err("目标已存在。".into());
    }
    Ok(result)
}
fn linked(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn fingerprint(path: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    fn walk(path: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>, depth: usize) -> Result<(), String> {
        if depth > 128 || out.len() > 10000 {
            return Err("文件规模超出安全操作限制。".into());
        }
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if linked(&meta) {
            return Err("目录包含符号链接，操作已取消。".into());
        }
        if meta.is_dir() {
            out.push((path.to_path_buf(), Vec::new()));
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                walk(&entry.map_err(|e| e.to_string())?.path(), out, depth + 1)?;
            }
        } else {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            out.push((path.to_path_buf(), Sha256::digest(bytes).to_vec()));
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(path, &mut out, 0)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if linked(&metadata) {
        return Err("不支持链接。".into());
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn relocate_markdown(source: &Path, target: &Path) -> Result<(), String> {
    let content = fs::read_to_string(source).map_err(|e| e.to_string())?;
    let request=serde_json::from_value(serde_json::json!({"path":source,"title":"","content":content,"meta":null,"newAssets":[],"removedResources":[],"sourceFormat":"markdown"})).map_err(|e|e.to_string())?;
    let result = crate::markdown_file::save_markdown_file(request, target)?;
    if let Some(warning) = result.warning {
        return Err(format!("资源复制不完整，源文件已保留：{warning}"));
    }
    Ok(())
}
#[cfg(windows)]
fn recycle_flags() -> u32 {
    use windows::Win32::UI::Shell::*;
    (FOF_NO_UI
        | FOF_WANTNUKEWARNING
        | FOFX_RECYCLEONDELETE
        | FOFX_EARLYFAILURE
        | FOFX_ADDUNDORECORD)
        .0
}
#[cfg(windows)]
fn recycle(path: &Path) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{System::Com::*, UI::Shell::*},
    };
    let path = path.to_string_lossy();
    let shell_path = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
    };
    let wide: Vec<u16> = shell_path.encode_utf16().chain(Some(0)).collect();
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let result = (|| -> windows::core::Result<bool> {
        unsafe {
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            operation.SetOperationFlags(FILEOPERATION_FLAGS(recycle_flags()))?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            Ok(operation.GetAnyOperationsAborted()?.as_bool())
        }
    })();
    unsafe { CoUninitialize() };
    match result {
        Ok(false) => Ok(()),
        Ok(true) => Err("回收站操作已取消，源文件已保留。".into()),
        Err(error) => Err(error.to_string()),
    }
}
#[cfg(not(windows))]
fn recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|error| error.to_string())
}
fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
        };
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )
        }
        .map_err(|e| e.to_string())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let to = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (from, to);
        Err("当前系统不支持安全的禁止覆盖移动。".into())
    }
}
fn move_entry(
    source: &Path,
    target: &Path,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let before = fingerprint(source)?;
    let parent = target.parent().ok_or("缺少目标父目录。")?;
    let staging = tempfile::Builder::new()
        .prefix(".mora-move-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let staged = staging
        .path()
        .join(target.file_name().ok_or("目标名称无效。")?);
    if source.is_dir() {
        copy_tree(source, &staged)?;
        for (path, _) in &before {
            if path.is_file() && crate::markdown_file::is_markdown_path(path) {
                let destination =
                    staged.join(path.strip_prefix(source).map_err(|e| e.to_string())?);
                relocate_markdown(path, &destination)?;
            }
        }
    } else if crate::markdown_file::is_markdown_path(source) {
        relocate_markdown(source, &staged)?;
    } else {
        fs::copy(source, &staged).map_err(|e| e.to_string())?;
    }
    if fingerprint(source)? != before {
        return Err("EXTERNAL_CONFLICT：操作期间源文件发生变化。".into());
    }
    let entries = fs::read_dir(staging.path())
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for entry in &entries {
        if parent.join(entry.file_name()).exists() {
            return Err("目标或资源目录已存在。".into());
        }
    }
    let mut committed: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut removal_attempted = false;
    let commit = (|| {
        for entry in entries {
            let from = entry.path();
            let to = parent.join(entry.file_name());
            rename_no_replace(&from, &to)?;
            committed.push((from, to));
        }
        if fingerprint(source)? != before {
            return Err("EXTERNAL_CONFLICT：源文件发生变化。".into());
        }
        removal_attempted = true;
        remove(source)
    })();
    if let Err(error) = commit {
        if removal_attempted && fingerprint(source).ok().as_ref() != Some(&before) {
            return Err(format!(
                "{error}；源路径已部分变化，完整恢复副本保留在：{}",
                target.display()
            ));
        }
        let mut failures = Vec::new();
        for (from, to) in committed.iter().rev() {
            if let Err(e) = fs::rename(to, from) {
                failures.push(format!("{}: {e}", to.display()));
            }
        }
        return Err(format!(
            "{error}{}",
            if failures.is_empty() {
                String::new()
            } else {
                format!("；目标副本回滚失败，源文件仍保留：{}", failures.join("；"))
            }
        ));
    }
    Ok(())
}
fn recycle_with_backup(
    source: &Path,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let before = fingerprint(source)?;
    let backup = tempfile::Builder::new()
        .prefix(".mora-recycle-")
        .tempdir_in(source.parent().ok_or("缺少父目录。")?)
        .map_err(|e| e.to_string())?;
    let name = source.file_name().ok_or("缺少文件名。")?;
    copy_tree(source, &backup.path().join(name))?;
    if fingerprint(source)? != before {
        return Err("EXTERNAL_CONFLICT：回收前源文件发生变化。".into());
    }
    if let Err(error) = remove(source) {
        if fingerprint(source).ok().as_ref() != Some(&before) {
            let recovery = backup.keep().join(name);
            return Err(format!(
                "{error}；源路径已部分变化，完整恢复副本保留在：{}",
                recovery.display()
            ));
        }
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub async fn workspace_operation(request: Operation) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || operate(request))
        .await
        .map_err(|e| e.to_string())?
}
fn operate(request: Operation) -> Result<Option<String>, String> {
    let _guard = OPERATIONS.lock().map_err(|_| "文件操作锁不可用。")?;
    let root = Path::new(&request.root);
    let raw = Path::new(&request.path);
    if request.action == "reveal" && fs::canonicalize(root).ok() == fs::canonicalize(raw).ok() {
        tauri_plugin_opener::reveal_item_in_dir(raw).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    let creating = request.action.starts_with("create-");
    let source = checked(root, raw, !creating)?;
    match request.action.as_str() {
        "create-directory" => fs::create_dir(&source).map_err(|e| e.to_string())?,
        "create-file" => {
            if crate::markdown_file::is_markdown_path(&source) {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&source)
                    .map_err(|e| e.to_string())?;
            } else if source
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("mdx"))
            {
                let request=serde_json::from_value(serde_json::json!({"path":null,"title":source.file_stem().unwrap().to_string_lossy(),"content":"","meta":null,"newAssets":[],"removedResources":[]})).map_err(|e|e.to_string())?;
                let staging = tempfile::Builder::new()
                    .prefix(".mora-new-")
                    .tempdir_in(source.parent().ok_or("缺少父目录。")?)
                    .map_err(|e| e.to_string())?;
                let staged = staging
                    .path()
                    .join(source.file_name().ok_or("缺少文件名。")?);
                crate::save_to_path_with_fingerprint(request, staged.clone())?;
                rename_no_replace(&staged, &source)?;
            } else {
                return Err("新文件必须使用 .md、.markdown 或 .mdx 后缀。".into());
            }
        }
        "move" | "rename" => {
            let target = checked(
                root,
                Path::new(request.target.as_deref().ok_or("缺少目标路径。")?),
                false,
            )?;
            if target.starts_with(&source) {
                return Err("不能将目录移入自身。".into());
            }
            if source.is_file()
                && source.extension().map(|s| s.to_ascii_lowercase())
                    != target.extension().map(|s| s.to_ascii_lowercase())
            {
                return Err("重命名不能更改文件格式。".into());
            }
            move_entry(&source, &target, recycle)?;
            return crate::normalize_path(&target).map(Some);
        }
        "trash" => {
            recycle_with_backup(&source, recycle)?;
        }
        "reveal" => tauri_plugin_opener::reveal_item_in_dir(&source).map_err(|e| e.to_string())?,
        _ => return Err("不支持的文件操作。".into()),
    }
    Ok(Some(crate::normalize_path(&source)?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundary_accepts_child_but_rejects_escape_and_root() {
        let root = tempfile::tempdir().unwrap();
        assert!(checked(root.path(), &root.path().join("new.md"), false).is_ok());
        assert!(checked(root.path(), root.path(), true).is_err());
        assert!(checked(root.path(), &root.path().join("../escape.md"), false).is_err());
    }

    #[test]
    fn move_copies_resources_without_deleting_shared_originals() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old.md");
        let target_dir = root.path().join("target");
        fs::create_dir(&target_dir).unwrap();
        fs::write(root.path().join("shared.png"), b"image").unwrap();
        fs::write(&source, "![图](shared.png)").unwrap();
        let target = target_dir.join("new.md");
        move_entry(&source, &target, |p| {
            fs::rename(p, root.path().join("recycled.md")).map_err(|e| e.to_string())
        })
        .unwrap();
        assert!(!source.exists());
        assert!(root.path().join("shared.png").exists());
        let note =
            crate::markdown_file::open_markdown(target.to_string_lossy().to_string()).unwrap();
        let content = serde_json::to_value(note).unwrap()["content"]
            .as_str()
            .unwrap()
            .to_string();
        for reference in crate::export::resource_references(&content) {
            let resource =
                crate::markdown_resources::local_reference_path(&target, &reference.destination)
                    .unwrap()
                    .unwrap();
            assert_eq!(fs::read(resource).unwrap(), b"image");
        }
    }
    #[test]
    fn failed_source_removal_rolls_back_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old.md");
        let target = root.path().join("new.md");
        fs::write(&source, "hello").unwrap();
        assert!(move_entry(&source, &target, |_| Err("recycle failed".into())).is_err());
        assert_eq!(fs::read_to_string(source).unwrap(), "hello");
        assert!(!target.exists());
    }
    #[test]
    fn rejects_existing_destination_and_self_move() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "hello").unwrap();
        assert!(checked(root.path(), &path, false).is_err());
        fs::create_dir(root.path().join("folder")).unwrap();
        let op = Operation {
            root: root.path().to_string_lossy().to_string(),
            path: root.path().join("folder").to_string_lossy().to_string(),
            target: Some(root.path().join("folder/sub").to_string_lossy().to_string()),
            action: "move".into(),
        };
        assert!(operate(op).is_err());
    }
    #[test]
    fn missing_resource_keeps_source_and_destination_absent() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old.md");
        let target = root.path().join("new.md");
        fs::write(&source, "![missing](missing.png)").unwrap();
        assert!(move_entry(&source, &target, |_| panic!("must not remove source")).is_err());
        assert!(source.exists());
        assert!(!target.exists());
    }

    #[test]
    fn commit_never_overwrites_a_racing_destination() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("stage");
        let to = root.path().join("destination");
        fs::write(&from, b"new").unwrap();
        fs::write(&to, b"existing").unwrap();
        assert!(rename_no_replace(&from, &to).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"existing");
        assert!(from.exists());
    }

    #[test]
    fn symbolic_link_cannot_escape_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let original = outside.path().join("outside.md");
        fs::write(&original, "outside").unwrap();
        let link = root.path().join("linked.md");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&original, &link);
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&original, &link);
        if let Err(error) = created {
            #[cfg(windows)]
            if error.raw_os_error() == Some(1314)
                || error.kind() == std::io::ErrorKind::PermissionDenied
            {
                eprintln!("unverified: 当前权限无法创建符号链接测试夹具");
                return;
            }
            panic!("{error}");
        }
        assert!(checked(root.path(), &link, true).is_err());
        assert_eq!(fs::read_to_string(original).unwrap(), "outside");
    }

    #[cfg(windows)]
    #[test]
    fn windows_deletion_explicitly_requires_recycling() {
        assert_ne!(recycle_flags() & 0x00080000, 0);
    }

    #[test]
    fn partial_source_removal_failure_keeps_complete_recovery_copy() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old.md");
        let target = root.path().join("new.md");
        fs::write(&source, "protected").unwrap();
        let result = move_entry(&source, &target, |path| {
            fs::remove_file(path).unwrap();
            Err("partial recycle failure".into())
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "protected");
    }

    #[test]
    fn recycle_failure_keeps_source_without_orphan_backup() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("note.md");
        fs::write(&source, "protected").unwrap();
        assert!(recycle_with_backup(&source, |_| Err("unavailable recycle bin".into())).is_err());
        assert_eq!(fs::read_to_string(source).unwrap(), "protected");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn partial_recycle_failure_preserves_named_recovery_backup() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("note.md");
        fs::write(&source, "protected").unwrap();
        let error = recycle_with_backup(&source, |p| {
            fs::remove_file(p).unwrap();
            Err("partial failure".into())
        })
        .unwrap_err();
        let recovery = fs::read_dir(root.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("note.md");
        assert_eq!(fs::read_to_string(&recovery).unwrap(), "protected");
        assert!(error.contains(&recovery.display().to_string()));
    }
}
