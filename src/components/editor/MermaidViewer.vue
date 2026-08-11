<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { MermaidDiagramSnapshot, MermaidViewerRequest } from "./mermaidPreview";

const props = withDefaults(
    defineProps<{
        request: MermaidViewerRequest | null;
        documentName: string;
        exporting?: boolean;
        exportError?: string;
    }>(),
    { exporting: false, exportError: "" },
);
const emit = defineEmits<{
    close: [];
    export: [diagram: MermaidDiagramSnapshot];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const activeIndex = ref(0);
const zoom = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const fullscreen = ref(false);
const dragging = ref(false);
const dragOrigin = { x: 0, y: 0, offsetX: 0, offsetY: 0 };
const zoomLevels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

const diagrams = computed(() => props.request?.diagrams ?? []);
const activeDiagram = computed(() => diagrams.value[activeIndex.value] ?? null);
const canZoomOut = computed(() => zoom.value > zoomLevels[0]);
const canZoomIn = computed(() => zoom.value < zoomLevels[zoomLevels.length - 1]);
const canvasTransform = computed(
    () =>
        `translate(-50%, -50%) translate(${offsetX.value}px, ${offsetY.value}px) scale(${zoom.value})`,
);

function resetView(): void {
    zoom.value = 1;
    offsetX.value = 0;
    offsetY.value = 0;
    dragging.value = false;
}

function selectDiagram(index: number): void {
    if (index < 0 || index >= diagrams.value.length || index === activeIndex.value)
        return;
    activeIndex.value = index;
    resetView();
}

function setZoom(value: number): void {
    zoom.value = Math.min(
        zoomLevels[zoomLevels.length - 1],
        Math.max(zoomLevels[0], value),
    );
    if (zoom.value <= 1) {
        offsetX.value = 0;
        offsetY.value = 0;
    }
}

function stepZoom(direction: -1 | 1): void {
    const current = zoomLevels.findIndex((level) => level >= zoom.value);
    const index = Math.min(
        zoomLevels.length - 1,
        Math.max(0, (current === -1 ? zoomLevels.length - 1 : current) + direction),
    );
    setZoom(zoomLevels[index]);
}

function handleWheel(event: WheelEvent): void {
    stepZoom(event.deltaY > 0 ? -1 : 1);
}

function handlePointerDown(event: PointerEvent): void {
    if (zoom.value <= 1 || event.button !== 0) return;
    dragging.value = true;
    dragOrigin.x = event.clientX;
    dragOrigin.y = event.clientY;
    dragOrigin.offsetX = offsetX.value;
    dragOrigin.offsetY = offsetY.value;
    if (typeof event.currentTarget !== "object" || !event.currentTarget) return;
    const target = event.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === "function" && event.pointerId !== undefined) {
        target.setPointerCapture(event.pointerId);
    }
}

function handlePointerMove(event: PointerEvent): void {
    if (!dragging.value) return;
    offsetX.value = dragOrigin.offsetX + event.clientX - dragOrigin.x;
    offsetY.value = dragOrigin.offsetY + event.clientY - dragOrigin.y;
}

function stopDragging(): void {
    dragging.value = false;
}

function handleCancel(event: Event): void {
    event.preventDefault();
    emit("close");
}

function handleBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) emit("close");
}

function exportActive(): void {
    if (activeDiagram.value && !props.exporting) emit("export", activeDiagram.value);
}

watch(
    () => props.request,
    async (request) => {
        activeIndex.value = request
            ? Math.min(Math.max(request.activeIndex, 0), request.diagrams.length - 1)
            : 0;
        resetView();
        fullscreen.value = false;
        await nextTick();
        const element = dialog.value;
        if (!element) return;
        if (request && !element.open) element.showModal();
        if (!request && element.open) element.close();
    },
    { immediate: true },
);
</script>

<template>
    <dialog
        ref="dialog"
        class="mermaid-viewer-dialog"
        :class="{ 'is-fullscreen': fullscreen }"
        aria-modal="true"
        aria-labelledby="mermaid-viewer-title"
        @cancel="handleCancel"
        @click="handleBackdrop"
    >
        <section v-if="request && activeDiagram" class="mermaid-viewer-shell">
            <header class="mermaid-viewer-toolbar">
                <div class="mermaid-viewer-heading">
                    <span class="mermaid-viewer-mark" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <rect x="3" y="4" width="7" height="6" rx="1.5" />
                            <rect x="14" y="14" width="7" height="6" rx="1.5" />
                            <path d="M10 7h3a4 4 0 0 1 4 4v3" />
                        </svg>
                    </span>
                    <div>
                        <h2 id="mermaid-viewer-title">{{ activeDiagram.label }}</h2>
                        <p>{{ documentName || "未命名笔记" }}</p>
                    </div>
                </div>

                <nav class="mermaid-viewer-navigation" aria-label="图表导航">
                    <button
                        type="button"
                        aria-label="上一张图"
                        title="上一张图"
                        :disabled="activeIndex === 0"
                        @click="selectDiagram(activeIndex - 1)"
                    >
                        ‹
                    </button>
                    <span>{{ activeIndex + 1 }} / {{ diagrams.length }}</span>
                    <button
                        type="button"
                        aria-label="下一张图"
                        title="下一张图"
                        :disabled="activeIndex === diagrams.length - 1"
                        @click="selectDiagram(activeIndex + 1)"
                    >
                        ›
                    </button>
                </nav>

                <div class="mermaid-viewer-actions">
                    <div class="mermaid-viewer-zoom" aria-label="缩放控制">
                        <button
                            type="button"
                            aria-label="缩小"
                            title="缩小"
                            :disabled="!canZoomOut"
                            @click="stepZoom(-1)"
                        >
                            −
                        </button>
                        <select
                            :value="zoom"
                            aria-label="缩放比例"
                            title="缩放比例"
                            @change="
                                setZoom(
                                    Number(($event.target as HTMLSelectElement).value),
                                )
                            "
                        >
                            <option
                                v-for="level in zoomLevels"
                                :key="level"
                                :value="level"
                            >
                                {{ Math.round(level * 100) }}%
                            </option>
                        </select>
                        <button
                            type="button"
                            aria-label="放大"
                            title="放大"
                            :disabled="!canZoomIn"
                            @click="stepZoom(1)"
                        >
                            ＋
                        </button>
                    </div>
                    <button
                        type="button"
                        aria-label="适应视图"
                        title="适应视图"
                        @click="resetView"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M9 9H5V5m10 4h4V5M9 15H5v4m10-4h4v4" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        :aria-label="fullscreen ? '退出全屏' : '全屏查看'"
                        :title="fullscreen ? '退出全屏' : '全屏查看'"
                        :aria-pressed="fullscreen"
                        @click="fullscreen = !fullscreen"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        aria-label="导出 PNG"
                        title="导出 PNG"
                        :disabled="exporting"
                        @click="exportActive"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 3v12m-4-4 4 4 4-4M5 20h14" />
                        </svg>
                    </button>
                    <span class="mermaid-viewer-divider" aria-hidden="true"></span>
                    <button
                        type="button"
                        aria-label="关闭查看器"
                        title="关闭查看器"
                        @click="emit('close')"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m5 5 14 14M19 5 5 19" />
                        </svg>
                    </button>
                </div>
            </header>

            <div
                class="mermaid-viewer-viewport"
                :class="{ 'is-draggable': zoom > 1, 'is-dragging': dragging }"
                @wheel.prevent="handleWheel"
                @pointerdown="handlePointerDown"
                @pointermove="handlePointerMove"
                @pointerup="stopDragging"
                @pointercancel="stopDragging"
                @pointerleave="stopDragging"
            >
                <!-- Mermaid 在 strict 安全级别下生成的 SVG，不接受外部 HTML。 -->
                <!-- eslint-disable vue/no-v-html -->
                <div
                    class="mermaid-viewer-canvas"
                    :style="{ transform: canvasTransform }"
                    v-html="activeDiagram.svg"
                ></div>
                <aside
                    v-if="zoom > 1"
                    class="mermaid-viewer-minimap"
                    aria-label="图表缩略图"
                >
                    <div
                        class="mermaid-viewer-minimap-image"
                        v-html="activeDiagram.svg"
                    ></div>
                    <span
                        class="mermaid-viewer-minimap-frame"
                        :style="{
                            width: `${Math.max(18, 100 / zoom)}%`,
                            height: `${Math.max(18, 100 / zoom)}%`,
                            transform: `translate(${50 - 50 / zoom - offsetX / 18}px, ${50 - 50 / zoom - offsetY / 18}px)`,
                        }"
                    ></span>
                </aside>
                <!-- eslint-enable vue/no-v-html -->
                <div class="mermaid-viewer-hint">滚轮缩放 · 拖动查看</div>
                <p v-if="exportError" class="mermaid-viewer-error" role="alert">
                    {{ exportError }}
                </p>
            </div>
        </section>
    </dialog>
</template>

<style scoped>
.mermaid-viewer-dialog {
    width: min(94vw, 1500px);
    height: min(90vh, 960px);
    max-width: none;
    max-height: none;
    margin: auto;
    padding: 0;
    overflow: hidden;
    color: var(--color-text-main);
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
}

.mermaid-viewer-dialog::backdrop {
    background: rgba(4, 8, 15, 0.72);
    backdrop-filter: blur(3px);
}

.mermaid-viewer-dialog.is-fullscreen {
    width: 100vw;
    height: 100vh;
    border: 0;
    border-radius: 0;
}

.mermaid-viewer-shell {
    display: grid;
    grid-template-rows: 64px minmax(0, 1fr);
    width: 100%;
    height: 100%;
}

.mermaid-viewer-toolbar {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr);
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    background: var(--color-bg-chrome);
    border-bottom: 1px solid var(--color-border);
    box-shadow: 0 1px 0 var(--color-inset-highlight) inset;
}

.mermaid-viewer-heading {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
}

.mermaid-viewer-heading > div {
    min-width: 0;
}

.mermaid-viewer-heading h2,
.mermaid-viewer-heading p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.mermaid-viewer-heading h2 {
    font-size: 15px;
    font-weight: 650;
}

.mermaid-viewer-heading p {
    margin-top: 2px;
    color: var(--color-text-muted);
    font-size: 11px;
}

.mermaid-viewer-mark {
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    display: grid;
    place-items: center;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-strong);
    border-radius: 8px;
}

.mermaid-viewer-mark svg,
.mermaid-viewer-actions svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.mermaid-viewer-navigation,
.mermaid-viewer-zoom {
    display: flex;
    align-items: center;
    height: 34px;
    overflow: hidden;
    background: var(--color-bg-control);
    border: 1px solid var(--color-border);
    border-radius: 8px;
}

.mermaid-viewer-navigation span {
    min-width: 64px;
    color: var(--color-text-main);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-align: center;
}

.mermaid-viewer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
}

.mermaid-viewer-actions > button,
.mermaid-viewer-navigation button,
.mermaid-viewer-zoom button {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    color: var(--color-text-muted);
    background: transparent;
    border: 0;
    border-radius: 7px;
    cursor: pointer;
}

.mermaid-viewer-actions > button:hover:not(:disabled),
.mermaid-viewer-navigation button:hover:not(:disabled),
.mermaid-viewer-zoom button:hover:not(:disabled) {
    color: var(--color-text-main);
    background: var(--color-bg-control-hover);
}

.mermaid-viewer-actions button:focus-visible,
.mermaid-viewer-navigation button:focus-visible,
.mermaid-viewer-zoom button:focus-visible,
.mermaid-viewer-zoom select:focus-visible {
    box-shadow: 0 0 0 2px var(--color-focus-border);
}

.mermaid-viewer-actions button:disabled,
.mermaid-viewer-navigation button:disabled,
.mermaid-viewer-zoom button:disabled {
    opacity: 0.32;
    cursor: default;
}

.mermaid-viewer-zoom select {
    width: 70px;
    height: 32px;
    color: var(--color-text-main);
    background: transparent;
    border: 0;
    text-align: center;
    cursor: pointer;
}

.mermaid-viewer-zoom option {
    color: var(--color-text-main);
    background: var(--color-bg-popup);
}

.mermaid-viewer-divider {
    width: 1px;
    height: 20px;
    margin: 0 3px;
    background: var(--color-border);
}

.mermaid-viewer-viewport {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    touch-action: none;
    background-color: var(--color-bg-base);
    background-image: radial-gradient(
        circle,
        color-mix(in srgb, var(--color-text-muted) 20%, transparent) 1px,
        transparent 1px
    );
    background-size: 24px 24px;
    user-select: none;
}

.mermaid-viewer-viewport.is-draggable {
    cursor: grab;
}

.mermaid-viewer-viewport.is-dragging {
    cursor: grabbing;
}

.mermaid-viewer-canvas {
    position: absolute;
    top: 50%;
    left: 50%;
    width: min(78%, 1160px);
    height: min(76%, 760px);
    display: grid;
    place-items: center;
    transform-origin: center;
    transition: transform 120ms ease-out;
    pointer-events: none;
}

.is-dragging .mermaid-viewer-canvas {
    transition: none;
}

.mermaid-viewer-canvas :deep(svg) {
    display: block;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
}

.mermaid-viewer-minimap {
    position: absolute;
    right: 18px;
    bottom: 18px;
    width: 176px;
    height: 112px;
    overflow: hidden;
    background: color-mix(in srgb, var(--color-bg-surface) 92%, transparent);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-md);
    pointer-events: none;
}

.mermaid-viewer-minimap-image {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 8px;
    opacity: 0.72;
}

.mermaid-viewer-minimap-image :deep(svg) {
    width: 100%;
    height: 100%;
}

.mermaid-viewer-minimap-frame {
    position: absolute;
    top: 0;
    left: 0;
    min-width: 18px;
    min-height: 18px;
    border: 1px solid var(--color-primary);
    background: var(--color-primary-soft);
    border-radius: 3px;
}

.mermaid-viewer-hint {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    padding: 5px 10px;
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-bg-surface) 84%, transparent);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: 11px;
    pointer-events: none;
}

.mermaid-viewer-error {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    max-width: min(560px, 80%);
    padding: 8px 12px;
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-bg-surface) 94%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
    border-radius: 8px;
    font-size: 12px;
}

@media (max-width: 960px) {
    .mermaid-viewer-toolbar {
        grid-template-columns: minmax(130px, 1fr) auto;
    }

    .mermaid-viewer-navigation {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
    }

    .mermaid-viewer-zoom,
    .mermaid-viewer-divider {
        display: none;
    }
}
</style>
