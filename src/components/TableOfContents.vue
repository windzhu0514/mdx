<script setup lang="ts">
export type TocItem = {
    level: number;
    text: string;
    id: number;
};

const props = defineProps<{
    items: TocItem[];
    visible: boolean;
}>();
const emit = defineEmits<{
    select: [text: string];
    visibility: [visible: boolean];
}>();
</script>

<template>
    <aside v-if="props.visible && props.items.length" class="toc-sidebar">
        <div class="toc-header">
            <span>目录</span>
            <button
                class="icon-button small"
                type="button"
                title="隐藏目录"
                aria-label="隐藏目录"
                @click="emit('visibility', false)"
            >
                ×
            </button>
        </div>
        <ul class="toc-list">
            <li
                v-for="item in props.items"
                :key="item.text + item.id"
                :style="{ paddingLeft: `${(item.level - 1) * 12 + 4}px` }"
            >
                <button
                    type="button"
                    :title="item.text"
                    @click="emit('select', item.text)"
                >
                    {{ item.text }}
                </button>
            </li>
        </ul>
    </aside>

    <button
        v-else-if="props.items.length"
        type="button"
        class="toc-show-button"
        title="显示目录"
        aria-label="显示目录"
        @click="emit('visibility', true)"
    >
        ›
    </button>
</template>
