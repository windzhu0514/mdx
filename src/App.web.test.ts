/** @vitest-environment jsdom */

import { createApp, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    closeHandler: undefined as
        ((event: { preventDefault: () => void }) => Promise<void>) | undefined,
    editorChange: undefined as (() => void) | undefined,
    editorConstructed: vi.fn(),
    editorMarkdown: "",
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
    invoke: vi.fn(async (command: string) => {
        if (command === "get_recent_files") return [];
        if (command === "read_latest_draft") return null;
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
    open: vi.fn(),
    save: vi.fn(),
}));

vi.mock("@toast-ui/editor", () => ({
    default: class MockEditor {
        constructor(options: { events?: { change?: () => void } }) {
            mocks.editorConstructed();
            mocks.editorChange = options.events?.change;
        }

        destroy() {}
        getMarkdown() {
            return mocks.editorMarkdown;
        }
        setMarkdown(markdown: string) {
            mocks.editorMarkdown = markdown;
        }
    },
}));

import App from "./App.vue";

let cleanup: (() => void) | undefined;

beforeEach(() => {
    mocks.closeHandler = undefined;
    mocks.editorChange = undefined;
    mocks.editorMarkdown = "";
    mocks.isTauri.mockReturnValue(false);
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
    it("初始化编辑器但不访问 Tauri 窗口和 IPC", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(mocks.editorConstructed).toHaveBeenCalledTimes(1);
        });

        expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it("编辑内容后仍不调用 Tauri 草稿 IPC", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(mocks.editorConstructed).toHaveBeenCalledTimes(1);
        });

        vi.useFakeTimers();
        try {
            mocks.editorMarkdown = "Web 预览编辑";
            mocks.editorChange?.();
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

        await vi.waitFor(() => {
            expect(mocks.editorConstructed).toHaveBeenCalledTimes(1);
        });

        mocks.editorMarkdown = "你好😀";
        mocks.editorChange?.();
        await nextTick();

        expect(host.textContent).toContain("3 字");
    });

    it("Web 预览的新笔记可以添加标签", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(mocks.editorConstructed).toHaveBeenCalledTimes(1);
        });

        const input = host.querySelector<HTMLInputElement>(
            'input[aria-label="添加标签"]',
        );
        if (!input) throw new Error("未找到标签输入框");

        input.value = "测试";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        await nextTick();

        const chip = host.querySelector(".tag-chip");
        expect(chip).not.toBeNull();
        expect(chip?.textContent ?? "").toContain("测试");
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});

describe("App 桌面关闭", () => {
    it("全新空白笔记不拦截原生关闭请求", async () => {
        mocks.isTauri.mockReturnValue(true);
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp(App);
        app.mount(host);
        cleanup = () => app.unmount();

        await vi.waitFor(() => {
            expect(mocks.closeHandler).toBeTypeOf("function");
            expect(host.textContent).toContain("已新建笔记");
        });

        expect(host.textContent).toContain("已保存");
        const event = { preventDefault: vi.fn() };
        await mocks.closeHandler?.(event);

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(mocks.windowClose).not.toHaveBeenCalled();
    });
});
