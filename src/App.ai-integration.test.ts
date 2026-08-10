/** @vitest-environment jsdom */
/* eslint-disable vue/one-component-per-file */

import type { AIPromptContext } from "@milkdown/crepe/feature/ai";
import type { MoraAIProvider } from "./ai/openAICompatible";
import type { MdxMetadata, MdxNote } from "./types/mdx";
import { createApp, defineComponent, h, nextTick, type PropType } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MilkdownControls = {
    aiProvider?: MoraAIProvider;
    emitAiError(message: string): void;
    uploadImage?: (file: File) => Promise<string>;
};

const mocks = vi.hoisted(() => {
    class MockChannel {
        onmessage: (event: unknown) => void = () => undefined;

        emit(event: unknown) {
            this.onmessage(event);
        }
    }

    return {
        Channel: MockChannel,
        editors: [] as MilkdownControls[],
        invoke: vi.fn(),
        objectUrl: "blob:mora-ai-image",
        requests: [] as Array<Record<string, unknown>>,
    };
});

function createMeta(): MdxMetadata {
    return {
        id: "note-ai",
        title: "AI 测试笔记",
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
    };
}

function createNote(): MdxNote {
    return {
        path: null,
        title: "AI 测试笔记",
        content: "",
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
    Channel: mocks.Channel,
    invoke: mocks.invoke,
    isTauri: () => true,
}));

vi.mock("@tauri-apps/api/app", () => ({
    setTheme: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        onDragDropEvent: vi.fn(async () => () => undefined),
        onCloseRequested: vi.fn(async () => () => undefined),
        onFocusChanged: vi.fn(async () => () => undefined),
        close: vi.fn(async () => undefined),
    }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
    save: vi.fn(),
}));

vi.mock("./components/editor/MilkdownEditor.vue", () => ({
    default: defineComponent({
        name: "MilkdownEditorStub",
        props: {
            modelValue: { type: String, required: true },
            readonly: { type: Boolean, default: false },
            uploadImage: {
                type: Function as PropType<(file: File) => Promise<string>>,
                default: undefined,
            },
            aiProvider: {
                type: Function as PropType<MoraAIProvider>,
                default: undefined,
            },
        },
        emits: ["update:modelValue", "ai-error"],
        setup(props, { emit, expose }) {
            const controls: MilkdownControls = {
                get aiProvider() {
                    return props.aiProvider;
                },
                emitAiError: (message) => emit("ai-error", message),
                uploadImage: props.uploadImage,
            };
            mocks.editors.push(controls);
            expose({
                cancelAi: vi.fn(),
                execute: vi.fn(),
                focus: vi.fn(),
                getSelectedText: vi.fn(() => ""),
                moveCursor: vi.fn(),
                replaceSelection: vi.fn(),
                releaseDocument: vi.fn(),
                scrollToHeading: vi.fn(() => false),
                whenReady: vi.fn(async () => undefined),
            });
            return () =>
                h("div", {
                    class: "milkdown-editor-stub",
                    "data-readonly": String(props.readonly),
                    "data-has-ai": String(Boolean(props.aiProvider)),
                });
        },
    }),
}));

vi.mock("./components/editor/SourceEditor.vue", () => ({
    default: defineComponent({
        name: "SourceEditorStub",
        props: {
            modelValue: { type: String, required: true },
            readonly: { type: Boolean, default: false },
        },
        emits: ["update:modelValue"],
        setup(_props, { expose }) {
            expose({
                cancelAi: vi.fn(),
                execute: vi.fn(),
                focus: vi.fn(),
                getSelectedText: vi.fn(() => ""),
                moveCursor: vi.fn(),
                replaceSelection: vi.fn(),
                releaseDocument: vi.fn(),
                scrollToHeading: vi.fn(() => false),
                whenReady: vi.fn(async () => undefined),
            });
            return () => h("div", { class: "source-editor-stub" });
        },
    }),
}));

import App from "./App.vue";

let cleanup: (() => void) | undefined;

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(host.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`未找到按钮：${label}`);
    return button;
}

function updateInput(host: HTMLElement, label: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`未找到输入框：${label}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function collect(iterable: AsyncIterable<string>) {
    const values: string[] = [];
    for await (const value of iterable) values.push(value);
    return values;
}

async function mountApp(): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();
    findButton(host, "新建文档").click();
    await vi.waitFor(() => expect(mocks.editors).toHaveLength(1));
    return host;
}

beforeEach(() => {
    mocks.editors.length = 0;
    mocks.requests.length = 0;
    localStorage.clear();
    localStorage.setItem(
        "mora.preferences.v1",
        JSON.stringify({
            aiBaseUrl: "https://old.example.com/v1",
            aiModel: "old-model",
        }),
    );
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
        if (command === "has_ai_api_key") return true;
        if (command === "get_recent_files") return [];
        if (command === "read_latest_draft") return null;
        if (command === "create_mdx") return createNote();
        if (command === "stream_ai") {
            const payload = args as {
                request: Record<string, unknown>;
                onEvent: InstanceType<typeof mocks.Channel>;
            };
            mocks.requests.push(payload.request);
            payload.onEvent.emit({ type: "done" });
        }
        return undefined;
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("crypto", { randomUUID: () => "ai-resource" });
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => mocks.objectUrl),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
    });
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("App WYSIWYG AI 接线", () => {
    it("复用稳定 Provider、读取最新偏好并在 IPC 前规范化正文和选区", async () => {
        const host = await mountApp();
        const editor = mocks.editors[0];
        const provider = editor.aiProvider;
        expect(provider).toBeTypeOf("function");

        findButton(host, "偏好设置...").click();
        await nextTick();
        updateInput(host, "AI Base URL", "https://new.example.com/v1");
        updateInput(host, "AI 模型", "new-model");
        await nextTick();

        expect(mocks.editors).toHaveLength(1);
        expect(mocks.editors[0].aiProvider).toBe(provider);

        const file = new File(["image"], "ai.png", { type: "image/png" });
        const blobUrl = await editor.uploadImage?.(file);
        expect(blobUrl).toBe(mocks.objectUrl);

        const context: AIPromptContext = {
            document: `![正文图](${blobUrl})`,
            selection: `![选区图](${blobUrl})`,
            instruction: "描述图片",
        };
        await collect(provider!(context, new AbortController().signal));

        expect(mocks.requests).toEqual([
            {
                baseUrl: "https://new.example.com/v1",
                model: "new-model",
                document: "![正文图](assets/image-ai-resource.png)",
                selection: "![选区图](assets/image-ai-resource.png)",
                instruction: "描述图片",
            },
        ]);
        expect(JSON.stringify(mocks.requests)).not.toContain("blob:");

        findButton(host, "垂直双栏").click();
        await nextTick();
        const preview = mocks.editors[mocks.editors.length - 1];
        expect(preview?.aiProvider).toBeUndefined();
        const milkdownEditors = host.querySelectorAll(".milkdown-editor-stub");
        expect(
            milkdownEditors[0]?.getAttribute("data-readonly"),
        ).toBe("true");
        expect(
            milkdownEditors[0]?.getAttribute("data-has-ai"),
        ).toBe("true");
        expect(
            milkdownEditors[1]?.getAttribute("data-has-ai"),
        ).toBe("false");
    });

    it.each([
        "请先配置 AI Base URL",
        "请先配置 AI 模型",
        "未找到 API Key",
    ])("把配置错误显示为 AI 生成失败并引导到偏好设置：%s", async (message) => {
        const host = await mountApp();

        mocks.editors[0].emitAiError(message);
        await nextTick();

        expect(host.textContent).toContain("AI 生成失败");
        expect(host.textContent).toContain(message);
        expect(host.textContent).toContain("偏好设置");
    });
});
