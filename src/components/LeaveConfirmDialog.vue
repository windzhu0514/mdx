<script setup lang="ts">
import { t } from "../i18n";

import { nextTick, ref, watch } from "vue";

import type { LeaveDecision } from "../utils/leaveGuard";

const props = withDefaults(
    defineProps<{
        open: boolean;
        documentName?: string;
    }>(),
    { documentName: t("当前笔记", "Current note") },
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
        <template v-if="open">
            <h2 id="leave-dialog-title">
                {{ t(`保存“${documentName}”？`, `Save “${documentName}”?`) }}
            </h2>
            <p>
                {{
                    t(
                        "当前内容尚未保存。你可以保存后继续、放弃修改，或取消当前操作。",
                        "You have unsaved changes. Save and continue, discard changes, or cancel this action.",
                    )
                }}
            </p>
            <div class="leave-dialog-actions">
                <button type="button" @click="emit('decide', 'cancel')">
                    {{ t("取消", "Cancel") }}
                </button>
                <button type="button" class="danger" @click="emit('decide', 'discard')">
                    {{ t("放弃修改", "Discard changes") }}
                </button>
                <button
                    type="button"
                    class="primary"
                    autofocus
                    @click="emit('decide', 'save')"
                >
                    {{ t("保存并继续", "Save and continue") }}
                </button>
            </div>
        </template>
    </dialog>
</template>
