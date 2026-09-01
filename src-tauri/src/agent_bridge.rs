use crate::agent_ipc::{AgentConnectionCounts, AgentServer, EndpointRegistry};
use crate::agent_protocol::{
    AgentBridgeStatus, AgentDocumentEvent, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AGENT_ACCESS_DISABLED, BRIDGE_UNAVAILABLE, PROTOCOL_VERSION, REQUEST_TIMEOUT, TIMEOUT,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{broadcast, oneshot};

const AGENT_REQUEST_EVENT: &str = "mora://agent-request";
const AGENT_STATUS_EVENT: &str = "mora://agent-status";
const AGENT_DISPATCH_INVALIDATED_EVENT: &str = "mora://agent-dispatch-invalidated";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFrontendRequest {
    request_id: String,
    dispatch_token: String,
    operation_generation: u64,
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
    dispatch_token: String,
    operation_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<AgentResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AgentError>,
}

impl AgentFrontendResponse {
    fn failure(
        request_id: impl Into<String>,
        dispatch_token: impl Into<String>,
        operation_generation: u64,
        error: AgentError,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            dispatch_token: dispatch_token.into(),
            operation_generation,
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

struct PendingFrontend {
    request_id: String,
    operation_generation: u64,
    is_write: bool,
    sender: oneshot::Sender<AgentFrontendResponse>,
}

impl PendingFrontend {
    fn fail(self, dispatch_token: String, error: AgentError) {
        let _ = self.sender.send(AgentFrontendResponse::failure(
            self.request_id,
            dispatch_token,
            self.operation_generation,
            error,
        ));
    }
}

#[derive(Clone)]
struct WriteOperations {
    gate: Arc<tokio::sync::Mutex<()>>,
    generation: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDispatchInvalidated {
    operation_generation: u64,
}

impl WriteOperations {
    fn new() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            generation: Arc::new(AtomicU64::new(1)),
        }
    }

    fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn invalidate(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    async fn drain(&self) {
        let _guard = self.gate.lock().await;
    }

    async fn run<T, F, Fut>(&self, generation: u64, operation: F) -> Result<T, AgentError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, AgentError>>,
    {
        let _guard = self.gate.lock().await;
        if generation != self.current_generation() {
            return Err(AgentError::new(
                AGENT_ACCESS_DISABLED,
                "Local Agent access changed before the write could start.",
            ));
        }
        operation().await
    }
}

async fn run_write_with_bounded_response<T, F>(
    operation: F,
    client_sender: oneshot::Sender<Result<T, AgentError>>,
    response_timeout: std::time::Duration,
) -> Result<T, AgentError>
where
    T: Clone,
    F: std::future::Future<Output = Result<T, AgentError>>,
{
    tokio::pin!(operation);
    tokio::select! {
        result = &mut operation => {
            let _ = client_sender.send(result.clone());
            result
        }
        _ = tokio::time::sleep(response_timeout) => {
            let _ = client_sender.send(Err(AgentError::new(
                TIMEOUT,
                "The Mora window did not complete the Agent request in time.",
            )));
            operation.await
        }
    }
}

#[derive(Clone)]
pub struct AgentBridgeState {
    inner: Arc<AgentBridgeInner>,
}

struct AgentBridgeInner {
    runtime: Mutex<Option<BridgeRuntime>>,
    pending: Mutex<HashMap<String, PendingFrontend>>,
    lifecycle_gate: tokio::sync::Mutex<()>,
    write_operations: WriteOperations,
    next_dispatch_token: AtomicU64,
    events: broadcast::Sender<AgentDocumentEvent>,
    status: RwLock<AgentBridgeStatus>,
    accepting_requests: AtomicBool,
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
            let _ = task.await;
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
                write_operations: WriteOperations::new(),
                next_dispatch_token: AtomicU64::new(1),
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
                accepting_requests: AtomicBool::new(false),
                closed: AtomicBool::new(false),
            }),
        }
    }
}

impl AgentBridgeState {
    pub(crate) fn shutdown_now(&self) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner
            .accepting_requests
            .store(false, Ordering::Release);
        self.inner.write_operations.invalidate();
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            drop(runtime.take());
        }
        if let Ok(mut pending) = self.inner.pending.lock() {
            for (dispatch_token, pending) in std::mem::take(&mut *pending) {
                pending.fail(
                    dispatch_token,
                    AgentError::new(
                        AGENT_ACCESS_DISABLED,
                        "Local Agent access stopped with the Mora window.",
                    ),
                );
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

    fn apply_connection_counts(
        &self,
        session_id: &str,
        counts: AgentConnectionCounts,
    ) -> Result<bool, AgentError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Ok(false);
        }
        let runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| bridge_state_error())?;
        if !runtime
            .as_ref()
            .is_some_and(|runtime| runtime.session_id == session_id)
        {
            return Ok(false);
        }
        let mut status = self
            .inner
            .status
            .write()
            .map_err(|_| bridge_state_error())?;
        status.connected_clients = counts.connected_clients;
        status.watcher_clients = counts.watcher_clients;
        Ok(true)
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
        if self
            .inner
            .status
            .write()
            .map(|mut status| {
                status.enabled = true;
                status.listening = true;
                status.last_error = None;
            })
            .is_err()
        {
            let error = bridge_state_error();
            let _ = self.rollback_started_runtime(&session_id, &error).await;
            return Err(error);
        }
        self.inner.accepting_requests.store(true, Ordering::Release);
        let counts_state = Arc::downgrade(&self.inner);
        let counts_app = app.clone();
        let counts_session_id = session_id.clone();
        let counts_task = tokio::spawn(async move {
            while connection_counts.changed().await.is_ok() {
                let Some(inner) = counts_state.upgrade() else {
                    return;
                };
                let counts_state = AgentBridgeState { inner };
                let counts = *connection_counts.borrow_and_update();
                let updated = counts_state
                    .apply_connection_counts(&counts_session_id, counts)
                    .unwrap_or(false);
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
        self.publish_started_status(&session_id, |status| {
            app.emit(AGENT_STATUS_EVENT, status).map_err(|_| {
                AgentError::new(
                    BRIDGE_UNAVAILABLE,
                    "Could not publish the Agent bridge status.",
                )
            })
        })
        .await
    }

    async fn stop<R: Runtime>(&self, app: &AppHandle<R>) -> Result<AgentBridgeStatus, AgentError> {
        let _lifecycle_guard = self.inner.lifecycle_gate.lock().await;
        self.inner
            .accepting_requests
            .store(false, Ordering::Release);
        let operation_generation = self.inner.write_operations.invalidate();
        let _ = app.emit(
            AGENT_DISPATCH_INVALIDATED_EVENT,
            AgentDispatchInvalidated {
                operation_generation,
            },
        );
        let runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| bridge_state_error())?
            .take();

        self.fail_pending(
            false,
            AgentError::new(
                AGENT_ACCESS_DISABLED,
                "Local Agent access was disabled before the request completed.",
            ),
        )?;

        let stop_result = if let Some(runtime) = runtime {
            runtime.stop().await
        } else {
            Ok(())
        };
        self.inner.write_operations.drain().await;
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
        let generation = self.inner.write_operations.current_generation();
        if !self.inner.accepting_requests.load(Ordering::Acquire) {
            return Err(AgentError::new(
                AGENT_ACCESS_DISABLED,
                "Local Agent access is disabled.",
            ));
        }
        if matches!(
            request.request,
            AgentRequestKind::ReplaceDocument { .. } | AgentRequestKind::SaveDocument { .. }
        ) {
            let state = self.clone();
            let app = app.clone();
            let operations = self.inner.write_operations.clone();
            let (sender, receiver) = oneshot::channel();
            tokio::spawn(async move {
                let operation = operations.run(generation, || {
                    state.dispatch_frontend_unbounded(&app, request, generation, true)
                });
                let _ = run_write_with_bounded_response(operation, sender, REQUEST_TIMEOUT).await;
            });
            match receiver.await {
                Ok(result) => result,
                Err(_) => Err(AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access stopped before the request completed.",
                )),
            }
        } else {
            self.dispatch_frontend_timed(app, request, generation).await
        }
    }

    async fn dispatch_frontend_timed<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentRequest,
        operation_generation: u64,
    ) -> Result<AgentResult, AgentError> {
        let request_id = request.request_id.clone();
        let (dispatch_token, receiver) =
            self.register_pending(&request_id, operation_generation, false)?;
        let frontend_request =
            frontend_request(request, dispatch_token.clone(), operation_generation)?;

        if app.emit(AGENT_REQUEST_EVENT, &frontend_request).is_err() {
            self.remove_pending(&dispatch_token)?;
            return Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "Could not forward the Agent request to the Mora window.",
            ));
        }

        let response = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.remove_pending(&dispatch_token)?;
                return Err(AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access stopped before the request completed.",
                ));
            }
            Err(_) => {
                self.remove_pending(&dispatch_token)?;
                return Err(AgentError::new(
                    TIMEOUT,
                    "The Mora window did not complete the Agent request in time.",
                ));
            }
        };
        response.into_result()
    }

    async fn dispatch_frontend_unbounded<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentRequest,
        operation_generation: u64,
        is_write: bool,
    ) -> Result<AgentResult, AgentError> {
        let request_id = request.request_id.clone();
        let (dispatch_token, receiver) =
            self.register_pending(&request_id, operation_generation, is_write)?;
        let frontend_request =
            frontend_request(request, dispatch_token.clone(), operation_generation)?;
        if app.emit(AGENT_REQUEST_EVENT, &frontend_request).is_err() {
            self.remove_pending(&dispatch_token)?;
            return Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "Could not forward the Agent request to the Mora window.",
            ));
        }
        receiver
            .await
            .map_err(|_| {
                AgentError::new(
                    AGENT_ACCESS_DISABLED,
                    "Local Agent access stopped before the request completed.",
                )
            })?
            .into_result()
    }

    fn register_pending(
        &self,
        request_id: &str,
        operation_generation: u64,
        is_write: bool,
    ) -> Result<(String, oneshot::Receiver<AgentFrontendResponse>), AgentError> {
        let sequence = self
            .inner
            .next_dispatch_token
            .fetch_add(1, Ordering::Relaxed);
        let dispatch_token = format!("dispatch-{operation_generation}-{sequence}");
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .map_err(|_| bridge_state_error())?
            .insert(
                dispatch_token.clone(),
                PendingFrontend {
                    request_id: request_id.to_string(),
                    operation_generation,
                    is_write,
                    sender,
                },
            );
        Ok((dispatch_token, receiver))
    }

    fn remove_pending(&self, dispatch_token: &str) -> Result<(), AgentError> {
        self.inner
            .pending
            .lock()
            .map_err(|_| bridge_state_error())?
            .remove(dispatch_token);
        Ok(())
    }

    fn complete_frontend(&self, response: AgentFrontendResponse) -> Result<(), AgentError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| bridge_state_error())?;
        let entry = pending.get(&response.dispatch_token).ok_or_else(|| {
            AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent request is no longer pending.",
            )
        })?;
        if entry.request_id != response.request_id
            || entry.operation_generation != response.operation_generation
        {
            return Err(AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent response identity does not match the pending request.",
            ));
        }
        let entry = pending.remove(&response.dispatch_token).ok_or_else(|| {
            AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent request is no longer pending.",
            )
        })?;
        entry.sender.send(response).map_err(|_| {
            AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The Agent request receiver is no longer available.",
            )
        })
    }

    fn fail_pending(&self, include_writes: bool, error: AgentError) -> Result<(), AgentError> {
        let failed = {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|_| bridge_state_error())?;
            let tokens = pending
                .iter()
                .filter_map(|(token, entry)| {
                    (include_writes || !entry.is_write).then_some(token.clone())
                })
                .collect::<Vec<_>>();
            tokens
                .into_iter()
                .filter_map(|token| pending.remove(&token).map(|entry| (token, entry)))
                .collect::<Vec<_>>()
        };
        for (dispatch_token, pending) in failed {
            pending.fail(dispatch_token, error.clone());
        }
        Ok(())
    }

    async fn publish_started_status<F>(
        &self,
        session_id: &str,
        publish: F,
    ) -> Result<AgentBridgeStatus, AgentError>
    where
        F: FnOnce(&AgentBridgeStatus) -> Result<(), AgentError>,
    {
        let status = match self.status() {
            Ok(status) => status,
            Err(error) => {
                let _ = self.rollback_started_runtime(session_id, &error).await;
                return Err(error);
            }
        };
        if let Err(error) = publish(&status) {
            self.rollback_started_runtime(session_id, &error).await?;
            return Err(error);
        }
        Ok(status)
    }

    async fn rollback_started_runtime(
        &self,
        session_id: &str,
        cause: &AgentError,
    ) -> Result<(), AgentError> {
        self.inner.write_operations.invalidate();
        self.inner
            .accepting_requests
            .store(false, Ordering::Release);
        let runtime = {
            let mut runtime = self
                .inner
                .runtime
                .lock()
                .map_err(|_| bridge_state_error())?;
            if runtime
                .as_ref()
                .is_some_and(|runtime| runtime.session_id == session_id)
            {
                runtime.take()
            } else {
                None
            }
        };
        self.fail_pending(
            false,
            AgentError::new(AGENT_ACCESS_DISABLED, "Local Agent access failed to start."),
        )?;
        if let Some(runtime) = runtime {
            let _ = runtime.stop().await;
        }
        self.inner.write_operations.drain().await;
        self.fail_pending(
            true,
            AgentError::new(AGENT_ACCESS_DISABLED, "Local Agent access failed to start."),
        )?;
        let mut status = self
            .inner
            .status
            .write()
            .map_err(|_| bridge_state_error())?;
        status.enabled = false;
        status.listening = false;
        status.connected_clients = 0;
        status.watcher_clients = 0;
        status.last_error = Some(cause.message.clone());
        Ok(())
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

fn frontend_request(
    request: AgentRequest,
    dispatch_token: String,
    operation_generation: u64,
) -> Result<AgentFrontendRequest, AgentError> {
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
        dispatch_token,
        operation_generation,
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
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::Notify;

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
        let (_token, receiver) = state.register_pending("pending-1", 1, false).unwrap();
        state.inner.status.write().unwrap().enabled = true;

        state.shutdown_now();

        let response = receiver.await.unwrap();
        assert_eq!(response.error.unwrap().code, AGENT_ACCESS_DISABLED);
        assert!(!state.status().unwrap().enabled);
    }

    #[test]
    fn stale_connection_count_task_cannot_update_a_restarted_runtime() {
        let state = AgentBridgeState::default();
        *state.inner.runtime.lock().unwrap() = Some(BridgeRuntime {
            session_id: "new-session".to_string(),
            server: None,
            counts_task: None,
        });

        let updated = state
            .apply_connection_counts(
                "old-session",
                AgentConnectionCounts {
                    connected_clients: 4,
                    watcher_clients: 2,
                },
            )
            .unwrap();

        assert!(!updated);
        let status = state.status().unwrap();
        assert_eq!(status.connected_clients, 0);
        assert_eq!(status.watcher_clients, 0);
    }

    #[test]
    fn closed_bridge_rejects_late_connection_count_updates() {
        let state = AgentBridgeState::default();
        *state.inner.runtime.lock().unwrap() = Some(BridgeRuntime {
            session_id: "closing-session".to_string(),
            server: None,
            counts_task: None,
        });
        state.inner.closed.store(true, Ordering::Release);

        let updated = state
            .apply_connection_counts(
                "closing-session",
                AgentConnectionCounts {
                    connected_clients: 3,
                    watcher_clients: 1,
                },
            )
            .unwrap();

        assert!(!updated);
        let status = state.status().unwrap();
        assert_eq!(status.connected_clients, 0);
        assert_eq!(status.watcher_clients, 0);
    }

    #[tokio::test]
    async fn stop_waits_for_a_delayed_save_before_reporting_drained() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let writes = Arc::new(AtomicUsize::new(0));
        let operation = {
            let operations = state.inner.write_operations.clone();
            let started = started.clone();
            let release = release.clone();
            let writes = writes.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        started.notify_one();
                        release.notified().await;
                        writes.fetch_add(1, AtomicOrdering::SeqCst);
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };
        started.notified().await;
        state.inner.write_operations.invalidate();
        let mut drain = {
            let operations = state.inner.write_operations.clone();
            tokio::spawn(async move { operations.drain().await })
        };

        assert!(tokio::time::timeout(Duration::from_millis(25), &mut drain)
            .await
            .is_err());
        release.notify_one();
        drain.await.unwrap();
        operation.await.unwrap().unwrap();
        let writes_at_stop_return = writes.load(AtomicOrdering::SeqCst);
        tokio::task::yield_now().await;

        assert_eq!(writes_at_stop_return, 1);
        assert_eq!(writes.load(AtomicOrdering::SeqCst), writes_at_stop_return);
    }

    #[tokio::test]
    async fn client_timeout_does_not_allow_the_next_write_to_overlap() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let first_started = Arc::new(Notify::new());
        let release_first = Arc::new(Notify::new());
        let second_started = Arc::new(Notify::new());
        let first = {
            let operations = state.inner.write_operations.clone();
            let first_started = first_started.clone();
            let release_first = release_first.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        first_started.notify_one();
                        release_first.notified().await;
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };
        first_started.notified().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        let second = {
            let operations = state.inner.write_operations.clone();
            let second_started = second_started.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        second_started.notify_one();
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };

        assert!(
            tokio::time::timeout(Duration::from_millis(25), second_started.notified())
                .await
                .is_err()
        );
        release_first.notify_one();

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn write_task_times_out_the_client_but_keeps_the_gate_until_settled() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let first_started = Arc::new(Notify::new());
        let release_first = Arc::new(Notify::new());
        let second_started = Arc::new(Notify::new());
        let (client_sender, client_receiver) = oneshot::channel();
        let first = {
            let operations = state.inner.write_operations.clone();
            let first_started = first_started.clone();
            let release_first = release_first.clone();
            tokio::spawn(async move {
                let operation = operations.run(generation, || async move {
                    first_started.notify_one();
                    release_first.notified().await;
                    Ok::<_, AgentError>(())
                });
                run_write_with_bounded_response(operation, client_sender, Duration::from_millis(25))
                    .await
            })
        };
        first_started.notified().await;
        let second = {
            let operations = state.inner.write_operations.clone();
            let second_started = second_started.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        second_started.notify_one();
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };

        let timeout = tokio::time::timeout(Duration::from_millis(100), client_receiver)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(timeout.code, TIMEOUT);
        assert!(!first.is_finished());
        assert!(
            tokio::time::timeout(Duration::from_millis(25), second_started.notified())
                .await
                .is_err()
        );

        release_first.notify_one();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn disable_rejects_a_queued_write_before_its_side_effect() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let first_started = Arc::new(Notify::new());
        let release_first = Arc::new(Notify::new());
        let writes = Arc::new(AtomicUsize::new(0));
        let first = {
            let operations = state.inner.write_operations.clone();
            let first_started = first_started.clone();
            let release_first = release_first.clone();
            let writes = writes.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        first_started.notify_one();
                        release_first.notified().await;
                        writes.fetch_add(1, AtomicOrdering::SeqCst);
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };
        first_started.notified().await;
        let second = {
            let operations = state.inner.write_operations.clone();
            let writes = writes.clone();
            tokio::spawn(async move {
                operations
                    .run(generation, || async move {
                        writes.fetch_add(1, AtomicOrdering::SeqCst);
                        Ok::<_, AgentError>(())
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;

        state.inner.write_operations.invalidate();
        release_first.notify_one();
        state.inner.write_operations.drain().await;

        first.await.unwrap().unwrap();
        let error = second.await.unwrap().unwrap_err();
        assert_eq!(error.code, AGENT_ACCESS_DISABLED);
        assert_eq!(writes.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_late_old_response_cannot_complete_a_reused_request_id() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let (old_token, _old_receiver) = state
            .register_pending("same-request", generation, false)
            .unwrap();
        state.remove_pending(&old_token).unwrap();
        let (new_token, mut new_receiver) = state
            .register_pending("same-request", generation, false)
            .unwrap();

        let old_response = AgentFrontendResponse {
            request_id: "same-request".to_string(),
            dispatch_token: old_token,
            operation_generation: generation,
            result: Some(AgentResult::Mutation(summary("old-revision"))),
            error: None,
        };
        assert!(state.complete_frontend(old_response).is_err());
        assert!(matches!(
            new_receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        let new_response = AgentFrontendResponse {
            request_id: "same-request".to_string(),
            dispatch_token: new_token,
            operation_generation: generation,
            result: Some(AgentResult::Mutation(summary("new-revision"))),
            error: None,
        };
        state.complete_frontend(new_response).unwrap();
        let result = new_receiver.await.unwrap().into_result().unwrap();
        let AgentResult::Mutation(result) = result else {
            panic!("expected mutation result");
        };
        assert_eq!(result.live_revision, "new-revision");
    }

    #[tokio::test]
    async fn start_status_emit_failure_rolls_back_runtime_and_pending() {
        let state = AgentBridgeState::default();
        let generation = state.inner.write_operations.current_generation();
        let (_token, pending) = state
            .register_pending("during-start", generation, false)
            .unwrap();
        *state.inner.runtime.lock().unwrap() = Some(BridgeRuntime {
            session_id: "failed-start".to_string(),
            server: None,
            counts_task: None,
        });
        {
            let mut status = state.inner.status.write().unwrap();
            status.enabled = true;
            status.listening = true;
        }
        let emit_error = AgentError::new(BRIDGE_UNAVAILABLE, "status emit failed");

        let result = state
            .publish_started_status("failed-start", |_| Err(emit_error.clone()))
            .await;

        assert_eq!(result.unwrap_err().message, "status emit failed");
        assert!(state.inner.runtime.lock().unwrap().is_none());
        let status = state.status().unwrap();
        assert!(!status.enabled);
        assert!(!status.listening);
        assert_eq!(status.last_error.as_deref(), Some("status emit failed"));
        let response = pending.await.unwrap();
        assert_eq!(response.error.unwrap().code, AGENT_ACCESS_DISABLED);
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

        let generation = state.inner.write_operations.current_generation();
        let first_operations = state.inner.write_operations.clone();
        let second_operations = state.inner.write_operations.clone();
        let (first, second) = tokio::join!(
            first_operations.run(generation, || replace(first_revision, first.clone())),
            second_operations.run(generation, || replace(second_revision, second.clone())),
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
