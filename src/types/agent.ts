import type { MdxMetadata } from "./mdx";
import type { DiskRevision } from "./workspace";

export const AGENT_ERROR_CODES = [
    "AGENT_ACCESS_DISABLED",
    "MORA_NOT_RUNNING",
    "BRIDGE_UNAVAILABLE",
    "BRIDGE_ALREADY_RUNNING",
    "DOCUMENT_NOT_FOUND",
    "DOCUMENT_NOT_OPEN",
    "DOCUMENT_BUSY",
    "SAVE_AS_REQUIRED",
    "REVISION_CONFLICT",
    "DISK_CONFLICT",
    "INVALID_MDX",
    "REQUEST_TOO_LARGE",
    "PERMISSION_DENIED",
    "TIMEOUT",
    "PROTOCOL_MISMATCH",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export type AgentDocumentChangeSource = "editor" | "agent" | "disk";

export type AgentDocumentSummary = {
    id: string;
    path: string | null;
    title: string;
    dirty: boolean;
    conflict: boolean;
    unavailable: boolean;
    liveRevision: string;
    diskRevision: DiskRevision | null;
};

export type AgentDocumentSnapshot = AgentDocumentSummary & {
    content: string;
    meta: MdxMetadata | null;
};

export type AgentMutationResult = AgentDocumentSummary;

export type AgentBridgeStatus = {
    enabled: boolean;
    listening: boolean;
    connectedClients: number;
    watcherClients: number;
    cliPath: string | null;
    protocolVersion: 1;
    lastError: string | null;
};

export type AgentDocumentEvent = {
    documentId: string;
    liveRevision: string;
    dirty: boolean;
    source: AgentDocumentChangeSource;
};

export type AgentFrontendRequest =
    | {
          requestId: string;
          method: "listDocuments";
          params: Record<string, never>;
      }
    | {
          requestId: string;
          method: "readDocument";
          params: { documentId: string };
      }
    | {
          requestId: string;
          method: "replaceDocument";
          params: {
              documentId: string;
              baseLiveRevision: string;
              content: string;
          };
      }
    | {
          requestId: string;
          method: "saveDocument";
          params: { documentId: string; baseLiveRevision: string };
      };

export type AgentFrontendError = {
    code: AgentErrorCode;
    message: string;
    detail?: Record<string, unknown>;
};

export type AgentFrontendResponse =
    | {
          requestId: string;
          result: AgentDocumentSummary[] | AgentDocumentSnapshot | AgentMutationResult;
          error?: never;
      }
    | {
          requestId: string;
          error: AgentFrontendError;
          result?: never;
      };
