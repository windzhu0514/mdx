import { describe, expect, it } from "vitest";

import { normalizeTags } from "./tags";

describe("tag normalization", () => {
    it("trims, removes empty values and deduplicates case-insensitively", () => {
        expect(normalizeTags([" 工作 ", "", "工作", "Work", "WORK", "生活"])).toEqual([
            "工作",
            "Work",
            "生活",
        ]);
    });

    it("limits tag length and total count", () => {
        const tags = Array.from(
            { length: 30 },
            (_, index) => `${index}-${"a".repeat(40)}`,
        );
        const normalized = normalizeTags(tags);
        expect(normalized).toHaveLength(20);
        expect(normalized.every((tag) => tag.length <= 30)).toBe(true);
    });
});
