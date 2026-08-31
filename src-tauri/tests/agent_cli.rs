use clap::Parser;
use futures_util::Stream;
use mdxnote_lib::agent_cli::{
    exit_code, run_cli_with_io, run_watch_stream_with_shutdown, Cli, Command,
};
use mdxnote_lib::agent_client::{AgentClient, AgentEventStream};
use mdxnote_lib::agent_ipc::{AgentServer, EndpointRegistry, IntoAgentHandlerResult};
use mdxnote_lib::agent_protocol::{
    AgentBridgeStatus, AgentChangeSource, AgentDocumentEvent, AgentDocumentSnapshot,
    AgentDocumentSummary, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AGENT_ACCESS_DISABLED, BRIDGE_UNAVAILABLE, DISK_CONFLICT, DOCUMENT_BUSY, DOCUMENT_NOT_FOUND,
    DOCUMENT_NOT_OPEN, INVALID_MDX, MAX_FRAME_BYTES, MORA_NOT_RUNNING, PERMISSION_DENIED,
    PROTOCOL_MISMATCH, PROTOCOL_VERSION, REQUEST_TOO_LARGE, REVISION_CONFLICT, SAVE_AS_REQUIRED,
    TIMEOUT,
};
use std::io::{Cursor, Write};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tempfile::TempDir;
use tokio::sync::{oneshot, Notify};

#[test]
fn parses_replace_without_accepting_inline_content() {
    let cli = Cli::try_parse_from([
        "mora-agent",
        "replace",
        "doc-1",
        "--base-revision",
        "session:2",
        "--content-file",
        "-",
        "--json",
    ])
    .unwrap();

    assert!(matches!(cli.command, Command::Replace { .. }));
    assert!(Cli::try_parse_from([
        "mora-agent",
        "replace",
        "doc-1",
        "--base-revision",
        "session:2",
        "fixture content",
    ])
    .is_err());
}

#[test]
fn maps_stable_errors_to_stable_exit_codes() {
    assert_eq!(exit_code("MORA_NOT_RUNNING"), 2);
    assert_eq!(exit_code("AGENT_ACCESS_DISABLED"), 3);
    assert_eq!(exit_code("REVISION_CONFLICT"), 4);
    assert_eq!(exit_code("DISK_CONFLICT"), 5);
    assert_eq!(exit_code("PERMISSION_DENIED"), 6);
    assert_eq!(exit_code("UNKNOWN"), 1);
}

#[tokio::test]
async fn list_json_writes_one_record_to_stdout_without_diagnostics() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Documents(vec![document_summary()])))
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let stdout = CaptureWriter::default();
    let stderr = CaptureWriter::default();
    let cli = Cli::try_parse_from(["mora-agent", "list", "--json"]).unwrap();

    let code = run_cli_with_io(
        cli,
        client,
        Cursor::new(Vec::new()),
        stdout.clone(),
        stderr.clone(),
    )
    .await;

    assert_eq!(code, 0);
    let output = stdout.into_string();
    assert_eq!(output.lines().count(), 1);
    let record: serde_json::Value = serde_json::from_str(output.trim()).unwrap();
    assert_eq!(record["ok"], true);
    assert_eq!(record["result"][0]["id"], "doc-1");
    assert!(stderr.into_string().is_empty());
}

#[tokio::test]
async fn watch_jsonl_writes_one_compact_event_per_line_and_never_logs_content() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Status(listening_status())))
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let stdout = CaptureWriter::default();
    let stderr = CaptureWriter::default();
    let cli = Cli::try_parse_from(["mora-agent", "watch", "--jsonl"]).unwrap();
    let mut counts = server.subscribe_connection_counts();
    let task = tokio::spawn(run_cli_with_io(
        cli,
        client,
        Cursor::new(Vec::new()),
        stdout.clone(),
        stderr.clone(),
    ));

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while counts.borrow().watcher_clients != 1 {
            counts.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    server.publish_event(AgentDocumentEvent {
        document_id: "doc-1".into(),
        live_revision: "session:2".into(),
        dirty: true,
        source: AgentChangeSource::Agent,
    });
    stdout.wait_for_contains("\"documentId\":\"doc-1\"").await;
    assert!(stdout.flush_count() >= 1);
    server.stop().await.unwrap();

    assert_eq!(task.await.unwrap(), 1);
    let output = stdout.into_string();
    assert!(!output.contains("fixture content"));
    let records: Vec<serde_json::Value> = output
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .unwrap();
    let events: Vec<_> = records
        .iter()
        .filter(|record| record.get("documentId").is_some())
        .collect();
    assert_eq!(events.len(), 1);
    let event = events[0];
    assert_eq!(event["documentId"], "doc-1");
    let diagnostics = stderr.into_string();
    assert!(diagnostics.contains("BRIDGE_UNAVAILABLE"));
    assert!(!diagnostics.contains("fixture content"));
}

struct IpcFixture {
    _temp: TempDir,
    registry: EndpointRegistry,
}

impl IpcFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let registry = EndpointRegistry::at(temp.path().join("agent-endpoint-v1.json"));
        Self {
            _temp: temp,
            registry,
        }
    }

    async fn start<H, F, O>(&self, handler: H) -> AgentServer
    where
        H: Fn(AgentRequest) -> F + Send + Sync + 'static,
        F: std::future::Future<Output = O> + Send + 'static,
        O: IntoAgentHandlerResult + 'static,
    {
        AgentServer::start(self.registry.clone(), handler)
            .await
            .unwrap()
    }
}

#[derive(Clone)]
struct CaptureWriter {
    buffer: Arc<Mutex<Vec<u8>>>,
    written: Arc<Notify>,
    flushes: Arc<std::sync::atomic::AtomicUsize>,
}

impl Default for CaptureWriter {
    fn default() -> Self {
        Self {
            buffer: Arc::new(Mutex::new(Vec::new())),
            written: Arc::new(Notify::new()),
            flushes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
}

impl CaptureWriter {
    fn into_string(self) -> String {
        String::from_utf8(self.buffer.lock().unwrap().clone()).unwrap()
    }

    async fn wait_for_contains(&self, needle: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let notified = self.written.notified();
                if self
                    .buffer
                    .lock()
                    .unwrap()
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes())
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .unwrap();
    }

    fn flush_count(&self) -> usize {
        self.flushes.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Write for CaptureWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.buffer.lock().unwrap().extend_from_slice(buffer);
        self.written.notify_one();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.flushes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Clone, Default)]
struct BlockingWriter {
    state: Arc<BlockingWriterState>,
}

#[derive(Default)]
struct BlockingWriterState {
    buffer: Mutex<Vec<u8>>,
    writes: std::sync::atomic::AtomicUsize,
    flushes: std::sync::atomic::AtomicUsize,
    first_write_started: Notify,
    progress: Notify,
    released: Mutex<bool>,
    release_signal: std::sync::Condvar,
}

impl BlockingWriter {
    async fn wait_for_first_write(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let notified = self.state.first_write_started.notified();
                if self.state.writes.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    return;
                }
                notified.await;
            }
        })
        .await
        .unwrap();
    }

    async fn wait_for_flushes(&self, expected: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let notified = self.state.progress.notified();
                if self.state.flushes.load(std::sync::atomic::Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        })
        .await
        .unwrap();
    }

    fn release(&self) {
        *self.state.released.lock().unwrap() = true;
        self.state.release_signal.notify_all();
    }

    fn output(&self) -> String {
        String::from_utf8(self.state.buffer.lock().unwrap().clone()).unwrap()
    }

    fn flush_count(&self) -> usize {
        self.state.flushes.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Write for BlockingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self
            .state
            .writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            self.state.first_write_started.notify_waiters();
            let mut released = self.state.released.lock().unwrap();
            while !*released {
                released = self.state.release_signal.wait(released).unwrap();
            }
        }
        self.state.buffer.lock().unwrap().extend_from_slice(buffer);
        self.state.progress.notify_waiters();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.state
            .flushes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.state.progress.notify_waiters();
        Ok(())
    }
}

struct CountingEventStream {
    emitted: usize,
    polls: Arc<std::sync::atomic::AtomicUsize>,
}

impl CountingEventStream {
    fn new(polls: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        Self { emitted: 0, polls }
    }
}

impl Stream for CountingEventStream {
    type Item = Result<AgentDocumentEvent, AgentError>;

    fn poll_next(mut self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.emitted == 3 {
            return Poll::Pending;
        }
        self.emitted += 1;
        Poll::Ready(Some(Ok(AgentDocumentEvent {
            document_id: format!("doc-{}", self.emitted),
            live_revision: format!("session:{}", self.emitted),
            dirty: true,
            source: AgentChangeSource::Agent,
        })))
    }
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

fn document_summary() -> AgentDocumentSummary {
    AgentDocumentSummary {
        id: "doc-1".into(),
        path: None,
        title: "Profile".into(),
        dirty: true,
        conflict: false,
        unavailable: false,
        live_revision: "session:1".into(),
        disk_revision: None,
    }
}

#[tokio::test]
async fn watch_eof_is_a_bridge_error_while_explicit_shutdown_is_clean() {
    let mut stdout = CaptureWriter::default();
    let mut stderr = CaptureWriter::default();
    let eof: AgentEventStream = Box::pin(futures_util::stream::empty());

    let code = run_watch_stream_with_shutdown(
        eof,
        None,
        true,
        &mut stdout,
        &mut stderr,
        std::future::pending(),
    )
    .await;

    assert_eq!(code, 1);
    assert_eq!(json_error_code(&stdout.into_string()), BRIDGE_UNAVAILABLE);
    assert!(stderr.into_string().contains(BRIDGE_UNAVAILABLE));

    let mut stdout = CaptureWriter::default();
    let mut stderr = CaptureWriter::default();
    let (shutdown, receiver) = oneshot::channel::<()>();
    shutdown.send(()).unwrap();
    let code = run_watch_stream_with_shutdown(
        Box::pin(futures_util::stream::pending()),
        None,
        true,
        &mut stdout,
        &mut stderr,
        async move {
            let _ = receiver.await;
        },
    )
    .await;

    assert_eq!(code, 0);
    assert!(stdout.into_string().is_empty());
    assert!(stderr.into_string().is_empty());
}

#[tokio::test]
async fn replace_preflights_the_complete_payload_before_dispatch() {
    for (document_id, base_revision) in [
        ("doc-1".to_string(), "session:1".to_string()),
        ("d".repeat(2048), "r".repeat(3072)),
    ] {
        let fixture = IpcFixture::new();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let requests_for_handler = requests.clone();
        let server = fixture
            .start(move |_| {
                requests_for_handler.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(AgentResult::Mutation(document_summary()))
            })
            .await;
        let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
        let exact = replacement_content_len(&document_id, &base_revision);
        let cli = replace_cli(&document_id, &base_revision, true);
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();

        let code = run_cli_with_io(
            cli,
            client.clone(),
            Cursor::new(vec![b'x'; exact]),
            stdout.clone(),
            stderr.clone(),
        )
        .await;
        assert_eq!(code, 0, "exact payload limit must pass");
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);

        let cli = replace_cli(&document_id, &base_revision, true);
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();
        let code = run_cli_with_io(
            cli,
            client,
            Cursor::new(vec![b'x'; exact + 1]),
            stdout.clone(),
            stderr.clone(),
        )
        .await;
        assert_eq!(code, 1, "one byte beyond full payload must fail");
        assert_eq!(json_error_code(&stdout.into_string()), REQUEST_TOO_LARGE);
        assert!(stderr.into_string().contains(REQUEST_TOO_LARGE));
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn replace_input_failures_are_stable_and_do_not_leak_content() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Mutation(document_summary())))
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let cases = [
        (Cursor::new(vec![0xff]), "INVALID_INPUT"),
        (
            Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]),
            REQUEST_TOO_LARGE,
        ),
    ];
    for (input, code) in cases {
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();
        let result = run_cli_with_io(
            replace_cli("doc-1", "session:1", true),
            client.clone(),
            input,
            stdout.clone(),
            stderr.clone(),
        )
        .await;
        assert_eq!(result, 1);
        assert_eq!(json_error_code(&stdout.into_string()), code);
        assert!(!stderr.into_string().contains("fixture content"));
    }
}

#[tokio::test]
async fn successful_commands_keep_content_exclusive_to_read_output() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|request| async move {
            match request.request {
                AgentRequestKind::Status => AgentResult::Status(listening_status()),
                AgentRequestKind::ListDocuments => AgentResult::Documents(vec![document_summary()]),
                AgentRequestKind::ReadDocument { .. } => {
                    AgentResult::Document(AgentDocumentSnapshot {
                        summary: document_summary(),
                        content: "fixture content secret-token".into(),
                        meta: None,
                    })
                }
                AgentRequestKind::ReplaceDocument { .. }
                | AgentRequestKind::SaveDocument { .. } => {
                    AgentResult::Mutation(document_summary())
                }
                AgentRequestKind::Watch { .. } => AgentResult::Status(listening_status()),
            }
        })
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let cases = vec![
        (
            Cli::try_parse_from(["mora-agent", "status", "--json"]).unwrap(),
            Vec::new(),
            false,
        ),
        (
            Cli::try_parse_from(["mora-agent", "list"]).unwrap(),
            Vec::new(),
            false,
        ),
        (
            Cli::try_parse_from(["mora-agent", "read", "doc-1"]).unwrap(),
            Vec::new(),
            true,
        ),
        (
            replace_cli("doc-1", "session:1", true),
            b"replacement".to_vec(),
            false,
        ),
        (
            Cli::try_parse_from([
                "mora-agent",
                "save",
                "doc-1",
                "--base-revision",
                "session:1",
                "--json",
            ])
            .unwrap(),
            Vec::new(),
            false,
        ),
    ];
    for (cli, input, contains_content) in cases {
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();
        assert_eq!(
            run_cli_with_io(
                cli,
                client.clone(),
                Cursor::new(input),
                stdout.clone(),
                stderr.clone()
            )
            .await,
            0
        );
        assert_eq!(
            stdout
                .into_string()
                .contains("fixture content secret-token"),
            contains_content
        );
        assert!(stderr.into_string().is_empty());
    }
}

#[tokio::test]
async fn stable_errors_and_mcp_placeholder_use_the_actual_output_path() {
    let cases = [
        (MORA_NOT_RUNNING, 2),
        (AGENT_ACCESS_DISABLED, 3),
        (REVISION_CONFLICT, 4),
        (DISK_CONFLICT, 5),
        (PERMISSION_DENIED, 6),
        (BRIDGE_UNAVAILABLE, 1),
        (DOCUMENT_NOT_FOUND, 1),
        (DOCUMENT_NOT_OPEN, 1),
        (DOCUMENT_BUSY, 1),
        (SAVE_AS_REQUIRED, 1),
        (INVALID_MDX, 1),
        (REQUEST_TOO_LARGE, 1),
        (TIMEOUT, 1),
        (PROTOCOL_MISMATCH, 1),
    ];
    for (code, expected_exit) in cases {
        let fixture = IpcFixture::new();
        let error_code = code.to_string();
        let server = fixture
            .start(move |_| {
                let error_code = error_code.clone();
                async move {
                    Err::<AgentResult, AgentError>(AgentError::new(error_code, "fixture failure"))
                }
            })
            .await;
        let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();
        let code_result = run_cli_with_io(
            Cli::try_parse_from(["mora-agent", "list", "--json"]).unwrap(),
            client,
            Cursor::new(Vec::new()),
            stdout.clone(),
            stderr.clone(),
        )
        .await;
        assert_eq!(code_result, expected_exit, "{code}");
        assert_eq!(json_error_code(&stdout.into_string()), code);
        assert!(stderr.into_string().contains(code));
    }
}

#[tokio::test]
async fn mcp_placeholder_and_console_entry_stay_gui_free() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Status(listening_status())))
        .await;
    let stdout = CaptureWriter::default();
    let stderr = CaptureWriter::default();
    let code = run_cli_with_io(
        Cli::try_parse_from(["mora-agent", "mcp"]).unwrap(),
        AgentClient::connect_to(server.descriptor()).await.unwrap(),
        Cursor::new(Vec::new()),
        stdout.clone(),
        stderr.clone(),
    )
    .await;
    assert_eq!(code, 1);
    assert!(stdout.into_string().is_empty());
    assert!(stderr.into_string().contains("UNSUPPORTED_COMMAND"));
    let entry = std::fs::read_to_string("src/bin/mora-agent.rs").unwrap();
    assert!(entry.contains("agent_cli::main_entry"));
    assert!(!entry.contains("tauri::Builder"));
}

#[tokio::test]
async fn replace_file_inputs_are_validated_before_dispatch() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Mutation(document_summary())))
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let invalid = temp.path().join("invalid.md");
    std::fs::write(&invalid, [0xff]).unwrap();
    let missing = temp.path().join("missing.md");

    for (path, expected) in [(invalid, "INVALID_INPUT"), (missing, "INPUT_READ_FAILED")] {
        let stdout = CaptureWriter::default();
        let stderr = CaptureWriter::default();
        let code = run_cli_with_io(
            Command::Replace {
                document_id: "doc-1".into(),
                base_revision: "session:1".into(),
                content_file: path,
                json: true,
            }
            .into_cli(),
            client.clone(),
            Cursor::new(Vec::new()),
            stdout.clone(),
            stderr.clone(),
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(json_error_code(&stdout.into_string()), expected);
        assert!(!stderr.into_string().contains("fixture content"));
    }
}

#[tokio::test]
async fn watch_human_prints_ack_then_event_and_flushes_each_record() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|_| std::future::ready(AgentResult::Status(listening_status())))
        .await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let stdout = CaptureWriter::default();
    let stderr = CaptureWriter::default();
    let mut counts = server.subscribe_connection_counts();
    let task = tokio::spawn(run_cli_with_io(
        Cli {
            command: Command::Watch {
                document_id: Some("doc-1".into()),
                jsonl: false,
            },
        },
        client,
        Cursor::new(Vec::new()),
        stdout.clone(),
        stderr.clone(),
    ));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while counts.borrow().watcher_clients != 1 {
            counts.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    stdout.wait_for_contains("Watching doc-1.").await;
    server.publish_event(AgentDocumentEvent {
        document_id: "doc-1".into(),
        live_revision: "session:2".into(),
        dirty: true,
        source: AgentChangeSource::Agent,
    });
    stdout.wait_for_contains("doc-1\tsession:2").await;
    assert!(stdout.flush_count() >= 2);
    server.stop().await.unwrap();
    assert_eq!(task.await.unwrap(), 1);
    assert!(!stdout.into_string().contains("fixture content"));
    assert!(!stderr.into_string().contains("fixture content"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watch_backpressures_events_until_a_slow_stdout_write_releases() {
    let stdout = BlockingWriter::default();
    let observed_stdout = stdout.clone();
    let stderr = CaptureWriter::default();
    let observed_stderr = stderr.clone();
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let events: AgentEventStream = Box::pin(CountingEventStream::new(polls.clone()));
    let (shutdown, receiver) = oneshot::channel::<()>();

    let task = tokio::spawn(async move {
        let mut stdout = stdout;
        let mut stderr = stderr;
        run_watch_stream_with_shutdown(events, None, true, &mut stdout, &mut stderr, async move {
            let _ = receiver.await;
        })
        .await
    });

    observed_stdout.wait_for_first_write().await;
    assert_eq!(polls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(!observed_stdout
        .output()
        .contains("fixture content secret-token"));

    observed_stdout.release();
    observed_stdout.wait_for_flushes(3).await;
    let output = observed_stdout.output();
    assert!(output.find("doc-1").unwrap() < output.find("doc-2").unwrap());
    assert!(output.find("doc-2").unwrap() < output.find("doc-3").unwrap());
    assert_eq!(observed_stdout.flush_count(), 3);
    assert!(!output.contains("fixture content secret-token"));
    assert!(observed_stderr.into_string().is_empty());

    shutdown.send(()).unwrap();
    assert_eq!(task.await.unwrap(), 0);
}

fn replace_cli(document_id: &str, base_revision: &str, json: bool) -> Cli {
    Cli::try_parse_from(
        [
            "mora-agent",
            "replace",
            document_id,
            "--base-revision",
            base_revision,
            "--content-file",
            "-",
        ]
        .into_iter()
        .chain(json.then_some("--json")),
    )
    .unwrap()
}

trait IntoCli {
    fn into_cli(self) -> Cli;
}

impl IntoCli for Command {
    fn into_cli(self) -> Cli {
        Cli { command: self }
    }
}

fn replacement_content_len(document_id: &str, base_revision: &str) -> usize {
    let request = AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: "00000000-0000-0000-0000-000000000000".into(),
        request: AgentRequestKind::ReplaceDocument {
            document_id: document_id.into(),
            base_live_revision: base_revision.into(),
            content: String::new(),
        },
    };
    MAX_FRAME_BYTES - serde_json::to_vec(&request).unwrap().len()
}

fn json_error_code(output: &str) -> String {
    serde_json::from_str::<serde_json::Value>(output.lines().last().unwrap()).unwrap()["error"]
        ["code"]
        .as_str()
        .unwrap()
        .to_string()
}
