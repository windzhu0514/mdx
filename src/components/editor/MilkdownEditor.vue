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
import { normalizeMarkdownHeadingText } from "../../utils/text";

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
let disposed = false;
let ready = false;
let readiness: Promise<void> = Promise.resolve();

function reportLifecycleError(operation: string, error: unknown): void {
    console.error(`Crepe ${operation}失败`, error);
}

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

    const instance = new Crepe({
        root: editorElement.value,
        defaultValue: props.modelValue,
        features,
        featureConfigs,
    });
    crepe = instance;
    disposed = false;
    ready = false;
    instance.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
            if (disposed || crepe !== instance) return;
            currentMarkdown = markdown;
            if (markdown !== props.modelValue) emit("update:modelValue", markdown);
        });
    });
    instance.setReadonly(Boolean(props.readonly));
    readiness = instance
        .create()
        .then(() => {
            if (disposed || crepe !== instance) return;

            ready = true;
            instance.setReadonly(Boolean(props.readonly));
            if (props.modelValue === currentMarkdown) return;
            instance.editor.action(replaceAll(props.modelValue));
            currentMarkdown = props.modelValue;
    });
    void readiness.catch((error: unknown) => {
        reportLifecycleError("初始化", error);
    });
});

watch(
    () => props.modelValue,
    (markdown) => {
        if (!crepe || !ready || disposed || markdown === currentMarkdown) return;
        crepe.editor.action(replaceAll(markdown));
        currentMarkdown = markdown;
    },
);

watch(
    () => props.readonly,
    (readonly) => {
        if (!crepe || !ready || disposed) return;
        crepe.setReadonly(Boolean(readonly));
    },
);

onBeforeUnmount(() => {
    const instance = crepe;
    if (!instance || disposed) return;

    disposed = true;
    ready = false;
    crepe = undefined;
    void readiness
        .then(
            async () => instance.destroy(),
            async () => instance.destroy(),
        )
        .catch((error: unknown) => {
            reportLifecycleError("销毁", error);
        });
});

function focus(): void {
    if (!crepe || !ready || disposed) return;
    crepe.editor.action((ctx) => {
        ctx.get(editorViewCtx).focus();
    });
}

function getSelectedText(): string {
    if (!crepe || !ready || disposed) return "";

    return crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        return view.state.doc.textBetween(from, to, "\n");
    });
}

function replaceSelection(text: string): void {
    if (!crepe || !ready || disposed) return;
    crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.insertText(text, from, to));
    });
}

function moveCursor(position: "start" | "end"): void {
    if (!crepe || !ready || disposed) return;
    crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = position === "start" ? 0 : view.state.doc.content.size;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    });
}

function scrollToHeading(text: string): boolean {
    if (!crepe || !ready || disposed) return false;

    return crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let headingPosition: number | undefined;
        view.state.doc.descendants((node, position) => {
            if (
                headingPosition === undefined &&
                node.type.name === "heading" &&
                normalizeMarkdownHeadingText(node.textContent) ===
                    normalizeMarkdownHeadingText(text)
            ) {
                headingPosition = position + 1;
            }
            return headingPosition === undefined;
        });
        if (headingPosition === undefined) return false;

        const transaction = view.state.tr
            .setSelection(TextSelection.create(view.state.doc, headingPosition))
            .scrollIntoView();
        view.dispatch(transaction);
        return true;
    });
}

function execute(command: EditorCommand): void {
    if (!crepe || !ready || disposed) return;

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
    if (!crepe || !ready || disposed) return;

    const instance = crepe;
    instance.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        const markdown = instance.editor.action(getMarkdown({ from, to }));
        const taskMarkdown = markdown
            ? markdown
                  .split("\n")
                  .map((line) => `- [ ] ${line}`)
                  .join("\n")
            : "- [ ] ";
        instance.editor.action(replaceRange(taskMarkdown, { from, to }));
    });
}

function whenReady(): Promise<void> {
    return readiness;
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
