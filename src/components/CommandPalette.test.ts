/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CommandPalette from "./CommandPalette.vue";

const commands = [
    { id: "file.new", category: "文件", label: "新建", shortcut: "Ctrl+N", disabled: false },
    { id: "edit.undo", category: "编辑", label: "撤销", shortcut: "Ctrl+Z", disabled: true },
    { id: "view.settings", category: "视图", label: "偏好设置...", disabled: false },
];

let app: App | undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = "";
});

function mountPalette(open = true) {
    const run = vi.fn();
    const close = vi.fn();
    const isOpen = ref(open);
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(CommandPalette, {
                open: isOpen.value,
                commands,
                onRun: run,
                onClose: close,
            }),
    });
    app.mount(host);

    const input = host.querySelector<HTMLInputElement>("input[aria-label='搜索命令']");
    if (!input) throw new Error("未找到命令搜索框");

    return {
        close,
        host,
        input,
        run,
        setOpen: async (value: boolean) => {
            isOpen.value = value;
            await nextTick();
        },
    };
}

async function keydown(input: HTMLInputElement, key: string) {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    await nextTick();
}

describe("CommandPalette", () => {
    it("filters commands and executes the keyboard-selected enabled result", async () => {
        const { input, run } = mountPalette();
        input.value = "偏好";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();
        await keydown(input, "Enter");

        expect(run).toHaveBeenCalledWith("view.settings");
    });

    it("keeps disabled commands visible but does not execute them", async () => {
        const { host, input, run } = mountPalette();
        input.value = "撤销";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();
        await keydown(input, "Enter");

        expect(host.textContent).toContain("撤销");
        expect(run).not.toHaveBeenCalled();
    });

    it("omits aria-activedescendant when search has no results", async () => {
        const { input } = mountPalette();
        input.value = "不存在的命令";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();

        expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("moves with arrows and restores the invoking focus after Escape", async () => {
        const trigger = document.createElement("button");
        document.body.append(trigger);
        trigger.focus();
        const { close, host, input, setOpen } = mountPalette();
        await keydown(input, "ArrowDown");
        expect(host.querySelector("[role='option'][aria-selected='true']")?.textContent).toContain(
            "撤销",
        );

        await keydown(input, "Escape");
        expect(close).toHaveBeenCalledOnce();
        await setOpen(false);
        await nextTick();
        expect(document.activeElement).toBe(trigger);
    });
});
