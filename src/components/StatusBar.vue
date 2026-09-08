<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
    errorMessage: string;
    statusMessage: string;
    progressMessage?: string;
    persistentMessage?: string;
    modeLabel: string;
    wordCount: number;
    workspaceVisible: boolean;
    outlineVisible: boolean;
    outlineAvailable: boolean;
}>();

const emit = defineEmits<{
    "toggle-workspace": [];
    "toggle-outline": [];
    "dismiss-message": [];
}>();
const persistent = computed(() => props.errorMessage || props.persistentMessage || "");
const displayMessage = computed(() =>
    [
        props.progressMessage,
        persistent.value || (props.progressMessage ? "" : props.statusMessage),
    ]
        .filter(Boolean)
        .join(" · "),
);
const messageDialog = ref<HTMLDialogElement | null>(null);
const detailsText = ref("");
function showDetails() {
    detailsText.value = persistent.value;
    messageDialog.value?.showModal();
}
defineExpose({ isDetailsOpen: () => messageDialog.value?.open ?? false });
</script>

<template>
    <footer class="status-bar">
        <button
            type="button"
            class="status-sidebar-toggle workspace-toggle"
            :class="{ active: workspaceVisible }"
            :aria-label="workspaceVisible ? '隐藏工作区' : '显示工作区'"
            :aria-pressed="workspaceVisible"
            @click="emit('toggle-workspace')"
        >
            <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect x="1.5" y="2" width="13" height="12" rx="1" />
                <path d="M5 2v12" />
            </svg>
        </button>
        <div class="status-left">
            <div class="status-cell status-feedback" :class="{ error: !!errorMessage }">
                <span
                    class="status-message-text"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {{ displayMessage }}
                </span>
                <template v-if="persistent">
                    <button
                        type="button"
                        class="status-message-action"
                        aria-label="查看提示详情"
                        @click="showDetails"
                    >
                        详情
                    </button>
                    <button
                        type="button"
                        class="status-message-action"
                        aria-label="关闭提示"
                        @click="emit('dismiss-message')"
                    >
                        ×
                    </button>
                </template>
            </div>
        </div>
        <div class="status-right">
            <div class="status-cell">{{ modeLabel }}</div>
            <div class="status-cell">{{ wordCount }} 字</div>
        </div>
        <button
            type="button"
            class="status-sidebar-toggle outline-toggle"
            :class="{ active: outlineVisible }"
            :disabled="!outlineAvailable"
            :aria-label="
                !outlineAvailable
                    ? '当前文档没有目录'
                    : outlineVisible
                      ? '隐藏目录'
                      : '显示目录'
            "
            :aria-pressed="outlineVisible"
            @click="emit('toggle-outline')"
        >
            <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect x="1.5" y="2" width="13" height="12" rx="1" />
                <path d="M11 2v12" />
            </svg>
        </button>
    </footer>
    <dialog
        ref="messageDialog"
        class="status-message-dialog"
        aria-labelledby="status-message-title"
        @close="detailsText = ''"
    >
        <h2 id="status-message-title">提示详情</h2>
        <p>{{ detailsText }}</p>
        <button
            type="button"
            class="status-message-action"
            aria-label="关闭详情"
            autofocus
            @click="messageDialog?.close()"
        >
            关闭
        </button>
    </dialog>
</template>

<style scoped>
.status-feedback {
    min-width: 0;
    width: 100%;
    gap: 8px;
}
.status-feedback.error {
    color: var(--color-danger);
}
.status-message-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.status-message-action {
    flex: 0 0 auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 2px 7px;
    min-height: 24px;
    background: var(--color-bg-control);
    color: inherit;
    cursor: pointer;
}
.status-message-action:hover {
    background: var(--color-bg-control-hover);
}
.status-message-dialog {
    margin: auto;
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    padding: 24px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-popup);
    color: var(--color-text-main);
    box-shadow: var(--shadow-lg);
}
.status-message-dialog::backdrop {
    background: rgb(0 0 0 / 30%);
}
.status-message-dialog h2 {
    font-size: 16px;
}
.status-message-dialog p {
    margin: 16px 0;
    max-height: 55vh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.6;
}
</style>
