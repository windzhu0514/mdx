use crate::{normalize_path, path_identity};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

static INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexSourceRevision {
    pub modified_at_ms: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub updated_at: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<IndexSourceRevision>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchResult {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub updated_at: String,
    pub snippet: String,
    pub score: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexRefresh {
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub failed: Vec<WorkspaceIndexFailure>,
    pub truncated: bool,
}

fn lock_index() -> MutexGuard<'static, ()> {
    INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_entries_unlocked(index_path: &Path) -> Result<Vec<NoteIndexEntry>, String> {
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(index_path).map_err(|err| err.to_string())?;
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_entries_unlocked(index_path: &Path, entries: &[NoteIndexEntry]) -> Result<(), String> {
    let parent = index_path
        .parent()
        .ok_or_else(|| "索引路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let nonce = Uuid::new_v4();
    let temporary = parent.join(format!(".notes-{nonce}.tmp"));
    let backup = parent.join(format!(".notes-{nonce}.bak"));
    let bytes = serde_json::to_vec_pretty(entries).map_err(|err| err.to_string())?;
    let mut file = File::create(&temporary).map_err(|err| err.to_string())?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    drop(file);

    if index_path.exists() {
        if let Err(error) = fs::rename(index_path, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    }

    if let Err(error) = fs::rename(&temporary, index_path) {
        let restore_error = if backup.exists() {
            fs::rename(&backup, index_path).err()
        } else {
            None
        };
        let _ = fs::remove_file(&temporary);
        return match restore_error {
            Some(restore) => Err(format!("索引替换失败：{error}；恢复旧索引失败：{restore}")),
            None => Err(format!("索引替换失败：{error}")),
        };
    }

    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

pub fn upsert_index_entry(index_path: &Path, entry: NoteIndexEntry) -> Result<(), String> {
    let _guard = lock_index();
    let mut entries = read_entries_unlocked(index_path)?;
    let identity = entry_identity(&entry.path);
    entries.retain(|item| entry_identity(&item.path) != identity);
    entries.push(entry);
    sort_entries(&mut entries);
    write_entries_unlocked(index_path, &entries)
}

pub fn list_index_entries(index_path: &Path) -> Result<Vec<NoteIndexEntry>, String> {
    let _guard = lock_index();
    let mut entries = read_entries_unlocked(index_path)?;
    sort_entries(&mut entries);
    Ok(entries)
}

pub fn source_revision(path: &Path) -> Result<IndexSourceRevision, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .and_then(|value| {
            value
                .duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map_err(|error| error.to_string())?;
    Ok(IndexSourceRevision {
        modified_at_ms: modified.as_millis(),
        size: metadata.len(),
    })
}

pub fn refresh_workspace_index<F>(
    index_path: &Path,
    root: &Path,
    files: &[PathBuf],
    truncated: bool,
    mut load: F,
) -> Result<WorkspaceIndexRefresh, String>
where
    F: FnMut(&Path) -> Result<NoteIndexEntry, String>,
{
    let root_identity = path_identity(root)?;
    let _guard = lock_index();
    let entries = read_entries_unlocked(index_path)?;
    let mut entries_by_identity = entries
        .into_iter()
        .map(|entry| (entry_identity(&entry.path), entry))
        .collect::<HashMap<_, _>>();
    let mut current_identities = HashSet::new();
    let mut indexed = 0;
    let mut unchanged = 0;
    let mut failed = Vec::new();

    for path in files {
        let identity = match path_identity(path) {
            Ok(identity) => identity,
            Err(error) => {
                failed.push(WorkspaceIndexFailure {
                    path: path.to_string_lossy().to_string(),
                    error,
                });
                continue;
            }
        };
        if !current_identities.insert(identity.clone()) {
            continue;
        }

        let revision = match source_revision(path) {
            Ok(revision) => revision,
            Err(error) => {
                failed.push(WorkspaceIndexFailure {
                    path: path.to_string_lossy().to_string(),
                    error,
                });
                continue;
            }
        };
        if entries_by_identity
            .get(&identity)
            .and_then(|entry| entry.source_revision.as_ref())
            == Some(&revision)
        {
            unchanged += 1;
            continue;
        }

        match load(path) {
            Ok(mut entry) => {
                entry.path =
                    normalize_path(path).unwrap_or_else(|_| path.to_string_lossy().to_string());
                entry.source_revision = Some(revision);
                entries_by_identity.insert(identity, entry);
                indexed += 1;
            }
            Err(error) => failed.push(WorkspaceIndexFailure {
                path: path.to_string_lossy().to_string(),
                error,
            }),
        }
    }

    let removed = if truncated {
        0
    } else {
        let before = entries_by_identity.len();
        entries_by_identity.retain(|identity, _| {
            !Path::new(identity).starts_with(Path::new(&root_identity))
                || current_identities.contains(identity)
        });
        before.saturating_sub(entries_by_identity.len())
    };

    if indexed > 0 || removed > 0 {
        let mut entries = entries_by_identity.into_values().collect::<Vec<_>>();
        sort_entries(&mut entries);
        write_entries_unlocked(index_path, &entries)?;
    }

    Ok(WorkspaceIndexRefresh {
        discovered: current_identities.len(),
        indexed,
        unchanged,
        removed,
        failed,
        truncated,
    })
}

fn entry_identity(path: &str) -> String {
    path_identity(Path::new(path)).unwrap_or_else(|_| {
        #[cfg(windows)]
        {
            path.to_lowercase()
        }
        #[cfg(not(windows))]
        {
            path.to_string()
        }
    })
}

fn sort_entries(entries: &mut [NoteIndexEntry]) {
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
}

fn count_matches(source: &str, query: &str) -> usize {
    source.match_indices(query).count()
}

fn snippet(content: &str, query: &str) -> String {
    let mut lower = String::with_capacity(content.len());
    let mut original_char_starts = Vec::new();

    for (char_index, ch) in content.chars().enumerate() {
        original_char_starts.push((lower.len(), char_index));
        lower.extend(ch.to_lowercase());
    }

    let start_byte = lower.find(query).unwrap_or(0);
    let match_char = original_char_starts
        .partition_point(|(lower_byte, _)| *lower_byte <= start_byte)
        .checked_sub(1)
        .and_then(|index| original_char_starts.get(index))
        .map(|(_, char_index)| *char_index)
        .unwrap_or(0);
    let start_char = match_char.saturating_sub(24);
    content.chars().skip(start_char).take(120).collect()
}

pub fn search_index_entries(
    index_path: &Path,
    query: &str,
) -> Result<Vec<NoteSearchResult>, String> {
    let _guard = lock_index();
    let query = query.trim().to_lowercase();
    let mut entries = read_entries_unlocked(index_path)?;
    sort_entries(&mut entries);
    if query.is_empty() {
        return Ok(entries
            .into_iter()
            .map(|entry| NoteSearchResult {
                path: entry.path,
                title: entry.title,
                tags: entry.tags,
                summary: entry.summary,
                updated_at: entry.updated_at,
                snippet: String::new(),
                score: 0,
            })
            .collect());
    }

    let mut results = Vec::new();
    for entry in entries {
        let title = entry.title.to_lowercase();
        let tags = entry.tags.join(" ").to_lowercase();
        let content = entry.content.to_lowercase();
        let score = count_matches(&title, &query) * 20
            + count_matches(&tags, &query) * 10
            + count_matches(&content, &query) * 2;
        if score == 0 {
            continue;
        }
        results.push(NoteSearchResult {
            path: entry.path,
            title: entry.title,
            tags: entry.tags,
            summary: entry.summary,
            updated_at: entry.updated_at,
            snippet: snippet(&entry.content, &query),
            score,
        });
    }
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    Ok(results)
}
