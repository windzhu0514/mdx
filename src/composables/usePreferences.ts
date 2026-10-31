import {
    t,
    locale,
    normalizeLanguage,
    resolveLanguage,
    type LanguagePreference,
} from "../i18n";

import { ref, watch } from "vue";

export type ThemeId =
    "xuan-white" | "ink-black" | "dai-blue" | "pine-green" | "crimson" | "wisteria";
export type ThemePreference = "system" | ThemeId;
export type FontPreference =
    | "system-default"
    | "cascadia-code"
    | "consolas"
    | "fira-code"
    | "jetbrains-mono"
    | "maple-mono-cn"
    | "sf-mono"
    | "sarasa-mono-sc"
    | "microsoft-yahei"
    | "pingfang-sc"
    | "source-han-sans-sc"
    | "inter"
    | "segoe-ui"
    | "source-han-serif-sc"
    | "simsun"
    | "kaiti"
    | "lxgw-wenkai"
    | "georgia"
    | "times-new-roman";
export type FontGroupId = "monospace" | "sans-serif" | "serif";
export type CodeFontPreference =
    | "cascadia-code"
    | "consolas"
    | "fira-code"
    | "jetbrains-mono"
    | "maple-mono-cn"
    | "sf-mono"
    | "sarasa-mono-sc";

export type FontOption = Readonly<{
    id: FontPreference;
    label: string;
    group: FontGroupId | null;
    fontFamily: string;
}>;

export type CodeFontOption = Readonly<{
    id: CodeFontPreference;
    label: string;
    fontFamily: string;
}>;

export const LOCAL_FONT_FAMILIES: Readonly<
    Partial<Record<FontPreference | CodeFontPreference, string>>
> = {
    "cascadia-code": "Cascadia Code",
    consolas: "Consolas",
    "fira-code": "Fira Code",
    "jetbrains-mono": "JetBrains Mono",
    "sf-mono": "SF Mono",
    "sarasa-mono-sc": "Sarasa Mono SC",
    inter: "Inter",
    "segoe-ui": "Segoe UI",
    "pingfang-sc": "PingFang SC",
    "source-han-sans-sc": "Source Han Sans SC",
    "microsoft-yahei": "Microsoft YaHei",
    georgia: "Georgia",
    "times-new-roman": "Times New Roman",
    kaiti: "KaiTi",
    "source-han-serif-sc": "Source Han Serif SC",
    simsun: "SimSun",
    "lxgw-wenkai": "LXGW WenKai",
};

export const FONT_GROUPS: ReadonlyArray<Readonly<{ id: FontGroupId; label: string }>> = [
    {
        id: "monospace",
        get label() {
            return t("等宽", "Monospace");
        },
    },
    {
        id: "sans-serif",
        get label() {
            return t("无衬线", "Sans serif");
        },
    },
    {
        id: "serif",
        get label() {
            return t("衬线", "Serif");
        },
    },
];

const bundledCodeFont = '"Maple Mono CN Bundled"';

export const FONT_OPTIONS: ReadonlyArray<FontOption> = [
    {
        id: "system-default",
        get label() {
            return t("系统默认", "System default");
        },
        group: null,
        fontFamily:
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    },
    {
        id: "cascadia-code",
        label: "Cascadia Code",
        group: "monospace",
        fontFamily:
            '"Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
    },
    {
        id: "consolas",
        label: "Consolas",
        group: "monospace",
        fontFamily:
            'Consolas, "Cascadia Code", "JetBrains Mono", "Microsoft YaHei", monospace',
    },
    {
        id: "fira-code",
        label: "Fira Code",
        group: "monospace",
        fontFamily:
            '"Fira Code", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
    },
    {
        id: "jetbrains-mono",
        label: "JetBrains Mono",
        group: "monospace",
        fontFamily:
            '"JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace',
    },
    {
        id: "maple-mono-cn",
        label: "Maple Mono CN",
        group: "monospace",
        fontFamily: `${bundledCodeFont}, monospace`,
    },
    {
        id: "sf-mono",
        label: "SF Mono",
        group: "monospace",
        fontFamily:
            '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
    },
    {
        id: "sarasa-mono-sc",
        get label() {
            return t("等距更纱黑体", "Sarasa Mono SC");
        },
        group: "monospace",
        fontFamily:
            '"Sarasa Mono SC", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
    },
    {
        id: "inter",
        label: "Inter",
        group: "sans-serif",
        fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',
    },
    {
        id: "segoe-ui",
        label: "Segoe UI",
        group: "sans-serif",
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    },
    {
        id: "pingfang-sc",
        get label() {
            return t("苹方", "PingFang SC");
        },
        group: "sans-serif",
        fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    },
    {
        id: "source-han-sans-sc",
        get label() {
            return t("思源黑体", "Source Han Sans SC");
        },
        group: "sans-serif",
        fontFamily: '"Source Han Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    },
    {
        id: "microsoft-yahei",
        get label() {
            return t("微软雅黑", "Microsoft YaHei");
        },
        group: "sans-serif",
        fontFamily: '"Microsoft YaHei", "Segoe UI", sans-serif',
    },
    {
        id: "georgia",
        label: "Georgia",
        group: "serif",
        fontFamily:
            'Georgia, "Source Han Serif SC", "LXGW WenKai", "Songti SC", SimSun, serif',
    },
    {
        id: "times-new-roman",
        label: "Times New Roman",
        group: "serif",
        fontFamily:
            '"Times New Roman", "Source Han Serif SC", "LXGW WenKai", "Songti SC", SimSun, serif',
    },
    {
        id: "kaiti",
        get label() {
            return t("楷体", "KaiTi");
        },
        group: "serif",
        fontFamily:
            'KaiTi, "LXGW WenKai", "Source Han Serif SC", "Songti SC", SimSun, serif',
    },
    {
        id: "source-han-serif-sc",
        get label() {
            return t("思源宋体", "Source Han Serif SC");
        },
        group: "serif",
        fontFamily: '"Source Han Serif SC", "LXGW WenKai", "Songti SC", SimSun, serif',
    },
    {
        id: "simsun",
        get label() {
            return t("宋体", "SimSun");
        },
        group: "serif",
        fontFamily: 'SimSun, "Source Han Serif SC", "LXGW WenKai", "Songti SC", serif',
    },
    {
        id: "lxgw-wenkai",
        get label() {
            return t("霞鹜文楷", "LXGW WenKai");
        },
        group: "serif",
        fontFamily: '"LXGW WenKai", "Source Han Serif SC", "Songti SC", SimSun, serif',
    },
];

export const CODE_FONT_OPTIONS: ReadonlyArray<CodeFontOption> = [
    {
        id: "cascadia-code",
        label: "Cascadia Code",
        fontFamily: `"Cascadia Code", ${bundledCodeFont}, monospace`,
    },
    {
        id: "consolas",
        label: "Consolas",
        fontFamily: `Consolas, ${bundledCodeFont}, monospace`,
    },
    {
        id: "fira-code",
        label: "Fira Code",
        fontFamily: `"Fira Code", ${bundledCodeFont}, monospace`,
    },
    {
        id: "jetbrains-mono",
        label: "JetBrains Mono",
        fontFamily: `"JetBrains Mono", ${bundledCodeFont}, monospace`,
    },
    {
        id: "maple-mono-cn",
        label: "Maple Mono CN",
        fontFamily: `${bundledCodeFont}, monospace`,
    },
    {
        id: "sf-mono",
        label: "SF Mono",
        fontFamily: `"SF Mono", ${bundledCodeFont}, monospace`,
    },
    {
        id: "sarasa-mono-sc",
        get label() {
            return t("等距更纱黑体", "Sarasa Mono SC");
        },
        fontFamily: `"Sarasa Mono SC", ${bundledCodeFont}, monospace`,
    },
];

export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeId; label: string }> = [
    {
        id: "xuan-white",
        get label() {
            return t("宣白", "Paper white");
        },
    },
    {
        id: "ink-black",
        get label() {
            return t("墨黑", "Ink black");
        },
    },
    {
        id: "dai-blue",
        get label() {
            return t("黛蓝", "Indigo");
        },
    },
    {
        id: "pine-green",
        get label() {
            return t("松青", "Pine green");
        },
    },
    {
        id: "crimson",
        get label() {
            return t("绛红", "Crimson");
        },
    },
    {
        id: "wisteria",
        get label() {
            return t("藤紫", "Wisteria");
        },
    },
];

export type EditorPreferences = {
    autoSave: boolean;
    language: LanguagePreference;
    theme: ThemePreference;
    fontFamily: FontPreference;
    codeFontFamily: CodeFontPreference;
    fontSize: number;
    lineHeight: number;
    contentWidth: number;
    showToc: boolean;
    aiBaseUrl: string;
    aiModel: string;
    agentAccessEnabled: boolean;
};

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "mora.preferences.v1";
const themes: ThemePreference[] = ["system", ...THEME_OPTIONS.map(({ id }) => id)];
const legacyFonts: Readonly<Record<string, FontPreference>> = {
    sans: "system-default",
    serif: "lxgw-wenkai",
    mono: "cascadia-code",
};

export const DEFAULT_PREFERENCES: EditorPreferences = {
    autoSave: false,
    language: "system",
    theme: "system",
    fontFamily: "system-default",
    codeFontFamily: "maple-mono-cn",
    fontSize: 16,
    lineHeight: 1.75,
    contentWidth: 820,
    showToc: true,
    aiBaseUrl: "",
    aiModel: "",
    agentAccessEnabled: false,
};

function clamp(value: unknown, min: number, max: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeTheme(value: unknown): ThemePreference {
    if (value === "light" || value === "monochrome") return "xuan-white";
    if (value === "dark") return "ink-black";
    return themes.includes(value as ThemePreference)
        ? (value as ThemePreference)
        : DEFAULT_PREFERENCES.theme;
}

function normalizeFont(value: unknown): FontPreference {
    if (typeof value !== "string") return DEFAULT_PREFERENCES.fontFamily;
    const migrated = legacyFonts[value] ?? value;
    return (
        FONT_OPTIONS.find(({ id }) => id === migrated)?.id ??
        DEFAULT_PREFERENCES.fontFamily
    );
}

function normalizeCodeFont(value: unknown): CodeFontPreference {
    if (typeof value !== "string") return DEFAULT_PREFERENCES.codeFontFamily;
    return (
        CODE_FONT_OPTIONS.find(({ id }) => id === value)?.id ??
        DEFAULT_PREFERENCES.codeFontFamily
    );
}

export function normalizePreferences(
    value: Partial<Record<keyof EditorPreferences, unknown>>,
): EditorPreferences {
    return {
        autoSave: typeof value.autoSave === "boolean" ? value.autoSave : false,
        language: normalizeLanguage(value.language),
        theme: normalizeTheme(value.theme),
        fontFamily: normalizeFont(value.fontFamily),
        codeFontFamily: normalizeCodeFont(value.codeFontFamily),
        fontSize: clamp(value.fontSize, 14, 22, DEFAULT_PREFERENCES.fontSize),
        lineHeight: clamp(value.lineHeight, 1.4, 2.1, DEFAULT_PREFERENCES.lineHeight),
        contentWidth: clamp(
            value.contentWidth,
            620,
            1200,
            DEFAULT_PREFERENCES.contentWidth,
        ),
        showToc:
            typeof value.showToc === "boolean"
                ? value.showToc
                : DEFAULT_PREFERENCES.showToc,
        aiBaseUrl: text(value.aiBaseUrl),
        aiModel: text(value.aiModel),
        agentAccessEnabled:
            typeof value.agentAccessEnabled === "boolean"
                ? value.agentAccessEnabled
                : DEFAULT_PREFERENCES.agentAccessEnabled,
    };
}

export function loadPreferences(storage: PreferenceStorage): EditorPreferences {
    try {
        const raw = storage.getItem(STORAGE_KEY);
        return raw
            ? normalizePreferences(JSON.parse(raw) as Partial<EditorPreferences>)
            : { ...DEFAULT_PREFERENCES };
    } catch {
        return { ...DEFAULT_PREFERENCES };
    }
}

export function savePreferences(
    storage: PreferenceStorage,
    preferences: EditorPreferences,
) {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean) {
    return theme === "system" ? (prefersDark ? "ink-black" : "xuan-white") : theme;
}

export function isDarkTheme(theme: string | undefined): boolean {
    return theme === "ink-black" || theme === "dai-blue";
}

export function usePreferences() {
    const preferences = ref(loadPreferences(localStorage));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const resolvedTheme = ref(resolveTheme(preferences.value.theme, media.matches));

    function apply() {
        const value = normalizePreferences(preferences.value);
        locale.value = resolveLanguage(value.language);
        document.documentElement.lang = locale.value;
        resolvedTheme.value = resolveTheme(value.theme, media.matches);
        document.documentElement.dataset.theme = resolvedTheme.value;
        document.documentElement.style.setProperty(
            "--editor-font-family",
            FONT_OPTIONS.find(({ id }) => id === value.fontFamily)?.fontFamily ??
                FONT_OPTIONS[0].fontFamily,
        );
        document.documentElement.style.setProperty(
            "--editor-code-font-family",
            CODE_FONT_OPTIONS.find(({ id }) => id === value.codeFontFamily)?.fontFamily ??
                CODE_FONT_OPTIONS[0].fontFamily,
        );
        document.documentElement.style.setProperty(
            "--editor-font-size",
            `${value.fontSize}px`,
        );
        document.documentElement.style.setProperty(
            "--editor-line-height",
            String(value.lineHeight),
        );
        document.documentElement.style.setProperty(
            "--content-width",
            `${value.contentWidth}px`,
        );
        savePreferences(localStorage, value);
    }

    function handleSystemTheme() {
        if (preferences.value.theme === "system") apply();
    }

    function update(patch: Partial<EditorPreferences>) {
        preferences.value = normalizePreferences({ ...preferences.value, ...patch });
    }

    const stopWatch = watch(preferences, apply, { deep: true, immediate: true });
    media.addEventListener("change", handleSystemTheme);
    window.addEventListener("languagechange", apply);

    function dispose() {
        stopWatch();
        window.removeEventListener("languagechange", apply);
        media.removeEventListener("change", handleSystemTheme);
    }

    return { preferences, resolvedTheme, update, dispose };
}
