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
    it("renders a non-modal categorized workspace with a semantic live preview", async () => {
        const close = vi.fn();
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () => h(SettingsPanel, { ...settingsProps(), onClose: close }),
        });
        app.mount(host);
        cleanup = () => app.unmount();

        expect(host.querySelector(".panel-backdrop")).toBeNull();
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector(".settings-workspace")).not.toBeNull();
        expect(
            Array.from(
                host.querySelectorAll<HTMLButtonElement>(".settings-nav button"),
            ).map((button) => button.textContent?.trim()),
        ).toEqual(["外观", "编辑器", "AI"]);

        const preview = host.querySelector<HTMLElement>(".settings-live-preview");
        expect(preview?.textContent).toContain("Mora 字体预览");
        expect(preview?.textContent).toContain("The quick brown fox");
        expect(preview?.querySelector("strong")).not.toBeNull();
        expect(preview?.querySelector("em")).not.toBeNull();
        expect(preview?.querySelector("a")).not.toBeNull();
        expect(preview?.querySelector("code")).not.toBeNull();
        expect(preview?.querySelector("pre code")).not.toBeNull();

        const editorCategory = Array.from(
            host.querySelectorAll<HTMLButtonElement>(".settings-nav button"),
        ).find((button) => button.textContent?.trim() === "编辑器");
        editorCategory?.click();
        await nextTick();

        expect(host.textContent).toContain("阅读宽度");
        expect(host.textContent).toContain("默认显示文档目录");
        expect(host.querySelector(".settings-live-preview")).toBeNull();

        host.querySelector<HTMLButtonElement>(".settings-back")?.click();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("offers system mode and all six themes, then emits a concrete selection", async () => {
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

        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            "system",
            "xuan-white",
            "ink-black",
            "dai-blue",
            "pine-green",
            "crimson",
            "wisteria",
        ]);
        select.value = "wisteria";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await nextTick();

        expect(update).toHaveBeenCalledWith({ theme: "wisteria" });
    });

    it("renders independent body and code font lists with per-option previews", async () => {
        const update = vi.fn();
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () => h(SettingsPanel, { ...settingsProps(), onUpdate: update }),
        });
        app.mount(host);
        cleanup = () => app.unmount();
        const selects = host.querySelectorAll<HTMLSelectElement>("select");
        const bodyFontSelect = selects[1];
        const codeFontSelect = selects[2];
        if (!bodyFontSelect) throw new Error("未找到字体选择框");
        if (!codeFontSelect) throw new Error("未找到代码字体选择框");

        expect(Array.from(bodyFontSelect.options).map((option) => option.value)).toEqual([
            "system-default",
            "cascadia-code",
            "consolas",
            "fira-code",
            "jetbrains-mono",
            "maple-mono-cn",
            "sf-mono",
            "sarasa-mono-sc",
            "inter",
            "segoe-ui",
            "pingfang-sc",
            "source-han-sans-sc",
            "microsoft-yahei",
            "georgia",
            "times-new-roman",
            "kaiti",
            "source-han-serif-sc",
            "simsun",
            "lxgw-wenkai",
        ]);
        expect(
            Array.from(bodyFontSelect.querySelectorAll("optgroup")).map((group) =>
                group.getAttribute("label"),
            ),
        ).toEqual(["等宽", "无衬线", "衬线"]);
        expect(
            bodyFontSelect.querySelector<HTMLOptionElement>('option[value="fira-code"]')
                ?.style.fontFamily,
        ).toContain("Fira Code");

        expect(Array.from(codeFontSelect.options).map((option) => option.value)).toEqual([
            "cascadia-code",
            "consolas",
            "fira-code",
            "jetbrains-mono",
            "maple-mono-cn",
            "sf-mono",
            "sarasa-mono-sc",
        ]);
        expect(
            codeFontSelect.querySelector<HTMLOptionElement>(
                'option[value="maple-mono-cn"]',
            )?.style.fontFamily,
        ).toContain("Maple Mono CN Bundled");

        bodyFontSelect.value = "lxgw-wenkai";
        bodyFontSelect.dispatchEvent(new Event("change", { bubbles: true }));
        codeFontSelect.value = "fira-code";
        codeFontSelect.dispatchEvent(new Event("change", { bubbles: true }));
        await nextTick();

        expect(update).toHaveBeenCalledWith({ fontFamily: "lxgw-wenkai" });
        expect(update).toHaveBeenCalledWith({ codeFontFamily: "fira-code" });
    });

    it("marks unavailable local fonts and keeps system and bundled fonts enabled", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () =>
                h(SettingsPanel, {
                    ...settingsProps(),
                    installedFontFamilies: ["Consolas", "Microsoft YaHei", "Segoe UI"],
                }),
        });
        app.mount(host);
        cleanup = () => app.unmount();
        const selects = host.querySelectorAll<HTMLSelectElement>("select");
        const bodyFontSelect = selects[1];
        const codeFontSelect = selects[2];
        if (!bodyFontSelect || !codeFontSelect) {
            throw new Error("未找到字体选择框");
        }

        const bodyOption = (value: string) =>
            bodyFontSelect.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
        const codeOption = (value: string) =>
            codeFontSelect.querySelector<HTMLOptionElement>(`option[value="${value}"]`);

        expect(bodyOption("system-default")?.disabled).toBe(false);
        expect(bodyOption("maple-mono-cn")?.disabled).toBe(false);
        expect(bodyOption("segoe-ui")?.disabled).toBe(false);
        expect(bodyOption("microsoft-yahei")?.disabled).toBe(false);
        expect(bodyOption("inter")?.disabled).toBe(true);
        expect(bodyOption("inter")?.textContent?.trim()).toBe("Inter（未安装）");
        expect(bodyOption("source-han-sans-sc")?.disabled).toBe(true);
        expect(bodyOption("source-han-sans-sc")?.textContent?.trim()).toBe(
            "思源黑体（未安装）",
        );
        expect(codeOption("maple-mono-cn")?.disabled).toBe(false);
        expect(codeOption("consolas")?.disabled).toBe(false);
        expect(codeOption("fira-code")?.disabled).toBe(true);
        expect(codeOption("fira-code")?.textContent?.trim()).toBe("Fira Code（未安装）");
    });
});
