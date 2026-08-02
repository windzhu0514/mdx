/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import RecentFilesDialog from "./RecentFilesDialog.vue";
import type { RecentFileEntry } from "../types/workspace";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function recentEntries(count: number, unavailableIndex?: number): RecentFileEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        path: `C:\\Notes\\note-${index + 1}.mdx`,
        title: `笔记 ${index + 1}`,
        lastOpenedAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`,
        available: index + 1 !== unavailableIndex,
    }));
}

function mountRecent(entries: RecentFileEntry[]) {
    const emitted = new Map<string, unknown[][]>();
    const record = (event: string, value?: string) => {
        const call = value === undefined ? [] : [value];
        emitted.set(event, [...(emitted.get(event) ?? []), call]);
    };
    const host = document.createElement("div");
    document.body.append(host);
    const app: App = createApp({
        render: () =>
            h(RecentFilesDialog, {
                open: true,
                entries,
                onOpenFile: (path: string) => record("open-file", path),
                onRemoveFile: (path: string) => record("remove-file", path),
                onClear: () => record("clear"),
                onClose: () => record("close"),
            }),
    });
    app.mount(host);
    cleanup = () => app.unmount();

    return {
        emitted: (event: string) => emitted.get(event),
        rows: () => Array.from(host.querySelectorAll<HTMLElement>("[data-recent-path]")),
        search: async (query: string) => {
            const input = host.querySelector<HTMLInputElement>('input[type="search"]');
            if (!input) throw new Error("未找到最近文件搜索框");
            input.value = query;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await nextTick();
        },
    };
}

describe("RecentFilesDialog", () => {
    it("filters only the first fifty entries and keeps unavailable entries actionable", async () => {
        const dialog = mountRecent(recentEntries(51, 3));

        await dialog.search("note-3");
        expect(dialog.rows()).toHaveLength(11);
        const unavailable = dialog
            .rows()
            .find((row) => row.dataset.recentPath?.endsWith("note-3.mdx"));
        if (!unavailable) throw new Error("未找到不可用的最近文件");
        expect(unavailable.textContent).toContain("不可用");

        unavailable.querySelector<HTMLButtonElement>(".recent-file-open")?.click();
        unavailable.querySelector<HTMLButtonElement>(".recent-file-remove")?.click();
        await nextTick();
        expect(dialog.emitted("open-file")).toEqual([["C:\\Notes\\note-3.mdx"]]);
        expect(dialog.emitted("remove-file")).toEqual([["C:\\Notes\\note-3.mdx"]]);
    });

    it("provides labeled search, clear-all, and close actions", () => {
        const dialog = mountRecent(recentEntries(1));
        expect(
            document.querySelector('input[aria-label="搜索最近打开的文件"]'),
        ).not.toBeNull();
        document.querySelector<HTMLButtonElement>(".recent-files-clear")?.click();
        document.querySelector<HTMLButtonElement>(".recent-files-close")?.click();
        expect(dialog.emitted("clear")).toEqual([[]]);
        expect(dialog.emitted("close")).toEqual([[]]);
    });
});
