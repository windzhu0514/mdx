use super::{io_error, ipc_error, AgentEndpointDescriptor, AgentTransport, EndpointRegistry};
use crate::agent_protocol::{AgentError, BRIDGE_UNAVAILABLE, REQUEST_TIMEOUT};
use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows::core::{HSTRING, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const TRANSPORT: AgentTransport = AgentTransport::NamedPipe;
pub enum PlatformStream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

impl AsyncRead for PlatformStream {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_read(context, buffer),
            Self::Client(stream) => Pin::new(stream).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for PlatformStream {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_write(context, buffer),
            Self::Client(stream) => Pin::new(stream).poll_write(context, buffer),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_flush(context),
            Self::Client(stream) => Pin::new(stream).poll_flush(context),
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::Server(stream) => Pin::new(stream).poll_shutdown(context),
            Self::Client(stream) => Pin::new(stream).poll_shutdown(context),
        }
    }
}

pub struct PlatformListener {
    address: String,
    security: OwnedSecurityAttributes,
    pending: NamedPipeServer,
}

pub struct OwnedSecurityAttributes {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

unsafe impl Send for OwnedSecurityAttributes {}

impl OwnedSecurityAttributes {
    fn new(sddl: &str) -> Result<Self, AgentError> {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|_| {
            ipc_error(
                BRIDGE_UNAVAILABLE,
                "Could not create owner-only Agent transport security.",
            )
        })?;
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            },
        })
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        (&mut self.attributes as *mut SECURITY_ATTRIBUTES).cast()
    }
}

impl Drop for OwnedSecurityAttributes {
    fn drop(&mut self) {
        if !self.descriptor.is_invalid() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }
}

pub fn owner_only_pipe_security() -> Result<OwnedSecurityAttributes, AgentError> {
    let sid = current_user_sid()?;
    OwnedSecurityAttributes::new(&owner_only_sddl(&sid))
}

pub async fn bind(descriptor: &AgentEndpointDescriptor) -> Result<PlatformListener, AgentError> {
    let mut security = owner_only_pipe_security()?;
    let pending = create_pipe(&descriptor.address, &mut security, true)?;
    Ok(PlatformListener {
        address: descriptor.address.clone(),
        security,
        pending,
    })
}

pub async fn accept(listener: &mut PlatformListener) -> std::io::Result<PlatformStream> {
    listener.pending.connect().await?;
    let next = create_pipe(&listener.address, &mut listener.security, false)
        .map_err(|error| std::io::Error::other(error.message))?;
    Ok(PlatformStream::Server(std::mem::replace(
        &mut listener.pending,
        next,
    )))
}

pub async fn connect(descriptor: &AgentEndpointDescriptor) -> Result<PlatformStream, AgentError> {
    let started = Instant::now();
    loop {
        match ClientOptions::new().open(&descriptor.address) {
            Ok(client) => return Ok(PlatformStream::Client(client)),
            Err(error)
                if matches!(error.raw_os_error(), Some(2 | 231))
                    && started.elapsed() < REQUEST_TIMEOUT =>
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err(error) => {
                return Err(io_error(
                    BRIDGE_UNAVAILABLE,
                    "Could not connect to the Mora Agent named pipe.",
                    error,
                ));
            }
        }
    }
}

pub fn address_for(_registry: &EndpointRegistry, session_id: &str) -> Result<String, AgentError> {
    Ok(format!(r"\\.\pipe\mora-agent-{session_id}"))
}

pub fn prepare_registry_directory(path: &Path) -> Result<(), AgentError> {
    std::fs::create_dir_all(path).map_err(|error| {
        io_error(
            BRIDGE_UNAVAILABLE,
            "Could not create the Agent registry directory.",
            error,
        )
    })
}

pub fn apply_owner_only_permissions(path: &Path) -> Result<(), AgentError> {
    let security = owner_only_pipe_security()?;
    let information = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    unsafe {
        SetFileSecurityW(
            &HSTRING::from(path.as_os_str()),
            information,
            security.descriptor,
        )
    }
    .ok()
    .map_err(|error| {
        AgentError::new(
            BRIDGE_UNAVAILABLE,
            format!("Could not protect the Agent endpoint registry: {error}"),
        )
    })
}

pub fn atomic_replace(source: &Path, destination: &Path) -> Result<(), AgentError> {
    unsafe {
        MoveFileExW(
            &HSTRING::from(source.as_os_str()),
            &HSTRING::from(destination.as_os_str()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not publish the Agent endpoint registry.",
        )
    })
}

pub fn remove_stale_endpoint(_descriptor: &AgentEndpointDescriptor) -> Result<(), AgentError> {
    Ok(())
}

pub async fn endpoint_is_live(descriptor: &AgentEndpointDescriptor) -> bool {
    if !process_is_alive(descriptor.pid) {
        return false;
    }
    tokio::time::timeout(std::time::Duration::from_millis(250), connect(descriptor))
        .await
        .is_ok_and(|result| result.is_ok())
}

fn create_pipe(
    address: &str,
    security: &mut OwnedSecurityAttributes,
    first_instance: bool,
) -> Result<NamedPipeServer, AgentError> {
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first_instance)
        .reject_remote_clients(true);
    unsafe { options.create_with_security_attributes_raw(address, security.as_mut_ptr()) }.map_err(
        |error| {
            io_error(
                BRIDGE_UNAVAILABLE,
                "Could not bind the Mora Agent named pipe.",
                error,
            )
        },
    )
}

fn current_user_sid() -> Result<String, AgentError> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(|_| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not read the current process identity.",
        )
    })?;
    let _token = OwnedHandle(token);

    let mut required = 0_u32;
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut required) };
    if required == 0 {
        return Err(ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not size the current process identity.",
        ));
    }
    let mut buffer = vec![0_u8; required as usize];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required,
            &mut required,
        )
    }
    .map_err(|_| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not read the current process identity.",
        )
    })?;
    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut string_sid = PWSTR::null();
    unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid) }.map_err(|_| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not encode the current process identity.",
        )
    })?;
    let sid = unsafe { string_sid.to_string() }.map_err(|_| {
        ipc_error(
            BRIDGE_UNAVAILABLE,
            "Could not encode the current process identity.",
        )
    })?;
    unsafe {
        let _ = LocalFree(Some(HLOCAL(string_sid.0.cast())));
    }
    Ok(sid)
}

fn owner_only_sddl(current_sid: &str) -> String {
    format!("D:P(A;;GA;;;SY)(A;;GA;;;{current_sid})")
}

fn process_is_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map(|handle| {
            let _ = unsafe { CloseHandle(handle) };
            true
        })
        .unwrap_or(false)
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::owner_only_sddl;

    #[test]
    fn owner_only_sddl_allows_only_system_and_current_user() {
        assert_eq!(
            owner_only_sddl("S-1-5-21-1000"),
            "D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-1000)"
        );
    }
}
