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
