/** @vitest-environment jsdom */

import { createApp, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    closeHandler: undefined as
        ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
    focusHandler: undefined as ((event: { payload: boolean }) => Promise<void>) | undefined,
    editorUpdate: undefined as ((markdown: string) => void) | undefined,
    aiKeyConfigured: false,
    aiKeyStatusResponses: [] as Array<boolean | Promise<boolean>>,
    getMoraEditorAiProvider: undefined as (() => unknown) | undefined,
    getMoraEditorMarkdown: undefined as (() => string) | undefined,
    moraEditorMounted: vi.fn(),
    cancelAi: vi.fn(),
    releaseDocument: vi.fn(),
    openDialog: vi.fn(),
    saveDialog: vi.fn(),
    openMdxFailures: new Set<string>(),
    saveFailures: new Set<string>(),
    drafts: new Map<
        string,
        {
            path: string | null;
            title: string;
            content: string;
            meta: Record<string, unknown> | null;
            newResources: unknown[];
            updatedAt: string;
        }
    >(),
    diskContents: new Map<string, string>(),
    diskRevisions: new Map<string, number>(),
    workspaceSession: null as null | {
        version: 1;
        documents: Array<{
            id: string;
            path: string | null;
            sourceKind: "mdx" | "markdown-import" | "untitled";
            importSourcePath: string | null;
            draftKey: string;
        }>;
        folderPaths: string[];
        expandedPaths: string[];
        activeDocumentId: string | null;
        sidebarCollapsed: boolean;
        sidebarWidth: number;
    },
    getCurrentWindow: vi.fn(() => ({
        onDragDropEvent: vi.fn(async () => () => undefined),
        onCloseRequested: vi.fn(
            async (handler: (event: { preventDefault: () => void }) => Promise<void>) => {
                mocks.closeHandler = handler;
                return () => undefined;
            },
        ),
        onFocusChanged: vi.fn(
            async (handler: (event: { payload: boolean }) => Promise<void>) => {
                mocks.focusHandler = handler;
                return () => undefined;
            },
        ),
        close: mocks.windowClose,
    })),
    invoke: vi.fn(async (command: string, args?: unknown) => {
        if (command === "has_ai_api_key") {
            const response = mocks.aiKeyStatusResponses.shift();
            return response ?? mocks.aiKeyConfigured;
        }
        if (command === "save_ai_api_key") {
            mocks.aiKeyConfigured = true;
            return undefined;
        }
        if (command === "delete_ai_api_key") {
            mocks.aiKeyConfigured = false;
            return undefined;
        }
        if (command === "get_recent_files" || command === "push_recent_file") return [];
        if (command === "read_workspace_session") {
            return { session: mocks.workspaceSession, warning: null };
        }
        if (command === "read_draft") {
            return mocks.drafts.get((args as { key: string }).key) ?? null;
        }
        if (
            command === "write_workspace_session" ||
            command === "write_draft" ||
            command === "delete_draft"
        ) {
            return undefined;
        }
        if (command === "resolve_path") {
            const path = (args as { path: string }).path;
            return { path, identity: path.toLowerCase(), available: true };
        }
        if (command === "get_disk_revisions") {
            return (args as { paths: string[] }).paths.map((path) => ({
                path,
                available: true,
                revision: {
                    path,
                    modifiedAtMs: mocks.diskRevisions.get(path.toLowerCase()) ?? 1,
                    size: 1,
                },
                error: null,
            }));
        }
        if (command === "open_mdx") {
            const path = (args as { path: string }).path;
            if (mocks.openMdxFailures.has(path)) throw new Error(`无法打开 ${path}`);
            const name =
                path
                    .split(/[\\/]/)
                    .pop()
                    ?.replace(/\.mdx$/iu, "") ?? "笔记";
            const diskContent = mocks.diskContents.get(path.toLowerCase()) ?? `# ${name}`;
            return {
                path,
                title: name,
                content: diskContent,
                meta: {
                    id: name,
                    title: name,
                    createdAt: "",
                    updatedAt: "",
                    wordCount: 0,
                    assets: diskContent.includes("assets/restored.png")
                        ? [
                              {
                                  path: "assets/restored.png",
                                  originalName: "restored.png",
                                  type: "image/png",
                                  size: 1,
                              },
                          ]
                        : [],
                    attachments: [],
                },
            };
        }
        if (command === "read_asset") return "YQ==";
        if (command === "save_mdx") {
            const request = (
                args as {
                    request: {
                        path: string;
                        title: string;
                        content: string;
                        meta: Record<string, unknown> | null;
                    };
                }
            ).request;
            if (mocks.saveFailures.has(request.path.toLowerCase())) {
                throw new Error(`无法保存 ${request.path}`);
            }
            return {
                path: request.path,
                title: request.title,
                content: request.content,
                meta: request.meta ?? {
                    id: request.title,
                    title: request.title,
                    createdAt: "",
                    updatedAt: "",
                    wordCount: 0,
                    assets: [],
                    attachments: [],
                },
            };
        }
        if (command === "save_mdx_as") {
            const payload = args as {
                path: string;
                request: {
                    title: string;
                    content: string;
                    meta: Record<string, unknown> | null;
                };
            };
            return {
                path: payload.path,
                title: payload.request.title,
                content: payload.request.content,
                meta: payload.request.meta ?? {
                    id: payload.request.title,
                    title: payload.request.title,
                    createdAt: "",
                    updatedAt: "",
                    wordCount: 0,
                    assets: [],
                    attachments: [],
                },
            };
        }
        if (command === "scan_workspace_folder") {
            const path = (args as { path: string }).path;
            return { path, entries: [], entryCount: 0, truncated: false };
        }
        if (command === "create_mdx") {
            return {
                path: null,
                title: "无标题笔记",
                content: "",
                meta: {
                    id: "test-note",
                    title: "无标题笔记",
                    createdAt: "",
                    updatedAt: "",
                    wordCount: 0,
                    assets: [],
                    attachments: [],
                },
            };
        }
        return undefined;
    }),
    isTauri: vi.fn(() => false),
    windowClose: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: mocks.invoke,
    isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: mocks.getCurrentWindow,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: mocks.openDialog,
    save: mocks.saveDialog,
}));

vi.mock("./components/editor/MoraEditor.vue", async () => {
    const { defineComponent, h } = await import("vue");
    return {
        default: defineComponent({
            name: "MoraEditorStub",
            inheritAttrs: false,
            props: {
                documentId: { type: String, required: true },
                modelValue: { type: String, required: true },
                displayValue: { type: String, default: undefined },
                mode: { type: String, required: true },
                sourcePreview: { type: Boolean, required: true },
                aiProvider: { type: Function, default: undefined },
            },
            emits: ["update:modelValue", "ai-error"],
            setup(props, { emit, expose }) {
                mocks.moraEditorMounted();
                mocks.editorUpdate = (markdown) => emit("update:modelValue", markdown);
                mocks.getMoraEditorAiProvider = () => props.aiProvider;
                mocks.getMoraEditorMarkdown = () => props.displayValue ?? props.modelValue;
                expose({
                    cancelAi: mocks.cancelAi,
                    execute: vi.fn(),
                    focus: vi.fn(),
                    getSelectedText: vi.fn(() => ""),
                    moveCursor: vi.fn(),
                    replaceSelection: vi.fn(),
                    releaseDocument: mocks.releaseDocument,
                    scrollToHeading: vi.fn(() => false),
                });
                return () => h("div", { class: "mora-editor-stub" });
            },
        }),
    };
});

import App from "./App.vue";

let cleanup: (() => void) | undefined;

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function documentRow(host: HTMLElement, name: string) {
    return Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
        (item) => item.querySelector(".workspace-name")?.textContent === name,
    );
}

function findButton(host: HTMLElement, label: string) {
    return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) =>
            button.textContent?.trim() === label ||
            button.querySelector("span")?.textContent?.trim() === label,
    );
}

async function mountWithInactiveConflict() {
    mocks.isTauri.mockReturnValue(true);
    mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();
    await vi.waitFor(() => expect(mocks.focusHandler).toBeTypeOf("function"));
    findButton(host, "打开文件...")?.click();
    await vi.waitFor(() =>
        expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2),
    );
    documentRow(host, "a")?.click();
    await nextTick();
    mocks.editorUpdate?.("local a");
    documentRow(host, "b")?.click();
    await nextTick();
    mocks.diskContents.set("c:\\notes\\a.mdx", "disk a");
    mocks.diskRevisions.set("c:\\notes\\a.mdx", 2);
    await mocks.focusHandler?.({ payload: true });
    await vi.waitFor(() =>
        expect(documentRow(host, "a")?.textContent).toContain("外部更改"),
    );
    documentRow(host, "a")?.click();
    await vi.waitFor(() =>
        expect(
            host.querySelector(
                '[aria-labelledby="external-conflict-dialog-title"][open]',
            ),
        ).not.toBeNull(),
    );
    return host;
}

beforeEach(() => {
    mocks.closeHandler = undefined;
    mocks.focusHandler = undefined;
    mocks.editorUpdate = undefined;
    mocks.getMoraEditorAiProvider = undefined;
    mocks.getMoraEditorMarkdown = undefined;
    mocks.isTauri.mockReturnValue(false);
    mocks.aiKeyConfigured = false;
    mocks.aiKeyStatusResponses = [];
    mocks.openDialog.mockReset();
    mocks.saveDialog.mockReset();
    mocks.openMdxFailures.clear();
    mocks.saveFailures.clear();
    mocks.drafts.clear();
    mocks.diskContents.clear();
    mocks.diskRevisions.clear();
    mocks.workspaceSession = null;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        configurable: true,
        value() {
            this.setAttribute("open", "");
        },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
        configurable: true,
        value() {
            this.removeAttribute("open");
        },
    });
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:restored-asset"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
    });
    window.matchMedia = vi.fn(() => ({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("App Web 预览启动", () => {
    it("以空欢迎页启动，并只在请求后创建未命名文档", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await nextTick();

        expect(host.textContent).toContain("新建文档");
        expect(host.querySelector(".mora-editor-stub")).toBeNull();
        expect(host.textContent).not.toContain("未命名文档 1");

        Array.from(host.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "新建文档")
            ?.click();
        await vi.waitFor(() => {
            expect(host.textContent).toContain("未命名文档 1");
            expect(host.querySelector(".mora-editor-stub")).not.toBeNull();
        });

        expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.getMoraEditorAiProvider?.()).toBeUndefined();
    });

    it("编辑内容后仍不调用 Tauri 草稿 IPC", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "新建文档")
            ?.click();
        await vi.waitFor(() => {
            expect(mocks.moraEditorMounted).toHaveBeenCalledTimes(1);
        });

        vi.useFakeTimers();
        try {
            mocks.editorUpdate?.("Web 预览编辑");
            await nextTick();
            expect(host.textContent).toContain("未保存");
            await vi.advanceTimersByTimeAsync(1600);

            expect(mocks.invoke).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("按 Unicode 字符而不是 UTF-16 单元统计字数", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "新建文档")
            ?.click();
        await vi.waitFor(() => {
            expect(mocks.moraEditorMounted).toHaveBeenCalledTimes(1);
        });

        mocks.editorUpdate?.("你好😀");
        await vi.waitFor(() => expect(host.textContent).toContain("3 字"));
    });

    it("新笔记在菜单栏显示编号名称且不渲染标题和标签输入", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "新建文档")
            ?.click();
        await vi.waitFor(() => {
            expect(mocks.moraEditorMounted).toHaveBeenCalledTimes(1);
        });

        const documentName = host.querySelector(".menu-document-name");
        expect(documentName?.textContent?.trim()).toBe("未命名文档 1");
        expect(documentName?.getAttribute("title")).toBe("未命名文档 1");
        expect(host.querySelector(".title-input")).toBeNull();
        expect(host.querySelector('input[aria-label="添加标签"]')).toBeNull();
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it("Web 预览打开 AI 设置时仍不访问凭据 IPC", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();
        const settingsButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "偏好设置...",
        );

        settingsButton?.click();
        await nextTick();

        expect(host.querySelector('[aria-labelledby="settings-title"]')).not.toBeNull();
        expect(host.textContent).toContain("未配置");
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});

describe("App 多文档工作区", () => {
    it("桌面启动恢复精确草稿且不创建隐式未命名文档", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.workspaceSession = {
            version: 1,
            documents: [
                {
                    id: "restored-document",
                    path: "C:\\notes\\restored.mdx",
                    sourceKind: "mdx",
                    importSourcePath: null,
                    draftKey: "exact-restored-draft",
                },
            ],
            folderPaths: [],
            expandedPaths: [],
            activeDocumentId: "restored-document",
            sidebarCollapsed: false,
            sidebarWidth: 260,
        };
        mocks.drafts.set("exact-restored-draft", {
            path: "C:\\notes\\restored.mdx",
            title: "恢复文档",
            content: "# 未保存草稿",
            meta: null,
            newResources: [],
            updatedAt: "2026-08-02T00:00:00.000Z",
        });
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(host.textContent).toContain("恢复文档");
            expect(mocks.getMoraEditorMarkdown?.()).toBe("# 未保存草稿");
        });

        expect(mocks.invoke).toHaveBeenCalledWith("read_workspace_session");
        expect(mocks.invoke).toHaveBeenCalledWith("read_draft", {
            key: "exact-restored-draft",
        });
        expect(host.textContent).not.toContain("未命名文档 1");
        expect(mocks.invoke).not.toHaveBeenCalledWith("create_mdx");
    });

    it("首次切换到非活动恢复文档时水合该文档资源且不污染其他文档", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.diskContents.set("c:\\notes\\b.mdx", "![恢复图](assets/restored.png)");
        mocks.workspaceSession = {
            version: 1,
            documents: [
                {
                    id: "restored-a",
                    path: "C:\\notes\\a.mdx",
                    sourceKind: "mdx",
                    importSourcePath: null,
                    draftKey: "draft-a",
                },
                {
                    id: "restored-b",
                    path: "C:\\notes\\b.mdx",
                    sourceKind: "mdx",
                    importSourcePath: null,
                    draftKey: "draft-b",
                },
            ],
            folderPaths: [],
            expandedPaths: [],
            activeDocumentId: "restored-a",
            sidebarCollapsed: false,
            sidebarWidth: 260,
        };
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "a",
            ),
        );

        documentRow(host, "b")?.click();

        await vi.waitFor(() =>
            expect(mocks.getMoraEditorMarkdown?.()).toBe(
                "![恢复图](blob:restored-asset)",
            ),
        );
        expect(mocks.invoke).toHaveBeenCalledWith("read_asset", {
            path: "C:\\notes\\b.mdx",
            assetName: "assets/restored.png",
        });
    });

    it("一次打开多个文件，并在切换时保留脏内容且不显示保存提示", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => expect(mocks.closeHandler).toBeTypeOf("function"));
        Array.from(host.querySelectorAll("button"))
            .find(
                (button) =>
                    button.querySelector("span")?.textContent?.trim() === "打开文件...",
            )
            ?.click();

        await vi.waitFor(() => {
            const names = Array.from(host.querySelectorAll('[role="treeitem"]')).map(
                (item) => item.textContent?.trim(),
            );
            expect(names).toContain("a");
            expect(names).toContain("b");
            expect(mocks.getMoraEditorMarkdown?.()).toBe("# b");
        });
        expect(mocks.openDialog).toHaveBeenCalledWith({
            multiple: true,
            filters: [
                {
                    name: "Mora 与 Markdown 文档",
                    extensions: ["mdx", "md", "markdown"],
                },
            ],
        });

        const activate = async (name: string) => {
            Array.from(host.querySelectorAll('[role="treeitem"]'))
                .find((item) => item.textContent?.includes(name))
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await nextTick();
        };
        await activate("a");
        mocks.editorUpdate?.("dirty a");
        await nextTick();
        await activate("b");
        await activate("a");

        expect(mocks.getMoraEditorMarkdown?.()).toBe("dirty a");
        expect(
            host.querySelector('[aria-labelledby="leave-dialog-title"][open]'),
        ).toBeNull();
        expect(host.textContent).not.toContain("保存并继续");
        expect(mocks.cancelAi).toHaveBeenCalledTimes(4);
    });

    it("关闭非活动脏文档时显示目标名称并保存目标文档", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find(
                (button) =>
                    button.querySelector("span")?.textContent?.trim() === "打开文件...",
            )
            ?.click();
        await vi.waitFor(() =>
            expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2),
        );
        const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'));
        const aRow = rows.find((row) => row.textContent?.includes("a"));
        const bRow = rows.find((row) => row.textContent?.includes("b"));
        aRow?.click();
        await nextTick();
        mocks.editorUpdate?.("dirty a");
        await nextTick();
        bRow?.click();
        await nextTick();
        aRow?.dispatchEvent(new FocusEvent("focus"));
        await nextTick();

        host.querySelector<HTMLButtonElement>('[aria-label="关闭 a"]')?.click();
        await vi.waitFor(() => expect(host.textContent).toContain("保存“a”？"));
        Array.from(host.querySelectorAll("button"))
            .find((button) => button.textContent?.trim() === "保存并继续")
            ?.click();

        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith(
                "save_mdx",
                expect.objectContaining({
                    request: expect.objectContaining({
                        path: "C:\\notes\\a.mdx",
                        content: "dirty a",
                    }),
                }),
            ),
        );
        expect(host.querySelector(".menu-document-name")?.textContent?.trim()).toBe("b");
    });

    it("批量打开时隔离单文件失败并继续处理后续路径", async () => {
        mocks.isTauri.mockReturnValue(true);
        const badPath = "C:\\notes\\bad.mdx";
        mocks.openMdxFailures.add(badPath);
        mocks.openDialog.mockResolvedValue([
            "C:\\notes\\good-a.mdx",
            badPath,
            "C:\\notes\\good-b.mdx",
        ]);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find(
                (button) =>
                    button.querySelector("span")?.textContent?.trim() === "打开文件...",
            )
            ?.click();

        await vi.waitFor(() => {
            const names = Array.from(host.querySelectorAll('[role="treeitem"]')).map(
                (item) => item.textContent?.trim(),
            );
            expect(names).toContain("good-a");
            expect(names).toContain("good-b");
            expect(host.textContent).toContain("bad.mdx");
        });
    });

    it("仅在窗口重新获得焦点时刷新磁盘并把冲突绑定到对应文档", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        Array.from(host.querySelectorAll("button"))
            .find(
                (button) =>
                    button.querySelector("span")?.textContent?.trim() === "打开文件...",
            )
            ?.click();
        await vi.waitFor(() =>
            expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2),
        );
        const row = (name: string) =>
            Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
                (item) => item.querySelector(".workspace-name")?.textContent === name,
            );
        row("a")?.click();
        await nextTick();
        mocks.editorUpdate?.("local a");
        row("b")?.click();
        await nextTick();

        mocks.diskContents.set("c:\\notes\\a.mdx", "disk a");
        mocks.diskContents.set("c:\\notes\\b.mdx", "disk b");
        mocks.diskRevisions.set("c:\\notes\\a.mdx", 2);
        mocks.diskRevisions.set("c:\\notes\\b.mdx", 2);
        await mocks.focusHandler?.({ payload: false });
        expect(mocks.getMoraEditorMarkdown?.()).toBe("# b");

        await mocks.focusHandler?.({ payload: true });
        await vi.waitFor(() => {
            expect(mocks.getMoraEditorMarkdown?.()).toBe("disk b");
            expect(row("a")?.textContent).toContain("外部更改");
        });
        expect(mocks.releaseDocument).toHaveBeenCalledWith("document-2");

        row("a")?.click();
        await vi.waitFor(() => {
            expect(
                host.querySelector(
                    '[aria-labelledby="external-conflict-dialog-title"][open]',
                ),
            ).not.toBeNull();
            expect(host.textContent).toContain("“a”已在磁盘上更改");
        });
    });

    it("冲突覆盖的延迟决定始终保存发起文档而不是当前文档", async () => {
        const host = await mountWithInactiveConflict();
        documentRow(host, "b")?.click();
        await nextTick();

        findButton(host, "覆盖磁盘版本")?.click();

        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith(
                "save_mdx",
                expect.objectContaining({
                    request: expect.objectContaining({
                        path: "C:\\notes\\a.mdx",
                        content: "local a",
                    }),
                }),
            ),
        );
        expect(host.querySelector(".menu-document-name")?.textContent?.trim()).toBe(
            "b",
        );
    });

    it("冲突重新加载只丢弃目标草稿并释放目标编辑器状态", async () => {
        const host = await mountWithInactiveConflict();
        documentRow(host, "b")?.click();
        await nextTick();

        findButton(host, "重新加载磁盘版本")?.click();

        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("delete_draft", {
                key: expect.any(String),
            });
            expect(mocks.releaseDocument).toHaveBeenCalledWith("document-1");
        });
        documentRow(host, "a")?.click();
        await vi.waitFor(() =>
            expect(mocks.getMoraEditorMarkdown?.()).toBe("disk a"),
        );
        expect(documentRow(host, "a")?.textContent).not.toContain("外部更改");
    });

    it("冲突另存为保存目标内容且不覆盖原路径", async () => {
        mocks.saveDialog.mockResolvedValue("C:\\notes\\a-copy.mdx");
        const host = await mountWithInactiveConflict();
        documentRow(host, "b")?.click();
        await nextTick();

        findButton(host, "另存为")?.click();

        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith(
                "save_mdx_as",
                expect.objectContaining({
                    path: "C:\\notes\\a-copy.mdx",
                    request: expect.objectContaining({ content: "local a" }),
                }),
            ),
        );
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({ path: "C:\\notes\\a.mdx" }),
            }),
        );
        expect(host.querySelector(".menu-document-name")?.textContent?.trim()).toBe(
            "b",
        );
    });

    it("取消冲突处理保留本地内容、草稿和冲突标记", async () => {
        const host = await mountWithInactiveConflict();

        findButton(host, "取消")?.click();

        await vi.waitFor(() =>
            expect(
                host.querySelector(
                    '[aria-labelledby="external-conflict-dialog-title"][open]',
                ),
            ).toBeNull(),
        );
        expect(mocks.getMoraEditorMarkdown?.()).toBe("local a");
        expect(documentRow(host, "a")?.textContent).toContain("外部更改");
        expect(mocks.invoke).not.toHaveBeenCalledWith("save_mdx", expect.anything());
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "delete_draft",
            expect.anything(),
        );
    });
});

describe("App 桌面关闭", () => {
    async function mountTwoDirtyDocuments() {
        mocks.isTauri.mockReturnValue(true);
        mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();
        await vi.waitFor(() => expect(mocks.closeHandler).toBeTypeOf("function"));
        findButton(host, "打开文件...")?.click();
        await vi.waitFor(() =>
            expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2),
        );
        documentRow(host, "a")?.click();
        await nextTick();
        mocks.editorUpdate?.("dirty a");
        documentRow(host, "b")?.click();
        await nextTick();
        mocks.editorUpdate?.("dirty b");
        await nextTick();
        return host;
    }

    it("按打开顺序提示所有 dirty 文档且后续取消不删除草稿或关闭窗口", async () => {
        const host = await mountTwoDirtyDocuments();
        const event = { preventDefault: vi.fn() };

        const closing = mocks.closeHandler?.(event);
        await vi.waitFor(() => expect(host.textContent).toContain("保存“a”？"));
        findButton(host, "放弃修改")?.click();
        await vi.waitFor(() => expect(host.textContent).toContain("保存“b”？"));
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "delete_draft",
            expect.anything(),
        );
        findButton(host, "取消")?.click();
        await closing;

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(mocks.windowClose).not.toHaveBeenCalled();
        expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "delete_draft",
            expect.anything(),
        );
    });

    it("后续文档保存失败时保留全部文档和草稿且不关闭窗口", async () => {
        const host = await mountTwoDirtyDocuments();
        mocks.saveFailures.add("c:\\notes\\b.mdx");
        const event = { preventDefault: vi.fn() };

        const closing = mocks.closeHandler?.(event);
        await vi.waitFor(() => expect(host.textContent).toContain("保存“a”？"));
        findButton(host, "放弃修改")?.click();
        await vi.waitFor(() => expect(host.textContent).toContain("保存“b”？"));
        findButton(host, "保存并继续")?.click();
        await closing;

        expect(mocks.windowClose).not.toHaveBeenCalled();
        expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
        expect(host.textContent).toContain("无法保存 C:\\notes\\b.mdx");
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "delete_draft",
            expect.anything(),
        );
    });

    it("所有 dirty 文档决策成功后才删除放弃草稿并关闭窗口", async () => {
        const host = await mountTwoDirtyDocuments();
        const event = { preventDefault: vi.fn() };

        const closing = mocks.closeHandler?.(event);
        await vi.waitFor(() => expect(host.textContent).toContain("保存“a”？"));
        findButton(host, "放弃修改")?.click();
        await vi.waitFor(() => expect(host.textContent).toContain("保存“b”？"));
        findButton(host, "放弃修改")?.click();
        await closing;

        const deleteCalls = mocks.invoke.mock.calls.filter(
            ([command]) => command === "delete_draft",
        );
        expect(deleteCalls).toHaveLength(2);
        expect(mocks.windowClose).toHaveBeenCalledTimes(1);
    });

    it("关闭确认进行中忽略重复关闭请求且不覆盖首个决策 resolver", async () => {
        const host = await mountTwoDirtyDocuments();
        const firstEvent = { preventDefault: vi.fn() };
        const secondEvent = { preventDefault: vi.fn() };
        let firstSettled = false;

        const firstClose = mocks.closeHandler?.(firstEvent).then(() => {
            firstSettled = true;
        });
        await vi.waitFor(() => expect(host.textContent).toContain("保存“a”？"));
        await mocks.closeHandler?.(secondEvent);
        findButton(host, "取消")?.click();
        await vi.waitFor(() => expect(firstSettled).toBe(true));
        await firstClose;

        expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(mocks.windowClose).not.toHaveBeenCalled();
    });

    it("较旧的 API Key 状态请求不会覆盖较新的结果", async () => {
        mocks.isTauri.mockReturnValue(true);
        const firstStatus = deferred<boolean>();
        const secondStatus = deferred<boolean>();
        mocks.aiKeyStatusResponses = [firstStatus.promise, secondStatus.promise];
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(1);
        });
        const settingsButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "偏好设置...",
        );
        settingsButton?.click();
        await vi.waitFor(() => {
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(2);
        });

        secondStatus.resolve(true);
        await vi.waitFor(() => expect(host.textContent).toContain("已配置"));
        firstStatus.resolve(false);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await nextTick();

        expect(host.textContent).toContain("已配置");
    });

    it("空工作区不拦截原生关闭请求", async () => {
        mocks.isTauri.mockReturnValue(true);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(mocks.closeHandler).toBeTypeOf("function");
            expect(host.textContent).toContain("新建文档");
        });

        expect(host.querySelector(".mora-editor-stub")).toBeNull();
        const event = { preventDefault: vi.fn() };
        await mocks.closeHandler?.(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(mocks.windowClose).not.toHaveBeenCalled();
    });

    it("启动、打开设置、保存和删除时同步 API Key 配置状态", async () => {
        mocks.isTauri.mockReturnValue(true);
        mocks.aiKeyConfigured = true;
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(1);
        });
        const settingsButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "偏好设置...",
        );
        settingsButton?.click();
        await vi.waitFor(() => {
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(2);
        });
        expect(host.textContent).toContain("已配置");

        const apiKey = host.querySelector<HTMLInputElement>(
            'input[aria-label="AI API Key"]',
        );
        if (!apiKey) throw new Error("未找到 API Key 输入框");
        apiKey.value = "replacement-key";
        apiKey.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();
        const saveButton = Array.from(host.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("保存/替换 API Key"),
        );
        saveButton?.click();
        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("save_ai_api_key", {
                key: "replacement-key",
            });
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(3);
        });

        const deleteButton = Array.from(host.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "删除 API Key",
        );
        deleteButton?.click();
        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("delete_ai_api_key");
            expect(
                mocks.invoke.mock.calls.filter(([name]) => name === "has_ai_api_key"),
            ).toHaveLength(4);
        });
        expect(host.textContent).toContain("未配置");
    });
});
