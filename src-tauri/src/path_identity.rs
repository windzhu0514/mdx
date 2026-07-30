use std::path::{Path, PathBuf};

pub fn normalize_path(path: &Path) -> Result<String, String> {
    let absolute = if path.exists() {
        std::fs::canonicalize(path).map_err(|error| error.to_string())?
    } else {
        std::path::absolute(path).map_err(|error| error.to_string())?
    };

    Ok(lexically_normalize(&absolute).to_string_lossy().to_string())
}

pub fn path_identity(path: &Path) -> Result<String, String> {
    let normalized = normalize_path(path)?;
    #[cfg(windows)]
    {
        Ok(normalized.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(normalized)
    }
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
