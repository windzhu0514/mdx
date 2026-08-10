/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoraAIProvider } from "../../ai/openAICompatible";
import type { MoraEditorHandle } from "./editorTypes";
import type { MermaidViewerRequest } from "./mermaidPreview";
import MilkdownEditor from "./MilkdownEditor.vue";

const mocks = vi.hoisted(() => {
    const selection = {
        atStart: vi.fn((_doc: unknown) => ({ boundary: "start" })),
        atEnd: vi.fn((_doc: unknown) => ({ boundary: "end" })),
    };
    const textSelectionCreate = vi.fn((_doc: unknown, position: number) => ({
        position,
    }));
    const editorView = {
        focus: vi.fn(),
        state: {
            doc: {
                content: { size: 8 },
                descendants: vi.fn<
                    (
                        visit: (
                            node: {
                                type: { name: string };
                                attrs?: { language?: string };
                                textContent: string;
                            },
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
                    () => { kind: string } | { scrollIntoView: () => { kind: string } }
                >(() => ({ kind: "selection" })),
            },
        },
        dispatch: vi.fn(),
        scrollDOM: { scrollTop: 0 },
        updateState: vi.fn<(state: unknown) => void>(),
    };
    editorView.updateState.mockImplementation((state) => {
        editorView.state = state as typeof editorView.state;
    });
    const commands = { call: vi.fn() };
    const parser = vi.fn((markdown: string) => ({
        content: { size: markdown.length },
        descendants: vi.fn(),
        parsedMarkdown: markdown,
        textBetween: vi.fn(() => ""),
    }));
    const stateCreate = vi.fn(
        (options: { schema: unknown; doc: unknown; plugins: unknown[] }) => ({
            doc: options.doc,
            plugins: options.plugins,
            schema: options.schema,
            selection: { from: 0, to: 0 },
            tr: editorView.state.tr,
        }),
    );
    const mermaidInitialize = vi.fn();
    const mermaidRender = vi.fn(async () => ({ svg: "<svg></svg>" }));
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
        mermaidInitialize,
        mermaidRender,
        parser,
        selection,
        selectedMarkdown: "item one\nitem two",
        stateCreate,
        textSelectionCreate,
    };
});

vi.mock("mermaid", () => ({
    default: {
        initialize: mocks.mermaidInitialize,
        render: mocks.mermaidRender,
    },
}));

vi.mock("@milkdown/crepe", () => {
    class Crepe {
        static Feature = {
            AI: "ai",
            CodeMirror: "code-mirror",
            ImageBlock: "image-block",
        };
        readonly create = vi.fn(() => mocks.createEditor());
        readonly destroy = vi.fn(() => mocks.destroyEditor());
        readonly setReadonly = vi.fn(() => this);
        readonly editor = {
            action: vi.fn((action: unknown) =>
                typeof action === "function"
                    ? action({
                          get: (key: string) =>
                              key === "editor-view"
                                  ? mocks.editorView
                                  : key === "parser"
                                    ? mocks.parser
                                    : mocks.commands,
                      })
                    : action,
            ),
        };
        readonly on = vi.fn(
            (
                configure: (listeners: {
                    markdownUpdated: (
                        listener: (context: unknown, markdown: string) => void,
                    ) => void;
                }) => void,
            ) => {
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
    parserCtx: "parser",
}));

vi.mock("@milkdown/crepe/feature/ai", () => ({
    abortAICmd: () => async () => undefined,
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
    EditorState: {
        create: mocks.stateCreate,
    },
    Selection: mocks.selection,
    TextSelection: {
        create: mocks.textSelectionCreate,
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
    documentId: Ref<string>;
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    markdown: Ref<string>;
    readonly: Ref<boolean>;
    errors: string[];
    mermaidRequests: MermaidViewerRequest[];
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
    documentId = "doc-a",
): MountedEditor {
    const host = document.createElement("div");
    const errors: string[] = [];
    const mermaidRequests: MermaidViewerRequest[] = [];
    const updates: string[] = [];
    const handle = ref<MoraEditorHandle | null>(null);
    const value = ref(markdown);
    const readonlyValue = ref(readonly);
    const documentIdValue = ref(documentId);
    const app = createApp({
        setup() {
            return () =>
                h(MilkdownEditor, {
                    ref: handle,
                    documentId: documentIdValue.value,
                    modelValue: value.value,
                    readonly: readonlyValue.value,
                    aiProvider,
                    onAiError: (message: string) => errors.push(message),
                    onOpenMermaid: (request: MermaidViewerRequest) =>
                        mermaidRequests.push(request),
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
        documentId: documentIdValue,
        handle,
        host,
        markdown: value,
        readonly: readonlyValue,
        errors,
        mermaidRequests,
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
    mocks.editorView.updateState.mockClear();
    mocks.editorView.scrollDOM.scrollTop = 0;
    mocks.editorView.state.doc.textBetween.mockClear();
    mocks.editorView.state.tr.insertText.mockClear();
    mocks.editorView.state.tr.setSelection.mockClear();
    mocks.selection.atStart.mockClear();
    mocks.selection.atEnd.mockClear();
    mocks.textSelectionCreate.mockClear();
    mocks.parser.mockClear();
    mocks.stateCreate.mockClear();
    mocks.mermaidInitialize.mockClear();
    mocks.mermaidRender.mockReset();
    mocks.mermaidRender.mockResolvedValue({ svg: "<svg></svg>" });
    mocks.editorView.state.selection = { from: 2, to: 5 };
    mocks.createEditor = async () => undefined;
    mocks.destroyEditor = async () => undefined;
    mocks.selectedMarkdown = "item one\nitem two";
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("MilkdownEditor", () => {
    it.each([false, true])(
        "configures the public CodeMirror preview hook for Mermaid blocks in readonly=%s",
        async (readonly) => {
            const editor = mountEditor(
                "```mermaid\nflowchart LR\nA --> B\n```",
                readonly,
            );
            cleanup = editor.unmount;
            await nextTick();

            const options = mocks.instances[0].options as {
                featureConfigs: Record<
                    string,
                    {
                        languages?: Array<{
                            name: string;
                            alias: readonly string[];
                            support?: unknown;
                        }>;
                        previewOnlyByDefault?: boolean;
                        renderPreview?: unknown;
                    }
                >;
            };
            const codeMirrorConfig = options.featureConfigs["code-mirror"];
            const configuredLanguages = codeMirrorConfig.languages ?? [];
            const configuredLanguageNames = configuredLanguages.map(({ name }) => name);

            expect(configuredLanguages.some(({ name }) => name === "JavaScript")).toBe(
                true,
            );
            expect(
                configuredLanguages.find(({ name }) => name === "Mermaid"),
            ).toMatchObject({
                name: "Mermaid",
                alias: expect.arrayContaining(["mermaid"]),
                support: expect.anything(),
            });
            expect(configuredLanguageNames.indexOf("Mermaid")).toBe(
                configuredLanguageNames.indexOf("Markdown") + 1,
            );
            expect(configuredLanguageNames.indexOf("MS SQL")).toBe(
                configuredLanguageNames.indexOf("Mermaid") + 1,
            );
            expect(codeMirrorConfig.previewOnlyByDefault).toBe(true);
            expect(codeMirrorConfig.renderPreview).toEqual(expect.any(Function));
        },
    );

    it("exposes Mermaid preview settlement separately from Crepe readiness", async () => {
        const deferred = createDeferred<{ svg: string }>();
        mocks.mermaidRender.mockReturnValueOnce(deferred.promise);
        const editor = mountEditor("```mermaid\nflowchart LR\nA --> B\n```");
        cleanup = editor.unmount;
        await nextTick();

        const options = mocks.instances[0].options as {
            featureConfigs: Record<
                string,
                {
                    renderPreview: (
                        language: string,
                        source: string,
                        applyPreview: (value: HTMLElement | null) => void,
                    ) => void;
                }
            >;
        };
        options.featureConfigs["code-mirror"].renderPreview(
            "mermaid",
            "flowchart LR\nA --> B",
            vi.fn(),
        );

        let settled = false;
        const waiting = editor.handle.value?.whenSettled().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        deferred.resolve({ svg: "<svg></svg>" });
        await waiting;
        expect(settled).toBe(true);
    });

    it("exports Mermaid diagrams from the current ProseMirror document", async () => {
        mocks.mermaidRender.mockResolvedValueOnce({ svg: '<svg data-export="flow"></svg>' });
        const editor = mountEditor("```mermaid\nflowchart LR\nA --> B\n```");
        cleanup = editor.unmount;
        await nextTick();
        mocks.editorView.state.doc.descendants.mockImplementationOnce((visit) => {
            visit(
                {
                    type: { name: "code_block" },
                    attrs: { language: "mermaid" },
                    textContent: "flowchart LR\nA --> B",
                },
                0,
            );
            visit(
                {
                    type: { name: "code_block" },
                    attrs: { language: "typescript" },
                    textContent: "const ignored = true;",
                },
                1,
            );
        });

        await expect(editor.handle.value!.getMermaidDiagrams()).resolves.toMatchObject([
            {
                label: "流程图",
                source: "flowchart LR\nA --> B",
                svg: '<svg data-export="flow"></svg>',
            },
        ]);
    });

    it("forwards a Mermaid preview activation to its parent", async () => {
        mocks.mermaidRender.mockResolvedValueOnce({
            svg: '<svg data-diagram="flowchart"></svg>',
        });
        const editor = mountEditor("```mermaid\nflowchart LR\nA --> B\n```");
        cleanup = editor.unmount;
        await nextTick();

        const options = mocks.instances[0].options as {
            featureConfigs: Record<
                string,
                {
                    renderPreview: (
                        language: string,
                        source: string,
                        applyPreview: (value: HTMLElement | null) => void,
                    ) => void;
                }
            >;
        };
        options.featureConfigs["code-mirror"].renderPreview(
            "mermaid",
            "flowchart LR\nA --> B",
            (value) => {
                if (value) editor.host.querySelector(".milkdown-editor")?.append(value);
            },
        );
        await editor.handle.value?.whenReady();
        await editor.handle.value?.whenSettled();
        mocks.editorView.state.doc.descendants.mockImplementationOnce((visit) => {
            visit(
                {
                    type: { name: "code_block" },
                    attrs: { language: "mermaid" },
                    textContent: "flowchart LR\nA --> B",
                },
                0,
            );
        });

        editor.host.querySelector<HTMLElement>(".mermaid-preview")?.click();

        expect(editor.mermaidRequests).toEqual([
            {
                activeIndex: 0,
                diagrams: [
                    {
                        label: "流程图",
                        source: "flowchart LR\nA --> B",
                        svg: '<svg data-diagram="flowchart"></svg>',
                    },
                ],
            },
        ]);

        editor.mermaidRequests.length = 0;
        mocks.editorView.state.doc.descendants.mockImplementationOnce((visit) => {
            visit(
                {
                    type: { name: "code_block" },
                    attrs: { language: "mermaid" },
                    textContent: "flowchart LR\nA --> B",
                },
                0,
            );
        });
        editor.host
            .querySelector<HTMLElement>(".mermaid-preview")
            ?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
            );
        expect(editor.mermaidRequests).toHaveLength(1);
    });

    it("enables Crepe AI with diff review and forwards provider errors", async () => {
        const provider: MoraAIProvider = async function* () {
            yield "结果";
        };
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
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

        editor.handle.value?.moveCursor("start");
        expect(mocks.selection.atStart).toHaveBeenCalledWith(mocks.editorView.state.doc);
        expect(mocks.editorView.state.tr.setSelection).toHaveBeenLastCalledWith({
            boundary: "start",
        });

        editor.handle.value?.moveCursor("end");
        expect(mocks.selection.atEnd).toHaveBeenCalledWith(mocks.editorView.state.doc);
        expect(mocks.editorView.state.tr.setSelection).toHaveBeenLastCalledWith({
            boundary: "end",
        });
        expect(mocks.textSelectionCreate).not.toHaveBeenCalledWith(
            mocks.editorView.state.doc,
            0,
        );
        expect(mocks.textSelectionCreate).not.toHaveBeenCalledWith(
            mocks.editorView.state.doc,
            mocks.editorView.state.doc.content.size,
        );
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

    it("switches ProseMirror states and aborts AI before changing documents", async () => {
        const provider: MoraAIProvider = async function* () {
            yield "结果";
        };
        const editor = mountEditor("# A", false, provider);
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        const stateA = mocks.editorView.state;
        const root = editor.host.querySelector<HTMLElement>(".milkdown-editor");
        expect(root).not.toBeNull();
        if (root) root.scrollTop = 80;
        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();

        expect(mocks.commands.call).toHaveBeenCalledWith("AbortAI", { keep: false });
        expect(mocks.parser).toHaveBeenCalledWith("# B");
        expect(mocks.editorView.updateState).toHaveBeenCalledTimes(1);
        expect(mocks.commands.call.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.editorView.updateState.mock.invocationCallOrder[0],
        );
        expect(mocks.instances[0].editor.action).not.toHaveBeenCalledWith({
            kind: "replace-all",
            markdown: "# B",
        });

        if (root) root.scrollTop = 20;
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# A";
        await nextTick();

        expect(mocks.editorView.updateState).toHaveBeenLastCalledWith(stateA);
        expect(root?.scrollTop).toBe(80);
    });

    it("switches documents without invoking an unregistered AI command", async () => {
        const editor = mountEditor("# A");
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();

        expect(mocks.commands.call).not.toHaveBeenCalledWith("AbortAI", {
            keep: false,
        });
        expect(mocks.editorView.updateState).toHaveBeenCalledTimes(1);
    });

    it("drops a released ProseMirror state", async () => {
        const editor = mountEditor("# A");
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# A";
        await nextTick();
        editor.handle.value?.releaseDocument("doc-a");
        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();
        const creationsBeforeReturn = mocks.stateCreate.mock.calls.length;
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# Fresh";
        await nextTick();

        expect(mocks.stateCreate).toHaveBeenCalledTimes(creationsBeforeReturn + 1);
        expect(mocks.parser).toHaveBeenLastCalledWith("# Fresh");
    });

    it("creates a new state after releasing the active document and switching away", async () => {
        const editor = mountEditor("# A");
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        editor.handle.value?.releaseDocument("doc-a");
        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();
        const creationsBeforeReopen = mocks.stateCreate.mock.calls.length;
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# A";
        await nextTick();

        expect(mocks.stateCreate).toHaveBeenCalledTimes(creationsBeforeReopen + 1);
        expect(mocks.parser).toHaveBeenLastCalledWith("# A");
    });

    it("recreates the active ProseMirror state when a released document reloads in place", async () => {
        const editor = mountEditor("# A");
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        editor.handle.value?.releaseDocument("doc-a");
        const creationsBeforeReload = mocks.stateCreate.mock.calls.length;
        editor.markdown.value = "# Fresh";
        await nextTick();

        expect(mocks.stateCreate).toHaveBeenCalledTimes(creationsBeforeReload + 1);
        expect(mocks.parser).toHaveBeenLastCalledWith("# Fresh");
        expect(mocks.editorView.updateState).toHaveBeenCalled();
    });

    it("caches a new ProseMirror state after reopening a released document id", async () => {
        const editor = mountEditor("# A");
        cleanup = editor.unmount;
        await nextTick();
        await editor.handle.value?.whenReady();

        editor.handle.value?.releaseDocument("doc-a");
        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# Fresh";
        await nextTick();

        const reopenedState = mocks.editorView.state;
        const root = editor.host.querySelector<HTMLElement>(".milkdown-editor");
        expect(root).not.toBeNull();
        if (root) root.scrollTop = 55;

        editor.documentId.value = "doc-b";
        editor.markdown.value = "# B";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "# Fresh";
        await nextTick();

        expect(mocks.editorView.updateState).toHaveBeenLastCalledWith(reopenedState);
        expect(root?.scrollTop).toBe(55);
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
