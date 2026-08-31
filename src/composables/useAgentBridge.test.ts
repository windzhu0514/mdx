/** @vitest-environment jsdom */

import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AgentBridgeStatus,
    AgentFrontendRequest,
    AgentFrontendResponse,
} from "../types/agent";
import { useAgentBridge } from "./useAgentBridge";
import { useDocumentSession, type OpenDocument } from "./useDocumentSession";

type PayloadEvent<T> = { payload: T };
type EventListener = (event: PayloadEvent<unknown>) => void | Promise<void>;
type WithoutDispatch<T> = T extends unknown
    ? Omit<T, "dispatchToken" | "operationGeneration">
    : never;
type FrontendRequestInput = WithoutDispatch<AgentFrontendRequest>;

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
    listeners: new Map<string, EventListener>(),
    unlisteners: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (name: string, listener: EventListener) => {
        tauri.listeners.set(name, listener);
        const unlisten = vi.fn(() => tauri.listeners.delete(name));
        tauri.unlisteners.set(name, unlisten);
        return unlisten;
    }),
}));

const disabledStatus: AgentBridgeStatus = {
    enabled: false,
    listening: false,
    connectedClients: 0,
    watcherClients: 0,
    cliPath: null,
    protocolVersion: 1,
    lastError: null,
};

const enabledStatus: AgentBridgeStatus = {
    ...disabledStatus,
    enabled: true,
    listening: true,
    cliPath: "C:\\Program Files\\Mora\\mora-agent.exe",
};

function completeResponses() {
    return tauri.invoke.mock.calls
        .filter(([command]) => command === "complete_agent_request")
        .map(([, args]) => (args as { response: AgentFrontendResponse }).response);
}

let dispatchSequence = 0;

async function request(
    payload: FrontendRequestInput,
    operationGeneration = 1,
    dispatchToken = `dispatch-${++dispatchSequence}`,
) {
    const listener = tauri.listeners.get("mora://agent-request");
    if (!listener) throw new Error("Agent request listener was not registered");
    await listener({
        payload: {
            ...payload,
            dispatchToken,
            operationGeneration,
        },
    });
    return dispatchToken;
}

async function waitForBridge() {
    await vi.waitFor(() => {
        expect(tauri.listeners.has("mora://agent-request")).toBe(true);
    });
}

describe("useAgentBridge", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        tauri.listeners.clear();
        tauri.unlisteners.clear();
        dispatchSequence = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") return disabledStatus;
            if (command === "set_agent_access_enabled") {
                return (args as { enabled: boolean }).enabled
                    ? enabledStatus
                    : disabledStatus;
            }
            return undefined;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads the current unsaved canonical document content", async () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        session.updateContent(runtime.id, "unsaved");
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await waitForBridge();

        const dispatchToken = await request({
            requestId: "req-1",
            method: "readDocument",
            params: { documentId: runtime.id },
        });

        expect(completeResponses()).toContainEqual(
            expect.objectContaining({
                requestId: "req-1",
                dispatchToken,
                operationGeneration: 1,
                result: expect.objectContaining({ content: "unsaved" }),
            }),
        );
        bridge.dispose();
    });

    it("guards replacements with live revisions and reports mutations", async () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const staleRevision = runtime.liveRevision;
        session.updateContent(runtime.id, "newer editor content");
        const onMutation = vi.fn();
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation,
        });
        await waitForBridge();

        await request({
            requestId: "req-stale",
            method: "replaceDocument",
            params: {
                documentId: runtime.id,
                baseLiveRevision: staleRevision,
                content: "must not win",
            },
        });
        const currentRevision = runtime.liveRevision;
        await request({
            requestId: "req-current",
            method: "replaceDocument",
            params: {
                documentId: runtime.id,
                baseLiveRevision: currentRevision,
                content: "agent content",
            },
        });

        expect(completeResponses()).toContainEqual(
            expect.objectContaining({
                requestId: "req-stale",
                error: expect.objectContaining({ code: "REVISION_CONFLICT" }),
            }),
        );
        expect(runtime.content).toBe("agent content");
        expect(onMutation).toHaveBeenCalledWith(runtime.id);
        bridge.dispose();
    });

    it("maps non-interactive external save conflicts to DISK_CONFLICT", async () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const saveDocument = vi
            .fn<(id: string, revision: string) => Promise<OpenDocument>>()
            .mockRejectedValue({ code: "EXTERNAL_CONFLICT", documentId: runtime.id });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument,
            onMutation: vi.fn(),
        });
        await waitForBridge();

        await request({
            requestId: "req-save",
            method: "saveDocument",
            params: {
                documentId: runtime.id,
                baseLiveRevision: runtime.liveRevision,
            },
        });

        expect(saveDocument).toHaveBeenCalledWith(runtime.id, runtime.liveRevision);
        expect(completeResponses()).toContainEqual(
            expect.objectContaining({
                requestId: "req-save",
                error: expect.objectContaining({ code: "DISK_CONFLICT" }),
            }),
        );
        bridge.dispose();
    });

    it("rejects an invalidated queued write before it can save", async () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const saveDocument = vi
            .fn<(id: string, revision: string) => Promise<OpenDocument>>()
            .mockResolvedValue(runtime);
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument,
            onMutation: vi.fn(),
        });
        await waitForBridge();
        await vi.waitFor(() => {
            expect(tauri.listeners.has("mora://agent-dispatch-invalidated")).toBe(true);
        });
        const invalidate = tauri.listeners.get("mora://agent-dispatch-invalidated")!;
        await invalidate({ payload: { operationGeneration: 2 } });

        const dispatchToken = await request(
            {
                requestId: "queued-save",
                method: "saveDocument",
                params: {
                    documentId: runtime.id,
                    baseLiveRevision: runtime.liveRevision,
                },
            },
            1,
            "dispatch-queued-save",
        );

        expect(saveDocument).not.toHaveBeenCalled();
        expect(completeResponses()).toContainEqual(
            expect.objectContaining({
                requestId: "queued-save",
                dispatchToken,
                operationGeneration: 1,
                error: expect.objectContaining({ code: "AGENT_ACCESS_DISABLED" }),
            }),
        );
        bridge.dispose();
    });

    it("queries and conservatively stops after a failed start with unknown status", async () => {
        let statusReads = 0;
        let stopCalls = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") {
                statusReads += 1;
                if (statusReads === 1) return disabledStatus;
                throw { message: "status unavailable" };
            }
            if (
                command === "set_agent_access_enabled" &&
                (args as { enabled: boolean }).enabled
            ) {
                throw { message: "start result lost" };
            }
            if (command === "set_agent_access_enabled") {
                stopCalls += 1;
                return disabledStatus;
            }
            return undefined;
        });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session: useDocumentSession(false),
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });

        await vi.waitFor(() => expect(stopCalls).toBe(1));

        expect(statusReads).toBe(2);
        expect(bridge.status.value.enabled).toBe(false);
        expect(bridge.status.value.lastError).toContain("start result lost");
        bridge.dispose();
    });

    it("conservatively stops a runtime when reload cannot query initial status", async () => {
        let stopCalls = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") {
                throw { message: "status unavailable after reload" };
            }
            if (
                command === "set_agent_access_enabled" &&
                !(args as { enabled: boolean }).enabled
            ) {
                stopCalls += 1;
                return disabledStatus;
            }
            return undefined;
        });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(false),
            session: useDocumentSession(false),
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });

        await vi.waitFor(() => expect(stopCalls).toBe(1));

        expect(bridge.status.value.lastError).toContain(
            "status unavailable after reload",
        );
        bridge.dispose();
    });

    it("retries a conservative stop on dispose while lifecycle remains unknown", async () => {
        let stopCalls = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") {
                throw { message: "status unavailable" };
            }
            if (
                command === "set_agent_access_enabled" &&
                !(args as { enabled: boolean }).enabled
            ) {
                stopCalls += 1;
                throw { message: "stop unavailable" };
            }
            return undefined;
        });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(false),
            session: useDocumentSession(false),
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await vi.waitFor(() => expect(stopCalls).toBe(1));

        bridge.dispose();

        await vi.waitFor(() => expect(stopCalls).toBe(3));
    });

    it("stops an enabled bridge and unregisters listeners on disable and dispose", async () => {
        const enabled = ref(true);
        const session = useDocumentSession(false);
        const bridge = useAgentBridge({
            desktop: true,
            enabled,
            session,
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await waitForBridge();

        enabled.value = false;
        await nextTick();
        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("set_agent_access_enabled", {
                enabled: false,
            });
        });
        bridge.dispose();

        expect(tauri.unlisteners.get("mora://agent-request")).toHaveBeenCalledTimes(1);
        expect(tauri.unlisteners.get("mora://agent-status")).toHaveBeenCalledTimes(1);
    });

    it("stops a bridge whose startup completes after dispose", async () => {
        const startGate: {
            resolve?: (status: AgentBridgeStatus) => void;
        } = {};
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") return disabledStatus;
            if (
                command === "set_agent_access_enabled" &&
                (args as { enabled: boolean }).enabled
            ) {
                return new Promise<AgentBridgeStatus>((resolve) => {
                    startGate.resolve = resolve;
                });
            }
            if (command === "set_agent_access_enabled") return disabledStatus;
            return undefined;
        });
        const session = useDocumentSession(false);
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await waitForBridge();
        await vi.waitFor(() => expect(startGate.resolve).toBeTypeOf("function"));

        bridge.dispose();
        if (!startGate.resolve) throw new Error("Agent bridge startup did not begin");
        startGate.resolve(enabledStatus);

        await vi.waitFor(() => {
            expect(tauri.invoke).toHaveBeenCalledWith("set_agent_access_enabled", {
                enabled: false,
            });
        });
    });

    it("keeps the request listener until dispose stop drains a racing write", async () => {
        const stopGate: { resolve?: (status: AgentBridgeStatus) => void } = {};
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") return disabledStatus;
            if (
                command === "set_agent_access_enabled" &&
                (args as { enabled: boolean }).enabled
            ) {
                return enabledStatus;
            }
            if (command === "set_agent_access_enabled") {
                return new Promise<AgentBridgeStatus>((resolve) => {
                    stopGate.resolve = resolve;
                });
            }
            return undefined;
        });
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const saveDocument =
            vi.fn<(id: string, revision: string) => Promise<OpenDocument>>();
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session,
            saveDocument,
            onMutation: vi.fn(),
        });
        await waitForBridge();
        await vi.waitFor(() => expect(bridge.status.value.enabled).toBe(true));

        bridge.dispose();
        await vi.waitFor(() => expect(stopGate.resolve).toBeTypeOf("function"));
        const dispatchToken = await request(
            {
                requestId: "dispose-race-save",
                method: "saveDocument",
                params: {
                    documentId: runtime.id,
                    baseLiveRevision: runtime.liveRevision,
                },
            },
            1,
            "dispose-race-token",
        );

        expect(saveDocument).not.toHaveBeenCalled();
        expect(completeResponses()).toContainEqual({
            requestId: "dispose-race-save",
            dispatchToken,
            operationGeneration: 1,
            error: {
                code: "AGENT_ACCESS_DISABLED",
                message: "本地 Agent 接入已关闭。",
            },
        });
        expect(tauri.unlisteners.get("mora://agent-request")).not.toHaveBeenCalled();

        stopGate.resolve?.(disabledStatus);
        await vi.waitFor(() => {
            expect(tauri.unlisteners.get("mora://agent-request")).toHaveBeenCalledTimes(
                1,
            );
            expect(tauri.unlisteners.get("mora://agent-status")).toHaveBeenCalledTimes(1);
            expect(
                tauri.unlisteners.get("mora://agent-dispatch-invalidated"),
            ).toHaveBeenCalledTimes(1);
        });
    });

    it("retries an unknown dispose stop and cleans listeners exactly once", async () => {
        let statusReads = 0;
        let stopCalls = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") {
                statusReads += 1;
                if (statusReads === 1) return disabledStatus;
                throw { message: "dispose status unknown" };
            }
            if (
                command === "set_agent_access_enabled" &&
                (args as { enabled: boolean }).enabled
            ) {
                return enabledStatus;
            }
            if (command === "set_agent_access_enabled") {
                stopCalls += 1;
                throw { message: "dispose stop failed" };
            }
            return undefined;
        });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session: useDocumentSession(false),
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await waitForBridge();
        await vi.waitFor(() => expect(bridge.status.value.enabled).toBe(true));

        bridge.dispose();
        bridge.dispose();

        await vi.waitFor(() => expect(stopCalls).toBe(2));
        expect(statusReads).toBe(2);
        expect(tauri.unlisteners.get("mora://agent-request")).toHaveBeenCalledTimes(1);
        expect(tauri.unlisteners.get("mora://agent-status")).toHaveBeenCalledTimes(1);
        expect(
            tauri.unlisteners.get("mora://agent-dispatch-invalidated"),
        ).toHaveBeenCalledTimes(1);
    });

    it("bounds unresolved dispose cleanup before releasing listeners", async () => {
        const timeoutControllers: AbortController[] = [];
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
            const controller = new AbortController();
            timeoutControllers.push(controller);
            return controller.signal;
        });
        let statusReads = 0;
        let stopCalls = 0;
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            if (command === "get_agent_bridge_status") {
                statusReads += 1;
                if (statusReads === 1) return disabledStatus;
                return new Promise<AgentBridgeStatus>(() => undefined);
            }
            if (
                command === "set_agent_access_enabled" &&
                (args as { enabled: boolean }).enabled
            ) {
                return enabledStatus;
            }
            if (command === "set_agent_access_enabled") {
                stopCalls += 1;
                return new Promise<AgentBridgeStatus>(() => undefined);
            }
            return undefined;
        });
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(true),
            session: useDocumentSession(false),
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        try {
            await waitForBridge();
            await vi.waitFor(() => expect(bridge.status.value.enabled).toBe(true));

            bridge.dispose();
            await vi.waitFor(() => expect(stopCalls).toBe(1));
            expect(tauri.unlisteners.get("mora://agent-request")).not.toHaveBeenCalled();
            timeoutControllers[timeoutControllers.length - 1]?.abort();

            await vi.waitFor(() => expect(statusReads).toBe(2));
            timeoutControllers[timeoutControllers.length - 1]?.abort();
            await vi.waitFor(() => expect(stopCalls).toBe(2));
            timeoutControllers[timeoutControllers.length - 1]?.abort();

            await vi.waitFor(() => {
                expect(
                    tauri.unlisteners.get("mora://agent-request"),
                ).toHaveBeenCalledTimes(1);
                expect(
                    tauri.unlisteners.get("mora://agent-status"),
                ).toHaveBeenCalledTimes(1);
                expect(
                    tauri.unlisteners.get("mora://agent-dispatch-invalidated"),
                ).toHaveBeenCalledTimes(1);
            });
        } finally {
            timeoutSpy.mockRestore();
            bridge.dispose();
        }
    });

    it("unregisters listeners when initial bridge status loading fails", async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === "get_agent_bridge_status") {
                throw { message: "status unavailable" };
            }
            return disabledStatus;
        });
        const session = useDocumentSession(false);
        const bridge = useAgentBridge({
            desktop: true,
            enabled: ref(false),
            session,
            saveDocument:
                vi.fn<(id: string, revision: string) => Promise<OpenDocument>>(),
            onMutation: vi.fn(),
        });
        await vi.waitFor(() => {
            expect(bridge.status.value.lastError).toBe("status unavailable");
        });

        bridge.dispose();

        await vi.waitFor(() => {
            expect(tauri.unlisteners.get("mora://agent-request")).toHaveBeenCalledTimes(
                1,
            );
            expect(tauri.unlisteners.get("mora://agent-status")).toHaveBeenCalledTimes(1);
            expect(
                tauri.unlisteners.get("mora://agent-dispatch-invalidated"),
            ).toHaveBeenCalledTimes(1);
        });
    });
});
