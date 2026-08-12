<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();
const maximized = ref(false);
let unlistenResize: (() => void) | undefined;

async function syncMaximized() {
    maximized.value = await appWindow.isMaximized();
}

async function runWindowCommand(command: () => Promise<void>) {
    try {
        await command();
    } catch (error) {
        console.error("窗口命令执行失败", error);
    }
}

async function toggleMaximize() {
    await runWindowCommand(() => appWindow.toggleMaximize());
    await runWindowCommand(syncMaximized);
}

onMounted(async () => {
    await runWindowCommand(syncMaximized);
    try {
        unlistenResize = await appWindow.onResized(() =>
            runWindowCommand(syncMaximized),
        );
    } catch (error) {
        console.error("窗口状态监听失败", error);
    }
});

onBeforeUnmount(() => unlistenResize?.());
</script>

<template>
    <div class="window-controls" aria-label="窗口控制">
        <button
            type="button"
            class="window-control window-control-minimize"
            aria-label="最小化窗口"
            title="最小化窗口"
            @click="runWindowCommand(() => appWindow.minimize())"
        >
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 6.5h8" />
            </svg>
        </button>
        <button
            type="button"
            class="window-control window-control-maximize"
            :aria-label="maximized ? '还原窗口' : '最大化窗口'"
            :title="maximized ? '还原窗口' : '最大化窗口'"
            @click="toggleMaximize"
        >
            <svg v-if="maximized" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4 2.5h5.5V8M2.5 4H8v5.5H2.5z" />
            </svg>
            <svg v-else viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" />
            </svg>
        </button>
        <button
            type="button"
            class="window-control window-control-close"
            aria-label="关闭窗口"
            title="关闭窗口"
            @click="runWindowCommand(() => appWindow.close())"
        >
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="m2.5 2.5 7 7m0-7-7 7" />
            </svg>
        </button>
    </div>
</template>

<style scoped>
.window-controls {
    display: flex;
    align-self: stretch;
    flex: 0 0 auto;
}

.window-control {
    display: grid;
    width: 46px;
    height: 42px;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--color-text-main);
    cursor: default;
}

.window-control:hover {
    background: var(--color-bg-control-hover);
}

.window-control:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
}

.window-control-close:hover,
.window-control-close:focus-visible {
    background: #c42b1c;
    color: #ffffff;
}

.window-control svg {
    width: 12px;
    height: 12px;
    overflow: visible;
    fill: none;
    stroke: currentColor;
    stroke-linecap: square;
    stroke-linejoin: miter;
    stroke-width: 1;
}
</style>
