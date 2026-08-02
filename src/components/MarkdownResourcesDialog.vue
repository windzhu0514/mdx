<script setup lang="ts">
import { computed } from "vue";

import type { MarkdownResourceItem, MarkdownResourcePlan } from "../types/workspace";

const props = defineProps<{
    open: boolean;
    documentName: string;
    plan: MarkdownResourcePlan;
}>();
const emit = defineEmits<{
    decide: [decision: "continue" | "cancel"];
}>();

const statusLabels: Record<MarkdownResourceItem["status"], string> = {
    ready: "可导入",
    missing: "缺失",
    unreadable: "无法读取",
    oversized: "超限",
};
const hasUnresolved = computed(() =>
    props.plan.items.some((item) => item.status !== "ready"),
);
</script>

<template>
    <div v-if="open" class="workspace-dialog-backdrop" role="presentation">
        <section
            class="workspace-decision-dialog markdown-resources-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="markdown-resources-dialog-title"
            aria-describedby="markdown-resources-dialog-description"
        >
            <p class="panel-eyebrow">Markdown 资源检查</p>
            <h2 id="markdown-resources-dialog-title">导入“{{ documentName }}”</h2>
            <p id="markdown-resources-dialog-description">
                请在继续前确认图片和附件的处理结果。
                <strong v-if="hasUnresolved">
                    继续后，未解决的链接将保持原样，目标笔记中可能无法打开这些资源。
                </strong>
            </p>

            <ul class="markdown-resource-list">
                <li
                    v-for="(item, index) in plan.items"
                    :key="`${item.originalReference}-${index}`"
                >
                    <span
                        class="resource-status"
                        :class="{
                            'is-ready': item.status === 'ready',
                            'is-danger': item.status !== 'ready',
                        }"
                    >
                        {{ statusLabels[item.status] }}
                    </span>
                    <span class="resource-reference">{{ item.originalReference }}</span>
                    <small v-if="item.message">{{ item.message }}</small>
                </li>
            </ul>
            <p v-if="!plan.items.length" class="panel-empty">
                未发现外部资源，可以继续导入。
            </p>

            <div class="workspace-dialog-actions">
                <button type="button" autofocus @click="emit('decide', 'cancel')">
                    取消
                </button>
                <button
                    type="button"
                    :class="{ 'danger-filled': hasUnresolved }"
                    @click="emit('decide', 'continue')"
                >
                    {{ hasUnresolved ? "继续导入（保留未解决链接）" : "继续导入" }}
                </button>
            </div>
        </section>
    </div>
</template>
