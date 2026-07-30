use crate::resource_import::{
    infer_mime_type, safe_resource_file_name, ImportedResource, MAX_IMPORTED_RESOURCE_BYTES,
    MAX_TOTAL_IMPORTED_RESOURCE_BYTES,
};
use base64::{engine::general_purpose, Engine as _};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

static MARKDOWN_DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?\[[^\]]*\]\()(?P<url><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?(\))"#).unwrap()
});
static HTML_DESTINATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b(?:src|href)=(?P<quote>["'])(?P<url>[^"']+)(?:["'])"#).unwrap()
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownResourceItem {
    pub original_reference: String,
    pub resolved_path: Option<String>,
    pub status: String,
    pub target_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownResourcePlan {
    pub rewritten_content: String,
    pub resources: Vec<ImportedResource>,
    pub items: Vec<MarkdownResourceItem>,
}

#[derive(Debug)]
struct Reference {
    range: std::ops::Range<usize>,
    original: String,
    resolution: String,
    wrapped: bool,
}

#[derive(Debug)]
struct SourceOutcome {
    target_path: Option<String>,
}

pub fn prepare_markdown_resources(
    source_path: &Path,
    markdown: &str,
) -> Result<MarkdownResourcePlan, String> {
    let references = discover_references(markdown);
    let source_directory = source_path.parent().unwrap_or_else(|| Path::new(""));
    let mut outcomes = HashMap::<PathBuf, SourceOutcome>::new();
    let mut resources = Vec::new();
    let mut items = Vec::new();
    let mut allocated_names = HashSet::new();
    let mut total_bytes = 0_u64;
    let mut replacements = Vec::new();

    for reference in references {
        if is_external_reference(&reference.resolution) {
            continue;
        }

        let normalized =
            normalize_source_path(&resolve_local_path(source_directory, &reference.resolution));
        if !outcomes.contains_key(&normalized) {
            let (outcome, item, resource) = inspect_source(
                &normalized,
                &reference.original,
                &mut total_bytes,
                &mut allocated_names,
            );
            if let Some(resource) = resource {
                resources.push(resource);
            }
            items.push(item);
            outcomes.insert(normalized.clone(), outcome);
        }

        if let Some(target_path) = outcomes
            .get(&normalized)
            .and_then(|outcome| outcome.target_path.as_ref())
        {
            let replacement = if reference.wrapped {
                format!("<{target_path}>")
            } else {
                target_path.clone()
            };
            replacements.push((reference.range, replacement));
        }
    }

    replacements.sort_by(|left, right| right.0.start.cmp(&left.0.start));
    let mut rewritten_content = markdown.to_string();
    for (range, replacement) in replacements {
        rewritten_content.replace_range(range, &replacement);
    }

    Ok(MarkdownResourcePlan {
        rewritten_content,
        resources,
        items,
    })
}

fn discover_references(markdown: &str) -> Vec<Reference> {
    let mut references = Vec::new();
    for captures in MARKDOWN_DESTINATION.captures_iter(markdown) {
        push_reference(&mut references, captures.name("url").unwrap());
    }
    for captures in HTML_DESTINATION.captures_iter(markdown) {
        push_reference(&mut references, captures.name("url").unwrap());
    }
    references.sort_by_key(|reference| reference.range.start);
    references
}

fn push_reference(references: &mut Vec<Reference>, matched: regex::Match<'_>) {
    let original = matched.as_str().to_string();
    let wrapped = original.starts_with('<') && original.ends_with('>');
    let resolution = if wrapped {
        original[1..original.len() - 1].to_string()
    } else {
        original.clone()
    };
    references.push(Reference {
        range: matched.range(),
        original,
        resolution,
        wrapped,
    });
}

fn is_external_reference(reference: &str) -> bool {
    !is_windows_drive_reference(reference)
        && (reference.starts_with('#')
            || reference.find(':').is_some_and(|index| {
                index > 0
                    && reference.as_bytes()[0].is_ascii_alphabetic()
                    && reference[..index].bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                    })
            }))
}

fn is_windows_drive_reference(reference: &str) -> bool {
    matches!(reference.as_bytes(), [drive, b':', ..] if drive.is_ascii_alphabetic())
}

fn resolve_local_path(source_directory: &Path, reference: &str) -> PathBuf {
    let reference_path = Path::new(reference);
    if reference_path.is_absolute() {
        reference_path.to_path_buf()
    } else {
        source_directory.join(reference_path)
    }
}

fn normalize_source_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push("..");
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn inspect_source(
    source_path: &Path,
    original_reference: &str,
    total_bytes: &mut u64,
    allocated_names: &mut HashSet<String>,
) -> (
    SourceOutcome,
    MarkdownResourceItem,
    Option<ImportedResource>,
) {
    let resolved_path = source_path.to_string_lossy().to_string();
    let metadata = match fs::metadata(source_path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            return unresolved_outcome(
                original_reference,
                &resolved_path,
                "unreadable",
                "只能导入普通文件。",
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return unresolved_outcome(
                original_reference,
                &resolved_path,
                "missing",
                "引用的本地资源不存在。",
            )
        }
        Err(_) => {
            return unresolved_outcome(
                original_reference,
                &resolved_path,
                "unreadable",
                "无法读取引用的本地资源。",
            )
        }
    };

    if metadata.len() > MAX_IMPORTED_RESOURCE_BYTES
        || total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_IMPORTED_RESOURCE_BYTES
    {
        return unresolved_outcome(
            original_reference,
            &resolved_path,
            "oversized",
            "引用的本地资源超过导入限制。",
        );
    }

    let original_name = match source_path.file_name() {
        Some(name) => name.to_string_lossy().to_string(),
        None => {
            return unresolved_outcome(
                original_reference,
                &resolved_path,
                "unreadable",
                "资源文件名无效。",
            )
        }
    };
    let mime_type = infer_mime_type(&original_name).to_string();
    let is_image = mime_type.starts_with("image/");
    let target_path = allocate_target_path(&original_name, is_image, allocated_names);
    let bytes = match fs::read(source_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            return unresolved_outcome(
                original_reference,
                &resolved_path,
                "unreadable",
                "无法读取引用的本地资源。",
            )
        }
    };
    *total_bytes += metadata.len();

    let resource = ImportedResource {
        name: target_path.clone(),
        original_name,
        mime_type,
        size: metadata.len(),
        kind: if is_image { "asset" } else { "attachment" }.to_string(),
        base64: general_purpose::STANDARD.encode(bytes),
    };
    let item = MarkdownResourceItem {
        original_reference: original_reference.to_string(),
        resolved_path: Some(resolved_path),
        status: "ready".to_string(),
        target_path: Some(target_path.clone()),
        message: None,
    };
    (
        SourceOutcome {
            target_path: Some(target_path),
        },
        item,
        Some(resource),
    )
}

fn unresolved_outcome(
    original_reference: &str,
    resolved_path: &str,
    status: &str,
    message: &str,
) -> (
    SourceOutcome,
    MarkdownResourceItem,
    Option<ImportedResource>,
) {
    (
        SourceOutcome { target_path: None },
        MarkdownResourceItem {
            original_reference: original_reference.to_string(),
            resolved_path: Some(resolved_path.to_string()),
            status: status.to_string(),
            target_path: None,
            message: Some(message.to_string()),
        },
        None,
    )
}

fn allocate_target_path(
    original_name: &str,
    is_image: bool,
    allocated_names: &mut HashSet<String>,
) -> String {
    let file_name = safe_resource_file_name(original_name);
    let path = Path::new(&file_name);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "bin".to_string());
    let directory = if is_image { "assets" } else { "attachments" };

    for suffix in 1_u32.. {
        let candidate_file_name = if suffix == 1 {
            file_name.clone()
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        let candidate = format!("{directory}/{candidate_file_name}");
        if allocated_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("u32 suffixes are finite but resource naming must not exhaust them")
}
