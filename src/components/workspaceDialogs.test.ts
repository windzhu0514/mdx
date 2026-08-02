/** @vitest-environment jsdom */

import { createApp, h, type App, type Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ExternalConflictDialog from "./ExternalConflictDialog.vue";
import LeaveConfirmDialog from "./LeaveConfirmDialog.vue";
import MarkdownResourcesDialog from "./MarkdownResourcesDialog.vue";
import type { MarkdownResourcePlan } from "../types/workspace";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function mount(component: Component, props: Record<string, unknown>) {
    const emitted = new Map<string, unknown[][]>();
    const host = document.createElement("div");
    document.body.append(host);
    const app: App = createApp({
        render: () =>
            h(component, {
                ...props,
                onDecide: (decision: string) =>
                    emitted.set("decide", [...(emitted.get("decide") ?? []), [decision]]),
            }),
    });
    app.mount(host);
    cleanup = () => app.unmount();
    return { host, emitted: (event: string) => emitted.get(event) };
}

function planWith(
    ...statuses: MarkdownResourcePlan["items"][number]["status"][]
): MarkdownResourcePlan {
    return {
        rewrittenContent: "",
        resources: [],
        items: statuses.map((status, index) => ({
            originalReference: `assets/item-${index + 1}.png`,
            resolvedPath: status === "ready" ? `C:\\Files\\item-${index + 1}.png` : null,
            status,
            targetPath: status === "ready" ? `assets/item-${index + 1}.png` : null,
            message: null,
        })),
    };
}

function expectAccessibleDialog(host: HTMLElement) {
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(host.querySelectorAll(`#${labelId}`).length).toBe(1);
}

describe("workspace decision dialogs", () => {
    it("offers all conflict outcomes and reports the exact decision", () => {
        const dialog = mount(ExternalConflictDialog, {
            open: true,
            documentName: "note.mdx",
        });
        expectAccessibleDialog(dialog.host);
        expect(dialog.host.querySelector("button[autofocus]")?.textContent).toContain(
            "取消",
        );

        for (const [label, decision] of [
            ["覆盖磁盘版本", "overwrite"],
            ["重新加载磁盘版本", "reload"],
            ["另存为", "save-as"],
            ["取消", "cancel"],
        ]) {
            Array.from(dialog.host.querySelectorAll<HTMLButtonElement>("button"))
                .find((button) => button.textContent?.includes(label))
                ?.click();
            const decisions = dialog.emitted("decide") ?? [];
            expect(decisions[decisions.length - 1]).toEqual([decision]);
        }
    });

    it("lists ready and unresolved resources before continuing", () => {
        const dialog = mount(MarkdownResourcesDialog, {
            open: true,
            documentName: "导入笔记.md",
            plan: planWith("ready", "missing", "unreadable", "oversized"),
        });
        expectAccessibleDialog(dialog.host);
        expect(dialog.host.textContent).toContain("可导入");
        expect(dialog.host.textContent).toContain("缺失");
        expect(dialog.host.textContent).toContain("无法读取");
        expect(dialog.host.textContent).toContain("超限");
        expect(dialog.host.textContent).toContain("未解决的链接将保持原样");
        Array.from(dialog.host.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent?.includes("继续导入"))
            ?.click();
        expect(dialog.emitted("decide")).toEqual([["continue"]]);
    });

    it("renders the document name in the leave confirmation without changing decisions", () => {
        const dialog = mount(LeaveConfirmDialog, {
            open: true,
            documentName: "草稿.mdx",
        });
        expectAccessibleDialog(dialog.host);
        expect(dialog.host.querySelector("h2")?.textContent).toBe("保存“草稿.mdx”？");
        Array.from(dialog.host.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent?.includes("放弃修改"))
            ?.click();
        expect(dialog.emitted("decide")).toEqual([["discard"]]);
    });
});
