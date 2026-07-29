import { describe, expect, it } from "vitest";

import {
    countNonWhitespaceCharacters,
    extractMarkdownHeadings,
    normalizeMarkdownHeadingText,
} from "./text";

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

describe("extractMarkdownHeadings", () => {
    it("忽略反引号和波浪围栏代码块中的伪 ATX 标题", () => {
        expect(
            extractMarkdownHeadings(
                "# 外部\n```ts\n## 反引号伪标题\n```\n~~~md\n### 波浪伪标题\n~~~",
            ),
        ).toEqual([{ level: 1, text: "外部", id: 0 }]);
    });
});
