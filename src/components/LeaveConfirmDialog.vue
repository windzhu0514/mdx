<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import type { LeaveDecision } from "../utils/leaveGuard";

const props = withDefaults(
    defineProps<{
        open: boolean;
        documentName?: string;
    }>(),
    { documentName: "当前笔记" },
);
const emit = defineEmits<{ decide: [decision: LeaveDecision] }>();

const dialog = ref<HTMLDialogElement | null>(null);

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

function handleCancel(event: Event) {
    event.preventDefault();
    emit("decide", "cancel");
}
</script>

<template>
    <dialog
        ref="dialog"
        class="leave-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        @cancel="handleCancel"
    >
        <h2 id="leave-dialog-title">保存“{{ documentName }}”？</h2>
        <p>当前内容尚未保存。你可以保存后继续、放弃修改，或取消当前操作。</p>
        <div class="leave-dialog-actions">
            <button type="button" @click="emit('decide', 'cancel')">取消</button>
            <button type="button" class="danger" @click="emit('decide', 'discard')">
                放弃修改
            </button>
            <button
                type="button"
                class="primary"
                autofocus
                @click="emit('decide', 'save')"
            >
                保存并继续
            </button>
        </div>
    </dialog>
</template>
