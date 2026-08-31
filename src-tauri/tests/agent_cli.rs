use clap::Parser;
use mdxnote_lib::agent_cli::{exit_code, run_cli_with_io, Cli, Command};
use mdxnote_lib::agent_client::AgentClient;
use mdxnote_lib::agent_ipc::{AgentServer, EndpointRegistry};
use mdxnote_lib::agent_protocol::{
    AgentBridgeStatus, AgentChangeSource, AgentDocumentEvent, AgentDocumentSummary, AgentRequest,
    AgentResult, PROTOCOL_VERSION,
};
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use tokio::sync::Notify;

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

    async fn start<H, F>(&self, handler: H) -> AgentServer
    where
        H: Fn(AgentRequest) -> F + Send + Sync + 'static,
        F: std::future::Future<Output = AgentResult> + Send + 'static,
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
}

impl Default for CaptureWriter {
    fn default() -> Self {
        Self {
            buffer: Arc::new(Mutex::new(Vec::new())),
            written: Arc::new(Notify::new()),
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
}

impl Write for CaptureWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.buffer.lock().unwrap().extend_from_slice(buffer);
        self.written.notify_one();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
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
