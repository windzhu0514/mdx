/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type App, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExternalConflictDialog from "./ExternalConflictDialog.vue";
import LeaveConfirmDialog from "./LeaveConfirmDialog.vue";
import MarkdownResourcesDialog from "./MarkdownResourcesDialog.vue";
import RecentFilesDialog from "./RecentFilesDialog.vue";
import type { MarkdownResourcePlan } from "../types/workspace";

let cleanup: (() => void) | undefined;

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
    });
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function mount(component: Component, props: Record<string, unknown>) {
    const emitted = new Map<string, unknown[][]>();
    const isOpen = ref(Boolean(props.open));
    const host = document.createElement("div");
    document.body.append(host);
    const app: App = createApp({
        render: () =>
            h(component, {
                ...props,
                open: isOpen.value,
                onDecide: (decision: string) =>
                    emitted.set("decide", [...(emitted.get("decide") ?? []), [decision]]),
            }),
    });
    app.mount(host);
    cleanup = () => app.unmount();
    return {
        host,
        emitted: (event: string) => emitted.get(event),
        setOpen: async (open: boolean) => {
            isOpen.value = open;
            await nextTick();
        },
    };
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
    it("offers all conflict outcomes and explains both destructive risks", () => {
        const dialog = mount(ExternalConflictDialog, {
            open: true,
            documentName: "note.mdx",
        });
        expectAccessibleDialog(dialog.host);
        expect(dialog.host.querySelector("button[autofocus]")?.textContent).toContain(
            "取消",
        );
        expect(dialog.host.textContent).toContain("重新加载会放弃当前未保存的编辑");
        expect(dialog.host.textContent).toContain("覆盖会永久替换磁盘上的新版本");

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

    it("maps resource cancel action to the existing cancel decision", () => {
        const dialog = mount(MarkdownResourcesDialog, {
            open: true,
            documentName: "导入笔记.md",
            plan: planWith("missing"),
        });
        Array.from(dialog.host.querySelectorAll<HTMLButtonElement>("button"))
            .find((button) => button.textContent?.includes("取消"))
            ?.click();
        expect(dialog.emitted("decide")).toEqual([["cancel"]]);
    });

    it("renders the document name and keeps save, discard, and cancel decisions", () => {
        const dialog = mount(LeaveConfirmDialog, {
            open: true,
            documentName: "草稿.mdx",
        });
        expectAccessibleDialog(dialog.host);
        expect(dialog.host.querySelector("h2")?.textContent).toBe("保存“草稿.mdx”？");
        const buttons = Array.from(
            dialog.host.querySelectorAll<HTMLButtonElement>("button"),
        );
        buttons.find((button) => button.textContent?.includes("保存并继续"))?.click();
        buttons.find((button) => button.textContent?.includes("放弃修改"))?.click();
        buttons.find((button) => button.textContent?.includes("取消"))?.click();
        expect(dialog.emitted("decide")).toEqual([["save"], ["discard"], ["cancel"]]);
    });

    it("opens each decision surface as a native modal and maps native cancel", async () => {
        const cases: Array<[Component, Record<string, unknown>, string]> = [
            [ExternalConflictDialog, { open: true, documentName: "note.mdx" }, "cancel"],
            [
                MarkdownResourcesDialog,
                {
                    open: true,
                    documentName: "note.md",
                    plan: planWith("ready"),
                },
                "cancel",
            ],
            [LeaveConfirmDialog, { open: true, documentName: "note.mdx" }, "cancel"],
        ];

        for (const [component, props, decision] of cases) {
            cleanup?.();
            cleanup = undefined;
            document.body.innerHTML = "";
            vi.mocked(HTMLDialogElement.prototype.showModal).mockClear();
            const mounted = mount(component, props);
            await nextTick();
            const element = mounted.host.querySelector("dialog");

            expect(element).not.toBeNull();
            expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
            element?.dispatchEvent(new Event("cancel", { cancelable: true }));
            expect(mounted.emitted("decide")).toEqual([[decision]]);
        }
    });

    it("keeps the native dialog mounted but removes closed dialog content", async () => {
        const cases: Array<[Component, Record<string, unknown>, string]> = [
            [RecentFilesDialog, { open: true, entries: [] }, "搜索最近打开的文件"],
            [
                ExternalConflictDialog,
                { open: true, documentName: "note.mdx" },
                "检测到外部更改",
            ],
            [
                MarkdownResourcesDialog,
                {
                    open: true,
                    documentName: "note.md",
                    plan: planWith("ready"),
                },
                "Markdown 资源检查",
            ],
            [
                LeaveConfirmDialog,
                { open: true, documentName: "note.mdx" },
                "当前内容尚未保存",
            ],
        ];

        for (const [component, props, content] of cases) {
            cleanup?.();
            cleanup = undefined;
            document.body.innerHTML = "";
            vi.mocked(HTMLDialogElement.prototype.close).mockClear();
            vi.mocked(HTMLDialogElement.prototype.showModal).mockClear();
            const mounted = mount(component, props);
            await nextTick();
            expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
            expect(mounted.host.textContent).toContain(content);
            await mounted.setOpen(false);

            expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
            expect(mounted.host.querySelector("dialog")).not.toBeNull();
            expect(mounted.host.textContent).not.toContain(content);
        }
    });
});
