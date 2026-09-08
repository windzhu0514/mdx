use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::Value;
use std::fs::{self, File};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use zip::ZipArchive;

use crate::archive_security::{
    read_archive_entry_bytes, validate_archive, validate_archive_entry_name,
};

static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<!--.*?-->|<!\[CDATA\[.*?\]\]>|<\?.*?\?>|<![^>]*>|<(?P<closing>/?)(?P<tag>[a-z][a-z0-9:-]*)(?P<attributes>(?:[^"'<>]|"[^"]*"|'[^']*')*)>"#,
    )
    .unwrap()
});
static HTML_ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?P<name>[^\s"'<>/=]+)(?:\s*=\s*(?:"(?P<double>[^"]*)"|'(?P<single>[^']*)'|(?P<bare>[^\s"'=<>`]+)))?"#,
    )
    .unwrap()
});

fn read_zip_text(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    validate_archive_entry_name(name)?;
    let mut file = archive.by_name(name).map_err(|err| err.to_string())?;
    String::from_utf8(read_archive_entry_bytes(&mut file)?).map_err(|err| err.to_string())
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

fn is_resource_destination(destination: &str) -> bool {
    destination.starts_with("assets/") || destination.starts_with("attachments/")
}

fn destination_start(content: &str, mut offset: usize, end: usize) -> usize {
    let bytes = content.as_bytes();
    // Reference definitions and inline destinations may continue inside a blockquote.
    while offset < end && (bytes[offset].is_ascii_whitespace() || bytes[offset] == b'>') {
        offset += 1;
    }
    if offset < end && bytes[offset] == b'<' {
        offset += 1;
    }
    offset
}

fn html_resource_offsets(content: &str, ranges: &[Range<usize>], offsets: &mut Vec<usize>) {
    let mut raw_text_tag: Option<String> = None;
    for range in ranges {
        for captures in HTML_TAG.captures_iter(&content[range.clone()]) {
            let Some(tag) = captures.name("tag") else {
                continue;
            };
            let closing = captures
                .name("closing")
                .is_some_and(|value| !value.is_empty());
            if let Some(raw_tag) = &raw_text_tag {
                if closing && tag.as_str().eq_ignore_ascii_case(raw_tag) {
                    raw_text_tag = None;
                }
                continue;
            }
            if closing {
                continue;
            }
            let attributes = captures.name("attributes").unwrap();
            for attribute in HTML_ATTRIBUTE.captures_iter(attributes.as_str()) {
                let name = attribute.name("name").unwrap().as_str();
                if !name.eq_ignore_ascii_case("src") && !name.eq_ignore_ascii_case("href") {
                    continue;
                }
                if let Some(value) = attribute
                    .name("double")
                    .or_else(|| attribute.name("single"))
                    .or_else(|| attribute.name("bare"))
                    .filter(|value| is_resource_destination(value.as_str()))
                {
                    offsets.push(range.start + attributes.start() + value.start());
                }
            }
            let tag = tag.as_str().to_ascii_lowercase();
            if matches!(
                tag.as_str(),
                "script" | "style" | "textarea" | "title" | "pre" | "code"
            ) {
                raw_text_tag = Some(tag);
            }
        }
    }
}

fn rewrite_resource_destinations(content: &str, folder_name: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(content, options);
    let mut offsets = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        if !is_resource_destination(&definition.dest) {
            continue;
        }
        let source = &content[definition.span.clone()];
        let mut escaped = false;
        for (index, byte) in source.bytes().enumerate() {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b']' && source.as_bytes().get(index + 1) == Some(&b':') {
                offsets.push(destination_start(
                    content,
                    definition.span.start + index + 2,
                    definition.span.end,
                ));
                break;
            }
        }
    }

    let mut links: Vec<(bool, usize)> = Vec::new();
    let mut html_ranges: Vec<Range<usize>> = Vec::new();
    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(
                Tag::Link {
                    link_type,
                    dest_url,
                    ..
                }
                | Tag::Image {
                    link_type,
                    dest_url,
                    ..
                },
            ) => {
                if let Some((_, label_end)) = links.last_mut() {
                    *label_end = (*label_end).max(range.end);
                }
                links.push((
                    link_type == LinkType::Inline && is_resource_destination(&dest_url),
                    range.start,
                ));
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((true, label_end)) = links.pop() {
                    // Child offsets exclude the link syntax, so a `](` inside label code
                    // or a nested image cannot be mistaken for this destination.
                    if let Some(index) = content[label_end..range.end].find("](") {
                        offsets.push(destination_start(content, label_end + index + 2, range.end));
                    }
                }
            }
            event => {
                if let Some((_, label_end)) = links.last_mut() {
                    *label_end = (*label_end).max(range.end);
                }
                if matches!(event, Event::Html(_) | Event::InlineHtml(_)) {
                    if let Some(previous) = html_ranges
                        .last_mut()
                        .filter(|previous| previous.end == range.start)
                    {
                        previous.end = range.end;
                    } else {
                        html_ranges.push(range);
                    }
                }
            }
        }
    }
    html_resource_offsets(content, &html_ranges, &mut offsets);
    offsets.sort_unstable();
    offsets.dedup();

    let mut prefix = String::new();
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in folder_name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            prefix.push(char::from(byte));
        } else {
            prefix.push('%');
            prefix.push(char::from(HEX[(byte >> 4) as usize]));
            prefix.push(char::from(HEX[(byte & 15) as usize]));
        }
    }
    prefix.push('/');
    let mut rewritten = String::with_capacity(content.len());
    let mut previous = 0;
    for offset in offsets {
        rewritten.push_str(&content[previous..offset]);
        rewritten.push_str(&prefix);
        previous = offset;
    }
    rewritten.push_str(&content[previous..]);
    rewritten
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
        let bytes = read_archive_entry_bytes(&mut entry)?;
        fs::write(output, bytes).map_err(|err| err.to_string())?;
    }

    let rewritten = rewrite_resource_destinations(&content, &resource_folder_name);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(destination, rewritten).map_err(|err| err.to_string())
}
