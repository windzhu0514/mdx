import { describe, expect, it } from "vitest";

interface NodeProcess {
    cwd(): string;
    getBuiltinModule(name: "fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
    };
}

const nodeProcess = (globalThis as typeof globalThis & { process: NodeProcess }).process;
const fs = nodeProcess.getBuiltinModule("fs");
const styleCss = fs.readFileSync(nodeProcess.cwd() + "/src/style.css", "utf8");
const experienceCss = fs.readFileSync(nodeProcess.cwd() + "/src/experience.css", "utf8");

describe("application viewport", () => {
    it("keeps scrolling inside editor panes instead of the WebView page", () => {
        expect(styleCss).toMatch(/html,\s*body,\s*#app\s*\{[^}]*overflow:\s*hidden/su);
        expect(styleCss).toMatch(
            /\.markdown-editor \.milkdown-editor,\s*\.markdown-editor \.source-editor\s*\{[^}]*overflow:\s*auto/su,
        );
    });
});

describe("primary scrollbars", () => {
    it("keeps workspace, editor, and outline scrollbars hidden until scrolling", () => {
        const primaryScrollContainer =
            /:where\(\s*\.workspace-tree,\s*\.toc-sidebar,\s*\.markdown-editor \.milkdown-editor,\s*\.markdown-editor \.cm-scroller\s*\)/su;

        expect(styleCss).toMatch(primaryScrollContainer);
        expect(styleCss).toMatch(
            /scrollbar-width:\s*thin[^}]*scrollbar-color:\s*transparent transparent/su,
        );
        expect(styleCss).toMatch(
            /:where\([^}]*\)::-webkit-scrollbar\s*\{[^}]*width:\s*8px[^}]*height:\s*8px/su,
        );
        expect(styleCss).toMatch(
            /:where\([^}]*\)\[data-scroll-active="true"\]\s*\{[^}]*scrollbar-color:\s*color-mix\(in srgb, var\(--color-text-muted\) 52%, transparent\)\s*transparent/su,
        );
        expect(styleCss).toMatch(
            /:where\([^}]*\)\[data-scroll-active="true"\]::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-text-muted\) 52%, transparent\)/su,
        );
    });
});

describe("theme interaction variables", () => {
    it("maps workspace and search states through theme variables", () => {
        expect(styleCss).not.toMatch(/rgba\(59,\s*130,\s*246/iu);
        expect(styleCss).toMatch(
            /\.workspace-tree-item\.active\s*\{[^}]*background:\s*var\(--color-primary-soft\)/su,
        );
        expect(styleCss).toMatch(
            /\.find-input:focus\s*\{[^}]*border-color:\s*var\(--color-focus-border\)[^}]*box-shadow:\s*0 0 0 3px var\(--color-focus-shadow\)/su,
        );
    });

    it("keeps CodeMirror selection and active lines theme-driven", () => {
        expect(styleCss).toMatch(
            /\.cm-selectionBackground[^}]*background:\s*var\(--editor-selection-background\)\s*!important/su,
        );
        expect(styleCss).toMatch(
            /\.cm-activeLine[^}]*background:\s*var\(--editor-active-line-background\)/su,
        );
    });
});

describe("dark application theme", () => {
    it("routes application chrome through semantic surface variables", () => {
        expect(styleCss).toMatch(
            /html,[\s\S]*?#app\s*\{[^}]*background-image:\s*var\(--app-background-image\)/u,
        );
        expect(styleCss).toMatch(
            /\.workspace-sidebar\s*\{[^}]*background:\s*var\(--color-bg-sidebar\)/su,
        );
        expect(styleCss).toMatch(
            /\.toc-sidebar\s*\{[^}]*background:\s*var\(--color-bg-sidebar-subtle\)/su,
        );
        expect(styleCss).toMatch(
            /\.menu-bar\s*\{[^}]*background:\s*var\(--color-bg-chrome\)/su,
        );
        expect(styleCss).toMatch(
            /\.status-bar\s*\{[^}]*background:\s*var\(--color-bg-chrome\)/su,
        );
        expect(styleCss).toMatch(
            /\.menu-popup\s*\{[^}]*background:\s*var\(--color-bg-popup\)/su,
        );
        expect(styleCss).toMatch(
            /\.find-panel\s*\{[^}]*background:\s*var\(--color-bg-popup\)/su,
        );
    });

    it("defines all six palettes with complete semantic surfaces", () => {
        for (const theme of [
            "xuan-white",
            "ink-black",
            "dai-blue",
            "pine-green",
            "crimson",
            "wisteria",
        ]) {
            expect(experienceCss).toMatch(
                new RegExp(
                    `:root\\[data-theme="${theme}"\\][^{]*\\{[^}]*--color-bg-base:[^}]*--color-bg-surface:[^}]*--color-bg-chrome:[^}]*--color-bg-sidebar:[^}]*--color-primary:`,
                    "su",
                ),
            );
        }
    });

    it("uses NyaMark white across the entire xuan white window", () => {
        const block = experienceCss.match(
            /:root\[data-theme="xuan-white"\][^{]*\{([^}]*)\}/su,
        )?.[1];
        expect(block).toBeDefined();

        const readToken = (token: string) =>
            block?.match(new RegExp(`--${token}:\\s*([^;]+);`, "u"))?.[1];

        for (const token of [
            "color-bg-base",
            "color-bg-surface",
            "color-bg-chrome",
            "color-bg-sidebar",
            "color-bg-sidebar-subtle",
            "color-bg-sidebar-header",
            "color-bg-elevated",
            "color-bg-popup",
            "color-bg-input",
        ]) {
            expect(readToken(token)).toBe("#fffffd");
        }
        expect(readToken("color-border")).toBe("#eeeeec");
        expect(readToken("app-background-image")).toBe("none");
        expect(experienceCss).not.toContain("#f7f5ef");
    });

    it("keeps dai blue visibly distinct from ink black", () => {
        const readThemeToken = (theme: string, token: string) => {
            const block = experienceCss.match(
                new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "su"),
            )?.[1];
            expect(block).toBeDefined();
            return block?.match(new RegExp(`--${token}:\\s*([^;]+);`, "u"))?.[1];
        };

        expect(readThemeToken("dai-blue", "color-bg-base")).toBe("#162334");
        expect(readThemeToken("dai-blue", "color-bg-surface")).toBe("#1c2b3d");
        expect(readThemeToken("dai-blue", "color-bg-sidebar")).toBe("#18283a");
        expect(readThemeToken("dai-blue", "color-bg-elevated")).toBe("#24364b");
        expect(readThemeToken("dai-blue", "color-text-main")).toBe("#e7edf3");
        expect(readThemeToken("dai-blue", "color-primary")).toBe("#668db3");

        for (const token of [
            "color-bg-base",
            "color-bg-surface",
            "color-bg-sidebar",
            "color-primary",
        ]) {
            expect(readThemeToken("dai-blue", token)).not.toBe(
                readThemeToken("ink-black", token),
            );
        }
    });

    it("uses each neutral and blue theme's own accent colors", () => {
        const readThemeToken = (theme: string, token: string) => {
            const block = experienceCss.match(
                new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "su"),
            )?.[1];
            expect(block).toBeDefined();
            return block?.match(new RegExp(`--${token}:\\s*([^;]+);`, "u"))?.[1];
        };

        expect(readThemeToken("xuan-white", "color-primary")).toBe("#596164");
        expect(readThemeToken("xuan-white", "color-primary-light")).toBe("#eef0ef");
        expect(readThemeToken("ink-black", "color-primary")).toBe("#b8c0c3");
        expect(readThemeToken("ink-black", "color-primary-light")).toBe(
            "rgba(184, 192, 195, 0.16)",
        );
        expect(readThemeToken("dai-blue", "color-primary")).toBe("#668db3");
        expect(readThemeToken("dai-blue", "color-primary-light")).toBe(
            "rgba(102, 141, 179, 0.24)",
        );
    });

    it("uses one main background across each light theme window", () => {
        for (const theme of ["pine-green", "crimson", "wisteria"]) {
            const block = experienceCss.match(
                new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "su"),
            )?.[1];
            expect(block).toBeDefined();

            const values = [
                "base",
                "chrome",
                "sidebar",
                "sidebar-subtle",
                "sidebar-header",
            ].map(
                (token) =>
                    block?.match(
                        new RegExp(`--color-bg-${token}:\\s*([^;]+);`, "u"),
                    )?.[1],
            );

            expect(new Set(values).size).toBe(1);
        }
    });

    it("uses the surrounding workspace background across every editor theme", () => {
        expect(experienceCss).toMatch(
            /\.editor-card\s*\{[^}]*background:\s*var\(--color-bg-base\)/su,
        );
        expect(experienceCss).toMatch(
            /\.markdown-editor \.milkdown\s*\{[^}]*--crepe-color-background:\s*var\(--color-bg-base\)[^}]*--crepe-color-surface:\s*var\(--color-bg-base\)/su,
        );
        expect(experienceCss).toMatch(
            /\.markdown-editor \.source-editor,\s*\.markdown-editor \.cm-editor,\s*\.markdown-editor \.cm-gutters\s*\{[^}]*background:\s*var\(--color-bg-base\)\s*!important/su,
        );
        expect(experienceCss).toMatch(
            /\.markdown-editor \.cm-content\s*\{[^}]*background:\s*var\(--color-bg-base\)/su,
        );
        expect(experienceCss).toMatch(
            /\.theme-card:not\(\[data-theme-preview="ink-black"\]\) \.theme-card-page\s*\{[^}]*background:\s*var\(--color-bg-base\)/su,
        );
    });
});

describe("bottom theme picker", () => {
    it("uses a native horizontal overflow track for side-to-side comparison", () => {
        expect(experienceCss).toMatch(
            /\.theme-picker-track\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/su,
        );
    });
});

describe("settings workspace", () => {
    it("uses an in-app categorized layout with a responsive preview column", () => {
        expect(experienceCss).toMatch(
            /\.settings-workspace\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/su,
        );
        expect(experienceCss).toMatch(
            /\.settings-appearance-layout\s*\{[^}]*grid-template-columns:\s*minmax\(420px, 520px\) minmax\(360px, 1fr\)/su,
        );
        expect(experienceCss).toMatch(
            /@media \(max-width:\s*1100px\)[^{]*\{[\s\S]*?\.settings-appearance-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u,
        );
    });

    it("previews body and code with the same variables as the editor", () => {
        expect(experienceCss).toMatch(
            /\.settings-live-preview\s*\{[^}]*font-family:\s*var\(--editor-font-family\)[^}]*font-size:\s*var\(--editor-font-size\)[^}]*line-height:\s*var\(--editor-line-height\)/su,
        );
        expect(experienceCss).toMatch(
            /\.settings-live-preview code,\s*\.settings-live-preview pre\s*\{[^}]*font-family:\s*var\(--editor-code-font-family\)/su,
        );
    });
});

describe("body and code editor fonts", () => {
    it("registers the bundled Maple Mono CN regular font", () => {
        expect(styleCss).toMatch(
            /@font-face\s*\{[^}]*font-family:\s*"Maple Mono CN Bundled"[^}]*src:\s*url\("\/fonts\/maple-mono-cn\/MapleMono-CN-Regular\.ttf"\)\s*format\("truetype"\)[^}]*font-weight:\s*400[^}]*font-style:\s*normal/su,
        );
    });

    it("keeps body text on the body font variable", () => {
        expect(experienceCss).toMatch(
            /\.markdown-editor \.ProseMirror\s*\{[^}]*font-family:\s*var\(--editor-font-family\)/su,
        );
        expect(experienceCss).toMatch(
            /--crepe-font-default:\s*var\(--editor-font-family\)/su,
        );
    });

    it("uses the code font variable for source and rich-text code", () => {
        expect(styleCss).toMatch(
            /\.markdown-editor \.cm-content\s*\{[^}]*font-family:\s*var\(--editor-code-font-family\)/su,
        );
        expect(experienceCss).toMatch(
            /\.markdown-editor \.cm-content\s*\{[^}]*font-family:\s*var\(--editor-code-font-family\)/su,
        );
        expect(experienceCss).toMatch(
            /--crepe-font-code:\s*var\(--editor-code-font-family\)/su,
        );
    });
});
