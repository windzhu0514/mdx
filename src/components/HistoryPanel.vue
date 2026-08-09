<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { HistoryListItem } from "../types/history";

const props = defineProps<{
    open: boolean;
    items: HistoryListItem[];
    loading: boolean;
}>();
const panel = ref<HTMLElement | null>(null);
const emit = defineEmits<{
    close: [];
    refresh: [];
    restore: [name: string];
}>();

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

watch(
    () => props.open,
    (open) => {
        if (open) void nextTick(() => panel.value?.focus());
    },
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
                    <p class="panel-eyebrow">自动保存快照</p>
                    <h2 id="history-title">历史版本</h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭历史版本"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>
            <button type="button" class="panel-refresh" @click="emit('refresh')">
                刷新历史
            </button>
            <p v-if="loading" class="panel-empty">正在读取历史…</p>
            <div v-else class="history-list">
                <article v-for="item in items" :key="item.name" class="history-item">
                    <div>
                        <strong>{{ item.title || "未命名笔记" }}</strong>
                        <time :datetime="item.createdAt">
                            {{ formatTime(item.createdAt) }}
                        </time>
                    </div>
                    <button type="button" @click="emit('restore', item.name)">
                        恢复此版本
                    </button>
                </article>
                <p v-if="!items.length" class="panel-empty">
                    暂无历史。覆盖保存笔记后会自动创建快照。
                </p>
            </div>
        </section>
    </div>
</template>
