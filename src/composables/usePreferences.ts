import { ref, watch } from "vue";

export type ThemePreference = "system" | "light" | "dark";
export type FontPreference = "sans" | "serif" | "mono";

export type EditorPreferences = {
    theme: ThemePreference;
    fontFamily: FontPreference;
    fontSize: number;
    lineHeight: number;
    contentWidth: number;
    showToc: boolean;
};

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "mora.preferences.v1";
const themes: ThemePreference[] = ["system", "light", "dark"];
const fonts: FontPreference[] = ["sans", "serif", "mono"];

export const DEFAULT_PREFERENCES: EditorPreferences = {
    theme: "system",
    fontFamily: "sans",
    fontSize: 16,
    lineHeight: 1.75,
    contentWidth: 820,
    showToc: true,
};

function clamp(value: unknown, min: number, max: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
}

export function normalizePreferences(
    value: Partial<Record<keyof EditorPreferences, unknown>>,
): EditorPreferences {
    return {
        theme: themes.includes(value.theme as ThemePreference)
            ? (value.theme as ThemePreference)
            : DEFAULT_PREFERENCES.theme,
        fontFamily: fonts.includes(value.fontFamily as FontPreference)
            ? (value.fontFamily as FontPreference)
            : DEFAULT_PREFERENCES.fontFamily,
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
    return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

const fontStacks: Record<FontPreference, string> = {
    sans: '"Segoe UI", "Microsoft YaHei", sans-serif',
    serif: '"LXGW WenKai", "Songti SC", SimSun, serif',
    mono: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
};

export function usePreferences() {
    const preferences = ref(loadPreferences(localStorage));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const resolvedTheme = ref(resolveTheme(preferences.value.theme, media.matches));

    function apply() {
        const value = normalizePreferences(preferences.value);
        resolvedTheme.value = resolveTheme(value.theme, media.matches);
        document.documentElement.dataset.theme = resolvedTheme.value;
        document.documentElement.style.setProperty(
            "--editor-font-family",
            fontStacks[value.fontFamily],
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

    function dispose() {
        stopWatch();
        media.removeEventListener("change", handleSystemTheme);
    }

    return { preferences, resolvedTheme, update, dispose };
}
