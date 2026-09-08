## 0.1.3 公开测试说明

此版本定位为公开测试版，重点修复笔记保存、恢复、资源路径与本地 Agent 的可靠性问题。升级前请备份重要笔记。

- 修复 ZIP 解压大小校验、草稿原子替换和保存中断后的备份恢复。
- 修复大正文历史快照导致后续保存失败的问题。
- 修复 Markdown 导出及资源路径转换误改代码、外链或遗漏真实图片引用的问题。
- 修复文档关闭后的资源泄漏、更新器资源释放、文件监听重扫和 Agent 请求取消清理。
- 项目源码采用 MIT；第三方依赖及内嵌字体继续适用各自许可，原始声明随安装包提供。

本地运行验收以 Windows x64 为范围。macOS/Linux 构建通过不能代替对应平台实机验收。Windows 尚未配置 Authenticode；macOS 尚未配置 Developer ID 与公证。

## 下载与安装

- Windows x64：下载 `x64-setup.exe`（推荐）或 `x64_zh-CN.msi`。
- macOS Apple Silicon（M1 及后续芯片）：下载 `aarch64.dmg`。
- macOS Intel：下载 `x64.dmg`。
- Linux x64：下载 `.AppImage` 或 `.deb`。

### macOS 首次启动

本版本使用 ad-hoc 签名，未经过 Apple Developer 公证。将 `Mora.app` 拖入“应用程序”后，如果 macOS 阻止启动：

1. 前往“系统设置 → 隐私与安全性 → 仍要打开”。
2. 如果仍提示“应用已损坏”，在终端执行：

    `xattr -dr com.apple.quarantine "/Applications/Mora.app"`

3. 重新打开 Mora。
