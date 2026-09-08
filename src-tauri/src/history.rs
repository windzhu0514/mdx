use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::path::Path;
use uuid::Uuid;
use zip::ZipArchive;

use crate::archive_security::{
    read_archive_entry_bytes, validate_archive, validate_archive_entry_name, MAX_TEXT_ENTRY_BYTES,
};

#[derive(Debug, Clone)]
pub struct HistoryArchiveEntry {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub title: String,
    pub content: String,
    pub meta: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListItem {
    pub name: String,
    pub title: String,
    pub created_at: String,
}

pub fn trim_history_entries(
    entries: Vec<HistoryArchiveEntry>,
    max_history: usize,
) -> Vec<HistoryArchiveEntry> {
    let (mut history, mut others): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|entry| entry.name.starts_with("history/") && entry.name.ends_with(".json"));
    history.sort_by(|left, right| left.name.cmp(&right.name));
    if history.len() > max_history {
        history.drain(0..history.len() - max_history);
    }
    others.extend(history);
    others
}

pub fn new_history_entry(
    title: &str,
    content: &str,
    meta: Value,
) -> Result<HistoryArchiveEntry, String> {
    let snapshot = HistorySnapshot {
        title: title.to_string(),
        content: content.to_string(),
        meta,
        created_at: Local::now().to_rfc3339(),
    };
    validate_snapshot_size(&snapshot)?;
    let name = format!(
        "history/{}-{}.json",
        Local::now().format("%Y%m%d-%H%M%S-%3f"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let bytes = serde_json::to_vec(&snapshot).map_err(|err| err.to_string())?;
    Ok(HistoryArchiveEntry { name, bytes })
}

fn validate_snapshot_size(snapshot: &HistorySnapshot) -> Result<(), String> {
    if snapshot.content.len() as u64 > MAX_TEXT_ENTRY_BYTES {
        return Err("历史版本正文超过 16 MiB 限制。".to_string());
    }
    let metadata = serde_json::to_vec(&snapshot.meta).map_err(|error| error.to_string())?;
    if metadata.len() as u64 > MAX_TEXT_ENTRY_BYTES {
        return Err("历史版本元数据超过 16 MiB 限制。".to_string());
    }
    let title = serde_json::to_vec(&snapshot.title).map_err(|error| error.to_string())?;
    if title.len() as u64 > MAX_TEXT_ENTRY_BYTES {
        return Err("历史版本标题超过 16 MiB 限制。".to_string());
    }
    Ok(())
}

fn read_snapshot(archive: &mut ZipArchive<File>, name: &str) -> Result<HistorySnapshot, String> {
    validate_archive_entry_name(name)?;
    if !name.starts_with("history/") || !name.ends_with(".json") {
        return Err("历史版本路径无效。".to_string());
    }
    let mut file = archive.by_name(name).map_err(|err| err.to_string())?;
    let bytes = read_archive_entry_bytes(&mut file)?;
    let snapshot = serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
    validate_snapshot_size(&snapshot)?;
    Ok(snapshot)
}

pub fn list_history_file(path: &Path) -> Result<Vec<HistoryListItem>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    validate_archive(&mut archive)?;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .filter(|name| name.starts_with("history/") && name.ends_with(".json"))
        .collect();
    let mut items = Vec::new();
    for name in names {
        if let Ok(snapshot) = read_snapshot(&mut archive, &name) {
            items.push(HistoryListItem {
                name,
                title: snapshot.title,
                created_at: snapshot.created_at,
            });
        }
    }
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(items)
}

pub fn read_history_file(path: &Path, name: &str) -> Result<HistorySnapshot, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    validate_archive(&mut archive)?;
    read_snapshot(&mut archive, name)
}

#[cfg(test)]
mod tests {
    use super::{new_history_entry, read_history_file};
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;
    use zip::write::FileOptions;

    #[test]
    fn history_rejects_decoded_content_over_the_document_limit() {
        let content = "x".repeat(16 * 1024 * 1024 + 1);
        assert!(new_history_entry("title", &content, json!({})).is_err());
    }

    #[test]
    fn history_rejects_metadata_over_the_document_limit() {
        let metadata = json!({"value": "x".repeat(16 * 1024 * 1024)});
        assert!(new_history_entry("title", "content", metadata).is_err());
    }

    #[test]
    fn reading_history_rejects_decoded_content_over_the_document_limit() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("oversized-history.mdx");
        let snapshot = json!({
            "title": "title",
            "content": "x".repeat(16 * 1024 * 1024 + 1),
            "meta": {},
            "createdAt": "2026-09-08T00:00:00Z"
        });
        let mut archive = zip::ZipWriter::new(File::create(&target).unwrap());
        archive
            .start_file("history/test.json", FileOptions::default())
            .unwrap();
        archive
            .write_all(&serde_json::to_vec(&snapshot).unwrap())
            .unwrap();
        archive.finish().unwrap();

        assert!(read_history_file(&target, "history/test.json").is_err());
    }
}
