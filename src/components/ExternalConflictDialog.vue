<script setup lang="ts">
import { t } from "../i18n";

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
        <template v-if="open">
            <p class="panel-eyebrow">
                {{ t("检测到外部更改", "External changes detected") }}
            </p>
            <h2 id="external-conflict-dialog-title">
                “{{ documentName }}{{ t("”已在磁盘上更改", "” changed on disk") }}
            </h2>
            <p id="external-conflict-dialog-description">
                {{
                    t(
                        "当前编辑内容与磁盘版本发生冲突。重新加载会放弃当前未保存的编辑；覆盖会永久替换磁盘上的新版本。",
                        "Your edits conflict with the disk version. Reloading discards unsaved edits; overwriting permanently replaces the newer disk version.",
                    )
                }}
            </p>
            <div class="workspace-dialog-actions conflict-actions">
                <button type="button" autofocus @click="emit('decide', 'cancel')">
                    {{ t("取消", "Cancel") }}
                </button>
                <button type="button" @click="emit('decide', 'save-as')">
                    {{ t("另存为", "Save as") }}
                </button>
                <button type="button" @click="emit('decide', 'reload')">
                    {{ t("重新加载磁盘版本", "Reload disk version") }}
                </button>
                <button
                    type="button"
                    class="danger danger-filled"
                    @click="emit('decide', 'overwrite')"
                >
                    {{ t("覆盖磁盘版本", "Overwrite disk version") }}
                </button>
            </div>
        </template>
    </dialog>
</template>
