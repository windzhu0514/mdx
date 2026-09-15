use crate::resource_import::{
    infer_mime_type, safe_resource_file_name, ImportedResource, MAX_IMPORTED_RESOURCE_BYTES,
    MAX_TOTAL_IMPORTED_RESOURCE_BYTES,
};
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

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
    pub resource_rewrites: std::collections::BTreeMap<String, String>,
}

#[derive(Debug)]
struct Reference {
    range: Option<std::ops::Range<usize>>,
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
    prepare_markdown_resources_with_pending(source_path, markdown, &[])
}

pub(crate) fn prepare_markdown_resources_with_pending(
    source_path: &Path,
    markdown: &str,
    pending: &[crate::ResourceData],
) -> Result<MarkdownResourcePlan, String> {
    let mut references = discover_references(markdown);
    references.extend(
        crate::markdown_file::stored_resource_references(source_path)
            .into_iter()
            .map(|original| Reference {
                range: None,
                resolution: original.clone(),
                original,
                wrapped: false,
            }),
    );
    let source_directory = source_path.parent().unwrap_or_else(|| Path::new(""));
    let mut outcomes = HashMap::<PathBuf, SourceOutcome>::new();
    let mut resources = Vec::new();
    let mut items = Vec::new();
    let mut allocated_names = HashSet::new();
    let mut pending_targets = HashMap::new();
    let mut total_bytes = 0_u64;
    for resource in pending {
        let estimated = (resource.base64.len() as u64 / 4 * 3).saturating_sub(
            resource
                .base64
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'=')
                .count() as u64,
        );
        crate::markdown_file::checked_resource_total(total_bytes, estimated)?;
        let bytes = crate::markdown_file::pending_bytes(resource)?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_TOTAL_IMPORTED_RESOURCE_BYTES {
            return Err("资源总大小超过导入限制。".to_string());
        }
        let is_image = matches!(resource.kind, crate::ResourceKind::Asset);
        let target = if crate::validate_new_resource_name(&resource.name).is_ok()
            && resource
                .name
                .rsplit('/')
                .next()
                .is_some_and(|name| safe_resource_file_name(name) == name)
            && allocated_names.insert(resource.name.clone())
        {
            resource.name.clone()
        } else {
            allocate_target_path(&resource.original_name, is_image, &mut allocated_names)
        };
        pending_targets.insert(resource.name.clone(), target.clone());
        resources.push(ImportedResource {
            name: target,
            original_name: resource.original_name.clone(),
            mime_type: resource.mime_type.clone(),
            size: bytes.len() as u64,
            kind: if is_image { "asset" } else { "attachment" }.to_string(),
            base64: resource.base64.clone(),
        });
    }
    let pending_paths: HashMap<PathBuf, &String> = pending_targets
        .keys()
        .filter_map(|reference| {
            local_reference_path(source_path, reference)
                .ok()
                .flatten()
                .map(|path| (normalize_source_path(&path), reference))
        })
        .collect();
    let mut replacements = Vec::new();
    let mut resource_rewrites = std::collections::BTreeMap::new();

    for reference in references {
        let pending_key = pending_targets
            .get_key_value(&reference.resolution)
            .map(|(key, _)| key)
            .or_else(|| {
                local_reference_path(source_path, &reference.resolution)
                    .ok()
                    .flatten()
                    .and_then(|path| pending_paths.get(&normalize_source_path(&path)).copied())
            });
        if let Some(target) = pending_key.and_then(|key| pending_targets.get(key)) {
            let replacement = crate::export::serialize_destination(&format!(
                "{target}{}",
                reference_suffix(&reference.resolution)
            ));
            if let Some(range) = reference.range.clone() {
                replacements.push((range, replacement.clone()));
            }
            resource_rewrites.insert(reference.original.clone(), replacement);
            items.push(MarkdownResourceItem {
                original_reference: reference.original,
                resolved_path: None,
                status: "ready".to_string(),
                target_path: Some(target.clone()),
                message: None,
            });
            continue;
        }
        let normalized = match local_reference_path(source_path, &reference.resolution) {
            Ok(Some(path)) => normalize_source_path(&path),
            Ok(None) => continue,
            Err(_) => {
                normalize_source_path(&resolve_local_path(source_directory, &reference.resolution))
            }
        };
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
            let target_path = crate::export::serialize_destination(&format!(
                "{}{}",
                target_path,
                reference_suffix(&reference.resolution)
            ));
            let replacement = if reference.wrapped {
                format!("<{target_path}>")
            } else {
                target_path
            };
            if let Some(range) = reference.range {
                replacements.push((range, replacement.clone()));
            }
            resource_rewrites.insert(reference.original, replacement);
        }
    }

    replacements.sort_by(|left, right| right.0.start.cmp(&left.0.start));
    resource_rewrites.extend(
        pending_targets
            .iter()
            .map(|(original, target)| (original.clone(), target.clone())),
    );
    let mut rewritten_content = markdown.to_string();
    for (range, replacement) in replacements {
        rewritten_content.replace_range(range, &replacement);
    }

    Ok(MarkdownResourcePlan {
        rewritten_content,
        resources,
        items,
        resource_rewrites,
    })
}

fn discover_references(markdown: &str) -> Vec<Reference> {
    crate::export::resource_references(markdown)
        .into_iter()
        .map(|reference| Reference {
            original: markdown[reference.range.clone()].to_string(),
            range: Some(reference.range),
            resolution: reference.destination,
            wrapped: false,
        })
        .collect()
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

pub(crate) fn reference_suffix(reference: &str) -> &str {
    let index = reference.find(['?', '#']).unwrap_or(reference.len());
    &reference[index..]
}

pub(crate) fn local_reference_path(
    source_path: &Path,
    reference: &str,
) -> Result<Option<PathBuf>, String> {
    if reference.starts_with('#') || reference.starts_with("//") {
        return Ok(None);
    }
    if reference.starts_with("file:") {
        return url::Url::parse(reference)
            .map_err(|error| error.to_string())?
            .to_file_path()
            .map(Some)
            .map_err(|_| "本地文件 URL 无效。".to_string());
    }
    if is_external_reference(reference) {
        return Ok(None);
    }
    let suffix = reference_suffix(reference);
    let reference = &reference[..reference.len() - suffix.len()];
    let bytes = reference.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "资源路径不是有效 UTF-8。".to_string())?;
    if decoded.contains('\0') {
        return Err("资源路径包含无效字符。".to_string());
    }
    Ok(Some(resolve_local_path(
        source_path.parent().unwrap_or_else(|| Path::new("")),
        &decoded,
    )))
}

pub(crate) fn normalize_source_path(path: &Path) -> PathBuf {
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
    let limit = MAX_IMPORTED_RESOURCE_BYTES
        .min(MAX_TOTAL_IMPORTED_RESOURCE_BYTES.saturating_sub(*total_bytes));
    let bytes = match fs::File::open(source_path).and_then(|file| {
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    }) {
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
    if bytes.len() as u64 > MAX_IMPORTED_RESOURCE_BYTES
        || total_bytes.saturating_add(bytes.len() as u64) > MAX_TOTAL_IMPORTED_RESOURCE_BYTES
    {
        return unresolved_outcome(
            original_reference,
            &resolved_path,
            "oversized",
            "引用的本地资源超过导入限制。",
        );
    }
    *total_bytes += bytes.len() as u64;

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

#[cfg(test)]
mod precise_reference_tests {
    use super::*;
    #[test]
    fn references_support_encoded_spaces_fragments_html_and_preserve_yaml() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a b.png"), b"image").unwrap();
        let content = "\u{feff}---\r\nexample: '![yaml](missing.png)'\r\n---\r\n![image](a%20b.png#section)\n<img SRC = \"a%20b.png\">\n\n[other]: <a b.png>\n";
        let plan = prepare_markdown_resources(&root.path().join("note.md"), content).unwrap();
        assert_eq!(plan.resources.len(), 1);
        assert!(plan
            .rewritten_content
            .starts_with("\u{feff}---\r\nexample: '![yaml](missing.png)'\r\n---\r\n"));
        assert!(plan.rewritten_content.contains("assets/a-b.png#section"));
        assert!(plan.rewritten_content.contains("SRC = \"assets/a-b.png\""));
        assert!(plan.rewritten_content.contains("[other]: <assets/a-b.png>"));
        assert_eq!(plan.resource_rewrites.len(), 3);
    }
    #[test]
    fn pending_resources_override_only_their_own_reference_and_survive_without_reference() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::write(root.path().join("assets/image.png"), b"disk").unwrap();
        let pending = crate::ResourceData {
            name: "note_files/assets/image.png".to_string(),
            original_name: "image.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 7,
            kind: crate::ResourceKind::Asset,
            base64: general_purpose::STANDARD.encode(b"pending"),
        };
        let attachment = crate::ResourceData {
            name: "note_files/attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            kind: crate::ResourceKind::Attachment,
            base64: general_purpose::STANDARD.encode(b"pdf"),
        };
        let plan = prepare_markdown_resources_with_pending(
            &root.path().join("note.md"),
            "![pending](note_files/assets/image.png) ![disk](assets/image.png)",
            &[pending, attachment],
        )
        .unwrap();
        assert_eq!(plan.resources.len(), 3);
        let rewritten_pending = &plan.resource_rewrites["note_files/assets/image.png"];
        let rewritten_disk = &plan.resource_rewrites["assets/image.png"];
        assert_ne!(rewritten_pending, rewritten_disk);
        assert_eq!(
            plan.resources
                .iter()
                .find(|resource| &resource.name == rewritten_pending)
                .unwrap()
                .base64,
            general_purpose::STANDARD.encode(b"pending")
        );
        assert!(plan
            .resource_rewrites
            .contains_key("note_files/attachments/manual.pdf"));
    }
    #[test]
    fn file_urls_and_pending_fragment_references_are_packaged() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("local image.png");
        fs::write(&file, b"image").unwrap();
        let url = url::Url::from_file_path(&file).unwrap();
        let pending = crate::ResourceData {
            name: "attachments/manual.pdf".to_string(),
            original_name: "manual.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 3,
            kind: crate::ResourceKind::Attachment,
            base64: general_purpose::STANDARD.encode(b"pdf"),
        };
        let content = format!("![file]({url}) [manual](attachments/manual.pdf#page=2)");
        let plan = prepare_markdown_resources_with_pending(
            &root.path().join("note.md"),
            &content,
            &[pending],
        )
        .unwrap();
        assert_eq!(plan.resources.len(), 2);
        assert!(plan.items.iter().all(|item| item.status == "ready"));
        assert!(plan
            .rewritten_content
            .contains("![file](assets/local-image.png)"));
        assert!(plan
            .rewritten_content
            .contains("[manual](attachments/manual.pdf#page=2)"));
        assert_eq!(
            plan.resource_rewrites["attachments/manual.pdf#page=2"],
            "attachments/manual.pdf#page=2"
        );
    }
    #[test]
    fn markdown_resources_ignore_code_and_find_reference_definitions() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("real.png"), b"real").unwrap();
        fs::write(root.path().join("code.png"), b"code").unwrap();
        let content = "![real][image]\n\n[image]: real.png\n\n`![code](code.png)`\n\n```md\n![code](code.png)\n```\n";
        let plan = prepare_markdown_resources(&root.path().join("note.md"), content).unwrap();
        assert_eq!(plan.resources.len(), 1);
        assert_eq!(plan.resources[0].original_name, "real.png");
        assert!(plan.rewritten_content.contains("[image]: assets/real.png"));
        assert!(plan.rewritten_content.contains("`![code](code.png)`"));
    }
}
