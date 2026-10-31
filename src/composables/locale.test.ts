/** @vitest-environment jsdom */
import { createApp, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_PREFERENCES,
    normalizePreferences,
    loadPreferences,
    savePreferences,
} from "./usePreferences";
import SettingsPanel from "../components/SettingsPanel.vue";

describe("界面语言偏好", () => {
    it("兼容历史与非法语言值，并在原存储键保存后重新加载", () => {
        expect(normalizePreferences({}).language).toBe("system");
        expect(normalizePreferences({ language: "invalid" }).language).toBe("system");
        for (const language of ["system", "zh-CN", "en"] as const) {
            const storage = { getItem: vi.fn(() => ""), setItem: vi.fn() };
            savePreferences(storage, { ...DEFAULT_PREFERENCES, language });
            const [key, value] = storage.setItem.mock.calls[0];
            expect(key).toBe("mora.preferences.v1");
            storage.getItem.mockReturnValue(value);
            expect(loadPreferences(storage).language).toBe(language);
        }
    });
    it("设置提供跟随系统、简体中文和英文，并发出偏好更新", async () => {
        const host = document.createElement("div");
        const update = vi.fn();
        const app = createApp({
            render: () =>
                h(SettingsPanel, {
                    open: true,
                    preferences: DEFAULT_PREFERENCES,
                    aiKeyConfigured: false,
                    aiKeySaving: false,
                    agentStatus: {
                        enabled: false,
                        listening: false,
                        connectedClients: 0,
                        watcherClients: 0,
                        cliPath: null,
                        protocolVersion: 1,
                        lastError: null,
                    },
                    onUpdate: update,
                }),
        });
        app.mount(host);
        try {
            const select = host.querySelector<HTMLSelectElement>(
                '[data-testid="language-select"]',
            );
            expect(select).not.toBeNull();
            expect(Array.from(select!.options).map((o) => o.value)).toEqual([
                "system",
                "zh-CN",
                "en",
            ]);
            select!.value = "en";
            select!.dispatchEvent(new Event("change"));
            await nextTick();
            expect(update).toHaveBeenCalledWith({ language: "en" });
        } finally {
            app.unmount();
        }
    });
});

import { locale, resolveLanguage } from "../i18n";
import LeaveConfirmDialog from "../components/LeaveConfirmDialog.vue";
it("首次按系统语言解析，手动选择优先", () => {
    expect(resolveLanguage("system", "zh-TW")).toBe("zh-CN");
    expect(resolveLanguage("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "ja-JP")).toBe("en");
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
});
it("已打开的保存确认框随语言切换，保留原文档名称", async () => {
    HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
        this.open = false;
    };
    const host = document.createElement("div");
    locale.value = "zh-CN";
    const app = createApp({
        render: () => h(LeaveConfirmDialog, { open: true, documentName: "原笔记标题" }),
    });
    app.mount(host);
    try {
        expect(host.textContent).toContain("保存并继续");
        locale.value = "en";
        await nextTick();
        expect(host.textContent).toContain("Save and continue");
        expect(host.textContent).toContain("原笔记标题");
    } finally {
        app.unmount();
        locale.value = "zh-CN";
    }
});
