mod ai;
mod archive_security;
mod document_export;
mod draft_store;
mod export;
mod history;
pub mod markdown_import;
pub mod markdown_resources;
mod note_index;
mod path_identity;
mod recent_files;
mod resource_import;
mod system_fonts;
mod window_state;
pub mod workspace;
mod workspace_session;

use ai::AiRequestState;
use archive_security::validate_archive;
pub use archive_security::{
    parse_supported_format_version, validate_archive_entry_name, validate_new_resource_name,
};
pub use draft_store::{
    delete_draft_file, read_draft_file, read_latest_draft_file, validate_draft_key,
    write_draft_file,
};
pub use export::export_markdown_file;
pub use history::{
    list_history_file, new_history_entry, read_history_file, trim_history_entries,
    HistoryArchiveEntry, HistoryListItem, HistorySnapshot,
};
pub use markdown_resources::{
    prepare_markdown_resources, MarkdownResourceItem, MarkdownResourcePlan,
};
pub use note_index::{
    list_index_entries, refresh_workspace_index, search_index_entries, source_revision,
    upsert_index_entry, IndexSourceRevision, NoteIndexEntry, NoteSearchResult,
    WorkspaceIndexFailure, WorkspaceIndexRefresh,
};
pub use path_identity::{normalize_path, path_identity};
pub use recent_files::{
    push_recent_entry, read_recent_file, remove_recent_entry, write_recent_file, RecentFileEntry,
    MAX_RECENT_FILES,
};
pub use resource_import::{
    import_resource_file, infer_mime_type, resource_path_for, ImportedResource,
    MAX_IMPORTED_RESOURCE_BYTES, MAX_TOTAL_IMPORTED_RESOURCE_BYTES,
};
pub use workspace::{
    disk_revision, markdown_file_paths, scan_folder, DiskRevision, DiskRevisionResult, FolderScan,
    WorkspaceTreeEntry,
};
pub use workspace_session::{
    read_workspace_session_file, write_workspace_session_file, WorkspaceSessionRead,
};

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const INVALID_MDX_ERROR: &str = "这不是有效的 MDXNote 笔记文件。";

pub fn validate_archive_bytes(bytes: &[u8]) -> Result<(), String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|err| err.to_string())?;
    validate_archive(&mut archive)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MdxManifest {
    format: String,
    format_version: String,
    package_type: String,
    content_file: String,
    metadata_file: String,
    assets_dir: String,
    attachments_dir: String,
    thumbnails_dir: String,
    encoding: String,
    encrypted: bool,
    compression: String,
}

impl Default for MdxManifest {
    fn default() -> Self {
        Self {
            format: "MDXNote".to_string(),
            format_version: "1.0.0".to_string(),
            package_type: "single-note".to_string(),
            content_file: "content.md".to_string(),
            metadata_file: "meta.json".to_string(),
            assets_dir: "assets/".to_string(),
            attachments_dir: "attachments/".to_string(),
            thumbnails_dir: "thumbnails/".to_string(),
            encoding: "utf-8".to_string(),
            encrypted: false,
            compression: "zip".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResourceMeta {
    #[serde(default = "new_resource_id")]
    id: String,
    #[serde(default)]
    original_name: String,
    #[serde(default)]
    stored_name: String,
    #[serde(default)]
    path: String,
    #[serde(default, rename = "type")]
    mime_type: String,
    #[serde(default)]
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(default = "current_time_rfc3339")]
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MdxMetadata {
    #[serde(default = "new_note_id")]
    id: String,
    #[serde(default = "default_title")]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    author: String,
    #[serde(default = "current_time_rfc3339")]
    created_at: String,
    #[serde(default = "current_time_rfc3339")]
    updated_at: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    category: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    cover: String,
    #[serde(default)]
    word_count: usize,
    #[serde(default)]
    assets: Vec<ResourceMeta>,
    #[serde(default)]
    attachments: Vec<ResourceMeta>,
}

impl Default for MdxMetadata {
    fn default() -> Self {
        let now = current_time_rfc3339();
        Self {
            id: new_note_id(),
            title: default_title(),
            summary: String::new(),
            author: String::new(),
            created_at: now.clone(),
            updated_at: now,
            tags: Vec::new(),
            category: String::new(),
            favorite: false,
            archived: false,
            cover: String::new(),
            word_count: 0,
            assets: Vec::new(),
            attachments: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MdxNote {
    path: Option<String>,
    title: String,
    content: String,
    manifest: MdxManifest,
    meta: MdxMetadata,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathIdentity {
    path: String,
    identity: String,
    available: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResourceKind {
    Asset,
    Attachment,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceData {
    name: String,
    original_name: String,
    mime_type: String,
    size: u64,
    kind: ResourceKind,
    base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentReadRequest {
    document_id: String,
    source_path: Option<String>,
    resource_path: String,
    original_name: String,
    base64: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MdxSaveRequest {
    path: Option<String>,
    title: String,
    content: String,
    meta: Option<MdxMetadata>,
    #[serde(default)]
    new_assets: Vec<ResourceData>,
    #[serde(default)]
    removed_resources: Vec<String>,
}

#[tauri::command]
fn create_mdx() -> Result<MdxNote, String> {
    let content = String::new();
    let mut meta = MdxMetadata::default();
    meta.word_count = count_words(&content);

    Ok(MdxNote {
        path: None,
        title: meta.title.clone(),
        content,
        manifest: MdxManifest::default(),
        meta,
    })
}

#[tauri::command]
fn open_mdx(app: AppHandle, path: String) -> Result<MdxNote, String> {
    let note = read_mdx(Path::new(&path))?;
    let _ = index_note(&app, &note);
    Ok(note)
}

#[tauri::command]
fn resolve_path(path: String) -> Result<PathIdentity, String> {
    let normalized = normalize_path(Path::new(&path))?;
    Ok(PathIdentity {
        identity: path_identity(Path::new(&normalized))?,
        available: Path::new(&normalized).exists(),
        path: normalized,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRefreshResult {
    folder: FolderScan,
    index: WorkspaceIndexRefresh,
}

#[tauri::command]
async fn refresh_workspace_folder(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceRefreshResult, String> {
    let index_path = note_index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = scan_folder(Path::new(&path), 10_000)?;
        let files = markdown_file_paths(&folder);
        let index = refresh_workspace_index(
            &index_path,
            Path::new(&folder.path),
            &files,
            folder.truncated,
            load_index_entry,
        )?;
        Ok(WorkspaceRefreshResult { folder, index })
    })
    .await
    .map_err(|error| format!("工作区索引任务失败：{error}"))?
}

#[tauri::command]
fn get_disk_revisions(paths: Vec<String>) -> Vec<DiskRevisionResult> {
    workspace::get_disk_revisions(paths)
}

#[tauri::command]
fn validate_mdx(path: String) -> Result<(), String> {
    let note = read_mdx(Path::new(&path))?;
    validate_manifest(&note.manifest)
}

#[tauri::command]
fn import_markdown(path: String) -> Result<markdown_import::ImportedMarkdown, String> {
    markdown_import::import_markdown_file(Path::new(&path))
}

#[tauri::command]
fn export_diagram_png(path: String, base64: String) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};

    let target = PathBuf::from(path);
    if target.as_os_str().is_empty() {
        return Err("PNG 导出路径为空。".to_string());
    }
    let bytes = general_purpose::STANDARD
        .decode(base64)
        .map_err(|error| format!("PNG 数据解码失败：{error}"))?;
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("导出数据不是有效的 PNG。".to_string());
    }
    fs::write(&target, bytes).map_err(|error| format!("写入 PNG 失败：{error}"))
}

#[tauri::command]
fn save_mdx(app: AppHandle, request: MdxSaveRequest) -> Result<MdxNote, String> {
    let path = request
        .path
        .clone()
        .ok_or_else(|| "请先选择保存位置。".to_string())?;
    let note = save_to_path(request, PathBuf::from(path))?;
    let _ = index_note(&app, &note);
    Ok(note)
}

#[tauri::command]
fn save_mdx_as(app: AppHandle, request: MdxSaveRequest, path: String) -> Result<MdxNote, String> {
    let note = save_to_path(request, PathBuf::from(path))?;
    let _ = index_note(&app, &note);
    Ok(note)
}

fn save_to_path(request: MdxSaveRequest, path: PathBuf) -> Result<MdxNote, String> {
    let target_path = ensure_mdx_extension(path);
    let source_path = request.path.as_deref().map(PathBuf::from);
    let removed_resources = validated_resource_paths(&request.removed_resources)?;
    let mut meta = request.meta.unwrap_or_default();
    let now = current_time_rfc3339();

    if meta.id.trim().is_empty() {
        meta.id = new_note_id();
    }
    if meta.created_at.trim().is_empty() {
        meta.created_at = now.clone();
    }

    meta.title = normalize_title(&request.title);
    meta.updated_at = now;
    meta.word_count = count_words(&request.content);
    meta.assets
        .retain(|resource| !removed_resources.contains(&resource.path));
    meta.attachments
        .retain(|resource| !removed_resources.contains(&resource.path));
    apply_resource_metadata(&mut meta, &request.new_assets);

    let archive_bytes = build_mdx_archive(
        source_path.as_deref(),
        &meta,
        &request.content,
        &request.new_assets,
        &removed_resources,
    )?;
    safe_write_file(&target_path, &archive_bytes)?;

    Ok(MdxNote {
        path: Some(target_path.to_string_lossy().to_string()),
        title: meta.title.clone(),
        content: request.content,
        manifest: MdxManifest::default(),
        meta,
    })
}

fn read_mdx(path: &Path) -> Result<MdxNote, String> {
    let file = File::open(path).map_err(|_| "无法打开文件。".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_archive(&mut archive)?;

    let manifest_text = read_zip_text(&mut archive, "manifest.json")?;
    let manifest: MdxManifest =
        serde_json::from_str(&manifest_text).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_manifest(&manifest)?;

    let meta_text = read_zip_text(&mut archive, &manifest.metadata_file)?;
    let mut meta: MdxMetadata =
        serde_json::from_str(&meta_text).map_err(|_| INVALID_MDX_ERROR.to_string())?;

    let content = read_zip_text(&mut archive, &manifest.content_file)?;
    if meta.title.trim().is_empty() {
        meta.title = default_title();
    }
    meta.word_count = count_words(&content);

    Ok(MdxNote {
        path: Some(path.to_string_lossy().to_string()),
        title: meta.title.clone(),
        content,
        manifest,
        meta,
    })
}

fn load_index_entry(path: &Path) -> Result<NoteIndexEntry, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("mdx") {
        let note = read_mdx(path)?;
        return Ok(NoteIndexEntry {
            path: note
                .path
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            title: note.title,
            tags: note.meta.tags,
            summary: note.meta.summary,
            updated_at: note.meta.updated_at,
            content: note.content,
            source_revision: None,
        });
    }
    if extension.eq_ignore_ascii_case("md") {
        let imported = markdown_import::import_markdown_file(path)?;
        let front_matter = imported.front_matter.unwrap_or_default();
        let modified = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .map_err(|error| format!("无法读取文件版本：{error}"))?;
        let updated_at = DateTime::<Utc>::from(modified).to_rfc3339();
        return Ok(NoteIndexEntry {
            path: path.to_string_lossy().to_string(),
            title: imported.title,
            tags: front_matter.tags,
            summary: front_matter.summary,
            updated_at,
            content: imported.content,
            source_revision: None,
        });
    }
    Err("索引仅支持 .md 和 .mdx 文件。".to_string())
}

#[tauri::command]
fn export_markdown(source_path: String, destination_path: String) -> Result<(), String> {
    export_markdown_file(Path::new(&source_path), Path::new(&destination_path))
}

#[tauri::command]
fn export_document(request: document_export::ExportDocumentRequest) -> Result<String, String> {
    document_export::export_document_file(request).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn import_resource(path: String) -> Result<ImportedResource, String> {
    import_resource_file(Path::new(&path))
}

#[tauri::command(rename = "prepare_markdown_resources")]
fn prepare_markdown_resources_command(
    source_path: String,
    markdown: String,
) -> Result<MarkdownResourcePlan, String> {
    markdown_resources::prepare_markdown_resources(Path::new(&source_path), &markdown)
}

#[tauri::command]
fn read_asset(path: String, asset_name: String) -> Result<String, String> {
    validate_new_resource_name(&asset_name)?;
    let bytes = read_archive_resource_bytes(Path::new(&path), &asset_name)?;

    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.encode(&bytes))
}

fn validate_attachment_path(path: &str) -> Result<(), String> {
    validate_new_resource_name(path).map_err(|error| format!("附件路径无效：{error}"))?;
    if !path.starts_with("attachments/") {
        return Err("附件路径必须位于 attachments/ 根目录。".to_string());
    }
    Ok(())
}

fn read_archive_resource_bytes(path: &Path, resource_path: &str) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| "无法打开文件。".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_archive(&mut archive)?;
    let mut resource = archive
        .by_name(resource_path)
        .map_err(|_| "未找到附件。".to_string())?;
    let mut bytes = Vec::new();
    resource
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取附件。".to_string())?;
    Ok(bytes)
}

fn read_attachment_bytes(request: &AttachmentReadRequest) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose, Engine as _};

    validate_attachment_path(&request.resource_path)?;
    if let Some(encoded) = request.base64.as_deref() {
        let maximum_encoded_length = ((MAX_IMPORTED_RESOURCE_BYTES.saturating_add(2)) / 3) * 4 + 4;
        if encoded.len() as u64 > maximum_encoded_length {
            return Err("附件超过 512 MiB 限制。".to_string());
        }
        let bytes = general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("附件数据解码失败：{error}"))?;
        if bytes.len() as u64 > MAX_IMPORTED_RESOURCE_BYTES {
            return Err("附件超过 512 MiB 限制。".to_string());
        }
        return Ok(bytes);
    }

    let source_path = request
        .source_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "附件来源不可用，请先保存文档。".to_string())?;
    read_archive_resource_bytes(Path::new(source_path), &request.resource_path)
}

fn attachment_cache_key(value: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn safe_attachment_file_name(original_name: &str) -> String {
    let file_name = Path::new(original_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    let cleaned = file_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim_matches(|character| matches!(character, ' ' | '.'));
    let cleaned = if cleaned.is_empty() {
        "attachment"
    } else {
        cleaned
    };
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or(cleaned)
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && matches!(&stem[..3], "COM" | "LPT")
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    }
}

fn write_attachment_preview(
    cache_root: &Path,
    request: &AttachmentReadRequest,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    validate_attachment_path(&request.resource_path)?;
    let preview_root = cache_root.join("attachment-preview");
    let preview_directory = preview_root
        .join(attachment_cache_key(&request.document_id))
        .join(attachment_cache_key(&request.resource_path));
    if !preview_directory.starts_with(&preview_root) {
        return Err("附件预览路径无效。".to_string());
    }
    if preview_directory.exists() {
        fs::remove_dir_all(&preview_directory)
            .map_err(|error| format!("清理附件预览失败：{error}"))?;
    }
    fs::create_dir_all(&preview_directory)
        .map_err(|error| format!("创建附件预览目录失败：{error}"))?;
    let preview_path = preview_directory.join(safe_attachment_file_name(&request.original_name));
    document_export::safe_write_bytes(&preview_path, bytes)?;
    Ok(preview_path)
}

fn export_attachment_bytes(target_path: &Path, bytes: &[u8]) -> Result<(), String> {
    document_export::safe_write_bytes(target_path, bytes)
}

#[tauri::command]
fn open_attachment(app: AppHandle, request: AttachmentReadRequest) -> Result<(), String> {
    let bytes = read_attachment_bytes(&request)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let preview_path = write_attachment_preview(&cache_root, &request, &bytes)?;
    tauri_plugin_opener::open_path(&preview_path, None::<&str>)
        .map_err(|error| format!("无法打开附件：{error}"))
}

#[tauri::command]
fn export_attachment(
    request: AttachmentReadRequest,
    destination_path: String,
) -> Result<(), String> {
    if destination_path.trim().is_empty() {
        return Err("附件导出路径为空。".to_string());
    }
    let bytes = read_attachment_bytes(&request)?;
    export_attachment_bytes(Path::new(&destination_path), &bytes)
}

fn note_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("notes-index.json"))
}

fn index_note(app: &AppHandle, note: &MdxNote) -> Result<(), String> {
    let Some(path) = &note.path else {
        return Ok(());
    };
    upsert_index_entry(
        &note_index_path(app)?,
        NoteIndexEntry {
            path: path.clone(),
            title: note.title.clone(),
            tags: note.meta.tags.clone(),
            summary: note.meta.summary.clone(),
            updated_at: note.meta.updated_at.clone(),
            content: note.content.clone(),
            source_revision: source_revision(Path::new(path)).ok(),
        },
    )
}

#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<NoteIndexEntry>, String> {
    list_index_entries(&note_index_path(&app)?)
}

#[tauri::command]
fn search_notes(app: AppHandle, query: String) -> Result<Vec<NoteSearchResult>, String> {
    search_index_entries(&note_index_path(&app)?, &query)
}

#[tauri::command]
fn list_history(path: String) -> Result<Vec<HistoryListItem>, String> {
    list_history_file(Path::new(&path))
}

#[tauri::command]
fn read_history(path: String, name: String) -> Result<HistorySnapshot, String> {
    read_history_file(Path::new(&path), &name)
}

fn drafts_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("drafts"))
}

#[tauri::command]
fn write_draft(app: AppHandle, key: String, draft: serde_json::Value) -> Result<(), String> {
    write_draft_file(&drafts_directory(&app)?, &key, &draft)
}

#[tauri::command]
fn read_draft(app: AppHandle, key: String) -> Result<Option<serde_json::Value>, String> {
    read_draft_file(&drafts_directory(&app)?, &key)
}
#[tauri::command]
fn read_latest_draft(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    read_latest_draft_file(&drafts_directory(&app)?)
}

fn workspace_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("workspace-session.json"))
}

#[tauri::command]
fn read_workspace_session(app: AppHandle) -> Result<WorkspaceSessionRead, String> {
    read_workspace_session_file(&workspace_session_path(&app)?)
}

#[tauri::command]
fn write_workspace_session(app: AppHandle, session: serde_json::Value) -> Result<(), String> {
    write_workspace_session_file(&workspace_session_path(&app)?, &session)
}
#[tauri::command]
fn delete_draft(app: AppHandle, key: String) -> Result<(), String> {
    delete_draft_file(&drafts_directory(&app)?, &key)
}

#[tauri::command]
fn get_recent_files(app: AppHandle) -> Result<Vec<RecentFileEntry>, String> {
    read_recent_files(&app)
}

#[tauri::command]
fn push_recent_file(
    app: AppHandle,
    path: String,
    title: String,
) -> Result<Vec<RecentFileEntry>, String> {
    let recent_files = push_recent_entry(
        read_recent_files(&app)?,
        path,
        normalize_title(&title),
        current_time_rfc3339(),
    )?;
    write_recent_files(&app, &recent_files)?;
    Ok(recent_files)
}

#[tauri::command]
fn remove_recent_file(app: AppHandle, path: String) -> Result<Vec<RecentFileEntry>, String> {
    let recent_files = remove_recent_entry(read_recent_files(&app)?, Path::new(&path))?;
    write_recent_files(&app, &recent_files)?;

    Ok(recent_files)
}

#[tauri::command]
fn clear_recent_files(app: AppHandle) -> Result<(), String> {
    write_recent_files(&app, &[])
}

fn read_recent_files(app: &AppHandle) -> Result<Vec<RecentFileEntry>, String> {
    read_recent_file(&recent_files_path(app)?)
}

fn write_recent_files(app: &AppHandle, recent_files: &[RecentFileEntry]) -> Result<(), String> {
    write_recent_file(&recent_files_path(app)?, recent_files)
}

fn recent_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    Ok(app_data_dir.join("recent-files.json"))
}

fn read_zip_text<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| INVALID_MDX_ERROR.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|_| INVALID_MDX_ERROR.to_string())?;
    Ok(text)
}

fn validate_manifest(manifest: &MdxManifest) -> Result<(), String> {
    if manifest.format != "MDXNote" {
        return Err(INVALID_MDX_ERROR.to_string());
    }

    parse_supported_format_version(&manifest.format_version)?;
    if manifest.package_type != "single-note"
        || !manifest.encoding.eq_ignore_ascii_case("utf-8")
        || !manifest.compression.eq_ignore_ascii_case("zip")
    {
        return Err(INVALID_MDX_ERROR.to_string());
    }
    validate_archive_entry_name(&manifest.content_file)?;
    validate_archive_entry_name(&manifest.metadata_file)?;
    if manifest.content_file.ends_with('/')
        || manifest.metadata_file.ends_with('/')
        || manifest.content_file == manifest.metadata_file
    {
        return Err(INVALID_MDX_ERROR.to_string());
    }

    if manifest.encrypted {
        return Err("当前版本暂不支持打开加密的 MDXNote 文件。".to_string());
    }

    Ok(())
}
fn apply_resource_metadata(meta: &mut MdxMetadata, resources: &[ResourceData]) {
    for resource in resources {
        let target = match resource.kind {
            ResourceKind::Asset => &mut meta.assets,
            ResourceKind::Attachment => &mut meta.attachments,
        };
        let stored_name = resource
            .name
            .rsplit('/')
            .next()
            .unwrap_or(&resource.name)
            .to_string();
        if let Some(entry) = target.iter_mut().find(|entry| entry.path == resource.name) {
            entry.original_name = resource.original_name.clone();
            entry.stored_name = stored_name;
            entry.mime_type = resource.mime_type.clone();
            entry.size = resource.size;
        } else {
            target.push(ResourceMeta {
                id: new_resource_id(),
                original_name: resource.original_name.clone(),
                stored_name,
                path: resource.name.clone(),
                mime_type: resource.mime_type.clone(),
                size: resource.size,
                width: None,
                height: None,
                created_at: current_time_rfc3339(),
            });
        }
    }
}

fn validated_resource_paths(
    paths: &[String],
) -> Result<std::collections::BTreeSet<String>, String> {
    let mut validated = std::collections::BTreeSet::new();
    for path in paths {
        validate_new_resource_name(path).map_err(|error| format!("资源路径无效：{error}"))?;
        validated.insert(path.clone());
    }
    Ok(validated)
}

fn build_mdx_archive(
    source_path: Option<&Path>,
    meta: &MdxMetadata,
    content: &str,
    new_assets: &[ResourceData],
    removed_resources: &std::collections::BTreeSet<String>,
) -> Result<Vec<u8>, String> {
    let preservation_source = source_path.map(|path| {
        if path.exists() {
            path.to_path_buf()
        } else {
            document_export::companion_path(path, ".bak")
        }
    });
    let replacement_resources = new_assets
        .iter()
        .map(|resource| resource.name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut preserved_entries: Vec<HistoryArchiveEntry> = preservation_source
        .as_deref()
        .map(collect_preserved_entries)
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .filter(|(name, _)| {
            !removed_resources.contains(name) && !replacement_resources.contains(name.as_str())
        })
        .map(|(name, bytes)| HistoryArchiveEntry { name, bytes })
        .collect();
    if let Some(source_path) = preservation_source.as_deref().filter(|path| path.exists()) {
        if let Ok(previous) = read_mdx(source_path) {
            let meta_value = serde_json::to_value(&previous.meta).map_err(|err| err.to_string())?;
            preserved_entries.push(new_history_entry(
                &previous.title,
                &previous.content,
                meta_value,
            )?);
        }
    }
    let preserved_entries = trim_history_entries(preserved_entries, 20);
    let manifest = MdxManifest::default();
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);

    write_zip_directory(&mut writer, "assets/")?;
    write_zip_directory(&mut writer, "attachments/")?;
    write_zip_directory(&mut writer, "thumbnails/")?;
    write_zip_directory(&mut writer, "history/")?;

    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
    let meta_json = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;

    write_zip_file(&mut writer, "manifest.json", manifest_json.as_bytes())?;
    write_zip_file(&mut writer, "meta.json", meta_json.as_bytes())?;
    write_zip_file(&mut writer, "content.md", content.as_bytes())?;

    for entry in preserved_entries {
        write_zip_file(&mut writer, &entry.name, &entry.bytes)?;
    }

    use base64::{engine::general_purpose, Engine as _};
    for asset in new_assets {
        validate_new_resource_name(&asset.name)?;
        let bytes = general_purpose::STANDARD
            .decode(&asset.base64)
            .map_err(|err| format!("图片解码失败: {err}"))?;
        write_zip_file(&mut writer, &asset.name, &bytes)?;
    }

    let cursor = writer.finish().map_err(|err| err.to_string())?;
    Ok(cursor.into_inner())
}

fn write_zip_directory<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    name: &str,
) -> Result<(), String> {
    let options = zip_file_options();
    writer
        .add_directory(name, options)
        .map_err(|err| err.to_string())
}

fn write_zip_file<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let options = zip_file_options();
    writer
        .start_file(name, options)
        .map_err(|err| err.to_string())?;
    writer.write_all(bytes).map_err(|err| err.to_string())
}

fn zip_file_options() -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn collect_preserved_entries(source_path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !source_path.exists() {
        return Err("源 MDX 文件不可用，无法保留资源。".to_string());
    }

    let invalid_source = || "源 MDX 文件无效，无法保留资源。".to_string();
    let file = File::open(source_path)
        .map_err(|error| format!("源 MDX 文件不可用，无法保留资源：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|_| invalid_source())?;
    validate_archive(&mut archive).map_err(|_| invalid_source())?;

    let manifest_text =
        read_zip_text(&mut archive, "manifest.json").map_err(|_| invalid_source())?;
    let manifest: MdxManifest =
        serde_json::from_str(&manifest_text).map_err(|_| invalid_source())?;
    validate_manifest(&manifest).map_err(|_| invalid_source())?;

    let mut entries = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        let name = file.name().replace('\\', "/");

        if file.is_dir() || !should_preserve_zip_entry(&name) {
            continue;
        }

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| err.to_string())?;
        entries.push((name, bytes));
    }

    Ok(entries)
}

fn should_preserve_zip_entry(name: &str) -> bool {
    if validate_archive_entry_name(name).is_err() {
        return false;
    }

    name.starts_with("assets/")
        || name.starts_with("attachments/")
        || name.starts_with("thumbnails/")
        || name.starts_with("history/")
        || name.starts_with("exports/")
}

fn validate_new_mdx_bytes(bytes: &[u8]) -> Result<(), String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_archive(&mut archive)?;

    let manifest_text = read_zip_text(&mut archive, "manifest.json")?;
    let manifest: MdxManifest =
        serde_json::from_str(&manifest_text).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_manifest(&manifest)?;

    let meta_text = read_zip_text(&mut archive, &manifest.metadata_file)?;
    serde_json::from_str::<MdxMetadata>(&meta_text).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    read_zip_text(&mut archive, &manifest.content_file)?;
    Ok(())
}

fn recover_interrupted_save(target_path: &Path) -> Result<(), String> {
    let backup_path = document_export::companion_path(target_path, ".bak");
    if !backup_path.exists() {
        return Ok(());
    }

    if !target_path.exists() {
        fs::rename(&backup_path, target_path).map_err(|err| err.to_string())?;
        return Ok(());
    }

    if read_mdx(target_path).is_ok() {
        fs::remove_file(&backup_path).map_err(|err| err.to_string())?;
        return Ok(());
    }

    fs::remove_file(target_path).map_err(|err| err.to_string())?;
    fs::rename(&backup_path, target_path).map_err(|err| err.to_string())
}

fn safe_write_file(target_path: &Path, bytes: &[u8]) -> Result<(), String> {
    validate_new_mdx_bytes(bytes)?;
    recover_interrupted_save(target_path)?;
    document_export::safe_write_bytes(target_path, bytes)
}
fn ensure_mdx_extension(path: PathBuf) -> PathBuf {
    if path.extension().is_none() {
        return path.with_extension("mdx");
    }
    path
}

fn normalize_title(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        default_title()
    } else {
        title.to_string()
    }
}

fn count_words(content: &str) -> usize {
    content.chars().filter(|ch| !ch.is_whitespace()).count()
}

fn default_title() -> String {
    "无标题笔记".to_string()
}

fn current_time_rfc3339() -> String {
    Local::now().to_rfc3339()
}

fn random8() -> String {
    Uuid::new_v4().simple().to_string()[0..8].to_string()
}

fn new_note_id() -> String {
    format!(
        "note_{}_{}",
        Local::now().format("%Y%m%d_%H%M%S"),
        random8()
    )
}

fn new_resource_id() -> String {
    format!("res_{}", random8())
}

pub fn run() {
    let window_state_flags = window_state::tracked_state_flags();
    tauri::Builder::default()
        .manage(AiRequestState::default())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let _ = window_state::fit_and_show_main_window(webview.app_handle());
            }
        })
        .setup(|app| {
            let _ = window_state::restore_main_window_state(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai::save_ai_api_key,
            ai::delete_ai_api_key,
            ai::has_ai_api_key,
            ai::stream_ai,
            ai::cancel_ai,
            create_mdx,
            open_mdx,
            resolve_path,
            save_mdx,
            save_mdx_as,
            validate_mdx,
            import_markdown,
            export_markdown,
            export_document,
            export_diagram_png,
            import_resource,
            prepare_markdown_resources_command,
            read_asset,
            open_attachment,
            export_attachment,
            list_notes,
            search_notes,
            list_history,
            read_history,
            write_draft,
            read_draft,
            read_latest_draft,
            read_workspace_session,
            write_workspace_session,
            delete_draft,
            get_recent_files,
            push_recent_file,
            remove_recent_file,
            clear_recent_files,
            refresh_workspace_folder,
            get_disk_revisions,
            system_fonts::list_system_font_families
        ])
        .run(tauri::generate_context!())
        .expect("error while running MDXNote application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_font_names_are_sorted_and_deduplicated_case_insensitively() {
        assert_eq!(
            system_fonts::normalize_font_family_names([
                "Segoe UI".to_string(),
                "inter".to_string(),
                "Inter".to_string(),
                "  ".to_string(),
            ]),
            vec!["inter".to_string(), "Segoe UI".to_string()]
        );
    }

    #[test]
    fn resource_metadata_is_added_and_deduplicated() {
        let mut meta = MdxMetadata::default();
        let resource = ResourceData {
            name: "assets/a.png".to_string(),
            original_name: "a.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 1,
            kind: ResourceKind::Asset,
            base64: "YQ==".to_string(),
        };

        apply_resource_metadata(&mut meta, &[resource.clone(), resource]);

        assert_eq!(meta.assets.len(), 1);
        assert_eq!(meta.assets[0].path, "assets/a.png");
        assert_eq!(meta.assets[0].original_name, "a.png");
        assert!(meta.attachments.is_empty());
    }

    #[test]
    fn attachment_metadata_is_stored_separately() {
        let mut meta = MdxMetadata::default();
        let resource = ResourceData {
            name: "attachments/a.pdf".to_string(),
            original_name: "a.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 42,
            kind: ResourceKind::Attachment,
            base64: "YQ==".to_string(),
        };

        apply_resource_metadata(&mut meta, &[resource]);

        assert!(meta.assets.is_empty());
        assert_eq!(meta.attachments.len(), 1);
        assert_eq!(meta.attachments[0].size, 42);
    }

    #[test]
    fn saved_attachment_deletion_removes_metadata_and_zip_bytes() {
        let dir = temp_test_dir("attachment-delete");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        write_note_with_resources(
            &source,
            &[
                ("attachments/keep.txt", b"keep"),
                ("attachments/delete.txt", b"delete"),
            ],
        );

        let request = save_request_for(
            &source,
            vec!["attachments/delete.txt".to_string()],
            Vec::new(),
        );
        let saved = save_to_path(request, source.clone()).unwrap();

        assert_eq!(
            saved
                .meta
                .attachments
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec!["attachments/keep.txt"]
        );
        assert_eq!(
            read_zip_bytes(&source, "attachments/keep.txt").unwrap(),
            b"keep"
        );
        assert!(read_zip_bytes(&source, "attachments/delete.txt").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_as_copies_source_resources_and_ignores_target_resources() {
        let dir = temp_test_dir("attachment-save-as");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        let target = dir.join("target.mdx");
        write_note_with_resources(&source, &[("attachments/source.txt", b"source")]);
        write_note_with_resources(&target, &[("attachments/target.txt", b"target")]);

        save_to_path(
            save_request_for(&source, Vec::new(), Vec::new()),
            target.clone(),
        )
        .unwrap();

        assert_eq!(
            read_zip_bytes(&target, "attachments/source.txt").unwrap(),
            b"source"
        );
        assert!(read_zip_bytes(&target, "attachments/target.txt").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_as_rejects_a_missing_source_instead_of_dropping_resources() {
        let dir = temp_test_dir("attachment-save-as-missing-source");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        let target = dir.join("target.mdx");
        write_note_with_resources(&source, &[("attachments/source.txt", b"source")]);
        let request = save_request_for(&source, Vec::new(), Vec::new());
        fs::remove_file(&source).unwrap();

        let error = save_to_path(request, target.clone()).unwrap_err();

        assert!(error.contains("源 MDX 文件"));
        assert!(!target.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_recovers_an_interrupted_backup_without_dropping_resources() {
        let dir = temp_test_dir("attachment-save-backup-source");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        write_note_with_resources(&source, &[("attachments/source.txt", b"source")]);
        let request = save_request_for(&source, Vec::new(), Vec::new());
        let backup = document_export::companion_path(&source, ".bak");
        fs::rename(&source, &backup).unwrap();

        save_to_path(request, source.clone()).unwrap();

        assert_eq!(
            read_zip_bytes(&source, "attachments/source.txt").unwrap(),
            b"source"
        );
        assert!(!backup.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn attachment_deletion_rejects_unsafe_paths() {
        let dir = temp_test_dir("attachment-delete-invalid");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        write_note_with_resources(&source, &[("attachments/keep.txt", b"keep")]);

        let error = save_to_path(
            save_request_for(
                &source,
                vec!["attachments/../keep.txt".to_string()],
                Vec::new(),
            ),
            source.clone(),
        )
        .unwrap_err();

        assert!(error.contains("资源路径"));
        assert_eq!(
            read_zip_bytes(&source, "attachments/keep.txt").unwrap(),
            b"keep"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn new_attachment_replaces_preserved_bytes_without_duplicate_entries() {
        let dir = temp_test_dir("attachment-replace");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        write_note_with_resources(&source, &[("attachments/a.txt", b"old")]);
        let replacement = resource_data("attachments/a.txt", b"new");

        save_to_path(
            save_request_for(&source, Vec::new(), vec![replacement]),
            source.clone(),
        )
        .unwrap();

        assert_eq!(
            read_zip_bytes(&source, "attachments/a.txt").unwrap(),
            b"new"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn attachment_bytes_are_read_from_archive_or_base64() {
        let dir = temp_test_dir("attachment-bytes");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mdx");
        write_note_with_resources(&source, &[("attachments/a.txt", b"archived")]);
        let archived = attachment_request(Some(source), None, "attachments/a.txt", "a.txt");
        let pending = attachment_request(None, Some("cGVuZGluZw=="), "attachments/b.txt", "b.txt");

        assert_eq!(read_attachment_bytes(&archived).unwrap(), b"archived");
        assert_eq!(read_attachment_bytes(&pending).unwrap(), b"pending");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn attachment_bytes_reject_unsafe_non_attachment_and_missing_sources() {
        for resource_path in ["attachments/../a.txt", "assets/a.png"] {
            let error = read_attachment_bytes(&attachment_request(
                None,
                Some("YQ=="),
                resource_path,
                "a.txt",
            ))
            .unwrap_err();
            assert!(error.contains("附件路径"));
        }

        let error = read_attachment_bytes(&attachment_request(
            None,
            None,
            "attachments/a.txt",
            "a.txt",
        ))
        .unwrap_err();
        assert!(error.contains("来源"));
    }

    #[test]
    fn attachment_preview_stays_in_cache_and_replaces_its_previous_copy() {
        let dir = temp_test_dir("attachment-preview");
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let first_request =
            attachment_request(None, Some("Zmlyc3Q="), "attachments/a.txt", "../CON");
        let first = write_attachment_preview(&cache, &first_request, b"first").unwrap();

        assert!(first.starts_with(&cache));
        assert_eq!(fs::read(&first).unwrap(), b"first");
        assert!(!first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .eq_ignore_ascii_case("CON"));

        let second_request =
            attachment_request(None, Some("c2Vjb25k"), "attachments/a.txt", "second.txt");
        let second = write_attachment_preview(&cache, &second_request, b"second").unwrap();

        assert!(!first.exists());
        assert_eq!(fs::read(&second).unwrap(), b"second");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn attachment_export_replaces_an_existing_file_safely() {
        let dir = temp_test_dir("attachment-export");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("export.txt");
        fs::write(&target, b"old").unwrap();

        export_attachment_bytes(&target, b"new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!document_export::companion_path(&target, ".tmp").exists());
        assert!(!document_export::companion_path(&target, ".bak").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diagram_png_export_decodes_and_validates_png_bytes() {
        let dir = temp_test_dir("diagram-png");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("diagram.png");

        export_diagram_png(
            target.to_string_lossy().to_string(),
            "iVBORw0KGgo=".to_string(),
        )
        .unwrap();

        assert_eq!(
            fs::read(&target).unwrap(),
            [137, 80, 78, 71, 13, 10, 26, 10]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diagram_png_export_rejects_non_png_data() {
        let dir = temp_test_dir("invalid-diagram-png");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("diagram.png");

        let error = export_diagram_png(
            target.to_string_lossy().to_string(),
            "bm90LXBuZw==".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("PNG"));
        assert!(!target.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    fn temp_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mora-{}-{}", label, Uuid::new_v4().simple()))
    }

    fn resource_data(name: &str, bytes: &[u8]) -> ResourceData {
        use base64::{engine::general_purpose, Engine as _};
        ResourceData {
            name: name.to_string(),
            original_name: name.rsplit('/').next().unwrap().to_string(),
            mime_type: "application/octet-stream".to_string(),
            size: bytes.len() as u64,
            kind: if name.starts_with("assets/") {
                ResourceKind::Asset
            } else {
                ResourceKind::Attachment
            },
            base64: general_purpose::STANDARD.encode(bytes),
        }
    }

    fn write_note_with_resources(path: &Path, resources: &[(&str, &[u8])]) {
        let new_assets = resources
            .iter()
            .map(|(name, bytes)| resource_data(name, bytes))
            .collect();
        save_to_path(
            MdxSaveRequest {
                path: None,
                title: "Fixture".to_string(),
                content: String::new(),
                meta: Some(MdxMetadata::default()),
                new_assets,
                removed_resources: Vec::new(),
            },
            path.to_path_buf(),
        )
        .unwrap();
    }

    fn save_request_for(
        source: &Path,
        removed_resources: Vec<String>,
        new_assets: Vec<ResourceData>,
    ) -> MdxSaveRequest {
        let note = read_mdx(source).unwrap();
        let mut request: MdxSaveRequest = serde_json::from_value(serde_json::json!({
            "path": source.to_string_lossy(),
            "title": note.title,
            "content": note.content,
            "meta": note.meta,
            "newAssets": [],
            "removedResources": removed_resources,
        }))
        .unwrap();
        request.new_assets = new_assets;
        request
    }

    fn read_zip_bytes(path: &Path, name: &str) -> Result<Vec<u8>, String> {
        let mut archive = ZipArchive::new(File::open(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let mut entry = archive.by_name(name).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }

    fn attachment_request(
        source_path: Option<PathBuf>,
        base64: Option<&str>,
        resource_path: &str,
        original_name: &str,
    ) -> AttachmentReadRequest {
        AttachmentReadRequest {
            document_id: "note-fixture".to_string(),
            source_path: source_path.map(|path| path.to_string_lossy().into_owned()),
            resource_path: resource_path.to_string(),
            original_name: original_name.to_string(),
            base64: base64.map(str::to_string),
        }
    }

    #[test]
    fn index_loader_maps_markdown_front_matter() {
        let dir = temp_test_dir("index-markdown");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(
            &path,
            "---\ntitle: 项目计划\ntags: [工作, 计划]\nsummary: 本周目标\n---\n正文内容",
        )
        .unwrap();

        let entry = load_index_entry(&path).unwrap();

        assert_eq!(entry.title, "项目计划");
        assert_eq!(entry.tags, ["工作", "计划"]);
        assert_eq!(entry.summary, "本周目标");
        assert_eq!(entry.content, "正文内容");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn index_loader_maps_valid_mdx_metadata_and_content() {
        let dir = temp_test_dir("index-mdx");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.mdx");
        let mut meta = MdxMetadata::default();
        meta.tags = vec!["工作".to_string(), "计划".to_string()];
        meta.summary = "本周目标".to_string();
        save_to_path(
            MdxSaveRequest {
                path: None,
                title: "项目计划".to_string(),
                content: "正文内容".to_string(),
                meta: Some(meta),
                new_assets: Vec::new(),
                removed_resources: Vec::new(),
            },
            path.clone(),
        )
        .unwrap();

        let entry = load_index_entry(&path).unwrap();

        assert_eq!(entry.title, "项目计划");
        assert_eq!(entry.tags, ["工作", "计划"]);
        assert_eq!(entry.summary, "本周目标");
        assert_eq!(entry.content, "正文内容");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn index_loader_rejects_invalid_mdx_without_falling_back_to_markdown() {
        let dir = temp_test_dir("invalid-index-mdx");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invalid.mdx");
        fs::write(&path, b"not-a-zip").unwrap();

        assert_eq!(load_index_entry(&path).unwrap_err(), INVALID_MDX_ERROR);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn safe_write_rejects_invalid_archives_without_replacing_original() {
        let dir = temp_test_dir("invalid-save");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("note.mdx");
        fs::write(&target, b"original").unwrap();

        assert!(safe_write_file(&target, b"not-a-zip").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_backup_is_restored_when_target_is_missing() {
        let dir = temp_test_dir("backup-restore");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("note.mdx");
        let backup = target.with_extension("mdx.bak");
        fs::write(&backup, b"backup").unwrap();

        recover_interrupted_save(&target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"backup");
        assert!(!backup.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
