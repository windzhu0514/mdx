import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";

describe("App 资源数据加载", () => {
    it("不通过受 Tauri CSP 限制的 data URL fetch 解码资源", () => {
        expect(appSource).not.toMatch(/fetch\s*\(\s*`data:/);
    });
});
