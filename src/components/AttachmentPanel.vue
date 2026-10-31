<script setup lang="ts">
import { t } from "../i18n";

import { nextTick, ref, watch } from "vue";

import type { AttachmentListItem } from "../types/mdx";

const props = defineProps<{
    open: boolean;
    documentName: string;
    items: AttachmentListItem[];
    busyPath?: string | null;
    format?: "markdown" | "mdx";
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
    () => [props.open, props.format] as const,
    ([open]) => {
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
    if (props.format === "markdown") return;
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
    if (props.format === "markdown") return;
    const originalName = renameValue.value.trim();
    if (!originalName) {
        renameError.value = t("文件名不能为空", "File name cannot be empty");
        return;
    }
    emit("rename", path, originalName);
    cancelRename();
}

function beginDelete(item: AttachmentListItem) {
    if (props.format === "markdown" || item.referenced) return;
    cancelRename();
    deletingPath.value = item.path;
}

function confirmDelete(path: string) {
    if (props.format === "markdown") return;
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
                    <h2 id="attachment-title">{{ t("附件管理", "Attachments") }}</h2>
                    <p id="attachment-description" class="attachment-summary">
                        {{ items.length }}
                        {{
                            t(
                                "个附件 · 打开的是只读缓存副本",
                                "attachments · Opens a read-only cached copy",
                            )
                        }}
                    </p>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    :aria-label="t('关闭附件管理', 'Close attachments')"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>

            <div class="attachment-toolbar">
                <button type="button" class="primary" @click="emit('add')">
                    {{ t("添加附件", "Add attachment") }}
                </button>
            </div>

            <p v-if="format === 'markdown'" class="attachment-summary">
                {{
                    t(
                        "外置资源请在文件夹中管理。",
                        "Manage external resources in their folder.",
                    )
                }}
            </p>

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
                                {{ t("修改显示名称", "Change display name") }}
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
                                    {{ t("保存名称", "Save name") }}
                                </button>
                                <button type="button" @click="cancelRename">
                                    {{ t("取消", "Cancel") }}
                                </button>
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
                                {{
                                    item.referenced
                                        ? t("正文已引用", "Referenced in document")
                                        : t("未引用", "Not referenced")
                                }}
                            </span>
                        </template>
                    </div>

                    <div
                        v-if="deletingPath === item.path"
                        class="attachment-delete-confirm"
                    >
                        <span>{{
                            t(
                                "确认从文档中删除此附件？",
                                "Remove this attachment from the document?",
                            )
                        }}</span>
                        <button
                            type="button"
                            class="danger-filled"
                            @click="confirmDelete(item.path)"
                        >
                            {{ t("确认删除", "Confirm deletion") }}
                        </button>
                        <button type="button" @click="deletingPath = null">
                            {{ t("取消", "Cancel") }}
                        </button>
                    </div>
                    <div v-else class="attachment-actions">
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('insertAttachment', item.path)"
                        >
                            {{ t("插入引用", "Insert reference") }}
                        </button>
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('openAttachment', item.path)"
                        >
                            {{ t("打开", "Open") }}
                        </button>
                        <button
                            type="button"
                            :disabled="busyPath === item.path"
                            @click="emit('saveAttachment', item.path)"
                        >
                            {{ t("另存为", "Save as") }}
                        </button>
                        <button
                            type="button"
                            :disabled="format === 'markdown' || busyPath === item.path"
                            @click="beginRename(item)"
                        >
                            {{ t("重命名", "Rename") }}
                        </button>
                        <button
                            type="button"
                            class="danger"
                            :disabled="
                                format === 'markdown' ||
                                item.referenced ||
                                busyPath === item.path
                            "
                            :title="
                                format === 'markdown'
                                    ? t(
                                          '外置资源请在文件夹中管理',
                                          'Manage external resources in their folder',
                                      )
                                    : item.referenced
                                      ? t(
                                            '请先移除正文引用，再删除附件',
                                            'Remove references from the document before deleting this attachment',
                                        )
                                      : t(
                                            '从当前文档删除附件',
                                            'Remove attachment from document',
                                        )
                            "
                            @click="beginDelete(item)"
                        >
                            {{ t("删除", "Delete") }}
                        </button>
                    </div>
                    <p
                        v-if="item.referenced && format !== 'markdown'"
                        class="attachment-reference-help"
                    >
                        {{
                            t(
                                "请先移除正文引用，再删除附件。",
                                "Remove references from the document before deleting this attachment.",
                            )
                        }}
                    </p>
                </li>
            </ul>

            <div v-else class="attachment-empty">
                <strong>{{ t("还没有附件", "No attachments yet") }}</strong>
                <p>
                    {{
                        format === "markdown"
                            ? t(
                                  "添加的文件会保存到文档旁的资源文件夹，请与文档一起保留。",
                                  "Files are saved in a resource folder next to the document. Keep them together.",
                              )
                            : t(
                                  "添加的文件会封装在当前 .mdx 文档中。",
                                  "Files are packed into the current .mdx document.",
                              )
                    }}
                </p>
                <button type="button" @click="emit('add')">
                    {{ t("添加附件", "Add attachment") }}
                </button>
            </div>
        </section>
    </div>
</template>
