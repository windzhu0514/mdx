use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use std::time::Duration;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_CONNECTIONS: usize = 8;

pub const AGENT_ACCESS_DISABLED: &str = "AGENT_ACCESS_DISABLED";
pub const MORA_NOT_RUNNING: &str = "MORA_NOT_RUNNING";
pub const BRIDGE_UNAVAILABLE: &str = "BRIDGE_UNAVAILABLE";
pub const BRIDGE_ALREADY_RUNNING: &str = "BRIDGE_ALREADY_RUNNING";
pub const DOCUMENT_NOT_FOUND: &str = "DOCUMENT_NOT_FOUND";
pub const DOCUMENT_NOT_OPEN: &str = "DOCUMENT_NOT_OPEN";
pub const DOCUMENT_BUSY: &str = "DOCUMENT_BUSY";
pub const SAVE_AS_REQUIRED: &str = "SAVE_AS_REQUIRED";
pub const REVISION_CONFLICT: &str = "REVISION_CONFLICT";
pub const DISK_CONFLICT: &str = "DISK_CONFLICT";
pub const INVALID_MDX: &str = "INVALID_MDX";
pub const REQUEST_TOO_LARGE: &str = "REQUEST_TOO_LARGE";
pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const TIMEOUT: &str = "TIMEOUT";
pub const PROTOCOL_MISMATCH: &str = "PROTOCOL_MISMATCH";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(flatten)]
    pub request: AgentRequestKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRequestKind {
    Status,
    ListDocuments,
    ReadDocument {
        document_id: String,
    },
    ReplaceDocument {
        document_id: String,
        base_live_revision: String,
        content: String,
    },
    SaveDocument {
        document_id: String,
        base_live_revision: String,
    },
    Watch {
        document_id: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl Serialize for AgentError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let detail = self.detail.clone().and_then(sanitize_error_detail);
        let mut state =
            serializer.serialize_struct("AgentError", if detail.is_some() { 3 } else { 2 })?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        if let Some(detail) = detail {
            state.serialize_field("detail", &detail)?;
        }
        state.end()
    }
}

impl AgentError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = sanitize_error_detail(detail);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeStatus {
    pub enabled: bool,
    pub listening: bool,
    pub connected_clients: usize,
    pub watcher_clients: usize,
    pub cli_path: Option<String>,
    pub protocol_version: u16,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentSummary {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub dirty: bool,
    pub conflict: bool,
    pub unavailable: bool,
    pub live_revision: String,
    pub disk_revision: Option<AgentDiskRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiskRevision {
    pub path: String,
    pub modified_at_ms: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentSnapshot {
    #[serde(flatten)]
    pub summary: AgentDocumentSummary,
    pub content: String,
    pub meta: Option<Value>,
}

pub type AgentMutationResult = AgentDocumentSummary;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentChangeSource {
    Editor,
    Agent,
    Disk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentEvent {
    pub document_id: String,
    pub live_revision: String,
    pub dirty: bool,
    pub source: AgentChangeSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentResult {
    Status(AgentBridgeStatus),
    Documents(Vec<AgentDocumentSummary>),
    Document(AgentDocumentSnapshot),
    Mutation(AgentMutationResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentError>,
}

impl AgentResponse {
    pub fn success(request_id: impl Into<String>, result: AgentResult) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: impl Into<String>, error: AgentError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentServerMessage {
    Response {
        #[serde(flatten)]
        response: AgentResponse,
    },
    Event {
        #[serde(flatten)]
        event: AgentDocumentEvent,
    },
}

pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, AgentError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(frame_too_large());
    }
    validate_json_payload(payload)?;

    let payload_length = u32::try_from(payload.len()).map_err(|_| frame_too_large())?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<Vec<u8>, AgentError> {
    if frame.len() < 4 {
        return Err(AgentError::new(
            PROTOCOL_MISMATCH,
            "Agent frame is missing its length prefix.",
        ));
    }

    let declared_length = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if declared_length > MAX_FRAME_BYTES || frame.len() - 4 > MAX_FRAME_BYTES {
        return Err(frame_too_large());
    }
    if frame.len() - 4 != declared_length {
        return Err(AgentError::new(
            PROTOCOL_MISMATCH,
            "Agent frame length does not match its payload.",
        ));
    }

    validate_json_payload(&frame[4..])?;

    Ok(frame[4..].to_vec())
}

fn sanitize_error_detail(detail: Value) -> Option<Value> {
    let Value::Object(detail) = detail else {
        return None;
    };
    let mut stable_detail = serde_json::Map::new();
    for key in ["documentId", "currentLiveRevision", "currentDiskRevision"] {
        if let Some(value) = detail.get(key) {
            stable_detail.insert(key.to_string(), remove_document_content(value.clone()));
        }
    }
    (!stable_detail.is_empty()).then(|| Value::Object(stable_detail))
}

fn remove_document_content(value: Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.into_iter().map(remove_document_content).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| key != "content")
                .map(|(key, value)| (key, remove_document_content(value)))
                .collect(),
        ),
        value => value,
    }
}

fn validate_json_payload(payload: &[u8]) -> Result<(), AgentError> {
    let payload = std::str::from_utf8(payload).map_err(|_| {
        AgentError::new(
            PROTOCOL_MISMATCH,
            "Agent frame payload must be valid UTF-8 JSON.",
        )
    })?;
    serde_json::from_str::<Value>(payload).map_err(|_| {
        AgentError::new(
            PROTOCOL_MISMATCH,
            "Agent frame payload must be valid UTF-8 JSON.",
        )
    })?;
    Ok(())
}

fn frame_too_large() -> AgentError {
    AgentError::new(
        REQUEST_TOO_LARGE,
        "Agent request exceeds the frame size limit.",
    )
}
