<script setup lang="ts">
import { locale, t } from "../i18n";

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
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale.value);
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
                    <p class="panel-eyebrow">{{ t("工作区", "Workspace") }}</p>
                    <h2 id="recent-files-dialog-title">
                        {{ t("最近打开", "Recent files") }}
                    </h2>
                </div>
                <button
                    type="button"
                    class="icon-button recent-files-close"
                    :aria-label="t('关闭最近打开', 'Close recent files')"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>

            <label class="recent-files-search">
                <span>{{ t("搜索最近打开的文件", "Search recent files") }}</span>
                <input
                    v-model="query"
                    type="search"
                    :aria-label="t('搜索最近打开的文件', 'Search recent files')"
                    :placeholder="t('搜索标题或完整路径', 'Search title or full path')"
                    autofocus
                />
            </label>

            <ul
                class="recent-files-list"
                :aria-label="t('最近打开的文件', 'Recent files')"
            >
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
                            <strong>{{
                                entry.title.trim() || t("未命名笔记", "Untitled note")
                            }}</strong>
                            <span
                                v-if="!entry.available"
                                class="resource-status is-danger"
                            >
                                {{ t("不可用", "Unavailable") }}
                            </span>
                        </span>
                        <span class="recent-file-path">{{ entry.path }}</span>
                        <time :datetime="entry.lastOpenedAt">
                            {{ t("最近打开：", "Recent files:")
                            }}{{ formatTime(entry.lastOpenedAt) }}
                        </time>
                    </button>
                    <button
                        type="button"
                        class="recent-file-remove"
                        :aria-label="
                            t(
                                `从最近打开中移除 ${entry.title || entry.path}`,
                                `Remove ${entry.title || entry.path} from recent files`,
                            )
                        "
                        @click="emit('remove-file', entry.path)"
                    >
                        {{ t("移除", "Remove") }}
                    </button>
                </li>
            </ul>
            <p v-if="!visibleEntries.length" class="panel-empty">
                {{
                    query.trim()
                        ? t("没有匹配的最近文件。", "No matching recent files.")
                        : t("暂无最近打开的文件。", "No recent files yet.")
                }}
            </p>

            <footer class="workspace-dialog-actions recent-files-actions">
                <span>{{ t("最多显示 50 条记录", "Up to 50 entries") }}</span>
                <button
                    type="button"
                    class="danger recent-files-clear"
                    :disabled="!entries.length"
                    @click="emit('clear')"
                >
                    {{ t("清空全部", "Clear all") }}
                </button>
                <button type="button" @click="emit('close')">
                    {{ t("关闭", "Close") }}
                </button>
            </footer>
        </template>
    </dialog>
</template>
