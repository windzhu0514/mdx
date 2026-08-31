use super::{io_error, ipc_error, AgentEndpointDescriptor, AgentTransport, EndpointRegistry};
use crate::agent_protocol::{AgentError, BRIDGE_UNAVAILABLE, PERMISSION_DENIED};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::Path;
use tokio::net::{UnixListener, UnixStream};

pub const TRANSPORT: AgentTransport = AgentTransport::UnixSocket;
pub type PlatformListener = UnixListener;
pub type PlatformStream = UnixStream;

pub async fn bind(descriptor: &AgentEndpointDescriptor) -> Result<UnixListener, AgentError> {
    let path = descriptor.socket_path();
    let parent = path.parent().ok_or_else(|| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "The Agent socket path has no parent directory.",
        )
    })?;
    prepare_registry_directory(parent)?;
    let listener = UnixListener::bind(path).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not bind the Mora Agent socket.",
            error,
        )
    })?;
    apply_owner_only_permissions(path)?;
    Ok(listener)
}

pub async fn accept(listener: &mut UnixListener) -> std::io::Result<UnixStream> {
    listener.accept().await.map(|(stream, _)| stream)
}

pub async fn connect(descriptor: &AgentEndpointDescriptor) -> Result<UnixStream, AgentError> {
    UnixStream::connect(descriptor.socket_path())
        .await
        .map_err(|error| {
            io_error(
                BRIDGE_UNAVAILABLE,
                "Could not connect to the Mora Agent socket.",
                error,
            )
        })
}

pub fn address_for(registry: &EndpointRegistry, session_id: &str) -> Result<String, AgentError> {
    let parent = registry.path().parent().ok_or_else(|| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "The Agent endpoint path has no parent directory.",
        )
    })?;
    Ok(parent
        .join(format!("mora-agent-{session_id}.sock"))
        .to_string_lossy()
        .into_owned())
}

pub fn prepare_registry_directory(path: &Path) -> Result<(), AgentError> {
    std::fs::create_dir_all(path).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not create the Agent registry directory.",
            error,
        )
    })?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not protect the Agent registry directory.",
            error,
        )
    })
}

pub fn apply_owner_only_permissions(path: &Path) -> Result<(), AgentError> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not protect the Agent endpoint.",
            error,
        )
    })
}

pub fn atomic_replace(source: &Path, destination: &Path) -> Result<(), AgentError> {
    std::fs::rename(source, destination).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not publish the Agent endpoint registry.",
            error,
        )
    })
}

pub fn remove_stale_endpoint(descriptor: &AgentEndpointDescriptor) -> Result<(), AgentError> {
    if descriptor.transport != AgentTransport::UnixSocket {
        return Ok(());
    }
    let path = descriptor.socket_path();
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent socket must not be a symbolic link.",
        )),
        Ok(metadata) if metadata.file_type().is_socket() => {
            std::fs::remove_file(path).map_err(|error| {
                io_error(
                    BRIDGE_UNAVAILABLE,
                    "Could not remove the Agent socket.",
                    error,
                )
            })
        }
        Ok(_) => Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent socket path is occupied by a non-socket file.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent socket.",
            error,
        )),
    }
}

pub async fn endpoint_is_live(descriptor: &AgentEndpointDescriptor) -> bool {
    connect(descriptor).await.is_ok()
}
