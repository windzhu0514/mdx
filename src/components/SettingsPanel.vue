<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type {
    CodeFontPreference,
    CodeFontOption,
    EditorPreferences,
    FontGroupId,
    FontOption,
    FontPreference,
    ThemePreference,
} from "../composables/usePreferences";
import {
    CODE_FONT_OPTIONS,
    FONT_GROUPS,
    FONT_OPTIONS,
    LOCAL_FONT_FAMILIES,
    THEME_OPTIONS,
} from "../composables/usePreferences";
import type { AgentBridgeStatus } from "../types/agent";

type SettingsCategory = "appearance" | "editor" | "ai" | "agent";

const props = withDefaults(
    defineProps<{
        open: boolean;
        preferences: EditorPreferences;
        aiKeyConfigured: boolean;
        aiKeySaving: boolean;
        agentStatus: AgentBridgeStatus;
        installedFontFamilies?: readonly string[] | null;
    }>(),
    { installedFontFamilies: null },
);
const emit = defineEmits<{
    close: [];
    update: [patch: Partial<EditorPreferences>];
    "save-ai-key": [key: string];
    "delete-ai-key": [];
    "copy-agent-config": [];
}>();

const categories: Array<{
    id: SettingsCategory;
    label: string;
    eyebrow: string;
    description: string;
}> = [
    {
        id: "appearance",
        label: "外观",
        eyebrow: "阅读与外观",
        description: "调整主题、正文字体和代码字体，并立即查看排版效果。",
    },
    {
        id: "editor",
        label: "编辑器",
        eyebrow: "编辑体验",
        description: "设置正文阅读宽度和文档目录的默认显示方式。",
    },
    {
        id: "ai",
        label: "AI",
        eyebrow: "智能写作",
        description: "配置用于所见即所得编辑器的 OpenAI-compatible 服务。",
    },
    {
        id: "agent",
        label: "Agent",
        eyebrow: "本地自动化",
        description: "显式授权同一用户下的本地工具访问当前打开的文档。",
    },
];

const apiKey = ref("");
const workspace = ref<HTMLElement | null>(null);
const activeCategory = ref<SettingsCategory>("appearance");
const activeCategoryInfo = computed(
    () =>
        categories.find((category) => category.id === activeCategory.value) ??
        categories[0],
);
const installedFontFamilySet = computed(() => {
    if (props.installedFontFamilies === null) return null;
    return new Set(
        props.installedFontFamilies.map((family) => family.trim().toLocaleLowerCase()),
    );
});
const agentStatusText = computed(() => {
    if (!props.agentStatus.enabled) return "已关闭（默认关闭）";
    if (!props.agentStatus.listening) return "正在启动本地 endpoint";
    return `正在监听 · ${props.agentStatus.connectedClients} 个连接 · ${props.agentStatus.watcherClients} 个订阅`;
});

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        activeCategory.value = "appearance";
        void nextTick(() => workspace.value?.focus());
    },
    { immediate: true },
);

function numberValue(event: Event) {
    return Number((event.target as HTMLInputElement).value);
}

function saveAiKey() {
    emit("save-ai-key", apiKey.value);
    apiKey.value = "";
}

function fontsInGroup(group: FontGroupId | null) {
    return FONT_OPTIONS.filter((font) => font.group === group);
}

function isFontAvailable(font: FontOption | CodeFontOption) {
    const localFamily = LOCAL_FONT_FAMILIES[font.id];
    if (!localFamily || installedFontFamilySet.value === null) return true;
    return installedFontFamilySet.value.has(localFamily.toLocaleLowerCase());
}

function fontLabel(font: FontOption | CodeFontOption) {
    return isFontAvailable(font) ? font.label : `${font.label}（未安装）`;
}
</script>

<template>
    <section
        v-if="open"
        ref="workspace"
        class="settings-workspace"
        tabindex="-1"
        aria-labelledby="settings-title"
        @keydown.esc="emit('close')"
    >
        <aside class="settings-navigation">
            <header class="settings-navigation-header">
                <button
                    type="button"
                    class="settings-back"
                    aria-label="返回编辑器"
                    @click="emit('close')"
                >
                    返回编辑器
                </button>
                <div>
                    <span class="settings-product-name">Mora 墨笺</span>
                    <h1 id="settings-title">偏好设置</h1>
                </div>
            </header>

            <nav class="settings-nav" aria-label="偏好设置分类">
                <button
                    v-for="category in categories"
                    :key="category.id"
                    type="button"
                    :class="{ active: activeCategory === category.id }"
                    :aria-current="activeCategory === category.id ? 'page' : undefined"
                    @click="activeCategory = category.id"
                >
                    {{ category.label }}
                </button>
            </nav>
        </aside>

        <section class="settings-content" :aria-labelledby="`${activeCategory}-title`">
            <header class="settings-content-header">
                <p class="panel-eyebrow">{{ activeCategoryInfo.eyebrow }}</p>
                <h2 :id="`${activeCategory}-title`">{{ activeCategoryInfo.label }}</h2>
                <p>{{ activeCategoryInfo.description }}</p>
            </header>

            <div
                v-if="activeCategory === 'appearance'"
                class="settings-appearance-layout"
            >
                <div class="settings-card settings-control-list">
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
                            <option
                                v-for="theme in THEME_OPTIONS"
                                :key="theme.id"
                                :value="theme.id"
                            >
                                {{ theme.label }}
                            </option>
                        </select>
                    </label>

                    <label class="setting-field">
                        <span>字体</span>
                        <select
                            :value="preferences.fontFamily"
                            @change="
                                emit('update', {
                                    fontFamily: ($event.target as HTMLSelectElement)
                                        .value as FontPreference,
                                })
                            "
                        >
                            <option
                                v-for="font in fontsInGroup(null)"
                                :key="font.id"
                                :value="font.id"
                                :style="{ fontFamily: font.fontFamily }"
                                :disabled="!isFontAvailable(font)"
                            >
                                {{ fontLabel(font) }}
                            </option>
                            <optgroup
                                v-for="group in FONT_GROUPS"
                                :key="group.id"
                                :label="group.label"
                            >
                                <option
                                    v-for="font in fontsInGroup(group.id)"
                                    :key="font.id"
                                    :value="font.id"
                                    :style="{ fontFamily: font.fontFamily }"
                                    :disabled="!isFontAvailable(font)"
                                >
                                    {{ fontLabel(font) }}
                                </option>
                            </optgroup>
                        </select>
                    </label>

                    <label class="setting-field">
                        <span>代码字体</span>
                        <select
                            :value="preferences.codeFontFamily"
                            @change="
                                emit('update', {
                                    codeFontFamily: ($event.target as HTMLSelectElement)
                                        .value as CodeFontPreference,
                                })
                            "
                        >
                            <option
                                v-for="font in CODE_FONT_OPTIONS"
                                :key="font.id"
                                :value="font.id"
                                :style="{ fontFamily: font.fontFamily }"
                                :disabled="!isFontAvailable(font)"
                            >
                                {{ fontLabel(font) }}
                            </option>
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
                </div>

                <aside class="settings-preview-panel" aria-label="字体实时预览">
                    <div class="settings-preview-heading">
                        <div>
                            <p class="panel-eyebrow">实时预览</p>
                            <h3>正文与代码</h3>
                        </div>
                        <span>更改后立即生效</span>
                    </div>
                    <article class="settings-live-preview">
                        <p class="settings-preview-kicker">Mora 字体预览</p>
                        <h3>让文字保持清晰，也保留一点呼吸感</h3>
                        <p>
                            这是一段中英文混排示例。Mora helps ideas stay focused, and The
                            quick brown fox jumps over the lazy dog.
                        </p>
                        <p>
                            这里包含<strong>加粗文字</strong>、<em>斜体文字</em>、
                            <a href="#" @click.prevent>链接文字</a>和
                            <code>const note = "墨笺"</code> 行内代码。
                        </p>
                        <blockquote>
                            好的排版不会打断阅读，而是在需要时给内容恰当的强调。
                        </blockquote>
                        <pre><code>function greet(name: string) {
    return `Hello, ${name}`;
}</code></pre>
                        <p>
                            长段落用于观察字号、行高与中英文标点的整体节奏。调整左侧选项时，
                            此区域会沿用编辑器当前的正文与代码字体设置，方便在回到文档前完成比较。
                        </p>
                    </article>
                </aside>
            </div>

            <div
                v-else-if="activeCategory === 'editor'"
                class="settings-card settings-control-list"
            >
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
                    <span>
                        <strong>默认显示文档目录</strong>
                        <small>打开包含标题的文档时显示右侧目录。</small>
                    </span>
                </label>
            </div>

            <div v-else-if="activeCategory === 'ai'" class="settings-card ai-settings">
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

            <div v-else class="settings-card agent-settings">
                <label class="setting-check agent-access-toggle">
                    <input
                        type="checkbox"
                        aria-label="本地 Agent 接入"
                        :checked="preferences.agentAccessEnabled"
                        @change="
                            emit('update', {
                                agentAccessEnabled: ($event.target as HTMLInputElement)
                                    .checked,
                            })
                        "
                    />
                    <span>
                        <strong>本地 Agent 接入</strong>
                        <small>默认关闭；仅在你明确开启后运行本地 endpoint。</small>
                    </span>
                </label>

                <div class="agent-security-note" role="note">
                    <strong>访问范围</strong>
                    <p>
                        开启后，同一系统用户下的程序可以读取和修改 Mora
                        当前打开的文档，包括未保存内容。请只连接你信任的本地工具。
                    </p>
                </div>

                <dl class="agent-status-list">
                    <div>
                        <dt>运行状态</dt>
                        <dd>{{ agentStatusText }}</dd>
                    </div>
                    <div>
                        <dt>Endpoint</dt>
                        <dd>当前用户专属的本地 IPC；关闭接入后立即移除。</dd>
                    </div>
                    <div>
                        <dt>CLI</dt>
                        <dd class="agent-path">
                            {{ agentStatus.cliPath ?? "当前安装未提供 mora-agent CLI" }}
                        </dd>
                    </div>
                    <div v-if="agentStatus.lastError" class="agent-status-error">
                        <dt>最近错误</dt>
                        <dd>{{ agentStatus.lastError }}</dd>
                    </div>
                </dl>

                <div class="setting-actions">
                    <button
                        type="button"
                        :disabled="!agentStatus.cliPath"
                        @click="emit('copy-agent-config')"
                    >
                        复制 MCP 配置
                    </button>
                </div>
            </div>
        </section>
    </section>
</template>
