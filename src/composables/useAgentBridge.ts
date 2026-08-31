import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readonly, ref, watch, type Ref } from "vue";

import type {
    AgentBridgeStatus,
    AgentDocumentEvent,
    AgentDocumentSnapshot,
    AgentDocumentSummary,
    AgentErrorCode,
    AgentFrontendError,
    AgentFrontendRequest,
    AgentFrontendResponse,
} from "../types/agent";
import type { OpenDocument } from "./useDocumentSession";
import { useDocumentSession } from "./useDocumentSession";

export type AgentBridgeOptions = {
    desktop: boolean;
    enabled: Readonly<Ref<boolean>>;
    session: ReturnType<typeof useDocumentSession>;
    saveDocument(id: string, baseLiveRevision: string): Promise<OpenDocument>;
    onMutation(documentId: string): void;
};

const DISABLED_STATUS: AgentBridgeStatus = {
    enabled: false,
    listening: false,
    connectedClients: 0,
    watcherClients: 0,
    cliPath: null,
    protocolVersion: 1,
    lastError: null,
};

const ERROR_CODES = new Set<AgentErrorCode>([
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
]);

function summary(document: OpenDocument): AgentDocumentSummary {
    return {
        id: document.id,
        path: document.path,
        title: document.displayName,
        dirty: document.dirty,
        conflict: document.conflict,
        unavailable: document.unavailable,
        liveRevision: document.liveRevision,
        diskRevision: document.diskRevision,
    };
}

function snapshot(document: OpenDocument): AgentDocumentSnapshot {
    return {
        ...summary(document),
        content: document.content,
        meta: document.meta,
    };
}

function errorRecord(error: unknown): Record<string, unknown> | null {
    return typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : null;
}

function bridgeErrorMessage(error: unknown): string {
    const record = errorRecord(error);
    return typeof record?.message === "string"
        ? record.message
        : "本地 Agent bridge 无法启动。请关闭接入后重试。";
}

function frontendError(error: unknown, documentId?: string): AgentFrontendError {
    const record = errorRecord(error);
    const rawCode = typeof record?.code === "string" ? record.code : "";
    const code: AgentErrorCode =
        rawCode === "EXTERNAL_CONFLICT"
            ? "DISK_CONFLICT"
            : ERROR_CODES.has(rawCode as AgentErrorCode)
              ? (rawCode as AgentErrorCode)
              : error instanceof Error && error.message.startsWith("Unknown document:")
                ? "DOCUMENT_NOT_OPEN"
                : "BRIDGE_UNAVAILABLE";
    const detail: Record<string, unknown> = {};
    const stableDocumentId =
        documentId ?? (typeof record?.documentId === "string" ? record.documentId : null);
    if (stableDocumentId) detail.documentId = stableDocumentId;
    if (typeof record?.currentLiveRevision === "string") {
        detail.currentLiveRevision = record.currentLiveRevision;
    }
    if (record?.currentDiskRevision !== undefined) {
        detail.currentDiskRevision = record.currentDiskRevision;
    }
    const messages: Record<AgentErrorCode, string> = {
        AGENT_ACCESS_DISABLED: "本地 Agent 接入已关闭。",
        MORA_NOT_RUNNING: "Mora 未运行。",
        BRIDGE_UNAVAILABLE: "Mora 无法完成此 Agent 请求。",
        BRIDGE_ALREADY_RUNNING: "本地 Agent bridge 已在运行。",
        DOCUMENT_NOT_FOUND: "未找到指定文档。",
        DOCUMENT_NOT_OPEN: "指定文档当前未打开。",
        DOCUMENT_BUSY: "文档正在执行另一项保存操作。",
        SAVE_AS_REQUIRED: "该文档必须先在 Mora 中另存为 .mdx。",
        REVISION_CONFLICT: "文档已变化，请基于最新 liveRevision 重试。",
        DISK_CONFLICT: "磁盘文件已变化，请先在 Mora 中处理冲突。",
        INVALID_MDX: "文档不是有效的 MDXNote 文件。",
        REQUEST_TOO_LARGE: "Agent 请求超过大小限制。",
        PERMISSION_DENIED: "Agent 请求没有访问权限。",
        TIMEOUT: "Agent 请求处理超时。",
        PROTOCOL_MISMATCH: "Agent 请求协议不受支持。",
    };
    return {
        code,
        message: messages[code],
        ...(Object.keys(detail).length ? { detail } : {}),
    };
}

export function useAgentBridge(options: AgentBridgeOptions) {
    const status = ref<AgentBridgeStatus>({ ...DISABLED_STATUS });
    const pendingEvents = new Map<string, AgentDocumentEvent>();
    let publishDelay: AbortController | null = null;
    let requestUnlisten: UnlistenFn | null = null;
    let statusUnlisten: UnlistenFn | null = null;
    let disposed = false;
    let startedBridge = false;
    let startRequested = false;
    let operationTail = Promise.resolve();

    function document(documentId: string) {
        return options.session.document(documentId);
    }

    async function handleRequest(request: AgentFrontendRequest): Promise<void> {
        let response: AgentFrontendResponse;
        try {
            if (request.method === "listDocuments") {
                response = {
                    requestId: request.requestId,
                    result: options.session.documents.value.map(summary),
                };
            } else if (request.method === "readDocument") {
                response = {
                    requestId: request.requestId,
                    result: snapshot(document(request.params.documentId)),
                };
            } else if (request.method === "replaceDocument") {
                const runtime = options.session.replaceContent(
                    request.params.documentId,
                    request.params.content,
                    request.params.baseLiveRevision,
                );
                options.onMutation(runtime.id);
                response = { requestId: request.requestId, result: summary(runtime) };
            } else if (request.method === "saveDocument") {
                options.session.assertLiveRevision(
                    request.params.documentId,
                    request.params.baseLiveRevision,
                );
                const runtime = await options.saveDocument(
                    request.params.documentId,
                    request.params.baseLiveRevision,
                );
                response = { requestId: request.requestId, result: summary(runtime) };
            } else {
                response = {
                    requestId: (request as { requestId: string }).requestId,
                    error: frontendError({ code: "PROTOCOL_MISMATCH" }),
                };
            }
        } catch (error) {
            const documentId =
                "params" in request &&
                typeof request.params === "object" &&
                request.params !== null &&
                "documentId" in request.params &&
                typeof request.params.documentId === "string"
                    ? request.params.documentId
                    : undefined;
            response = {
                requestId: request.requestId,
                error: frontendError(error, documentId),
            };
        }
        await invoke("complete_agent_request", { response });
    }

    function clearPublishDelay() {
        publishDelay?.abort();
        publishDelay = null;
    }

    async function flushDocumentEvents() {
        if (disposed || !status.value.listening || pendingEvents.size === 0) return;
        const events = Array.from(pendingEvents.values());
        pendingEvents.clear();
        try {
            await invoke("publish_agent_document_events", { events });
        } catch (error) {
            status.value = { ...status.value, lastError: bridgeErrorMessage(error) };
        }
    }

    function queueDocumentEvents() {
        if (!status.value.listening) return;
        for (const runtime of options.session.documents.value) {
            pendingEvents.set(runtime.id, {
                documentId: runtime.id,
                liveRevision: runtime.liveRevision,
                dirty: runtime.dirty,
                source: runtime.changeSource,
            });
        }
        if (pendingEvents.size > 0 && publishDelay === null) {
            const delay = new AbortController();
            publishDelay = delay;
            AbortSignal.timeout(100).addEventListener(
                "abort",
                () => {
                    if (delay.signal.aborted) return;
                    publishDelay = null;
                    void flushDocumentEvents();
                },
                { once: true },
            );
        }
    }

    async function syncEnabled(enabled: boolean) {
        if (disposed) return;
        if (enabled) startRequested = true;
        if (!enabled) {
            startRequested = false;
            clearPublishDelay();
            pendingEvents.clear();
        }
        try {
            const next = await invoke<AgentBridgeStatus>("set_agent_access_enabled", {
                enabled,
            });
            if (disposed) return;
            status.value = next;
            startedBridge = enabled && next.enabled;
            startRequested = false;
            if (next.listening) queueDocumentEvents();
        } catch (error) {
            if (disposed) return;
            startedBridge = false;
            startRequested = false;
            status.value = {
                ...status.value,
                enabled: false,
                listening: false,
                connectedClients: 0,
                watcherClients: 0,
                lastError: bridgeErrorMessage(error),
            };
        }
    }

    async function initialize(): Promise<boolean> {
        if (!options.desktop) return false;
        let unlistenRequest: UnlistenFn | null = null;
        let unlistenStatus: UnlistenFn | null = null;
        try {
            unlistenRequest = await listen<AgentFrontendRequest>(
                "mora://agent-request",
                async (event) => {
                    try {
                        await handleRequest(event.payload);
                    } catch {
                        // The bridge may have been disabled while completing the request.
                    }
                },
            );
            unlistenStatus = await listen<AgentBridgeStatus>(
                "mora://agent-status",
                (event) => {
                    status.value = event.payload;
                    if (event.payload.listening) {
                        queueDocumentEvents();
                    } else {
                        clearPublishDelay();
                        pendingEvents.clear();
                    }
                },
            );
            const initialStatus = await invoke<AgentBridgeStatus>(
                "get_agent_bridge_status",
            );
            if (disposed) {
                unlistenRequest();
                unlistenStatus();
                return false;
            }
            requestUnlisten = unlistenRequest;
            statusUnlisten = unlistenStatus;
            status.value = initialStatus;
            return true;
        } catch (error) {
            unlistenRequest?.();
            unlistenStatus?.();
            status.value = {
                ...DISABLED_STATUS,
                lastError: bridgeErrorMessage(error),
            };
            return false;
        }
    }

    const ready = initialize();

    const stopEnabledWatch = watch(
        options.enabled,
        (enabled) => {
            operationTail = operationTail
                .then(() => ready)
                .then((initialized) => (initialized ? syncEnabled(enabled) : undefined))
                .catch((error: unknown) => {
                    if (!disposed) {
                        status.value = {
                            ...status.value,
                            enabled: false,
                            listening: false,
                            lastError: bridgeErrorMessage(error),
                        };
                    }
                });
        },
        { immediate: options.desktop },
    );

    const stopDocumentWatch = watch(
        () =>
            options.session.documents.value.map((document) => ({
                id: document.id,
                liveRevision: document.liveRevision,
                dirty: document.dirty,
            })),
        queueDocumentEvents,
        { deep: true },
    );

    function dispose() {
        if (disposed) return;
        const shouldStopBridge = startedBridge || startRequested;
        disposed = true;
        stopEnabledWatch();
        stopDocumentWatch();
        clearPublishDelay();
        pendingEvents.clear();
        requestUnlisten?.();
        statusUnlisten?.();
        requestUnlisten = null;
        statusUnlisten = null;
        startedBridge = false;
        startRequested = false;
        if (shouldStopBridge) {
            void operationTail.then(
                () => invoke("set_agent_access_enabled", { enabled: false }),
                () => invoke("set_agent_access_enabled", { enabled: false }),
            );
        }
    }

    return { status: readonly(status), dispose };
}
