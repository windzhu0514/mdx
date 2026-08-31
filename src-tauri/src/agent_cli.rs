use crate::agent_client::AgentClient;
use crate::agent_protocol::{
    encode_frame, AgentDocumentEvent, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AGENT_ACCESS_DISABLED, BRIDGE_UNAVAILABLE, DISK_CONFLICT, MAX_FRAME_BYTES, MORA_NOT_RUNNING,
    PERMISSION_DENIED, PROTOCOL_VERSION, REVISION_CONFLICT,
};
use clap::{Parser, Subcommand};
use futures_util::{Future, StreamExt};
use serde::Serialize;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;

const INVALID_INPUT: &str = "INVALID_INPUT";
const INPUT_READ_FAILED: &str = "INPUT_READ_FAILED";
const REQUEST_ID_PLACEHOLDER: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug, Parser)]
#[command(name = "mora-agent", about = "Mora local Agent command-line client")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Status {
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Read {
        document_id: String,
        #[arg(long)]
        json: bool,
    },
    Replace {
        document_id: String,
        #[arg(long)]
        base_revision: String,
        #[arg(long)]
        content_file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    Save {
        document_id: String,
        #[arg(long)]
        base_revision: String,
        #[arg(long)]
        json: bool,
    },
    Watch {
        document_id: Option<String>,
        #[arg(long)]
        jsonl: bool,
    },
    Mcp,
}

pub async fn main_entry(args: impl IntoIterator<Item = OsString>) -> i32 {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            let _ = write!(std::io::stderr(), "{error}");
            return error.exit_code();
        }
    };

    if matches!(&cli.command, Command::Mcp) {
        return match crate::agent_mcp::run_mcp().await {
            Ok(()) => 0,
            Err(error) => {
                let mut stdout = std::io::stdout().lock();
                let mut stderr = std::io::stderr().lock();
                finish_error(&cli, error, &mut stdout, &mut stderr)
            }
        };
    }

    let mut input = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    let content = match read_replace_content(&cli, &mut input) {
        Ok(content) => content,
        Err(error) => return finish_error(&cli, error, &mut stdout, &mut stderr),
    };
    let client = match AgentClient::connect().await {
        Ok(client) => client,
        Err(error) => return finish_error(&cli, error, &mut stdout, &mut stderr),
    };
    run_cli_with_prepared_content(cli, client, content, &mut stdout, &mut stderr).await
}

pub async fn run_cli(cli: Cli, client: AgentClient) -> i32 {
    run_cli_with_io(
        cli,
        client,
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        std::io::stderr().lock(),
    )
    .await
}

pub async fn run_cli_with_io<I, O, E>(
    cli: Cli,
    client: AgentClient,
    mut input: I,
    mut stdout: O,
    mut stderr: E,
) -> i32
where
    I: Read,
    O: Write,
    E: Write,
{
    let content = match read_replace_content(&cli, &mut input) {
        Ok(content) => content,
        Err(error) => return finish_error(&cli, error, &mut stdout, &mut stderr),
    };
    run_cli_with_prepared_content(cli, client, content, &mut stdout, &mut stderr).await
}

pub fn exit_code(code: &str) -> i32 {
    match code {
        MORA_NOT_RUNNING => 2,
        AGENT_ACCESS_DISABLED => 3,
        REVISION_CONFLICT => 4,
        DISK_CONFLICT => 5,
        PERMISSION_DENIED => 6,
        _ => 1,
    }
}

async fn run_cli_with_prepared_content<O, E>(
    cli: Cli,
    client: AgentClient,
    content: Option<String>,
    stdout: &mut O,
    stderr: &mut E,
) -> i32
where
    O: Write,
    E: Write,
{
    match cli.command {
        Command::Status { json } => finish_request(
            client.request(AgentRequestKind::Status).await,
            json,
            stdout,
            stderr,
        ),
        Command::List { json } => finish_request(
            client.request(AgentRequestKind::ListDocuments).await,
            json,
            stdout,
            stderr,
        ),
        Command::Read { document_id, json } => finish_request(
            client
                .request(AgentRequestKind::ReadDocument { document_id })
                .await,
            json,
            stdout,
            stderr,
        ),
        Command::Replace {
            document_id,
            json,
            base_revision,
            ..
        } => finish_request(
            client
                .request(AgentRequestKind::ReplaceDocument {
                    document_id,
                    base_live_revision: base_revision,
                    content: content.expect("replace content is prepared before dispatch"),
                })
                .await,
            json,
            stdout,
            stderr,
        ),
        Command::Save {
            document_id,
            base_revision,
            json,
        } => finish_request(
            client
                .request(AgentRequestKind::SaveDocument {
                    document_id,
                    base_live_revision: base_revision,
                })
                .await,
            json,
            stdout,
            stderr,
        ),
        Command::Watch { document_id, jsonl } => {
            run_watch(client, document_id, jsonl, stdout, stderr).await
        }
        Command::Mcp => finish_error(
            &Cli {
                command: Command::Mcp,
            },
            AgentError::new(INVALID_INPUT, "MCP requires the process stdio transport."),
            stdout,
            stderr,
        ),
    }
}

async fn run_watch<O, E>(
    client: AgentClient,
    document_id: Option<String>,
    jsonl: bool,
    stdout: &mut O,
    stderr: &mut E,
) -> i32
where
    O: Write,
    E: Write,
{
    let events = match client.watch(document_id.clone()).await {
        Ok(events) => events,
        Err(error) => return finish_watch_error(jsonl, error, stdout, stderr),
    };
    run_watch_stream_with_shutdown(events, document_id, jsonl, stdout, stderr, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

#[doc(hidden)]
pub async fn run_watch_stream_with_shutdown<O, E, F>(
    mut events: crate::agent_client::AgentEventStream,
    document_id: Option<String>,
    jsonl: bool,
    stdout: &mut O,
    stderr: &mut E,
    shutdown: F,
) -> i32
where
    O: Write,
    E: Write,
    F: Future<Output = ()>,
{
    if !jsonl {
        let scope = document_id.as_deref().unwrap_or("all documents");
        if writeln!(stdout, "Watching {scope}.")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            return 1;
        }
    }

    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return 0,
            item = events.next() => match item {
                Some(Ok(event)) => {
                    if write_watch_event(jsonl, &event, stdout).is_err() {
                        return 1;
                    }
                }
                Some(Err(error)) => return finish_watch_error(jsonl, error, stdout, stderr),
                None => return finish_watch_error(
                    jsonl,
                    AgentError::new(
                        BRIDGE_UNAVAILABLE,
                        "The Agent watch stream ended unexpectedly.",
                    ),
                    stdout,
                    stderr,
                ),
            },
        }
    }
}

fn read_replace_content(cli: &Cli, input: &mut impl Read) -> Result<Option<String>, AgentError> {
    let Command::Replace {
        content_file,
        document_id,
        base_revision,
        ..
    } = &cli.command
    else {
        return Ok(None);
    };
    let bytes = if content_file.as_os_str() == std::ffi::OsStr::new("-") {
        read_limited(input)?
    } else {
        let mut file = std::fs::File::open(content_file).map_err(|_| {
            AgentError::new(
                INPUT_READ_FAILED,
                "Could not read the requested content file.",
            )
        })?;
        read_limited(&mut file)?
    };
    let content = String::from_utf8(bytes)
        .map_err(|_| AgentError::new(INVALID_INPUT, "Replacement content must be valid UTF-8."))?;
    validate_replace_payload(document_id, base_revision, &content)?;
    Ok(Some(content))
}

fn validate_replace_payload(
    document_id: &str,
    base_live_revision: &str,
    content: &str,
) -> Result<(), AgentError> {
    let request = AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        // AgentClient creates UUID v4 request IDs. The fixed placeholder has the
        // same UTF-8 length, so this preflight exactly matches its frame budget.
        request_id: REQUEST_ID_PLACEHOLDER.into(),
        request: AgentRequestKind::ReplaceDocument {
            document_id: document_id.into(),
            base_live_revision: base_live_revision.into(),
            content: content.into(),
        },
    };
    let payload = serde_json::to_vec(&request).map_err(|_| {
        AgentError::new(
            crate::agent_protocol::PROTOCOL_MISMATCH,
            "Could not encode the Agent replacement request.",
        )
    })?;
    encode_frame(&payload).map(|_| ())
}

fn read_limited(reader: &mut impl Read) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AgentError::new(INPUT_READ_FAILED, "Could not read replacement content."))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AgentError::new(
            crate::agent_protocol::REQUEST_TOO_LARGE,
            "Replacement content exceeds the frame size limit.",
        ));
    }
    Ok(bytes)
}

fn finish_request<O, E>(
    result: Result<AgentResult, AgentError>,
    json: bool,
    stdout: &mut O,
    stderr: &mut E,
) -> i32
where
    O: Write,
    E: Write,
{
    match result {
        Ok(result) => match write_success(json, &result, stdout) {
            Ok(()) => 0,
            Err(_) => 1,
        },
        Err(error) => finish_error_mode(json, false, error, stdout, stderr),
    }
}

fn finish_error<O, E>(cli: &Cli, error: AgentError, stdout: &mut O, stderr: &mut E) -> i32
where
    O: Write,
    E: Write,
{
    finish_error_mode(
        is_json(&cli.command),
        is_jsonl(&cli.command),
        error,
        stdout,
        stderr,
    )
}

fn finish_watch_error<O, E>(jsonl: bool, error: AgentError, stdout: &mut O, stderr: &mut E) -> i32
where
    O: Write,
    E: Write,
{
    finish_error_mode(false, jsonl, error, stdout, stderr)
}

fn finish_error_mode<O, E>(
    json: bool,
    jsonl: bool,
    error: AgentError,
    stdout: &mut O,
    stderr: &mut E,
) -> i32
where
    O: Write,
    E: Write,
{
    if json || jsonl {
        let record = ErrorRecord {
            ok: false,
            error: &error,
        };
        let _ = serde_json::to_writer(&mut *stdout, &record);
        let _ = writeln!(stdout);
        let _ = stdout.flush();
    }
    let _ = writeln!(stderr, "{}: {}", error.code, error.message);
    let _ = stderr.flush();
    exit_code(&error.code)
}

fn write_success(
    result_json: bool,
    result: &AgentResult,
    stdout: &mut impl Write,
) -> Result<(), ()> {
    if result_json {
        serde_json::to_writer(&mut *stdout, &SuccessRecord { ok: true, result }).map_err(|_| ())?;
        writeln!(stdout).map_err(|_| ())?;
    } else {
        write_human_result(result, stdout)?;
    }
    stdout.flush().map_err(|_| ())
}

fn write_human_result(result: &AgentResult, stdout: &mut impl Write) -> Result<(), ()> {
    match result {
        AgentResult::Status(status) => writeln!(
            stdout,
            "enabled={} listening={} connected_clients={} watcher_clients={}",
            status.enabled, status.listening, status.connected_clients, status.watcher_clients
        )
        .map_err(|_| ()),
        AgentResult::Documents(documents) => {
            for document in documents {
                writeln!(
                    stdout,
                    "{}\t{}\t{}",
                    document.id, document.live_revision, document.title
                )
                .map_err(|_| ())?;
            }
            Ok(())
        }
        AgentResult::Document(document) => write!(stdout, "{}", document.content).map_err(|_| ()),
        AgentResult::Mutation(document) => {
            writeln!(stdout, "{}\t{}", document.id, document.live_revision).map_err(|_| ())
        }
    }
}

fn write_watch_event(
    jsonl: bool,
    event: &AgentDocumentEvent,
    stdout: &mut impl Write,
) -> Result<(), ()> {
    if jsonl {
        serde_json::to_writer(&mut *stdout, event).map_err(|_| ())?;
        writeln!(stdout).map_err(|_| ())?;
    } else {
        writeln!(
            stdout,
            "{}\t{}\tdirty={}\tsource={:?}",
            event.document_id, event.live_revision, event.dirty, event.source
        )
        .map_err(|_| ())?;
    }
    stdout.flush().map_err(|_| ())
}

fn is_json(command: &Command) -> bool {
    match command {
        Command::Status { json }
        | Command::List { json }
        | Command::Read { json, .. }
        | Command::Replace { json, .. }
        | Command::Save { json, .. } => *json,
        Command::Watch { .. } | Command::Mcp => false,
    }
}

fn is_jsonl(command: &Command) -> bool {
    matches!(command, Command::Watch { jsonl: true, .. })
}

#[derive(Serialize)]
struct SuccessRecord<'a> {
    ok: bool,
    result: &'a AgentResult,
}

#[derive(Serialize)]
struct ErrorRecord<'a> {
    ok: bool,
    error: &'a AgentError,
}
