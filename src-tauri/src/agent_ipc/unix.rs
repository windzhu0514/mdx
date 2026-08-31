use super::{io_error, ipc_error, AgentEndpointDescriptor, AgentTransport, EndpointRegistry};
use crate::agent_protocol::{AgentError, BRIDGE_UNAVAILABLE, PERMISSION_DENIED};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tokio::net::{UnixListener, UnixStream};

pub const TRANSPORT: AgentTransport = AgentTransport::UnixSocket;
pub type PlatformListener = UnixListener;
pub type PlatformStream = UnixStream;

pub fn open_lifecycle_lock(registry: &EndpointRegistry) -> Result<File, AgentError> {
    let parent = registry.path().parent().ok_or_else(|| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "The Agent endpoint path has no parent directory.",
        )
    })?;
    prepare_registry_directory(parent)?;
    let path = registry.path().with_extension("lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|error| {
            let code = if error.raw_os_error() == Some(libc::ELOOP) {
                PERMISSION_DENIED
            } else {
                BRIDGE_UNAVAILABLE
            };
            io_error(code, "Could not open the Agent lifecycle lock.", error)
        })?;
    validate_registry_metadata(&file.metadata().map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent lifecycle lock.",
            error,
        )
    })?)?;
    Ok(file)
}

pub fn open_registry_file(path: &Path, missing_code: &str) -> Result<File, AgentError> {
    let parent = path.parent().ok_or_else(|| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "The Agent endpoint path has no parent directory.",
        )
    })?;
    validate_secure_directory(parent, missing_code)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                missing_code
            } else if error.raw_os_error() == Some(libc::ELOOP) {
                PERMISSION_DENIED
            } else {
                BRIDGE_UNAVAILABLE
            };
            io_error(code, "Could not open the Agent endpoint registry.", error)
        })?;
    validate_registry_metadata(&file.metadata().map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent endpoint registry.",
            error,
        )
    })?)?;
    Ok(file)
}

fn validate_secure_directory(path: &Path, missing_code: &str) -> Result<(), AgentError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            missing_code
        } else {
            BRIDGE_UNAVAILABLE
        };
        io_error(
            code,
            "Could not inspect the Agent registry directory.",
            error,
        )
    })?;
    if !directory_metadata_is_owner_only(
        metadata.is_dir(),
        metadata.uid(),
        metadata.permissions().mode(),
        effective_uid(),
    ) {
        return Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent registry directory is not owner-only.",
        ));
    }
    Ok(())
}

fn validate_registry_metadata(metadata: &std::fs::Metadata) -> Result<(), AgentError> {
    if !file_metadata_is_owner_only(
        metadata.is_file(),
        metadata.uid(),
        metadata.permissions().mode(),
        effective_uid(),
    ) {
        return Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent endpoint registry is not owner-only.",
        ));
    }
    Ok(())
}

fn directory_metadata_is_owner_only(is_directory: bool, uid: u32, mode: u32, euid: u32) -> bool {
    is_directory && uid == euid && mode & 0o777 == 0o700
}

fn file_metadata_is_owner_only(is_file: bool, uid: u32, mode: u32, euid: u32) -> bool {
    is_file && uid == euid && mode & 0o777 == 0o600
}

pub(super) fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

#[derive(Clone, Copy)]
enum SystemBaseKind {
    Runtime,
    Temp,
}

pub fn current_user_registry_base() -> Result<PathBuf, AgentError> {
    let (raw_base, kind, runtime) = match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(path) => (PathBuf::from(path), SystemBaseKind::Runtime, true),
        None => (std::env::temp_dir(), SystemBaseKind::Temp, false),
    };
    let euid = effective_uid();
    let resolved = resolve_trusted_system_base(&raw_base, euid, kind)?;
    if runtime {
        Ok(super::mora_registry_directory(&resolved, euid, true))
    } else {
        Ok(fallback_registry_base(&resolved, euid))
    }
}

fn fallback_registry_base(temp_dir: &Path, euid: u32) -> PathBuf {
    super::mora_registry_directory(temp_dir, euid, false)
}

fn resolve_trusted_system_base(
    raw_base: &Path,
    euid: u32,
    kind: SystemBaseKind,
) -> Result<PathBuf, AgentError> {
    let resolved = std::fs::canonicalize(raw_base).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not resolve the Agent system runtime directory.",
            error,
        )
    })?;
    let metadata = std::fs::symlink_metadata(&resolved).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent system runtime directory.",
            error,
        )
    })?;
    if !system_base_metadata_is_trusted(
        metadata.is_dir(),
        metadata.uid(),
        metadata.permissions().mode(),
        euid,
        kind,
    ) {
        return Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent system runtime directory is not trusted.",
        ));
    }
    Ok(resolved)
}

fn system_base_metadata_is_trusted(
    is_directory: bool,
    uid: u32,
    mode: u32,
    euid: u32,
    kind: SystemBaseKind,
) -> bool {
    if !is_directory {
        return false;
    }
    match kind {
        SystemBaseKind::Runtime => uid == euid && mode & 0o777 == 0o700,
        SystemBaseKind::Temp => {
            (uid == euid && mode & 0o022 == 0)
                || (uid == 0 && mode & 0o1000 != 0 && mode & 0o002 != 0)
        }
    }
}

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
    match std::fs::symlink_metadata(path) {
        Ok(_) => return validate_secure_directory(path, BRIDGE_UNAVAILABLE),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(io_error(
                BRIDGE_UNAVAILABLE,
                "Could not inspect the Agent registry directory.",
                error,
            ));
        }
    }
    let parent = path.parent().ok_or_else(|| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "The Agent registry directory has no trusted system base.",
        )
    })?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not inspect the Agent registry system base.",
            error,
        )
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(ipc_error(
            PERMISSION_DENIED,
            "The Agent registry system base is not a local directory.",
        ));
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(path).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not create the Agent registry directory.",
            error,
        )
    })?;
    validate_secure_directory(path, BRIDGE_UNAVAILABLE)
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

#[cfg(test)]
mod tests {
    use super::{
        directory_metadata_is_owner_only, fallback_registry_base, file_metadata_is_owner_only,
        prepare_registry_directory, resolve_trusted_system_base, system_base_metadata_is_trusted,
        validate_secure_directory, SystemBaseKind,
    };
    use crate::agent_protocol::{BRIDGE_UNAVAILABLE, PERMISSION_DENIED};
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn owner_only_metadata_validators_reject_wrong_owner_and_mode() {
        assert!(file_metadata_is_owner_only(true, 42, 0o100600, 42));
        assert!(!file_metadata_is_owner_only(true, 7, 0o100600, 42));
        assert!(!file_metadata_is_owner_only(true, 42, 0o100644, 42));
        assert!(directory_metadata_is_owner_only(true, 42, 0o40700, 42));
        assert!(!directory_metadata_is_owner_only(true, 7, 0o40700, 42));
        assert!(!directory_metadata_is_owner_only(true, 42, 0o40755, 42));
    }

    #[test]
    fn fallback_registry_path_uses_effective_uid() {
        assert_eq!(
            fallback_registry_base(std::path::Path::new("/tmp"), 4242),
            std::path::Path::new("/tmp/mora-agent-4242")
        );
    }

    #[test]
    fn registry_directory_rejects_weak_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = validate_secure_directory(&path, BRIDGE_UNAVAILABLE).unwrap_err();
        assert_eq!(error.code, PERMISSION_DENIED);
    }

    #[test]
    fn registry_directory_rejects_symlink_components() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let linked = temp.path().join("linked");
        symlink(&real, &linked).unwrap();

        let error = prepare_registry_directory(&linked.join("agent")).unwrap_err();
        assert_eq!(error.code, PERMISSION_DENIED);
    }

    #[test]
    fn macos_style_system_symlink_is_resolved_before_the_mora_subdirectory() {
        let temp = tempfile::tempdir().unwrap();
        let private_var = temp.path().join("private").join("var");
        let runtime = private_var.join("folders").join("user").join("T");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&private_var, temp.path().join("var")).unwrap();
        let raw_runtime = temp
            .path()
            .join("var")
            .join("folders")
            .join("user")
            .join("T");

        let resolved = resolve_trusted_system_base(
            &raw_runtime,
            super::effective_uid(),
            SystemBaseKind::Runtime,
        )
        .unwrap();

        assert_eq!(resolved, std::fs::canonicalize(runtime).unwrap());
    }

    #[test]
    fn system_base_metadata_requires_runtime_ownership_or_a_sticky_system_temp() {
        assert!(system_base_metadata_is_trusted(
            true,
            501,
            0o40700,
            501,
            SystemBaseKind::Runtime,
        ));
        assert!(!system_base_metadata_is_trusted(
            true,
            0,
            0o40755,
            501,
            SystemBaseKind::Runtime,
        ));
        assert!(system_base_metadata_is_trusted(
            true,
            0,
            0o41777,
            501,
            SystemBaseKind::Temp,
        ));
        assert!(!system_base_metadata_is_trusted(
            true,
            0,
            0o40777,
            501,
            SystemBaseKind::Temp,
        ));
    }
}
