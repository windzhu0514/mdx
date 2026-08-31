use crate::agent_ipc::{
    connect_until, endpoint_is_live, ipc_error, read_server_message, write_request,
    AgentEndpointDescriptor, EndpointRegistry,
};
use crate::agent_protocol::{
    AgentDocumentEvent, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AgentServerMessage, MORA_NOT_RUNNING, PROTOCOL_MISMATCH, PROTOCOL_VERSION, REQUEST_TIMEOUT,
};
use futures_util::Stream;
use std::future::Future;
use std::pin::Pin;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;
use uuid::Uuid;

pub type AgentEventStream =
    Pin<Box<dyn Stream<Item = Result<AgentDocumentEvent, AgentError>> + Send + 'static>>;

#[derive(Debug, Clone)]
pub struct AgentClient {
    descriptor: AgentEndpointDescriptor,
}

impl AgentClient {
    pub async fn connect() -> Result<Self, AgentError> {
        let registry = EndpointRegistry::for_current_user()?;
        Self::connect_with_registry(registry).await
    }

    pub async fn connect_with_registry(registry: EndpointRegistry) -> Result<Self, AgentError> {
        let descriptor = registry.read_for_client()?;
        let client = Self::connect_to(&descriptor).await?;
        if !endpoint_is_live(&client.descriptor).await {
            return Err(ipc_error(
                MORA_NOT_RUNNING,
                "The Mora Agent bridge is not running.",
            ));
        }
        Ok(client)
    }

    pub async fn connect_to(descriptor: &AgentEndpointDescriptor) -> Result<Self, AgentError> {
        EndpointRegistry::at(descriptor.registry_path().to_path_buf())
            .validate_descriptor(descriptor)?;
        Ok(Self {
            descriptor: descriptor.clone(),
        })
    }

    pub async fn request(&self, request: AgentRequestKind) -> Result<AgentResult, AgentError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let stream = connect_until(&self.descriptor, deadline).await?;
        request_over_stream_until(stream, request, deadline).await
    }

    pub async fn watch(&self, document_id: Option<String>) -> Result<AgentEventStream, AgentError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let mut stream = connect_until(&self.descriptor, deadline).await?;
        let request_id = Uuid::new_v4().to_string();
        let request = AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            request: AgentRequestKind::Watch { document_id },
        };
        client_phase(
            deadline,
            write_request(&mut stream, &request),
            "The Agent watch request timed out.",
        )
        .await?;
        let acknowledgement = client_phase(
            deadline,
            read_server_message(&mut stream),
            "The Agent watch request timed out.",
        )
        .await?;
        response_result(acknowledgement, &request_id)?;

        let stream =
            futures_util::stream::unfold((Some(stream), false), |(stream, finished)| async move {
                if finished {
                    return None;
                }
                let mut stream = stream?;
                match read_server_message(&mut stream).await {
                    Ok(AgentServerMessage::Event { event }) => {
                        Some((Ok(event), (Some(stream), false)))
                    }
                    Ok(AgentServerMessage::Response { .. }) => Some((
                        Err(ipc_error(
                            PROTOCOL_MISMATCH,
                            "The Agent watch stream contained an unexpected response.",
                        )),
                        (None, true),
                    )),
                    Err(error) => Some((Err(error), (None, true))),
                }
            });
        Ok(Box::pin(stream))
    }
}

async fn request_over_stream_until<S>(
    mut stream: S,
    request: AgentRequestKind,
    deadline: Instant,
) -> Result<AgentResult, AgentError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request_id = Uuid::new_v4().to_string();
    let request = AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        request,
    };
    client_phase(
        deadline,
        write_request(&mut stream, &request),
        "The Agent request timed out.",
    )
    .await?;
    let message = client_phase(
        deadline,
        read_server_message(&mut stream),
        "The Agent request timed out.",
    )
    .await?;
    response_result(message, &request_id)
}

async fn client_phase<T, F>(
    deadline: Instant,
    future: F,
    timeout_message: &'static str,
) -> Result<T, AgentError>
where
    F: Future<Output = Result<T, AgentError>>,
{
    tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| ipc_error(crate::agent_protocol::TIMEOUT, timeout_message))?
}

fn response_result(
    message: AgentServerMessage,
    expected_request_id: &str,
) -> Result<AgentResult, AgentError> {
    let AgentServerMessage::Response { response } = message else {
        return Err(ipc_error(
            PROTOCOL_MISMATCH,
            "The Agent request received an event instead of a response.",
        ));
    };
    if response.protocol_version != PROTOCOL_VERSION || response.request_id != expected_request_id {
        return Err(ipc_error(
            PROTOCOL_MISMATCH,
            "The Agent response does not match the request.",
        ));
    }
    match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => Err(ipc_error(
            PROTOCOL_MISMATCH,
            "The Agent response must contain exactly one result or error.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{request_over_stream_until, response_result};
    use crate::agent_protocol::{
        encode_frame, AgentError, AgentRequest, AgentRequestKind, AgentResponse,
        AgentServerMessage, PROTOCOL_MISMATCH, TIMEOUT,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::{Duration, Instant};

    #[test]
    fn response_request_id_must_match_the_request() {
        let message = AgentServerMessage::Response {
            response: AgentResponse::failure(
                "different-request",
                AgentError::new("DOCUMENT_BUSY", "Document is busy."),
            ),
        };

        let error = response_result(message, "expected-request").unwrap_err();

        assert_eq!(error.code, PROTOCOL_MISMATCH);
    }

    #[tokio::test]
    async fn request_uses_one_deadline_across_write_and_response() {
        let (client_stream, mut server_stream) = tokio::io::duplex(1024);
        let server = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            let mut prefix = [0_u8; 4];
            server_stream.read_exact(&mut prefix).await.unwrap();
            let length = u32::from_be_bytes(prefix) as usize;
            let mut payload = vec![0_u8; length];
            server_stream.read_exact(&mut payload).await.unwrap();
            let request: AgentRequest = serde_json::from_slice(&payload).unwrap();

            tokio::time::sleep(Duration::from_millis(35)).await;
            let response = AgentServerMessage::Response {
                response: AgentResponse::failure(
                    request.request_id,
                    AgentError::new("DOCUMENT_BUSY", "Document is busy."),
                ),
            };
            let payload = serde_json::to_vec(&response).unwrap();
            let frame = encode_frame(&payload).unwrap();
            let _ = server_stream.write_all(&frame).await;
        });

        let error = request_over_stream_until(
            client_stream,
            AgentRequestKind::Status,
            Instant::now() + Duration::from_millis(50),
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, TIMEOUT);
        server.await.unwrap();
    }
}
