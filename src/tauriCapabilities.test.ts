import { describe, expect, it } from "vitest";

import capability from "../src-tauri/capabilities/default.json";

describe("Tauri 主窗口权限", () => {
    it("允许关闭事件完成 close 和 destroy 调用", () => {
        expect(capability.permissions).toContain("core:window:allow-close");
        expect(capability.permissions).toContain("core:window:allow-destroy");
    });
});
