<script setup lang="ts">
import type {
    EditorPreferences,
    FontPreference,
    ThemePreference,
} from "../composables/usePreferences";

defineProps<{
    open: boolean;
    preferences: EditorPreferences;
}>();
const emit = defineEmits<{
    close: [];
    update: [patch: Partial<EditorPreferences>];
}>();

function numberValue(event: Event) {
    return Number((event.target as HTMLInputElement).value);
}
</script>

<template>
    <div v-if="open" class="panel-backdrop" @click.self="emit('close')">
        <section
            class="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
        >
            <header>
                <div>
                    <p class="panel-eyebrow">阅读与外观</p>
                    <h2 id="settings-title">偏好设置</h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭偏好设置"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>

            <label class="setting-field">
                <span>主题</span>
                <select
                    :value="preferences.theme"
                    @change="
                        emit('update', {
                            theme: ($event.target as HTMLSelectElement)
                                .value as ThemePreference,
                        })
                    "
                >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                </select>
            </label>

            <label class="setting-field">
                <span>正文字体</span>
                <select
                    :value="preferences.fontFamily"
                    @change="
                        emit('update', {
                            fontFamily: ($event.target as HTMLSelectElement)
                                .value as FontPreference,
                        })
                    "
                >
                    <option value="sans">清晰无衬线</option>
                    <option value="serif">宋体阅读</option>
                    <option value="mono">等宽写作</option>
                </select>
            </label>

            <label class="setting-field range-field">
                <span>字号 {{ preferences.fontSize }} px</span>
                <input
                    type="range"
                    min="14"
                    max="22"
                    step="1"
                    :value="preferences.fontSize"
                    @input="emit('update', { fontSize: numberValue($event) })"
                />
            </label>

            <label class="setting-field range-field">
                <span>行高 {{ preferences.lineHeight.toFixed(2) }}</span>
                <input
                    type="range"
                    min="1.4"
                    max="2.1"
                    step="0.05"
                    :value="preferences.lineHeight"
                    @input="emit('update', { lineHeight: numberValue($event) })"
                />
            </label>

            <label class="setting-field range-field">
                <span>阅读宽度 {{ preferences.contentWidth }} px</span>
                <input
                    type="range"
                    min="620"
                    max="1200"
                    step="20"
                    :value="preferences.contentWidth"
                    @input="emit('update', { contentWidth: numberValue($event) })"
                />
            </label>

            <label class="setting-check">
                <input
                    type="checkbox"
                    :checked="preferences.showToc"
                    @change="
                        emit('update', {
                            showToc: ($event.target as HTMLInputElement).checked,
                        })
                    "
                />
                默认显示文档目录
            </label>
        </section>
    </div>
</template>
