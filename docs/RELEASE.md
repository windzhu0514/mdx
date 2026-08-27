# Mora 跨平台发布手册

本文描述 Windows x64、macOS Apple Silicon/Intel、Linux x64、GitHub Releases 和 Tauri 自动更新。流水线只创建 Draft Release，不会自动公开发布。

## 1. 保管更新签名密钥

更新私钥位于：

```text
C:\Users\ljc01\.tauri\mora-updater.key
```

对应公钥位于同目录的 `mora-updater.key.pub`，公钥已经写入 `src-tauri/tauri.conf.json`。

- 将私钥和公钥备份到受控的离线密码库或加密介质。
- 不要把私钥加入 Git、工单、聊天、构建日志或 Release 资产。
- 不要为普通版本重新生成密钥。更换公钥后，已安装的旧版本无法验证使用新私钥签名的更新。

## 2. 配置 GitHub Actions Secrets

在仓库 `Settings → Secrets and variables → Actions` 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：仅当私钥设置了密码时配置；无密码时保持未设置。

三个操作系统共用这套 Tauri updater 签名身份。使用 GitHub 网页的 Secret 输入框或从标准输入直接写入 Secret，避免在终端打印私钥。`GITHUB_TOKEN` 由 GitHub Actions 自动提供，无需另建长期令牌。

## 3. 更新版本号

发布版本必须是 SemVer，且以下权威版本完全一致：

1. `package.json`
2. `src-tauri/Cargo.toml` 的根 `[package].version`
3. `src-tauri/tauri.conf.json` 的 `version`

同时同步 `package-lock.json` 和 `src-tauri/Cargo.lock` 中 Mora 根包的版本。发布标签必须是完全对应的 `app-vX.Y.Z`。

## 4. 本地发布门禁

以 `0.1.1` 为例，在 PowerShell 中验证标签和仓库版本：

```powershell
$env:RELEASE_TAG = "app-v0.1.1"
npm run release:check
Remove-Item Env:RELEASE_TAG
```

然后依次运行：

```powershell
npm test
npm run lint
npm run format:check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run build:exe
npm run tauri -- build
```

任一命令失败都停止发布。Windows 本地正式构建必须提供与 GitHub Secrets 相同的 Tauri 更新签名私钥环境变量，确保安装包带有对应 updater 签名。

Windows 主机只能真实验证 Windows 构建。macOS 与 Linux 的权威编译和打包结果来自 GitHub-hosted 对应 Runner，不能用 Windows 本地检查代替。

## 5. 跨平台构建矩阵

`Publish Mora` 工作流先执行一次通用质量门禁，再依次构建：

| 平台    | 架构          | 安装包                      |
| ------- | ------------- | --------------------------- |
| Windows | x64           | 简体中文 NSIS、简体中文 MSI |
| macOS   | Apple Silicon | DMG                         |
| macOS   | Intel         | DMG                         |
| Linux   | x64           | AppImage、Deb               |

平台任务串行上传，以避免多个任务同时更新 `latest.json`。本版本不生成 RPM、Snap、Flatpak、ARM Linux 或 Windows ARM64。

## 6. macOS 签名限制

当前 macOS 包使用 `signingIdentity: "-"` 的 ad-hoc 签名。它满足 Apple Silicon 的最低签名要求，可降低下载包被直接判断为损坏的概率，但不等于 Apple Developer ID 签名或公证。

用户从 GitHub 下载 DMG 后按以下步骤安装：

1. Apple Silicon 用户下载 `aarch64.dmg`，Intel 用户下载 `x64.dmg`。
2. 打开 DMG，将 `Mora.app` 拖入“应用程序”。
3. 首次启动被阻止时，前往“系统设置 → 隐私与安全性 → 仍要打开”。
4. 如果仍提示“应用已损坏”，在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Mora.app"
```

然后重新打开 Mora。该命令只移除 GitHub 下载产生的 quarantine 隔离属性，不使用 Apple Developer 凭据。要彻底消除首次启动警告，仍需要 Apple Developer Program、Developer ID Application 证书和公证流程；接入这些能力时再新增对应 Secrets。

## 7. 创建 Draft Release

只有获得明确发布授权后，才创建并推送与仓库版本完全一致的标签：

```powershell
git tag app-v0.1.1
git push origin app-v0.1.1
```

也可以手动运行 `Publish Mora` workflow，并输入完全一致的 `release_tag`。创建标签、推送标签和运行工作流都属于发布操作，需要明确授权。

## 8. 审核并公开

在公开 Draft 前逐项确认：

- Windows：一个简体中文 `.msi` 和一个 NSIS setup `.exe`。
- macOS：aarch64 与 x86_64 两个 `.dmg`。
- Linux：一个 `.AppImage` 和一个 `.deb`。
- updater 更新归档及对应 `.sig` 文件存在。
- `latest.json` 同时包含 Windows、macOS 和 Linux 平台条目，版本、下载 URL 和签名字段正确。
- Release 标题、说明和目标提交正确。
- Windows 安装器界面为简体中文。
- 至少在一台非开发机上分别验证可用平台的安装、启动、手动检查更新和未保存文档保护。

全部通过后，在 GitHub Releases 页面手动发布 Draft。流水线不会替你执行这一步。

## 9. 错误版本处理

发现坏版本时，先停止其公开分发或移除对应公开 Release，再发布更高的补丁版本。

- 不复用已经发布的标签或版本号。
- 不降低版本号覆盖旧版本。
- 不替换同一版本的签名资产来规避升级规则。
- 任一目标平台构建失败时保持 Draft，不发布缺少平台产物的版本。

## 10. 平台代码签名与 updater 签名

Tauri updater 签名用于让 Mora 验证下载的更新包没有被替换；它不等于平台可信发布者签名。

- Windows：未配置 Authenticode 时仍可能显示“未知发布者”。
- macOS：ad-hoc 签名不能替代 Developer ID 与公证。
- Linux：AppImage 和 Deb 通过 GitHub Release 与 updater 签名分发，当前不维护独立软件源签名。

后续取得平台证书时，应单独配置并验证，不能与 `TAURI_SIGNING_PRIVATE_KEY` 混用，也不能移除现有 updater 签名。
