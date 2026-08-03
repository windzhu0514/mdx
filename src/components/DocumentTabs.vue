<script setup lang="ts">
import { nextTick, ref, watch, type ComponentPublicInstance } from "vue";

import type { OpenDocument } from "../composables/useDocumentSession";

const props = defineProps<{
    documents: OpenDocument[];
    activeDocumentId: string | null;
}>();
const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
}>();

const scrollHost = ref<HTMLElement | null>(null);
const tabTargets = new Map<string, HTMLButtonElement>();

function documentStatus(document: OpenDocument) {
    const statuses: string[] = [];
    if (document.dirty) statuses.push("未保存");
    if (document.conflict) statuses.push("外部更改冲突");
    if (document.unavailable) statuses.push("路径不可用");
    return statuses.length > 0 ? `，${statuses.join("，")}` : "";
}

function setTabTarget(id: string, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLButtonElement) tabTargets.set(id, element);
    else tabTargets.delete(id);
}

function activateAt(index: number) {
    const document = props.documents[index];
    if (!document) return;
    emit("activate", document.id);
    tabTargets.get(document.id)?.focus();
}

function focusDocument(id: string) {
    tabTargets.get(id)?.focus();
}

defineExpose({ focusDocument });

function onKeydown(event: KeyboardEvent, index: number) {
    if (event.key === "ArrowRight") {
        event.preventDefault();
        activateAt((index + 1) % props.documents.length);
    } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        activateAt((index - 1 + props.documents.length) % props.documents.length);
    } else if (event.key === "Home") {
        event.preventDefault();
        activateAt(0);
    } else if (event.key === "End") {
        event.preventDefault();
        activateAt(props.documents.length - 1);
    } else if (event.key === "Delete") {
        event.preventDefault();
        const document = props.documents[index];
        if (document) emit("close", document.id);
    }
}

function onWheel(event: WheelEvent) {
    const host = scrollHost.value;
    if (!host || host.scrollWidth <= host.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    host.scrollLeft += event.deltaY;
}

watch(
    () => props.activeDocumentId,
    async (id) => {
        await nextTick();
        if (id) {
            tabTargets.get(id)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
    },
    { immediate: true, flush: "post" },
);
</script>

<template>
    <nav v-if="documents.length" class="document-tabs" aria-label="打开的文档">
        <div
            ref="scrollHost"
            class="document-tabs-scroll"
            role="tablist"
            @wheel="onWheel"
        >
            <div
                v-for="(document, index) in documents"
                :key="document.id"
                class="document-tab"
                :class="{ active: document.id === activeDocumentId }"
            >
                <button
                    :ref="(element) => setTabTarget(document.id, element)"
                    type="button"
                    class="document-tab-target"
                    role="tab"
                    aria-controls="document-editor-panel"
                    :aria-selected="document.id === activeDocumentId"
                    :aria-label="`切换到 ${document.displayName}${documentStatus(document)}`"
                    aria-keyshortcuts="Delete"
                    :tabindex="document.id === activeDocumentId ? 0 : -1"
                    @click="emit('activate', document.id)"
                    @keydown="onKeydown($event, index)"
                >
                    <span
                        v-if="document.dirty"
                        class="document-tab-dirty"
                        aria-hidden="true"
                    />
                    <span class="document-tab-name">{{ document.displayName }}</span>
                    <span
                        v-if="document.conflict"
                        class="document-tab-state conflict"
                        aria-hidden="true"
                    >
                        冲突
                    </span>
                    <span
                        v-if="document.unavailable"
                        class="document-tab-state unavailable"
                        aria-hidden="true"
                    >
                        不可用
                    </span>
                </button>
                <button
                    type="button"
                    class="document-tab-close"
                    :aria-label="`关闭 ${document.displayName}`"
                    tabindex="-1"
                    @click.stop="emit('close', document.id)"
                >
                    ×
                </button>
            </div>
        </div>
    </nav>
</template>
