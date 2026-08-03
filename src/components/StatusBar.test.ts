/** @vitest-environment jsdom */

import { createApp, h, type App } from "vue";
import { afterEach, expect, it } from "vitest";

import StatusBar from "./StatusBar.vue";

let app: App<Element> | null = null;
afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
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
                path: "C:\\note.mdx",
                dirty: false,
                modeLabel: "所见即所得",
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
});
