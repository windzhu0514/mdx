import { describe, expect, it } from "vitest";

import capability from "../src-tauri/capabilities/default.json";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("Tauri 主窗口权限", () => {
    it("允许关闭事件完成 close 和 destroy 调用", () => {
        expect(capability.permissions).toContain("core:window:allow-close");
        expect(capability.permissions).toContain("core:window:allow-destroy");
    });

    it("保留文档导出选择目标路径所需的系统对话框权限", () => {
        expect(capability.permissions).toContain("dialog:default");
    });

    it("关闭原生标题栏装饰", () => {
        expect(tauriConfig.app.windows[0]?.decorations).toBe(false);
    });

    it("只补充自绘标题栏所需的窗口命令权限", () => {
        expect(capability.permissions).toContain("core:window:allow-minimize");
        expect(capability.permissions).toContain("core:window:allow-toggle-maximize");
        expect(capability.permissions).toContain("core:window:allow-start-dragging");
        expect(capability.permissions).not.toContain(
            "core:window:allow-set-decorations",
        );
    });
});
