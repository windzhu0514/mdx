<script setup lang="ts">
import { onMounted, ref } from "vue";
import { t } from "../i18n";
const props = defineProps<{
    path: string;
    root: string;
    directory: boolean;
    busy: boolean;
}>();
const emit = defineEmits<{ close: []; execute: [action: string, name: string] }>();
const name = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
onMounted(() => nameInput.value?.focus());
</script>
<template>
    <div class="panel-backdrop" @click.self="!busy && emit('close')">
        <section
            class="history-panel"
            role="dialog"
            aria-modal="true"
            :aria-label="t('文件管理', 'File management')"
            @keydown.esc.stop="!busy && emit('close')"
        >
            <h2>{{ t("文件管理", "File management") }}</h2>
            <p>{{ props.path }}</p>
            <label
                >{{ t("文件或文件夹名称", "File or folder name")
                }}<input v-model="name" :disabled="busy"
            /></label>
            <div class="workspace-operations">
                <button
                    v-if="directory"
                    :disabled="busy || !name.trim()"
                    @click="emit('execute', 'create-file', name)"
                >
                    {{ t("新建文件", "New file") }}
                </button>
                <button
                    v-if="directory"
                    :disabled="busy || !name.trim()"
                    @click="emit('execute', 'create-directory', name)"
                >
                    {{ t("新建文件夹", "New folder") }}
                </button>
                <button
                    v-if="path !== root"
                    :disabled="busy || !name.trim()"
                    @click="emit('execute', 'rename', name)"
                >
                    {{ t("重命名", "Rename") }}
                </button>
                <button
                    v-if="path !== root"
                    :disabled="busy"
                    @click="emit('execute', 'move', name)"
                >
                    {{ t("移动到…", "Move to…") }}
                </button>
                <button
                    v-if="path !== root"
                    :disabled="busy"
                    @click="emit('execute', 'trash', name)"
                >
                    {{ t("移入回收站", "Move to trash") }}
                </button>
                <button :disabled="busy" @click="emit('execute', 'reveal', name)">
                    {{ t("在资源管理器中显示", "Show in file manager") }}
                </button>
                <button :disabled="busy" @click="emit('close')">
                    {{ t("关闭", "Close") }}
                </button>
            </div>
        </section>
    </div>
</template>
