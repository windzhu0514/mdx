<template>
    <div ref="editorElement" class="milkdown-editor"></div>
</template>

<script setup lang="ts">
import { Crepe } from "@milkdown/crepe";
import type { AIProvider } from "@milkdown/crepe/feature/ai";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
    createCodeBlockCommand,
    insertHrCommand,
    liftListItemCommand,
    sinkListItemCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { redo, undo } from "@milkdown/kit/prose/history";
import { selectAll } from "@milkdown/kit/prose/commands";
import { TextSelection } from "@milkdown/kit/prose/state";
import { getMarkdown, replaceAll, replaceRange } from "@milkdown/kit/utils";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { EditorCommand, ImageUploadHandler, MoraEditorHandle } from "./editorTypes";

const props = defineProps<{
    modelValue: string;
    readonly?: boolean;
    uploadImage?: ImageUploadHandler;
    aiProvider?: AIProvider;
}>();

const emit = defineEmits<{
    "update:modelValue": [markdown: string];
    "ai-error": [message: string];
}>();

const editorElement = ref<HTMLDivElement>();
let crepe: Crepe | undefined;
let currentMarkdown = props.modelValue;

onMounted(() => {
    if (!editorElement.value) return;

    const features = {
        [Crepe.Feature.AI]: props.aiProvider ? true : false,
    };
    const featureConfigs = {
        [Crepe.Feature.ImageBlock]: {
            onUpload: async (file: File) => {
                if (!props.uploadImage) throw new Error("图片上传不可用");
                return props.uploadImage(file);
            },
        },
        ...(props.aiProvider
            ? {
                  [Crepe.Feature.AI]: {
                      provider: props.aiProvider,
                      diffReviewOnEnd: true,
                      onError: (error: Error) => emit("ai-error", error.message),
                  },
              }
            : {}),
    };

    crepe = new Crepe({
        root: editorElement.value,
        defaultValue: props.modelValue,
        features,
        featureConfigs,
    });
    crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
            currentMarkdown = markdown;
            if (markdown !== props.modelValue) emit("update:modelValue", markdown);
        });
    });
    crepe.setReadonly(Boolean(props.readonly));
    void crepe.create();
});

watch(
    () => props.modelValue,
    (markdown) => {
        if (!crepe || markdown === currentMarkdown) return;
        crepe.editor.action(replaceAll(markdown));
        currentMarkdown = markdown;
    },
);

watch(
    () => props.readonly,
    (readonly) => {
        crepe?.setReadonly(Boolean(readonly));
    },
);

onBeforeUnmount(() => {
    if (!crepe) return;
    void crepe.destroy();
    crepe = undefined;
});

function focus(): void {
    crepe?.editor.action((ctx) => {
        ctx.get(editorViewCtx).focus();
    });
}

function getSelectedText(): string {
    if (!crepe) return "";

    return crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        return view.state.doc.textBetween(from, to, "\n");
    });
}

function replaceSelection(text: string): void {
    crepe?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.insertText(text, from, to));
    });
}

function moveCursor(position: "start" | "end"): void {
    crepe?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = position === "start" ? 0 : view.state.doc.content.size;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    });
}

function execute(command: EditorCommand): void {
    if (!crepe) return;

    if (command.name === "taskList") {
        executeTaskList();
        return;
    }

    crepe.editor.action((ctx) => {
        if (command.name === "undo") {
            const view = ctx.get(editorViewCtx);
            undo(view.state, view.dispatch);
            return;
        }
        if (command.name === "redo") {
            const view = ctx.get(editorViewCtx);
            redo(view.state, view.dispatch);
            return;
        }
        if (command.name === "selectAll") {
            const view = ctx.get(editorViewCtx);
            selectAll(view.state, view.dispatch);
            return;
        }

        const commands = ctx.get(commandsCtx);
        switch (command.name) {
            case "heading":
                if (command.level === 0) commands.call(turnIntoTextCommand.key);
                else commands.call(wrapInHeadingCommand.key, command.level);
                return;
            case "bold":
                commands.call(toggleStrongCommand.key);
                return;
            case "italic":
                commands.call(toggleEmphasisCommand.key);
                return;
            case "strike":
                commands.call(toggleStrikethroughCommand.key);
                return;
            case "code":
                commands.call(toggleInlineCodeCommand.key);
                return;
            case "blockQuote":
                commands.call(wrapInBlockquoteCommand.key);
                return;
            case "bulletList":
                commands.call(wrapInBulletListCommand.key);
                return;
            case "orderedList":
                commands.call(wrapInOrderedListCommand.key);
                return;
            case "indent":
                commands.call(sinkListItemCommand.key);
                return;
            case "outdent":
                commands.call(liftListItemCommand.key);
                return;
            case "hr":
                commands.call(insertHrCommand.key);
                return;
            case "codeBlock":
                commands.call(createCodeBlockCommand.key);
                return;
        }
    });
}

function executeTaskList(): void {
    if (!crepe) return;

    crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        const markdown = crepe?.editor.action(getMarkdown({ from, to })) ?? "";
        const taskMarkdown = markdown
            ? markdown
                  .split("\n")
                  .map((line) => `- [ ] ${line}`)
                  .join("\n")
            : "- [ ] ";
        crepe?.editor.action(replaceRange(taskMarkdown, { from, to }));
    });
}

defineExpose<MoraEditorHandle>({
    focus,
    getSelectedText,
    replaceSelection,
    moveCursor,
    execute,
});
</script>
