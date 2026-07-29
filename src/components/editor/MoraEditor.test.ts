/** @vitest-environment jsdom */

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    onUnmounted,
    ref,
    type Ref,
} from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    EditorCommand,
    EditorMode,
    MoraEditorHandle,
} from "./editorTypes";
import MoraEditor from "./MoraEditor.vue";

type ChildHandle = MoraEditorHandle & {
    emitUpdate(markdown: string): void;
    calls: {
        execute: EditorCommand[];
        focus: number;
        getSelectedText: number;
        moveCursor: Array<"start" | "end">;
        replaceSelection: string[];
        scrollToHeading: string[];
        unmounted: number;
    };
};

const childHandles = vi.hoisted(() => ({
    milkdown: [] as ChildHandle[],
    source: [] as ChildHandle[],
}));

function createChildHandle(
    label: string,
    emitUpdate: (markdown: string) => void,
): ChildHandle {
    const calls: ChildHandle["calls"] = {
        execute: [],
        focus: 0,
        getSelectedText: 0,
        moveCursor: [],
        replaceSelection: [],
        scrollToHeading: [],
        unmounted: 0,
    };

    return {
        calls,
        emitUpdate,
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
        setup(props, { emit, expose }) {
            const handle = createChildHandle("milkdown", (markdown) =>
                emit("update:modelValue", markdown),
            );
            childHandles.milkdown.push(handle);
            onUnmounted(() => {
                handle.calls.unmounted += 1;
            });
            expose(handle);
            return () =>
                h("div", {
                    class: "milkdown-editor-stub",
                    "data-model-value": props.modelValue,
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
        setup(props, { emit, expose }) {
            const handle = createChildHandle("source", (markdown) =>
                emit("update:modelValue", markdown),
            );
            childHandles.source.push(handle);
            onUnmounted(() => {
                handle.calls.unmounted += 1;
            });
            expose(handle);
            return () =>
                h("div", {
                    class: "source-editor-stub",
                    "data-model-value": props.modelValue,
                });
        },
    }),
}));

type MountedEditor = {
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    mode: Ref<EditorMode>;
    sourcePreview: Ref<boolean>;
    updates: string[];
    unmount: () => void;
};

function mountEditor(mode: EditorMode, sourcePreview: boolean): MountedEditor {
    const host = document.createElement("div");
    const handle = ref<MoraEditorHandle | null>(null);
    const modeValue = ref<EditorMode>(mode);
    const previewValue = ref(sourcePreview);
    const updates: string[] = [];
    const app = createApp({
        setup() {
            return () =>
                h(MoraEditor, {
                    ref: handle,
                    modelValue: "# 标题",
                    displayValue: "# 显示标题",
                    mode: modeValue.value,
                    sourcePreview: previewValue.value,
                    "onUpdate:modelValue": (markdown: string) => updates.push(markdown),
                });
        },
    });

    document.body.append(host);
    app.mount(host);
    return {
        handle,
        host,
        mode: modeValue,
        sourcePreview: previewValue,
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
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-model-value"),
        ).toBe("# 显示标题");
    });

    it("renders only SourceEditor in source-only mode", async () => {
        const editor = mountEditor("source", false);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(0);
        expect(
            editor.host
                .querySelector(".source-editor-stub")
                ?.getAttribute("data-model-value"),
        ).toBe("# 标题");
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
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-model-value"),
        ).toBe("# 显示标题");
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

    it("forwards a real child update event to its parent", async () => {
        const editor = mountEditor("wysiwyg", false);
        cleanup = editor.unmount;
        await nextTick();

        childHandles.milkdown[0].emitUpdate("# 编辑后");

        expect(editor.updates).toEqual(["# 编辑后"]);
    });

    it("unmounts obsolete children while switching source preview and mode", async () => {
        const editor = mountEditor("source", false);
        cleanup = editor.unmount;
        await nextTick();
        const source = childHandles.source[0];

        editor.sourcePreview.value = true;
        await nextTick();
        const preview = childHandles.milkdown[0];
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(preview.calls.unmounted).toBe(0);

        editor.sourcePreview.value = false;
        await nextTick();
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(0);
        expect(preview.calls.unmounted).toBe(1);

        editor.mode.value = "wysiwyg";
        await nextTick();
        expect(source.calls.unmounted).toBe(1);
        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(0);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
    });
});
