<template>
    <div ref="editorElement" class="source-editor"></div>
</template>

<script setup lang="ts">
import { redo, selectAll, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { EditorCommand, MoraEditorHandle } from "./editorTypes";
import { transformSourceSelection } from "./sourceTransforms";

const props = defineProps<{ modelValue: string; readonly?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [markdown: string] }>();

const editorElement = ref<HTMLDivElement>();
const editableCompartment = new Compartment();
let editorView: EditorView | undefined;
let applyingExternalValue = false;

onMounted(() => {
    if (!editorElement.value) return;

    editorView = new EditorView({
        doc: props.modelValue,
        extensions: [
            basicSetup,
            markdown(),
            editableCompartment.of(EditorView.editable.of(!props.readonly)),
            EditorView.updateListener.of((update) => {
                if (update.docChanged && !applyingExternalValue) {
                    emit("update:modelValue", update.state.doc.toString());
                }
            }),
        ],
        parent: editorElement.value,
    });
});

watch(
    () => props.modelValue,
    (value) => {
        if (!editorView || editorView.state.doc.toString() === value) return;

        applyingExternalValue = true;
        try {
            editorView.dispatch({
                changes: { from: 0, to: editorView.state.doc.length, insert: value },
            });
        } finally {
            applyingExternalValue = false;
        }
    },
);

watch(
    () => props.readonly,
    (value) => {
        editorView?.dispatch({
            effects: editableCompartment.reconfigure(EditorView.editable.of(!value)),
        });
    },
);

onBeforeUnmount(() => {
    editorView?.destroy();
    editorView = undefined;
});

function focus(): void {
    editorView?.focus();
}

function getSelectedText(): string {
    if (!editorView) return "";
    const { from, to } = editorView.state.selection.main;
    return editorView.state.sliceDoc(from, to);
}

function replaceSelection(text: string): void {
    if (!editorView) return;
    const { from, to } = editorView.state.selection.main;
    editorView.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
    });
}

function moveCursor(position: "start" | "end"): void {
    if (!editorView) return;
    editorView.dispatch({
        selection: { anchor: position === "start" ? 0 : editorView.state.doc.length },
    });
}

function scrollToHeading(text: string): boolean {
    if (!editorView) return false;

    const doc = editorView.state.doc;
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
        const line = doc.line(lineNumber);
        const match = /^(#{1,6})\s+(.+)$/.exec(line.text);
        if (match?.[2].trim() !== text) continue;

        editorView.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: "start" }),
        });
        return true;
    }

    return false;
}

function execute(command: EditorCommand): void {
    if (!editorView) return;

    switch (command.name) {
        case "undo":
            undo(editorView);
            return;
        case "redo":
            redo(editorView);
            return;
        case "selectAll":
            selectAll(editorView);
            return;
        default:
            break;
    }

    const { from, to } = editorView.state.selection.main;
    const change = transformSourceSelection(
        editorView.state.doc.toString(),
        from,
        to,
        command,
    );
    if (!change) return;

    editorView.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: { anchor: change.anchor },
    });
}

defineExpose<MoraEditorHandle>({
    focus,
    getSelectedText,
    replaceSelection,
    moveCursor,
    execute,
    scrollToHeading,
});
</script>
