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

    it("keeps xuan white neutral instead of paper yellow", () => {
        expect(experienceCss).toMatch(
            /:root\[data-theme="xuan-white"\][^{]*\{[^}]*--color-bg-base:\s*#f6f7f7[^}]*--color-bg-surface:\s*#fbfcfc[^}]*--color-bg-chrome:\s*#eceeef[^}]*--color-bg-sidebar:\s*#f0f2f2/su,
        );
        expect(experienceCss).not.toContain("#f7f5ef");
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
