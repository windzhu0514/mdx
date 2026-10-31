<script setup lang="ts">
import { locale, t } from "../i18n";

import { lineDifference } from "../utils/reviewText";
import type { HistorySnapshot } from "../types/history";
import { computed, nextTick, ref, watch } from "vue";
import type { HistoryListItem } from "../types/history";

const props = defineProps<{
    open: boolean;
    items: HistoryListItem[];
    loading: boolean;
    snapshot?: HistorySnapshot | null;
    selected?: string;
    currentContent?: string;
}>();
const panel = ref<HTMLElement | null>(null);
const emit = defineEmits<{
    close: [];
    refresh: [];
    restore: [name: string];
    preview: [name: string];
}>();

const differences = computed(() =>
    props.snapshot
        ? lineDifference(props.snapshot.content, props.currentContent ?? "")
        : [],
);

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale.value);
}

watch(
    () => props.open,
    (open) => {
        if (open) void nextTick(() => panel.value?.focus());
    },
    { immediate: true },
);
</script>

<template>
    <div v-if="open" class="panel-backdrop" @click.self="emit('close')">
        <section
            ref="panel"
            class="history-panel"
            role="dialog"
            tabindex="-1"
            aria-modal="true"
            aria-labelledby="history-title"
        >
            <header>
                <div>
                    <p class="panel-eyebrow">
                        {{ t("自动保存快照", "Automatic snapshot") }}
                    </p>
                    <h2 id="history-title">{{ t("历史版本", "Version history") }}</h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    :aria-label="t('关闭历史版本', 'Close version history')"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>
            <button type="button" class="panel-refresh" @click="emit('refresh')">
                {{ t("刷新历史", "Refresh history") }}
            </button>
            <p v-if="loading" class="panel-empty">
                {{ t("正在读取历史…", "Loading history…") }}
            </p>
            <section v-if="snapshot" class="history-review">
                <h3>{{ t("版本正文（只读）", "Version content (read only)") }}</h3>
                <pre>{{ snapshot.content }}</pre>
                <h3>
                    {{
                        t(
                            "与当前正文对比：− 历史 / + 当前",
                            "Compare: − history / + current",
                        )
                    }}
                </h3>
                <pre><div v-for="(line,index) in differences" :key="index" :class="`diff-${line.kind}`">{{ line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  ' }}{{ line.text }}</div></pre>
                <button type="button" @click="emit('restore', selected!)">
                    {{ t("确认恢复此版本", "Confirm restore version") }}
                </button>
            </section>
            <div v-if="!loading" class="history-list">
                <article v-for="item in items" :key="item.name" class="history-item">
                    <div>
                        <strong>{{
                            item.title || t("未命名笔记", "Untitled note")
                        }}</strong>
                        <time :datetime="item.createdAt">
                            {{ formatTime(item.createdAt) }}
                        </time>
                    </div>
                    <button type="button" @click="emit('preview', item.name)">
                        {{ t("预览与对比", "Preview and compare") }}
                    </button>
                </article>
                <p v-if="!items.length" class="panel-empty">
                    {{
                        t(
                            "暂无历史。覆盖保存笔记后会自动创建快照。",
                            "No history yet. Saving over an existing note creates a snapshot.",
                        )
                    }}
                </p>
            </div>
        </section>
    </div>
</template>
