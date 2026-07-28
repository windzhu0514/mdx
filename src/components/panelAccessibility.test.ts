/** @vitest-environment jsdom */

import { createApp, h, type Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";

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
            props: { open: true, preferences: DEFAULT_PREFERENCES },
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
});
