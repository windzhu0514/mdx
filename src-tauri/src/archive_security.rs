use std::collections::HashSet;
use std::io::{Read, Seek};

use zip::ZipArchive;

pub const MAX_ARCHIVE_ENTRIES: usize = 4096;
pub const MAX_TEXT_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_RESOURCE_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const SUPPORTED_MAJOR_VERSION: u32 = 1;

pub fn parse_supported_format_version(version: &str) -> Result<(u32, u32, u32), String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("文件格式版本无效。".to_string());
    }

    let parse_part = |part: &str| {
        if !part.chars().all(|ch| ch.is_ascii_digit()) {
            return Err("文件格式版本无效。".to_string());
        }
        part.parse::<u32>()
            .map_err(|_| "文件格式版本无效。".to_string())
    };

    let parsed = (
        parse_part(parts[0])?,
        parse_part(parts[1])?,
        parse_part(parts[2])?,
    );
    if parsed.0 > SUPPORTED_MAJOR_VERSION {
        return Err("文件格式版本过高，当前软件无法打开。".to_string());
    }
    if parsed.0 != SUPPORTED_MAJOR_VERSION {
        return Err("当前版本不支持该 MDXNote 主版本。".to_string());
    }
    Ok(parsed)
}

pub fn validate_archive_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\\')
        || name.contains(':')
        || name.contains('\0')
    {
        return Err("压缩包包含不安全的条目路径。".to_string());
    }

    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty()
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("压缩包包含不安全的条目路径。".to_string());
    }
    Ok(())
}

pub fn validate_new_resource_name(name: &str) -> Result<(), String> {
    validate_archive_entry_name(name)?;
    if name.ends_with('/') {
        return Err("资源路径不能是目录。".to_string());
    }

    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() != 2 || !matches!(parts[0], "assets" | "attachments") || parts[1].is_empty() {
        return Err("资源只能写入 assets/ 或 attachments/ 根目录。".to_string());
    }
    Ok(())
}

fn entry_limit(name: &str) -> u64 {
    if name.starts_with("assets/")
        || name.starts_with("attachments/")
        || name.starts_with("thumbnails/")
    {
        MAX_RESOURCE_ENTRY_BYTES
    } else {
        MAX_TEXT_ENTRY_BYTES
    }
}

pub fn validate_archive<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("MDXNote 文件包含过多条目。".to_string());
    }

    let mut names = HashSet::new();
    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|err| err.to_string())?;
        let name = file.name();
        validate_archive_entry_name(name)?;
        if !names.insert(name.to_string()) {
            return Err("MDXNote 文件包含重复条目。".to_string());
        }
        if file.size() > entry_limit(name) {
            return Err(format!("MDXNote 条目过大：{name}"));
        }
        total_size = total_size
            .checked_add(file.size())
            .ok_or_else(|| "MDXNote 文件解压大小溢出。".to_string())?;
        if total_size > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err("MDXNote 文件解压后总大小过大。".to_string());
        }
    }
    Ok(())
}
