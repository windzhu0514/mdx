use eventsource_stream::{Event, Eventsource};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use tokio::sync::oneshot;
use url::{Host, Url};

const AI_KEYRING_SERVICE: &str = "com.mora.mojian";
const AI_KEYRING_USER: &str = "openai-compatible-api-key";

#[derive(Default)]
pub(crate) struct AiRequestState {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

impl AiRequestState {
    fn begin_request(&self) -> Result<oneshot::Receiver<()>, String> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let previous = self
            .cancel
            .lock()
            .map_err(|_| "无法更新 AI 请求状态".to_string())?
            .replace(cancel_tx);
        if let Some(previous) = previous {
            let _ = previous.send(());
        }
        Ok(cancel_rx)
    }

    fn cancel_current(&self) -> Result<(), String> {
        let sender = self
            .cancel
            .lock()
            .map_err(|_| "无法更新 AI 请求状态".to_string())?
            .take();
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRequest {
    pub base_url: String,
    pub model: String,
    pub document: String,
    pub selection: String,
    pub instruction: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum AiStreamEvent {
    Delta { text: String },
    Done,
    Error { code: String, message: String },
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    stream: bool,
    messages: [ChatMessage; 2],
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

fn build_chat_request(request: &AiRequest) -> ChatRequest {
    const SYSTEM_MESSAGE: &str = "你是 Mora 墨笺的 Markdown 写作助手。只返回要插入或替换的 Markdown，\n不要解释，不要用代码围栏包裹整个答案。";
    let selection = if request.selection.is_empty() {
        "无选区，请生成可插入光标位置的内容"
    } else {
        &request.selection
    };

    ChatRequest {
        model: request.model.trim().to_string(),
        stream: true,
        messages: [
            ChatMessage {
                role: "system",
                content: SYSTEM_MESSAGE.to_string(),
            },
            ChatMessage {
                role: "user",
                content: format!(
                    "指令：\n{}\n\n当前文档：\n{}\n\n当前选区：\n{}",
                    request.instruction, request.document, selection
                ),
            },
        ],
    }
}

#[derive(Debug, PartialEq)]
enum StreamData {
    Delta(Option<String>),
    Done,
}

#[derive(Deserialize)]
struct StreamEnvelope {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, PartialEq)]
struct AiError {
    code: &'static str,
    message: &'static str,
}

fn parse_stream_data(data: &str) -> Result<StreamData, ()> {
    if data.trim() == "[DONE]" {
        return Ok(StreamData::Done);
    }

    let envelope: StreamEnvelope = serde_json::from_str(data).map_err(|_| ())?;
    let choice = envelope.choices.into_iter().next().ok_or(())?;
    Ok(StreamData::Delta(choice.delta.content))
}

fn http_status_error(status: u16) -> AiError {
    match status {
        401 | 403 => AiError {
            code: "AI_AUTH",
            message: "AI API Key 无效或无权限",
        },
        404 => AiError {
            code: "AI_ENDPOINT",
            message: "AI Base URL、接口路径或模型不兼容",
        },
        429 => AiError {
            code: "AI_RATE_LIMIT",
            message: "AI 请求频率或额度受限",
        },
        500..=599 => AiError {
            code: "AI_SERVER",
            message: "AI 服务暂时不可用，请稍后重试",
        },
        _ => AiError {
            code: "AI_HTTP",
            message: "AI 请求失败，请检查服务配置",
        },
    }
}

fn protocol_error_event() -> AiStreamEvent {
    AiStreamEvent::Error {
        code: "AI_PROTOCOL".to_string(),
        message: "AI 服务不符合 OpenAI-compatible 流式协议".to_string(),
    }
}

fn build_ai_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化 AI 网络客户端".to_string())
}

fn send_event(
    on_event: &tauri::ipc::Channel<AiStreamEvent>,
    event: AiStreamEvent,
) -> Result<(), String> {
    on_event
        .send(event)
        .map_err(|_| "AI 事件通道已关闭".to_string())
}

fn send_http_status_error(
    status: u16,
    on_event: &tauri::ipc::Channel<AiStreamEvent>,
) -> Result<(), String> {
    let error = http_status_error(status);
    send_event(
        on_event,
        AiStreamEvent::Error {
            code: error.code.to_string(),
            message: error.message.to_string(),
        },
    )
}

async fn forward_stream<S, E>(
    mut events: S,
    mut cancel_rx: oneshot::Receiver<()>,
    on_event: &tauri::ipc::Channel<AiStreamEvent>,
) -> Result<(), String>
where
    S: Stream<Item = Result<Event, E>> + Unpin,
{
    loop {
        let event = tokio::select! {
            biased;
            _ = &mut cancel_rx => return Ok(()),
            event = events.next() => event,
        };

        let Some(event) = event else {
            send_event(on_event, protocol_error_event())?;
            return Ok(());
        };
        let Ok(event) = event else {
            send_event(on_event, protocol_error_event())?;
            return Ok(());
        };

        match parse_stream_data(&event.data) {
            Ok(StreamData::Done) => {
                send_event(on_event, AiStreamEvent::Done)?;
                return Ok(());
            }
            Ok(StreamData::Delta(Some(text))) => {
                send_event(on_event, AiStreamEvent::Delta { text })?;
            }
            Ok(StreamData::Delta(None)) => {}
            Err(()) => {
                send_event(on_event, protocol_error_event())?;
                return Ok(());
            }
        }
    }
}

fn ai_key_entry() -> Result<keyring::v1::Entry, String> {
    keyring::v1::Entry::new(AI_KEYRING_SERVICE, AI_KEYRING_USER)
        .map_err(|_| "无法访问系统凭据库".to_string())
}

fn credential_presence(result: keyring::v1::Result<String>) -> Result<bool, String> {
    match result {
        Ok(_) => Ok(true),
        Err(keyring::v1::Error::NoEntry) => Ok(false),
        Err(_) => Err("无法检查 AI API Key 配置".to_string()),
    }
}

fn credential_read_result(result: keyring::v1::Result<String>) -> Result<String, String> {
    match result {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(keyring::v1::Error::NoEntry) => Err("请先在 AI 设置中配置 API Key".to_string()),
        Err(_) => Err("无法读取 AI API Key".to_string()),
    }
}

fn credential_delete_result(result: keyring::v1::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除 AI API Key".to_string()),
    }
}

#[tauri::command]
pub(crate) fn save_ai_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("AI API Key 不能为空".to_string());
    }

    ai_key_entry()?
        .set_password(key)
        .map_err(|_| "无法保存 AI API Key".to_string())
}

#[tauri::command]
pub(crate) fn has_ai_api_key() -> Result<bool, String> {
    credential_presence(ai_key_entry()?.get_password())
}

#[tauri::command]
pub(crate) fn delete_ai_api_key() -> Result<(), String> {
    credential_delete_result(ai_key_entry()?.delete_credential())
}

fn is_parser_normalized_http_loopback(host: Host<&str>) -> bool {
    // `url` applies standard URL host canonicalization before producing `Host`.
    // Compare that typed result exactly: equivalent loopback spellings are safe,
    // while trailing-dot domains, subdomains, and mapped/non-loopback IPs stay rejected.
    matches!(
        host,
        Host::Domain("localhost")
            | Host::Ipv4(Ipv4Addr::LOCALHOST)
            | Host::Ipv6(Ipv6Addr::LOCALHOST)
    )
}

pub fn validate_base_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("AI Base URL 不能为空".to_string());
    }

    let mut url = Url::parse(value).map_err(|_| "AI Base URL 格式无效".to_string())?;
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return Err("AI Base URL 不允许包含用户名或密码".to_string());
    }
    let host = url
        .host()
        .ok_or_else(|| "AI Base URL 必须包含主机".to_string())?;

    match url.scheme() {
        "https" => {}
        "http" if is_parser_normalized_http_loopback(host) => {}
        "http" => return Err("远程 AI Base URL 必须使用 HTTPS".to_string()),
        _ => return Err("AI Base URL 仅支持 HTTP 或 HTTPS".to_string()),
    }

    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/chat/completions"));
    Ok(url)
}

fn validate_ai_request(request: &AiRequest) -> Result<Url, String> {
    let url = validate_base_url(&request.base_url)?;
    if request.model.trim().is_empty() {
        return Err("请先配置 AI 模型".to_string());
    }
    if request.instruction.trim().is_empty() {
        return Err("AI 指令不能为空".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub(crate) async fn stream_ai(
    request: AiRequest,
    on_event: tauri::ipc::Channel<AiStreamEvent>,
    state: tauri::State<'_, AiRequestState>,
) -> Result<(), String> {
    let url = validate_ai_request(&request)?;
    let body = build_chat_request(&request);
    let mut cancel_rx = state.begin_request()?;
    let api_key = credential_read_result(ai_key_entry()?.get_password())?;
    let client = build_ai_client()?;

    let response = tokio::select! {
        biased;
        _ = &mut cancel_rx => return Ok(()),
        response = client
            .post(url)
            .bearer_auth(api_key)
            .json(&body)
            .send() => response.map_err(|_| {
                "无法连接 AI 服务，请检查网络和 Base URL 后重试".to_string()
            })?,
    };

    if !response.status().is_success() {
        send_http_status_error(response.status().as_u16(), &on_event)?;
        return Ok(());
    }

    forward_stream(response.bytes_stream().eventsource(), cancel_rx, &on_event).await
}

#[tauri::command]
pub(crate) fn cancel_ai(state: tauri::State<'_, AiRequestState>) -> Result<(), String> {
    state.cancel_current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, StreamExt};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn event(data: &str) -> Event {
        Event {
            data: data.to_string(),
            ..Event::default()
        }
    }

    fn recording_channel() -> (
        tauri::ipc::Channel<AiStreamEvent>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&messages);
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                recorded.lock().unwrap().push(serde_json::from_str(&json)?);
            }
            Ok(())
        });
        (channel, messages)
    }

    fn failing_channel() -> tauri::ipc::Channel<AiStreamEvent> {
        tauri::ipc::Channel::new(|_| {
            Err(std::io::Error::other("secret channel failure detail").into())
        })
    }

    #[test]
    fn parses_openai_stream_delta_and_done_frames() {
        assert_eq!(
            parse_stream_data(r#"{"choices":[{"delta":{"content":"你"}}]}"#).unwrap(),
            StreamData::Delta(Some("你".to_string()))
        );
        assert_eq!(
            parse_stream_data(r#"{"choices":[{"delta":{}}]}"#).unwrap(),
            StreamData::Delta(None)
        );
        assert_eq!(parse_stream_data("[DONE]").unwrap(), StreamData::Done);
    }

    #[test]
    fn rejects_invalid_openai_stream_json() {
        assert!(parse_stream_data("not-json").is_err());
    }

    #[test]
    fn rejects_json_that_is_not_an_openai_stream_delta_shape() {
        for data in [
            r#"{}"#,
            r#"{"choices":[]}"#,
            r#"{"choices":[{}]}"#,
            r#"{"choices":[{"delta":{"content":1}}]}"#,
        ] {
            assert!(parse_stream_data(data).is_err(), "{data}");
        }
    }

    #[test]
    fn maps_http_statuses_to_stable_ai_error_codes() {
        for (status, code) in [
            (401, "AI_AUTH"),
            (403, "AI_AUTH"),
            (404, "AI_ENDPOINT"),
            (429, "AI_RATE_LIMIT"),
            (500, "AI_SERVER"),
            (599, "AI_SERVER"),
            (400, "AI_HTTP"),
        ] {
            assert_eq!(http_status_error(status).code, code, "{status}");
        }
    }

    fn sample_request(selection: &str) -> AiRequest {
        AiRequest {
            base_url: "https://api.example.com/v1".to_string(),
            model: "example-model".to_string(),
            document: "# 文档".to_string(),
            selection: selection.to_string(),
            instruction: "续写".to_string(),
        }
    }

    #[test]
    fn serializes_ai_stream_events_with_camel_case_tagged_variants() {
        assert_eq!(
            serde_json::to_value(AiStreamEvent::Delta {
                text: "你".to_string()
            })
            .unwrap(),
            serde_json::json!({ "type": "delta", "text": "你" })
        );
        assert_eq!(
            serde_json::to_value(AiStreamEvent::Done).unwrap(),
            serde_json::json!({ "type": "done" })
        );
        assert_eq!(
            serde_json::to_value(AiStreamEvent::Error {
                code: "AI_PROTOCOL".to_string(),
                message: "协议错误".to_string()
            })
            .unwrap(),
            serde_json::json!({
                "type": "error",
                "code": "AI_PROTOCOL",
                "message": "协议错误"
            })
        );
    }

    #[test]
    fn builds_minimal_chat_completions_body_in_required_message_order() {
        let body = serde_json::to_value(build_chat_request(&sample_request("选中文字"))).unwrap();

        assert_eq!(body["model"], "example-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][0]["content"],
            "你是 Mora 墨笺的 Markdown 写作助手。只返回要插入或替换的 Markdown，\n不要解释，不要用代码围栏包裹整个答案。"
        );
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(
            body["messages"][1]["content"],
            "指令：\n续写\n\n当前文档：\n# 文档\n\n当前选区：\n选中文字"
        );
    }

    #[test]
    fn uses_explicit_no_selection_text_in_chat_request() {
        let body = serde_json::to_value(build_chat_request(&sample_request(""))).unwrap();

        assert_eq!(
            body["messages"][1]["content"],
            "指令：\n续写\n\n当前文档：\n# 文档\n\n当前选区：\n无选区，请生成可插入光标位置的内容"
        );
    }

    #[test]
    fn validates_request_fields_before_network_access() {
        assert!(validate_ai_request(&sample_request("")).is_ok());

        let mut missing_model = sample_request("");
        missing_model.model = "  ".to_string();
        assert_eq!(
            validate_ai_request(&missing_model),
            Err("请先配置 AI 模型".to_string())
        );

        let mut missing_instruction = sample_request("");
        missing_instruction.instruction = "\n".to_string();
        assert_eq!(
            validate_ai_request(&missing_instruction),
            Err("AI 指令不能为空".to_string())
        );
    }

    #[test]
    fn new_request_cancels_old_sender_without_losing_new_sender() {
        let state = AiRequestState::default();
        let mut first = state.begin_request().unwrap();
        let mut second = state.begin_request().unwrap();

        assert_eq!(first.try_recv(), Ok(()));
        assert_eq!(second.try_recv(), Err(oneshot::error::TryRecvError::Empty));

        state.cancel_current().unwrap();
        assert_eq!(second.try_recv(), Ok(()));
        assert!(state.cancel.lock().unwrap().is_none());
    }

    #[test]
    fn cancel_without_an_active_request_is_idempotent() {
        let state = AiRequestState::default();

        state.cancel_current().unwrap();
        state.cancel_current().unwrap();

        assert!(state.cancel.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forwards_deltas_skips_empty_delta_and_finishes_on_done() {
        let input = stream::iter(vec![
            Ok::<_, ()>(event(r#"{"choices":[{"delta":{"content":"你"}}]}"#)),
            Ok(event(r#"{"choices":[{"delta":{}}]}"#)),
            Ok(event("[DONE]")),
            Ok(event(r#"{"choices":[{"delta":{"content":"不应发送"}}]}"#)),
        ]);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (channel, messages) = recording_channel();

        forward_stream(input, cancel_rx, &channel).await.unwrap();
        drop(cancel_tx);

        assert_eq!(
            *messages.lock().unwrap(),
            vec![
                serde_json::json!({ "type": "delta", "text": "你" }),
                serde_json::json!({ "type": "done" }),
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reports_invalid_json_as_protocol_error_without_failing_command() {
        let input = stream::iter(vec![Ok::<_, ()>(event("not-json"))]);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let (channel, messages) = recording_channel();

        forward_stream(input, cancel_rx, &channel).await.unwrap();

        assert_eq!(
            *messages.lock().unwrap(),
            vec![serde_json::json!({
                "type": "error",
                "code": "AI_PROTOCOL",
                "message": "AI 服务不符合 OpenAI-compatible 流式协议"
            })]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reports_sse_errors_as_protocol_errors() {
        let input = stream::iter(vec![Err::<Event, _>("broken stream")]);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let (channel, messages) = recording_channel();

        forward_stream(input, cancel_rx, &channel).await.unwrap();

        assert_eq!(messages.lock().unwrap()[0]["code"], "AI_PROTOCOL");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_stops_stream_without_emitting_an_event() {
        let input = stream::pending::<Result<Event, ()>>();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (channel, messages) = recording_channel();
        cancel_tx.send(()).unwrap();

        forward_stream(input, cancel_rx, &channel).await.unwrap();

        assert!(messages.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_wins_when_a_stream_event_is_ready_at_the_same_time() {
        for _ in 0..64 {
            let input = stream::iter(vec![Ok::<_, ()>(event(
                r#"{"choices":[{"delta":{"content":"不应发送"}}]}"#,
            ))]);
            let (cancel_tx, cancel_rx) = oneshot::channel();
            let (channel, messages) = recording_channel();
            cancel_tx.send(()).unwrap();

            forward_stream(input, cancel_rx, &channel).await.unwrap();

            assert!(messages.lock().unwrap().is_empty());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn channel_send_failure_stops_before_reading_more_stream_events() {
        let polled = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&polled);
        let input = stream::iter(vec![
            event(r#"{"choices":[{"delta":{"content":"一"}}]}"#),
            event(r#"{"choices":[{"delta":{"content":"二"}}]}"#),
        ])
        .map(move |item| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, ()>(item)
        });
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let channel = failing_channel();

        let error = forward_stream(input, cancel_rx, &channel)
            .await
            .unwrap_err();

        assert_eq!(polled.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(error, "AI 事件通道已关闭");
        assert!(!error.contains("secret channel failure detail"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn done_channel_failure_rejects_the_command_with_a_stable_error() {
        let input = stream::iter(vec![Ok::<_, ()>(event("[DONE]"))]);
        let (_cancel_tx, cancel_rx) = oneshot::channel();

        let error = forward_stream(input, cancel_rx, &failing_channel())
            .await
            .unwrap_err();

        assert_eq!(error, "AI 事件通道已关闭");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn protocol_error_channel_failure_rejects_the_command() {
        for input in ["not-json", ""] {
            let events = if input.is_empty() {
                Vec::new()
            } else {
                vec![Ok::<_, ()>(event(input))]
            };
            let (_cancel_tx, cancel_rx) = oneshot::channel();

            let error = forward_stream(stream::iter(events), cancel_rx, &failing_channel())
                .await
                .unwrap_err();

            assert_eq!(error, "AI 事件通道已关闭");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sse_error_channel_failure_rejects_the_command() {
        let input = stream::iter(vec![Err::<Event, _>("secret stream failure detail")]);
        let (_cancel_tx, cancel_rx) = oneshot::channel();

        let error = forward_stream(input, cancel_rx, &failing_channel())
            .await
            .unwrap_err();

        assert_eq!(error, "AI 事件通道已关闭");
        assert!(!error.contains("secret stream failure detail"));
    }

    #[test]
    fn http_status_error_channel_failure_rejects_the_command() {
        let error = send_http_status_error(401, &failing_channel()).unwrap_err();

        assert_eq!(error, "AI 事件通道已关闭");
        assert!(!error.contains("secret channel failure detail"));
    }

    #[test]
    fn http_status_error_successfully_sent_keeps_command_successful() {
        let (channel, messages) = recording_channel();

        send_http_status_error(429, &channel).unwrap();

        assert_eq!(
            *messages.lock().unwrap(),
            vec![serde_json::json!({
                "type": "error",
                "code": "AI_RATE_LIMIT",
                "message": "AI 请求频率或额度受限"
            })]
        );
    }

    async fn assert_redirect_is_not_followed(status: u16) {
        let target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        target.set_nonblocking(true).unwrap();
        let target_url = format!("http://{}/private", target.local_addr().unwrap());

        let redirect = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let redirect_url = format!(
            "http://{}/v1/chat/completions",
            redirect.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut socket, _) = redirect.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 {status} Redirect\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });

        let response = build_ai_client()
            .unwrap()
            .post(redirect_url)
            .send()
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status().as_u16(), status);
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "{status} redirect target must not be visited"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ai_client_does_not_follow_307_or_308_redirects() {
        assert_redirect_is_not_followed(307).await;
        assert_redirect_is_not_followed(308).await;
    }

    #[test]
    fn accepts_https_and_local_http() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert_eq!(
            validate_base_url("http://LOCALHOST:11434/v1")
                .unwrap()
                .as_str(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert!(validate_base_url("http://127.0.0.1:1234/v1").is_ok());
        assert!(validate_base_url("http://[::1]:1234/v1").is_ok());
    }

    #[test]
    fn accepts_parser_normalized_ipv4_loopback_spellings() {
        for value in [
            "http://127.1/v1",
            "http://2130706433/v1",
            "http://0x7f000001/v1",
            "http://0177.0.0.1/v1",
        ] {
            assert_eq!(
                validate_base_url(value).unwrap().host_str(),
                Some("127.0.0.1"),
                "{value}"
            );
        }
    }

    #[test]
    fn accepts_expanded_ipv6_loopback() {
        let url = validate_base_url("http://[0:0:0:0:0:0:0:1]:11434/v1").unwrap();

        assert_eq!(url.host_str(), Some("[::1]"));
    }

    #[test]
    fn rejects_deceptive_or_non_loopback_http_hosts() {
        for value in [
            "http://localhost./v1",
            "http://evil.localhost/v1",
            "http://127.0.0.2/v1",
            "http://[::2]/v1",
            "http://[::ffff:127.0.0.1]/v1",
        ] {
            assert_eq!(
                validate_base_url(value),
                Err("远程 AI Base URL 必须使用 HTTPS".to_string()),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_non_empty_userinfo_for_every_supported_scheme_without_leaking_it() {
        for value in [
            "https://alice@api.openai.com/v1",
            "https://alice:secret-value@api.openai.com/v1",
            "https://:secret-value@api.openai.com/v1",
            "http://alice:secret-value@localhost:11434/v1",
        ] {
            let error = validate_base_url(value).unwrap_err();

            assert_eq!(error, "AI Base URL 不允许包含用户名或密码", "{value}");
            assert!(!error.contains("alice"));
            assert!(!error.contains("secret-value"));
        }
    }

    #[test]
    fn rejects_empty_host_remote_http_and_non_http_schemes() {
        assert!(validate_base_url("   ").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("file:///tmp/api").is_err());
    }

    #[test]
    fn normalizes_chat_completions_path_and_removes_query_and_fragment() {
        let url =
            validate_base_url(" https://api.openai.com/v1/?organization=secret#fragment ").unwrap();

        assert_eq!(url.as_str(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);

        assert_eq!(
            validate_base_url("https://api.openai.com")
                .unwrap()
                .as_str(),
            "https://api.openai.com/chat/completions"
        );
        assert_eq!(
            validate_base_url("https://api.openai.com/custom/path///?q=1#section")
                .unwrap()
                .as_str(),
            "https://api.openai.com/custom/path/chat/completions"
        );
    }

    #[test]
    fn no_entry_is_the_only_missing_credential_result() {
        assert_eq!(
            credential_presence(Err(keyring::v1::Error::NoEntry)),
            Ok(false)
        );
        assert_eq!(
            credential_presence(Ok("stored-secret".to_string())),
            Ok(true)
        );
        assert!(credential_presence(Err(keyring::v1::Error::BadEncoding(vec![1]))).is_err());
    }

    #[test]
    fn deleting_an_absent_credential_succeeds() {
        assert_eq!(
            credential_delete_result(Err(keyring::v1::Error::NoEntry)),
            Ok(())
        );
        assert_eq!(credential_delete_result(Ok(())), Ok(()));
    }

    #[test]
    fn credential_errors_do_not_expose_secret_material() {
        let secret = "sk-do-not-leak";
        let error = credential_presence(Err(keyring::v1::Error::BadEncoding(
            secret.as_bytes().to_vec(),
        )))
        .unwrap_err();

        assert!(!error.contains(secret));
    }

    #[test]
    fn api_key_read_errors_are_stable_and_do_not_expose_secret_material() {
        assert_eq!(
            credential_read_result(Err(keyring::v1::Error::NoEntry)),
            Err("请先在 AI 设置中配置 API Key".to_string())
        );
        let secret = "sk-do-not-leak";
        let error = credential_read_result(Err(keyring::v1::Error::BadEncoding(
            secret.as_bytes().to_vec(),
        )))
        .unwrap_err();

        assert_eq!(error, "无法读取 AI API Key");
        assert!(!error.contains(secret));
    }

    #[test]
    fn empty_api_key_read_from_keyring_is_treated_as_not_configured() {
        assert_eq!(
            credential_read_result(Ok(" \n ".to_string())),
            Err("请先在 AI 设置中配置 API Key".to_string())
        );
    }

    #[test]
    fn saving_an_empty_key_is_rejected_before_accessing_the_keyring() {
        assert_eq!(
            save_ai_api_key("  \n ".to_string()),
            Err("AI API Key 不能为空".to_string())
        );
    }

    #[test]
    fn request_state_starts_without_a_cancellation_sender() {
        let state = AiRequestState::default();

        assert!(state.cancel.lock().unwrap().is_none());
    }
}
