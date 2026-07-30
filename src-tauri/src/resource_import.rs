use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::Path;
use uuid::Uuid;

pub const MAX_IMPORTED_RESOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_IMPORTED_RESOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedResource {
    pub name: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
    pub base64: String,
}

pub fn infer_mime_type(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("pdf") => "application/pdf",
        Some("txt" | "md") => "text/plain",
        Some("json") => "application/json",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn safe_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 10
                && value.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string())
}

pub fn safe_resource_file_name(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let stem = stem.trim_matches('-');
    let stem = if stem.is_empty() { "file" } else { stem };
    format!("{stem}.{}", safe_extension(file_name))
}

pub fn resource_path_for(file_name: &str, is_image: bool) -> String {
    let prefix = if is_image {
        "assets/image"
    } else {
        "attachments/file"
    };
    format!(
        "{}-{}.{}",
        prefix,
        Uuid::new_v4().simple(),
        safe_extension(file_name)
    )
}

pub fn import_resource_file(path: &Path) -> Result<ImportedResource, String> {
    let metadata = fs::metadata(path).map_err(|err| err.to_string())?;
    if !metadata.is_file() {
        return Err("只能导入普通文件。".to_string());
    }
    if metadata.len() > MAX_IMPORTED_RESOURCE_BYTES {
        return Err("导入文件超过 512 MiB 限制。".to_string());
    }

    let original_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无效。".to_string())?
        .to_string();
    let mime_type = infer_mime_type(&original_name).to_string();
    let is_image = mime_type.starts_with("image/");
    let bytes = fs::read(path).map_err(|err| err.to_string())?;

    Ok(ImportedResource {
        name: resource_path_for(&original_name, is_image),
        original_name,
        mime_type,
        size: metadata.len(),
        kind: if is_image { "asset" } else { "attachment" }.to_string(),
        base64: general_purpose::STANDARD.encode(bytes),
    })
}
