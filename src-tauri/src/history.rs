use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use uuid::Uuid;
use zip::ZipArchive;

use crate::archive_security::{validate_archive, validate_archive_entry_name};

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
    let name = format!(
        "history/{}-{}.json",
        Local::now().format("%Y%m%d-%H%M%S-%3f"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|err| err.to_string())?;
    Ok(HistoryArchiveEntry { name, bytes })
}

fn read_snapshot(archive: &mut ZipArchive<File>, name: &str) -> Result<HistorySnapshot, String> {
    validate_archive_entry_name(name)?;
    if !name.starts_with("history/") || !name.ends_with(".json") {
        return Err("历史版本路径无效。".to_string());
    }
    let mut file = archive.by_name(name).map_err(|err| err.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&bytes).map_err(|err| err.to_string())
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
