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

describe("monochrome interaction theme", () => {
    it("maps workspace and search states through theme variables", () => {
        expect(styleCss).not.toMatch(/rgba\(59,\s*130,\s*246/iu);
        expect(styleCss).toMatch(
            /\.workspace-tree-item\.active\s*\{[^}]*background:\s*var\(--color-primary-soft\)/su,
        );
        expect(styleCss).toMatch(
            /\.find-input:focus\s*\{[^}]*border-color:\s*var\(--color-focus-border\)[^}]*box-shadow:\s*0 0 0 3px var\(--color-focus-shadow\)/su,
        );
    });

    it("uses grayscale monochrome variables for CodeMirror selection and active lines", () => {
        expect(experienceCss).toMatch(
            /:root\[data-theme="monochrome"\]\s*\{[^}]*--editor-selection-background:\s*rgba\(36, 36, 36, 0\.18\)[^}]*--editor-active-line-background:\s*rgba\(36, 36, 36, 0\.06\)/su,
        );
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

    it("defines a matte dark palette for chrome, sidebars, controls, and inputs", () => {
        expect(experienceCss).toMatch(
            /:root\[data-theme="dark"\]\s*\{[^}]*--color-bg-chrome:\s*rgba\(16, 24, 30, 0\.96\)[^}]*--color-bg-sidebar:\s*#121b21[^}]*--color-bg-popup:\s*rgba\(27, 38, 45, 0\.98\)[^}]*--color-bg-input:\s*#111a20[^}]*--color-bg-control:\s*rgba\(213, 231, 232, 0\.06\)[^}]*--app-background-image:/su,
        );
    });
});
