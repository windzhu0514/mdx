## Mora 0.1.3 公开测试版

本版本以 Pre-release 发布，不进入客户端默认自动更新通道。

### 新增与改进

- 支持标准 Markdown（`.md` / `.markdown`）原格式读写；`Ctrl+S` 直接保存当前文件。
- 可新建 Markdown 或 Mora MDX，通过“另存为 Markdown / MDX”转换格式，保留原文件并处理图片、附件与相对路径。
- 两种格式共用所见即所得、源码、源码与预览；保留 frontmatter、BOM，并改善资源编码、HTML 实体与片段链接处理。
- 加强保存失败保护、草稿恢复后的外部修改冲突检测，以及未引用资源往返转换的完整性。
- 优化工作区打开入口、目录间距、文件行选中效果、最近打开菜单和路径显示。
- 主题选择改为点击框外或按 Esc 关闭；简化状态栏反馈。
- 延续此前候选版的 ZIP 有界读取、保存恢复、历史快照与本地 Agent 可靠性修复。

### 使用与测试范围

- 打开普通 Markdown 后，“保存”会写回原文件；需要单文件封装时请选择“另存为 MDX”。这里的 MDX 是 Mora MDXNote 格式，与 Markdown + JSX 无关。
- Markdown 资源存于外部目录，分享时需要一起携带。内置历史及包内附件重命名、删除适用于 MDX；Markdown 外置文件在文件夹中管理。
- 此为公开测试版，建议先备份重要笔记。本机验收以 Windows x64 为范围；各平台 CI 构建不等于所有平台的独立实机验收。
- 源码采用 MIT；第三方依赖与内嵌字体的独立许可证随安装包提供。
- Windows 未配置 Authenticode，可能显示未知发布者；macOS 使用 ad-hoc 签名，未配置 Developer ID 与公证。

## 下载与安装

- Windows x64：下载 `x64-setup.exe`（推荐）或 `x64_zh-CN.msi`。
- macOS Apple Silicon：下载 `aarch64.dmg`；Intel：下载 `x64.dmg`。
- Linux x64：下载 `.AppImage` 或 `.deb`。

### macOS 首次启动

将 `Mora.app` 拖入“应用程序”后，如被阻止，前往“系统设置 → 隐私与安全性 → 仍要打开”。仍提示损坏时，可在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Mora.app"
```
