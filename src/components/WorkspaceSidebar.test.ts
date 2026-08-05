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

function directory(
    path: string,
    children: WorkspaceTreeEntry[] = [],
): WorkspaceTreeEntry {
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
type WorkspaceSidebarPublic = {
    focusDocument: (id: string) => Promise<void>;
    focusFirstAvailable: () => Promise<void>;
};

function mountSidebar(overrides: Partial<SidebarProps> = {}) {
    const emitted = new Map<string, unknown[][]>();
    const props: SidebarProps = {
        documents: [],
        folders: [],
        activeDocumentId: null,
        expandedPaths: [],
        visible: true,
        compact: false,
        width: 260,
        ...overrides,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const record = (event: string, ...values: unknown[]) => {
        emitted.set(event, [...(emitted.get(event) ?? []), values]);
    };
    const app: App = createApp(WorkspaceSidebar, {
        ...props,
        onActivate: (value: string) => record("activate", value),
        onOpenPath: (value: string) => record("open-path", value),
        onOpenFolder: () => record("open-folder"),
        onCloseDocument: (value: string) => record("close-document", value),
        onCloseFolder: (value: string) => record("close-folder", value),
        onRefreshFolder: (value: string) => record("refresh-folder", value),
        onToggleExpanded: (value: string) => record("toggle-expanded", value),
        "onUpdate:width": (value: number) => record("update:width", value),
    });
    const component = app.mount(host) as unknown as WorkspaceSidebarPublic;
    cleanup = () => app.unmount();

    return {
        host,
        component,
        emitted: (event: string) => emitted.get(event),
        triggerKey: async (key: string) => {
            host.querySelector<HTMLElement>("[role=tree]")?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key }),
            );
            await nextTick();
        },
    };
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
    const item = Array.from(
        sidebar.host.querySelectorAll<HTMLElement>("[role=treeitem]"),
    ).find((element) => element.dataset.treeKey === key);
    if (!item) throw new Error(`未找到树项 ${key}`);
    return item;
}

function dispatchKey(element: HTMLElement, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

describe("WorkspaceSidebar", () => {
    it("renders every open document before folder roots and keeps folder duplicates", () => {
        const sidebar = mountSidebar({
            documents: [
                documentItem("C:\\Root\\inside.mdx"),
                documentItem("C:\\Other\\outside.mdx"),
                documentItem("C:\\imports\\draft.md", {
                    id: "imported-draft",
                    path: null,
                    pathIdentity: null,
                    sourceKind: "markdown-import",
                    importSourcePath: "C:\\imports\\draft.md",
                    displayName: "draft.md",
                }),
                untitled(),
            ],
            folders: [folder("C:\\Root", [file("C:\\Root\\inside.mdx")])],
            expandedPaths: ["C:\\Root"],
        });

        expect(sidebar.host.textContent).toContain("已打开文件");
        expect(sidebar.host.textContent).toContain("文件夹");
        expect(sidebar.host.textContent).toContain("outside.mdx");
        expect(sidebar.host.textContent).toContain("draft.md");
        expect(sidebar.host.textContent).toContain("未命名文档 1");
        expect(sidebar.host.textContent).toContain("inside.mdx");
        expect(sidebar.host.textContent?.match(/inside\.mdx/gu)).toHaveLength(2);
        const keys = Array.from(
            sidebar.host.querySelectorAll<HTMLElement>("[role=treeitem]"),
            (item) => item.dataset.treeKey,
        );
        expect(keys.slice(0, 4)).toEqual([
            "document:c:\\root\\inside.mdx",
            "document:c:\\other\\outside.mdx",
            "document:imported-draft",
            "document:untitled-1",
        ]);
    });

    it("maps an active Markdown import to its folder copy with document state and activation", async () => {
        const sourcePath = "C:\\notes\\draft.md";
        const documentId = "markdown-import-draft";
        const sidebar = mountSidebar({
            documents: [
                documentItem(sourcePath, {
                    id: documentId,
                    path: null,
                    pathIdentity: sourcePath.toLowerCase(),
                    sourceKind: "markdown-import",
                    importSourcePath: sourcePath,
                    displayName: "draft.md",
                    dirty: true,
                    unavailable: true,
                }),
            ],
            folders: [folder("C:\\notes", [file(sourcePath)])],
            activeDocumentId: documentId,
            expandedPaths: ["C:\\notes"],
        });

        expect(sidebar.host.textContent?.match(/draft\.md/gu)).toHaveLength(2);
        const openCopy = treeItem(sidebar, `document:${documentId}`);
        const folderCopy = treeItem(sidebar, "file:c:\\notes\\draft.md");
        expect(openCopy.getAttribute("aria-current")).toBe("page");
        expect(folderCopy.getAttribute("aria-current")).toBe("page");
        expect(folderCopy.getAttribute("aria-label")).toBe(
            "draft.md，未保存，不可用",
        );

        folderCopy.click();
        await nextTick();

        expect(sidebar.emitted("activate")).toEqual([[documentId]]);
        expect(sidebar.emitted("open-path")).toBeUndefined();
    });

    it("shows the open-document empty state and keeps opening a folder available", () => {
        const sidebar = mountSidebar();

        expect(sidebar.host.textContent).toContain("没有打开文件");
        expect(
            sidebar.host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹"]'),
        ).not.toBeNull();
    });

    it("offers opening a folder when the workspace has no roots", () => {
        const sidebar = mountSidebar();
        sidebar.host
            .querySelector<HTMLButtonElement>('[aria-label="打开文件夹"]')
            ?.click();
        expect(sidebar.emitted("open-folder")).toEqual([[]]);
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
        expect(sidebar.host.textContent?.match(/note\.mdx/gu)).toHaveLength(2);
        await sidebar.triggerKey("ArrowDown");
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
                documentItem("C:\\Root\\state.mdx", {
                    dirty: true,
                    conflict: true,
                    unavailable: true,
                }),
            ],
            folders: [folder("C:\\Root", [file("C:\\Root\\state.mdx")])],
            expandedPaths: ["C:\\Root"],
        });

        expect(sidebar.host.textContent).toContain("未保存");
        expect(sidebar.host.textContent).toContain("外部更改");
        expect(sidebar.host.textContent).toContain("不可用");
        const documentRow = treeItem(sidebar, "document:c:\\root\\state.mdx");
        expect(documentRow.getAttribute("aria-label")).toBe(
            "state.mdx，未保存，外部更改，不可用",
        );
        sidebar.host
            .querySelector<HTMLButtonElement>('[aria-label="关闭 state.mdx"]')
            ?.click();
        expect(sidebar.emitted("close-document")).toEqual([["C:\\Root\\state.mdx"]]);
        const handle = sidebar.host.querySelector<HTMLElement>(
            ".workspace-resize-handle",
        );
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

    it("activates and closes open documents without changing folder browsing", async () => {
        const sidebar = mountSidebar({
            documents: [documentItem("C:\\notes\\a.mdx"), untitled()],
            folders: [folder("C:\\notes", [file("C:\\notes\\a.mdx")])],
            expandedPaths: ["C:\\notes"],
        });

        treeItem(sidebar, "document:c:\\notes\\a.mdx").click();
        sidebar.host
            .querySelector<HTMLButtonElement>('[aria-label="关闭 未命名文档 1"]')
            ?.click();
        await nextTick();

        expect(sidebar.emitted("activate")).toEqual([["C:\\notes\\a.mdx"]]);
        expect(sidebar.emitted("close-document")).toEqual([["untitled-1"]]);
    });

    it("closes only the focused document row when Delete is pressed", async () => {
        const documentPath = "C:\\notes\\a.mdx";
        const root = "C:\\notes";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder(root, [file(documentPath)])],
            expandedPaths: [root],
        });
        const documentRow = treeItem(sidebar, "document:c:\\notes\\a.mdx");
        const folderRow = treeItem(sidebar, "folder:c:\\notes");
        const fileRow = treeItem(sidebar, "file:c:\\notes\\a.mdx");

        documentRow.focus();
        dispatchKey(documentRow, "Delete");
        folderRow.focus();
        dispatchKey(folderRow, "Delete");
        fileRow.focus();
        dispatchKey(fileRow, "Delete");
        await nextTick();

        expect(sidebar.emitted("close-document")).toEqual([[documentPath]]);
    });

    it("moves between open documents and folder roots with ArrowDown and ArrowUp", async () => {
        const documentPath = "C:\\notes\\a.mdx";
        const root = "C:\\notes";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder(root)],
        });
        const documentRow = treeItem(sidebar, "document:c:\\notes\\a.mdx");

        documentRow.focus();
        dispatchKey(documentRow, "ArrowDown");
        await nextTick();
        expect(document.activeElement?.getAttribute("data-tree-key")).toBe("folder:c:\\notes");

        dispatchKey(treeItem(sidebar, "folder:c:\\notes"), "ArrowUp");
        await nextTick();
        expect(document.activeElement?.getAttribute("data-tree-key")).toBe(
            "document:c:\\notes\\a.mdx",
        );
    });

    it("keeps document close buttons keyboard-focusable and labels them by document name", () => {
        const sidebar = mountSidebar({ documents: [untitled()] });
        const closeButton = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭 未命名文档 1"]',
        );

        expect(closeButton?.tabIndex).toBe(0);
        expect(closeButton?.getAttribute("aria-label")).toContain("未命名文档 1");
    });

    it("uses legal ARIA composite groups and semantic rows that own their actions", () => {
        const documentPath = "C:\\notes\\a.mdx";
        const root = "C:\\notes";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder(root)],
        });
        const tree = sidebar.host.querySelector<HTMLElement>('[role="tree"]');
        if (!tree) throw new Error("未找到工作区树");

        expect(
            Array.from(tree.children, (element) => element.getAttribute("role")),
        ).toEqual(["group", "group"]);
        expect(tree.querySelector('[role="region"]')).toBeNull();
        const documentRow = treeItem(sidebar, "document:c:\\notes\\a.mdx");
        const folderRow = treeItem(sidebar, "folder:c:\\notes");
        const documentClose = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭 a.mdx"]',
        );
        const refresh = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="刷新 notes"]',
        );
        const folderClose = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭文件夹 notes"]',
        );

        expect(documentRow.classList.contains("workspace-tree-row")).toBe(true);
        expect(folderRow.classList.contains("workspace-tree-row")).toBe(true);
        expect(documentClose && documentRow.contains(documentClose)).toBe(true);
        expect(refresh && folderRow.contains(refresh)).toBe(true);
        expect(folderClose && folderRow.contains(folderClose)).toBe(true);
    });

    it("keeps ARIA composite action-button keys scoped to the action only", async () => {
        const documentPath = "C:\\notes\\a.mdx";
        const root = "C:\\notes";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder(root)],
        });
        const documentRow = treeItem(sidebar, "document:c:\\notes\\a.mdx");
        const folderRow = treeItem(sidebar, "folder:c:\\notes");
        const documentClose = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭 a.mdx"]',
        );
        const refresh = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="刷新 notes"]',
        );
        const folderClose = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭文件夹 notes"]',
        );
        if (!documentClose || !refresh || !folderClose) {
            throw new Error("未找到工作区行操作按钮");
        }
        expect(documentRow.contains(documentClose)).toBe(true);
        expect(folderRow.contains(refresh)).toBe(true);
        expect(folderRow.contains(folderClose)).toBe(true);

        documentClose.focus();
        dispatchKey(documentClose, "Enter");
        documentClose.click();
        refresh.focus();
        dispatchKey(refresh, "Enter");
        refresh.click();
        folderClose.focus();
        dispatchKey(folderClose, " ");
        folderClose.click();
        await nextTick();

        expect(sidebar.emitted("close-document")).toEqual([[documentPath]]);
        expect(sidebar.emitted("refresh-folder")).toEqual([[root]]);
        expect(sidebar.emitted("close-folder")).toEqual([[root]]);
        expect(sidebar.emitted("activate")).toBeUndefined();
        expect(sidebar.emitted("toggle-expanded")).toBeUndefined();
    });

    it("keeps empty-state controls outside the ARIA composite", () => {
        const sidebar = mountSidebar({ documents: [untitled()] });
        const tree = sidebar.host.querySelector<HTMLElement>('[role="tree"]');
        const openFolder = sidebar.host.querySelector<HTMLButtonElement>(
            '[aria-label="打开文件夹"]',
        );

        expect(tree).not.toBeNull();
        expect(openFolder).not.toBeNull();
        expect(tree?.contains(openFolder ?? null)).toBe(false);
    });

    it("marks the active document in both open documents and folder browsing", () => {
        const documentPath = "C:\\notes\\a.mdx";
        const sidebar = mountSidebar({
            documents: [documentItem(documentPath)],
            folders: [folder("C:\\notes", [file(documentPath)])],
            activeDocumentId: documentPath,
            expandedPaths: ["C:\\notes"],
        });

        expect(treeItem(sidebar, "document:c:\\notes\\a.mdx").getAttribute("aria-current")).toBe(
            "page",
        );
        expect(treeItem(sidebar, "file:c:\\notes\\a.mdx").getAttribute("aria-current")).toBe(
            "page",
        );
    });

    it("focuses a requested open document through the public focus API", async () => {
        const documentPath = "C:\\notes\\a.mdx";
        const sidebar = mountSidebar({ documents: [documentItem(documentPath)] });

        await sidebar.component.focusDocument(documentPath);

        expect(document.activeElement).toBe(
            treeItem(sidebar, "document:c:\\notes\\a.mdx"),
        );
    });

    it("focuses the first folder root or the open-folder button through the public focus API", async () => {
        const documentPath = "C:\\notes\\a.mdx";
        const withDocument = mountSidebar({ documents: [documentItem(documentPath)] });

        await withDocument.component.focusFirstAvailable();

        expect(document.activeElement).toBe(
            treeItem(withDocument, "document:c:\\notes\\a.mdx"),
        );

        cleanup?.();
        const root = "C:\\notes";
        const withFolder = mountSidebar({ folders: [folder(root)] });

        await withFolder.component.focusFirstAvailable();

        expect(document.activeElement).toBe(treeItem(withFolder, "folder:c:\\notes"));

        cleanup?.();
        const empty = mountSidebar();
        await empty.component.focusFirstAvailable();

        expect(document.activeElement).toBe(
            empty.host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹"]'),
        );
    });

    it("renders compact visibility only from controlled props without a floating toggle", () => {
        const compact = mountSidebar({ visible: true, compact: true });
        expect(
            compact.host.querySelector(".workspace-sidebar.is-compact"),
        ).not.toBeNull();
        expect(compact.host.querySelector(".workspace-sidebar-toggle")).toBeNull();

        const hidden = mountSidebar({ visible: false, compact: true });
        expect(hidden.host.querySelector(".workspace-sidebar")).toBeNull();
        expect(hidden.host.querySelector(".workspace-sidebar-toggle")).toBeNull();
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

    it("renders folder refresh and close actions inside the root tree item without toggling it", async () => {
        const root = "C:\\Root";
        const sidebar = mountSidebar({
            folders: [folder(root)],
        });
        const tree = sidebar.host.querySelector<HTMLElement>("[role=tree]");
        const rootRow = treeItem(sidebar, "folder:c:\\root");
        const actions = rootRow.querySelector<HTMLElement>(
            ".workspace-row-actions",
        );
        const refresh = actions?.querySelector<HTMLButtonElement>(
            '[aria-label="刷新 Root"]',
        );
        const close = actions?.querySelector<HTMLButtonElement>(
            '[aria-label="关闭文件夹 Root"]',
        );

        expect(tree?.contains(rootRow)).toBe(true);
        expect(sidebar.host.querySelector(".workspace-action-toolbar")).toBeNull();
        expect(actions?.parentElement).toBe(rootRow);
        if (!refresh) throw new Error("未找到文件夹刷新操作");
        if (!close) throw new Error("未找到文件夹关闭操作");

        refresh.click();
        await nextTick();
        expect(sidebar.emitted("toggle-expanded")).toBeUndefined();
        expect(sidebar.emitted("refresh-folder")).toEqual([[root]]);

        close.click();
        await nextTick();
        expect(sidebar.emitted("toggle-expanded")).toBeUndefined();
        expect(sidebar.emitted("close-folder")).toEqual([[root]]);
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

        expect(owningRoot(childFile, ["C:/ROOT/", specific, "C:\\ROOT\\SPECIFIC"])).toBe(
            specific,
        );
        const folderKeys = Array.from(
            sidebar.host.querySelectorAll<HTMLElement>("[data-tree-key]"),
            (element) => element.dataset.treeKey,
        );
        expect(folderKeys.filter((key) => key === "folder:c:\\root")).toHaveLength(1);
        expect(
            folderKeys.filter((key) => key === "folder:c:\\root\\specific"),
        ).toHaveLength(1);
        expect(sidebar.host.textContent?.match(/keep\.mdx/gu)).toHaveLength(2);
        expect(sidebar.host.textContent?.match(/note\.mdx/gu)).toHaveLength(2);
    });
});
