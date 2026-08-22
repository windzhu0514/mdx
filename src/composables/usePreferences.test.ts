import { describe, expect, it } from "vitest";

import {
    CODE_FONT_OPTIONS,
    DEFAULT_PREFERENCES,
    FONT_GROUPS,
    FONT_OPTIONS,
    THEME_OPTIONS,
    isDarkTheme,
    loadPreferences,
    normalizePreferences,
    resolveTheme,
    savePreferences,
    type PreferenceStorage,
} from "./usePreferences";

function memoryStorage(initial: string | null = null): PreferenceStorage & {
    value: string | null;
} {
    return {
        value: initial,
        getItem() {
            return this.value;
        },
        setItem(_key, value) {
            this.value = value;
        },
    };
}

describe("editor preferences", () => {
    it("clamps numeric values and rejects unknown choices", () => {
        expect(
            normalizePreferences({
                theme: "neon",
                fontFamily: "comic",
                fontSize: 50,
                lineHeight: 0.5,
                contentWidth: 5000,
            }),
        ).toEqual({
            ...DEFAULT_PREFERENCES,
            fontSize: 22,
            lineHeight: 1.4,
            contentWidth: 1200,
        });
    });

    it("falls back from damaged storage and persists normalized values", () => {
        const storage = memoryStorage("not-json");
        expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
        savePreferences(storage, { ...DEFAULT_PREFERENCES, fontSize: 19 });
        expect(loadPreferences(storage).fontSize).toBe(19);
    });

    it("normalizes damaged AI settings to empty strings", () => {
        const preferences = normalizePreferences({
            ...DEFAULT_PREFERENCES,
            aiBaseUrl: 42,
            aiModel: { name: "invalid" },
        });

        expect(preferences.aiBaseUrl).toBe("");
        expect(preferences.aiModel).toBe("");
    });

    it("trims and persists valid AI settings", () => {
        const storage = memoryStorage();
        savePreferences(storage, {
            ...DEFAULT_PREFERENCES,
            aiBaseUrl: "  https://api.example.com/v1  ",
            aiModel: "  example-model  ",
        });

        expect(loadPreferences(storage)).toEqual({
            ...DEFAULT_PREFERENCES,
            aiBaseUrl: "https://api.example.com/v1",
            aiModel: "example-model",
        });
    });

    it("exposes the six writing themes in display order", () => {
        expect(THEME_OPTIONS).toEqual([
            { id: "xuan-white", label: "宣白" },
            { id: "ink-black", label: "墨黑" },
            { id: "dai-blue", label: "黛蓝" },
            { id: "pine-green", label: "松青" },
            { id: "crimson", label: "绛红" },
            { id: "wisteria", label: "藤紫" },
        ]);
    });

    it("resolves system mode and classifies concrete dark themes", () => {
        expect(resolveTheme("system", true)).toBe("ink-black");
        expect(resolveTheme("system", false)).toBe("xuan-white");
        expect(resolveTheme("dai-blue", false)).toBe("dai-blue");
        expect(isDarkTheme("ink-black")).toBe(true);
        expect(isDarkTheme("dai-blue")).toBe(true);
        expect(isDarkTheme("crimson")).toBe(false);
    });

    it("persists a concrete theme and migrates legacy theme values", () => {
        const storage = memoryStorage();
        const preferences = normalizePreferences({ theme: "wisteria" });

        expect(preferences.theme).toBe("wisteria");
        savePreferences(storage, preferences);
        expect(loadPreferences(storage).theme).toBe("wisteria");
        expect(normalizePreferences({ theme: "light" }).theme).toBe("xuan-white");
        expect(normalizePreferences({ theme: "dark" }).theme).toBe("ink-black");
        expect(normalizePreferences({ theme: "monochrome" }).theme).toBe("xuan-white");
    });

    it("exposes the fixed font list in display groups", () => {
        expect(FONT_OPTIONS.map(({ id, label }) => ({ id, label }))).toEqual([
            { id: "system-default", label: "系统默认" },
            { id: "cascadia-code", label: "Cascadia Code" },
            { id: "consolas", label: "Consolas" },
            { id: "fira-code", label: "Fira Code" },
            { id: "jetbrains-mono", label: "JetBrains Mono" },
            { id: "maple-mono-cn", label: "Maple Mono CN" },
            { id: "sf-mono", label: "SF Mono" },
            { id: "sarasa-mono-sc", label: "等距更纱黑体" },
            { id: "inter", label: "Inter" },
            { id: "segoe-ui", label: "Segoe UI" },
            { id: "pingfang-sc", label: "苹方" },
            { id: "source-han-sans-sc", label: "思源黑体" },
            { id: "microsoft-yahei", label: "微软雅黑" },
            { id: "georgia", label: "Georgia" },
            { id: "times-new-roman", label: "Times New Roman" },
            { id: "kaiti", label: "楷体" },
            { id: "source-han-serif-sc", label: "思源宋体" },
            { id: "simsun", label: "宋体" },
            { id: "lxgw-wenkai", label: "霞鹜文楷" },
        ]);
        expect(FONT_GROUPS.map(({ label }) => label)).toEqual(["等宽", "无衬线", "衬线"]);
        expect(FONT_OPTIONS[0].fontFamily).toBe(
            'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
        );
        expect(FONT_OPTIONS.find(({ id }) => id === "fira-code")?.fontFamily).toBe(
            '"Fira Code", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
        );
    });

    it("accepts concrete fonts and migrates legacy font preferences", () => {
        expect(normalizePreferences({ fontFamily: "fira-code" }).fontFamily).toBe(
            "fira-code",
        );
        expect(normalizePreferences({ fontFamily: "sans" }).fontFamily).toBe(
            "system-default",
        );
        expect(normalizePreferences({ fontFamily: "serif" }).fontFamily).toBe(
            "lxgw-wenkai",
        );
        expect(normalizePreferences({ fontFamily: "mono" }).fontFamily).toBe(
            "cascadia-code",
        );
        expect(normalizePreferences({ fontFamily: "missing" }).fontFamily).toBe(
            "system-default",
        );
    });

    it("exposes code-only monospaced fonts in display order", () => {
        expect(CODE_FONT_OPTIONS.map(({ id, label }) => ({ id, label }))).toEqual([
            { id: "cascadia-code", label: "Cascadia Code" },
            { id: "consolas", label: "Consolas" },
            { id: "fira-code", label: "Fira Code" },
            { id: "jetbrains-mono", label: "JetBrains Mono" },
            { id: "maple-mono-cn", label: "Maple Mono CN" },
            { id: "sf-mono", label: "SF Mono" },
            { id: "sarasa-mono-sc", label: "等距更纱黑体" },
        ]);
        expect(
            CODE_FONT_OPTIONS.find(({ id }) => id === "maple-mono-cn")?.fontFamily,
        ).toBe('"Maple Mono CN Bundled", monospace');
        expect(CODE_FONT_OPTIONS.find(({ id }) => id === "fira-code")?.fontFamily).toBe(
            '"Fira Code", "Maple Mono CN Bundled", monospace',
        );
        expect(
            FONT_OPTIONS.filter(({ group }) => group === "monospace").map(({ id }) => id),
        ).toEqual(CODE_FONT_OPTIONS.map(({ id }) => id));
    });

    it("defaults and normalizes the independent code font", () => {
        expect(DEFAULT_PREFERENCES.codeFontFamily).toBe("maple-mono-cn");
        expect(normalizePreferences({ codeFontFamily: "fira-code" }).codeFontFamily).toBe(
            "fira-code",
        );
        expect(normalizePreferences({}).codeFontFamily).toBe("maple-mono-cn");
        expect(normalizePreferences({ codeFontFamily: "missing" }).codeFontFamily).toBe(
            "maple-mono-cn",
        );
        expect(normalizePreferences({ codeFontFamily: 42 }).codeFontFamily).toBe(
            "maple-mono-cn",
        );
    });
});
