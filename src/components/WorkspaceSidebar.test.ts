/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceSidebar, { owningRoot } from "./WorkspaceSidebar.vue";
import type { OpenDocument } from "../composables/useDocumentSession";
import type { WorkspaceFolder, WorkspaceTreeEntry } from "../types/workspace";

let cleanup: (() => void) | undefined;
const originalMatchMedia = window.matchMedia;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
    });
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

function directory(path: string, children: WorkspaceTreeEntry[] = []): WorkspaceTreeEntry {
    const segments = path.split(/[\\/]/u);
    return {
        path,
        name: segments[segments.length - 1] ?? path,
        kind: "directory",
        children,
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

function treeItem(sidebar: ReturnType<typeof mountSidebar>, key: string) {
    const item = Array.from(sidebar.host.querySelectorAll<HTMLElement>("[role=treeitem]")).find(
        (element) => element.dataset.treeKey === key,
    );
    if (!item) throw new Error(`未找到树项 ${key}`);
    return item;
}

function dispatchKey(element: HTMLElement, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

function installMatchMedia(initialMatches: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const query = {
        matches: initialMatches,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
            listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
            listeners.delete(listener),
    };
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => query,
    });
    return {
        setMatches(matches: boolean) {
            query.matches = matches;
            const event = { matches } as MediaQueryListEvent;
            listeners.forEach((listener) => listener(event));
        },
    };
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

    it("opens and closes the sidebar locally at narrow widths without changing desktop collapse", async () => {
        const viewport = installMatchMedia(true);
        const sidebar = mountSidebar();
        await nextTick();

        expect(sidebar.host.querySelector(".workspace-sidebar")).toBeNull();
        const toggle = sidebar.host.querySelector<HTMLButtonElement>(".workspace-sidebar-toggle");
        if (!toggle) throw new Error("未找到工作区侧栏切换按钮");
        toggle.click();
        await nextTick();
        expect(sidebar.host.querySelector(".workspace-sidebar")).not.toBeNull();

        sidebar.host
            .querySelector<HTMLButtonElement>('[aria-label="收起工作区侧栏"]')
            ?.click();
        await nextTick();
        expect(sidebar.host.querySelector(".workspace-sidebar")).toBeNull();
        expect(sidebar.emitted("update:collapsed")).toBeUndefined();

        viewport.setMatches(false);
        await nextTick();
        expect(sidebar.host.querySelector(".workspace-sidebar")).not.toBeNull();
    });

    it("moves ArrowLeft from leaves and collapsed directories to the parent, but leaves roots unchanged", async () => {
        const root = "C:\\Root";
        const directoryPath = "C:\\Root\\Folder";
        const leafPath = "C:\\Root\\Folder\\note.mdx";
        const sidebar = mountSidebar({
            folders: [folder(root, [directory(directoryPath, [file(leafPath)])])],
            expandedPaths: [root, directoryPath],
        });
        const rootItem = treeItem(sidebar, "folder:c:\\root");
        const directoryItem = treeItem(sidebar, "directory:c:\\root\\folder");
        const leafItem = treeItem(sidebar, "file:c:\\root\\folder\\note.mdx");

        leafItem.focus();
        dispatchKey(leafItem, "ArrowLeft");
        await nextTick();
        expect(document.activeElement).toBe(directoryItem);

        directoryItem.focus();
        dispatchKey(directoryItem, "ArrowLeft");
        await nextTick();
        expect(sidebar.emitted("toggle-expanded")).toEqual([[directoryPath]]);

        const collapsed = mountSidebar({
            folders: [folder(root, [directory(directoryPath)])],
            expandedPaths: [root],
        });
        const collapsedDirectory = treeItem(collapsed, "directory:c:\\root\\folder");
        collapsedDirectory.focus();
        dispatchKey(collapsedDirectory, "ArrowLeft");
        await nextTick();
        expect(document.activeElement).toBe(treeItem(collapsed, "folder:c:\\root"));

        rootItem.focus();
        dispatchKey(rootItem, "ArrowLeft");
        await nextTick();
        expect(document.activeElement).toBe(rootItem);
        expect(sidebar.emitted("toggle-expanded")).toEqual([[directoryPath], [root]]);

        const collapsedRoot = mountSidebar({ folders: [folder(root)] });
        const collapsedRootItem = treeItem(collapsedRoot, "folder:c:\\root");
        collapsedRootItem.focus();
        dispatchKey(collapsedRootItem, "ArrowLeft");
        await nextTick();
        expect(document.activeElement).toBe(collapsedRootItem);
        expect(collapsedRoot.emitted("toggle-expanded")).toBeUndefined();
    });

    it("keeps close and refresh actions outside the tree key handler", async () => {
        const documentPath = "C:\\Other\\outside.mdx";
        const root = "C:\\Root";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder(root)],
        });
        const tree = sidebar.host.querySelector<HTMLElement>("[role=tree]");
        const toolbar = sidebar.host.querySelector<HTMLElement>(".workspace-action-toolbar");
        expect(tree?.querySelectorAll("button")).toHaveLength(0);
        expect(toolbar).not.toBeNull();
        expect(toolbar?.getAttribute("role")).toBe("group");
        expect(sidebar.host.querySelector('[role="toolbar"]')).toBeNull();
        expect(tree?.contains(toolbar)).toBe(false);
        const close = toolbar?.querySelector<HTMLButtonElement>('[aria-label="关闭 outside.mdx"]');
        if (!close) throw new Error("未找到文档关闭操作");

        close.focus();
        dispatchKey(close, "Enter");
        await nextTick();
        expect(document.activeElement).toBe(close);
        expect(sidebar.emitted("activate")).toBeUndefined();
        close.click();
        expect(sidebar.emitted("close-document")).toEqual([[documentPath]]);

        treeItem(sidebar, "folder:c:\\root").focus();
        await nextTick();
        const refresh = toolbar?.querySelector<HTMLButtonElement>('[aria-label="刷新 Root"]');
        if (!refresh) throw new Error("未找到文件夹刷新操作");
        refresh.focus();
        dispatchKey(refresh, " ");
        await nextTick();
        expect(document.activeElement).toBe(refresh);
        expect(sidebar.emitted("toggle-expanded")).toBeUndefined();
        refresh.click();
        expect(sidebar.emitted("refresh-folder")).toEqual([[root]]);
    });

    it("normalizes root identity before choosing an owner and rendering folders", () => {
        const root = "C:\\Root";
        const specific = "c:/ROOT/Specific/";
        const parentFile = "C:\\Root\\keep.mdx";
        const childFile = "C:\\Root\\Specific\\note.mdx";
        const sidebar = mountSidebar({
            documents: [documentItem(parentFile), documentItem(childFile)],
            folders: [
                folder(root, [file(parentFile), file(childFile)]),
                folder("c:/root/", [file(parentFile)]),
                folder(specific, [file(childFile)]),
                folder("C:\\ROOT\\SPECIFIC", [file(childFile)]),
            ],
            expandedPaths: [root, specific],
        });

        expect(
            owningRoot(childFile, ["C:/ROOT/", specific, "C:\\ROOT\\SPECIFIC"]),
        ).toBe(specific);
        const folderKeys = Array.from(
            sidebar.host.querySelectorAll<HTMLElement>("[data-tree-key]"),
            (element) => element.dataset.treeKey,
        );
        expect(folderKeys.filter((key) => key === "folder:c:\\root")).toHaveLength(1);
        expect(folderKeys.filter((key) => key === "folder:c:\\root\\specific")).toHaveLength(1);
        expect(sidebar.host.textContent?.match(/keep\.mdx/gu)).toHaveLength(1);
        expect(sidebar.host.textContent?.match(/note\.mdx/gu)).toHaveLength(1);
    });
});
