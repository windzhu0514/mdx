/** @vitest-environment jsdom */
/* eslint-disable vue/one-component-per-file */

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    onUnmounted,
    ref,
    type PropType,
    type Ref,
} from "vue";
import type { AIProvider } from "@milkdown/crepe/feature/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorCommand, EditorMode, MoraEditorHandle } from "./editorTypes";
import type { MermaidViewerRequest } from "./mermaidPreview";
import MoraEditor from "./MoraEditor.vue";

type ChildHandle = MoraEditorHandle & {
    emitOpenMermaid(request: MermaidViewerRequest): void;
    emitUpdate(markdown: string): void;
    calls: {
        execute: EditorCommand[];
        cancelAi: number;
        focus: number;
        getSelectedText: number;
        moveCursor: Array<"start" | "end">;
        replaceSelection: string[];
        releaseDocument: string[];
        scrollToHeading: string[];
        getMermaidDiagrams: number;
        whenReady: number;
        whenSettled: number;
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
    emitOpenMermaid: (request: MermaidViewerRequest) => void = () => undefined,
): ChildHandle {
    const calls: ChildHandle["calls"] = {
        execute: [],
        cancelAi: 0,
        focus: 0,
        getSelectedText: 0,
        moveCursor: [],
        replaceSelection: [],
        releaseDocument: [],
        scrollToHeading: [],
        getMermaidDiagrams: 0,
        whenReady: 0,
        whenSettled: 0,
        unmounted: 0,
    };

    return {
        calls,
        cancelAi: () => {
            calls.cancelAi += 1;
        },
        emitOpenMermaid,
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
        releaseDocument: (documentId) => calls.releaseDocument.push(documentId),
        scrollToHeading: (text) => {
            calls.scrollToHeading.push(text);
            return text === "目标标题";
        },
        getMermaidDiagrams: () => {
            calls.getMermaidDiagrams += 1;
            return Promise.resolve([
                {
                    label: "流程图",
                    source: "flowchart LR\nA --> B",
                    svg: "<svg></svg>",
                },
            ]);
        },
        whenReady: () => {
            calls.whenReady += 1;
            return Promise.resolve();
        },
        whenSettled: () => {
            calls.whenSettled += 1;
            return Promise.resolve();
        },
    };
}

vi.mock("./MilkdownEditor.vue", () => ({
    default: defineComponent({
        name: "MilkdownEditorStub",
        inheritAttrs: false,
        props: {
            documentId: { type: String, required: true },
            modelValue: { type: String, required: true },
            readonly: Boolean,
            aiProvider: {
                type: Function as PropType<AIProvider>,
                default: undefined,
            },
        },
        emits: ["update:modelValue", "ai-error", "open-mermaid"],
        setup(props, { emit, expose }) {
            const handle = createChildHandle(
                "milkdown",
                (markdown) => emit("update:modelValue", markdown),
                (request) => emit("open-mermaid", request),
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
                    "data-has-ai": String(Boolean(props.aiProvider)),
                    "data-document-id": props.documentId,
                });
        },
    }),
}));

vi.mock("./SourceEditor.vue", () => ({
    default: defineComponent({
        name: "SourceEditorStub",
        props: {
            documentId: { type: String, required: true },
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
                    "data-document-id": props.documentId,
                });
        },
    }),
}));

type MountedEditor = {
    documentId: Ref<string>;
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    mode: Ref<EditorMode>;
    sourcePreview: Ref<boolean>;
    updates: string[];
    mermaidRequests: MermaidViewerRequest[];
    unmount: () => void;
};

function mountEditor(
    mode: EditorMode,
    sourcePreview: boolean,
    readonly = false,
    aiProvider?: AIProvider,
    documentId = "doc-a",
): MountedEditor {
    const host = document.createElement("div");
    const handle = ref<MoraEditorHandle | null>(null);
    const modeValue = ref<EditorMode>(mode);
    const previewValue = ref(sourcePreview);
    const documentIdValue = ref(documentId);
    const updates: string[] = [];
    const mermaidRequests: MermaidViewerRequest[] = [];
    const app = createApp({
        setup() {
            return () =>
                h(MoraEditor, {
                    ref: handle,
                    documentId: documentIdValue.value,
                    modelValue: "# 标题",
                    displayValue: "# 显示标题",
                    mode: modeValue.value,
                    sourcePreview: previewValue.value,
                    readonly,
                    aiProvider,
                    onOpenMermaid: (request: MermaidViewerRequest) =>
                        mermaidRequests.push(request),
                    "onUpdate:modelValue": (markdown: string) => updates.push(markdown),
                });
        },
    });

    document.body.append(host);
    app.mount(host);
    return {
        documentId: documentIdValue,
        handle,
        host,
        mode: modeValue,
        mermaidRequests,
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
        const aiProvider = vi.fn() as unknown as AIProvider;
        const editor = mountEditor("wysiwyg", false, false, aiProvider);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
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
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-has-ai"),
        ).toBe("true");
    });

    it("does not forward AI to readonly WYSIWYG", async () => {
        const aiProvider = vi.fn() as unknown as AIProvider;
        const editor = mountEditor("wysiwyg", false, true, aiProvider);
        cleanup = editor.unmount;
        await nextTick();

        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-readonly"),
        ).toBe("true");
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-has-ai"),
        ).toBe("false");
    });

    it("renders only SourceEditor in source-only mode", async () => {
        const editor = mountEditor("source", false);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(
            editor.host
                .querySelector(".source-editor-stub")
                ?.getAttribute("data-model-value"),
        ).toBe("# 标题");
        expect(
            editor.host
                .querySelector(".milkdown-editor-stub")
                ?.getAttribute("data-readonly"),
        ).toBe("true");
    });

    it("renders SourceEditor with one readonly Milkdown preview in split mode", async () => {
        const aiProvider = vi.fn() as unknown as AIProvider;
        const editor = mountEditor("source", true, false, aiProvider);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        const milkdown = editor.host.querySelectorAll(".milkdown-editor-stub");
        expect(milkdown).toHaveLength(2);
        expect(milkdown[0].getAttribute("data-readonly")).toBe("true");
        expect(milkdown[0].getAttribute("data-model-value")).toBe("# 显示标题");
        expect(milkdown[0].getAttribute("data-has-ai")).toBe("true");
        expect(milkdown[1].getAttribute("data-readonly")).toBe("true");
        expect(milkdown[1].getAttribute("data-has-ai")).toBe("false");
    });

    it("does not mount the readonly preview outside source split mode", async () => {
        const editor = mountEditor("wysiwyg", true);
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
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
        expect(childHandles.milkdown[1].calls.scrollToHeading).toEqual(["目标标题"]);
    });

    it("delegates readiness only to the current editable child", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        await expect(editor.handle.value?.whenReady()).resolves.toBeUndefined();
        expect(childHandles.source[0].calls.whenReady).toBe(1);
        expect(childHandles.milkdown[0].calls.whenReady).toBe(0);
    });

    it("delegates settlement to the visible Milkdown editor", async () => {
        const editor = mountEditor("wysiwyg", false);
        cleanup = editor.unmount;
        await nextTick();

        await expect(editor.handle.value?.whenSettled()).resolves.toBeUndefined();
        expect(childHandles.milkdown[0].calls.whenSettled).toBe(1);
    });

    it("exports Mermaid diagrams through the always-mounted editable Milkdown editor", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        await expect(editor.handle.value?.getMermaidDiagrams()).resolves.toEqual([
            {
                label: "流程图",
                source: "flowchart LR\nA --> B",
                svg: "<svg></svg>",
            },
        ]);
        expect(childHandles.milkdown[0].calls.getMermaidDiagrams).toBe(1);
        expect(childHandles.milkdown[1].calls.getMermaidDiagrams).toBe(0);
    });

    it("forwards a real child update event to its parent", async () => {
        const editor = mountEditor("wysiwyg", false);
        cleanup = editor.unmount;
        await nextTick();

        childHandles.milkdown[0].emitUpdate("# 编辑后");

        expect(editor.updates).toEqual(["# 编辑后"]);
    });

    it("forwards Mermaid viewer requests from editable and readonly previews", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();
        const request: MermaidViewerRequest = {
            activeIndex: 0,
            diagrams: [
                { label: "流程图", source: "flowchart LR\nA --> B", svg: "<svg></svg>" },
            ],
        };

        childHandles.milkdown[0].emitOpenMermaid(request);
        childHandles.milkdown[1].emitOpenMermaid(request);

        expect(editor.mermaidRequests).toEqual([request, request]);
    });

    it("keeps editable kernels mounted while switching source preview and mode", async () => {
        const editor = mountEditor("source", false);
        cleanup = editor.unmount;
        await nextTick();
        const source = childHandles.source[0];

        editor.sourcePreview.value = true;
        await nextTick();
        const preview = childHandles.milkdown[1];
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(2);
        expect(preview.calls.unmounted).toBe(0);

        editor.sourcePreview.value = false;
        await nextTick();
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(preview.calls.unmounted).toBe(1);

        editor.mode.value = "wysiwyg";
        await nextTick();
        expect(source.calls.unmounted).toBe(0);
        expect(editor.host.querySelectorAll(".source-editor-stub")).toHaveLength(1);
        expect(editor.host.querySelectorAll(".milkdown-editor-stub")).toHaveLength(1);
        expect(childHandles.milkdown).toHaveLength(2);
    });

    it("cancels AI on mode changes and forwards document release to every kernel", async () => {
        const editor = mountEditor("source", true);
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.releaseDocument("doc-a");
        expect(childHandles.source[0].calls.releaseDocument).toEqual(["doc-a"]);
        expect(childHandles.milkdown[0].calls.releaseDocument).toEqual(["doc-a"]);
        expect(childHandles.milkdown[1].calls.releaseDocument).toEqual(["doc-a:preview"]);

        editor.mode.value = "wysiwyg";
        await nextTick();
        expect(childHandles.milkdown[0].calls.cancelAi).toBe(1);
    });

    it("passes stable document ids to editable and preview kernels", async () => {
        const editor = mountEditor("source", true, false, undefined, "doc-a");
        cleanup = editor.unmount;
        await nextTick();

        expect(
            editor.host
                .querySelector(".source-editor-stub")
                ?.getAttribute("data-document-id"),
        ).toBe("doc-a");
        const milkdown = editor.host.querySelectorAll(".milkdown-editor-stub");
        expect(milkdown[0].getAttribute("data-document-id")).toBe("doc-a");
        expect(milkdown[1].getAttribute("data-document-id")).toBe("doc-a:preview");
    });
});
