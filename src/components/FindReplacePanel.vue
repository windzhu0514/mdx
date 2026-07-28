<script setup lang="ts">
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
                placeholder="查找"
                aria-label="查找内容"
                @keydown.enter.prevent="navigateFromEnter($event.shiftKey)"
            />
            <span class="find-meta">{{ matchCount }} 处匹配</span>
            <button type="button" class="find-button" @click="emit('previous')">
                上一处
            </button>
            <button type="button" class="find-button" @click="emit('next')">
                下一处
            </button>
            <button
                v-if="!replaceOpen"
                type="button"
                class="find-button secondary"
                @click="emit('expand')"
            >
                替换
            </button>
            <button type="button" class="find-button secondary" @click="emit('close')">
                关闭
            </button>
        </div>
        <div v-if="replaceOpen" class="find-row find-row-secondary">
            <input
                ref="replaceInput"
                v-model="replacement"
                class="find-input"
                type="text"
                placeholder="替换为"
                aria-label="替换内容"
                @keydown.enter.prevent="emit('replaceCurrent')"
            />
            <button type="button" class="find-button" @click="emit('replaceCurrent')">
                替换当前
            </button>
            <button type="button" class="find-button" @click="emit('replaceAll')">
                全部替换
            </button>
        </div>
    </div>
</template>
