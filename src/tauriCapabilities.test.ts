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
        expect(capability.permissions).not.toContain("core:window:allow-set-decorations");
    });

    it("只开放更新检查、安装和重启所需权限", () => {
        expect(capability.permissions).toContain("updater:default");
        expect(capability.permissions).toContain("process:allow-restart");
    });

    it("只从 GitHub Releases HTTPS endpoint 获取签名更新", () => {
        expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
        expect(tauriConfig.plugins.updater.endpoints).toEqual([
            "https://github.com/windzhu0514/mdx/releases/latest/download/latest.json",
        ]);
        expect(tauriConfig.plugins.updater.pubkey).not.toMatch(/placeholder|replace/i);
        expect(tauriConfig.plugins.updater.pubkey.length).toBeGreaterThan(40);
        expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
    });
});
