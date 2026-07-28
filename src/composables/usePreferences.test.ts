import { describe, expect, it } from "vitest";

import {
    DEFAULT_PREFERENCES,
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

    it("resolves the system theme", () => {
        expect(resolveTheme("system", true)).toBe("dark");
        expect(resolveTheme("system", false)).toBe("light");
        expect(resolveTheme("light", true)).toBe("light");
    });
});
