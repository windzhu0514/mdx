use crate::agent_protocol::{
    AgentDocumentEvent, AgentError, AgentRequest, AgentResponse, AgentResult, AgentServerMessage,
    BRIDGE_ALREADY_RUNNING, BRIDGE_UNAVAILABLE, MAX_CONNECTIONS, MAX_FRAME_BYTES,
    PERMISSION_DENIED, PROTOCOL_MISMATCH, PROTOCOL_VERSION, REQUEST_TIMEOUT, TIMEOUT,
};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, watch, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
use self::unix as platform;
#[cfg(windows)]
use self::windows as platform;

type HandlerFuture =
    Pin<Box<dyn Future<Output = Result<AgentResult, AgentError>> + Send + 'static>>;
type Handler = Arc<dyn Fn(AgentRequest) -> HandlerFuture + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTransport {
    NamedPipe,
    UnixSocket,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEndpointDescriptor {
    pub protocol_version: u16,
    pub session_id: String,
    pub pid: u32,
    pub transport: AgentTransport,
    pub address: String,
    #[serde(skip)]
    registry_path: PathBuf,
}

impl AgentEndpointDescriptor {
    pub fn registry_path(&self) -> &Path {
        &self.registry_path
    }

    pub fn socket_path(&self) -> &Path {
        Path::new(&self.address)
    }
}

#[derive(Debug, Clone)]
pub struct EndpointRegistry {
    path: PathBuf,
}

impl EndpointRegistry {
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn for_current_user() -> Result<Self, AgentError> {
        #[cfg(windows)]
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| ipc_error(BRIDGE_UNAVAILABLE, "Local application data is unavailable."))?
            .join("Mora")
            .join("agent");

        #[cfg(unix)]
        let base = if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            PathBuf::from(runtime_dir).join("mora")
        } else {
            let user = std::env::var("USER").unwrap_or_else(|_| "current-user".into());
            std::env::temp_dir().join(format!("mora-agent-{user}"))
        };

        Ok(Self::at(base.join("agent-endpoint-v1.json")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Result<AgentEndpointDescriptor, AgentError> {
        reject_registry_symlink(&self.path)?;
        let bytes = std::fs::read(&self.path).map_err(|error| {
            io_error(
                BRIDGE_UNAVAILABLE,
                "Could not read the Agent endpoint.",
                error,
            )
        })?;
        let mut descriptor: AgentEndpointDescriptor =
            serde_json::from_slice(&bytes).map_err(|_| {
                ipc_error(
                    BRIDGE_UNAVAILABLE,
                    "The Agent endpoint registry is invalid.",
                )
            })?;
        descriptor.registry_path = self.path.clone();
        Ok(descriptor)
    }

    pub fn publish(&self, descriptor: &AgentEndpointDescriptor) -> Result<(), AgentError> {
        let parent = self.path.parent().ok_or_else(|| {
            ipc_error(
                BRIDGE_UNAVAILABLE,
                "The Agent endpoint path has no parent directory.",
            )
        })?;
        platform::prepare_registry_directory(parent)?;

        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ipc_error(BRIDGE_UNAVAILABLE, "The Agent endpoint path is invalid."))?;
        let temporary = parent.join(format!(".{file_name}.{}.tmp", descriptor.session_id));
        let bytes = serde_json::to_vec(descriptor)
            .map_err(|_| ipc_error(BRIDGE_UNAVAILABLE, "Could not encode the Agent endpoint."))?;

        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| {
                    io_error(
                        BRIDGE_UNAVAILABLE,
                        "Could not create the Agent endpoint registry.",
                        error,
                    )
                })?;
            file.write_all(&bytes).map_err(|error| {
                io_error(
                    BRIDGE_UNAVAILABLE,
                    "Could not write the Agent endpoint registry.",
                    error,
                )
            })?;
            file.sync_all().map_err(|error| {
                io_error(
                    BRIDGE_UNAVAILABLE,
                    "Could not flush the Agent endpoint registry.",
                    error,
                )
            })?;
            platform::apply_owner_only_permissions(&temporary)?;
            platform::atomic_replace(&temporary, &self.path)
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub fn remove_if_owned(&self, session_id: &str) -> Result<(), AgentError> {
        let descriptor = match self.read() {
            Ok(descriptor) => descriptor,
            Err(_error) if !self.path.exists() => return Ok(()),
            Err(error) => return Err(error),
        };
        if descriptor.session_id != session_id {
            return Ok(());
        }
        std::fs::remove_file(&self.path).map_err(|error| {
            io_error(
                BRIDGE_UNAVAILABLE,
                "Could not remove the Agent endpoint registry.",
                error,
            )
        })
    }

    fn remove_stale(&self) -> Result<(), AgentError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(
                BRIDGE_UNAVAILABLE,
                "Could not remove a stale Agent endpoint registry.",
                error,
            )),
        }
    }
}

pub trait IntoAgentHandlerResult {
    fn into_agent_handler_result(self) -> Result<AgentResult, AgentError>;
}

impl IntoAgentHandlerResult for AgentResult {
    fn into_agent_handler_result(self) -> Result<AgentResult, AgentError> {
        Ok(self)
    }
}

impl IntoAgentHandlerResult for Result<AgentResult, AgentError> {
    fn into_agent_handler_result(self) -> Result<AgentResult, AgentError> {
        self
    }
}

pub struct AgentServer {
    descriptor: AgentEndpointDescriptor,
    registry: EndpointRegistry,
    cancel: watch::Sender<bool>,
    events: broadcast::Sender<AgentDocumentEvent>,
    accept_task: Option<JoinHandle<()>>,
    stopped: bool,
}

impl std::fmt::Debug for AgentServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentServer")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl AgentServer {
    pub async fn start<H, F, O>(registry: EndpointRegistry, handler: H) -> Result<Self, AgentError>
    where
        H: Fn(AgentRequest) -> F + Send + Sync + 'static,
        F: Future<Output = O> + Send + 'static,
        O: IntoAgentHandlerResult + 'static,
    {
        if registry.path.exists() {
            match registry.read() {
                Ok(existing) if endpoint_is_live(&existing).await => {
                    return Err(ipc_error(
                        BRIDGE_ALREADY_RUNNING,
                        "A Mora Agent bridge is already running.",
                    ));
                }
                Ok(existing) => platform::remove_stale_endpoint(&existing)?,
                Err(_) => {}
            }
            registry.remove_stale()?;
        }

        let session_id = Uuid::new_v4().to_string();
        let mut descriptor = AgentEndpointDescriptor {
            protocol_version: PROTOCOL_VERSION,
            session_id: session_id.clone(),
            pid: std::process::id(),
            transport: platform::TRANSPORT,
            address: platform::address_for(&registry, &session_id)?,
            registry_path: registry.path.clone(),
        };
        descriptor.registry_path = registry.path.clone();

        let listener = platform::bind(&descriptor).await?;
        if let Err(error) = registry.publish(&descriptor) {
            drop(listener);
            let _ = platform::remove_stale_endpoint(&descriptor);
            return Err(error);
        }

        let handler: Handler = Arc::new(move |request| {
            let future = handler(request);
            Box::pin(async move { future.await.into_agent_handler_result() })
        });
        let (cancel, cancel_receiver) = watch::channel(false);
        let (events, _) = broadcast::channel(128);
        let accept_task = tokio::spawn(accept_connections(
            listener,
            handler,
            events.clone(),
            cancel_receiver,
        ));

        Ok(Self {
            descriptor,
            registry,
            cancel,
            events,
            accept_task: Some(accept_task),
            stopped: false,
        })
    }

    pub fn descriptor(&self) -> &AgentEndpointDescriptor {
        &self.descriptor
    }

    pub fn publish_event(&self, event: AgentDocumentEvent) {
        let _ = self.events.send(event);
    }

    pub async fn stop(mut self) -> Result<(), AgentError> {
        self.shutdown().await;
        self.cleanup()?;
        self.stopped = true;
        Ok(())
    }

    async fn shutdown(&mut self) {
        let _ = self.cancel.send(true);
        if let Some(task) = self.accept_task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    fn cleanup(&self) -> Result<(), AgentError> {
        platform::remove_stale_endpoint(&self.descriptor)?;
        self.registry.remove_if_owned(&self.descriptor.session_id)
    }
}

impl Drop for AgentServer {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        let _ = self.cancel.send(true);
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
        let _ = platform::remove_stale_endpoint(&self.descriptor);
        let _ = self.registry.remove_if_owned(&self.descriptor.session_id);
    }
}

pub(crate) async fn endpoint_is_live(descriptor: &AgentEndpointDescriptor) -> bool {
    if descriptor.protocol_version != PROTOCOL_VERSION
        || descriptor.transport != platform::TRANSPORT
    {
        return false;
    }
    platform::endpoint_is_live(descriptor).await
}

async fn accept_connections(
    mut listener: platform::PlatformListener,
    handler: Handler,
    events: broadcast::Sender<AgentDocumentEvent>,
    mut cancel: watch::Receiver<bool>,
) {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        if *cancel.borrow() {
            return;
        }
        let permit = tokio::select! {
            _ = cancel.changed() => return,
            permit = connections.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };
        let stream = tokio::select! {
            _ = cancel.changed() => return,
            stream = platform::accept(&mut listener) => match stream {
                Ok(stream) => stream,
                Err(_) => return,
            },
        };
        let handler = handler.clone();
        let events = events.clone();
        let connection_cancel = cancel.clone();
        tokio::spawn(async move {
            let _permit = permit;
            serve_connection(stream, handler, events, connection_cancel).await;
        });
    }
}

async fn serve_connection(
    mut stream: platform::PlatformStream,
    handler: Handler,
    events: broadcast::Sender<AgentDocumentEvent>,
    mut cancel: watch::Receiver<bool>,
) {
    let request = match tokio::time::timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(_)) => return,
        Err(_) => return,
    };
    let request_id = request.request_id.clone();
    if request.protocol_version != PROTOCOL_VERSION {
        let response = AgentResponse::failure(
            request_id,
            ipc_error(
                PROTOCOL_MISMATCH,
                "The Agent protocol version is not supported.",
            ),
        );
        let _ = write_message(&mut stream, &AgentServerMessage::Response { response }).await;
        return;
    }

    let watch_filter = match &request.request {
        crate::agent_protocol::AgentRequestKind::Watch { document_id } => Some(document_id.clone()),
        _ => None,
    };
    let mut event_receiver = watch_filter.as_ref().map(|_| events.subscribe());
    let response = match tokio::time::timeout(REQUEST_TIMEOUT, handler(request)).await {
        Ok(Ok(result)) => AgentResponse::success(request_id, result),
        Ok(Err(error)) => AgentResponse::failure(request_id, error),
        Err(_) => AgentResponse::failure(
            request_id,
            ipc_error(TIMEOUT, "The Agent request timed out."),
        ),
    };
    let handler_failed = response.error.is_some();
    if write_message(&mut stream, &AgentServerMessage::Response { response })
        .await
        .is_err()
        || handler_failed
    {
        return;
    }

    let (Some(filter), Some(receiver)) = (watch_filter, event_receiver.as_mut()) else {
        return;
    };
    loop {
        let event = tokio::select! {
            _ = cancel.changed() => return,
            event = receiver.recv() => match event {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
        };
        if filter
            .as_ref()
            .is_some_and(|document_id| document_id != &event.document_id)
        {
            continue;
        }
        if write_message(&mut stream, &AgentServerMessage::Event { event })
            .await
            .is_err()
        {
            return;
        }
    }
}

pub(crate) async fn connect(
    descriptor: &AgentEndpointDescriptor,
) -> Result<platform::PlatformStream, AgentError> {
    if descriptor.protocol_version != PROTOCOL_VERSION
        || descriptor.transport != platform::TRANSPORT
    {
        return Err(ipc_error(
            PROTOCOL_MISMATCH,
            "The Agent endpoint uses an unsupported protocol or transport.",
        ));
    }
    tokio::time::timeout(REQUEST_TIMEOUT, platform::connect(descriptor))
        .await
        .map_err(|_| ipc_error(TIMEOUT, "Connecting to the Mora Agent bridge timed out."))?
}

pub(crate) async fn write_request<S>(
    stream: &mut S,
    request: &AgentRequest,
) -> Result<(), AgentError>
where
    S: AsyncWrite + Unpin,
{
    write_json_frame(stream, request).await
}

pub(crate) async fn read_server_message<S>(stream: &mut S) -> Result<AgentServerMessage, AgentError>
where
    S: AsyncRead + Unpin,
{
    read_json_frame(stream).await
}

async fn read_request<S>(stream: &mut S) -> Result<AgentRequest, AgentError>
where
    S: AsyncRead + Unpin,
{
    read_json_frame(stream).await
}

async fn write_message<S>(stream: &mut S, message: &AgentServerMessage) -> Result<(), AgentError>
where
    S: AsyncWrite + Unpin,
{
    write_json_frame(stream, message).await
}

async fn read_json_frame<T, S>(stream: &mut S) -> Result<T, AgentError>
where
    T: for<'de> Deserialize<'de>,
    S: AsyncRead + Unpin,
{
    let mut prefix = [0_u8; 4];
    stream.read_exact(&mut prefix).await.map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not read from the Agent transport.",
            error,
        )
    })?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(crate::agent_protocol::AgentError::new(
            crate::agent_protocol::REQUEST_TOO_LARGE,
            "Agent request exceeds the frame size limit.",
        ));
    }
    let mut frame = Vec::with_capacity(4 + length);
    frame.extend_from_slice(&prefix);
    frame.resize(4 + length, 0);
    stream.read_exact(&mut frame[4..]).await.map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not read from the Agent transport.",
            error,
        )
    })?;
    let payload = crate::agent_protocol::decode_frame(&frame)?;
    serde_json::from_slice(&payload)
        .map_err(|_| ipc_error(PROTOCOL_MISMATCH, "The Agent frame contains invalid JSON."))
}

async fn write_json_frame<T, S>(stream: &mut S, value: &T) -> Result<(), AgentError>
where
    T: Serialize,
    S: AsyncWrite + Unpin,
{
    let payload = serde_json::to_vec(value)
        .map_err(|_| ipc_error(PROTOCOL_MISMATCH, "Could not encode the Agent frame."))?;
    let frame = crate::agent_protocol::encode_frame(&payload)?;
    stream.write_all(&frame).await.map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not write to the Agent transport.",
            error,
        )
    })?;
    stream.flush().await.map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not flush the Agent transport.",
            error,
        )
    })
}

pub(crate) fn ipc_error(code: &str, message: &str) -> AgentError {
    AgentError::new(code, message)
}

pub(crate) fn io_error(code: &str, message: &str, _error: std::io::Error) -> AgentError {
    AgentError::new(code, message)
}

fn reject_registry_symlink(path: &Path) -> Result<(), AgentError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent endpoint registry must not be a symbolic link.",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent endpoint registry.",
            error,
        )),
    }
}
