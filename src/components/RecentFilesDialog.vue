<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import type { RecentFileEntry } from "../types/workspace";

const props = defineProps<{
    open: boolean;
    entries: RecentFileEntry[];
}>();
const emit = defineEmits<{
    "open-file": [path: string];
    "remove-file": [path: string];
    clear: [];
    close: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const query = ref("");
const visibleEntries = computed(() => {
    const entries = props.entries.slice(0, 50);
    const normalizedQuery = query.value.trim().toLocaleLowerCase();
    if (!normalizedQuery) return entries;
    return entries.filter((entry) =>
        `${entry.title}\n${entry.path}`.toLocaleLowerCase().includes(normalizedQuery),
    );
});

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

watch(
    () => props.open,
    async (open) => {
        await nextTick();
        const element = dialog.value;
        if (!element) return;
        if (open && !element.open) element.showModal();
        if (!open && element.open) element.close();
    },
    { immediate: true },
);

function handleCancel(event: Event) {
    event.preventDefault();
    emit("close");
}
</script>

<template>
    <dialog
        ref="dialog"
        class="recent-files-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recent-files-dialog-title"
        @cancel="handleCancel"
    >
        <template v-if="open">
            <header class="workspace-dialog-header">
                <div>
                    <p class="panel-eyebrow">工作区</p>
                    <h2 id="recent-files-dialog-title">最近打开</h2>
                </div>
                <button
                    type="button"
                    class="icon-button recent-files-close"
                    aria-label="关闭最近打开"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>

            <label class="recent-files-search">
                <span>搜索最近打开的文件</span>
                <input
                    v-model="query"
                    type="search"
                    aria-label="搜索最近打开的文件"
                    placeholder="搜索标题或完整路径"
                    autofocus
                />
            </label>

            <ul class="recent-files-list" aria-label="最近打开的文件">
                <li
                    v-for="entry in visibleEntries"
                    :key="entry.path"
                    class="recent-file-row"
                    :class="{ unavailable: !entry.available }"
                    :data-recent-path="entry.path"
                >
                    <button
                        type="button"
                        class="recent-file-open"
                        @click="emit('open-file', entry.path)"
                    >
                        <span class="recent-file-heading">
                            <strong>{{ entry.title.trim() || "未命名笔记" }}</strong>
                            <span
                                v-if="!entry.available"
                                class="resource-status is-danger"
                            >
                                不可用
                            </span>
                        </span>
                        <span class="recent-file-path">{{ entry.path }}</span>
                        <time :datetime="entry.lastOpenedAt">
                            最近打开：{{ formatTime(entry.lastOpenedAt) }}
                        </time>
                    </button>
                    <button
                        type="button"
                        class="recent-file-remove"
                        :aria-label="`从最近打开中移除 ${entry.title || entry.path}`"
                        @click="emit('remove-file', entry.path)"
                    >
                        移除
                    </button>
                </li>
            </ul>
            <p v-if="!visibleEntries.length" class="panel-empty">
                {{ query.trim() ? "没有匹配的最近文件。" : "暂无最近打开的文件。" }}
            </p>

            <footer class="workspace-dialog-actions recent-files-actions">
                <span>最多显示 50 条记录</span>
                <button
                    type="button"
                    class="danger recent-files-clear"
                    :disabled="!entries.length"
                    @click="emit('clear')"
                >
                    清空全部
                </button>
                <button type="button" @click="emit('close')">关闭</button>
            </footer>
        </template>
    </dialog>
</template>
