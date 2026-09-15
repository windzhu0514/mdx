//! Standard UTF-8 Markdown uses the shared editor and ordinary files, without a metadata sidecar.
use crate::export::{
    encode_destination, resource_destinations, resource_references, rewrite_destinations,
};
use crate::markdown_resources::{local_reference_path, reference_suffix};
use crate::{
    disk_revision, file_watch, MdxMetadata, MdxSaveRequest, ResourceData, ResourceKind,
    ResourceMeta,
};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::State;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SourceFormat {
    #[default]
    Markdown,
    Mdx,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExpectedRevision {
    path: String,
    modified_at_ms: u128,
    size: u64,
}

impl ExpectedRevision {
    fn matches(&self, current: &crate::DiskRevision) -> bool {
        self.path == current.path
            && self.modified_at_ms == current.modified_at_ms
            && self.size == current.size
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownSaveRequest {
    #[serde(flatten)]
    note: MdxSaveRequest,
    #[serde(default)]
    source_format: SourceFormat,
    expected_revision: Option<ExpectedRevision>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownNote {
    path: String,
    title: String,
    content: String,
    meta: MdxMetadata,
    disk_revision: Option<crate::DiskRevision>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownSaveResult {
    #[serde(flatten)]
    note: MarkdownNote,
    resource_rewrites: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

pub(crate) fn validate_document(path: &Path) -> Result<(), String> {
    if is_markdown_path(path) {
        fs::read_to_string(path)
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        crate::validate_mdx_path(path)
    }
}

#[tauri::command]
pub(crate) fn open_markdown(path: String) -> Result<MarkdownNote, String> {
    let path = Path::new(&path);
    if !is_markdown_path(path) {
        return Err("仅支持 .md 和 .markdown 文件。".to_string());
    }
    let _transaction = crate::DOCUMENT_FILE_TRANSACTION
        .lock()
        .map_err(|_| "文档恢复锁不可用。".to_string())?;
    let content =
        fs::read_to_string(path).map_err(|error| format!("无法读取 Markdown：{error}"))?;
    note_from_content(path, content)
}

fn resource_metadata(reference: &str, path: &Path) -> Option<ResourceMeta> {
    let info = fs::metadata(path).ok()?;
    if !info.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    Some(ResourceMeta {
        id: crate::new_resource_id(),
        original_name: name.clone(),
        stored_name: name.clone(),
        path: reference.to_string(),
        mime_type: crate::infer_mime_type(&name).to_string(),
        size: info.len(),
        width: None,
        height: None,
        created_at: String::new(),
    })
}

fn dedicated_folder(path: &Path) -> Result<String, String> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Markdown 文件名无效。".to_string())?;
    Ok(format!("{stem}_files"))
}

pub(crate) fn stored_resource_references(path: &Path) -> Vec<String> {
    let Ok(folder) = dedicated_folder(path) else {
        return Vec::new();
    };
    let root = path.parent().unwrap_or_else(|| Path::new(""));
    if !fs::symlink_metadata(root.join(&folder))
        .is_ok_and(|entry| entry.is_dir() && !entry.file_type().is_symlink())
    {
        return Vec::new();
    }
    let mut references = Vec::new();
    for kind in ["assets", "attachments"] {
        let relative = format!("{folder}/{kind}");
        let directory = root.join(&relative);
        if !fs::symlink_metadata(&directory)
            .is_ok_and(|entry| entry.is_dir() && !entry.file_type().is_symlink())
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        // Only this note's flat managed directories are discovered; never follow links or traverse other directories.
        references.extend(
            entries
                .take(10_000_usize.saturating_sub(references.len()))
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| {
                    encode_destination(&format!(
                        "{relative}/{}",
                        entry.file_name().to_string_lossy()
                    ))
                }),
        );
    }
    references.sort();
    references
}

fn note_from_content(path: &Path, content: String) -> Result<MarkdownNote, String> {
    let parsed = crate::markdown_import::parse_markdown(path, &content)?;
    let front = parsed.front_matter.unwrap_or_default();
    let mut meta = MdxMetadata::default();
    meta.title = parsed.title.clone();
    meta.tags = front.tags;
    meta.summary = front.summary;
    meta.author = front.author;
    meta.category = front.categories.join(", ");
    meta.word_count = crate::count_words(&content);
    let mut references: BTreeMap<String, String> = resource_references(&content)
        .into_iter()
        .map(|reference| (content[reference.range].to_string(), reference.destination))
        .collect();
    references.extend(
        stored_resource_references(path)
            .into_iter()
            .map(|reference| (reference.clone(), reference)),
    );
    let mut loaded = BTreeSet::new();
    for (reference, destination) in references {
        if let Ok(Some(local)) = local_reference_path(path, &destination) {
            // Deduplicate aliases without changing their actual Markdown destinations.
            let identity = fs::canonicalize(&local).unwrap_or_else(|_| local.clone());
            if !loaded.insert(identity) {
                continue;
            }
            if let Some(resource) = resource_metadata(&reference, &local) {
                if resource.mime_type.starts_with("image/") {
                    meta.assets.push(resource);
                } else {
                    meta.attachments.push(resource);
                }
            }
        }
    }
    Ok(MarkdownNote {
        path: path.to_string_lossy().to_string(),
        title: parsed.title,
        content,
        meta,
        disk_revision: disk_revision(path).revision,
    })
}

fn read_local_bytes(path: &Path) -> Result<Vec<u8>, String> {
    read_local_bytes_limited(path, crate::MAX_IMPORTED_RESOURCE_BYTES)
}

fn read_local_bytes_limited(path: &Path, remaining: u64) -> Result<Vec<u8>, String> {
    let limit = remaining.min(crate::MAX_IMPORTED_RESOURCE_BYTES);
    let file = File::open(path)
        .map_err(|error| format!("无法读取本地资源 {}：{error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("资源必须是普通文件。".to_string());
    }
    if metadata.len() > limit {
        return Err("RESOURCE_LIMIT：资源超过单文件或剩余总量限制。".to_string());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("RESOURCE_LIMIT：资源超过单文件或剩余总量限制。".to_string());
    }
    Ok(bytes)
}

// The public resource commands receive a source literal. Only a matching syntax node gives
// permission to decode it; metadata/managed filenames without a matching node stay literal.
pub(crate) fn resource_reference_literal(
    source: &Path,
    reference: &str,
    markdown: Option<&str>,
) -> String {
    if !reference.contains(['&', '\\']) {
        return reference.to_string();
    }
    let stored;
    let markdown = match markdown {
        Some(markdown) => Some(markdown),
        None => {
            stored = if is_markdown_path(source) {
                fs::read_to_string(source).ok()
            } else {
                crate::read_mdx(source).ok().map(|note| note.content)
            };
            stored.as_deref()
        }
    };
    markdown
        .and_then(|content| crate::export::reference_destination(content, reference))
        .unwrap_or_else(|| reference.to_string())
}

fn resolved_reference<'a>(
    reference: &'a str,
    resolutions: &'a BTreeMap<String, String>,
) -> &'a str {
    resolutions
        .get(reference)
        .map(String::as_str)
        .unwrap_or(reference)
}

#[tauri::command]
pub(crate) fn read_markdown_resource(
    source_path: String,
    reference: String,
    markdown: Option<String>,
) -> Result<crate::ImportedResource, String> {
    let destination =
        resource_reference_literal(Path::new(&source_path), &reference, markdown.as_deref());
    let local = local_reference_path(Path::new(&source_path), &destination)?
        .ok_or_else(|| "该引用不是本地资源。".to_string())?;
    let bytes = read_local_bytes(&local)?;
    let original_name = local
        .file_name()
        .ok_or_else(|| "资源文件名无效。".to_string())?
        .to_string_lossy()
        .to_string();
    let mime_type = crate::infer_mime_type(&original_name).to_string();
    Ok(crate::ImportedResource {
        name: reference,
        original_name,
        kind: if mime_type.starts_with("image/") {
            "asset"
        } else {
            "attachment"
        }
        .to_string(),
        mime_type,
        size: bytes.len() as u64,
        base64: general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub(crate) fn save_markdown(
    watch_state: State<file_watch::DocumentWatchState>,
    request: MarkdownSaveRequest,
    path: String,
) -> Result<MarkdownSaveResult, String> {
    let path = PathBuf::from(path);
    let guard = watch_state.begin_internal_write(&path);
    let result = save_markdown_file(request, &path)?;
    let fingerprint = file_watch::ContentFingerprint::from_bytes(result.note.content.as_bytes());
    if let Ok(snapshot) = file_watch::read_file_snapshot(&path) {
        if snapshot.fingerprint == fingerprint {
            guard.finish(snapshot.revision, fingerprint);
        }
    }
    Ok(result)
}

pub(crate) fn pending_bytes(resource: &ResourceData) -> Result<Vec<u8>, String> {
    if resource.base64.len() as u64 > (crate::MAX_IMPORTED_RESOURCE_BYTES + 2) / 3 * 4 + 4 {
        return Err("资源超过 512 MiB 限制。".to_string());
    }
    let bytes = general_purpose::STANDARD
        .decode(&resource.base64)
        .map_err(|error| format!("资源解码失败：{error}"))?;
    if bytes.len() as u64 > crate::MAX_IMPORTED_RESOURCE_BYTES {
        return Err("资源超过 512 MiB 限制。".to_string());
    }
    Ok(bytes)
}

// New resources never replace existing files: an old Markdown file or another note may still use them.
fn write_new_resource(
    parent: &Path,
    folder: &str,
    name: &str,
    bytes: &[u8],
    created: &mut Vec<PathBuf>,
) -> Result<String, String> {
    let directory = parent.join(folder);
    let mut checked = parent.to_path_buf();
    for component in Path::new(folder).components() {
        let Component::Normal(part) = component else {
            return Err("资源目录无效。".to_string());
        };
        checked.push(part);
        match fs::symlink_metadata(&checked) {
            Ok(info) if info.file_type().is_symlink() || !info.is_dir() => {
                return Err("资源目录不是安全的普通目录。".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&checked).map_err(|error| error.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let safe = crate::resource_import::safe_resource_file_name(name);
    let mut candidate = safe.clone();
    loop {
        let path = directory.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                created.push(path);
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|error| error.to_string())?;
                return Ok(encode_destination(&format!("{folder}/{candidate}")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Reuse byte-identical ordinary files only, and never follow a preexisting symlink.
                if fs::symlink_metadata(&path)
                    .is_ok_and(|info| info.is_file() && !info.file_type().is_symlink())
                    && read_local_bytes(&path).is_ok_and(|existing| existing == bytes)
                {
                    return Ok(encode_destination(&format!("{folder}/{candidate}")));
                }
                let stem = Path::new(&safe)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy();
                let extension = Path::new(&safe)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy();
                candidate = format!("{stem}-{}.{}", uuid::Uuid::new_v4().simple(), extension);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

pub(crate) fn checked_resource_total(total: u64, additional: u64) -> Result<u64, String> {
    total
        .checked_add(additional)
        .filter(|sum| *sum <= crate::MAX_TOTAL_IMPORTED_RESOURCE_BYTES)
        .ok_or_else(|| "RESOURCE_LIMIT：资源总大小超过 2 GiB 限制。".to_string())
}

fn save_markdown_file(
    request: MarkdownSaveRequest,
    path: &Path,
) -> Result<MarkdownSaveResult, String> {
    save_markdown_with_writer(
        request,
        path,
        crate::document_export::safe_write_bytes_exclusive,
    )
}

fn save_markdown_with_writer<F>(
    request: MarkdownSaveRequest,
    path: &Path,
    writer: F,
) -> Result<MarkdownSaveResult, String>
where
    F: FnOnce(&Path, &[u8]) -> Result<(), String>,
{
    let _transaction = crate::DOCUMENT_FILE_TRANSACTION
        .lock()
        .map_err(|_| "文档保存锁不可用。".to_string())?;
    if !is_markdown_path(path) {
        return Err("Markdown 保存路径必须使用 .md 或 .markdown 后缀。".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "保存路径缺少父目录。".to_string())?;
    for suffix in [".tmp", ".bak"] {
        let companion = crate::document_export::companion_path(path, suffix);
        if fs::symlink_metadata(&companion).is_ok() {
            return Err(format!(
                "目标旁存在 {suffix} 文件，已保留现有文件；请选择其他保存位置。"
            ));
        }
    }
    let source = request.note.path.as_deref().map(Path::new);
    let same_file = source
        .is_some_and(|source| crate::path_identity(source).ok() == crate::path_identity(path).ok());
    if same_file && request.source_format == SourceFormat::Mdx {
        return Err("格式转换必须使用不同的目标文件，已保留源文件。".to_string());
    }
    let initial_revision = disk_revision(path).revision;
    if !request.overwrite {
        if let Some(expected) = &request.expected_revision {
            if initial_revision
                .as_ref()
                .is_none_or(|current| !expected.matches(current))
            {
                return Err("EXTERNAL_CONFLICT：文件已被外部修改。".to_string());
            }
        }
    }
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let copy_existing = request.source_format == SourceFormat::Mdx || !same_file;
    let managed_folder = dedicated_folder(path)?;
    let mut replacements = BTreeMap::new();
    let mut to_write = BTreeMap::<String, (String, String, Vec<u8>)>::new();
    let removed: BTreeSet<&str> = request
        .note
        .removed_resources
        .iter()
        .map(String::as_str)
        .collect();
    let pending: BTreeMap<&str, &ResourceData> = request
        .note
        .new_assets
        .iter()
        .map(|resource| (resource.name.as_str(), resource))
        .collect();
    let mut warning = Vec::new();
    let mut aliases = BTreeMap::<String, String>::new();
    let resolutions: BTreeMap<String, String> = resource_references(&request.note.content)
        .into_iter()
        .map(|reference| {
            (
                request.note.content[reference.range].to_string(),
                reference.destination,
            )
        })
        .collect();
    let mut total_bytes = 0_u64;
    let pending_paths: BTreeMap<PathBuf, String> = pending
        .keys()
        .filter_map(|reference| {
            local_reference_path(
                source.unwrap_or(path),
                resolved_reference(reference, &resolutions),
            )
            .ok()
            .flatten()
            .map(|path| {
                (
                    crate::markdown_resources::normalize_source_path(&path),
                    (*reference).to_string(),
                )
            })
        })
        .collect();
    if request.source_format == SourceFormat::Mdx {
        if let Some(source) = source {
            for (name, bytes) in crate::collect_preserved_entries(source)? {
                if !(name.starts_with("assets/") || name.starts_with("attachments/"))
                    || removed.contains(name.as_str())
                    || pending.contains_key(name.as_str())
                {
                    continue;
                }
                let kind = if name.starts_with("assets/") {
                    "assets"
                } else {
                    "attachments"
                };
                let original = name.rsplit('/').next().unwrap_or("file").to_string();
                total_bytes = checked_resource_total(total_bytes, bytes.len() as u64)?;
                to_write.insert(name, (kind.to_string(), original, bytes));
            }
        }
    } else if copy_existing {
        if let Some(source) = source {
            let mut references: BTreeSet<String> = resource_destinations(&request.note.content)
                .into_iter()
                .map(|range| request.note.content[range].to_string())
                .collect();
            references.extend(stored_resource_references(source));
            if let Some(meta) = &request.note.meta {
                references.extend(
                    meta.attachments
                        .iter()
                        .map(|resource| resource.path.clone()),
                );
            }
            let mut loaded = BTreeMap::<PathBuf, String>::new();
            for reference in references {
                if removed.contains(reference.as_str()) || pending.contains_key(reference.as_str())
                {
                    continue;
                }
                let Some(local) =
                    local_reference_path(source, resolved_reference(&reference, &resolutions))?
                else {
                    continue;
                };
                let identity = crate::markdown_resources::normalize_source_path(&local);
                if let Some(first) = pending_paths
                    .get(&identity)
                    .or_else(|| loaded.get(&identity))
                {
                    aliases.insert(reference, first.clone());
                    continue;
                }
                loaded.insert(identity, reference.clone());
                match read_local_bytes_limited(
                    &local,
                    crate::MAX_TOTAL_IMPORTED_RESOURCE_BYTES.saturating_sub(total_bytes),
                ) {
                    Ok(bytes) => {
                        let name = local
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let kind = if crate::infer_mime_type(&name).starts_with("image/") {
                            "assets"
                        } else {
                            "attachments"
                        };
                        total_bytes = checked_resource_total(total_bytes, bytes.len() as u64)?;
                        to_write.insert(reference, (kind.to_string(), name, bytes));
                    }
                    Err(error) => {
                        if error.starts_with("RESOURCE_LIMIT") {
                            return Err(error);
                        }
                        // Preserve the old location for missing/unreadable references after moving the document.
                        if let Ok(url) = url::Url::from_file_path(&local) {
                            replacements.insert(
                                reference.clone(),
                                format!(
                                    "{url}{}",
                                    reference_suffix(resolved_reference(&reference, &resolutions))
                                ),
                            );
                        }
                        warning.push(error);
                    }
                }
            }
        }
    }
    for resource in &request.note.new_assets {
        if removed.contains(resource.name.as_str()) {
            continue;
        }
        let kind = match resource.kind {
            ResourceKind::Asset => "assets",
            ResourceKind::Attachment => "attachments",
        };
        let name = resource
            .name
            .rsplit('/')
            .next()
            .unwrap_or(&resource.original_name)
            .to_string();
        let estimated = (resource.base64.len() as u64 / 4 * 3).saturating_sub(
            resource
                .base64
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'=')
                .count() as u64,
        );
        checked_resource_total(total_bytes, estimated)?;
        let bytes = pending_bytes(resource)?;
        total_bytes = checked_resource_total(total_bytes, bytes.len() as u64)?;
        to_write.insert(resource.name.clone(), (kind.to_string(), name, bytes));
    }
    // Map URI-escaped and fragment-bearing aliases to the same persisted bytes.
    if let Some(source) = source {
        let source_keys: BTreeMap<PathBuf, String> = to_write
            .keys()
            .filter_map(|reference| {
                (if request.source_format == SourceFormat::Mdx {
                    Ok(Some(
                        source
                            .parent()
                            .unwrap_or_else(|| Path::new(""))
                            .join(reference),
                    ))
                } else {
                    local_reference_path(source, resolved_reference(reference, &resolutions))
                })
                .ok()
                .flatten()
                .map(|path| {
                    (
                        crate::markdown_resources::normalize_source_path(&path),
                        reference.clone(),
                    )
                })
            })
            .collect();
        for range in resource_destinations(&request.note.content) {
            let reference = &request.note.content[range];
            if to_write.contains_key(reference) || replacements.contains_key(reference) {
                continue;
            }
            if let Some(first) =
                local_reference_path(source, resolved_reference(reference, &resolutions))
                    .ok()
                    .flatten()
                    .and_then(|path| {
                        source_keys.get(&crate::markdown_resources::normalize_source_path(&path))
                    })
            {
                aliases.insert(reference.to_string(), first.clone());
            }
        }
    }
    let mut created = Vec::new();
    let result = (|| {
        for (reference, (kind, name, bytes)) in &to_write {
            let folder = if kind == "assets"
                && !copy_existing
                && pending.contains_key(reference.as_str())
                && reference.starts_with(&format!("{kind}/"))
            {
                kind.clone()
            } else {
                format!("{managed_folder}/{kind}")
            };
            let destination = write_new_resource(parent, &folder, name, bytes, &mut created)?;
            replacements.insert(
                reference.clone(),
                format!(
                    "{destination}{}",
                    resolutions
                        .get(reference)
                        .map(|value| reference_suffix(value))
                        .unwrap_or("")
                ),
            );
        }
        for (alias, first) in &aliases {
            if let Some(destination) = replacements.get(first) {
                let base = &destination[..destination.len() - reference_suffix(destination).len()];
                replacements.insert(
                    alias.clone(),
                    format!(
                        "{base}{}",
                        reference_suffix(resolved_reference(alias, &resolutions))
                    ),
                );
            }
        }
        for destination in replacements.values_mut() {
            *destination = crate::export::serialize_destination(destination);
        }
        let content = rewrite_destinations(&request.note.content, &replacements);
        // Check again after resource IO, immediately before the .tmp/.bak commit.
        if !request.overwrite && disk_revision(path).revision != initial_revision {
            return Err("EXTERNAL_CONFLICT：保存期间文件已被外部修改。".to_string());
        }
        if let Err(error) = writer(path, content.as_bytes()) {
            // safe_write_bytes can report a backup-cleanup error after committing the new document.
            if fs::read(path).is_ok_and(|bytes| bytes == content.as_bytes()) {
                warning.push(error);
            } else {
                return Err(error);
            }
        }
        let note = note_from_content(path, content)?;
        Ok(MarkdownSaveResult {
            note,
            resource_rewrites: replacements,
            warning: if warning.is_empty() {
                None
            } else {
                Some(warning.join("\n"))
            },
        })
    })();
    if result.is_err() {
        for resource in created {
            let _ = fs::remove_file(resource);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(path: Option<&Path>, content: &str) -> MarkdownSaveRequest {
        MarkdownSaveRequest {
            note: MdxSaveRequest {
                path: path.map(|path| path.to_string_lossy().to_string()),
                title: "test".to_string(),
                content: content.to_string(),
                meta: None,
                new_assets: Vec::new(),
                removed_resources: Vec::new(),
            },
            source_format: SourceFormat::Markdown,
            expected_revision: None,
            overwrite: false,
        }
    }
    fn image(name: &str, bytes: &[u8]) -> ResourceData {
        ResourceData {
            name: name.to_string(),
            original_name: "image.png".to_string(),
            mime_type: "image/png".to_string(),
            size: bytes.len() as u64,
            kind: ResourceKind::Asset,
            base64: general_purpose::STANDARD.encode(bytes),
        }
    }
    #[test]
    fn same_directory_save_as_keeps_unreferenced_managed_attachment() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old.md");
        let target = root.path().join("new.md");
        fs::create_dir_all(root.path().join("old_files/attachments")).unwrap();
        fs::write(root.path().join("old_files/attachments/manual.pdf"), b"pdf").unwrap();
        fs::write(&source, "body").unwrap();
        save_markdown_file(request(Some(&source), "body"), &target).unwrap();
        assert_eq!(
            open_markdown(target.to_string_lossy().to_string())
                .unwrap()
                .meta
                .attachments
                .len(),
            1
        );
    }
    #[test]
    fn pending_rekeyed_resource_can_be_saved_again_without_duplicates() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        let mut first = request(None, "![image](assets/image.png)");
        first
            .note
            .new_assets
            .push(image("assets/image.png", b"image"));
        let saved = save_markdown_file(first, &path).unwrap();
        let reference = &saved.resource_rewrites["assets/image.png"];
        let mut second = request(Some(&path), &saved.note.content);
        second.note.new_assets.push(image(reference, b"image"));
        let saved_again = save_markdown_file(second, &path).unwrap();
        assert_eq!(saved_again.note.content, saved.note.content);
        assert_eq!(
            fs::read_dir(root.path().join("note_files/assets"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn mdx_conversion_rewrites_fragment_and_encoded_resource_aliases() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mdx");
        let target = root.path().join("target.md");
        let text = "![image](assets/my%20image.png#view)";
        let bytes = crate::build_mdx_archive(
            None,
            &MdxMetadata::default(),
            text,
            &[image("assets/my image.png", b"image")],
            &BTreeSet::new(),
        )
        .unwrap();
        fs::write(&source, bytes).unwrap();
        let mut save = request(Some(&source), text);
        save.source_format = SourceFormat::Mdx;
        let saved = save_markdown_file(save, &target).unwrap();
        assert_eq!(
            saved.note.content,
            "![image](target_files/assets/my-image.png#view)"
        );
        assert_eq!(
            read_markdown_resource(
                target.to_string_lossy().to_string(),
                "target_files/assets/my-image.png#view".to_string(),
                None,
            )
            .unwrap()
            .base64,
            general_purpose::STANDARD.encode(b"image")
        );
    }
    #[test]
    fn opening_and_saving_markdown_never_claim_existing_companion_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        let backup = crate::document_export::companion_path(&path, ".bak");
        fs::write(&backup, "other editor backup").unwrap();
        assert!(open_markdown(path.to_string_lossy().to_string()).is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "other editor backup");
        fs::write(&path, "body").unwrap();
        assert_eq!(
            open_markdown(path.to_string_lossy().to_string())
                .unwrap()
                .content,
            "body"
        );
        assert_eq!(fs::read_to_string(&backup).unwrap(), "other editor backup");
        assert!(save_markdown_file(request(Some(&path), "changed"), &path).is_err());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "other editor backup");
        fs::remove_file(&backup).unwrap();
        let temporary = crate::document_export::companion_path(&path, ".tmp");
        fs::write(&temporary, "other editor temporary").unwrap();
        assert!(save_markdown_file(request(Some(&path), "changed"), &path).is_err());
        assert_eq!(
            fs::read_to_string(temporary).unwrap(),
            "other editor temporary"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "body");
    }
    #[test]
    fn standard_markdown_to_mdx_to_markdown_roundtrip_preserves_source_and_all_resources() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("原始 note.md");
        let image_path = root.path().join("图片 一.png");
        let attachment_path = root.path().join("说明 文档.pdf");
        fs::write(&image_path, b"image bytes").unwrap();
        fs::write(&attachment_path, b"attachment bytes").unwrap();
        let text = "\u{feff}---\r\ntitle: 标题\r\nunknown: { nested: [one, two] }\r\nexample: '![yaml](absent.png)'\r\n---\r\n\r\n![inline](%E5%9B%BE%E7%89%87%20%E4%B8%80.png)\n![reference][image]\n\n[image]: <图片 一.png>\n\n<img src=\"图片 一.png\">\n\n[manual](<说明 文档.pdf>)\n\n```markdown\n![fake](absent.png)\n```\n";
        fs::write(&source, text).unwrap();
        let before: Vec<_> = [&source, &image_path, &attachment_path]
            .into_iter()
            .map(|path| Sha256::digest(fs::read(path).unwrap()))
            .collect();
        let opened = open_markdown(source.to_string_lossy().to_string()).unwrap();
        let plan = crate::markdown_resources::prepare_markdown_resources(&source, &opened.content)
            .unwrap();
        assert_eq!(plan.resources.len(), 2);
        assert!(plan.items.iter().all(|item| item.status == "ready"));
        let mut resources: Vec<ResourceData> = plan
            .resources
            .into_iter()
            .map(|resource| ResourceData {
                name: resource.name,
                original_name: resource.original_name,
                mime_type: resource.mime_type,
                size: resource.size,
                kind: if resource.kind == "asset" {
                    ResourceKind::Asset
                } else {
                    ResourceKind::Attachment
                },
                base64: resource.base64,
            })
            .collect();
        resources.push(ResourceData {
            name: "attachments/unreferenced.pdf".to_string(),
            original_name: "unreferenced.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 6,
            kind: ResourceKind::Attachment,
            base64: general_purpose::STANDARD.encode(b"orphan"),
        });
        let archive = root.path().join("packed.mdx");
        crate::save_to_path_with_fingerprint(
            MdxSaveRequest {
                path: None,
                title: "packed".to_string(),
                content: plan.rewritten_content.clone(),
                meta: Some(opened.meta),
                new_assets: resources,
                removed_resources: Vec::new(),
            },
            archive.clone(),
        )
        .unwrap();
        let packed = crate::read_mdx(&archive).unwrap();
        assert_eq!(packed.manifest.format, "MDXNote");
        assert_eq!(packed.content, plan.rewritten_content);
        assert!(packed
            .content
            .contains("unknown: { nested: [one, two] }\r\n"));
        let destination = root.path().join("converted/最终 note.markdown");
        let mut convert = request(Some(&archive), &packed.content);
        convert.source_format = SourceFormat::Mdx;
        convert.note.meta = Some(packed.meta);
        save_markdown_file(convert, &destination).unwrap();
        let reopened = open_markdown(destination.to_string_lossy().to_string()).unwrap();
        assert!(reopened.content.starts_with("\u{feff}---\r\ntitle: 标题\r\nunknown: { nested: [one, two] }\r\nexample: '![yaml](absent.png)'\r\n---\r\n\r\n"));
        assert!(reopened
            .content
            .contains("```markdown\n![fake](absent.png)\n```"));
        assert_eq!(reopened.meta.assets.len(), 1);
        assert_eq!(reopened.meta.attachments.len(), 2);
        for range in resource_destinations(&reopened.content) {
            let reference = &reopened.content[range];
            let loaded = read_markdown_resource(
                destination.to_string_lossy().to_string(),
                reference.to_string(),
                None,
            )
            .unwrap();
            assert!(!loaded.base64.is_empty());
        }
        for (index, path) in [&source, &image_path, &attachment_path]
            .into_iter()
            .enumerate()
        {
            assert_eq!(Sha256::digest(fs::read(path).unwrap()), before[index]);
        }
    }
    #[test]
    fn unreferenced_pending_attachment_is_discoverable_after_same_file_save() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "body").unwrap();
        let mut save = request(Some(&path), "body");
        save.note.new_assets.push(ResourceData {
            name: "attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            kind: ResourceKind::Attachment,
            base64: general_purpose::STANDARD.encode(b"pdf"),
        });
        let saved = save_markdown_file(save, &path).unwrap();
        assert_eq!(saved.note.content, "body");
        assert_eq!(saved.note.meta.attachments.len(), 1);
        assert_eq!(
            open_markdown(path.to_string_lossy().to_string())
                .unwrap()
                .meta
                .attachments
                .len(),
            1
        );
    }
    #[test]
    fn pending_attachment_fragment_uses_pending_bytes_without_touching_old_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "body").unwrap();
        fs::create_dir(root.path().join("attachments")).unwrap();
        fs::write(root.path().join("attachments/manual.pdf"), b"old").unwrap();
        let mut save = request(Some(&path), "[manual](attachments/manual.pdf#page=2)");
        save.note.new_assets.push(ResourceData {
            name: "attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            kind: ResourceKind::Attachment,
            base64: general_purpose::STANDARD.encode(b"new"),
        });
        let saved = save_markdown_file(save, &path).unwrap();
        assert_eq!(
            saved.note.content,
            "[manual](note_files/attachments/manual.pdf#page=2)"
        );
        assert_eq!(
            fs::read(root.path().join("note_files/attachments/manual.pdf")).unwrap(),
            b"new"
        );
        assert_eq!(
            fs::read(root.path().join("attachments/manual.pdf")).unwrap(),
            b"old"
        );
    }
    #[test]
    fn racing_temporary_file_is_preserved_and_document_commit_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "old").unwrap();
        let temporary = crate::document_export::companion_path(&path, ".tmp");
        let result =
            save_markdown_with_writer(request(Some(&path), "new"), &path, |target, bytes| {
                fs::write(&temporary, "other editor").unwrap();
                crate::document_export::safe_write_bytes_exclusive(target, bytes)
            });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "other editor");
    }
    #[test]
    fn resource_reads_respect_remaining_budget_before_allocating() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("resource.bin");
        fs::write(&path, b"12345678").unwrap();
        assert!(read_local_bytes_limited(&path, 4)
            .unwrap_err()
            .starts_with("RESOURCE_LIMIT"));
        assert!(checked_resource_total(crate::MAX_TOTAL_IMPORTED_RESOURCE_BYTES - 2, 3).is_err());
        assert_eq!(fs::read(path).unwrap(), b"12345678");
    }
    #[test]
    fn raw_markdown_roundtrip_keeps_bom_yaml_and_crlf() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.markdown");
        let text = "\u{feff}---\r\ntitle: Raw\r\ncustom: [a, b]\r\n---\r\n\r\n# Body\r\n";
        fs::write(&path, text).unwrap();
        let opened = open_markdown(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(opened.content, text);
        save_markdown_file(request(Some(&path), &opened.content), &path).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), text);
    }
    #[test]
    fn save_as_copies_local_image_and_attachment_without_modifying_source() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.md");
        let target = root.path().join("other/target.md");
        fs::write(root.path().join("my image.png"), b"image").unwrap();
        fs::write(root.path().join("manual.pdf"), b"pdf").unwrap();
        let text = "![img][i]\n\n[i]: my%20image.png\n\n[manual](manual.pdf#page=2)\n`![code](not-real.png)`";
        fs::write(&source, text).unwrap();
        let saved = save_markdown_file(request(Some(&source), text), &target).unwrap();
        assert_eq!(fs::read_to_string(source).unwrap(), text);
        assert!(saved.note.content.contains("`![code](not-real.png)`"));
        for resource in saved
            .note
            .meta
            .assets
            .iter()
            .chain(saved.note.meta.attachments.iter())
        {
            assert!(local_reference_path(&target, &resource.path)
                .unwrap()
                .unwrap()
                .is_file());
        }
        assert!(saved.note.content.contains("#page=2"));
        assert_eq!(saved.note.meta.assets.len(), 1);
        assert_eq!(saved.note.meta.attachments.len(), 1);
    }
    #[test]
    fn pending_image_collision_never_overwrites_external_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "old").unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::write(root.path().join("assets/image.png"), b"original").unwrap();
        let mut save = request(Some(&path), "![new](assets/image.png)");
        save.note.new_assets.push(image("assets/image.png", b"new"));
        let result = save_markdown_file(save, &path).unwrap();
        assert_eq!(
            fs::read(root.path().join("assets/image.png")).unwrap(),
            b"original"
        );
        assert_ne!(
            result.resource_rewrites["assets/image.png"],
            "assets/image.png"
        );
    }
    #[test]
    fn failed_document_commit_removes_only_created_resources() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "old").unwrap();
        let mut save = request(Some(&path), "![new](assets/image.png)");
        save.note.new_assets.push(image("assets/image.png", b"new"));
        let result = save_markdown_with_writer(save, &path, |target, bytes| {
            crate::document_export::safe_write_bytes_exclusive_with_rename(
                target,
                bytes,
                |from, to| {
                    if from == crate::document_export::companion_path(target, ".tmp") {
                        Err(std::io::Error::other("injected commit failure"))
                    } else {
                        fs::rename(from, to)
                    }
                },
            )
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "old");
        assert!(!root.path().join("assets/image.png").exists());
    }
    #[test]
    fn cleanup_error_after_commit_keeps_new_resources() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "old").unwrap();
        let mut save = request(Some(&path), "![new](assets/image.png)");
        save.note.new_assets.push(image("assets/image.png", b"new"));
        let result = save_markdown_with_writer(save, &path, |path, bytes| {
            fs::write(path, bytes).unwrap();
            Err("backup cleanup failure".to_string())
        })
        .unwrap();
        assert!(result.warning.is_some());
        assert!(root.path().join("assets/image.png").is_file());
    }
    #[test]
    fn external_revision_conflict_preserves_document_and_resources() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("note.md");
        fs::write(&path, "external").unwrap();
        let mut save = request(Some(&path), "replacement");
        save.expected_revision = Some(ExpectedRevision {
            path: String::new(),
            modified_at_ms: 0,
            size: 0,
        });
        assert!(save_markdown_file(save, &path)
            .unwrap_err()
            .contains("EXTERNAL_CONFLICT"));
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }
    #[test]
    fn entity_resource_literals_read_and_convert_without_double_decoding() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("entities.md");
        let files: [(&str, &[u8]); 6] = [
            ("a&b.png", b"amp"),
            ("copy©.png", b"copy"),
            ("decimal&.png", b"decimal"),
            ("hex©.png", b"hex"),
            ("literal&copy;.png", b"literal-copy"),
            ("literal&amp;b.png", b"literal-amp"),
        ];
        for (name, bytes) in files {
            fs::write(root.path().join(name), bytes).unwrap();
        }
        fs::write(root.path().join("literal©.png"), b"wrong double decoding").unwrap();
        fs::write(
            root.path().join("literal&b.png"),
            b"wrong percent/entity order",
        )
        .unwrap();
        let cases: [(&str, &[u8]); 6] = [
            ("a&amp;b.png", b"amp"),
            ("copy&copy;.png", b"copy"),
            ("decimal&#38;.png", b"decimal"),
            ("hex&#xA9;.png", b"hex"),
            ("literal&amp;copy;.png", b"literal-copy"),
            ("literal%26amp%3Bb.png", b"literal-amp"),
        ];
        let mut content = String::new();
        for (literal, _) in cases {
            content.push_str(&format!(
                "![image]({literal})\n\n<img src=\"{literal}\">\n\n"
            ));
        }
        content.push_str("![fragment](a&amp;b.png#literal&amp;copy;)\n\n");
        content.push_str("```markdown\n![fake](not&amp;present.png)\n```\n");
        fs::write(&source, &content).unwrap();
        let opened = open_markdown(source.to_string_lossy().to_string()).unwrap();
        assert_eq!(opened.meta.assets.len(), 6);
        for (literal, expected) in cases {
            let loaded = read_markdown_resource(
                source.to_string_lossy().to_string(),
                literal.to_string(),
                None,
            )
            .unwrap();
            assert_eq!(loaded.name, literal);
            assert_eq!(
                general_purpose::STANDARD.decode(loaded.base64).unwrap(),
                expected
            );
        }
        // A literal filename without a matching syntax node is not guessed to be an entity.
        let direct = read_markdown_resource(
            source.to_string_lossy().to_string(),
            "literal&copy;.png".to_string(),
            Some(String::new()),
        )
        .unwrap();
        assert_eq!(
            general_purpose::STANDARD.decode(direct.base64).unwrap(),
            b"literal-copy"
        );
        let plan =
            crate::markdown_resources::prepare_markdown_resources(&source, &content).unwrap();
        assert_eq!(plan.resources.len(), 6);
        assert!(crate::export::resource_references(&plan.rewritten_content)
            .iter()
            .any(|reference| reference.destination.ends_with("#literal&copy;")));
        assert!(plan.items.iter().all(|item| item.status == "ready"));
        let expected: BTreeSet<Vec<u8>> =
            files.into_iter().map(|(_, bytes)| bytes.to_vec()).collect();
        assert_eq!(
            plan.resources
                .iter()
                .map(|resource| general_purpose::STANDARD.decode(&resource.base64).unwrap())
                .collect::<BTreeSet<_>>(),
            expected
        );
        let target = root.path().join("converted/result.md");
        let saved = save_markdown_file(request(Some(&source), &content), &target).unwrap();
        assert!(saved.warning.is_none());
        assert_eq!(saved.note.meta.assets.len(), 6);
        assert!(crate::export::resource_references(&saved.note.content)
            .iter()
            .any(|reference| reference.destination.ends_with("#literal&copy;")));
        let copied: BTreeSet<Vec<u8>> = saved
            .note
            .meta
            .assets
            .iter()
            .map(|resource| {
                read_local_bytes(
                    &local_reference_path(&target, &resource.path)
                        .unwrap()
                        .unwrap(),
                )
                .unwrap()
            })
            .collect();
        assert_eq!(copied, expected);
        assert!(saved.note.content.contains("![fake](not&amp;present.png)"));
        assert_eq!(fs::read_to_string(source).unwrap(), content);
    }

    #[test]
    fn mdx_to_markdown_to_mdx_keeps_unreferenced_images_and_attachments() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original.mdx");
        let markdown = root.path().join("plain.md");
        let repacked = root.path().join("repacked.mdx");
        let attachment = ResourceData {
            kind: ResourceKind::Attachment,
            name: "attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            base64: general_purpose::STANDARD.encode(b"pdf"),
        };
        let original_bytes = crate::build_mdx_archive(
            None,
            &MdxMetadata::default(),
            "# No resource links",
            &[attachment, image("assets/unused.png", b"png")],
            &BTreeSet::new(),
        )
        .unwrap();
        fs::write(&original, &original_bytes).unwrap();
        let mut convert = request(Some(&original), "# No resource links");
        convert.source_format = SourceFormat::Mdx;
        save_markdown_file(convert, &markdown).unwrap();
        let reopened = open_markdown(markdown.to_string_lossy().to_string()).unwrap();
        let plan =
            crate::markdown_resources::prepare_markdown_resources(&markdown, &reopened.content)
                .unwrap();
        assert_eq!(plan.resources.len(), 2, "reopened stored resources must be included without pending resources or body references");
        assert_eq!(reopened.meta.attachments.len(), 1);
        assert_eq!(reopened.meta.assets.len(), 1);
        assert_eq!(plan.rewritten_content, "# No resource links");
        assert_eq!(plan.resource_rewrites.len(), 2);
        let resources: Vec<ResourceData> = plan
            .resources
            .into_iter()
            .map(|resource| ResourceData {
                name: resource.name,
                original_name: resource.original_name,
                mime_type: resource.mime_type,
                size: resource.size,
                kind: if resource.kind == "asset" {
                    ResourceKind::Asset
                } else {
                    ResourceKind::Attachment
                },
                base64: resource.base64,
            })
            .collect();
        crate::save_to_path_with_fingerprint(
            MdxSaveRequest {
                path: None,
                title: "repacked".to_string(),
                content: plan.rewritten_content,
                meta: None,
                new_assets: resources,
                removed_resources: Vec::new(),
            },
            repacked.clone(),
        )
        .unwrap();
        let packed = crate::read_mdx(&repacked).unwrap();
        assert_eq!(packed.content, "# No resource links");
        assert_eq!(packed.meta.assets.len(), 1);
        assert_eq!(packed.meta.attachments.len(), 1);
        assert_eq!(
            crate::read_archive_resource_bytes(&repacked, "assets/unused.png").unwrap(),
            b"png"
        );
        assert_eq!(
            crate::read_archive_resource_bytes(&repacked, "attachments/manual.pdf").unwrap(),
            b"pdf"
        );
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        assert_eq!(fs::read_to_string(markdown).unwrap(), "# No resource links");
    }

    #[test]
    fn mdx_conversion_keeps_unreferenced_attachments_on_reopen() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mdx");
        let target = root.path().join("target.md");
        let meta = MdxMetadata::default();
        let attachment = ResourceData {
            kind: ResourceKind::Attachment,
            name: "attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            base64: general_purpose::STANDARD.encode(b"pdf"),
        };
        let bytes =
            crate::build_mdx_archive(None, &meta, "# Body", &[attachment], &BTreeSet::new())
                .unwrap();
        fs::write(&source, &bytes).unwrap();
        let mut save = request(Some(&source), "# Body");
        save.source_format = SourceFormat::Mdx;
        let saved = save_markdown_file(save, &target).unwrap();
        assert_eq!(saved.note.content, "# Body");
        let reopened = open_markdown(target.to_string_lossy().to_string()).unwrap();
        assert_eq!(reopened.meta.attachments.len(), 1);
        assert_eq!(fs::read(source).unwrap(), bytes);
    }
}
