use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use tempfile::NamedTempFile;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionRead {
    pub session: Option<Value>,
    pub warning: Option<String>,
}

pub fn read_workspace_session_file(path: &Path) -> Result<WorkspaceSessionRead, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceSessionRead {
                session: None,
                warning: None,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let session: Value = match serde_json::from_slice(&bytes) {
        Ok(session) => session,
        Err(_) => {
            return Ok(WorkspaceSessionRead {
                session: None,
                warning: Some("工作区会话文件损坏，已跳过恢复。".to_string()),
            });
        }
    };
    if session.get("version").and_then(Value::as_u64) != Some(1) {
        return Ok(WorkspaceSessionRead {
            session: None,
            warning: Some("工作区会话版本不支持，已跳过恢复。".to_string()),
        });
    }
    Ok(WorkspaceSessionRead {
        session: Some(session),
        warning: None,
    })
}

pub fn write_workspace_session_file(path: &Path, session: &Value) -> Result<(), String> {
    if session.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("工作区会话版本无效。".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "工作区会话路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(session).map_err(|error| error.to_string())?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}
