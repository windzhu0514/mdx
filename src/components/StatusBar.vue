<script setup lang="ts">
defineProps<{
    errorMessage: string;
    statusMessage: string;
    path: string;
    dirty: boolean;
    modeLabel: string;
    wordCount: number;
    workspaceVisible: boolean;
    outlineVisible: boolean;
    outlineAvailable: boolean;
}>();

const emit = defineEmits<{
    "toggle-workspace": [];
    "toggle-outline": [];
}>();
</script>

<template>
    <footer class="status-bar" aria-live="polite">
        <button
            type="button"
            class="status-sidebar-toggle workspace-toggle"
            :class="{ active: workspaceVisible }"
            :aria-label="workspaceVisible ? '隐藏工作区' : '显示工作区'"
            :aria-pressed="workspaceVisible"
            @click="emit('toggle-workspace')"
        >
            <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect x="1.5" y="2" width="13" height="12" rx="1" />
                <path d="M5 2v12" />
            </svg>
        </button>
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
        <button
            type="button"
            class="status-sidebar-toggle outline-toggle"
            :class="{ active: outlineVisible }"
            :disabled="!outlineAvailable"
            :aria-label="
                !outlineAvailable
                    ? '当前文档没有目录'
                    : outlineVisible
                      ? '隐藏目录'
                      : '显示目录'
            "
            :aria-pressed="outlineVisible"
            @click="emit('toggle-outline')"
        >
            <svg aria-hidden="true" viewBox="0 0 16 16">
                <rect x="1.5" y="2" width="13" height="12" rx="1" />
                <path d="M11 2v12" />
            </svg>
        </button>
    </footer>
</template>
