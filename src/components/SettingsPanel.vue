<script setup lang="ts">
import { ref } from "vue";
import type {
    EditorPreferences,
    FontPreference,
    ThemePreference,
} from "../composables/usePreferences";

defineProps<{
    open: boolean;
    preferences: EditorPreferences;
    aiKeyConfigured: boolean;
    aiKeySaving: boolean;
}>();
const emit = defineEmits<{
    close: [];
    update: [patch: Partial<EditorPreferences>];
    "save-ai-key": [key: string];
    "delete-ai-key": [];
}>();

const apiKey = ref("");

function numberValue(event: Event) {
    return Number((event.target as HTMLInputElement).value);
}

function saveAiKey() {
    emit("save-ai-key", apiKey.value);
    apiKey.value = "";
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
                    <option value="monochrome">阅读黑白</option>
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

            <div class="ai-settings">
                <div>
                    <p class="panel-eyebrow">AI</p>
                    <h3>OpenAI-compatible 服务</h3>
                </div>

                <label class="setting-field">
                    <span>Base URL</span>
                    <input
                        aria-label="AI Base URL"
                        type="text"
                        autocomplete="url"
                        :value="preferences.aiBaseUrl"
                        @input="
                            emit('update', {
                                aiBaseUrl: ($event.target as HTMLInputElement).value,
                            })
                        "
                    />
                </label>

                <label class="setting-field">
                    <span>模型</span>
                    <input
                        aria-label="AI 模型"
                        type="text"
                        autocomplete="off"
                        :value="preferences.aiModel"
                        @input="
                            emit('update', {
                                aiModel: ($event.target as HTMLInputElement).value,
                            })
                        "
                    />
                </label>

                <label class="setting-field">
                    <span>API Key</span>
                    <input
                        v-model="apiKey"
                        aria-label="AI API Key"
                        type="password"
                        autocomplete="new-password"
                        :disabled="aiKeySaving"
                    />
                </label>

                <div class="setting-actions">
                    <span class="key-status">
                        {{ aiKeyConfigured ? "已配置" : "未配置" }}
                    </span>
                    <button
                        type="button"
                        :disabled="aiKeySaving || !apiKey"
                        @click="saveAiKey"
                    >
                        保存/替换 API Key
                    </button>
                    <button
                        type="button"
                        :disabled="aiKeySaving || !aiKeyConfigured"
                        @click="emit('delete-ai-key')"
                    >
                        删除 API Key
                    </button>
                </div>
            </div>
        </section>
    </div>
</template>
