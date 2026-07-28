import { describe, expect, it } from "vitest";

import { countNonWhitespaceCharacters } from "./text";

describe("countNonWhitespaceCharacters", () => {
    it("忽略空白并按 Unicode 字符计数", () => {
        expect(countNonWhitespaceCharacters("你 好\n😀")).toBe(3);
    });
});
