import { describe, expect, it } from "vitest";

import { toDisplayMarkdown, toPersistedMarkdown } from "./resourcePaths";

describe("resource markdown mapping", () => {
    const urls = new Map([["assets/photo.png", "blob:mora-photo"]]);

    it("maps package paths to object URLs for display", () => {
        expect(toDisplayMarkdown("![图](assets/photo.png)", urls)).toBe(
            "![图](blob:mora-photo)",
        );
    });

    it("maps object URLs back before persistence", () => {
        expect(toPersistedMarkdown("![图](blob:mora-photo)", urls)).toBe(
            "![图](assets/photo.png)",
        );
    });

    it("maps HTML resource sources in both directions", () => {
        expect(toDisplayMarkdown('<img src="assets/photo.png">', urls)).toBe(
            '<img src="blob:mora-photo">',
        );
        expect(toPersistedMarkdown('<img src="blob:mora-photo">', urls)).toBe(
            '<img src="assets/photo.png">',
        );
    });

    it("does not rewrite external URLs", () => {
        expect(toDisplayMarkdown("![图](https://example.com/a.png)", urls)).toBe(
            "![图](https://example.com/a.png)",
        );
    });
});
