use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMarkdown {
    pub title: String,
    pub content: String,
    pub front_matter: Option<FrontMatterData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrontMatterData {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub extra: HashMap<String, Value>,
}

pub fn import_markdown_file(path: &Path) -> Result<ImportedMarkdown, String> {
    let raw = fs::read_to_string(path).map_err(|error| format!("无法读取文件：{error}"))?;
    parse_markdown(path, &raw)
}

pub fn parse_markdown(path: &Path, raw: &str) -> Result<ImportedMarkdown, String> {
    let (front_matter, content) = split_front_matter(raw);
    let fallback_title = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "无标题笔记".to_string());
    let title = front_matter
        .as_ref()
        .map(|value| value.title.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(fallback_title);

    Ok(ImportedMarkdown {
        title,
        content,
        front_matter,
    })
}

fn split_front_matter(raw: &str) -> (Option<FrontMatterData>, String) {
    let without_bom = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let normalized = without_bom.replace("\r\n", "\n");
    let Some(after_opening) = normalized.strip_prefix("---\n") else {
        return (None, without_bom.to_string());
    };
    let Some(end) = after_opening.find("\n---") else {
        return (None, without_bom.to_string());
    };

    let boundary_end = end + 4;
    let suffix = &after_opening[boundary_end..];
    if !suffix.is_empty() && !suffix.starts_with('\n') {
        return (None, without_bom.to_string());
    }

    let yaml = after_opening[..end].trim();
    let body = suffix.trim_start_matches('\n').to_string();
    (Some(parse_simple_yaml(yaml)), body)
}

fn parse_simple_yaml(yaml: &str) -> FrontMatterData {
    let mut front_matter = FrontMatterData::default();
    let mut current_list_key: Option<String> = None;
    let mut list_items = Vec::new();

    for line in yaml.lines() {
        let trimmed = line.trim();
        if let Some(item) = trimmed.strip_prefix("- ") {
            if current_list_key.is_some() {
                list_items.push(clean_scalar(item));
            }
            continue;
        }

        flush_list(&mut front_matter, &mut current_list_key, &mut list_items);
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let raw_value = raw_value.trim();
        if raw_value.is_empty() {
            current_list_key = Some(key.to_string());
            continue;
        }

        if raw_value.starts_with('[') && raw_value.ends_with(']') {
            let items = raw_value[1..raw_value.len() - 1]
                .split(',')
                .map(clean_scalar)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            apply_list(&mut front_matter, key, &items);
            continue;
        }

        apply_scalar(&mut front_matter, key, raw_value);
    }

    flush_list(&mut front_matter, &mut current_list_key, &mut list_items);
    front_matter
}

fn clean_scalar(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn flush_list(
    front_matter: &mut FrontMatterData,
    current_key: &mut Option<String>,
    items: &mut Vec<String>,
) {
    if let Some(key) = current_key.take() {
        apply_list(front_matter, &key, items);
        items.clear();
    }
}

fn apply_scalar(front_matter: &mut FrontMatterData, key: &str, raw_value: &str) {
    let value = clean_scalar(raw_value);
    match key {
        "title" => front_matter.title = value,
        "date" => front_matter.date = value,
        "author" => front_matter.author = value,
        "summary" | "description" | "excerpt" => front_matter.summary = value,
        "draft" => front_matter.draft = value.eq_ignore_ascii_case("true"),
        _ => {
            front_matter
                .extra
                .insert(key.to_string(), parse_extra_value(raw_value, &value));
        }
    }
}

fn apply_list(front_matter: &mut FrontMatterData, key: &str, items: &[String]) {
    match key {
        "tags" | "tag" => front_matter.tags = items.to_vec(),
        "categories" | "category" => front_matter.categories = items.to_vec(),
        _ => {
            front_matter.extra.insert(
                key.to_string(),
                Value::Array(items.iter().cloned().map(Value::String).collect()),
            );
        }
    }
}

fn parse_extra_value(raw_value: &str, clean_value: &str) -> Value {
    if raw_value.eq_ignore_ascii_case("true") {
        Value::Bool(true)
    } else if raw_value.eq_ignore_ascii_case("false") {
        Value::Bool(false)
    } else if let Ok(value) = raw_value.parse::<i64>() {
        Value::Number(value.into())
    } else if let Ok(value) = raw_value.parse::<f64>() {
        serde_json::json!(value)
    } else {
        Value::String(clean_value.to_string())
    }
}
