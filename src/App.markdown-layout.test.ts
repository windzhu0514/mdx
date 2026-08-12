import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";
import moraEditorSource from "./components/editor/MoraEditor.vue?raw";

interface NodeProcess {
    cwd(): string;
    getBuiltinModule(name: "fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
    };
}

const nodeProcess = (globalThis as typeof globalThis & { process: NodeProcess }).process;
const styleCss = nodeProcess
    .getBuiltinModule("fs")
    .readFileSync(nodeProcess.cwd() + "/src/style.css", "utf8");

describe("App 编辑器视图", () => {
    it("orders workspace, editor and outline without moving the mode switch", () => {
        expect(appSource.indexOf("<WorkspaceSidebar")).toBeLessThan(
            appSource.indexOf('class="workspace-center"'),
        );
        expect(appSource.indexOf('class="workspace-center"')).toBeLessThan(
            appSource.indexOf("<TableOfContents"),
        );
        expect(appSource.indexOf('class="mode-switch compact"')).toBeLessThan(
            appSource.indexOf('class="main-body"'),
        );
        expect(appSource).toContain('@toggle-workspace="toggleWorkspacePanel"');
        expect(appSource).toContain('@toggle-outline="toggleOutlinePanel"');
        const printBlock = appSource.slice(appSource.indexOf("@media print"));
        expect(printBlock).toContain(".workspace-sidebar");
        expect(appSource).not.toContain(".document-tabs");
    });

    it("integrates the application menu and native controls into one titlebar", () => {
        expect(appSource).toContain(
            'import WindowControls from "./components/WindowControls.vue"',
        );
        expect(appSource).toContain('class="menu-bar custom-titlebar"');
        expect(appSource).toContain("data-tauri-drag-region");
        expect(appSource).toContain('<WindowControls v-if="tauriRuntime"');
        expect(appSource).not.toContain("titlebar-app-icon");
        expect(appSource.indexOf('class="mode-switch compact"')).toBeLessThan(
            appSource.indexOf("<WindowControls"),
        );
    });

    it("renders compact editor mode icon buttons with complete hover hints", () => {
        const modeSwitchSource = appSource.slice(
            appSource.indexOf('class="mode-switch compact"'),
            appSource.indexOf("<WindowControls"),
        );

        expect(modeSwitchSource).toContain('aria-label="所见即所得"');
        expect(modeSwitchSource).toContain('title="所见即所得"');
        expect(modeSwitchSource).toContain('aria-label="仅源码"');
        expect(modeSwitchSource).toContain('title="仅源码"');
        expect(modeSwitchSource).toContain('aria-label="垂直双栏"');
        expect(modeSwitchSource).toContain('title="垂直双栏"');
        expect(modeSwitchSource.match(/class="mode-switch-icon"/gu)).toHaveLength(3);
        expect(modeSwitchSource.match(/aria-hidden="true"/gu)).toHaveLength(3);
        expect(modeSwitchSource).not.toMatch(/>\s*编辑\s*<\/button>/u);
        expect(modeSwitchSource).not.toMatch(/>\s*源码\s*<\/button>/u);
        expect(modeSwitchSource).not.toMatch(/>\s*双栏\s*<\/button>/u);
        expect(styleCss).toMatch(
            /\.mode-switch\.compact\s*\{[^}]*height:\s*32px[^}]*gap:\s*0[^}]*padding:\s*2px[^}]*border:\s*1px solid var\(--color-border\)[^}]*border-radius:\s*8px[^}]*background:\s*var\(--color-bg-control\)/su,
        );
        expect(styleCss).toMatch(
            /\.mode-switch\.compact button\s*\{[^}]*width:\s*28px[^}]*min-width:\s*28px[^}]*height:\s*28px[^}]*padding:\s*0[^}]*border-radius:\s*6px/su,
        );
        expect(styleCss).toMatch(
            /\.mode-switch-icon\s*\{[^}]*width:\s*15px[^}]*height:\s*15px[^}]*stroke:\s*currentColor/su,
        );
    });

    it("只提供所见即所得、仅源码和垂直双栏", () => {
        expect(appSource).toContain("所见即所得");
        expect(appSource).toContain("仅源码");
        expect(appSource).toContain("垂直双栏");
        expect(appSource).not.toContain("仅预览");
        expect(appSource).toContain("<MoraEditor");
    });

    it("打印时解除 MoraEditor 容器的固定高度和裁剪", () => {
        expect(appSource).toContain(".markdown-editor .mora-editor");
    });

    it("源码编辑区不使用所见即所得正文的居中限宽", () => {
        const sourceContentRule = moraEditorSource.match(
            /\.source-layout :deep\(\.cm-content\)\s*\{([^}]*)\}/,
        )?.[1];

        expect(sourceContentRule).toBeDefined();
        expect(sourceContentRule).toContain("max-width: none");
        expect(sourceContentRule).toContain("margin-inline: 0");
    });
});
