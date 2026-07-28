<script setup lang="ts">
import type { LeaveDecision } from "../utils/leaveGuard";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ decide: [decision: LeaveDecision] }>();
</script>

<template>
    <div v-if="open" class="leave-dialog-backdrop" role="presentation">
        <section
            class="leave-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-dialog-title"
        >
            <h2 id="leave-dialog-title">保存当前笔记？</h2>
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
        </section>
    </div>
</template>
