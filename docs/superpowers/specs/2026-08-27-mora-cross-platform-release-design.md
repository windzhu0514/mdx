# Mora 跨平台发布设计

**日期：** 2026-08-27

**状态：** 已批准

**目标版本：** 0.1.1

## 目标

1. 将现有 GitHub Draft Release 从 Windows x64 扩展为 Windows、macOS 和 Linux 桌面发布。
2. 生成以下安装包：
    - Windows x64：简体中文 NSIS、简体中文 MSI。
    - macOS：Apple Silicon DMG、Intel DMG。
    - Linux x64：AppImage、Deb。
3. 保持现有 Tauri updater 私钥签名、`latest.json`、Draft Release 和人工发布边界。
4. 将仓库版本准备到 `0.1.1`，但本次不创建标签、不推送、不公开 Release。

## 当前必须实现

### 发布流水线

发布流程拆为两个职责：

- `verify`：在 Ubuntu 上执行版本一致性、前端测试、Lint、格式、前端构建、Rust 测试和 Rust 检查。
- `publish`：在四个目标矩阵项中执行目标架构检查和真实 Tauri 打包，并把产物上传到同一个 Draft Release。

矩阵固定为：

| 目标                | Runner           | Rust target                | Bundles        |
| ------------------- | ---------------- | -------------------------- | -------------- |
| Windows x64         | `windows-latest` | `x86_64-pc-windows-msvc`   | `nsis,msi`     |
| macOS Apple Silicon | `macos-latest`   | `aarch64-apple-darwin`     | `dmg`          |
| macOS Intel         | `macos-latest`   | `x86_64-apple-darwin`      | `dmg`          |
| Linux x64           | `ubuntu-22.04`   | `x86_64-unknown-linux-gnu` | `appimage,deb` |

`publish` 使用 `max-parallel: 1`。原因是每个目标都会更新同一个 `latest.json`；串行上传避免多个矩阵任务同时删除、合并和上传该文件。发布频率低，可靠性优先于并行节省的时间。

Linux 仅安装 Tauri 官方构建所需的 GTK/WebKit、AppIndicator、SVG、OpenSSL、patchelf 和 xdg-utils 依赖，不增加 RPM 工具链。

### 安装器与图标

- WiX `language` 固定为 `zh-CN`，只生成简体中文 MSI。
- NSIS `languages` 固定为 `SimpChinese`，不显示语言选择器。
- macOS 配置 `signingIdentity: "-"`，使用 ad-hoc 签名，避免 Apple Silicon 下载包被直接识别为损坏；它不能替代 Apple Developer 签名和公证。
- 继续使用现有 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns` 和 `icon.ico`，不再引入第二套图标源。

### 版本与文档

- `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、根包对应的 `Cargo.lock` 条目和 `tauri.conf.json` 同步到 `0.1.1`。
- 发布手册改为跨平台，明确各平台产物、macOS ad-hoc 限制、平台验证和 Draft 审核清单。
- README 标明 `0.1.0` 是当前公开版本，`0.1.1` 正在准备跨平台发布。

## 数据与发布流程

1. 标签推送或手动输入 `app-vX.Y.Z` 启动工作流。
2. `verify` 先验证标签与三处版本一致并通过通用门禁。
3. 四个 `publish` 矩阵项依次执行目标架构 `cargo check` 和 Tauri 构建。
4. 所有平台共用 `TAURI_SIGNING_PRIVATE_KEY` 与可选密码，生成 updater 签名。
5. `tauri-action` 将安装包、更新包、签名和合并后的 `latest.json` 上传到同一个 Draft Release。
6. 发布者审核全部平台资产后手动公开 Draft。

## 错误处理

- 任一通用门禁失败：不进入平台构建。
- 任一平台构建失败：工作流失败，Draft 保持未公开；不以缺少该平台产物的状态发布。
- `latest.json` 上传失败：该矩阵项失败；`retryAttempts: 3` 允许瞬时 GitHub API 或上传错误重试。
- 未配置 Apple Developer 凭据：继续生成 ad-hoc 签名 DMG，但文档必须明确 Gatekeeper 仍可能要求用户手动允许。
- Tauri updater 私钥缺失：平台构建失败，不降级为无更新签名发布。

## 验证与验收

### 自动化

- `releaseWorkflow.test.ts` 校验四项目标矩阵、目标 bundles、Linux 依赖、串行发布、Draft/updater 配置和 Windows/macOS bundler 配置。
- 本地运行版本检查、前端测试、Lint、格式、前端构建、Rust 测试、Cargo 检查和 Windows EXE/安装包构建。
- GitHub Actions 是 macOS/Linux 真实编译与产物验证的权威环境；Windows 主机不伪装为已执行 macOS/Linux 构建。

### Draft Release

- Windows：`.msi`、NSIS setup `.exe` 及对应 updater 签名。
- macOS：aarch64 与 x86_64 两个 `.dmg`，以及 updater 归档与签名。
- Linux：`.AppImage`、`.deb`，以及 updater 签名。
- `latest.json` 同时包含 Windows、macOS 和 Linux 对应平台条目。

## 仅在指标不达标时增加

- 如果串行构建时间持续超过 60 分钟，再拆分“并行构建产物 + 单独聚合发布”的流程。
- 如果 macOS 用户安装失败率不可接受，再接入 Apple Developer ID 与公证。
- 如果 Linux 用户明确需要 Fedora/RHEL 安装包，再增加 RPM。

## 本次不实现

- RPM、Snap、Flatpak、AUR。
- Linux ARM64、Windows ARM64、Windows x86。
- Apple Developer 证书、公证或 Mac App Store。
- Windows Authenticode、Microsoft Store。
- 自动公开 Release、自动创建或推送标签。
- 自建更新服务器、灰度发布或更新渠道系统。

## 删减检查

| 新增或修改项           | 必要性                                   | 删除后的失败项             |
| ---------------------- | ---------------------------------------- | -------------------------- |
| 四项目标矩阵           | 生成已确认的三平台四架构产物             | 对应安装包缺失             |
| Linux 依赖步骤         | Ubuntu 无法编译 WebKit/GTK Tauri 应用    | Linux 构建失败             |
| Windows 安装器语言配置 | 生成中文 MSI/NSIS                        | 安装界面仍为英文           |
| macOS ad-hoc 签名      | Apple Silicon 直接下载运行的最低签名要求 | 下载包可能被判断为损坏     |
| 串行发布与上传重试     | 保护共享 `latest.json`                   | 并行上传存在竞争和间歇失败 |
| 发布契约测试           | 在触发真实付费 CI 前发现矩阵/配置回退    | 错误只能在发布时发现       |

没有新增接口、脚本、构建服务或依赖抽象；现有 `publish.yml`、Tauri 配置和测试足以承担需求。

## 参考资料

- https://v2.tauri.app/distribute/pipelines/github/
- https://github.com/tauri-apps/tauri-action
- https://v2.tauri.app/distribute/windows-installer/
- https://v2.tauri.app/distribute/sign/macos/
