import { describe, expect, it } from "vitest";

import {
    referencedResourcePaths,
    toDisplayMarkdown,
    toPersistedMarkdown,
} from "./resourcePaths";

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

    it.each([
        '![图](assets/photo.png "说明")',
        "![图](<assets/photo.png> '说明')",
        '![图][photo]\n\n[photo]: <assets/photo.png> "说明"',
        "![photo][]\n\n[photo]: assets/photo.png",
        "![photo]\n\n[photo]: assets/photo.png",
    ])(
        "round trips resource destinations without changing Markdown syntax: %s",
        (source) => {
            const display = source.replace("assets/photo.png", "blob:mora-photo");

            expect(referencedResourcePaths(source)).toEqual(
                new Set(["assets/photo.png"]),
            );
            expect(toDisplayMarkdown(source, urls)).toBe(display);
            expect(toPersistedMarkdown(display, urls)).toBe(source);
        },
    );

    it.each([
        "`![图](assets/photo.png)`",
        '```markdown\n![图](assets/photo.png)\n<img src="assets/photo.png">\n```',
        '    ![图](assets/photo.png)\n    <img src="assets/photo.png">',
        '<!-- <img src="assets/photo.png"> -->',
        '正文 src="assets/photo.png"',
        '<img data-src="assets/photo.png">',
    ])("preserves non-resource examples and attributes: %s", (source) => {
        expect(referencedResourcePaths(source)).toEqual(new Set());
        expect(toDisplayMarkdown(source, urls)).toBe(source);
        const display = source.split("assets/photo.png").join("blob:mora-photo");
        expect(toPersistedMarkdown(display, urls)).toBe(display);
    });

    it("maps valid HTML attributes with whitespace, case and unquoted values", () => {
        const source = '<img SRC = "assets/photo.png"><a href=assets/photo.png>图</a>';
        const display = source.split("assets/photo.png").join("blob:mora-photo");
        expect(referencedResourcePaths(source)).toEqual(new Set(["assets/photo.png"]));
        expect(toDisplayMarkdown(source, urls)).toBe(display);
        expect(toPersistedMarkdown(display, urls)).toBe(source);
    });

    it("maps multiple real resources while preserving examples in the same document", () => {
        const source = [
            '![图](assets/photo.png "说明") and `![示例](assets/photo.png)`',
            "",
            '<img src="assets/photo.png">',
            "",
            '```html\n<img src="assets/photo.png">\n```',
            "",
            '[附件](attachments/a.pdf "文件")',
        ].join("\n");
        const resources = new Map([
            ...urls,
            ["attachments/a.pdf", "blob:mora-attachment"],
        ]);
        const display = source
            .replace('![图](assets/photo.png "说明")', '![图](blob:mora-photo "说明")')
            .replace('<img src="assets/photo.png">', '<img src="blob:mora-photo">')
            .replace("attachments/a.pdf", "blob:mora-attachment");

        expect(toDisplayMarkdown(source, resources)).toBe(display);
        expect(toPersistedMarkdown(display, resources)).toBe(source);
    });

    it("extracts unique package resources from Markdown and HTML", () => {
        expect(
            referencedResourcePaths(
                "[附件](attachments/a.pdf) ![图](assets/a.png) " +
                    '<a href="attachments/a.pdf">重复</a><img src="assets/b.png">',
            ),
        ).toEqual(new Set(["attachments/a.pdf", "assets/a.png", "assets/b.png"]));
    });

    it("ignores external, local and blob destinations", () => {
        expect(
            referencedResourcePaths(
                "[站点](https://example.com/a.pdf) ![临时](blob:mora) " +
                    '<a href="file:///C:/a.pdf">本地</a>',
            ),
        ).toEqual(new Set());
    });
});
