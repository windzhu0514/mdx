use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
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

#[derive(Debug)]
pub(crate) struct ResourceReference {
    pub range: Range<usize>,
    // Decoded once by the syntax parser. Local path resolution must never decode entities again.
    pub destination: String,
}

#[derive(Default)]
struct HtmlAttributes(RefCell<HashMap<String, String>>);

impl TokenSink for HtmlAttributes {
    type Handle = ();
    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        if let Token::TagToken(tag) = token {
            for attribute in tag.attrs {
                let name = attribute.name.local.to_string();
                if matches!(name.as_str(), "src" | "href") {
                    self.0
                        .borrow_mut()
                        .insert(name, attribute.value.to_string());
                }
            }
        }
        TokenSinkResult::Continue
    }
}

fn html_attributes(tag: &str) -> HashMap<String, String> {
    let input = BufferQueue::default();
    input.push_back(tag.into());
    let tokenizer = Tokenizer::new(HtmlAttributes::default(), Default::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.0.into_inner()
}

fn html_resource_offsets(
    content: &str,
    ranges: &[Range<usize>],
    offsets: &mut Vec<ResourceReference>,
) {
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
            let mut decoded_attributes = html_attributes(captures.get(0).unwrap().as_str());
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
                {
                    if let Some(destination) = decoded_attributes.remove(&name.to_ascii_lowercase())
                    {
                        offsets.push(ResourceReference {
                            range: (range.start + attributes.start() + value.start())
                                ..(range.start + attributes.start() + value.end()),
                            destination,
                        });
                    }
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

pub(crate) fn resource_destinations(content: &str) -> Vec<Range<usize>> {
    resource_references(content)
        .into_iter()
        .map(|reference| reference.range)
        .collect()
}

pub(crate) fn resource_references(content: &str) -> Vec<ResourceReference> {
    let body = crate::document_export::markdown_body(content);
    let offset = content.len() - body.len();
    resource_destinations_in_body(body)
        .into_iter()
        .map(|reference| ResourceReference {
            range: (reference.range.start + offset)..(reference.range.end + offset),
            destination: reference.destination,
        })
        .collect()
}

pub(crate) fn reference_destination(markdown: &str, literal: &str) -> Option<String> {
    resource_references(markdown)
        .into_iter()
        .find(|reference| &markdown[reference.range.clone()] == literal)
        .map(|reference| reference.destination)
}

fn resource_destinations_in_body(content: &str) -> Vec<ResourceReference> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(content, options);
    let mut offsets = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        let source = &content[definition.span.clone()];
        let mut escaped = false;
        for (index, byte) in source.bytes().enumerate() {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b']' && source.as_bytes().get(index + 1) == Some(&b':') {
                offsets.push((
                    destination_start(
                        content,
                        definition.span.start + index + 2,
                        definition.span.end,
                    ),
                    definition.dest.to_string(),
                ));
                break;
            }
        }
    }

    let mut links: Vec<(Option<String>, usize)> = Vec::new();
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
                    (link_type == LinkType::Inline).then(|| dest_url.to_string()),
                    range.start,
                ));
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((Some(destination), label_end)) = links.pop() {
                    // Child offsets exclude the link syntax, so a `](` inside label code
                    // or a nested image cannot be mistaken for this destination.
                    if let Some(index) = content[label_end..range.end].find("](") {
                        offsets.push((
                            destination_start(content, label_end + index + 2, range.end),
                            destination,
                        ));
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

    let mut ranges: Vec<ResourceReference> = offsets
        .into_iter()
        .map(|(start, destination)| {
            let bytes = content.as_bytes();
            let wrapped = start > 0 && bytes[start - 1] == b'<';
            let mut end = start;
            let mut depth = 0_u32;
            while end < bytes.len() {
                match bytes[end] {
                    b'\\' if end + 1 < bytes.len() && bytes[end + 1].is_ascii_punctuation() => {
                        end += 2;
                        continue;
                    }
                    b'>' if wrapped => break,
                    b'(' if !wrapped => depth += 1,
                    b')' if !wrapped => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    byte if !wrapped && byte.is_ascii_whitespace() => break,
                    _ => {}
                }
                end += 1;
            }
            ResourceReference {
                range: start..end,
                destination,
            }
        })
        .collect();
    html_resource_offsets(content, &html_ranges, &mut ranges);
    ranges.sort_by_key(|reference| reference.range.start);
    ranges.dedup_by(|left, right| left.range == right.range);
    ranges
}

pub(crate) fn rewrite_destinations(
    content: &str,
    replacements: &std::collections::BTreeMap<String, String>,
) -> String {
    let mut rewritten = content.to_string();
    for range in resource_destinations(content).into_iter().rev() {
        if let Some(replacement) = replacements.get(&content[range.clone()]) {
            rewritten.replace_range(range, replacement);
        }
    }
    rewritten
}

// A decoded destination must be serialized before inserting it into either Markdown or HTML.
// In particular, a literal "&copy;" from an already-decoded fragment must not decode a second time.
pub(crate) fn serialize_destination(destination: &str) -> String {
    let mut serialized = String::new();
    for character in destination.chars() {
        match character {
            '&' => serialized.push_str("&amp;"),
            '<' => serialized.push_str("&lt;"),
            '>' => serialized.push_str("&gt;"),
            '"' => serialized.push_str("&quot;"),
            '\'' => serialized.push_str("&#39;"),
            '(' => serialized.push_str("&#40;"),
            ')' => serialized.push_str("&#41;"),
            '\\' => serialized.push_str("&#92;"),
            character if character.is_whitespace() => {
                serialized.push_str(&format!("&#{};", character as u32))
            }
            character => serialized.push(character),
        }
    }
    serialized
}

pub(crate) fn encode_destination(value: &str) -> String {
    let mut encoded = String::new();
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 15) as usize]));
        }
    }
    encoded
}

fn rewrite_resource_destinations(content: &str, folder_name: &str) -> String {
    let prefix = format!("{}/", encode_destination(folder_name));
    let replacements = resource_references(content)
        .into_iter()
        .filter(|reference| is_resource_destination(&reference.destination))
        .map(|reference| content[reference.range].to_string())
        .map(|value| (value.clone(), format!("{prefix}{value}")))
        .collect();
    rewrite_destinations(content, &replacements)
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
