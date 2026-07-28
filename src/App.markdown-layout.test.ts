import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";

describe("App Markdown 单栏布局", () => {
    it("只隐藏对应子面板，并让保留面板占满容器", () => {
        expect(appSource).not.toMatch(
            /\.markdown-editor\.preview-only\s+:deep\(\.toastui-editor-md-container\)\s*\{\s*display:\s*none/,
        );
        expect(appSource).toMatch(
            /\.markdown-editor\.source-only\s+:deep\(\.toastui-editor-md-container > \.toastui-editor\)/,
        );
        expect(appSource).toMatch(
            /\.markdown-editor\.preview-only\s+:deep\(\.toastui-editor-md-container > \.toastui-editor\)/,
        );
        expect(appSource).toMatch(
            /\.markdown-editor\.preview-only\s+:deep\(\.toastui-editor-md-preview\)\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/s,
        );
    });
});
