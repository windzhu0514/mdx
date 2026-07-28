/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoraEditorHandle } from "./editorTypes";
import MilkdownEditor from "./MilkdownEditor.vue";

const mocks = vi.hoisted(() => {
    const editorView = {
        focus: vi.fn(),
        state: {
            doc: {
                content: { size: 8 },
                textBetween: vi.fn(() => "选中文本"),
            },
            selection: { from: 2, to: 5 },
            tr: {
                insertText: vi.fn(() => ({ kind: "insert" })),
                setSelection: vi.fn(() => ({ kind: "selection" })),
            },
        },
        dispatch: vi.fn(),
    };
    const commands = { call: vi.fn() };
    const instances: Array<{
        options: Record<string, unknown>;
        create: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        setReadonly: ReturnType<typeof vi.fn>;
        markdownUpdated?: (context: unknown, markdown: string) => void;
        editor: { action: ReturnType<typeof vi.fn> };
    }> = [];

    return { commands, editorView, instances, selectedMarkdown: "item one\nitem two" };
});

vi.mock("@milkdown/crepe", () => {
    class Crepe {
        static Feature = { AI: "ai", ImageBlock: "image-block" };
        readonly create = vi.fn(async () => undefined);
        readonly destroy = vi.fn(async () => undefined);
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
    updates: string[];
    unmount: () => void;
};

function mountEditor(markdown = "# 初始", readonly = false): MountedEditor {
    const host = document.createElement("div");
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
    mocks.selectedMarkdown = "item one\nitem two";
    document.body.innerHTML = "";
});

describe("MilkdownEditor", () => {
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
});
