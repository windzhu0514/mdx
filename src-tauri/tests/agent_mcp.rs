#![cfg(feature = "agent-bin")]

use mdxnote_lib::agent_ipc::{AgentServer, EndpointRegistry};
use mdxnote_lib::agent_protocol::{
    AgentDocumentSnapshot, AgentDocumentSummary, AgentError, AgentRequest, AgentRequestKind,
    AgentResult, BRIDGE_UNAVAILABLE, REVISION_CONFLICT, TIMEOUT,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

struct IpcFixture {
    temp: TempDir,
    registry: EndpointRegistry,
}

impl IpcFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(windows)]
        let registry_path = temp
            .path()
            .join("Mora")
            .join("agent")
            .join("agent-endpoint-v1.json");
        #[cfg(unix)]
        let registry_path = temp.path().join("mora").join("agent-endpoint-v1.json");
        Self {
            registry: EndpointRegistry::at(registry_path),
            temp,
        }
    }

    async fn start<H, F>(&self, handler: H) -> AgentServer
    where
        H: Fn(AgentRequest) -> F + Send + Sync + 'static,
        F: std::future::Future<Output = Result<AgentResult, AgentError>> + Send + 'static,
    {
        AgentServer::start(self.registry.clone(), handler)
            .await
            .unwrap()
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mora-agent"));
        command.arg("mcp");
        #[cfg(windows)]
        command.env("LOCALAPPDATA", self.temp.path());
        #[cfg(unix)]
        command.env("XDG_RUNTIME_DIR", self.temp.path());
        command
    }
}

struct McpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl McpProcess {
    fn start(fixture: &IpcFixture) -> Self {
        let mut child = fixture
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *stdin, &message).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "MCP server closed stdout before replying");
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("stdout contained non-MCP text: {line:?}: {error}"))
    }

    fn initialize(&mut self) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "mora-agent-test", "version": "1.0.0" }
            }
        }));
        let response = self.receive();
        assert_eq!(response["id"], 1);
        assert!(response["result"]["serverInfo"]["name"]
            .as_str()
            .is_some_and(|name| !name.is_empty()));
        assert!(response["result"]["capabilities"]["tools"].is_object());
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }));
    }

    fn call_tool(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }));
        let response = self.receive();
        assert_eq!(response["id"], id);
        response
    }

    fn close(mut self) -> (i32, String, String) {
        drop(self.stdin.take());
        let mut remaining_stdout = String::new();
        self.stdout.read_to_string(&mut remaining_stdout).unwrap();
        let status = self.child.wait().unwrap();
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        (status.code().unwrap_or(-1), remaining_stdout, stderr)
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn discovers_and_invokes_exactly_four_stdio_tools_through_agent_client() {
    let fixture = IpcFixture::new();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let server = fixture
        .start({
            let captured = captured.clone();
            move |request| {
                captured.lock().unwrap().push(request.request.clone());
                async move {
                    match request.request {
                        AgentRequestKind::ListDocuments => {
                            Ok(AgentResult::Documents(vec![document_summary("session:7")]))
                        }
                        AgentRequestKind::ReadDocument { .. } => {
                            Ok(AgentResult::Document(AgentDocumentSnapshot {
                                summary: document_summary("session:7"),
                                content: "fixture content secret-token".into(),
                                meta: None,
                            }))
                        }
                        AgentRequestKind::ReplaceDocument { .. }
                        | AgentRequestKind::SaveDocument { .. } => {
                            Ok(AgentResult::Mutation(document_summary("session:8")))
                        }
                        other => panic!("unexpected Agent request: {other:?}"),
                    }
                }
            }
        })
        .await;
    let mut mcp = McpProcess::start(&fixture);
    mcp.initialize();

    mcp.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }));
    let listed = mcp.receive();
    let listed_tool_names: Vec<_> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        listed_tool_names,
        [
            "mora_list_documents",
            "mora_read_document",
            "mora_replace_document",
            "mora_save_document",
        ]
    );
    assert_input_schema(&listed["result"]["tools"][0], &[]);
    assert_input_schema(&listed["result"]["tools"][1], &["document_id"]);
    assert_input_schema(
        &listed["result"]["tools"][2],
        &["document_id", "base_live_revision", "content"],
    );
    assert_input_schema(
        &listed["result"]["tools"][3],
        &["document_id", "base_live_revision"],
    );

    let list = mcp.call_tool(3, "mora_list_documents", json!({}));
    assert_eq!(tool_text_json(&list)[0]["id"], "doc-1");
    let read = mcp.call_tool(4, "mora_read_document", json!({ "document_id": "doc-1" }));
    assert_eq!(
        tool_text_json(&read)["content"],
        "fixture content secret-token"
    );
    let replace = mcp.call_tool(
        5,
        "mora_replace_document",
        json!({
            "document_id": "doc-1",
            "base_live_revision": "session:7",
            "content": "# from mcp\n"
        }),
    );
    assert_eq!(tool_text_json(&replace)["liveRevision"], "session:8");
    let save = mcp.call_tool(
        6,
        "mora_save_document",
        json!({
            "document_id": "doc-1",
            "base_live_revision": "session:8"
        }),
    );
    assert_eq!(tool_text_json(&save)["liveRevision"], "session:8");

    let captured = captured.lock().unwrap();
    assert!(matches!(captured[0], AgentRequestKind::ListDocuments));
    assert!(matches!(
        &captured[1],
        AgentRequestKind::ReadDocument { document_id } if document_id == "doc-1"
    ));
    let AgentRequestKind::ReplaceDocument {
        document_id,
        base_live_revision,
        content,
    } = &captured[2]
    else {
        panic!("replace did not use AgentClient::request")
    };
    assert_eq!(document_id, "doc-1");
    assert_eq!(base_live_revision, "session:7");
    assert_eq!(content, "# from mcp\n");
    assert!(matches!(
        &captured[3],
        AgentRequestKind::SaveDocument {
            document_id,
            base_live_revision,
        } if document_id == "doc-1" && base_live_revision == "session:8"
    ));
    drop(captured);

    let (code, remaining_stdout, stderr) = mcp.close();
    assert_eq!(code, 0);
    assert!(remaining_stdout.is_empty());
    assert!(!stderr.contains("fixture content"));
    assert!(!stderr.contains("secret-token"));
    server.stop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn revision_conflict_is_a_structured_tool_error_without_document_content() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|request| async move {
            match request.request {
                AgentRequestKind::ReplaceDocument { .. } => Err(AgentError::new(
                    REVISION_CONFLICT,
                    "The document changed since it was read.",
                )
                .with_detail(json!({
                    "documentId": "doc-1",
                    "currentLiveRevision": "session:8",
                    "content": "fixture content secret-token"
                }))),
                other => panic!("unexpected Agent request: {other:?}"),
            }
        })
        .await;
    let mut mcp = McpProcess::start(&fixture);
    mcp.initialize();

    let response = mcp.call_tool(
        2,
        "mora_replace_document",
        json!({
            "document_id": "doc-1",
            "base_live_revision": "session:7",
            "content": "replacement content secret-token"
        }),
    );

    assert_eq!(response["result"]["isError"], true);
    assert!(response.get("error").is_none());
    let error = tool_text_json(&response);
    assert_eq!(error["code"], REVISION_CONFLICT);
    assert_eq!(error["detail"]["currentLiveRevision"], "session:8");
    assert!(!response.to_string().contains("fixture content"));
    assert!(!response.to_string().contains("replacement content"));
    assert!(!response.to_string().contains("secret-token"));

    let (code, remaining_stdout, stderr) = mcp.close();
    assert_eq!(code, 0);
    assert!(remaining_stdout.is_empty());
    assert!(!stderr.contains("fixture content"));
    assert!(!stderr.contains("replacement content"));
    assert!(!stderr.contains("secret-token"));
    server.stop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn save_timeout_preserves_the_unknown_outcome_marker_in_mcp() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|request| async move {
            assert!(matches!(
                request.request,
                AgentRequestKind::SaveDocument { .. }
            ));
            Err(AgentError::new(TIMEOUT, "The Agent request timed out.")
                .with_detail(json!({ "outcomeUnknown": true })))
        })
        .await;
    let mut mcp = McpProcess::start(&fixture);
    mcp.initialize();

    let response = mcp.call_tool(
        2,
        "mora_save_document",
        json!({
            "document_id": "doc-1",
            "base_live_revision": "session:1"
        }),
    );

    assert_eq!(response["result"]["isError"], true);
    let error = tool_text_json(&response);
    assert_eq!(error["code"], TIMEOUT);
    assert_eq!(error["detail"]["outcomeUnknown"], true);

    let (code, remaining_stdout, stderr) = mcp.close();
    assert_eq!(code, 0);
    assert!(remaining_stdout.is_empty());
    assert!(!stderr.contains("session:1"));
    server.stop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_misuse_invalid_arguments_concurrency_and_bridge_stop_do_not_panic() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|request| async move {
            match request.request {
                AgentRequestKind::ListDocuments => Ok(AgentResult::Documents(Vec::new())),
                other => panic!("unexpected Agent request: {other:?}"),
            }
        })
        .await;
    let mut before_initialize = McpProcess::start(&fixture);
    before_initialize.send(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    }));
    let (code, stdout, stderr) = before_initialize.close();
    assert_eq!(code, 1);
    let protocol_error: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(protocol_error["id"], 1);
    assert!(protocol_error.get("error").is_some());
    assert!(stderr.contains("PROTOCOL_MISMATCH"));

    let mut mcp = McpProcess::start(&fixture);
    mcp.initialize();
    let unknown = mcp.call_tool(2, "mora_unknown", json!({}));
    assert_eq!(unknown["error"]["code"], -32602);
    assert_eq!(unknown["error"]["message"], "tool not found");
    assert!(unknown.get("result").is_none());
    let invalid = mcp.call_tool(3, "mora_read_document", json!({}));
    assert_eq!(invalid["error"]["code"], -32602);
    assert!(invalid["error"]["message"]
        .as_str()
        .unwrap()
        .contains("missing field `document_id`"));
    assert!(invalid.get("result").is_none());

    for id in [4, 5] {
        mcp.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": "mora_list_documents", "arguments": {} }
        }));
    }
    let concurrent_ids: BTreeSet<_> = [mcp.receive(), mcp.receive()]
        .into_iter()
        .map(|response| response["id"].as_u64().unwrap())
        .collect();
    assert_eq!(concurrent_ids, BTreeSet::from([4, 5]));

    server.stop().await.unwrap();
    let stopped = mcp.call_tool(6, "mora_list_documents", json!({}));
    assert_eq!(stopped["result"]["isError"], true);
    let error = tool_text_json(&stopped);
    assert_eq!(error["code"], BRIDGE_UNAVAILABLE);

    let (code, remaining_stdout, stderr) = mcp.close();
    assert_eq!(code, 0);
    assert!(remaining_stdout.is_empty());
    assert!(!stderr.contains("fixture content"));
}

#[tokio::test(flavor = "multi_thread")]
async fn one_mcp_process_initializes_before_mora_and_recovers_across_bridge_sessions() {
    let fixture = IpcFixture::new();
    let mut mcp = McpProcess::start(&fixture);
    mcp.initialize();

    let unavailable = mcp.call_tool(2, "mora_list_documents", json!({}));
    assert_eq!(unavailable["result"]["isError"], true);
    assert_eq!(tool_text_json(&unavailable)["code"], BRIDGE_UNAVAILABLE);

    let server_a = fixture
        .start(|request| async move {
            match request.request {
                AgentRequestKind::ListDocuments => {
                    Ok(AgentResult::Documents(vec![document_summary(
                        "session-a:1",
                    )]))
                }
                other => panic!("unexpected Agent request: {other:?}"),
            }
        })
        .await;
    let first_session = mcp.call_tool(3, "mora_list_documents", json!({}));
    assert_eq!(
        tool_text_json(&first_session)[0]["liveRevision"],
        "session-a:1"
    );

    server_a.stop().await.unwrap();
    let stopped = mcp.call_tool(4, "mora_list_documents", json!({}));
    assert_eq!(stopped["result"]["isError"], true);
    assert_eq!(tool_text_json(&stopped)["code"], BRIDGE_UNAVAILABLE);

    let server_b = fixture
        .start(|request| async move {
            match request.request {
                AgentRequestKind::ListDocuments => {
                    Ok(AgentResult::Documents(vec![document_summary(
                        "session-b:1",
                    )]))
                }
                other => panic!("unexpected Agent request: {other:?}"),
            }
        })
        .await;
    let second_session = mcp.call_tool(5, "mora_list_documents", json!({}));
    assert_eq!(
        tool_text_json(&second_session)[0]["liveRevision"],
        "session-b:1"
    );

    let (code, remaining_stdout, stderr) = mcp.close();
    assert_eq!(code, 0);
    assert!(remaining_stdout.is_empty());
    assert!(!stderr.contains("fixture content"));
    server_b.stop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn stdin_eof_before_initialize_exits_cleanly_when_mora_is_running() {
    let fixture = IpcFixture::new();
    let server = fixture
        .start(|request| async move {
            panic!("stdin EOF must not dispatch an Agent request: {request:?}")
        })
        .await;

    let output = fixture
        .command()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    server.stop().await.unwrap();
}

fn tool_text_json(response: &Value) -> Value {
    let text = response["result"]["content"][0]["text"].as_str().unwrap();
    serde_json::from_str(text).unwrap()
}

fn document_summary(live_revision: &str) -> AgentDocumentSummary {
    AgentDocumentSummary {
        id: "doc-1".into(),
        path: Some("C:/notes/fixture.mdx".into()),
        title: "Fixture".into(),
        dirty: true,
        conflict: false,
        unavailable: false,
        live_revision: live_revision.into(),
        disk_revision: None,
    }
}

fn assert_input_schema(tool: &Value, expected_fields: &[&str]) {
    let schema = &tool["inputSchema"];
    assert_eq!(schema["type"], "object", "schema for {}", tool["name"]);

    let properties = schema["properties"].as_object().unwrap();
    let property_names: BTreeSet<_> = properties.keys().map(String::as_str).collect();
    let expected_names: BTreeSet<_> = expected_fields.iter().copied().collect();
    assert_eq!(
        property_names, expected_names,
        "schema for {}",
        tool["name"]
    );
    for field in expected_fields {
        assert_eq!(
            properties[*field]["type"], "string",
            "schema for {} field {field}",
            tool["name"]
        );
    }

    let required: BTreeSet<_> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|field| field.as_str().unwrap())
        .collect();
    assert_eq!(required, expected_names, "schema for {}", tool["name"]);
}
