import { describe, expect, it } from "vitest";

import {
    DEFAULT_PREFERENCES,
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
});
