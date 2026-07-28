<script setup lang="ts">
import { ref } from "vue";

import { normalizeTags } from "../utils/tags";

const props = defineProps<{ tags: string[] }>();
const emit = defineEmits<{ update: [tags: string[]] }>();
const input = ref("");

function addTag() {
    const next = normalizeTags([...props.tags, input.value]);
    input.value = "";
    emit("update", next);
}

function removeTag(tag: string) {
    emit(
        "update",
        props.tags.filter((item) => item !== tag),
    );
}
</script>

<template>
    <div class="tag-editor" aria-label="笔记标签">
        <span v-for="tag in tags" :key="tag" class="tag-chip">
            {{ tag }}
            <button type="button" :aria-label="`移除标签 ${tag}`" @click="removeTag(tag)">
                ×
            </button>
        </span>
        <input
            v-model="input"
            type="text"
            maxlength="30"
            placeholder="添加标签"
            aria-label="添加标签"
            @keydown.enter.prevent="addTag"
            @keydown.,.prevent="addTag"
        />
    </div>
</template>
