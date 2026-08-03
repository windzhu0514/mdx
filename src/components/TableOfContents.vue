<script setup lang="ts">
export type TocItem = {
    level: number;
    text: string;
    id: number;
};

const props = defineProps<{
    items: TocItem[];
    visible: boolean;
    compact: boolean;
}>();
const emit = defineEmits<{ select: [text: string] }>();
</script>

<template>
    <aside
        v-if="props.visible && props.items.length"
        class="toc-sidebar"
        :class="{ 'is-compact': props.compact }"
        aria-label="本文目录"
    >
        <div class="toc-header"><span>目录</span></div>
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
</template>
