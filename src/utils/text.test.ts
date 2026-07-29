import { describe, expect, it } from "vitest";

import { countNonWhitespaceCharacters, normalizeMarkdownHeadingText } from "./text";

describe("countNonWhitespaceCharacters", () => {
    it("忽略空白并按 Unicode 字符计数", () => {
        expect(countNonWhitespaceCharacters("你 好\n😀")).toBe(3);
    });
});

describe("normalizeMarkdownHeadingText", () => {
    it("removes closing hashes and emphasis markers from a heading label", () => {
        expect(normalizeMarkdownHeadingText("**标题** ##")).toBe("标题");
    });

    it("keeps link labels and inline-code text without their Markdown syntax", () => {
        expect(
            normalizeMarkdownHeadingText(
                "[文档](https://example.com) 与 `代码`",
            ),
        ).toBe("文档 与 代码");
    });
});
