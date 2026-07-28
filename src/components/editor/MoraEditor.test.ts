/** @vitest-environment jsdom */

import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    EditorCommand,
    EditorMode,
    MoraEditorHandle,
} from "./editorTypes";
import MoraEditor from "./MoraEditor.vue";

type ChildHandle = MoraEditorHandle & {
    calls: {
        execute: EditorCommand[];
        focus: number;
        getSelectedText: number;
        moveCursor: Array<"start" | "end">;
        replaceSelection: string[];
        scrollToHeading: string[];
    };
};

const childHandles = vi.hoisted(() => ({
    milkdown: [] as ChildHandle[],
    source: [] as ChildHandle[],
}));

function createChildHandle(label: string): ChildHandle {
    const calls: ChildHandle["calls"] = {
        execute: [],
        focus: 0,
        getSelectedText: 0,
        moveCursor: [],
        replaceSelection: [],
        scrollToHeading: [],
    };

    return {
        calls,
        execute: (command) => calls.execute.push(command),
        focus: () => {
            calls.focus += 1;
        },
        getSelectedText: () => {
            calls.getSelectedText += 1;
            return `${label} selection`;
        },
        moveCursor: (position) => calls.moveCursor.push(position),
        replaceSelection: (text) => calls.replaceSelection.push(text),
        scrollToHeading: (text) => {
            calls.scrollToHeading.push(text);
            return text === "目标标题";
        },
    };
}

vi.mock("./MilkdownEditor.vue", () => ({
    default: defineComponent({
        name: "MilkdownEditorStub",
        inheritAttrs: false,
        props: {
            modelValue: { type: String, required: true },
            readonly: Boolean,
        },
        emits: ["update:modelValue", "ai-error"],
        setup(props, { expose }) {
            const handle = createChildHandle("milkdown");
            childHandles.milkdown.push(handle);
            expose(handle);
            return () =>
                h("div", {
                    class: "milkdown-editor-stub",
                    "data-readonly": String(props.readonly),
                });
        },
    }),
}));

vi.mock("./SourceEditor.vue", () => ({
    default: defineComponent({
        name: "SourceEditorStub",
        props: {
            modelValue: { type: String, required: true },
            readonly: Boolean,
        },
        emits: ["update:modelValue"],
        setup(_props, { expose }) {
            const handle = createChildHandle("source");
            childHandles.source.push(handle);
            expose(handle);
            return () => h("div", { class: "source-editor-stub" });
        },
    }),
}));

type MountedEditor = {
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    unmount: () => void;
};

function mountEditor(mode: EditorMode, sourcePreview: boolean): MountedEditor {
    const host = document.createElement("div");
    const handle = ref<MoraEditorHandle | null>(null);
    const app = createApp({
        setup() {
            return () =>
                h(MoraEditor, {
                    ref: handle,
                    modelValue: "# 标题",
                    mode,
                    sourcePreview,
                });
        },
    });

    document.body.append(host);
    app.mount(host);
    return {
        handle,
        host,
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
    childHandles.milkdown.length = 0;
    childHandles.source.length = 0;
    document.body.innerHTML = "";
});

describe("MoraEditor", () => {
    it("renders one editable Milkdown editor in WYSIWYG mode", async () => {
        const editor = mountEditor("wysiwyg", false);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(0);
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-readonly"),
        ).toBe("false");
    });

    it("renders only SourceEditor in source-only mode", async () => {
        const editor = mountEditor("source", false);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(0);
    });

    it("renders SourceEditor with one readonly Milkdown preview in split mode", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-readonly"),
        ).toBe("true");
    });

    it("forwards editing operations only to the currently editable child", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        const command: EditorCommand = { name: "bold" };
        editor.handle.value?.focus();
        expect(editor.handle.value?.getSelectedText()).toBe("source selection");
        editor.handle.value?.replaceSelection("替换");
        editor.handle.value?.moveCursor("end");
        editor.handle.value?.execute(command);

        expect(childHandles.source[0].calls).toMatchObject({
            execute: [command],
            focus: 1,
            getSelectedText: 1,
            moveCursor: ["end"],
            replaceSelection: ["替换"],
        });
        expect(childHandles.milkdown[0].calls).toMatchObject({
            execute: [],
            focus: 0,
            getSelectedText: 0,
            moveCursor: [],
            replaceSelection: [],
        });
    });

    it("scrolls both source and readonly preview to a heading in split mode", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.handle.value?.scrollToHeading("目标标题")).toBe(true);
        expect(childHandles.source[0].calls.scrollToHeading).toEqual(["目标标题"]);
        expect(childHandles.milkdown[0].calls.scrollToHeading).toEqual([
            "目标标题",
        ]);
    });
});
