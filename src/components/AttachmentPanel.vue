<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import type { AttachmentListItem } from "../types/mdx";

const props = defineProps<{
    open: boolean;
    documentName: string;
    items: AttachmentListItem[];
    busyPath?: string | null;
}>();

const emit = defineEmits<{
    close: [];
    add: [];
    openAttachment: [path: string];
    saveAttachment: [path: string];
    insertAttachment: [path: string];
    rename: [path: string, originalName: string];
    remove: [path: string];
}>();

const panel = ref<HTMLElement | null>(null);
const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const renameError = ref("");
const deletingPath = ref<string | null>(null);

function resetLocalActions() {
    renamingPath.value = null;
    renameValue.value = "";
    renameError.value = "";
    deletingPath.value = null;
}

watch(
    () => props.open,
    (open) => {
        resetLocalActions();
        if (open) void nextTick(() => panel.value?.focus());
    },
    { immediate: true },
);

function formatSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function beginRename(item: AttachmentListItem) {
    deletingPath.value = null;
    renamingPath.value = item.path;
    renameValue.value = item.originalName;
    renameError.value = "";
    void nextTick(() => {
        const input = panel.value?.querySelector<HTMLInputElement>(
            ".attachment-rename-input",
        );
        input?.focus();
        input?.select();
    });
}

function cancelRename() {
    renamingPath.value = null;
    renameValue.value = "";
    renameError.value = "";
}

function submitRename(path: string) {
    const originalName = renameValue.value.trim();
    if (!originalName) {
        renameError.value = "文件名不能为空";
        return;
    }
    emit("rename", path, originalName);
    cancelRename();
}

function beginDelete(item: AttachmentListItem) {
    if (item.referenced) return;
    cancelRename();
    deletingPath.value = item.path;
}

function confirmDelete(path: string) {
    emit("remove", path);
    deletingPath.value = null;
}

function handleEscape() {
    if (deletingPath.value) {
        deletingPath.value = null;
        return;
    }
    if (renamingPath.value) {
        cancelRename();
        return;
    }
    emit("close");
}
</script>

<template>
    <div v-if="open" class="panel-backdrop" @click.self="emit('close')">
        <section
            ref="panel"
            class="attachment-panel"
            role="dialog"
            tabindex="-1"
            aria-modal="true"
            aria-labelledby="attachment-title"
            aria-describedby="attachment-description"
            @keydown.esc.prevent.stop="handleEscape"
        >
            <header class="attachment-panel-header">
                <div>
                    <p class="panel-eyebrow">{{ documentName }}</p>
                    <h2 id="attachment-title">附件管理</h2>
                    <p id="attachment-description" class="attachment-summary">
                        {{ items.length }} 个附件 · 打开的是只读缓存副本
                    </p>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭附件管理"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>

            <div class="attachment-toolbar">
                <button type="button" class="primary" @click="emit('add')">
                    添加附件
                </button>
            </div>

            <ul v-if="items.length" class="attachment-list">
                <li
                    v-for="item in items"
                    :key="item.path"
                    class="attachment-row"
                    :data-path="item.path"
                >
                    <div class="attachment-info">
                        <template v-if="renamingPath === item.path">
                            <label :for="`attachment-rename-${item.id}`">
                                修改显示名称
                            </label>
                            <div class="attachment-rename-controls">
                                <input
                                    :id="`attachment-rename-${item.id}`"
                                    v-model="renameValue"
                                    class="attachment-rename-input"
                                    type="text"
                                    @keydown.enter.prevent="submitRename(item.path)"
                                />
                                <button type="button" @click="submitRename(item.path)">
                                    保存名称
                                </button>
                                <button type="button" @click="cancelRename">取消</button>
                            </div>
                            <p v-if="renameError" class="attachment-inline-error">
                                {{ renameError }}
                            </p>
                        </template>
                        <template v-else>
                            <strong>{{ item.originalName }}</strong>
                            <span class="attachment-meta">
                                {{ item.type || "application/octet-stream" }} ·
                                {{ formatSize(item.size) }}
                            </span>
                            <span
                                class="attachment-reference-state"
                                :class="{ referenced: item.referenced }"
                            >
                                {{ item.referenced ? "正文已引用" : "未引用" }}
                            </span>
                        </template>
                    </div>

                    <div
                        v-if="deletingPath === item.path"
                        class="attachment-delete-confirm"
                    >
                        <span>确认从文档中删除此附件？</span>
                        <button
                            type="button"
                            class="danger-filled"
                            @click="confirmDelete(item.path)"
                        >
                            确认删除
                        </button>
                        <button type="button" @click="deletingPath = null">取消</button>
                    </div>
                    <div v-else class="attachment-actions">
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('insertAttachment', item.path)"
                        >
                            插入引用
                        </button>
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('openAttachment', item.path)"
                        >
                            打开
                        </button>
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('saveAttachment', item.path)"
                        >
                            另存为
                        </button>
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="beginRename(item)"
                        >
                            重命名
                        </button>
                        <button
                            type="button"
                            class="danger"
                            :disabled="item.referenced || busyPath === item.path"
                            :title="
                                item.referenced
                                    ? '请先移除正文引用，再删除附件'
                                    : '从当前文档删除附件'
                            "
                            @click="beginDelete(item)"
                        >
                            删除
                        </button>
                    </div>
                    <p v-if="item.referenced" class="attachment-reference-help">
                        请先移除正文引用，再删除附件。
                    </p>
                </li>
            </ul>

            <div v-else class="attachment-empty">
                <strong>还没有附件</strong>
                <p>添加的文件会封装在当前 .mdx 文档中。</p>
                <button type="button" @click="emit('add')">添加附件</button>
            </div>
        </section>
    </div>
</template>
