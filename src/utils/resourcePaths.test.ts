import { describe, expect, it } from "vitest";

import {
    referencedResourcePaths,
    referencedLocalResourcePaths,
    rebaseMarkdownReferences,
    toDisplayMarkdown,
    toPersistedMarkdown,
} from "./resourcePaths";

describe("resource markdown mapping", () => {
    it("keeps YAML links and HTML byte-for-byte while mapping body references at their canonical offsets", () => {
        const header =
            '\uFEFF---\r\nimage: ![sample](assets/photo.png)\r\nlink: [sample](docs/header.pdf)\r\nhtml: <img src="assets/header.png">\r\n...\r\n';
        const body =
            '![photo](<assets/photo.png>)\r\n\r\n<img src="assets/photo.png">\r\n\r\n[document](docs/body.pdf)';
        const source = header + body;
        const mapped =
            header +
            '![photo](<blob:photo>)\r\n\r\n<img src="blob:photo">\r\n\r\n[document](blob:document)';
        const urls = new Map([
            ["assets/photo.png", "blob:photo"],
            ["docs/body.pdf", "blob:document"],
            ["docs/header.pdf", "blob:header"],
            ["assets/header.png", "blob:header-image"],
        ]);
        expect([...referencedResourcePaths(source)]).toEqual(["assets/photo.png"]);
        expect([...referencedLocalResourcePaths(source)]).toEqual([
            "assets/photo.png",
            "docs/body.pdf",
        ]);
        expect(toDisplayMarkdown(source, urls)).toBe(mapped);
        expect(toPersistedMarkdown(mapped, urls)).toBe(source);
    });

    it("rebases only body references while retaining YAML examples and a leading BOM", () => {
        const header = "\uFEFF---\nexample: ![sample](images/a.png)\n---\n";
        expect(
            rebaseMarkdownReferences(
                header + "![photo](images/a.png)",
                "C:/Notes/source.md",
            ),
        ).toBe(header + "![photo](file:///C:/Notes/images/a.png)");
        expect(
            toDisplayMarkdown(
                "\uFEFF![photo](assets/a.png)",
                new Map([["assets/a.png", "blob:photo"]]),
            ),
        ).toBe("\uFEFF![photo](blob:photo)");
    });

    it("finds local references without treating code or web URLs as files", () => {
        const source =
            "![local](../images/a.png) [file](file:///C:/a.txt) ![web](https://example.com/a.png) [section](#x)\n" +
            "\x60[code](hidden.png)\x60";
        expect([...referencedLocalResourcePaths(source)]).toEqual([
            "../images/a.png",
            "file:///C:/a.txt",
        ]);
    });

    it("rebases relative references with Unicode, spaces and encoded paths without touching pending keys", () => {
        const source =
            "![local](<../图/a b.png>) [query](doc.md?q=a#part) ![pending](assets/new.png)";
        expect(
            rebaseMarkdownReferences(
                source,
                "C:\\My Notes\\原稿.md",
                new Set(["assets/new.png"]),
            ),
        ).toBe(
            "![local](<file:///C:/%E5%9B%BE/a%20b.png>) [query](file:///C:/My%20Notes/doc.md?q=a#part) ![pending](assets/new.png)",
        );
    });

    it.each([
        [
            "\\\\?\\C:\\100% # Notes\\source.md",
            "file:///C:/100%25%20%23%20Notes/a%20b%25.png#part",
        ],
        [
            "\\\\?\\UNC\\server\\share\\100% # Notes\\source.md",
            "file://server/share/100%25%20%23%20Notes/a%20b%25.png#part",
        ],
        [
            "\\\\server\\share\\100% # Notes\\source.md",
            "file://server/share/100%25%20%23%20Notes/a%20b%25.png#part",
        ],
    ])(
        "projects extended Windows path %s into a valid file URL",
        (sourcePath, expected) => {
            expect(
                rebaseMarkdownReferences("![pic](a%20b%25.png#part)", sourcePath),
            ).toBe("![pic](" + expected + ")");
        },
    );

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
