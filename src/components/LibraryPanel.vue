<script setup lang="ts">
import type { NoteListItem, NoteSearchResult } from "../types/library";

defineProps<{
    open: boolean;
    notes: NoteListItem[];
    results: NoteSearchResult[];
    loading: boolean;
}>();
const query = defineModel<string>("query", { required: true });
const emit = defineEmits<{
    close: [];
    refresh: [];
    search: [];
    openNote: [path: string];
}>();
</script>

<template>
    <div v-if="open" class="panel-backdrop" @click.self="emit('close')">
        <section
            class="library-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-title"
        >
            <header>
                <div>
                    <p class="panel-eyebrow">当前工作区</p>
                    <h2 id="library-title">工作区查找</h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭工作区查找"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>
            <form class="library-search" @submit.prevent="emit('search')">
                <input
                    v-model="query"
                    type="search"
                    placeholder="搜索标题、标签和正文"
                    autofocus
                />
                <button type="submit">搜索</button>
                <button type="button" @click="emit('refresh')">刷新列表</button>
            </form>
            <p v-if="loading" class="panel-empty">正在读取索引…</p>
            <div v-else class="library-results">
                <button
                    v-for="item in query.trim() ? results : notes"
                    :key="item.path"
                    type="button"
                    class="library-result"
                    @click="emit('openNote', item.path)"
                >
                    <strong>{{ item.title || "未命名笔记" }}</strong>
                    <span v-if="item.tags.length" class="result-tags">
                        {{ item.tags.join(" · ") }}
                    </span>
                    <span class="result-snippet">
                        {{ "snippet" in item ? item.snippet : item.summary }}
                    </span>
                    <small>{{ item.path }}</small>
                </button>
                <p v-if="!(query.trim() ? results : notes).length" class="panel-empty">
                    暂无匹配笔记。打开工作区会自动建立索引，也可以刷新当前工作区。
                </p>
            </div>
        </section>
    </div>
</template>
