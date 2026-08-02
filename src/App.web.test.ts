/** @vitest-environment jsdom */

import { createApp, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    closeHandler: undefined as
        ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
    editorUpdate: undefined as ((markdown: string) => void) | undefined,
    aiKeyConfigured: false,
    aiKeyStatusResponses: [] as Array<boolean | Promise<boolean>>,
    getMoraEditorAiProvider: undefined as (() => unknown) | undefined,
    getMoraEditorMarkdown: undefined as (() => string) | undefined,
    moraEditorMounted: vi.fn(),
    cancelAi: vi.fn(),
    releaseDocument: vi.fn(),
    openDialog: vi.fn(),
    getCurrentWindow: vi.fn(() => ({
        onDragDropEvent: vi.fn(async () => () => undefined),
        onCloseRequested: vi.fn(
            async (handler: (event: { preventDefault: () => void }) => Promise<void>) => {
                mocks.closeHandler = handler;
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
        if (command === "read_latest_draft") return null;
        if (command === "resolve_path") {
            const path = (args as { path: string }).path;
            return { path, identity: path.toLowerCase(), available: true };
        }
        if (command === "get_disk_revisions") {
            return [{ available: true, revision: { modifiedAtMs: 1, size: 1 } }];
        }
        if (command === "open_mdx") {
            const path = (args as { path: string }).path;
            const name =
                path
                    .split(/[\\/]/)
                    .pop()
                    ?.replace(/\.mdx$/iu, "") ?? "笔记";
            return {
                path,
                title: name,
                content: `# ${name}`,
                meta: {
                    id: name,
                    title: name,
                    createdAt: "",
                    updatedAt: "",
                    wordCount: 0,
                    assets: [],
                    attachments: [],
                },
            };
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
    save: vi.fn(),
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
                mode: { type: String, required: true },
                sourcePreview: { type: Boolean, required: true },
                aiProvider: { type: Function, default: undefined },
            },
            emits: ["update:modelValue", "ai-error"],
            setup(props, { emit, expose }) {
                mocks.moraEditorMounted();
                mocks.editorUpdate = (markdown) => emit("update:modelValue", markdown);
                mocks.getMoraEditorAiProvider = () => props.aiProvider;
                mocks.getMoraEditorMarkdown = () => props.modelValue;
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

beforeEach(() => {
    mocks.closeHandler = undefined;
    mocks.editorUpdate = undefined;
    mocks.getMoraEditorAiProvider = undefined;
    mocks.getMoraEditorMarkdown = undefined;
    mocks.isTauri.mockReturnValue(false);
    mocks.aiKeyConfigured = false;
    mocks.aiKeyStatusResponses = [];
    mocks.openDialog.mockReset();
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
});

describe("App 桌面关闭", () => {
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
