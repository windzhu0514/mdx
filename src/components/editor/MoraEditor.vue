<template>
    <div class="mora-editor">
        <MilkdownEditor
            v-if="mode === 'wysiwyg'"
            ref="milkdownEditor"
            :model-value="displayValue ?? modelValue"
            :readonly="readonly"
            :upload-image="uploadImage"
            :ai-provider="readonly ? undefined : aiProvider"
            @update:model-value="emit('update:modelValue', $event)"
            @ai-error="emit('ai-error', $event)"
        />
        <div v-else class="source-layout" :class="{ split: sourcePreview }">
            <SourceEditor
                ref="sourceEditor"
                :model-value="modelValue"
                :readonly="readonly"
                @update:model-value="emit('update:modelValue', $event)"
            />
            <MilkdownEditor
                v-if="sourcePreview"
                ref="previewEditor"
                :model-value="displayValue ?? modelValue"
                readonly
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { AIProvider } from "@milkdown/crepe/feature/ai";
import { ref } from "vue";
import type {
    EditorCommand,
    EditorMode,
    ImageUploadHandler,
    MoraEditorHandle,
} from "./editorTypes";
import MilkdownEditor from "./MilkdownEditor.vue";
import SourceEditor from "./SourceEditor.vue";

const props = defineProps<{
    modelValue: string;
    displayValue?: string;
    mode: EditorMode;
    sourcePreview: boolean;
    readonly?: boolean;
    uploadImage?: ImageUploadHandler;
    aiProvider?: AIProvider;
}>();

const emit = defineEmits<{
    "update:modelValue": [markdown: string];
    "ai-error": [message: string];
}>();

const milkdownEditor = ref<MoraEditorHandle | null>(null);
const sourceEditor = ref<MoraEditorHandle | null>(null);
const previewEditor = ref<MoraEditorHandle | null>(null);

function editableEditor(): MoraEditorHandle | null {
    return props.mode === "wysiwyg" ? milkdownEditor.value : sourceEditor.value;
}

function focus(): void {
    editableEditor()?.focus();
}

function getSelectedText(): string {
    return editableEditor()?.getSelectedText() ?? "";
}

function replaceSelection(text: string): void {
    editableEditor()?.replaceSelection(text);
}

function moveCursor(position: "start" | "end"): void {
    editableEditor()?.moveCursor(position);
}

function execute(command: EditorCommand): void {
    editableEditor()?.execute(command);
}

function scrollToHeading(text: string): boolean {
    if (props.mode === "wysiwyg") {
        return milkdownEditor.value?.scrollToHeading(text) ?? false;
    }

    const sourceFound = sourceEditor.value?.scrollToHeading(text) ?? false;
    const previewFound = props.sourcePreview
        ? (previewEditor.value?.scrollToHeading(text) ?? false)
        : false;
    return sourceFound || previewFound;
}

function whenReady(): Promise<void> {
    return editableEditor()?.whenReady() ?? Promise.resolve();
}

defineExpose<MoraEditorHandle>({
    focus,
    getSelectedText,
    replaceSelection,
    moveCursor,
    execute,
    scrollToHeading,
    whenReady,
});
</script>

<style scoped>
.mora-editor {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.source-layout {
    display: grid;
    min-width: 0;
    min-height: 0;
    height: 100%;
    grid-template-columns: minmax(0, 1fr);
}

.source-layout.split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.source-layout.split > :last-child {
    border-left: 1px solid var(--color-border);
}
</style>
