<script setup lang="ts">
import { t } from "../i18n";

import { ref } from "vue";

import { useScrollActivity } from "../composables/useScrollActivity";

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
const outlineScrollElement = ref<HTMLElement>();

useScrollActivity(outlineScrollElement);
</script>

<template>
    <aside
        v-if="props.visible && props.items.length"
        ref="outlineScrollElement"
        class="toc-sidebar"
        :class="{ 'is-compact': props.compact }"
        :aria-label="t('本文目录', 'Document outline')"
    >
        <div class="toc-header">
            <span>{{ t("目录", "Outline") }}</span>
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
</template>
