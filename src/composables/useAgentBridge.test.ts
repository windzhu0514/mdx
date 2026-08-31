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

async function request(payload: AgentFrontendRequest) {
    const listener = tauri.listeners.get("mora://agent-request");
    if (!listener) throw new Error("Agent request listener was not registered");
    await listener({ payload });
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

        await request({
            requestId: "req-1",
            method: "readDocument",
            params: { documentId: runtime.id },
        });

        expect(completeResponses()).toContainEqual(
            expect.objectContaining({
                requestId: "req-1",
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
        });
    });
});
