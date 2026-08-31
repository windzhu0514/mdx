use crate::agent_ipc::{
    connect, endpoint_is_live, ipc_error, read_server_message, write_request,
    AgentEndpointDescriptor, EndpointRegistry,
};
use crate::agent_protocol::{
    AgentDocumentEvent, AgentError, AgentRequest, AgentRequestKind, AgentResult,
    AgentServerMessage, MORA_NOT_RUNNING, PROTOCOL_MISMATCH, PROTOCOL_VERSION, REQUEST_TIMEOUT,
};
use futures_util::Stream;
use std::pin::Pin;
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
        let descriptor = registry
            .read()
            .map_err(|_| ipc_error(MORA_NOT_RUNNING, "The Mora Agent bridge is not running."))?;
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
        if descriptor.protocol_version != PROTOCOL_VERSION {
            return Err(ipc_error(
                PROTOCOL_MISMATCH,
                "The Mora Agent endpoint uses an unsupported protocol version.",
            ));
        }
        Ok(Self {
            descriptor: descriptor.clone(),
        })
    }

    pub async fn request(&self, request: AgentRequestKind) -> Result<AgentResult, AgentError> {
        let mut stream = connect(&self.descriptor).await?;
        let request_id = Uuid::new_v4().to_string();
        let request = AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            request,
        };
        tokio::time::timeout(REQUEST_TIMEOUT, write_request(&mut stream, &request))
            .await
            .map_err(|_| {
                ipc_error(
                    crate::agent_protocol::TIMEOUT,
                    "The Agent request timed out.",
                )
            })??;
        let message = tokio::time::timeout(REQUEST_TIMEOUT, read_server_message(&mut stream))
            .await
            .map_err(|_| {
                ipc_error(
                    crate::agent_protocol::TIMEOUT,
                    "The Agent request timed out.",
                )
            })??;
        response_result(message, &request_id)
    }

    pub async fn watch(&self, document_id: Option<String>) -> Result<AgentEventStream, AgentError> {
        let mut stream = connect(&self.descriptor).await?;
        let request_id = Uuid::new_v4().to_string();
        let request = AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            request: AgentRequestKind::Watch { document_id },
        };
        tokio::time::timeout(REQUEST_TIMEOUT, write_request(&mut stream, &request))
            .await
            .map_err(|_| {
                ipc_error(
                    crate::agent_protocol::TIMEOUT,
                    "The Agent watch request timed out.",
                )
            })??;
        let acknowledgement =
            tokio::time::timeout(REQUEST_TIMEOUT, read_server_message(&mut stream))
                .await
                .map_err(|_| {
                    ipc_error(
                        crate::agent_protocol::TIMEOUT,
                        "The Agent watch request timed out.",
                    )
                })??;
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
    use super::response_result;
    use crate::agent_protocol::{AgentError, AgentResponse, AgentServerMessage, PROTOCOL_MISMATCH};

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
}
