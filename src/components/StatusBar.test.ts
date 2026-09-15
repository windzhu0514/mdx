/** @vitest-environment jsdom */

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";

import StatusBar from "./StatusBar.vue";

let app: App<Element> | null = null;
afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

it("places workspace and outline controls at opposite status-bar edges", () => {
    const events: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(StatusBar, {
                errorMessage: "",
                statusMessage: "准备就绪",
                wordCount: 10,
                workspaceVisible: true,
                outlineVisible: false,
                outlineAvailable: false,
                onToggleWorkspace: () => events.push("workspace"),
                onToggleOutline: () => events.push("outline"),
            }),
    });
    app.mount(host);

    const footer = host.querySelector(".status-bar");
    expect(footer?.firstElementChild?.getAttribute("aria-label")).toBe("隐藏工作区");
    expect(footer?.lastElementChild?.getAttribute("aria-label")).toBe("当前文档没有目录");
    expect(footer?.lastElementChild).toHaveProperty("disabled", true);
    (footer?.firstElementChild as HTMLButtonElement | null)?.click();
    expect(events).toEqual(["workspace"]);
    expect(footer?.getAttribute("aria-live")).toBeNull();
    expect(host.querySelector(".status-right")?.textContent?.trim()).toBe("10 字");
});

it("keeps an error visible, opens full details, and lets the user dismiss it", async () => {
    const state = reactive({ error: "保存失败\n磁盘空间不足，请释放空间后重试。" });
    const host = document.createElement("div");
    document.body.append(host);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute("open", "");
        }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute("open");
        }),
    });
    app = createApp({
        render: () =>
            h(StatusBar, {
                errorMessage: state.error,
                statusMessage: "保存成功",
                wordCount: 12,
                workspaceVisible: true,
                outlineVisible: false,
                outlineAvailable: false,
                onDismissMessage: () => {
                    state.error = "";
                },
            }),
    });
    app.mount(host);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("磁盘空间不足");
    const details = host.querySelector<HTMLButtonElement>('[aria-label="查看提示详情"]');
    expect(details).not.toBeNull();
    details!.click();
    await nextTick();
    expect(host.querySelector("dialog[open]")?.textContent).toContain(state.error);
    host.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click();
    host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click();
    await nextTick();
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain(
        "磁盘空间不足",
    );
    expect(host.querySelector(".path")).toBeNull();
});
