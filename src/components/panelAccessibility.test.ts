/** @vitest-environment jsdom */

import { createApp, h, nextTick, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "../composables/usePreferences";
import HistoryPanel from "./HistoryPanel.vue";
import LibraryPanel from "./LibraryPanel.vue";
import SettingsPanel from "./SettingsPanel.vue";

let cleanup: (() => void) | undefined;

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

describe("模态面板关闭按钮", () => {
    it.each([
        {
            name: "偏好设置",
            component: SettingsPanel,
            props: {
                open: true,
                preferences: DEFAULT_PREFERENCES,
                aiKeyConfigured: false,
                aiKeySaving: false,
            },
            label: "关闭偏好设置",
        },
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
            label: "关闭笔记库",
        },
    ])("$name 提供明确的无障碍名称", ({ component, props, label }) => {
        const host = mountPanel(component, props);
        const closeButton = host.querySelector<HTMLButtonElement>(".icon-button");

        expect(closeButton?.getAttribute("aria-label")).toBe(label);
    });

    it.each([
        {
            name: "偏好设置",
            component: SettingsPanel,
            props: {
                open: true,
                preferences: DEFAULT_PREFERENCES,
                aiKeyConfigured: false,
                aiKeySaving: false,
            },
        },
        {
            name: "历史版本",
            component: HistoryPanel,
            props: { open: true, items: [], loading: false },
        },
    ])("$name 打开后接管模态焦点", async ({ component, props }) => {
        const host = mountPanel(component, props);
        const dialog = host.querySelector<HTMLElement>('[role="dialog"]');

        expect(dialog).not.toBeNull();
        await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
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
            onUpdate: update,
            onSaveAiKey: saveAiKey,
        });
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

    it("已配置时允许删除 API Key", () => {
        const deleteAiKey = vi.fn();
        const host = mountPanel(SettingsPanel, {
            open: true,
            preferences: DEFAULT_PREFERENCES,
            aiKeyConfigured: true,
            aiKeySaving: false,
            onDeleteAiKey: deleteAiKey,
        });
        const deleteButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "删除 API Key",
        );

        expect(host.textContent).toContain("已配置");
        expect(deleteButton?.disabled).toBe(false);
        deleteButton?.click();
        expect(deleteAiKey).toHaveBeenCalledTimes(1);
    });
});
