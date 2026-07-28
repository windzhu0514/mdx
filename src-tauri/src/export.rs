use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

use crate::archive_security::{validate_archive, validate_archive_entry_name};

fn read_zip_text(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    validate_archive_entry_name(name)?;
    let mut file = archive.by_name(name).map_err(|err| err.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|err| err.to_string())?;
    Ok(text)
}

fn export_folder(destination: &Path) -> Result<(PathBuf, String), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "导出路径无效。".to_string())?;
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "导出文件名无效。".to_string())?;
    let name = format!("{stem}_files");
    Ok((parent.join(&name), name))
}

pub fn export_markdown_file(source: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    validate_archive(&mut archive)?;

    let manifest_text = read_zip_text(&mut archive, "manifest.json")?;
    let manifest: Value = serde_json::from_str(&manifest_text).map_err(|err| err.to_string())?;
    let content_name = manifest
        .get("contentFile")
        .and_then(Value::as_str)
        .unwrap_or("content.md");
    let content = read_zip_text(&mut archive, content_name)?;
    let (resource_root, resource_folder_name) = export_folder(destination)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().to_string();
        if entry.is_dir() || !(name.starts_with("assets/") || name.starts_with("attachments/")) {
            continue;
        }
        validate_archive_entry_name(&name)?;
        let output = resource_root.join(Path::new(&name));
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|err| err.to_string())?;
        fs::write(output, bytes).map_err(|err| err.to_string())?;
    }

    let rewritten = content
        .replace("assets/", &format!("{resource_folder_name}/assets/"))
        .replace(
            "attachments/",
            &format!("{resource_folder_name}/attachments/"),
        );
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(destination, rewritten).map_err(|err| err.to_string())
}
