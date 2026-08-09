/** @vitest-environment jsdom */

import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "../composables/usePreferences";
import SettingsPanel from "./SettingsPanel.vue";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function settingsProps() {
    return {
        open: true,
        preferences: DEFAULT_PREFERENCES,
        aiKeyConfigured: false,
        aiKeySaving: false,
    };
}

describe("SettingsPanel", () => {
    it("emits monochrome theme selection", async () => {
        const update = vi.fn();
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () => h(SettingsPanel, { ...settingsProps(), onUpdate: update }),
        });
        app.mount(host);
        cleanup = () => app.unmount();
        const select = host.querySelector<HTMLSelectElement>("select");
        if (!select) throw new Error("未找到主题选择框");

        expect(Array.from(select.options).map((option) => option.value)).toContain(
            "monochrome",
        );
        select.value = "monochrome";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await nextTick();

        expect(update).toHaveBeenCalledWith({ theme: "monochrome" });
    });
});
