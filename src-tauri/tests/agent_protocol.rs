use mdxnote_lib::agent_protocol::{
    decode_frame, encode_frame, AgentChangeSource, AgentDocumentEvent, AgentDocumentSnapshot,
    AgentDocumentSummary, AgentError, AgentRequest, AgentRequestKind, AgentResponse, AgentResult,
    AgentServerMessage, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};

#[test]
fn replace_request_uses_versioned_camel_case_wire_shape() {
    let request = AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: "req-1".into(),
        request: AgentRequestKind::ReplaceDocument {
            document_id: "doc-1".into(),
            base_live_revision: "session:4".into(),
            content: "# changed\n".into(),
        },
    };

    let value = serde_json::to_value(request).unwrap();

    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["requestId"], "req-1");
    assert_eq!(value["method"], "replaceDocument");
    assert_eq!(value["params"]["baseLiveRevision"], "session:4");
}

#[test]
fn frame_codec_round_trips_and_rejects_oversized_payloads() {
    let bytes = encode_frame(br#"{\"ok\":true}"#).unwrap();

    assert_eq!(decode_frame(&bytes).unwrap(), br#"{\"ok\":true}"#);
    assert_eq!(
        encode_frame(&vec![0; MAX_FRAME_BYTES + 1])
            .unwrap_err()
            .code,
        "REQUEST_TOO_LARGE"
    );
}

#[test]
fn stable_error_never_serializes_document_content() {
    let error = AgentError::new("REVISION_CONFLICT", "文档已变化")
        .with_detail(serde_json::json!({ "currentLiveRevision": "session:5" }));
    let text = serde_json::to_string(&error).unwrap();

    assert!(text.contains("REVISION_CONFLICT"));
    assert!(!text.contains("content"));
}

#[test]
fn server_messages_use_the_stable_response_and_event_shapes() {
    let summary = AgentDocumentSummary {
        id: "doc-1".into(),
        path: None,
        title: "Untitled".into(),
        dirty: true,
        conflict: false,
        unavailable: false,
        live_revision: "session:6".into(),
        disk_revision: None,
    };
    let response = AgentServerMessage::Response {
        response: AgentResponse::success(
            "req-1",
            AgentResult::Document(AgentDocumentSnapshot {
                summary,
                content: "unsaved content".into(),
                meta: None,
            }),
        ),
    };
    let event = AgentServerMessage::Event {
        event: AgentDocumentEvent {
            document_id: "doc-1".into(),
            live_revision: "session:6".into(),
            dirty: true,
            source: AgentChangeSource::Agent,
        },
    };

    let response = serde_json::to_value(response).unwrap();
    let event = serde_json::to_value(event).unwrap();

    assert_eq!(response["type"], "response");
    assert_eq!(response["result"]["content"], "unsaved content");
    assert_eq!(event["type"], "event");
    assert_eq!(event["source"], "agent");
}
