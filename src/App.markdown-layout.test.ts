import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";
import moraEditorSource from "./components/editor/MoraEditor.vue?raw";

describe("App 编辑器视图", () => {
    it("orders workspace, tabbed editor and outline without moving the mode switch", () => {
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
        expect(printBlock).toContain(".document-tabs");
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
