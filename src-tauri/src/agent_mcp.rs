use crate::agent_client::AgentClient;
use crate::agent_protocol::{
    AgentError, AgentRequestKind, AgentResult, BRIDGE_UNAVAILABLE, MORA_NOT_RUNNING,
    PROTOCOL_MISMATCH,
};
use rmcp::{
    handler::server::{tool::ToolCallContext, wrapper::Parameters},
    model::{CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock},
    schemars,
    service::{RequestContext, ServerInitializeError},
    tool, tool_router, RoleServer, ServiceExt,
};
use serde::{de::DeserializeOwned, Deserialize};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadDocumentArgs {
    pub document_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReplaceDocumentArgs {
    pub document_id: String,
    pub base_live_revision: String,
    pub content: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SaveDocumentArgs {
    pub document_id: String,
    pub base_live_revision: String,
}

#[derive(Debug, Clone)]
pub struct MoraMcpServer {
    client: AgentClient,
}

impl MoraMcpServer {
    pub fn new(client: AgentClient) -> Self {
        Self { client }
    }

    async fn request(&self, request: AgentRequestKind) -> CallToolResult {
        match self.client.request(request).await {
            Ok(result) => success_result(result),
            Err(error) => operational_error(error),
        }
    }
}

#[tool_router]
impl MoraMcpServer {
    #[tool(
        name = "mora_list_documents",
        description = "List the documents currently open in Mora."
    )]
    async fn list_documents(&self) -> CallToolResult {
        self.request(AgentRequestKind::ListDocuments).await
    }

    #[tool(
        name = "mora_read_document",
        description = "Read one open Mora document and its current live revision."
    )]
    async fn read_document(
        &self,
        Parameters(ReadDocumentArgs { document_id }): Parameters<ReadDocumentArgs>,
    ) -> CallToolResult {
        self.request(AgentRequestKind::ReadDocument { document_id })
            .await
    }

    #[tool(
        name = "mora_replace_document",
        description = "Replace an open Mora document only when base_live_revision still matches."
    )]
    async fn replace_document(
        &self,
        Parameters(ReplaceDocumentArgs {
            document_id,
            base_live_revision,
            content,
        }): Parameters<ReplaceDocumentArgs>,
    ) -> CallToolResult {
        self.request(AgentRequestKind::ReplaceDocument {
            document_id,
            base_live_revision,
            content,
        })
        .await
    }

    #[tool(
        name = "mora_save_document",
        description = "Explicitly save an open Mora document only when base_live_revision still matches."
    )]
    async fn save_document(
        &self,
        Parameters(SaveDocumentArgs {
            document_id,
            base_live_revision,
        }): Parameters<SaveDocumentArgs>,
    ) -> CallToolResult {
        self.request(AgentRequestKind::SaveDocument {
            document_id,
            base_live_revision,
        })
        .await
    }
}

#[rmcp::tool_handler(router = Self::tool_router())]
impl rmcp::ServerHandler for MoraMcpServer {
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        match request.name.as_ref() {
            "mora_read_document" => validate_arguments::<ReadDocumentArgs>(&request)?,
            "mora_replace_document" => validate_arguments::<ReplaceDocumentArgs>(&request)?,
            "mora_save_document" => validate_arguments::<SaveDocumentArgs>(&request)?,
            _ => {}
        }

        Self::tool_router()
            .call(ToolCallContext::new(self, request, context))
            .await
    }
}

fn validate_arguments<T: DeserializeOwned>(
    request: &CallToolRequestParams,
) -> Result<(), rmcp::ErrorData> {
    rmcp::handler::server::tool::parse_json_object::<T>(
        request.arguments.clone().unwrap_or_default(),
    )?;
    Ok(())
}

fn success_result(result: AgentResult) -> CallToolResult {
    match serde_json::to_string(&result) {
        Ok(json) => CallToolResult::success(vec![ContentBlock::text(json)]),
        Err(_) => encoding_error(),
    }
}

fn operational_error(error: AgentError) -> CallToolResult {
    let error = if error.code == MORA_NOT_RUNNING {
        AgentError::new(
            BRIDGE_UNAVAILABLE,
            "The Mora Agent bridge is temporarily unavailable.",
        )
    } else {
        error
    };
    match serde_json::to_string(&error) {
        Ok(json) => CallToolResult::error(vec![ContentBlock::text(json)]),
        Err(_) => encoding_error(),
    }
}

fn encoding_error() -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        r#"{"code":"PROTOCOL_MISMATCH","message":"Could not encode the Mora Agent result."}"#,
    )])
}

pub async fn run_mcp() -> Result<(), AgentError> {
    let client = AgentClient::connect().await?;
    let service = match MoraMcpServer::new(client)
        .serve(rmcp::transport::stdio())
        .await
    {
        Ok(service) => service,
        Err(ServerInitializeError::ConnectionClosed(_) | ServerInitializeError::Cancelled) => {
            return Ok(())
        }
        Err(error) => return Err(AgentError::from_mcp(error)),
    };
    service.waiting().await.map_err(|_| {
        AgentError::new(
            BRIDGE_UNAVAILABLE,
            "The MCP stdio service ended unexpectedly.",
        )
    })?;
    Ok(())
}

impl AgentError {
    fn from_mcp(error: ServerInitializeError) -> Self {
        match error {
            ServerInitializeError::ExpectedInitializeRequest(_)
            | ServerInitializeError::UnexpectedInitializeResponse(_)
            | ServerInitializeError::InitializeFailed(_) => AgentError::new(
                PROTOCOL_MISMATCH,
                "The MCP client did not complete a valid initialization handshake.",
            ),
            _ => AgentError::new(
                BRIDGE_UNAVAILABLE,
                "The MCP stdio service ended unexpectedly.",
            ),
        }
    }
}
