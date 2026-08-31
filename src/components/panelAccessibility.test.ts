/** @vitest-environment jsdom */

import { createApp, h, nextTick, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "../composables/usePreferences";
import type { AgentBridgeStatus } from "../types/agent";
import AttachmentPanel from "./AttachmentPanel.vue";
import HistoryPanel from "./HistoryPanel.vue";
import LibraryPanel from "./LibraryPanel.vue";
import SettingsPanel from "./SettingsPanel.vue";

let cleanup: (() => void) | undefined;

const disabledAgentStatus: AgentBridgeStatus = {
    enabled: false,
    listening: false,
    connectedClients: 0,
    watcherClients: 0,
    cliPath: null,
    protocolVersion: 1,
    lastError: null,
};

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function mountPanel(component: Component, props: Record<string, unknown>) {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
        render: () => h(component, props),
    });
    app.mount(host);
    cleanup = () => app.unmount();
    return host;
}

describe("面板关闭按钮", () => {
    it.each([
        {
            name: "历史版本",
            component: HistoryPanel,
            props: { open: true, items: [], loading: false },
            label: "关闭历史版本",
        },
        {
            name: "笔记库",
            component: LibraryPanel,
            props: {
                open: true,
                notes: [],
                results: [],
                loading: false,
                query: "",
            },
            label: "关闭工作区查找",
        },
        {
            name: "附件管理",
            component: AttachmentPanel,
            props: {
                open: true,
                documentName: "项目.mdx",
                items: [],
            },
            label: "关闭附件管理",
        },
    ])("$name 提供明确的无障碍名称", ({ component, props, label }) => {
        const host = mountPanel(component, props);
        const closeButton = host.querySelector<HTMLButtonElement>(".icon-button");

        expect(closeButton?.getAttribute("aria-label")).toBe(label);
    });

    it("历史版本打开后接管模态焦点", async () => {
        const host = mountPanel(HistoryPanel, {
            open: true,
            items: [],
            loading: false,
        });
        const dialog = host.querySelector<HTMLElement>('[role="dialog"]');

        expect(dialog).not.toBeNull();
        await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
    });

    it("偏好设置使用非模态工作区并提供返回入口", async () => {
        const host = mountPanel(SettingsPanel, {
            open: true,
            preferences: DEFAULT_PREFERENCES,
            aiKeyConfigured: false,
            aiKeySaving: false,
            agentStatus: disabledAgentStatus,
        });
        const workspace = host.querySelector<HTMLElement>(".settings-workspace");
        const backButton = host.querySelector<HTMLButtonElement>(".settings-back");

        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(backButton?.getAttribute("aria-label")).toBe("返回编辑器");
        await vi.waitFor(() => expect(document.activeElement).toBe(workspace));
    });
});

describe("AI 设置", () => {
    it("更新非敏感设置，保存后清空本地 API Key 输入", async () => {
        const update = vi.fn();
        const saveAiKey = vi.fn();
        const host = mountPanel(SettingsPanel, {
            open: true,
            preferences: DEFAULT_PREFERENCES,
            aiKeyConfigured: false,
            aiKeySaving: false,
            agentStatus: disabledAgentStatus,
            onUpdate: update,
            onSaveAiKey: saveAiKey,
        });
        Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
            .find((button) => button.textContent?.trim() === "AI")
            ?.click();
        await nextTick();
        const baseUrl = host.querySelector<HTMLInputElement>(
            'input[aria-label="AI Base URL"]',
        );
        const apiKey = host.querySelector<HTMLInputElement>(
            'input[aria-label="AI API Key"]',
        );
        if (!baseUrl || !apiKey) throw new Error("未找到 AI 设置输入框");

        baseUrl.value = "https://api.example.com/v1";
        baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
        apiKey.value = "secret-value";
        apiKey.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();
        const saveButton = Array.from(host.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("保存/替换 API Key"),
        );
        saveButton?.click();
        await nextTick();

        expect(update).toHaveBeenCalledWith({
            aiBaseUrl: "https://api.example.com/v1",
        });
        expect(saveAiKey).toHaveBeenCalledWith("secret-value");
        expect(apiKey.value).toBe("");
        expect(host.textContent).not.toContain("secret-value");
        expect(host.textContent).toContain("未配置");
        const deleteButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "删除 API Key",
        );
        expect(deleteButton?.disabled).toBe(true);
    });

    it("已配置时允许删除 API Key", async () => {
        const deleteAiKey = vi.fn();
        const host = mountPanel(SettingsPanel, {
            open: true,
            preferences: DEFAULT_PREFERENCES,
            aiKeyConfigured: true,
            aiKeySaving: false,
            agentStatus: disabledAgentStatus,
            onDeleteAiKey: deleteAiKey,
        });
        Array.from(host.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
            .find((button) => button.textContent?.trim() === "AI")
            ?.click();
        await nextTick();
        const deleteButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "删除 API Key",
        );

        expect(host.textContent).toContain("已配置");
        expect(deleteButton?.disabled).toBe(false);
        deleteButton?.click();
        expect(deleteAiKey).toHaveBeenCalledTimes(1);
    });
});
