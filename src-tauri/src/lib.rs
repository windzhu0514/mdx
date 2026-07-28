mod archive_security;
mod draft_store;
mod export;
mod history;
pub mod markdown_import;
mod note_index;
mod resource_import;

use archive_security::validate_archive;
pub use archive_security::{
    parse_supported_format_version, validate_archive_entry_name, validate_new_resource_name,
};
pub use draft_store::{
    delete_draft_file, read_latest_draft_file, validate_draft_key, write_draft_file,
};
pub use export::export_markdown_file;
pub use history::{
    list_history_file, new_history_entry, read_history_file, trim_history_entries,
    HistoryArchiveEntry, HistoryListItem, HistorySnapshot,
};
pub use note_index::{
    list_index_entries, search_index_entries, upsert_index_entry, NoteIndexEntry, NoteSearchResult,
};
pub use resource_import::{
    import_resource_file, infer_mime_type, resource_path_for, ImportedResource,
};

use chrono::Local;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFileEntry {
    path: String,
    title: String,
    last_opened_at: String,
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
struct MdxSaveRequest {
    path: Option<String>,
    title: String,
    content: String,
    meta: Option<MdxMetadata>,
    #[serde(default)]
    new_assets: Vec<ResourceData>,
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
fn validate_mdx(path: String) -> Result<(), String> {
    let note = read_mdx(Path::new(&path))?;
    validate_manifest(&note.manifest)
}

#[tauri::command]
fn import_markdown(path: String) -> Result<markdown_import::ImportedMarkdown, String> {
    markdown_import::import_markdown_file(Path::new(&path))
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
    apply_resource_metadata(&mut meta, &request.new_assets);

    let archive_bytes =
        build_mdx_archive(&target_path, &meta, &request.content, &request.new_assets)?;
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

#[tauri::command]
fn export_markdown(source_path: String, destination_path: String) -> Result<(), String> {
    export_markdown_file(Path::new(&source_path), Path::new(&destination_path))
}

#[tauri::command]
fn import_resource(path: String) -> Result<ImportedResource, String> {
    import_resource_file(Path::new(&path))
}

#[tauri::command]
fn read_asset(path: String, asset_name: String) -> Result<String, String> {
    use std::io::Read;
    let file = File::open(Path::new(&path)).map_err(|_| "无法打开文件。".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| INVALID_MDX_ERROR.to_string())?;
    validate_archive(&mut archive)?;
    validate_new_resource_name(&asset_name)?;

    let mut asset_file = archive
        .by_name(&asset_name)
        .map_err(|_| "未找到资产".to_string())?;
    let mut bytes = Vec::new();
    asset_file
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取资产".to_string())?;

    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.encode(&bytes))
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
fn read_latest_draft(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    read_latest_draft_file(&drafts_directory(&app)?)
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
    let normalized_path = ensure_mdx_extension(PathBuf::from(path))
        .to_string_lossy()
        .to_string();
    let mut recent_files = read_recent_files(&app)?;

    recent_files.retain(|item| item.path != normalized_path);
    recent_files.insert(
        0,
        RecentFileEntry {
            path: normalized_path,
            title: normalize_title(&title),
            last_opened_at: current_time_rfc3339(),
        },
    );
    recent_files.truncate(10);

    write_recent_files(&app, &recent_files)?;
    Ok(recent_files)
}

#[tauri::command]
fn remove_recent_file(app: AppHandle, path: String) -> Result<Vec<RecentFileEntry>, String> {
    let normalized_path = ensure_mdx_extension(PathBuf::from(path))
        .to_string_lossy()
        .to_string();
    let mut recent_files = read_recent_files(&app)?;

    recent_files.retain(|item| item.path != normalized_path);
    write_recent_files(&app, &recent_files)?;

    Ok(recent_files)
}

#[tauri::command]
fn clear_recent_files(app: AppHandle) -> Result<(), String> {
    write_recent_files(&app, &[])
}

fn read_recent_files(app: &AppHandle) -> Result<Vec<RecentFileEntry>, String> {
    let recent_files_path = recent_files_path(app)?;

    if !recent_files_path.exists() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&recent_files_path).map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn write_recent_files(app: &AppHandle, recent_files: &[RecentFileEntry]) -> Result<(), String> {
    let recent_files_path = recent_files_path(app)?;
    let parent = recent_files_path
        .parent()
        .ok_or_else(|| "最近打开列表路径无效。".to_string())?;

    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let json = serde_json::to_string_pretty(recent_files).map_err(|err| err.to_string())?;
    fs::write(recent_files_path, json).map_err(|err| err.to_string())
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
        target.retain(|entry| entry.path != resource.name);
        target.push(ResourceMeta {
            id: new_resource_id(),
            original_name: resource.original_name.clone(),
            stored_name: resource
                .name
                .rsplit('/')
                .next()
                .unwrap_or(&resource.name)
                .to_string(),
            path: resource.name.clone(),
            mime_type: resource.mime_type.clone(),
            size: resource.size,
            width: None,
            height: None,
            created_at: current_time_rfc3339(),
        });
    }
}

fn build_mdx_archive(
    target_path: &Path,
    meta: &MdxMetadata,
    content: &str,
    new_assets: &[ResourceData],
) -> Result<Vec<u8>, String> {
    let mut preserved_entries: Vec<HistoryArchiveEntry> = collect_preserved_entries(target_path)?
        .into_iter()
        .map(|(name, bytes)| HistoryArchiveEntry { name, bytes })
        .collect();
    if target_path.exists() {
        if let Ok(previous) = read_mdx(target_path) {
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

fn collect_preserved_entries(target_path: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !target_path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(target_path).map_err(|err| err.to_string())?;
    let mut archive = match ZipArchive::new(file) {
        Ok(archive) => archive,
        Err(_) => return Ok(Vec::new()),
    };
    if validate_archive(&mut archive).is_err() {
        return Ok(Vec::new());
    }

    let manifest_text = match read_zip_text(&mut archive, "manifest.json") {
        Ok(text) => text,
        Err(_) => return Ok(Vec::new()),
    };
    let manifest: MdxManifest = match serde_json::from_str(&manifest_text) {
        Ok(manifest) => manifest,
        Err(_) => return Ok(Vec::new()),
    };
    if validate_manifest(&manifest).is_err() {
        return Ok(Vec::new());
    }

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
    let backup_path = target_path.with_extension("mdx.bak");
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

    let parent = target_path
        .parent()
        .ok_or_else(|| "保存路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    recover_interrupted_save(target_path)?;

    let tmp_path = target_path.with_extension("mdx.tmp");
    let bak_path = target_path.with_extension("mdx.bak");
    if tmp_path.exists() {
        fs::remove_file(&tmp_path).map_err(|err| err.to_string())?;
    }

    let mut temporary = File::create(&tmp_path).map_err(|err| err.to_string())?;
    temporary.write_all(bytes).map_err(|err| err.to_string())?;
    temporary.sync_all().map_err(|err| err.to_string())?;
    drop(temporary);

    if target_path.exists() {
        fs::rename(target_path, &bak_path).map_err(|err| err.to_string())?;
        match fs::rename(&tmp_path, target_path) {
            Ok(()) => {
                let _ = fs::remove_file(&bak_path);
                Ok(())
            }
            Err(error) => {
                let restore_result = fs::rename(&bak_path, target_path);
                if let Err(restore_error) = restore_result {
                    return Err(format!(
                        "保存失败且无法恢复原文件：{error}；恢复错误：{restore_error}；临时文件：{}；备份文件：{}",
                        tmp_path.display(),
                        bak_path.display()
                    ));
                }
                Err(format!("保存失败，已恢复原文件：{error}"))
            }
        }
    } else {
        fs::rename(&tmp_path, target_path).map_err(|err| err.to_string())
    }
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_mdx,
            open_mdx,
            save_mdx,
            save_mdx_as,
            validate_mdx,
            import_markdown,
            export_markdown,
            import_resource,
            read_asset,
            list_notes,
            search_notes,
            list_history,
            read_history,
            write_draft,
            read_latest_draft,
            delete_draft,
            get_recent_files,
            push_recent_file,
            remove_recent_file,
            clear_recent_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running MDXNote application");
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn temp_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mora-{}-{}", label, Uuid::new_v4().simple()))
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
