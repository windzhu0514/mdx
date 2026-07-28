<script setup lang="ts">
defineProps<{
    errorMessage: string;
    statusMessage: string;
    path: string;
    dirty: boolean;
    modeLabel: string;
    wordCount: number;
}>();
</script>

<template>
    <footer class="status-bar" aria-live="polite">
        <div class="status-left">
            <div v-if="errorMessage" class="status-cell status error">
                {{ errorMessage }}
            </div>
            <div v-else class="status-cell">{{ statusMessage }}</div>
            <div class="status-cell path" :title="path">{{ path }}</div>
        </div>
        <div class="status-right">
            <div class="status-cell">{{ dirty ? "未保存" : "已保存" }}</div>
            <div class="status-cell">{{ modeLabel }}</div>
            <div class="status-cell">{{ wordCount }} 字</div>
        </div>
    </footer>
</template>
