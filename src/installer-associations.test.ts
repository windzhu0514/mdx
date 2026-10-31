import { it, expect } from "vitest";
import windowsConfig from "../src-tauri/tauri.windows.conf.json";
import nsisHooks from "../src-tauri/installer/file-open-choices.nsh?raw";
import wixFragment from "../src-tauri/installer/file-open-choices.wxs?raw";
it("Windows 安装包禁用会接管扩展名默认值的内置关联", () => {
    const config = windowsConfig;
    expect(config.bundle?.fileAssociations).toEqual([]);
    expect(config.bundle?.windows?.wix?.componentRefs).toContain("MoraFileOpenChoices");
});
it("NSIS 只注册独立 ProgID 和命名 OpenWith 值", () => {
    const hooks = nsisHooks;
    expect(hooks).toContain("OpenWithProgids");
    expect(hooks).toContain("com.mora.desktop.mdx");
    expect(hooks).not.toMatch(/Software\\Classes\\\.\w+"\s+""/u);
    expect(hooks).not.toContain("UserChoice");
    expect(hooks).not.toContain("APP_ASSOCIATE");
    expect(hooks).toContain('$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\" $\\"%1$\\"');
});
it("MSI 只写打开方式命名值，命令对程序与文件参数均加引号", () => {
    const fragment = wixFragment;
    expect(fragment).toContain("OpenWithProgids");
    expect(fragment).not.toMatch(/<Extension\b/u);
    expect(fragment).not.toContain("UserChoice");
    expect(fragment).toContain("&quot;[INSTALLDIR]mora.exe&quot; &quot;%1&quot;");
});
