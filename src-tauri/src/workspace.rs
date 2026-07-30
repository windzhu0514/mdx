use crate::{normalize_path, path_identity};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Directory,
    Md,
    Mdx,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTreeEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub children: Vec<WorkspaceTreeEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub path: String,
    pub entries: Vec<WorkspaceTreeEntry>,
    pub entry_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevision {
    pub path: String,
    pub modified_at_ms: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevisionResult {
    pub path: String,
    pub available: bool,
    pub revision: Option<DiskRevision>,
    pub error: Option<String>,
}

struct Candidate {
    path: std::path::PathBuf,
    name: String,
    kind: EntryKind,
}

pub fn scan_folder(root: &Path, limit: usize) -> Result<FolderScan, String> {
    let path = normalize_path(root)?;
    let mut remaining = limit;
    let mut truncated = false;
    let entries = scan_directory(Path::new(&path), &mut remaining, &mut truncated)?;

    Ok(FolderScan {
        path,
        entries,
        entry_count: limit.saturating_sub(remaining),
        truncated,
    })
}

pub fn disk_revision(path: &Path) -> DiskRevisionResult {
    let normalized_path =
        normalize_path(path).unwrap_or_else(|_| path.to_string_lossy().to_string());
    let identity_path = path_identity(path).unwrap_or_else(|_| normalized_path.clone());

    match fs::metadata(path) {
        Ok(metadata) => match metadata.modified().and_then(|modified| {
            modified
                .duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            Ok(modified) => DiskRevisionResult {
                path: normalized_path,
                available: true,
                revision: Some(DiskRevision {
                    path: identity_path,
                    modified_at_ms: modified.as_millis(),
                    size: metadata.len(),
                }),
                error: None,
            },
            Err(error) => DiskRevisionResult {
                path: normalized_path,
                available: true,
                revision: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => DiskRevisionResult {
            path: normalized_path,
            available: false,
            revision: None,
            error: Some(error.to_string()),
        },
    }
}

pub fn get_disk_revisions(paths: Vec<String>) -> Vec<DiskRevisionResult> {
    paths
        .iter()
        .map(|path| disk_revision(Path::new(path)))
        .collect()
}

fn scan_directory(
    directory: &Path,
    remaining: &mut usize,
    truncated: &mut bool,
) -> Result<Vec<WorkspaceTreeEntry>, String> {
    let (directories, files) = candidates_in(directory)?;
    let mut entries = Vec::new();

    for candidate in directories {
        if !has_visible_markdown_descendant(&candidate.path)? {
            continue;
        }
        if *remaining == 0 {
            *truncated = true;
            continue;
        }

        *remaining -= 1;
        entries.push(WorkspaceTreeEntry {
            path: normalize_path(&candidate.path)?,
            name: candidate.name,
            kind: candidate.kind,
            children: scan_directory(&candidate.path, remaining, truncated)?,
        });
    }

    for candidate in files {
        if *remaining == 0 {
            *truncated = true;
            break;
        }

        *remaining -= 1;
        entries.push(WorkspaceTreeEntry {
            path: normalize_path(&candidate.path)?,
            name: candidate.name,
            kind: candidate.kind,
            children: Vec::new(),
        });
    }

    Ok(entries)
}

fn has_visible_markdown_descendant(directory: &Path) -> Result<bool, String> {
    let (directories, files) = candidates_in(directory)?;
    if !files.is_empty() {
        return Ok(true);
    }

    for candidate in directories {
        if has_visible_markdown_descendant(&candidate.path)? {
            return Ok(true);
        }
    }

    Ok(false)
}

fn candidates_in(directory: &Path) -> Result<(Vec<Candidate>, Vec<Candidate>), String> {
    let mut directories = Vec::new();
    let mut files = Vec::new();

    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if should_skip(&metadata) {
            continue;
        }

        if metadata.is_dir() {
            directories.push(Candidate {
                path: entry.path(),
                name,
                kind: EntryKind::Directory,
            });
        } else if metadata.is_file() {
            let Some(kind) =
                markdown_kind(entry.path().extension().and_then(|value| value.to_str()))
            else {
                continue;
            };
            files.push(Candidate {
                path: entry.path(),
                name,
                kind,
            });
        }
    }

    directories.sort_by(|left, right| natural_compare(&left.name, &right.name));
    files.sort_by(|left, right| natural_compare(&left.name, &right.name));
    Ok((directories, files))
}

fn should_skip(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
    }

    #[cfg(not(windows))]
    {
        false
    }
}

fn markdown_kind(extension: Option<&str>) -> Option<EntryKind> {
    match extension {
        Some(value) if value.eq_ignore_ascii_case("md") => Some(EntryKind::Md),
        Some(value) if value.eq_ignore_ascii_case("mdx") => Some(EntryKind::Mdx),
        _ => None,
    }
}

fn natural_compare(left: &str, right: &str) -> Ordering {
    let left = left.to_lowercase().chars().collect::<Vec<_>>();
    let right = right.to_lowercase().chars().collect::<Vec<_>>();
    let mut left_index = 0;
    let mut right_index = 0;

    while left_index < left.len() && right_index < right.len() {
        if left[left_index].is_ascii_digit() && right[right_index].is_ascii_digit() {
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left.len() && left[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right.len() && right[right_index].is_ascii_digit() {
                right_index += 1;
            }

            let left_number = left[left_start..left_index].iter().collect::<String>();
            let right_number = right[right_start..right_index].iter().collect::<String>();
            let left_significant = left_number.trim_start_matches('0');
            let right_significant = right_number.trim_start_matches('0');
            let number_order = left_significant
                .len()
                .cmp(&right_significant.len())
                .then_with(|| left_significant.cmp(right_significant));
            if number_order != Ordering::Equal {
                return number_order;
            }

            let zero_order = left_number.len().cmp(&right_number.len());
            if zero_order != Ordering::Equal {
                return zero_order;
            }
            continue;
        }

        let order = left[left_index].cmp(&right[right_index]);
        if order != Ordering::Equal {
            return order;
        }
        left_index += 1;
        right_index += 1;
    }

    left.len().cmp(&right.len()).then_with(|| left.cmp(&right))
}
