use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub updated_at: String,
    pub content: String,
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

fn read_entries(index_path: &Path) -> Result<Vec<NoteIndexEntry>, String> {
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(index_path).map_err(|err| err.to_string())?;
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_entries(index_path: &Path, entries: &[NoteIndexEntry]) -> Result<(), String> {
    let parent = index_path
        .parent()
        .ok_or_else(|| "索引路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temporary = parent.join(format!(".notes-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(entries).map_err(|err| err.to_string())?;
    let mut file = File::create(&temporary).map_err(|err| err.to_string())?;
    file.write_all(&bytes).map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())?;
    drop(file);
    if index_path.exists() {
        fs::remove_file(index_path).map_err(|err| err.to_string())?;
    }
    fs::rename(temporary, index_path).map_err(|err| err.to_string())
}

pub fn upsert_index_entry(index_path: &Path, entry: NoteIndexEntry) -> Result<(), String> {
    let mut entries = read_entries(index_path)?;
    entries.retain(|item| item.path != entry.path);
    entries.push(entry);
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    write_entries(index_path, &entries)
}

pub fn list_index_entries(index_path: &Path) -> Result<Vec<NoteIndexEntry>, String> {
    let mut entries = read_entries(index_path)?;
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(entries)
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
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(list_index_entries(index_path)?
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
    for entry in read_entries(index_path)? {
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
