use chrono::{DateTime, FixedOffset};
use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub fn validate_draft_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("草稿标识无效。".to_string());
    }
    Ok(())
}

fn draft_path(directory: &Path, key: &str) -> Result<PathBuf, String> {
    validate_draft_key(key)?;
    Ok(directory.join(format!("{key}.json")))
}

pub fn write_draft_file(directory: &Path, key: &str, draft: &Value) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|err| err.to_string())?;
    let target = draft_path(directory, key)?;
    let temporary = directory.join(format!(".{key}-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(draft).map_err(|err| err.to_string())?;

    let mut file = File::create(&temporary).map_err(|err| err.to_string())?;
    file.write_all(&bytes).map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())?;
    drop(file);

    if target.exists() {
        fs::remove_file(&target).map_err(|err| err.to_string())?;
    }
    fs::rename(&temporary, &target).map_err(|err| err.to_string())
}

pub fn read_draft_file(directory: &Path, key: &str) -> Result<Option<Value>, String> {
    let path = draft_path(directory, key)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn draft_updated_at(value: &Value) -> Option<DateTime<FixedOffset>> {
    value
        .get("updatedAt")?
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
}

pub fn read_latest_draft_file(directory: &Path) -> Result<Option<Value>, String> {
    if !directory.exists() {
        return Ok(None);
    }

    let mut latest: Option<(DateTime<FixedOffset>, Value)> = None;
    for entry in fs::read_dir(directory).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(key) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_draft_key(key).is_err() {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(updated_at) = draft_updated_at(&value) else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| updated_at > *current)
        {
            latest = Some((updated_at, value));
        }
    }
    Ok(latest.map(|(_, value)| value))
}

pub fn delete_draft_file(directory: &Path, key: &str) -> Result<(), String> {
    let path = draft_path(directory, key)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
