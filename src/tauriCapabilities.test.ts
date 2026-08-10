import { describe, expect, it } from "vitest";

import capability from "../src-tauri/capabilities/default.json";

describe("Tauri 主窗口权限", () => {
    it("允许关闭事件完成 close 和 destroy 调用", () => {
        expect(capability.permissions).toContain("core:window:allow-close");
        expect(capability.permissions).toContain("core:window:allow-destroy");
    });

    it("保留文档导出选择目标路径所需的系统对话框权限", () => {
        expect(capability.permissions).toContain("dialog:default");
    });
});
