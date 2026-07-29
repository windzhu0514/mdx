/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoraAIProvider } from "../../ai/openAICompatible";
import type { MoraEditorHandle } from "./editorTypes";
import MilkdownEditor from "./MilkdownEditor.vue";

const mocks = vi.hoisted(() => {
    const editorView = {
        focus: vi.fn(),
        state: {
            doc: {
                content: { size: 8 },
                descendants: vi.fn<
                    (
                        visit: (
                            node: { type: { name: string }; textContent: string },
                            position: number,
                        ) => boolean | void,
                    ) => void
                >(),
                textBetween: vi.fn(() => "选中文本"),
            },
            selection: { from: 2, to: 5 },
            tr: {
                insertText: vi.fn(() => ({ kind: "insert" })),
                setSelection: vi.fn<
                    () =>
                        | { kind: string }
                        | { scrollIntoView: () => { kind: string } }
                >(() => ({ kind: "selection" })),
            },
        },
        dispatch: vi.fn(),
    };
    const commands = { call: vi.fn() };
    const createEditor: () => Promise<void> = async () => undefined;
    const destroyEditor: () => Promise<void> = async () => undefined;
    const instances: Array<{
        options: Record<string, unknown>;
        create: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        setReadonly: ReturnType<typeof vi.fn>;
        markdownUpdated?: (context: unknown, markdown: string) => void;
        editor: { action: ReturnType<typeof vi.fn> };
    }> = [];

    return {
        commands,
        createEditor,
        destroyEditor,
        editorView,
        instances,
        selectedMarkdown: "item one\nitem two",
    };
});

vi.mock("@milkdown/crepe", () => {
    class Crepe {
        static Feature = { AI: "ai", ImageBlock: "image-block" };
        readonly create = vi.fn(() => mocks.createEditor());
        readonly destroy = vi.fn(() => mocks.destroyEditor());
        readonly setReadonly = vi.fn(() => this);
        readonly editor = {
            action: vi.fn((action: unknown) =>
                typeof action === "function"
                    ? action({
                          get: (key: string) =>
                              key === "editor-view" ? mocks.editorView : mocks.commands,
                      })
                    : action,
            ),
        };
        readonly on = vi.fn(
            (configure: (listeners: { markdownUpdated: (listener: (context: unknown, markdown: string) => void) => void }) => void) => {
                configure({
                    markdownUpdated: (listener) => {
                        const instance = mocks.instances[mocks.instances.length - 1];
                        if (instance) instance.markdownUpdated = listener;
                    },
                });
                return this;
            },
        );

        constructor(options: Record<string, unknown>) {
            mocks.instances.push({
                options,
                create: this.create,
                destroy: this.destroy,
                setReadonly: this.setReadonly,
                editor: this.editor,
            });
        }
    }

    return { Crepe };
});

vi.mock("@milkdown/kit/core", () => ({
    commandsCtx: "commands",
    editorViewCtx: "editor-view",
}));

vi.mock("@milkdown/kit/utils", () => ({
    getMarkdown: vi.fn(() => () => mocks.selectedMarkdown),
    replaceAll: vi.fn((markdown: string) => ({ kind: "replace-all", markdown })),
    replaceRange: vi.fn((markdown: string, range: { from: number; to: number }) => ({
        kind: "replace-range",
        markdown,
        range,
    })),
}));

vi.mock("@milkdown/kit/prose/state", () => ({
    TextSelection: {
        create: vi.fn((_doc: unknown, position: number) => ({ position })),
    },
}));

vi.mock("@milkdown/kit/preset/commonmark", () => ({
    createCodeBlockCommand: { key: "code-block" },
    insertHrCommand: { key: "hr" },
    liftListItemCommand: { key: "outdent" },
    sinkListItemCommand: { key: "indent" },
    toggleEmphasisCommand: { key: "italic" },
    toggleInlineCodeCommand: { key: "code" },
    toggleStrongCommand: { key: "bold" },
    turnIntoTextCommand: { key: "text" },
    wrapInBlockquoteCommand: { key: "quote" },
    wrapInBulletListCommand: { key: "bullet-list" },
    wrapInHeadingCommand: { key: "heading" },
    wrapInOrderedListCommand: { key: "ordered-list" },
}));

vi.mock("@milkdown/kit/preset/gfm", () => ({
    insertTableCommand: "table",
    toggleStrikethroughCommand: "strike",
}));

vi.mock("@milkdown/kit/prose/history", () => ({ redo: "redo", undo: "undo" }));
vi.mock("@milkdown/kit/prose/commands", () => ({ selectAll: "select-all" }));

type MountedEditor = {
    handle: Ref<MoraEditorHandle | null>;
    markdown: Ref<string>;
    readonly: Ref<boolean>;
    errors: string[];
    updates: string[];
    unmount: () => void;
};

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve: ((value: T) => void) | undefined;
    let reject: ((reason: unknown) => void) | undefined;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });

    return {
        promise,
        resolve: (value) => resolve?.(value),
        reject: (reason) => reject?.(reason),
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function mountEditor(
    markdown = "# 初始",
    readonly = false,
    aiProvider?: MoraAIProvider,
): MountedEditor {
    const host = document.createElement("div");
    const errors: string[] = [];
    const updates: string[] = [];
    const handle = ref<MoraEditorHandle | null>(null);
    const value = ref(markdown);
    const readonlyValue = ref(readonly);
    const app = createApp({
        setup() {
            return () =>
                h(MilkdownEditor, {
                    ref: handle,
                    modelValue: value.value,
                    readonly: readonlyValue.value,
                    aiProvider,
                    onAiError: (message: string) => errors.push(message),
                    "onUpdate:modelValue": (updated: string) => {
                        updates.push(updated);
                        value.value = updated;
                    },
                });
        },
    });

    document.body.append(host);
    app.mount(host);

    return {
        handle,
        markdown: value,
        readonly: readonlyValue,
        errors,
        updates,
        unmount: () => {
            app.unmount();
            host.remove();
        },
    };
}

let cleanup: (() => void) | undefined;

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    mocks.instances.length = 0;
    mocks.commands.call.mockClear();
    mocks.editorView.focus.mockClear();
    mocks.editorView.dispatch.mockClear();
    mocks.editorView.state.doc.textBetween.mockClear();
    mocks.editorView.state.tr.insertText.mockClear();
    mocks.editorView.state.tr.setSelection.mockClear();
    mocks.editorView.state.selection = { from: 2, to: 5 };
    mocks.createEditor = async () => undefined;
    mocks.destroyEditor = async () => undefined;
    mocks.selectedMarkdown = "item one\nitem two";
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("MilkdownEditor", () => {
    it("enables Crepe AI with diff review and forwards provider errors", async () => {
        const provider: MoraAIProvider = async function* () {
            yield "结果";
        };
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const editor = mountEditor("# AI", false, provider);
        cleanup = editor.unmount;
        await nextTick();

        const options = mocks.instances[0].options as {
            features: Record<string, boolean>;
            featureConfigs: Record<
                string,
                {
                    provider: MoraAIProvider;
                    diffReviewOnEnd: boolean;
                    onError: (error: Error) => void;
                }
            >;
        };
        expect(options.features.ai).toBe(true);
        expect(options.featureConfigs.ai.provider).toBe(provider);
        expect(options.featureConfigs.ai.diffReviewOnEnd).toBe(true);

        options.featureConfigs.ai.onError(new Error("未找到 API Key"));

        expect(editor.errors).toEqual(["未找到 API Key"]);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("initializes Crepe, emits editor input, synchronizes external Markdown, and destroys it", async () => {
        const editor = mountEditor("# 初始", true);
        cleanup = editor.unmount;
        await nextTick();
        await Promise.resolve();

        const crepe = mocks.instances[0];
        expect(crepe.options.defaultValue).toBe("# 初始");
        expect(crepe.create).toHaveBeenCalledTimes(1);
        expect(crepe.setReadonly).toHaveBeenCalledWith(true);

        crepe.markdownUpdated?.(undefined, "# 编辑后");
        expect(editor.updates).toEqual(["# 编辑后"]);

        editor.markdown.value = "# 来自父组件";
        await nextTick();
        expect(crepe.editor.action).toHaveBeenLastCalledWith({
            kind: "replace-all",
            markdown: "# 来自父组件",
        });

        editor.unmount();
        await flushPromises();
        expect(crepe.destroy).toHaveBeenCalledTimes(1);
    });

    it("exposes selection, cursor, heading, and task-list operations without inspecting editor DOM", async () => {
        const editor = mountEditor();
        cleanup = editor.unmount;
        await nextTick();
        await Promise.resolve();

        expect(editor.handle.value?.getSelectedText()).toBe("选中文本");
        editor.handle.value?.focus();
        expect(mocks.editorView.focus).toHaveBeenCalledTimes(1);

        editor.handle.value?.replaceSelection("替换");
        expect(mocks.editorView.state.tr.insertText).toHaveBeenCalledWith("替换", 2, 5);
        expect(mocks.editorView.dispatch).toHaveBeenCalledWith({ kind: "insert" });

        editor.handle.value?.moveCursor("end");
        expect(mocks.editorView.state.tr.setSelection).toHaveBeenCalledWith({ position: 8 });
        expect(mocks.editorView.dispatch).toHaveBeenLastCalledWith({ kind: "selection" });

        editor.handle.value?.execute({ name: "heading", level: 2 });
        expect(mocks.commands.call).toHaveBeenLastCalledWith("heading", 2);

        editor.handle.value?.execute({ name: "taskList" });
        const action = mocks.instances[0].editor.action;
        expect(action).toHaveBeenLastCalledWith({
            kind: "replace-range",
            markdown: "- [ ] item one\n- [ ] item two",
            range: { from: 2, to: 5 },
        });
    });

    it("finds a heading by TOC text and scrolls it into view with a ProseMirror transaction", async () => {
        const scrollIntoView = vi.fn(() => ({ kind: "scrolled-selection" }));
        const setSelection = vi.fn(() => ({ scrollIntoView }));
        mocks.editorView.state.doc.descendants = vi.fn((visit) => {
            visit(
                {
                    type: { name: "heading" },
                    textContent: "**目标标题** ##",
                },
                4,
            );
        });
        mocks.editorView.state.tr.setSelection = setSelection;
        const editor = mountEditor();
        cleanup = editor.unmount;
        await nextTick();
        await flushPromises();

        expect(editor.handle.value?.scrollToHeading("目标标题")).toBe(true);
        expect(setSelection).toHaveBeenCalledWith({ position: 5 });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(mocks.editorView.dispatch).toHaveBeenLastCalledWith({
            kind: "scrolled-selection",
        });
        expect(editor.handle.value?.scrollToHeading("不存在")).toBe(false);
    });

    it("waits for Crepe creation before synchronizing only the latest external Markdown", async () => {
        const deferred = createDeferred<void>();
        mocks.createEditor = () => deferred.promise;
        const editor = mountEditor("# 初始");
        cleanup = editor.unmount;
        await nextTick();

        const crepe = mocks.instances[0];
        editor.markdown.value = "# 过期值";
        await nextTick();
        editor.markdown.value = "# 最新值";
        await nextTick();
        expect(crepe.editor.action).not.toHaveBeenCalled();

        deferred.resolve();
        await flushPromises();
        expect(crepe.editor.action).toHaveBeenCalledTimes(1);
        expect(crepe.editor.action).toHaveBeenLastCalledWith({
            kind: "replace-all",
            markdown: "# 最新值",
        });
    });

    it("exposes the pending Crepe creation promise as editor readiness", async () => {
        const deferred = createDeferred<void>();
        mocks.createEditor = () => deferred.promise;
        const editor = mountEditor();
        cleanup = editor.unmount;
        await nextTick();

        const readyHandle = editor.handle.value as MoraEditorHandle & {
            whenReady(): Promise<void>;
        };
        let settled = false;
        const waiting = readyHandle.whenReady().then(() => {
            settled = true;
        });
        await flushPromises();
        expect(settled).toBe(false);

        deferred.resolve();
        await waiting;
        expect(settled).toBe(true);
    });

    it("keeps rejected Crepe creation observable through readiness while reporting and cleaning up", async () => {
        const deferred = createDeferred<void>();
        const failure = new Error("Crepe 初始化失败");
        const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.createEditor = () => deferred.promise;
        const editor = mountEditor();
        await nextTick();

        const readyHandle = editor.handle.value as MoraEditorHandle & {
            whenReady(): Promise<void>;
        };
        const readiness = readyHandle.whenReady();
        deferred.reject(failure);

        await expect(readiness).rejects.toThrow("Crepe 初始化失败");
        expect(report).toHaveBeenCalledWith("Crepe 初始化失败", failure);

        editor.unmount();
        await flushPromises();
        expect(mocks.instances[0].destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys Crepe once only after a pending creation settles", async () => {
        const deferred = createDeferred<void>();
        mocks.createEditor = () => deferred.promise;
        const editor = mountEditor();
        await nextTick();

        const crepe = mocks.instances[0];
        editor.unmount();
        expect(crepe.destroy).not.toHaveBeenCalled();

        deferred.resolve();
        await flushPromises();
        expect(crepe.destroy).toHaveBeenCalledTimes(1);
    });

    it("inserts one unchecked task marker at an empty selection", async () => {
        const editor = mountEditor();
        cleanup = editor.unmount;
        await nextTick();
        await flushPromises();

        mocks.editorView.state.selection = { from: 4, to: 4 };
        mocks.selectedMarkdown = "";
        editor.handle.value?.execute({ name: "taskList" });

        expect(mocks.instances[0].editor.action).toHaveBeenLastCalledWith({
            kind: "replace-range",
            markdown: "- [ ] ",
            range: { from: 4, to: 4 },
        });
    });

    it("reports a rejected creation and keeps external Markdown updates inactive", async () => {
        const deferred = createDeferred<void>();
        const failure = new Error("create failed");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.createEditor = () => deferred.promise;
        const editor = mountEditor();
        cleanup = editor.unmount;
        await nextTick();

        const crepe = mocks.instances[0];
        deferred.reject(failure);
        await flushPromises();
        expect(errorSpy).toHaveBeenCalledWith("Crepe 初始化失败", failure);

        editor.markdown.value = "# 不应同步";
        await nextTick();
        expect(crepe.editor.action).not.toHaveBeenCalled();
    });

    it("reports a rejected destruction without leaving an unhandled rejection", async () => {
        const deferred = createDeferred<void>();
        const failure = new Error("destroy failed");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.destroyEditor = () => deferred.promise;
        const editor = mountEditor();
        await nextTick();
        await flushPromises();

        const crepe = mocks.instances[0];
        editor.unmount();
        await flushPromises();
        expect(crepe.destroy).toHaveBeenCalledTimes(1);

        deferred.reject(failure);
        await flushPromises();
        expect(errorSpy).toHaveBeenCalledWith("Crepe 销毁失败", failure);
    });

    it("ignores markdown updates from an instance after it is unmounted", async () => {
        const editor = mountEditor("# 保持原值");
        await nextTick();
        await flushPromises();

        const crepe = mocks.instances[0];
        editor.unmount();
        await flushPromises();
        crepe.markdownUpdated?.(undefined, "# 旧实例更新");

        expect(editor.updates).toEqual([]);
        expect(editor.markdown.value).toBe("# 保持原值");
    });
});
