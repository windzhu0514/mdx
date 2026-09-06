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
