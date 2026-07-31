/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceSidebar, { owningRoot } from "./WorkspaceSidebar.vue";
import type { OpenDocument } from "../composables/useDocumentSession";
import type { WorkspaceFolder, WorkspaceTreeEntry } from "../types/workspace";

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

function documentItem(path: string, overrides: Partial<OpenDocument> = {}): OpenDocument {
    const segments = path.split("\\");
    return {
        id: path,
        path,
        pathIdentity: path.toLowerCase(),
        sourceKind: "mdx",
        importSourcePath: null,
        displayName: segments[segments.length - 1] ?? path,
        content: "",
        meta: null,
        dirty: false,
        diskRevision: null,
        conflict: false,
        unavailable: false,
        ...overrides,
    };
}

function untitled(): OpenDocument {
    return documentItem("untitled-1", {
        id: "untitled-1",
        path: null,
        pathIdentity: null,
        sourceKind: "untitled",
        displayName: "未命名文档 1",
    });
}

function file(path: string): WorkspaceTreeEntry {
    const segments = path.split("\\");
    return {
        path,
        name: segments[segments.length - 1] ?? path,
        kind: path.endsWith(".mdx") ? "mdx" : "md",
        children: [],
    };
}

function folder(path: string, entries: WorkspaceTreeEntry[] = []): WorkspaceFolder {
    const segments = path.split("\\");
    return {
        path,
        name: segments[segments.length - 1] ?? path,
        entries,
        entryCount: entries.length,
        truncated: false,
        unavailable: false,
        error: null,
    };
}

type SidebarProps = InstanceType<typeof WorkspaceSidebar>["$props"];

function mountSidebar(overrides: Partial<SidebarProps> = {}) {
    const emitted = new Map<string, unknown[][]>();
    const props: SidebarProps = {
        documents: [],
        folders: [],
        activeDocumentId: null,
        expandedPaths: [],
        collapsed: false,
        width: 260,
        ...overrides,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const app: App = createApp({
        render: () =>
            h(WorkspaceSidebar, {
                ...props,
                onActivate: (value: string) => record("activate", value),
                onOpenPath: (value: string) => record("open-path", value),
                onCloseDocument: (value: string) => record("close-document", value),
                onCloseFolder: (value: string) => record("close-folder", value),
                onRefreshFolder: (value: string) => record("refresh-folder", value),
                onToggleExpanded: (value: string) => record("toggle-expanded", value),
                "onUpdate:collapsed": (value: boolean) => record("update:collapsed", value),
                "onUpdate:width": (value: number) => record("update:width", value),
            }),
    });
    const record = (event: string, value: unknown) => {
        emitted.set(event, [...(emitted.get(event) ?? []), [value]]);
    };
    app.mount(host);
    cleanup = () => app.unmount();

    return {
        host,
        emitted: (event: string) => emitted.get(event),
        triggerKey: async (key: string) => {
            host.querySelector<HTMLElement>("[role=tree]")?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key }),
            );
            await nextTick();
        },
    };
}

function sectionText(sidebar: ReturnType<typeof mountSidebar>, title: string) {
    const section = Array.from(sidebar.host.querySelectorAll<HTMLElement>("section")).find(
        (item) => item.querySelector("h2")?.textContent === title,
    );
    return section?.textContent ?? "";
}

function pointerEvent(type: string, pointerId: number, clientX: number) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        clientX: { value: clientX },
    });
    return event;
}

describe("WorkspaceSidebar", () => {
    it("shows independent files separately and places folder-owned files only in the tree", () => {
        const sidebar = mountSidebar({
            documents: [
                documentItem("C:\\Root\\inside.mdx"),
                documentItem("C:\\Other\\outside.mdx"),
                untitled(),
            ],
            folders: [folder("C:\\Root", [file("C:\\Root\\inside.mdx")])],
            expandedPaths: ["C:\\Root"],
        });

        expect(sectionText(sidebar, "打开的文件")).toContain("outside.mdx");
        expect(sectionText(sidebar, "打开的文件")).toContain("未命名文档 1");
        expect(sectionText(sidebar, "打开的文件")).not.toContain("inside.mdx");
        expect(sectionText(sidebar, "打开的文件夹")).toContain("inside.mdx");
    });

    it("uses the longest folder root and supports arrows plus Enter", async () => {
        const path = "C:\\Root\\Specific\\note.mdx";
        const sidebar = mountSidebar({
            folders: [
                folder("C:\\Root", [file(path)]),
                folder("C:\\Root\\Specific", [file(path)]),
            ],
            documents: [documentItem(path)],
            expandedPaths: ["C:\\Root", "C:\\Root\\Specific"],
        });

        expect(owningRoot(path, ["C:\\Root", "C:\\Root\\Specific"])).toBe(
            "C:\\Root\\Specific",
        );
        expect(sidebar.host.textContent).toContain("Specific");
        expect(sidebar.host.textContent?.match(/note\.mdx/gu)).toHaveLength(1);
        await sidebar.triggerKey("ArrowDown");
        expect(document.activeElement?.getAttribute("data-tree-key")).toBe(
            "folder:c:\\root\\specific",
        );
        await sidebar.triggerKey("ArrowRight");
        await sidebar.triggerKey("Enter");
        expect(sidebar.emitted("activate")).toEqual([[path]]);
    });

    it("exposes document statuses and clamps pointer resizing", async () => {
        const sidebar = mountSidebar({
            documents: [
                documentItem("C:\\Other\\state.mdx", {
                    dirty: true,
                    conflict: true,
                    unavailable: true,
                }),
            ],
        });

        expect(sidebar.host.textContent).toContain("未保存");
        expect(sidebar.host.textContent).toContain("外部更改");
        expect(sidebar.host.textContent).toContain("不可用");
        const handle = sidebar.host.querySelector<HTMLElement>(".workspace-resize-handle");
        if (!handle) throw new Error("未找到侧栏缩放手柄");
        handle.dispatchEvent(pointerEvent("pointerdown", 1, 10));
        handle.dispatchEvent(pointerEvent("pointermove", 1, 500));
        handle.dispatchEvent(pointerEvent("pointerup", 1, 500));
        await nextTick();

        const expandedWidths = sidebar.emitted("update:width") ?? [];
        expect(expandedWidths[expandedWidths.length - 1]).toEqual([420]);
        handle.dispatchEvent(pointerEvent("pointerdown", 2, 10));
        handle.dispatchEvent(pointerEvent("pointermove", 2, -500));
        handle.dispatchEvent(pointerEvent("pointerup", 2, -500));
        await nextTick();
        const collapsedWidths = sidebar.emitted("update:width") ?? [];
        expect(collapsedWidths[collapsedWidths.length - 1]).toEqual([180]);
    });
});
