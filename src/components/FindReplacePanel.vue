<script setup lang="ts">
import { t } from "../i18n";

import { nextTick, ref } from "vue";

defineProps<{
    open: boolean;
    replaceOpen: boolean;
    matchCount: number;
}>();

const query = defineModel<string>("query", { required: true });
const replacement = defineModel<string>("replacement", { required: true });
const emit = defineEmits<{
    previous: [];
    next: [];
    expand: [];
    close: [];
    replaceCurrent: [];
    replaceAll: [];
}>();

const findInput = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);

function focusFind(selectText = true) {
    void nextTick(() => {
        findInput.value?.focus();
        if (selectText) findInput.value?.select();
    });
}

function focusReplace() {
    void nextTick(() => {
        replaceInput.value?.focus();
        replaceInput.value?.select();
    });
}

function navigateFromEnter(backwards: boolean) {
    if (backwards) emit("previous");
    else emit("next");
}

defineExpose({ focusFind, focusReplace });
</script>

<template>
    <div v-if="open" class="find-panel" role="search">
        <div class="find-row">
            <input
                ref="findInput"
                v-model="query"
                class="find-input"
                type="text"
                :placeholder="t('查找', 'Find')"
                :aria-label="t('查找内容', 'Find text')"
                @keydown.enter.prevent="navigateFromEnter($event.shiftKey)"
            />
            <span class="find-meta">{{ matchCount }} {{ t("处匹配", "matches") }}</span>
            <button type="button" class="find-button" @click="emit('previous')">
                {{ t("上一处", "Previous match") }}
            </button>
            <button type="button" class="find-button" @click="emit('next')">
                {{ t("下一处", "Next match") }}
            </button>
            <button
                v-if="!replaceOpen"
                type="button"
                class="find-button secondary"
                @click="emit('expand')"
            >
                {{ t("替换", "Replace") }}
            </button>
            <button type="button" class="find-button secondary" @click="emit('close')">
                {{ t("关闭", "Close") }}
            </button>
        </div>
        <div v-if="replaceOpen" class="find-row find-row-secondary">
            <input
                ref="replaceInput"
                v-model="replacement"
                class="find-input"
                type="text"
                :placeholder="t('替换为', 'Replace with')"
                :aria-label="t('替换内容', 'Replacement text')"
                @keydown.enter.prevent="emit('replaceCurrent')"
            />
            <button type="button" class="find-button" @click="emit('replaceCurrent')">
                {{ t("替换当前", "Replace current") }}
            </button>
            <button type="button" class="find-button" @click="emit('replaceAll')">
                {{ t("全部替换", "Replace all") }}
            </button>
        </div>
    </div>
</template>
