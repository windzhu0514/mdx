/** @vitest-environment jsdom */

import { createApp, defineComponent, h, nextTick, watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MdxMetadata, MdxNote, ResourceSaveData } from "./types/mdx";
import type { MermaidDiagramSnapshot } from "./components/editor/mermaidPreview";
import type { HistoryListItem, HistorySnapshot } from "./types/history";
import { countNonWhitespaceCharacters } from "./utils/text";

type LowestEditorControls = {
    cancelAi: ReturnType<typeof vi.fn>;
    emitUpdate: (markdown: string) => void;
    focus: ReturnType<typeof vi.fn>;
    readiness: Promise<void>;
    settlement: Promise<void>;
    uploadImage?: (file: File) => Promise<string>;
    replaceSelection: ReturnType<typeof vi.fn>;
    whenReadyCalls: number;
    whenSettledCalls: number;
    documentId: () => string;
};

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value?: T) => void;
    reject: (reason: unknown) => void;
};

const mocks = vi.hoisted(() => ({
    milkdown: undefined as LowestEditorControls | undefined,
    source: undefined as LowestEditorControls | undefined,
    objectUrl: "blob:mora-image",
    openedNote: undefined as MdxNote | undefined,
    openedNotes: new Map<string, MdxNote>(),
    nextSave: undefined as Promise<MdxNote> | undefined,
    nextImportedResource: undefined as Promise<ResourceSaveData> | undefined,
    historyItems: [] as HistoryListItem[],
    nextHistoryItems: undefined as Promise<HistoryListItem[]> | undefined,
    historySnapshot: undefined as HistorySnapshot | undefined,
    nextHistorySnapshot: undefined as Promise<HistorySnapshot> | undefined,
    replaceSelection: vi.fn(),
    printSnapshots: [] as string[],
    printTitles: [] as string[],
    nextMilkdownReadiness: undefined as Promise<void> | undefined,
    nextMilkdownSettlement: undefined as Promise<void> | undefined,
    mermaidDiagrams: new Map<string, MermaidDiagramSnapshot[]>(),
    mermaidPng: vi.fn(async () => "cG5n"),
    invoke: vi.fn(),
    openDialog: vi.fn(),
    saveDialog: vi.fn(),
}));

function createDeferred<T>(): Deferred<T> {
    let resolve: ((value: T) => void) | undefined;
    let reject: ((reason: unknown) => void) | undefined;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return {
        promise,
        resolve: (value) => resolve?.(value as T),
        reject: (reason) => reject?.(reason),
    };
}

function createMeta(overrides: Partial<MdxMetadata> = {}): MdxMetadata {
    return {
        id: "note-1",
        title: "测试笔记",
        summary: "",
        author: "",
        createdAt: "2026-07-29T00:00:00Z",
        updatedAt: "2026-07-29T00:00:00Z",
        tags: [],
        category: "",
        favorite: false,
        archived: false,
        cover: "",
        wordCount: 0,
        assets: [],
        attachments: [],
        ...overrides,
    };
}

function createNote(
    content: string,
    path: string | null = "C:\\notes\\test.mdx",
): MdxNote {
    return {
        path,
        title: "测试笔记",
        content,
        manifest: {
            format: "MDXNote",
            formatVersion: "1.0",
            packageType: "note",
            contentFile: "content.md",
            metadataFile: "meta.json",
            assetsDir: "assets",
            attachmentsDir: "attachments",
            thumbnailsDir: "thumbnails",
            encoding: "utf-8",
            encrypted: false,
            compression: "deflate",
        },
        meta: createMeta(),
    };
}

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => true,
    invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/app", () => ({
    setTheme: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: vi.fn(() => ({
        onDragDropEvent: vi.fn(async () => () => undefined),
        onCloseRequested: vi.fn(async () => () => undefined),
        onFocusChanged: vi.fn(async () => () => undefined),
        close: vi.fn(async () => undefined),
    })),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: mocks.openDialog,
    save: mocks.saveDialog,
}));

vi.mock("./components/editor/mermaidExport", () => ({
    svgToPngBase64: mocks.mermaidPng,
}));

function lowestEditorStub(kind: "milkdown" | "source") {
    return defineComponent({
        name: kind === "milkdown" ? "MilkdownEditorStub" : "SourceEditorStub",
        props: {
            documentId: { type: String, required: true },
            modelValue: { type: String, required: true },
            readonly: { type: Boolean, default: false },
            uploadImage: { type: Function, default: undefined },
        },
        emits: ["update:modelValue", "ai-error"],
        setup(props, { emit, expose }) {
            const readiness =
                kind === "milkdown"
                    ? (mocks.nextMilkdownReadiness ?? Promise.resolve())
                    : Promise.resolve();
            if (kind === "milkdown") mocks.nextMilkdownReadiness = undefined;
            const controls: LowestEditorControls = {
                cancelAi: vi.fn(),
                emitUpdate: (markdown) => emit("update:modelValue", markdown),
                focus: vi.fn(),
                readiness,
                settlement:
                    kind === "milkdown"
                        ? (mocks.nextMilkdownSettlement ?? Promise.resolve())
                        : Promise.resolve(),
                uploadImage: props.uploadImage as
                    ((file: File) => Promise<string>) | undefined,
                replaceSelection: mocks.replaceSelection,
                whenReadyCalls: 0,
                whenSettledCalls: 0,
                documentId: () => props.documentId,
            };
            mocks[kind] = controls;

            watch(
                () => props.modelValue,
                (markdown) => emit("update:modelValue", markdown),
            );

            expose({
                cancelAi: controls.cancelAi,
                captureMermaidSources: async () => {
                    controls.whenReadyCalls += 1;
                    await controls.readiness;
                    controls.whenSettledCalls += 1;
                    await controls.settlement;
                    return (mocks.mermaidDiagrams.get(props.documentId) ?? []).map(
                        (diagram) => diagram.source,
                    );
                },
                execute: vi.fn(),
                focus: controls.focus,
                getMermaidDiagrams: (sources?: readonly string[]) =>
                    Promise.resolve(
                        (mocks.mermaidDiagrams.get(props.documentId) ?? []).filter(
                            (diagram) => !sources || sources.includes(diagram.source),
                        ),
                    ),
                getSelectedText: vi.fn(() => ""),
                moveCursor: vi.fn(),
                replaceSelection: controls.replaceSelection,
                releaseDocument: vi.fn(),
                scrollToHeading: vi.fn(() => false),
                whenReady: () => {
                    controls.whenReadyCalls += 1;
                    return controls.readiness;
                },
                whenSettled: () => {
                    controls.whenSettledCalls += 1;
                    return controls.settlement;
                },
            });

            return () =>
                h("div", {
                    class: `${kind}-editor-stub`,
                    "data-model-value": props.modelValue,
                    "data-readonly": String(props.readonly),
                });
        },
    });
}

vi.mock("./components/editor/MilkdownEditor.vue", () => ({
    default: lowestEditorStub("milkdown"),
}));

vi.mock("./components/editor/SourceEditor.vue", () => ({
    default: lowestEditorStub("source"),
}));

import App from "./App.vue";

let cleanup: (() => void) | undefined;

function editorValue(host: HTMLElement, kind: "milkdown" | "source"): string | null {
    return (
        host.querySelector(`.${kind}-editor-stub`)?.getAttribute("data-model-value") ??
        null
    );
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(host.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.trim() === label ||
            candidate.querySelector("span")?.textContent?.trim() === label,
    );
    if (!button) throw new Error(`未找到按钮：${label}`);
    return button;
}

function openDocumentRow(host: HTMLElement, name: string) {
    return Array.from(
        host.querySelectorAll<HTMLElement>(
            '[role="treeitem"][data-tree-key^="document:"]',
        ),
    ).find((item) => item.querySelector(".workspace-name")?.textContent === name);
}

async function mountApp(): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();
    await vi.waitFor(() =>
        expect(
            mocks.invoke.mock.calls.some(([command]) => command === "has_ai_api_key"),
        ).toBe(true),
    );
    findButton(host, "新建文档").click();
    await vi.waitFor(() => expect(mocks.milkdown).toBeDefined());
    return host;
}

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
    });
    mocks.milkdown = undefined;
    mocks.source = undefined;
    mocks.openedNote = undefined;
    mocks.openedNotes.clear();
    mocks.nextSave = undefined;
    mocks.nextImportedResource = undefined;
    mocks.historyItems = [];
    mocks.nextHistoryItems = undefined;
    mocks.historySnapshot = undefined;
    mocks.nextHistorySnapshot = undefined;
    mocks.replaceSelection.mockReset();
    mocks.printSnapshots = [];
    mocks.printTitles = [];
    mocks.nextMilkdownReadiness = undefined;
    mocks.nextMilkdownSettlement = undefined;
    mocks.mermaidDiagrams.clear();
    mocks.mermaidPng.mockClear();
    mocks.openDialog.mockResolvedValue("C:\\notes\\test.mdx");
    mocks.saveDialog.mockResolvedValue("C:\\notes\\saved.mdx");
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
        if (command === "has_ai_api_key") return false;
        if (command === "get_recent_files" || command === "push_recent_file") return [];
        if (command === "read_workspace_session") {
            return { session: null, warning: null };
        }
        if (command === "resolve_path") {
            const path = (args as { path: string }).path;
            return { path, identity: path.toLowerCase(), available: true };
        }
        if (command === "get_disk_revisions") {
            return [{ available: true, revision: { modifiedAtMs: 1, size: 1 } }];
        }
        if (command === "open_mdx") {
            const path = (args as { path: string }).path;
            return (
                mocks.openedNotes.get(path) ??
                mocks.openedNote ??
                createNote(
                    `# ${path
                        .split(/[\\/]/)
                        .pop()
                        ?.replace(/\.mdx$/iu, "")}`,
                    path,
                )
            );
        }
        if (command === "read_asset") return "aW1hZ2U=";
        if (command === "save_mdx_as" || command === "save_mdx") {
            if (mocks.nextSave) {
                const pending = mocks.nextSave;
                mocks.nextSave = undefined;
                return pending;
            }
            const request = (
                args as {
                    request: {
                        content: string;
                        meta: MdxMetadata | null;
                        path?: string;
                    };
                }
            ).request;
            const note = createNote(
                request.content,
                request.path ?? "C:\\notes\\saved.mdx",
            );
            note.meta = request.meta ?? createMeta({ title: note.title });
            return note;
        }
        if (command === "import_resource") {
            if (mocks.nextImportedResource) {
                const pending = mocks.nextImportedResource;
                mocks.nextImportedResource = undefined;
                return pending;
            }
            throw new Error("缺少资源导入测试数据");
        }
        if (command === "export_markdown") return undefined;
        if (command === "list_history") {
            if (mocks.nextHistoryItems) {
                const pending = mocks.nextHistoryItems;
                mocks.nextHistoryItems = undefined;
                return pending;
            }
            return mocks.historyItems;
        }
        if (command === "read_history") {
            if (mocks.nextHistorySnapshot) {
                const pending = mocks.nextHistorySnapshot;
                mocks.nextHistorySnapshot = undefined;
                return pending;
            }
            return mocks.historySnapshot;
        }
        return undefined;
    });
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
    vi.stubGlobal("crypto", { randomUUID: () => "resource-id" });
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => mocks.objectUrl),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(() => undefined),
    });
    window.print = vi.fn(() => {
        mocks.printSnapshots.push(document.body.innerHTML);
        mocks.printTitles.push(document.title);
    });
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("App 编辑器状态集成", () => {
    it.each([
        ["wysiwyg", null, "milkdown"],
        ["source", "仅源码", "source"],
        ["split", "垂直双栏", "source"],
    ] as const)(
        "在 %s 模式切换文档后仍保存各自的 canonical Markdown",
        async (_mode, modeButton, editorKind) => {
            const host = await mountApp();
            const editableMilkdown = mocks.milkdown;
            if (modeButton) {
                findButton(host, modeButton).click();
                await nextTick();
            }

            mocks[editorKind]?.emitUpdate("A edit");
            await nextTick();
            findButton(host, "新建").click();
            await vi.waitFor(() =>
                expect(openDocumentRow(host, "未命名文档 2")).not.toBeUndefined(),
            );
            mocks[editorKind]?.emitUpdate("B edit");
            await nextTick();

            openDocumentRow(host, "未命名文档 1")?.click();
            await vi.waitFor(() => expect(editorValue(host, editorKind)).toBe("A edit"));
            expect(editableMilkdown?.cancelAi).toHaveBeenCalled();

            findButton(host, "另存为...").click();
            await vi.waitFor(() => {
                const saveCall = mocks.invoke.mock.calls.find(
                    ([command]) => command === "save_mdx_as",
                );
                expect(
                    (saveCall?.[1] as { request: { content: string } }).request.content,
                ).toBe("A edit");
            });

            openDocumentRow(host, "未命名文档 2")?.click();
            await vi.waitFor(() => expect(editorValue(host, editorKind)).toBe("B edit"));
        },
    );

    it("输入法组合期间不执行全局文档快捷键", async () => {
        const host = await mountApp();
        const event = new KeyboardEvent("keydown", {
            key: "n",
            ctrlKey: true,
            bubbles: true,
            isComposing: true,
        });

        window.dispatchEvent(event);
        await nextTick();

        expect(openDocumentRow(host, "未命名文档 1")).not.toBeUndefined();
        expect(openDocumentRow(host, "未命名文档 2")).toBeUndefined();
    });

    it("资源 Blob URL 跨文档切换存活并在关闭所属文档时撤销", async () => {
        const host = await mountApp();
        const file = new File(["image"], "switch.png", { type: "image/png" });
        const displayUrl = await mocks.milkdown?.uploadImage?.(file);
        mocks.milkdown?.emitUpdate(`![图](${displayUrl})`);
        await nextTick();

        findButton(host, "新建").click();
        await vi.waitFor(() =>
            expect(openDocumentRow(host, "未命名文档 2")).not.toBeUndefined(),
        );
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(mocks.objectUrl);

        openDocumentRow(host, "未命名文档 1")?.click();
        await vi.waitFor(() =>
            expect(editorValue(host, "milkdown")).toBe(`![图](${mocks.objectUrl})`),
        );
        findButton(host, "仅源码").click();
        await nextTick();
        expect(editorValue(host, "source")).toBe("![图](assets/image-resource-id.png)");

        openDocumentRow(host, "未命名文档 1")?.click();
        await nextTick();
        host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭 未命名文档 1"]',
        )?.click();
        await vi.waitFor(() => expect(host.textContent).toContain("放弃修改"));
        findButton(host, "放弃修改").click();
        await vi.waitFor(() =>
            expect(openDocumentRow(host, "未命名文档 1")).toBeUndefined(),
        );

        expect(URL.revokeObjectURL).toHaveBeenCalledWith(mocks.objectUrl);
    });

    it("打开旧笔记时以文件名显示文档名称而不是包内标题", async () => {
        const note = createNote("# 正文", "C:\\notes\\项目计划.MDX");
        note.title = "包内旧标题";
        note.meta = createMeta({ title: "包内旧标题", tags: ["保留标签"] });
        mocks.openedNote = note;
        const host = await mountApp();

        findButton(host, "打开文件...").click();
        await vi.waitFor(() => {
            expect(host.querySelector(".menu-document-name")?.textContent?.trim()).toBe(
                "项目计划",
            );
        });

        expect(document.title).toBe("项目计划 - Mora");
        expect(mocks.invoke).toHaveBeenCalledWith("push_recent_file", {
            path: "C:\\notes\\项目计划.MDX",
            title: "项目计划",
        });
        expect(host.querySelector(".title-input")).toBeNull();
        expect(host.querySelector('input[aria-label="添加标签"]')).toBeNull();
    });

    it("保存旧笔记时用当前文件名同步标题并保留标签", async () => {
        const note = createNote("# 正文", "C:\\notes\\文件标题.mdx");
        note.title = "包内旧标题";
        note.meta = createMeta({ title: "包内旧标题", tags: ["保留标签"] });
        mocks.openedNote = note;
        const host = await mountApp();

        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "文件标题",
            ),
        );
        findButton(host, "保存").click();

        await vi.waitFor(() => {
            const call = mocks.invoke.mock.calls.find(([name]) => name === "save_mdx");
            expect(call).toBeDefined();
            const request = (
                call?.[1] as {
                    request: { title: string; meta: MdxMetadata };
                }
            ).request;
            expect(request.title).toBe("文件标题");
            expect(request.meta.title).toBe("文件标题");
            expect(request.meta.tags).toEqual(["保留标签"]);
        });
    });

    it("另存为时从用户选择的路径生成标题", async () => {
        mocks.saveDialog.mockResolvedValue("C:\\notes\\用户命名.mdx");
        const host = await mountApp();

        findButton(host, "另存为...").click();

        await vi.waitFor(() => {
            const call = mocks.invoke.mock.calls.find(([name]) => name === "save_mdx_as");
            expect(call).toBeDefined();
            const request = (
                call?.[1] as {
                    request: { title: string; meta: MdxMetadata | null };
                }
            ).request;
            expect(request.title).toBe("用户命名");
            expect(request.meta).toBeNull();
        });
    });

    it("另存为后保持同一编辑器文档标识", async () => {
        const host = await mountApp();
        const before = host
            .querySelector(".milkdown-editor-stub")
            ?.getAttribute("document-id");

        findButton(host, "另存为...").click();
        await vi.waitFor(() =>
            expect(mocks.invoke.mock.calls.some(([name]) => name === "save_mdx_as")).toBe(
                true,
            ),
        );
        await nextTick();

        expect(
            host.querySelector(".milkdown-editor-stub")?.getAttribute("document-id"),
        ).toBe(before);
    });

    it("shows an ATX heading with three leading spaces in the App TOC", async () => {
        mocks.openedNote = createNote("   ## 缩进标题\n    ### 非标题");
        const host = await mountApp();

        findButton(host, "打开文件...").click();
        await vi.waitFor(() => {
            expect(
                Array.from(host.querySelectorAll(".toc-list button")).map((button) =>
                    button.textContent?.trim(),
                ),
            ).toEqual(["缩进标题"]);
        });
    });

    it("does not put fenced-code pseudo headings in the App TOC", async () => {
        mocks.openedNote = createNote("# 外部\n```ts\n## 伪标题\n```");
        const host = await mountApp();

        findButton(host, "打开文件...").click();
        await vi.waitFor(() => {
            expect(
                Array.from(host.querySelectorAll(".toc-list button")).map((button) =>
                    button.textContent?.trim(),
                ),
            ).toEqual(["外部"]);
        });
    });

    it("把 Milkdown 更新归一化为持久 Markdown，并仅向 Milkdown 投影 Blob URL", async () => {
        const host = await mountApp();
        const file = new File(["image"], "paste.png", { type: "image/png" });
        const displayUrl = await mocks.milkdown?.uploadImage?.(file);
        expect(displayUrl).toBe(mocks.objectUrl);

        mocks.milkdown?.emitUpdate(`正文\n![图](${displayUrl})`);
        await nextTick();

        const canonical = "正文\n![图](assets/image-resource-id.png)";
        expect(host.textContent).toContain("未保存");
        expect(host.textContent).toContain(
            `${countNonWhitespaceCharacters(canonical)} 字`,
        );
        expect(editorValue(host, "milkdown")).toBe(`正文\n![图](${mocks.objectUrl})`);

        findButton(host, "仅源码").click();
        await nextTick();
        expect(editorValue(host, "source")).toBe(canonical);
        expect(editorValue(host, "source")).not.toContain("blob:");
    });

    it("打开外部内容时，子编辑器回传同一内容不会误标脏", async () => {
        const canonical = "## **标题** ##\n![图](assets/a.png)";
        const note = createNote(canonical);
        note.meta.assets = [
            {
                id: "asset-1",
                originalName: "a.png",
                storedName: "a.png",
                path: "assets/a.png",
                type: "image/png",
                size: 5,
                createdAt: "2026-07-29T00:00:00Z",
            },
        ];
        mocks.openedNote = note;
        const host = await mountApp();

        findButton(host, "打开文件...").click();
        await vi.waitFor(() => {
            expect(editorValue(host, "milkdown")).toContain(mocks.objectUrl);
        });
        await nextTick();

        expect(host.textContent).toContain("已保存");
        expect(host.textContent).not.toContain("未保存");
        expect(findButton(host, "标题")).toBeTruthy();

        findButton(host, "仅源码").click();
        await nextTick();
        expect(editorValue(host, "source")).toBe(canonical);
    });

    it("切换视图后聚焦新挂载的可编辑实例", async () => {
        const host = await mountApp();
        const initialMilkdown = mocks.milkdown;

        findButton(host, "仅源码").click();
        await nextTick();
        expect(initialMilkdown?.focus).not.toHaveBeenCalled();
        expect(mocks.source?.focus).toHaveBeenCalledTimes(1);

        const source = mocks.source;
        findButton(host, "所见即所得编辑").click();
        await nextTick();
        expect(source?.focus).toHaveBeenCalledTimes(1);
        expect(mocks.milkdown?.focus).toHaveBeenCalledTimes(1);

        findButton(host, "垂直双栏").click();
        await nextTick();
        expect(mocks.source?.focus).toHaveBeenCalledTimes(2);
    });

    it("资源导入等待期间切换文档会取消导入且不污染任一文档", async () => {
        const imported = createDeferred<ResourceSaveData>();
        mocks.nextImportedResource = imported.promise;
        mocks.openDialog.mockResolvedValueOnce("C:\\files\\late.png");
        const host = await mountApp();

        findButton(host, "导入图片或附件...").click();
        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith("import_resource", {
                path: "C:\\files\\late.png",
            }),
        );
        findButton(host, "新建").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "未命名文档 2",
            ),
        );

        imported.resolve({
            name: "assets/late.png",
            originalName: "late.png",
            mimeType: "image/png",
            size: 4,
            kind: "asset",
            base64: "bGF0ZQ==",
        });

        await vi.waitFor(() => expect(host.textContent).toContain("资源导入已取消"));
        expect(mocks.replaceSelection).not.toHaveBeenCalled();
        expect(editorValue(host, "milkdown")).toBe("");

        mocks.saveDialog
            .mockResolvedValueOnce("C:\\notes\\second.mdx")
            .mockResolvedValueOnce("C:\\notes\\first.mdx");
        findButton(host, "另存为...").click();
        await vi.waitFor(() =>
            expect(
                mocks.invoke.mock.calls.filter(([command]) => command === "save_mdx_as"),
            ).toHaveLength(1),
        );
        openDocumentRow(host, "未命名文档 1")?.click();
        await nextTick();
        expect(editorValue(host, "milkdown")).toBe("");
        findButton(host, "另存为...").click();
        await vi.waitFor(() =>
            expect(
                mocks.invoke.mock.calls.filter(([command]) => command === "save_mdx_as"),
            ).toHaveLength(2),
        );
        const requests = mocks.invoke.mock.calls
            .filter(([command]) => command === "save_mdx_as")
            .map(
                ([, args]) =>
                    (args as { request: { newAssets: ResourceSaveData[] } }).request,
            );
        expect(requests.map((request) => request.newAssets)).toEqual([[], []]);
    });
});

describe("App PDF 打印视图", () => {
    it("导出 Word 在 Mermaid 等待期间切换文档时取消，不混入新文档图表", async () => {
        const pathA = "C:\\notes\\draft.mdx";
        const pathB = "C:\\notes\\other.mdx";
        const noteA = createNote("# 旧正文\n![图](assets/diagram.png)", pathA);
        noteA.meta.assets = [
            {
                id: "image-1",
                originalName: "diagram.png",
                storedName: "diagram.png",
                path: "assets/diagram.png",
                type: "image/png",
                size: 4,
                createdAt: "2026-08-10T00:00:00Z",
            },
        ];
        mocks.openedNotes.set(pathA, noteA);
        mocks.openedNotes.set(pathB, createNote("# 另一篇", pathB));
        mocks.openDialog.mockResolvedValueOnce([pathA, pathB]);
        mocks.saveDialog.mockResolvedValueOnce("C:\\Exports\\draft.docx");
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "other",
            ),
        );
        openDocumentRow(host, "draft")?.click();
        await vi.waitFor(() =>
            expect(editorValue(host, "milkdown")).toContain("# 旧正文"),
        );
        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith("read_asset", {
                path: pathA,
                assetName: "assets/diagram.png",
            }),
        );
        mocks.milkdown?.emitUpdate("# newest");
        await nextTick();
        const targetEditor = mocks.milkdown;
        const settled = createDeferred<void>();
        if (targetEditor) {
            targetEditor.settlement = settled.promise;
            mocks.mermaidDiagrams.set(targetEditor.documentId(), [
                { label: "流程图", source: "flowchart TD\\nA-->B", svg: "<svg />" },
            ]);
        }

        findButton(host, "导出 Word...").click();
        await vi.waitFor(() => expect(targetEditor?.whenSettledCalls).toBe(1));
        openDocumentRow(host, "other")?.click();
        await nextTick();
        if (targetEditor) {
            mocks.mermaidDiagrams.set(targetEditor.documentId(), [
                { label: "新文档图", source: "flowchart LR\\nX-->Y", svg: "<svg />" },
            ]);
        }
        settled.resolve();

        await vi.waitFor(() =>
            expect(host.textContent).toContain("Word 导出已取消：活动文档已切换"),
        );
        expect(mocks.saveDialog).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "export_document",
            expect.anything(),
        );
        expect(mocks.invoke).not.toHaveBeenCalledWith("save_mdx", expect.anything());
    });

    it("导出 PDF 在同一文档等待 Mermaid 时编辑会取消，避免混合版本", async () => {
        const host = await mountApp();
        mocks.milkdown?.emitUpdate(
            "# 导出前正文\n```mermaid\nflowchart TD\nA --> B\n```",
        );
        await nextTick();
        const targetEditor = mocks.milkdown;
        const settled = createDeferred<void>();
        if (targetEditor) {
            targetEditor.settlement = settled.promise;
            mocks.mermaidDiagrams.set(targetEditor.documentId(), [
                { label: "流程图", source: "flowchart TD\nA --> B", svg: "<svg />" },
            ]);
        }
        mocks.saveDialog.mockResolvedValueOnce("C:\\Exports\\draft.pdf");

        findButton(host, "导出 PDF...").click();
        await vi.waitFor(() => expect(targetEditor?.whenSettledCalls).toBe(1));
        targetEditor?.emitUpdate("# 导出后正文");
        await nextTick();
        settled.resolve();

        await vi.waitFor(() =>
            expect(host.textContent).toContain("PDF 导出已取消：文档内容已变更"),
        );
        expect(mocks.saveDialog).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalledWith(
            "export_document",
            expect.anything(),
        );
    });

    it.each([
        ["Word", "docx", "导出 Word...", "C:\\Exports\\draft.docx"],
        ["PDF", "pdf", "导出 PDF...", "C:\\Exports\\draft.pdf"],
    ] as const)(
        "导出 %s 会调用 export_document，并传递同一快照的完整请求",
        async (_label, format, action, destinationPath) => {
            const sourcePath = "C:\\notes\\export-source.mdx";
            const note = createNote(
                "# 已保存正文\n![图](assets/diagram.png)",
                sourcePath,
            );
            note.meta.assets = [
                {
                    id: "image-1",
                    originalName: "diagram.png",
                    storedName: "diagram.png",
                    path: "assets/diagram.png",
                    type: "image/png",
                    size: 4,
                    createdAt: "2026-08-10T00:00:00Z",
                },
            ];
            mocks.openedNotes.set(sourcePath, note);
            mocks.openDialog.mockResolvedValueOnce(sourcePath);
            mocks.saveDialog.mockResolvedValueOnce(destinationPath);
            const host = await mountApp();
            findButton(host, "打开文件...").click();
            await vi.waitFor(() =>
                expect(mocks.invoke).toHaveBeenCalledWith("read_asset", {
                    path: sourcePath,
                    assetName: "assets/diagram.png",
                }),
            );
            mocks.milkdown?.emitUpdate(
                "# 未保存正文\n![图](assets/diagram.png)\n```mermaid\nflowchart TD\nA --> B\n```",
            );
            await nextTick();
            const targetEditor = mocks.milkdown;
            if (targetEditor) {
                mocks.mermaidDiagrams.set(targetEditor.documentId(), [
                    { label: "流程图", source: "flowchart TD\nA --> B", svg: "<svg />" },
                ]);
            }

            findButton(host, action).click();

            await vi.waitFor(() =>
                expect(mocks.invoke).toHaveBeenCalledWith(
                    "export_document",
                    expect.objectContaining({
                        request: expect.objectContaining({
                            destinationPath,
                            format,
                            markdown:
                                "# 未保存正文\n![图](assets/diagram.png)\n```mermaid\nflowchart TD\nA --> B\n```",
                            resources: [
                                expect.objectContaining({
                                    name: "assets/diagram.png",
                                    base64: "aW1hZ2U=",
                                }),
                            ],
                            mermaidDiagrams: [
                                {
                                    source: "flowchart TD\nA --> B",
                                    pngBase64: "cG5n",
                                },
                            ],
                        }),
                    }),
                ),
            );
        },
    );

    it("Markdown 导出等待目标保存时切换文档仍导出原目标路径", async () => {
        const pathA = "C:\\notes\\a.mdx";
        const pathB = "C:\\notes\\b.mdx";
        mocks.openedNotes.set(pathA, createNote("# A", pathA));
        mocks.openedNotes.set(pathB, createNote("# B", pathB));
        mocks.openDialog.mockResolvedValueOnce([pathA, pathB]);
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain("b"),
        );
        openDocumentRow(host, "a")?.click();
        await nextTick();
        mocks.milkdown?.emitUpdate("# A changed");
        await nextTick();

        const pendingSave = createDeferred<MdxNote>();
        mocks.nextSave = pendingSave.promise;
        findButton(host, "导出 Markdown...").click();
        await vi.waitFor(() =>
            expect(mocks.invoke.mock.calls.some(([name]) => name === "save_mdx")).toBe(
                true,
            ),
        );
        openDocumentRow(host, "b")?.click();
        await nextTick();
        pendingSave.resolve(createNote("# A changed", pathA));

        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith("export_markdown", {
                sourcePath: pathA,
                destinationPath: "C:\\notes\\saved.mdx",
            }),
        );
    });

    it("PDF 等待目标编辑器就绪时切换文档会取消而不打印新活动文档", async () => {
        const pathA = "C:\\notes\\pdf-a.mdx";
        const pathB = "C:\\notes\\pdf-b.mdx";
        mocks.openedNotes.set(pathA, createNote("# PDF A", pathA));
        mocks.openedNotes.set(pathB, createNote("# PDF B", pathB));
        mocks.openDialog.mockResolvedValueOnce([pathA, pathB]);
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "pdf-b",
            ),
        );
        openDocumentRow(host, "pdf-a")?.click();
        await nextTick();
        const targetEditor = mocks.milkdown;
        const readiness = createDeferred<void>();
        if (targetEditor) targetEditor.readiness = readiness.promise;

        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(targetEditor?.whenReadyCalls).toBe(1));
        openDocumentRow(host, "pdf-b")?.click();
        await nextTick();
        readiness.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await nextTick();

        expect(window.print).not.toHaveBeenCalled();
        expect(host.textContent).toContain("PDF 导出已取消");
    });

    it("打印期间用文档文件名作为标题且不注入额外正文标题", async () => {
        mocks.openedNote = createNote("## Markdown 中的标题", "C:\\notes\\项目计划.mdx");
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "项目计划",
            ),
        );

        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));

        expect(mocks.printTitles).toEqual(["项目计划"]);
        expect(mocks.printSnapshots[0]).not.toContain("title-row");
        await nextTick();
        expect(document.title).toBe("项目计划 - Mora");
    });

    it("prevents concurrent exports, recovers from rejected readiness, and releases the print guard", async () => {
        mocks.openedNote = createNote("# 原文");
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() => expect(editorValue(host, "milkdown")).toBe("# 原文"));
        const editableMilkdown = mocks.milkdown;
        findButton(host, "垂直双栏").click();
        await nextTick();

        const deferred = createDeferred<void>();
        if (editableMilkdown) editableMilkdown.readiness = deferred.promise;
        findButton(host, "打印...").click();
        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(editableMilkdown?.whenReadyCalls).toBe(1));

        deferred.reject(new Error("Crepe 初始化失败"));
        await vi.waitFor(() => expect(host.textContent).toContain("Crepe 初始化失败"));
        expect(window.print).not.toHaveBeenCalled();
        await nextTick();
        expect(host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(
            host.querySelector(".milkdown-editor-stub")?.getAttribute("data-readonly"),
        ).toBe("true");
        expect(host.textContent).not.toContain("未保存");

        if (editableMilkdown) editableMilkdown.readiness = Promise.resolve();
        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    });

    it("waits for the temporary WYSIWYG editor and ignores its normalization until printing ends", async () => {
        mocks.openedNote = createNote("# 原文");
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() => expect(editorValue(host, "milkdown")).toBe("# 原文"));
        findButton(host, "仅源码").click();
        await nextTick();

        const deferred = createDeferred<void>();
        if (mocks.milkdown) mocks.milkdown.readiness = deferred.promise;
        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(mocks.milkdown?.whenReadyCalls).toBe(1));

        expect(window.print).not.toHaveBeenCalled();
        mocks.milkdown?.emitUpdate("# Crepe 规范化后的内容");
        await nextTick();
        expect(host.textContent).not.toContain("未保存");

        deferred.resolve();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
        await nextTick();
        expect(editorValue(host, "source")).toBe("# 原文");
        expect(host.textContent).not.toContain("未保存");
    });

    it("waits for deferred Mermaid preview settlement before opening the print dialog", async () => {
        const host = await mountApp();
        const mermaidSettlement = createDeferred<void>();
        if (mocks.milkdown) mocks.milkdown.settlement = mermaidSettlement.promise;

        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(mocks.milkdown?.whenSettledCalls).toBe(1));
        expect(window.print).not.toHaveBeenCalled();

        mermaidSettlement.resolve();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    });

    it.each([
        ["仅源码", false],
        ["垂直双栏", true],
    ])("从%s导出时临时使用单一可编辑 WYSIWYG，并在打印后恢复", async (mode, split) => {
        const host = await mountApp();
        findButton(host, mode).click();
        await nextTick();

        findButton(host, "打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));

        const printed = mocks.printSnapshots[0];
        expect((printed.match(/milkdown-editor-stub/g) ?? []).length).toBe(1);
        expect(printed).toContain("source-editor-stub");
        expect(printed).toMatch(
            /class="source-layout(?: split)?" style="display: none;"/,
        );
        expect(printed).toContain('data-readonly="false"');

        await nextTick();
        expect(host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(
            split ? 2 : 1,
        );
        if (split) {
            expect(
                host
                    .querySelector(".milkdown-editor-stub")
                    ?.getAttribute("data-readonly"),
            ).toBe("true");
        }
        expect(host.textContent).not.toContain("未保存");
    });
});

describe("App 历史版本文档作用域", () => {
    it("切换文档后关闭历史面板并丢弃原文档的延迟列表响应", async () => {
        const pathA = "C:\\notes\\history-a.mdx";
        const pathB = "C:\\notes\\history-b.mdx";
        mocks.openedNotes.set(pathA, createNote("# History A", pathA));
        mocks.openedNotes.set(pathB, createNote("# History B", pathB));
        mocks.openDialog.mockResolvedValueOnce([pathA, pathB]);
        const pendingItems = createDeferred<HistoryListItem[]>();
        mocks.nextHistoryItems = pendingItems.promise;
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "history-b",
            ),
        );
        openDocumentRow(host, "history-a")?.click();
        await nextTick();
        findButton(host, "历史版本...").click();
        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith("list_history", { path: pathA }),
        );

        openDocumentRow(host, "history-b")?.click();
        await nextTick();
        pendingItems.resolve([
            {
                name: "late.json",
                title: "A 的延迟历史",
                createdAt: "2026-08-02T00:00:00Z",
            },
        ]);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await nextTick();

        expect(host.querySelector('[aria-labelledby="history-title"]')).toBeNull();
        expect(host.textContent).not.toContain("A 的延迟历史");
    });

    it("切换文档后丢弃原文档的延迟历史恢复响应", async () => {
        const pathA = "C:\\notes\\restore-a.mdx";
        const pathB = "C:\\notes\\restore-b.mdx";
        mocks.openedNotes.set(pathA, createNote("# Restore A", pathA));
        mocks.openedNotes.set(pathB, createNote("# Restore B", pathB));
        mocks.openDialog.mockResolvedValueOnce([pathA, pathB]);
        mocks.historyItems = [
            {
                name: "restore.json",
                title: "A 的历史",
                createdAt: "2026-08-02T00:00:00Z",
            },
        ];
        const pendingSnapshot = createDeferred<HistorySnapshot>();
        mocks.nextHistorySnapshot = pendingSnapshot.promise;
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "restore-b",
            ),
        );
        const rowA = openDocumentRow(host, "restore-a");
        expect(rowA).toBeDefined();
        rowA?.click();
        await nextTick();
        findButton(host, "历史版本...").click();
        await vi.waitFor(() => expect(host.textContent).toContain("A 的历史"));
        findButton(host, "恢复此版本").click();
        await vi.waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith("read_history", {
                path: pathA,
                name: "restore.json",
            }),
        );

        const rowB = openDocumentRow(host, "restore-b");
        expect(rowB).toBeDefined();
        rowB?.click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "restore-b",
            ),
        );
        const restoredMeta = createMeta({ tags: ["不应应用"] });
        pendingSnapshot.resolve({
            title: "A 的历史",
            content: "# Late restored A",
            meta: restoredMeta,
            createdAt: "2026-08-02T00:00:00Z",
        });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        openDocumentRow(host, "restore-a")?.click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "restore-a",
            ),
        );

        expect(editorValue(host, "milkdown")).toBe("# Restore A");
        findButton(host, "保存").click();
        await vi.waitFor(() => {
            const saveCalls = mocks.invoke.mock.calls.filter(
                ([command]) => command === "save_mdx",
            );
            const saveCall = saveCalls[saveCalls.length - 1];
            expect(
                (saveCall?.[1] as { request: { meta: MdxMetadata } }).request.meta.tags,
            ).toEqual([]);
        });
    });

    it("恢复相同正文但不同元数据时标脏并保存历史元数据", async () => {
        const pathA = "C:\\notes\\metadata-history.mdx";
        mocks.openedNotes.set(pathA, createNote("# Same content", pathA));
        mocks.openDialog.mockResolvedValueOnce(pathA);
        mocks.historyItems = [
            {
                name: "metadata.json",
                title: "元数据历史",
                createdAt: "2026-08-02T00:00:00Z",
            },
        ];
        mocks.historySnapshot = {
            title: "元数据历史",
            content: "# Same content",
            meta: createMeta({ id: "history-meta", tags: ["历史标签"] }),
            createdAt: "2026-08-02T00:00:00Z",
        };
        const host = await mountApp();
        findButton(host, "打开文件...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "metadata-history",
            ),
        );
        findButton(host, "历史版本...").click();
        await vi.waitFor(() => expect(host.textContent).toContain("元数据历史"));
        findButton(host, "恢复此版本").click();

        await vi.waitFor(() => expect(host.textContent).toContain("未保存"));
        findButton(host, "保存").click();
        await vi.waitFor(() => {
            const saveCalls = mocks.invoke.mock.calls.filter(
                ([command]) => command === "save_mdx",
            );
            const saveCall = saveCalls[saveCalls.length - 1];
            expect(
                (saveCall?.[1] as { request: { meta: MdxMetadata } }).request.meta,
            ).toMatchObject({ id: "history-meta", tags: ["历史标签"] });
        });
    });
});
