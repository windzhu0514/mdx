use crate::agent_ipc::{AgentServer, EndpointRegistry};
use crate::agent_protocol::{
    AgentBridgeStatus, AgentDocumentEvent, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AGENT_ACCESS_DISABLED, BRIDGE_UNAVAILABLE, PROTOCOL_VERSION, REQUEST_TIMEOUT, TIMEOUT,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{broadcast, oneshot};

const AGENT_REQUEST_EVENT: &str = "mora://agent-request";
const AGENT_STATUS_EVENT: &str = "mora://agent-status";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFrontendRequest {
    request_id: String,
    #[serde(flatten)]
    request: AgentFrontendRequestKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AgentFrontendRequestKind {
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFrontendResponse {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<AgentResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AgentError>,
}

impl AgentFrontendResponse {
    fn failure(request_id: impl Into<String>, error: AgentError) -> Self {
        Self {
            request_id: request_id.into(),
            result: None,
            error: Some(error),
        }
    }

    fn into_result(self) -> Result<AgentResult, AgentError> {
        match (self.result, self.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(error),
            _ => Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent frontend returned an invalid response.",
            )),
        }
    }
}

#[derive(Clone)]
pub struct AgentBridgeState {
    inner: Arc<AgentBridgeInner>,
}

struct AgentBridgeInner {
    runtime: Mutex<Option<BridgeRuntime>>,
    pending: Mutex<HashMap<String, oneshot::Sender<AgentFrontendResponse>>>,
    lifecycle_gate: tokio::sync::Mutex<()>,
    write_gate: tokio::sync::Mutex<()>,
    events: broadcast::Sender<AgentDocumentEvent>,
    status: RwLock<AgentBridgeStatus>,
    closed: AtomicBool,
}

struct BridgeRuntime {
    session_id: String,
    server: Option<AgentServer>,
    counts_task: Option<tokio::task::JoinHandle<()>>,
}

impl BridgeRuntime {
    async fn stop(mut self) -> Result<(), AgentError> {
        if let Some(task) = self.counts_task.take() {
            task.abort();
        }
        if let Some(server) = self.server.take() {
            server.stop().await?;
        }
        Ok(())
    }
}

impl Drop for BridgeRuntime {
    fn drop(&mut self) {
        // Dropping AgentServer synchronously aborts accept work and removes only
        // the endpoint matching its own session descriptor.
        if let Some(task) = self.counts_task.take() {
            task.abort();
        }
        drop(self.server.take());
    }
}

impl Default for AgentBridgeState {
    fn default() -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            inner: Arc::new(AgentBridgeInner {
                runtime: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                lifecycle_gate: tokio::sync::Mutex::new(()),
                write_gate: tokio::sync::Mutex::new(()),
                events,
                status: RwLock::new(AgentBridgeStatus {
                    enabled: false,
                    listening: false,
                    connected_clients: 0,
                    watcher_clients: 0,
                    cli_path: None,
                    protocol_version: PROTOCOL_VERSION,
                    last_error: None,
                }),
                closed: AtomicBool::new(false),
            }),
        }
    }
}

impl AgentBridgeState {
    pub(crate) fn shutdown_now(&self) {
        self.inner.closed.store(true, Ordering::Release);
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            drop(runtime.take());
        }
        if let Ok(mut pending) = self.inner.pending.lock() {
            for (request_id, sender) in std::mem::take(&mut *pending) {
                let _ = sender.send(AgentFrontendResponse::failure(
                    request_id,
                    AgentError::new(
                        AGENT_ACCESS_DISABLED,
                        "Local Agent access stopped with the Mora window.",
                    ),
                ));
            }
        }
        if let Ok(mut status) = self.inner.status.write() {
            status.enabled = false;
            status.listening = false;
            status.connected_clients = 0;
            status.watcher_clients = 0;
        }
    }

    fn status(&self) -> Result<AgentBridgeStatus, AgentError> {
        self.inner
            .status
            .read()
            .map(|status| status.clone())
            .map_err(|_| bridge_state_error())
    }

    fn update_cli_path<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), AgentError> {
        let mut status = self
            .inner
            .status
            .write()
            .map_err(|_| bridge_state_error())?;
        status.cli_path = resolve_cli_path(app);
        Ok(())
    }

    fn emit_status<R: Runtime>(&self, app: &AppHandle<R>) -> Result<AgentBridgeStatus, AgentError> {
        let status = self.status()?;
        app.emit(AGENT_STATUS_EVENT, &status).map_err(|_| {
            AgentError::new(
                BRIDGE_UNAVAILABLE,
                "Could not publish the Agent bridge status.",
            )
        })?;
        Ok(status)
    }

    async fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Result<AgentBridgeStatus, AgentError> {
        let _lifecycle_guard = self.inner.lifecycle_gate.lock().await;
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(AgentError::new(
                AGENT_ACCESS_DISABLED,
                "Local Agent access stopped with the Mora window.",
            ));
        }
        self.update_cli_path(app)?;
        if self
            .inner
            .runtime
            .lock()
            .map_err(|_| bridge_state_error())?
            .is_some()
        {
            return self.status();
        }

        let registry = EndpointRegistry::for_current_user()?;
        let handler_state = Arc::downgrade(&self.inner);
        let handler_app = app.clone();
        let server = match AgentServer::start(registry, move |request| {
            let state = handler_state
                .upgrade()
                .map(|inner| AgentBridgeState { inner });
            let app = handler_app.clone();
            async move {
                let state = state.ok_or_else(|| {
                    AgentError::new(AGENT_ACCESS_DISABLED, "Local Agent access is disabled.")
                })?;
                state.handle_agent_request(&app, request).await
            }
        })
        .await
        {
            Ok(server) => server,
            Err(error) => {
                {
                    let mut status = self
                        .inner
                        .status
                        .write()
                        .map_err(|_| bridge_state_error())?;
                    status.enabled = false;
                    status.listening = false;
                    status.connected_clients = 0;
                    status.watcher_clients = 0;
                    status.last_error = Some(error.message.clone());
                }
                let _ = self.emit_status(app);
                return Err(error);
            }
        };
        let session_id = server.descriptor().session_id.clone();
        let mut connection_counts = server.subscribe_connection_counts();

        {
            let mut runtime = self
                .inner
                .runtime
                .lock()
                .map_err(|_| bridge_state_error())?;
            if self.inner.closed.load(Ordering::Acquire) {
                drop(server);
                return Err(AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access stopped with the Mora window.",
                ));
            }
            if runtime.is_some() {
                drop(server);
                return self.status();
            }
            *runtime = Some(BridgeRuntime {
                session_id: session_id.clone(),
                server: Some(server),
                counts_task: None,
            });
        }
        {
            let mut status = self
                .inner
                .status
                .write()
                .map_err(|_| bridge_state_error())?;
            status.enabled = true;
            status.listening = true;
            status.last_error = None;
        }
        let counts_state = Arc::downgrade(&self.inner);
        let counts_app = app.clone();
        let counts_task = tokio::spawn(async move {
            while connection_counts.changed().await.is_ok() {
                let Some(inner) = counts_state.upgrade() else {
                    return;
                };
                let counts_state = AgentBridgeState { inner };
                let counts = *connection_counts.borrow_and_update();
                let updated = counts_state
                    .inner
                    .status
                    .write()
                    .map(|mut status| {
                        status.connected_clients = counts.connected_clients;
                        status.watcher_clients = counts.watcher_clients;
                    })
                    .is_ok();
                if updated {
                    let _ = counts_state.emit_status(&counts_app);
                }
            }
        });
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            if let Some(runtime) = runtime
                .as_mut()
                .filter(|runtime| runtime.session_id == session_id)
            {
                runtime.counts_task = Some(counts_task);
            } else {
                counts_task.abort();
            }
        } else {
            counts_task.abort();
        }
        self.emit_status(app)
    }

    async fn stop<R: Runtime>(&self, app: &AppHandle<R>) -> Result<AgentBridgeStatus, AgentError> {
        let _lifecycle_guard = self.inner.lifecycle_gate.lock().await;
        let runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| bridge_state_error())?
            .take();

        let pending = {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|_| bridge_state_error())?;
            std::mem::take(&mut *pending)
        };
        for (request_id, sender) in pending {
            let _ = sender.send(AgentFrontendResponse::failure(
                request_id,
                AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access was disabled before the request completed.",
                ),
            ));
        }

        let stop_result = if let Some(runtime) = runtime {
            runtime.stop().await
        } else {
            Ok(())
        };
        {
            let mut status = self
                .inner
                .status
                .write()
                .map_err(|_| bridge_state_error())?;
            status.enabled = false;
            status.listening = false;
            status.connected_clients = 0;
            status.watcher_clients = 0;
            status.last_error = stop_result
                .as_ref()
                .err()
                .map(|error| error.message.clone());
        }
        let status = self.emit_status(app)?;
        stop_result.map(|_| status)
    }

    async fn handle_agent_request<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentRequest,
    ) -> Result<AgentResult, AgentError> {
        match request.request {
            AgentRequestKind::Status | AgentRequestKind::Watch { .. } => {
                Ok(AgentResult::Status(self.status()?))
            }
            _ => self.forward_to_frontend(app, request).await,
        }
    }

    async fn forward_to_frontend<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentRequest,
    ) -> Result<AgentResult, AgentError> {
        self.guard_write(&request, self.dispatch_frontend(app, request.clone()))
            .await
    }

    async fn guard_write<T, F>(&self, request: &AgentRequest, operation: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        let _write_guard = if matches!(
            request.request,
            AgentRequestKind::ReplaceDocument { .. } | AgentRequestKind::SaveDocument { .. }
        ) {
            Some(self.inner.write_gate.lock().await)
        } else {
            None
        };
        operation.await
    }

    async fn dispatch_frontend<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentRequest,
    ) -> Result<AgentResult, AgentError> {
        let frontend_request = frontend_request(request)?;
        let request_id = frontend_request.request_id.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|_| bridge_state_error())?;
            if pending.contains_key(&request_id) {
                return Err(AgentError::new(
                    BRIDGE_UNAVAILABLE,
                    "The Agent request identifier is already pending.",
                ));
            }
            pending.insert(request_id.clone(), sender);
        }

        if app.emit(AGENT_REQUEST_EVENT, &frontend_request).is_err() {
            self.remove_pending(&request_id)?;
            return Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "Could not forward the Agent request to the Mora window.",
            ));
        }

        let response = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.remove_pending(&request_id)?;
                return Err(AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access stopped before the request completed.",
                ));
            }
            Err(_) => {
                self.remove_pending(&request_id)?;
                return Err(AgentError::new(
                    TIMEOUT,
                    "The Mora window did not complete the Agent request in time.",
                ));
            }
        };
        self.remove_pending(&request_id)?;
        response.into_result()
    }

    fn remove_pending(&self, request_id: &str) -> Result<(), AgentError> {
        self.inner
            .pending
            .lock()
            .map_err(|_| bridge_state_error())?
            .remove(request_id);
        Ok(())
    }

    fn complete_frontend(&self, response: AgentFrontendResponse) -> Result<(), AgentError> {
        let sender = self
            .inner
            .pending
            .lock()
            .map_err(|_| bridge_state_error())?
            .remove(&response.request_id)
            .ok_or_else(|| {
                AgentError::new(
                    BRIDGE_UNAVAILABLE,
                    "The Agent request is no longer pending.",
                )
            })?;
        sender.send(response).map_err(|_| {
            AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent request receiver is no longer available.",
            )
        })
    }

    fn publish_events(&self, events: Vec<AgentDocumentEvent>) -> Result<(), AgentError> {
        let runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| bridge_state_error())?;
        let server = runtime
            .as_ref()
            .and_then(|runtime| runtime.server.as_ref())
            .ok_or_else(|| {
                AgentError::new(AGENT_ACCESS_DISABLED, "Local Agent access is disabled.")
            })?;
        for event in events {
            let _ = self.inner.events.send(event.clone());
            server.publish_event(event);
        }
        Ok(())
    }
}

fn frontend_request(request: AgentRequest) -> Result<AgentFrontendRequest, AgentError> {
    let request_id = request.request_id;
    let request = match request.request {
        AgentRequestKind::ListDocuments => AgentFrontendRequestKind::ListDocuments,
        AgentRequestKind::ReadDocument { document_id } => {
            AgentFrontendRequestKind::ReadDocument { document_id }
        }
        AgentRequestKind::ReplaceDocument {
            document_id,
            base_live_revision,
            content,
        } => AgentFrontendRequestKind::ReplaceDocument {
            document_id,
            base_live_revision,
            content,
        },
        AgentRequestKind::SaveDocument {
            document_id,
            base_live_revision,
        } => AgentFrontendRequestKind::SaveDocument {
            document_id,
            base_live_revision,
        },
        AgentRequestKind::Status | AgentRequestKind::Watch { .. } => {
            return Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent request does not require the Mora window.",
            ));
        }
    };
    Ok(AgentFrontendRequest {
        request_id,
        request,
    })
}

fn resolve_cli_path<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let executable_name = format!("mora-agent{}", std::env::consts::EXE_SUFFIX);
    let mut candidates = Vec::<PathBuf>::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(&executable_name));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&executable_name));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn bridge_state_error() -> AgentError {
    AgentError::new(BRIDGE_UNAVAILABLE, "The Agent bridge state is unavailable.")
}

#[tauri::command]
pub async fn set_agent_access_enabled(
    app: AppHandle,
    state: State<'_, AgentBridgeState>,
    enabled: bool,
) -> Result<AgentBridgeStatus, AgentError> {
    if enabled {
        state.start(&app).await
    } else {
        state.stop(&app).await
    }
}

#[tauri::command]
pub fn get_agent_bridge_status(
    app: AppHandle,
    state: State<'_, AgentBridgeState>,
) -> Result<AgentBridgeStatus, AgentError> {
    state.update_cli_path(&app)?;
    state.status()
}

#[tauri::command]
pub fn complete_agent_request(
    state: State<'_, AgentBridgeState>,
    response: AgentFrontendResponse,
) -> Result<(), AgentError> {
    state.complete_frontend(response)
}

#[tauri::command]
pub fn publish_agent_document_events(
    state: State<'_, AgentBridgeState>,
    events: Vec<AgentDocumentEvent>,
) -> Result<(), AgentError> {
    state.publish_events(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_protocol::{
        AgentDocumentSummary, AgentRequest, AgentRequestKind, AgentResult, REVISION_CONFLICT,
    };
    use std::sync::{Arc, Mutex};

    fn replace_request(request_id: &str) -> AgentRequest {
        AgentRequest {
            protocol_version: crate::agent_protocol::PROTOCOL_VERSION,
            request_id: request_id.to_string(),
            request: AgentRequestKind::ReplaceDocument {
                document_id: "document-1".to_string(),
                base_live_revision: "revision-1".to_string(),
                content: format!("content from {request_id}"),
            },
        }
    }

    fn summary(live_revision: &str) -> AgentDocumentSummary {
        AgentDocumentSummary {
            id: "document-1".to_string(),
            path: Some("C:\\Notes\\bridge.mdx".to_string()),
            title: "bridge.mdx".to_string(),
            dirty: true,
            conflict: false,
            unavailable: false,
            live_revision: live_revision.to_string(),
            disk_revision: None,
        }
    }

    #[tokio::test]
    async fn synchronous_shutdown_fails_pending_requests() {
        let state = AgentBridgeState::default();
        let (sender, receiver) = oneshot::channel();
        state
            .inner
            .pending
            .lock()
            .unwrap()
            .insert("pending-1".to_string(), sender);
        state.inner.status.write().unwrap().enabled = true;

        state.shutdown_now();

        let response = receiver.await.unwrap();
        assert_eq!(response.error.unwrap().code, AGENT_ACCESS_DISABLED);
        assert!(!state.status().unwrap().enabled);
    }

    #[tokio::test]
    async fn serializes_replaces_with_the_same_base_revision() {
        let state = AgentBridgeState::default();
        let live_revision = Arc::new(Mutex::new("revision-1".to_string()));
        let first = replace_request("replace-1");
        let second = replace_request("replace-2");
        let first_revision = live_revision.clone();
        let second_revision = live_revision.clone();

        async fn replace(
            live_revision: Arc<Mutex<String>>,
            request: AgentRequest,
        ) -> Result<AgentResult, crate::agent_protocol::AgentError> {
            let AgentRequestKind::ReplaceDocument {
                base_live_revision, ..
            } = request.request
            else {
                unreachable!()
            };
            let mut current = live_revision.lock().unwrap();
            if base_live_revision != *current {
                return Err(crate::agent_protocol::AgentError::new(
                    REVISION_CONFLICT,
                    "The document changed before the Agent replacement.",
                ));
            }
            *current = "revision-2".to_string();
            Ok(AgentResult::Mutation(summary(&current)))
        }

        let (first, second) = tokio::join!(
            state.guard_write(&first, replace(first_revision, first.clone())),
            state.guard_write(&second, replace(second_revision, second.clone())),
        );
        let results = [first, second];

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.code == REVISION_CONFLICT)
                .count(),
            1,
        );
    }
}
