<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = defineProps<{
    open: boolean;
    documentName: string;
}>();
const emit = defineEmits<{
    decide: [decision: "overwrite" | "reload" | "save-as" | "cancel"];
}>();

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
        class="workspace-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-conflict-dialog-title"
        aria-describedby="external-conflict-dialog-description"
        @cancel="handleCancel"
    >
        <p class="panel-eyebrow">检测到外部更改</p>
        <h2 id="external-conflict-dialog-title">“{{ documentName }}”已在磁盘上更改</h2>
        <p id="external-conflict-dialog-description">
            当前编辑内容与磁盘版本发生冲突。重新加载会放弃当前未保存的编辑；覆盖会永久替换磁盘上的新版本。
        </p>
        <div class="workspace-dialog-actions conflict-actions">
            <button type="button" autofocus @click="emit('decide', 'cancel')">
                取消
            </button>
            <button type="button" @click="emit('decide', 'save-as')">另存为</button>
            <button type="button" @click="emit('decide', 'reload')">
                重新加载磁盘版本
            </button>
            <button
                type="button"
                class="danger danger-filled"
                @click="emit('decide', 'overwrite')"
            >
                覆盖磁盘版本
            </button>
        </div>
    </dialog>
</template>
