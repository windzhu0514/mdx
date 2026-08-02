import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";

describe("App 资源数据加载", () => {
    it("不通过受 Tauri CSP 限制的 data URL fetch 解码资源", () => {
        expect(appSource).not.toMatch(/fetch\s*\(\s*`data:/);
    });

    it("Markdown 本地资源转换只把规范相对路径交给保存链", () => {
        expect(appSource).toContain("MarkdownResourcesDialog");
        expect(appSource).toContain('"prepare_markdown_resources"');
        expect(appSource).toContain("plan.rewrittenContent");
        expect(appSource).not.toMatch(/session\.updateContent\([^)]*objectUrl/s);
    });
});
