/** @vitest-environment jsdom */

import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ThemePicker from "./ThemePicker.vue";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

describe("ThemePicker", () => {
    it("renders six ordered, horizontally scrollable theme choices", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () => h(ThemePicker, { theme: "dai-blue" }),
        });
        app.mount(host);
        cleanup = () => app.unmount();

        const picker = host.querySelector('[role="radiogroup"]');
        const choices = Array.from(
            host.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
        );
        expect(picker?.classList).toContain("theme-picker-track");
        expect(
            choices.map((choice) =>
                choice.querySelector(".theme-card-label > span")?.textContent?.trim(),
            ),
        ).toEqual(["宣白", "墨黑", "黛蓝", "松青", "绛红", "藤紫"]);
        expect(choices[2]?.getAttribute("aria-checked")).toBe("true");
    });

    it("emits selection and closes from the upper-right button", async () => {
        const select = vi.fn();
        const close = vi.fn();
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () =>
                h(ThemePicker, {
                    theme: "xuan-white",
                    onSelect: select,
                    onClose: close,
                }),
        });
        app.mount(host);
        cleanup = () => app.unmount();

        host.querySelector<HTMLButtonElement>('[data-theme-choice="wisteria"]')?.click();
        host.querySelector<HTMLButtonElement>(
            'button[aria-label="关闭主题选择"]',
        )?.click();
        await nextTick();

        expect(select).toHaveBeenCalledWith("wisteria");
        expect(close).toHaveBeenCalledOnce();
    });
});
