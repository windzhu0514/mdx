<script setup lang="ts">
import { t } from "../i18n";

import { computed, nextTick, ref, watch } from "vue";

import type { AppUpdatePhase } from "../composables/useAppUpdater";

const props = defineProps<{
    open: boolean;
    phase: AppUpdatePhase;
    version: string;
    date: string;
    notes: string;
    downloadedBytes: number;
    totalBytes: number | null;
    error: string;
}>();

const emit = defineEmits<{
    close: [];
    download: [];
    install: [];
    retry: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const blocksClose = computed(() => ["downloading", "installing"].includes(props.phase));
const percent = computed(() => {
    if (!props.totalBytes || props.totalBytes <= 0) return null;
    return Math.min(100, (props.downloadedBytes / props.totalBytes) * 100);
});
const progressText = computed(() =>
    props.totalBytes
        ? `${formatBytes(props.downloadedBytes)} / ${formatBytes(props.totalBytes)}`
        : formatBytes(props.downloadedBytes),
);

watch(
    () => props.open,
    async (open) => {
        await nextTick();
        const element = dialog.value;
        if (!element) return;
        if (open && !element.open) element.showModal();
        if (!open && element.open) element.close();
    },
    { immediate: true },
);

function requestClose() {
    if (!blocksClose.value) emit("close");
}

function handleCancel(event: Event) {
    event.preventDefault();
    requestClose();
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
    <dialog
        ref="dialog"
        class="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        @cancel="handleCancel"
    >
        <template v-if="open">
            <header class="update-dialog-header">
                <div>
                    <p class="panel-eyebrow">{{ t("墨笺 更新", "Mora updates") }}</p>
                    <h2 id="update-dialog-title">
                        {{
                            phase === "error" && !version
                                ? t("检查更新失败", "Failed to check for updates")
                                : t("发现新版本", "New version available")
                        }}
                    </h2>
                </div>
                <button
                    type="button"
                    class="update-dialog-close"
                    :aria-label="t('关闭更新窗口', 'Close update dialog')"
                    :disabled="blocksClose"
                    @click="requestClose"
                >
                    ×
                </button>
            </header>

            <div v-if="version" class="update-version-row">
                <strong>{{ t("版本", "Version") }} {{ version }}</strong>
                <time v-if="date" :datetime="date">{{ date.slice(0, 10) }}</time>
            </div>

            <p v-if="notes" class="update-notes">{{ notes }}</p>

            <section v-if="phase === 'downloading'" class="update-progress">
                <div class="update-progress-label">
                    <span>{{ t("正在下载更新…", "Downloading update…") }}</span>
                    <span>{{ progressText }}</span>
                </div>
                <div
                    class="update-progress-track"
                    role="progressbar"
                    :aria-label="t('更新下载进度', 'Update download progress')"
                    aria-valuemin="0"
                    :aria-valuenow="totalBytes ? downloadedBytes : undefined"
                    :aria-valuemax="totalBytes ?? undefined"
                >
                    <span
                        class="update-progress-value"
                        :class="{ indeterminate: percent === null }"
                        :style="percent === null ? undefined : { width: `${percent}%` }"
                    ></span>
                </div>
            </section>

            <p v-else-if="phase === 'installing'" class="update-status">
                {{ t("正在安装更新…", "Installing update…") }}
            </p>
            <p v-else-if="phase === 'error'" class="update-error" role="alert">
                {{
                    error ||
                    t(
                        "无法检查更新，请稍后重试。",
                        "Unable to check for updates. Try again later.",
                    )
                }}
            </p>

            <div class="workspace-dialog-actions update-dialog-actions">
                <template v-if="phase === 'available'">
                    <button type="button" @click="emit('close')">
                        {{ t("稍后", "Later") }}
                    </button>
                    <button
                        type="button"
                        class="update-primary"
                        autofocus
                        @click="emit('download')"
                    >
                        {{ t("下载更新", "Download update") }}
                    </button>
                </template>
                <template v-else-if="phase === 'downloaded'">
                    <button type="button" @click="emit('close')">
                        {{ t("稍后", "Later") }}
                    </button>
                    <button
                        type="button"
                        class="update-primary"
                        autofocus
                        @click="emit('install')"
                    >
                        {{ t("安装并重启", "Install and restart") }}
                    </button>
                </template>
                <template v-else-if="phase === 'error'">
                    <button type="button" @click="emit('close')">
                        {{ t("关闭", "Close") }}
                    </button>
                    <button
                        type="button"
                        class="update-primary"
                        autofocus
                        @click="emit('retry')"
                    >
                        {{ t("重试检查", "Check again") }}
                    </button>
                </template>
            </div>
        </template>
    </dialog>
</template>
