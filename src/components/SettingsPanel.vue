<script setup lang="ts">
import { appName, t, type LanguagePreference } from "../i18n";

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
        get label() {
            return t("外观", "Appearance");
        },
        get eyebrow() {
            return t("阅读与外观", "Reading and appearance");
        },
        get description() {
            return t(
                "调整主题、正文字体和代码字体，并立即查看排版效果。",
                "Adjust the theme, body and code fonts with a live preview.",
            );
        },
    },
    {
        id: "editor",
        get label() {
            return t("编辑器", "Editor");
        },
        get eyebrow() {
            return t("编辑体验", "Editing experience");
        },
        get description() {
            return t(
                "设置正文阅读宽度和文档目录的默认显示方式。",
                "Set the reading width and default outline visibility.",
            );
        },
    },
    {
        id: "ai",
        label: "AI",
        get eyebrow() {
            return t("智能写作", "AI writing");
        },
        get description() {
            return t(
                "配置用于所见即所得编辑器的 OpenAI-compatible 服务。",
                "Configure an OpenAI-compatible service for the visual editor.",
            );
        },
    },
    {
        id: "agent",
        label: "Agent",
        get eyebrow() {
            return t("本地自动化", "Local automation");
        },
        get description() {
            return t(
                "显式授权同一用户下的本地工具访问当前打开的文档。",
                "Allow local tools running as the same user to access open documents.",
            );
        },
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
    if (!props.agentStatus.enabled) return t("已关闭（默认关闭）", "Disabled (default)");
    if (!props.agentStatus.listening)
        return t("正在启动本地 endpoint", "Starting local endpoint");
    return t(
        `正在监听 · ${props.agentStatus.connectedClients} 个连接 · ${props.agentStatus.watcherClients} 个订阅`,
        `Listening · ${props.agentStatus.connectedClients} connections · ${props.agentStatus.watcherClients} subscriptions`,
    );
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
    return isFontAvailable(font)
        ? font.label
        : t(`${font.label}（未安装）`, `${font.label} (not installed)`);
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
                    :aria-label="t('返回编辑器', 'Back to editor')"
                    @click="emit('close')"
                >
                    {{ t("返回编辑器", "Back to editor") }}
                </button>
                <div>
                    <span class="settings-product-name">{{ appName }}</span>
                    <h1 id="settings-title">{{ t("偏好设置", "Preferences") }}</h1>
                </div>
            </header>

            <label class="setting-field settings-language">
                {{ t("界面语言", "Interface language") }}
                <select
                    data-testid="language-select"
                    :aria-label="t('界面语言', 'Interface language')"
                    :value="preferences.language"
                    @change="
                        emit('update', {
                            language: ($event.target as HTMLSelectElement)
                                .value as LanguagePreference,
                        })
                    "
                >
                    <option value="system">{{ t("跟随系统", "Follow system") }}</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                </select>
            </label>
            <p class="settings-language-hint">
                {{
                    t(
                        "界面语言立即生效。部分编辑器 AI 提示需重启应用后更新。",
                        "The interface updates immediately. Some editor AI labels update after restarting the app.",
                    )
                }}
            </p>
            <nav
                class="settings-nav"
                :aria-label="t('偏好设置分类', 'Preferences categories')"
            >
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
                        <span>{{ t("主题", "Theme") }}</span>
                        <select
                            :value="preferences.theme"
                            @change="
                                emit('update', {
                                    theme: ($event.target as HTMLSelectElement)
                                        .value as ThemePreference,
                                })
                            "
                        >
                            <option value="system">
                                {{ t("跟随系统", "Follow system") }}
                            </option>
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
                        <span>{{ t("字体", "Font") }}</span>
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
                        <span>{{ t("代码字体", "Code font") }}</span>
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
                        <span
                            >{{ t("字号", "Font size") }}
                            {{ preferences.fontSize }} px</span
                        >
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
                        <span
                            >{{ t("行高", "Line height") }}
                            {{ preferences.lineHeight.toFixed(2) }}</span
                        >
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

                <aside
                    class="settings-preview-panel"
                    :aria-label="t('字体实时预览', 'Live font preview')"
                >
                    <div class="settings-preview-heading">
                        <div>
                            <p class="panel-eyebrow">
                                {{ t("实时预览", "Live preview") }}
                            </p>
                            <h3>{{ t("正文与代码", "Body and code") }}</h3>
                        </div>
                        <span>{{
                            t("更改后立即生效", "Changes take effect immediately")
                        }}</span>
                    </div>
                    <article class="settings-live-preview">
                        <p class="settings-preview-kicker">
                            {{ t("墨笺 字体预览", "Mora font preview") }}
                        </p>
                        <h3>
                            {{
                                t(
                                    "让文字保持清晰，也保留一点呼吸感",
                                    "Keep text clear, with room to breathe",
                                )
                            }}
                        </h3>
                        <p>
                            {{
                                t(
                                    "这是一段中英文混排示例。墨笺 helps ideas stay focused, and The quick brown fox jumps over the lazy dog.",
                                    "Mora helps ideas stay focused. The quick brown fox jumps over the lazy dog.",
                                )
                            }}
                        </p>
                        <p>
                            {{ t("这里包含", "This includes")
                            }}<strong>{{ t("加粗文字", "Bold text") }}</strong
                            >、<em>{{ t("斜体文字", "Italic text") }}</em
                            >、
                            <a href="#" @click.prevent>{{ t("链接文字", "Link text") }}</a
                            >{{ t("和", "and") }} <code>const note = "墨笺"</code>
                            {{ t("行内代码。", "inline code.") }}
                        </p>
                        <blockquote>
                            {{
                                t(
                                    "好的排版不会打断阅读，而是在需要时给内容恰当的强调。",
                                    "Good typography supports reading and adds emphasis where it matters.",
                                )
                            }}
                        </blockquote>
                        <pre><code>function greet(name: string) {
    return `Hello, ${name}`;
}</code></pre>
                        <p>
                            {{
                                t(
                                    "长段落用于观察字号、行高与中英文标点的整体节奏。调整左侧选项时， 此区域会沿用编辑器当前的正文与代码字体设置，方便在回到文档前完成比较。",
                                    "Use this paragraph to compare font size, line spacing and punctuation. Changes on the left use the same body and code fonts as the editor.",
                                )
                            }}
                        </p>
                    </article>
                </aside>
            </div>

            <div
                v-else-if="activeCategory === 'editor'"
                class="settings-card settings-control-list"
            >
                <label class="setting-check">
                    <input
                        type="checkbox"
                        :aria-label="t('自动保存原文件', 'Auto-save original files')"
                        :checked="preferences.autoSave"
                        @change="
                            emit('update', {
                                autoSave: ($event.target as HTMLInputElement).checked,
                            })
                        "
                    />
                    <span>
                        <strong>{{
                            t("自动保存原文件", "Auto-save original files")
                        }}</strong>
                        <small>{{
                            t(
                                "默认关闭。停笔 5 秒后保存已有路径的文档；未命名或冲突文档不自动保存。保存失败后暂停，请手动保存或重新开关。",
                                "Off by default. Saves documents with a file path after 5 seconds of inactivity. Untitled or conflicted documents are skipped. After a failure, save manually or toggle this option to resume.",
                            )
                        }}</small>
                    </span>
                </label>
                <label class="setting-field range-field">
                    <span
                        >{{ t("阅读宽度", "Reading width") }}
                        {{ preferences.contentWidth }} px</span
                    >
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
                        <strong>{{
                            t("默认显示文档目录", "Show document outline by default")
                        }}</strong>
                        <small>{{
                            t(
                                "打开包含标题的文档时显示右侧目录。",
                                "Show the outline on the right for documents with headings.",
                            )
                        }}</small>
                    </span>
                </label>
            </div>

            <div v-else-if="activeCategory === 'ai'" class="settings-card ai-settings">
                <div>
                    <p class="panel-eyebrow">AI</p>
                    <h3>
                        {{ t("OpenAI-compatible 服务", "OpenAI-compatible service") }}
                    </h3>
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
                    <span>{{ t("模型", "Model") }}</span>
                    <input
                        :aria-label="t('AI 模型', 'AI model')"
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
                        {{
                            aiKeyConfigured
                                ? t("已配置", "Configured")
                                : t("未配置", "Not configured")
                        }}
                    </span>
                    <button
                        type="button"
                        :disabled="aiKeySaving || !apiKey"
                        @click="saveAiKey"
                    >
                        {{ t("保存/替换 API Key", "Save/replace API key") }}
                    </button>
                    <button
                        type="button"
                        :disabled="aiKeySaving || !aiKeyConfigured"
                        @click="emit('delete-ai-key')"
                    >
                        {{ t("删除 API Key", "Delete API key") }}
                    </button>
                </div>
            </div>

            <div v-else class="settings-card agent-settings">
                <label class="setting-check agent-access-toggle">
                    <input
                        type="checkbox"
                        :aria-label="t('本地 Agent 接入', 'Local Agent access')"
                        :checked="preferences.agentAccessEnabled"
                        @change="
                            emit('update', {
                                agentAccessEnabled: ($event.target as HTMLInputElement)
                                    .checked,
                            })
                        "
                    />
                    <span>
                        <strong>{{ t("本地 Agent 接入", "Local Agent access") }}</strong>
                        <small>{{
                            t(
                                "默认关闭；仅在你明确开启后运行本地 endpoint。",
                                "Disabled by default. The local endpoint runs only when enabled.",
                            )
                        }}</small>
                    </span>
                </label>

                <div class="agent-security-note" role="note">
                    <strong>{{ t("访问范围", "Access scope") }}</strong>
                    <p>
                        {{
                            t(
                                "开启后，同一系统用户下的程序可以读取和修改 墨笺 当前打开的文档，包括未保存内容。请只连接你信任的本地工具。",
                                "When enabled, programs running as the same user can read and modify open documents in Mora, including unsaved changes. Connect only trusted local tools.",
                            )
                        }}
                    </p>
                </div>

                <dl class="agent-status-list">
                    <div>
                        <dt>{{ t("运行状态", "Status") }}</dt>
                        <dd>{{ agentStatusText }}</dd>
                    </div>
                    <div>
                        <dt>Endpoint</dt>
                        <dd>
                            {{
                                t(
                                    "当前用户专属的本地 IPC；关闭接入后立即移除。",
                                    "Local IPC for the current user; removed when access is disabled.",
                                )
                            }}
                        </dd>
                    </div>
                    <div>
                        <dt>CLI</dt>
                        <dd class="agent-path">
                            {{
                                agentStatus.cliPath ??
                                t(
                                    "当前安装未提供 mora-agent CLI",
                                    "This installation does not include the mora-agent CLI",
                                )
                            }}
                        </dd>
                    </div>
                    <div v-if="agentStatus.lastError" class="agent-status-error">
                        <dt>{{ t("最近错误", "Last error") }}</dt>
                        <dd>{{ agentStatus.lastError }}</dd>
                    </div>
                </dl>

                <div class="setting-actions">
                    <button
                        type="button"
                        :disabled="!agentStatus.cliPath"
                        @click="emit('copy-agent-config')"
                    >
                        {{ t("复制 MCP 配置", "Copy MCP configuration") }}
                    </button>
                </div>
            </div>
        </section>
    </section>
</template>
