/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import SourceEditor from "./SourceEditor.vue";
import type { MoraEditorHandle } from "./editorTypes";

type MountedEditor = {
    handle: Ref<MoraEditorHandle | null>;
    host: HTMLDivElement;
    markdown: Ref<string>;
    readonly: Ref<boolean>;
    updates: string[];
    unmount: () => void;
};

function mountEditor(markdown = "", readonly = false): MountedEditor {
    const host = document.createElement("div");
    const updates: string[] = [];
    const handle = ref<MoraEditorHandle | null>(null);
    const value = ref(markdown);
    const readonlyValue = ref(readonly);
    const app = createApp({
        setup() {
            return () =>
                h(SourceEditor, {
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
});
