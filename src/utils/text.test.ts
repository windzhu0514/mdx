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
    it("recognizes ATX headings with up to three leading spaces while excluding four-space lines and fenced pseudo headings", () => {
        expect(
            extractMarkdownHeadings(
                "   ## 缩进标题\n    ### 代码缩进\n   ```md\n   ### 围栏伪标题\n    ```\n   ## 仍在围栏\n   ```\n   ## 第二标题\n    ```\n    ### 非围栏也非标题",
            ).map(({ level, text }) => ({ level, text })),
        ).toEqual([
            { level: 2, text: "缩进标题" },
            { level: 2, text: "第二标题" },
        ]);
    });

    it("忽略反引号和波浪围栏代码块中的伪 ATX 标题", () => {
        expect(
            extractMarkdownHeadings(
                "# 外部\n```ts\n## 反引号伪标题\n```\n~~~md\n### 波浪伪标题\n~~~",
            ),
        ).toEqual([{ level: 1, text: "外部", id: 0 }]);
    });

    it("does not treat tab-indented headings or fences as block syntax", () => {
        expect(
            extractMarkdownHeadings(
                "\t# Tab 标题\n\t```\n# 反引号 Tab 围栏后\n\t~~~\n# 波浪 Tab 围栏后\n```\n# 围栏内\n\t```\n# Tab 关闭围栏后仍在围栏内\n```\n# 真正关闭围栏后",
            ).map(({ text }) => text),
        ).toEqual([
            "反引号 Tab 围栏后",
            "波浪 Tab 围栏后",
            "真正关闭围栏后",
        ]);
    });

    it("rejects backtick fences whose info string contains a backtick while allowing tilde fences", () => {
        expect(
            extractMarkdownHeadings(
                "```info`invalid\n# 无效反引号围栏后的标题\n~~~info`allowed\n# 波浪围栏内\n~~~\n# 波浪围栏后的标题",
            ).map(({ text }) => text),
        ).toEqual(["无效反引号围栏后的标题", "波浪围栏后的标题"]);
    });
});
