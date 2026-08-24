/** @vitest-environment jsdom */

import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentListItem } from "../types/mdx";
import AttachmentPanel from "./AttachmentPanel.vue";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function attachment(
    path: string,
    originalName: string,
    referenced = false,
): AttachmentListItem {
    return {
        id: path,
        originalName,
        storedName: path.split("/").pop() ?? originalName,
        path,
        type: "application/pdf",
        size: 1536,
        createdAt: "2026-08-24T12:00:00.000Z",
        referenced,
    };
}

function mountPanel(items: AttachmentListItem[] = []) {
    const host = document.createElement("div");
    document.body.append(host);
    const events = {
        close: vi.fn(),
        add: vi.fn(),
        openAttachment: vi.fn(),
        saveAttachment: vi.fn(),
        insertAttachment: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
    };
    const app = createApp({
        render: () =>
            h(AttachmentPanel, {
                open: true,
                documentName: "项目.mdx",
                items,
                onClose: events.close,
                onAdd: events.add,
                onOpenAttachment: events.openAttachment,
                onSaveAttachment: events.saveAttachment,
                onInsertAttachment: events.insertAttachment,
                onRename: events.rename,
                onRemove: events.remove,
            }),
    });
    app.mount(host);
    cleanup = () => app.unmount();
    return { host, events };
}

function row(host: HTMLElement, path: string) {
    const found = Array.from(host.querySelectorAll<HTMLElement>(".attachment-row")).find(
        (item) => item.dataset.path === path,
    );
    if (!found) throw new Error(`未找到附件行：${path}`);
    return found;
}

function button(container: ParentNode, label: string) {
    const found = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((item) => item.textContent?.trim() === label);
    if (!found) throw new Error(`未找到按钮：${label}`);
    return found;
}

describe("AttachmentPanel", () => {
    it("renders an accessible focused list with reference state", async () => {
        const { host } = mountPanel([
            attachment("attachments/a.pdf", "a.pdf", true),
            attachment("attachments/b.zip", "b.zip"),
        ]);
        const dialog = host.querySelector<HTMLElement>('[role="dialog"]');

        expect(dialog?.getAttribute("aria-labelledby")).toBe("attachment-title");
        await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
        expect(host.textContent).toContain("项目.mdx");
        expect(host.textContent).toContain("2 个附件");
        expect(row(host, "attachments/a.pdf").textContent).toContain("正文已引用");
        expect(row(host, "attachments/b.zip").textContent).toContain("未引用");
        const referencedDelete = button(row(host, "attachments/a.pdf"), "删除");
        expect(referencedDelete.disabled).toBe(true);
        expect(referencedDelete.title).toContain("先移除正文引用");
        expect(button(row(host, "attachments/b.zip"), "删除").disabled).toBe(false);
    });

    it("emits add, insert, open and save actions with the exact attachment path", async () => {
        const path = "attachments/a.pdf";
        const { host, events } = mountPanel([attachment(path, "a.pdf")]);
        const attachmentRow = row(host, path);

        button(host, "添加附件").click();
        button(attachmentRow, "插入引用").click();
        button(attachmentRow, "打开").click();
        button(attachmentRow, "另存为").click();
        await nextTick();

        expect(events.add).toHaveBeenCalledTimes(1);
        expect(events.insertAttachment).toHaveBeenCalledWith(path);
        expect(events.openAttachment).toHaveBeenCalledWith(path);
        expect(events.saveAttachment).toHaveBeenCalledWith(path);
    });

    it("validates inline rename before emitting a trimmed display name", async () => {
        const path = "attachments/a.pdf";
        const { host, events } = mountPanel([attachment(path, "a.pdf")]);
        button(row(host, path), "重命名").click();
        await nextTick();
        const input = host.querySelector<HTMLInputElement>(".attachment-rename-input");
        if (!input) throw new Error("未找到重命名输入框");

        input.value = "   ";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        button(row(host, path), "保存名称").click();
        await nextTick();
        expect(events.rename).not.toHaveBeenCalled();
        expect(row(host, path).textContent).toContain("文件名不能为空");

        input.value = "  方案终稿.pdf  ";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        button(row(host, path), "保存名称").click();
        await nextTick();
        expect(events.rename).toHaveBeenCalledWith(path, "方案终稿.pdf");
    });

    it("requires confirmation before removal and lets Escape cancel the local action", async () => {
        const path = "attachments/a.pdf";
        const { host, events } = mountPanel([attachment(path, "a.pdf")]);
        const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) throw new Error("未找到附件对话面板");

        button(row(host, path), "删除").click();
        await nextTick();
        expect(events.remove).not.toHaveBeenCalled();
        expect(row(host, path).textContent).toContain("确认从文档中删除此附件？");

        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await nextTick();
        expect(row(host, path).textContent).not.toContain("确认从文档中删除此附件？");
        expect(events.close).not.toHaveBeenCalled();

        button(row(host, path), "删除").click();
        await nextTick();
        button(row(host, path), "确认删除").click();
        expect(events.remove).toHaveBeenCalledWith(path);

        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(events.close).toHaveBeenCalledTimes(1);
    });

    it("shows a useful empty state", () => {
        const { host } = mountPanel();
        expect(host.textContent).toContain("还没有附件");
        expect(host.textContent).toContain("添加附件");
    });
});
