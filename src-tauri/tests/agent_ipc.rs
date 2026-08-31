use futures_util::StreamExt;
use mdxnote_lib::agent_client::AgentClient;
#[cfg(windows)]
use mdxnote_lib::agent_ipc::AgentTransport;
use mdxnote_lib::agent_ipc::{AgentServer, EndpointRegistry};
use mdxnote_lib::agent_protocol::{
    AgentBridgeStatus, AgentChangeSource, AgentDocumentEvent, AgentDocumentSnapshot,
    AgentDocumentSummary, AgentRequest, AgentRequestKind, AgentResult, BRIDGE_ALREADY_RUNNING,
    MORA_NOT_RUNNING, PROTOCOL_VERSION,
};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tempfile::TempDir;
use tokio::sync::Semaphore;

struct IpcFixture {
    _temp: TempDir,
    registry: EndpointRegistry,
}

impl IpcFixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let registry = EndpointRegistry::at(temp.path().join("agent-endpoint-v1.json"));
        Self {
            _temp: temp,
            registry,
        }
    }

    async fn start<H, F>(&self, handler: H) -> AgentServer
    where
        H: Fn(AgentRequest) -> F + Send + Sync + 'static,
        F: Future<Output = AgentResult> + Send + 'static,
    {
        AgentServer::start(self.registry.clone(), handler)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn client_round_trips_over_current_platform_transport() {
    let fixture = IpcFixture::new().await;
    let server = fixture
        .start(|request| async move {
            assert_eq!(request.protocol_version, PROTOCOL_VERSION);
            AgentResult::Status(listening_status())
        })
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();

    let result = client.request(AgentRequestKind::Status).await.unwrap();

    assert!(matches!(result, AgentResult::Status(_)));
}

#[tokio::test]
async fn endpoint_is_published_after_binding_and_removed_on_stop() {
    let fixture = IpcFixture::new().await;
    assert!(!fixture.registry.path().exists());
    let server = fixture.start(ok_handler()).await;

    let published = fixture.registry.read().unwrap();
    assert_eq!(published.session_id, server.descriptor().session_id);

    server.stop().await.unwrap();
    assert!(!fixture.registry.path().exists());
}

#[tokio::test]
async fn stop_does_not_remove_an_endpoint_owned_by_another_session() {
    let fixture = IpcFixture::new().await;
    let server = fixture.start(ok_handler()).await;
    let mut replacement = server.descriptor().clone();
    replacement.session_id = "replacement-session".into();
    fixture.registry.publish(&replacement).unwrap();

    server.stop().await.unwrap();

    assert_eq!(
        fixture.registry.read().unwrap().session_id,
        "replacement-session"
    );
}

#[tokio::test]
async fn second_live_server_is_rejected() {
    let fixture = IpcFixture::new().await;
    let _server = fixture.start(ok_handler()).await;

    let error = AgentServer::start(fixture.registry.clone(), ok_handler())
        .await
        .unwrap_err();

    assert_eq!(error.code, BRIDGE_ALREADY_RUNNING);
}

#[tokio::test]
async fn missing_registry_maps_to_mora_not_running() {
    let fixture = IpcFixture::new().await;

    let error = AgentClient::connect_with_registry(fixture.registry.clone())
        .await
        .unwrap_err();

    assert_eq!(error.code, MORA_NOT_RUNNING);
}

#[tokio::test]
async fn stale_registry_maps_to_mora_not_running_without_waiting_for_request_timeout() {
    let fixture = IpcFixture::new().await;
    std::fs::write(
        fixture.registry.path(),
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": "stale-session",
            "pid": 0,
            "transport": if cfg!(windows) { "namedPipe" } else { "unixSocket" },
            "address": if cfg!(windows) {
                r"\\.\pipe\mora-agent-stale-session".to_string()
            } else {
                fixture
                    .registry
                    .path()
                    .parent()
                    .unwrap()
                    .join("mora-agent-stale-session.sock")
                    .to_string_lossy()
                    .into_owned()
            },
        })
        .to_string(),
    )
    .unwrap();

    let error = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        AgentClient::connect_with_registry(fixture.registry.clone()),
    )
    .await
    .expect("stale discovery must not consume the request timeout")
    .unwrap_err();

    assert_eq!(error.code, MORA_NOT_RUNNING);
}

#[tokio::test]
async fn stale_registry_is_replaced_before_binding() {
    let fixture = IpcFixture::new().await;
    std::fs::write(
        fixture.registry.path(),
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": "stale-session",
            "pid": std::process::id(),
            "transport": if cfg!(windows) { "namedPipe" } else { "unixSocket" },
            "address": if cfg!(windows) {
                r"\\.\pipe\mora-agent-stale-session"
            } else {
                "/tmp/mora-agent-stale-session.sock"
            },
        })
        .to_string(),
    )
    .unwrap();

    let server = fixture.start(ok_handler()).await;

    assert_ne!(server.descriptor().session_id, "stale-session");
    assert_eq!(
        fixture.registry.read().unwrap().session_id,
        server.descriptor().session_id
    );
}

#[tokio::test]
async fn server_runs_no_more_than_eight_handlers_concurrently() {
    let fixture = IpcFixture::new().await;
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Semaphore::new(0));
    let server = fixture
        .start({
            let active = active.clone();
            let maximum = maximum.clone();
            let release = release.clone();
            move |_| {
                let active = active.clone();
                let maximum = maximum.clone();
                let release = release.clone();
                async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    release.acquire().await.unwrap().forget();
                    active.fetch_sub(1, Ordering::SeqCst);
                    AgentResult::Status(listening_status())
                }
            }
        })
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let requests: Vec<_> = (0..9)
        .map(|_| {
            let client = client.clone();
            tokio::spawn(async move { client.request(AgentRequestKind::Status).await })
        })
        .collect();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while active.load(Ordering::SeqCst) < 8 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(maximum.load(Ordering::SeqCst), 8);

    release.add_permits(9);
    for request in requests {
        assert!(request.await.unwrap().is_ok());
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 8);
}

#[tokio::test]
async fn watch_returns_only_document_events_after_acknowledgement() {
    let fixture = IpcFixture::new().await;
    let server = fixture.start(ok_handler()).await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let mut events = client.watch(Some("doc-1".into())).await.unwrap();

    server.publish_event(AgentDocumentEvent {
        document_id: "doc-1".into(),
        live_revision: "session:2".into(),
        dirty: true,
        source: AgentChangeSource::Agent,
    });

    let event = events.next().await.unwrap().unwrap();
    assert_eq!(event.document_id, "doc-1");
    assert_eq!(event.live_revision, "session:2");
}

#[cfg(windows)]
#[tokio::test]
async fn windows_descriptor_uses_session_scoped_named_pipe() {
    let fixture = IpcFixture::new().await;
    let server = fixture.start(ok_handler()).await;
    let descriptor = server.descriptor();

    assert!(matches!(descriptor.transport, AgentTransport::NamedPipe));
    assert_eq!(
        descriptor.address,
        format!(r"\\.\pipe\mora-agent-{}", descriptor.session_id)
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_registry_allows_only_system_and_current_user() {
    let fixture = IpcFixture::new().await;
    let _server = fixture.start(ok_handler()).await;

    let sddl = windows_file_dacl_sddl(fixture.registry.path());
    let current_sid = windows_current_user_sid();

    assert!(
        sddl.starts_with("D:P"),
        "registry DACL is not protected: {sddl}"
    );
    assert_eq!(
        sddl.matches("(A;").count(),
        2,
        "registry DACL contains unexpected access entries: {sddl}"
    );
    assert!(sddl.contains(";;;SY)"), "SYSTEM is missing from: {sddl}");
    assert!(
        sddl.contains(&format!(";;;{current_sid})")),
        "current user is missing from: {sddl}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unix_endpoint_and_registry_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = IpcFixture::new().await;
    let server = fixture.start(ok_handler()).await;

    assert_eq!(mode(server.descriptor().registry_path()), 0o600);
    assert_eq!(mode(server.descriptor().socket_path()), 0o600);

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }
}

#[tokio::test]
#[ignore = "manual transport performance profile"]
async fn five_mib_round_trip_profile() {
    let fixture = IpcFixture::new().await;
    let server = fixture
        .start(|request| async move {
            let AgentRequestKind::ReplaceDocument { content, .. } = request.request else {
                return AgentResult::Status(listening_status());
            };
            AgentResult::Document(snapshot_with_content(content))
        })
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let content = "x".repeat(5 * 1024 * 1024);

    round_trip_large_document(&client, &content).await;
    let mut samples = Vec::with_capacity(20);
    for _ in 0..20 {
        let started = Instant::now();
        round_trip_large_document(&client, &content).await;
        samples.push(started.elapsed());
    }
    samples.sort_unstable();
    let p95_ms = samples[18].as_secs_f64() * 1_000.0;
    println!("sorted_samples={samples:?} p95_ms={p95_ms:.3}");
}

fn ok_handler() -> impl Fn(AgentRequest) -> std::future::Ready<AgentResult> + Send + Sync + 'static
{
    |_| std::future::ready(AgentResult::Status(listening_status()))
}

fn listening_status() -> AgentBridgeStatus {
    AgentBridgeStatus {
        enabled: true,
        listening: true,
        connected_clients: 0,
        watcher_clients: 0,
        cli_path: None,
        protocol_version: PROTOCOL_VERSION,
        last_error: None,
    }
}

fn snapshot_with_content(content: String) -> AgentDocumentSnapshot {
    AgentDocumentSnapshot {
        summary: AgentDocumentSummary {
            id: "doc-1".into(),
            path: None,
            title: "Profile".into(),
            dirty: true,
            conflict: false,
            unavailable: false,
            live_revision: "session:1".into(),
            disk_revision: None,
        },
        content,
        meta: None,
    }
}

async fn round_trip_large_document(client: &AgentClient, content: &str) {
    let result = client
        .request(AgentRequestKind::ReplaceDocument {
            document_id: "doc-1".into(),
            base_live_revision: "session:0".into(),
            content: content.into(),
        })
        .await
        .unwrap();
    let AgentResult::Document(snapshot) = result else {
        panic!("expected a document snapshot");
    };
    assert_eq!(snapshot.content.len(), content.len());
}

#[cfg(windows)]
fn windows_file_dacl_sddl(path: &std::path::Path) -> String {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetFileSecurityW, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    let path = HSTRING::from(path.as_os_str());
    let mut required = 0;
    unsafe {
        let _ = GetFileSecurityW(&path, DACL_SECURITY_INFORMATION.0, None, 0, &mut required);
    }
    assert!(required > 0, "could not size registry security descriptor");

    let mut bytes = vec![0_u8; required as usize];
    let descriptor = PSECURITY_DESCRIPTOR(bytes.as_mut_ptr().cast());
    assert!(unsafe {
        GetFileSecurityW(
            &path,
            DACL_SECURITY_INFORMATION.0,
            Some(descriptor),
            required,
            &mut required,
        )
    }
    .as_bool());

    let mut string_descriptor = PWSTR::null();
    unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut string_descriptor,
            None,
        )
    }
    .unwrap();
    let sddl = unsafe { string_descriptor.to_string() }.unwrap();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(string_descriptor.0.cast())));
    }
    sddl
}

#[cfg(windows)]
fn windows_current_user_sid() -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.unwrap();
    let mut required = 0;
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut required);
    }
    assert!(required > 0, "could not size current user token");
    let mut bytes = vec![0_u8; required as usize];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(bytes.as_mut_ptr().cast()),
            required,
            &mut required,
        )
    }
    .unwrap();
    let token_user = unsafe { &*(bytes.as_ptr().cast::<TOKEN_USER>()) };
    let mut string_sid = PWSTR::null();
    unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid) }.unwrap();
    let sid = unsafe { string_sid.to_string() }.unwrap();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(string_sid.0.cast())));
        let _ = CloseHandle(token);
    }
    sid
}
