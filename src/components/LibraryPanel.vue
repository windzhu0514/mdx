<script setup lang="ts">
import { textMatches } from "../utils/reviewText";
import { t } from "../i18n";

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
    openNote: [path: string, occurrence?: number];
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
                    <p class="panel-eyebrow">
                        {{ t("当前工作区", "Current workspace") }}
                    </p>
                    <h2 id="library-title">{{ t("工作区查找", "Find in workspace") }}</h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    :aria-label="t('关闭工作区查找', 'Close workspace search')"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>
            <form class="library-search" @submit.prevent="emit('search')">
                <input
                    v-model="query"
                    type="search"
                    :placeholder="
                        t('搜索标题、标签和正文', 'Search titles, tags and content')
                    "
                    autofocus
                />
                <button type="submit">{{ t("搜索", "Search") }}</button>
                <button type="button" @click="emit('refresh')">
                    {{ t("刷新列表", "Refresh list") }}
                </button>
            </form>
            <p v-if="loading" class="panel-empty">
                {{ t("正在读取索引…", "Loading index…") }}
            </p>
            <div v-else class="library-results">
                <article
                    v-for="item in query.trim() ? results : notes"
                    :key="item.path"
                    class="library-result"
                >
                    <button type="button" @click="emit('openNote', item.path)">
                        <strong>{{
                            item.title || t("未命名笔记", "Untitled note")
                        }}</strong>
                    </button>
                    <span v-if="item.tags.length" class="result-tags">
                        {{ item.tags.join(" · ") }}
                    </span>
                    <span class="result-snippet">
                        <template
                            v-for="(hit, index) in textMatches(
                                'content' in item && item.content
                                    ? item.content
                                    : 'snippet' in item
                                      ? item.snippet
                                      : item.summary,
                                query.trim(),
                            )"
                            :key="index"
                        >
                            <button
                                type="button"
                                class="search-hit"
                                @click.stop="emit('openNote', item.path, index)"
                            >
                                {{ hit.before }}<mark>{{ hit.match }}</mark
                                >{{ hit.after }}
                            </button>
                        </template>
                        <template
                            v-if="
                                !textMatches(
                                    'content' in item && item.content
                                        ? item.content
                                        : 'snippet' in item
                                          ? item.snippet
                                          : item.summary,
                                    query.trim(),
                                ).length
                            "
                            >{{
                                "snippet" in item ? item.snippet : item.summary
                            }}</template
                        >
                    </span>
                    <small>{{ item.path }}</small>
                </article>
                <p v-if="!(query.trim() ? results : notes).length" class="panel-empty">
                    {{
                        t(
                            "暂无匹配笔记。打开工作区会自动建立索引，也可以刷新当前工作区。",
                            "No matching notes. Opening a workspace builds its index; you can also refresh it.",
                        )
                    }}
                </p>
            </div>
        </section>
    </div>
</template>
