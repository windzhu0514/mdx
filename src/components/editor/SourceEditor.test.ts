/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import SourceEditor from "./SourceEditor.vue";
import type { MoraEditorHandle } from "./editorTypes";

type MountedEditor = {
    documentId: Ref<string>;
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    markdown: Ref<string>;
    readonly: Ref<boolean>;
    updates: string[];
    unmount: () => void;
};

function mountEditor(
    markdown = "",
    readonly = false,
    documentId = "doc-a",
): MountedEditor {
    const host = document.createElement("div");
    const updates: string[] = [];
    const handle = ref<MoraEditorHandle | null>(null);
    const value = ref(markdown);
    const readonlyValue = ref(readonly);
    const documentIdValue = ref(documentId);
    const app = createApp({
        setup() {
            return () =>
                h(SourceEditor, {
                    ref: handle,
                    documentId: documentIdValue.value,
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
        documentId: documentIdValue,
        handle,
        host,
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
    document.body.innerHTML = "";
});

describe("SourceEditor", () => {
    it("writes the initial model value into CodeMirror", async () => {
        const editor = mountEditor("# Initial note");
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.host.querySelector(".cm-content")?.textContent).toBe(
            "# Initial note",
        );
    });

    it("does not emit while applying an external model value update", async () => {
        const editor = mountEditor("before");
        cleanup = editor.unmount;
        await nextTick();

        editor.markdown.value = "from parent";
        await nextTick();

        expect(editor.host.querySelector(".cm-content")?.textContent).toBe("from parent");
        expect(editor.updates).toEqual([]);
    });

    it("emits exactly once when replaceSelection changes the document", async () => {
        const editor = mountEditor("note");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.replaceSelection("new ");
        await nextTick();

        expect(editor.updates).toEqual(["new note"]);
    });

    it("restores text, selection, scroll, and undo history per document", async () => {
        const editor = mountEditor("alpha");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.replaceSelection("A ");
        await nextTick();
        const scroller = editor.host.querySelector<HTMLElement>(".cm-scroller");
        expect(scroller).not.toBeNull();
        if (scroller) scroller.scrollTop = 120;

        editor.documentId.value = "doc-b";
        editor.markdown.value = "beta";
        await nextTick();
        editor.handle.value?.replaceSelection("B ");
        await nextTick();

        editor.documentId.value = "doc-a";
        editor.markdown.value = "A alpha";
        await nextTick();

        expect(editor.host.querySelector(".cm-content")?.textContent).toBe("A alpha");
        expect(scroller?.scrollTop).toBe(120);
        editor.handle.value?.replaceSelection("X");
        await nextTick();
        expect(editor.updates[editor.updates.length - 1]).toBe("A Xalpha");
        editor.handle.value?.execute({ name: "undo" });
        await nextTick();
        editor.handle.value?.execute({ name: "undo" });
        await nextTick();
        expect(editor.updates[editor.updates.length - 1]).toBe("alpha");
    });

    it("drops a released document state", async () => {
        const editor = mountEditor("alpha");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.replaceSelection("A ");
        await nextTick();
        (
            editor.handle.value as MoraEditorHandle & {
                releaseDocument(documentId: string): void;
            }
        ).releaseDocument("doc-a");
        editor.documentId.value = "doc-b";
        editor.markdown.value = "beta";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "fresh";
        await nextTick();
        editor.handle.value?.execute({ name: "undo" });
        await nextTick();

        expect(editor.host.querySelector(".cm-content")?.textContent).toBe("fresh");
    });

    it("does not cache the active state after releasing it and switching away", async () => {
        const editor = mountEditor("alpha");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.releaseDocument("doc-a");
        const scroller = editor.host.querySelector<HTMLElement>(".cm-scroller");
        expect(scroller).not.toBeNull();
        if (scroller) scroller.scrollTop = 45;

        editor.documentId.value = "doc-b";
        editor.markdown.value = "beta";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "alpha";
        await nextTick();

        expect(scroller?.scrollTop).toBe(0);
    });

    it("recreates the active state when a released document reloads in place", async () => {
        const editor = mountEditor("alpha");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.replaceSelection("A ");
        await nextTick();
        editor.handle.value?.releaseDocument("doc-a");
        editor.markdown.value = "fresh";
        await nextTick();
        editor.handle.value?.execute({ name: "undo" });
        await nextTick();

        expect(editor.host.querySelector(".cm-content")?.textContent).toBe("fresh");
    });

    it("caches a new state after reopening a released document id", async () => {
        const editor = mountEditor("alpha");
        cleanup = editor.unmount;
        await nextTick();

        editor.handle.value?.releaseDocument("doc-a");
        editor.documentId.value = "doc-b";
        editor.markdown.value = "beta";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "fresh";
        await nextTick();

        editor.handle.value?.replaceSelection("R ");
        await nextTick();
        const scroller = editor.host.querySelector<HTMLElement>(".cm-scroller");
        expect(scroller).not.toBeNull();
        if (scroller) scroller.scrollTop = 45;

        editor.documentId.value = "doc-b";
        editor.markdown.value = "beta";
        await nextTick();
        editor.documentId.value = "doc-a";
        editor.markdown.value = "R fresh";
        await nextTick();

        expect(scroller?.scrollTop).toBe(45);
        editor.handle.value?.execute({ name: "undo" });
        await nextTick();
        expect(editor.host.querySelector(".cm-content")?.textContent).toBe("fresh");
    });

    it("sets CodeMirror to non-editable when readonly", async () => {
        const editor = mountEditor("locked", true);
        cleanup = editor.unmount;
        await nextTick();

        expect(
            editor.host.querySelector(".cm-content")?.getAttribute("contenteditable"),
        ).toBe("false");
    });

    it("reconfigures editability when readonly changes", async () => {
        const editor = mountEditor("editable");
        cleanup = editor.unmount;
        await nextTick();

        editor.readonly.value = true;
        await nextTick();

        expect(
            editor.host.querySelector(".cm-content")?.getAttribute("contenteditable"),
        ).toBe("false");
    });

    it("is ready immediately after CodeMirror mounts", async () => {
        const editor = mountEditor("ready");
        cleanup = editor.unmount;
        await nextTick();

        const readyHandle = editor.handle.value as MoraEditorHandle & {
            whenReady(): Promise<void>;
        };
        await expect(readyHandle.whenReady()).resolves.toBeUndefined();
    });

    it("exposes an empty Mermaid export snapshot for the shared editor handle", async () => {
        const editor = mountEditor("# source only");
        cleanup = editor.unmount;
        await nextTick();

        const getMermaidDiagrams = editor.handle.value?.getMermaidDiagrams;
        expect(getMermaidDiagrams).toEqual(expect.any(Function));
        if (!getMermaidDiagrams) return;

        await expect(getMermaidDiagrams()).resolves.toEqual([]);
    });

    it("finds the first ATX heading by TOC text and moves the source cursor to it", async () => {
        const editor = mountEditor("# 开始\n正文\n## **目标标题** ##\n结尾");
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.handle.value?.scrollToHeading("目标标题")).toBe(true);
        editor.handle.value?.replaceSelection("光标：");
        await nextTick();

        expect(editor.updates).toEqual(["# 开始\n正文\n光标：## **目标标题** ##\n结尾"]);
        expect(editor.handle.value?.scrollToHeading("不存在")).toBe(false);
    });

    it("finds an ATX heading with three leading spaces and moves the source cursor to it", async () => {
        const editor = mountEditor("前言\n   ## 缩进标题\n正文\n    ### 非标题");
        cleanup = editor.unmount;
        await nextTick();

        expect(editor.handle.value?.scrollToHeading("缩进标题")).toBe(true);
        editor.handle.value?.replaceSelection("定位：");
        await nextTick();

        expect(editor.updates).toEqual([
            "前言\n定位：   ## 缩进标题\n正文\n    ### 非标题",
        ]);
    });
});

it("does not scroll to an ATX-looking line inside a fenced code block", async () => {
    const editor = mountEditor("# 外部\n```ts\n## 伪标题\n```");
    cleanup = editor.unmount;
    await nextTick();

    expect(editor.handle.value?.scrollToHeading("伪标题")).toBe(false);
    expect(editor.handle.value?.scrollToHeading("外部")).toBe(true);
});
