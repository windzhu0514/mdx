/** @vitest-environment jsdom */

import { createApp, defineComponent, h, nextTick, watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MdxMetadata, MdxNote } from "./types/mdx";
import { countNonWhitespaceCharacters } from "./utils/text";

type LowestEditorControls = {
    emitUpdate: (markdown: string) => void;
    focus: ReturnType<typeof vi.fn>;
    uploadImage?: (file: File) => Promise<string>;
    whenReadyCalls: number;
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
    printSnapshots: [] as string[],
    printTitles: [] as string[],
    nextMilkdownReadiness: undefined as Promise<void> | undefined,
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
    isTauri: () => false,
    invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: mocks.openDialog,
    save: mocks.saveDialog,
}));

function lowestEditorStub(kind: "milkdown" | "source") {
    return defineComponent({
        name: kind === "milkdown" ? "MilkdownEditorStub" : "SourceEditorStub",
        props: {
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
                emitUpdate: (markdown) => emit("update:modelValue", markdown),
                focus: vi.fn(),
                uploadImage: props.uploadImage as
                    ((file: File) => Promise<string>) | undefined,
                whenReadyCalls: 0,
            };
            mocks[kind] = controls;

            watch(
                () => props.modelValue,
                (markdown) => emit("update:modelValue", markdown),
            );

            expose({
                execute: vi.fn(),
                focus: controls.focus,
                getSelectedText: vi.fn(() => ""),
                moveCursor: vi.fn(),
                replaceSelection: vi.fn(),
                scrollToHeading: vi.fn(() => false),
                whenReady: () => {
                    controls.whenReadyCalls += 1;
                    return readiness;
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

async function mountApp(): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();
    await nextTick();
    return host;
}

beforeEach(() => {
    mocks.milkdown = undefined;
    mocks.source = undefined;
    mocks.openedNote = undefined;
    mocks.printSnapshots = [];
    mocks.printTitles = [];
    mocks.nextMilkdownReadiness = undefined;
    mocks.openDialog.mockResolvedValue("C:\\notes\\test.mdx");
    mocks.saveDialog.mockResolvedValue("C:\\notes\\saved.mdx");
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
        if (command === "open_mdx") return mocks.openedNote;
        if (command === "read_asset") return "aW1hZ2U=";
        if (command === "get_recent_files" || command === "push_recent_file") return [];
        if (command === "save_mdx_as" || command === "save_mdx") {
            const request = (args as { request: { content: string; path?: string } })
                .request;
            return createNote(request.content, request.path ?? "C:\\notes\\saved.mdx");
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
    it("打开旧笔记时以文件名显示文档名称而不是包内标题", async () => {
        const note = createNote("# 正文", "C:\\notes\\项目计划.MDX");
        note.title = "包内旧标题";
        note.meta = createMeta({ title: "包内旧标题", tags: ["保留标签"] });
        mocks.openedNote = note;
        const host = await mountApp();

        findButton(host, "打开...").click();
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

        findButton(host, "打开...").click();
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
                    request: { title: string; meta: MdxMetadata };
                }
            ).request;
            expect(request.title).toBe("用户命名");
            expect(request.meta.title).toBe("用户命名");
        });
    });

    it("shows an ATX heading with three leading spaces in the App TOC", async () => {
        mocks.openedNote = createNote("   ## 缩进标题\n    ### 非标题");
        const host = await mountApp();

        findButton(host, "打开...").click();
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

        findButton(host, "打开...").click();
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

        findButton(host, "打开...").click();
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
        expect(mocks.source?.focus).toHaveBeenCalledTimes(1);
    });
});

describe("App PDF 打印视图", () => {
    it("打印期间用文档文件名作为标题且不注入额外正文标题", async () => {
        mocks.openedNote = createNote("## Markdown 中的标题", "C:\\notes\\项目计划.mdx");
        const host = await mountApp();
        findButton(host, "打开...").click();
        await vi.waitFor(() =>
            expect(host.querySelector(".menu-document-name")?.textContent).toContain(
                "项目计划",
            ),
        );

        findButton(host, "导出 PDF / 打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));

        expect(mocks.printTitles).toEqual(["项目计划"]);
        expect(mocks.printSnapshots[0]).not.toContain("title-row");
        await nextTick();
        expect(document.title).toBe("项目计划 - Mora");
    });

    it("prevents concurrent exports, recovers from rejected readiness, and releases the print guard", async () => {
        mocks.openedNote = createNote("# 原文");
        const host = await mountApp();
        findButton(host, "打开...").click();
        await vi.waitFor(() => expect(editorValue(host, "milkdown")).toBe("# 原文"));
        findButton(host, "垂直双栏").click();
        await nextTick();

        const deferred = createDeferred<void>();
        mocks.nextMilkdownReadiness = deferred.promise;
        findButton(host, "导出 PDF / 打印...").click();
        findButton(host, "导出 PDF / 打印...").click();
        await vi.waitFor(() => expect(mocks.milkdown?.whenReadyCalls).toBe(1));

        deferred.reject(new Error("Crepe 初始化失败"));
        await vi.waitFor(() => expect(host.textContent).toContain("Crepe 初始化失败"));
        expect(window.print).not.toHaveBeenCalled();
        await nextTick();
        expect(host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(
            host.querySelector(".milkdown-editor-stub")?.getAttribute("data-readonly"),
        ).toBe("true");
        expect(host.textContent).not.toContain("未保存");

        findButton(host, "导出 PDF / 打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    });

    it("waits for the temporary WYSIWYG editor and ignores its normalization until printing ends", async () => {
        mocks.openedNote = createNote("# 原文");
        const host = await mountApp();
        findButton(host, "打开...").click();
        await vi.waitFor(() => expect(editorValue(host, "milkdown")).toBe("# 原文"));
        findButton(host, "仅源码").click();
        await nextTick();

        const deferred = createDeferred<void>();
        mocks.nextMilkdownReadiness = deferred.promise;
        findButton(host, "导出 PDF / 打印...").click();
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

    it.each([
        ["仅源码", false],
        ["垂直双栏", true],
    ])("从%s导出时临时使用单一可编辑 WYSIWYG，并在打印后恢复", async (mode, split) => {
        const host = await mountApp();
        findButton(host, mode).click();
        await nextTick();

        findButton(host, "导出 PDF / 打印...").click();
        await vi.waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));

        const printed = mocks.printSnapshots[0];
        expect((printed.match(/milkdown-editor-stub/g) ?? []).length).toBe(1);
        expect(printed).not.toContain("source-editor-stub");
        expect(printed).toContain('data-readonly="false"');

        await nextTick();
        expect(host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(
            split ? 1 : 0,
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
