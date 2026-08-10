<template>
    <div ref="editorElement" class="source-editor"></div>
</template>

<script setup lang="ts">
import { redo, selectAll, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { EditorCommand, MoraEditorHandle } from "./editorTypes";
import type { MermaidDiagramSnapshot } from "./mermaidPreview";
import { transformSourceSelection } from "./sourceTransforms";
import { extractMarkdownHeadings, normalizeMarkdownHeadingText } from "../../utils/text";

const props = defineProps<{
    documentId: string;
    modelValue: string;
    readonly?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [markdown: string] }>();

const editorElement = ref<HTMLDivElement>();
const editableCompartment = new Compartment();
let editorView: EditorView | undefined;
let applyingExternalValue = false;
let activeDocumentId = props.documentId;
const states = new Map<string, { state: EditorState; scrollTop: number }>();
let pendingReleasedDocumentId: string | null = null;

function createState(markdownValue: string): EditorState {
    return EditorState.create({
        doc: markdownValue,
        extensions: [
            basicSetup,
            markdown(),
            editableCompartment.of(EditorView.editable.of(!props.readonly)),
            EditorView.updateListener.of((update) => {
                if (update.docChanged && !applyingExternalValue) {
                    if (pendingReleasedDocumentId === activeDocumentId) {
                        pendingReleasedDocumentId = null;
                    }
                    emit("update:modelValue", update.state.doc.toString());
                }
            }),
        ],
    });
}

function applyExternalValue(value: string): void {
    if (!editorView || editorView.state.doc.toString() === value) return;

    applyingExternalValue = true;
    try {
        editorView.dispatch({
            changes: { from: 0, to: editorView.state.doc.length, insert: value },
        });
    } finally {
        applyingExternalValue = false;
    }
}

function replaceActiveState(value: string): void {
    if (!editorView) return;
    editorView.setState(createState(value));
    editorView.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!props.readonly)),
    });
    editorView.scrollDOM.scrollTop = 0;
}

function switchDocument(nextId: string, value: string): void {
    if (!editorView) return;
    if (nextId === activeDocumentId) {
        if (pendingReleasedDocumentId === nextId) {
            replaceActiveState(value);
            pendingReleasedDocumentId = null;
            return;
        }
        applyExternalValue(value);
        return;
    }

    if (pendingReleasedDocumentId !== activeDocumentId) {
        states.set(activeDocumentId, {
            state: editorView.state,
            scrollTop: editorView.scrollDOM.scrollTop,
        });
    }
    pendingReleasedDocumentId = null;
    const stored = states.get(nextId);
    const cached = stored?.state.doc.toString() === value ? stored : undefined;
    if (stored && !cached) {
        states.delete(nextId);
    }
    editorView.setState(cached?.state ?? createState(value));
    editorView.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!props.readonly)),
    });
    editorView.scrollDOM.scrollTop = cached?.scrollTop ?? 0;
    activeDocumentId = nextId;
}

onMounted(() => {
    if (!editorElement.value) return;

    editorView = new EditorView({
        state: createState(props.modelValue),
        parent: editorElement.value,
    });
});

watch(
    () => [props.documentId, props.modelValue] as const,
    ([documentId, value]) => {
        switchDocument(documentId, value);
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
    states.clear();
    pendingReleasedDocumentId = null;
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
    const heading = extractMarkdownHeadings(doc.toString()).find(
        (candidate) => candidate.text === normalizeMarkdownHeadingText(text),
    );
    if (!heading) return false;

    const line = doc.lineAt(heading.id);
    editorView.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "start" }),
    });
    return true;
}

function whenReady(): Promise<void> {
    return Promise.resolve();
}

function whenSettled(): Promise<void> {
    return Promise.resolve();
}

function cancelAi(): void {}

function releaseDocument(documentId: string): void {
    states.delete(documentId);
    if (documentId !== activeDocumentId) return;
    pendingReleasedDocumentId = documentId;
    replaceActiveState(props.modelValue);
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

function captureMermaidSources(): Promise<string[]> {
    return Promise.resolve([]);
}

function getMermaidDiagrams(
    _sources?: readonly string[],
): Promise<MermaidDiagramSnapshot[]> {
    return Promise.resolve([]);
}

defineExpose<MoraEditorHandle>({
    focus,
    getSelectedText,
    replaceSelection,
    moveCursor,
    execute,
    scrollToHeading,
    whenReady,
    whenSettled,
    captureMermaidSources,
    getMermaidDiagrams,
    cancelAi,
    releaseDocument,
});
</script>
