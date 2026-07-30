use crate::{normalize_path, path_identity};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub const MAX_RECENT_FILES: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileEntry {
    pub path: String,
    pub title: String,
    pub last_opened_at: String,
    #[serde(default)]
    pub available: bool,
}

pub fn push_recent_entry(
    mut entries: Vec<RecentFileEntry>,
    path: String,
    title: String,
    opened_at: String,
) -> Result<Vec<RecentFileEntry>, String> {
    let normalized = normalize_path(Path::new(&path))?;
    let identity = path_identity(Path::new(&normalized))?;
    entries
        .retain(|entry| path_identity(Path::new(&entry.path)).ok().as_deref() != Some(&identity));
    entries.insert(
        0,
        RecentFileEntry {
            path: normalized.clone(),
            title,
            last_opened_at: opened_at,
            available: Path::new(&normalized).is_file(),
        },
    );
    entries.truncate(MAX_RECENT_FILES);
    Ok(entries)
}

pub fn remove_recent_entry(
    mut entries: Vec<RecentFileEntry>,
    path: &Path,
) -> Result<Vec<RecentFileEntry>, String> {
    let identity = path_identity(path)?;
    entries
        .retain(|entry| path_identity(Path::new(&entry.path)).ok().as_deref() != Some(&identity));
    Ok(entries)
}

pub fn read_recent_file(path: &Path) -> Result<Vec<RecentFileEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut entries: Vec<RecentFileEntry> =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let mut identities = HashSet::new();
    entries.retain(|entry| {
        path_identity(Path::new(&entry.path))
            .map(|identity| identities.insert(identity))
            .unwrap_or(true)
    });
    for entry in &mut entries {
        entry.available = Path::new(&entry.path).is_file();
    }
    entries.truncate(MAX_RECENT_FILES);
    Ok(entries)
}

pub fn write_recent_file(path: &Path, entries: &[RecentFileEntry]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "最近打开列表路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}
