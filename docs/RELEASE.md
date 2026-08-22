# Mora Windows 发布手册

本文只描述 Windows x64、GitHub Releases 和 Tauri 自动更新。当前流水线创建 Draft Release，不会自动公开发布。

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

使用 GitHub 网页的 Secret 输入框或从标准输入直接写入 Secret，避免在终端打印私钥。`GITHUB_TOKEN` 由 GitHub Actions 自动提供，无需另建长期令牌。

## 3. 更新版本号

发布版本必须是 SemVer，且以下三处完全一致：

1. `package.json`（同时同步 `package-lock.json`）
2. `src-tauri/Cargo.toml` 的根 `[package].version`
3. `src-tauri/tauri.conf.json` 的 `version`

可以先运行 `npm version X.Y.Z --no-git-tag-version` 更新 npm 文件，再修改两处 Tauri/Rust 版本。随后运行 Cargo 命令同步锁文件。

## 4. 本地发布门禁

以首个 `0.1.0` Release 为例，在 PowerShell 中验证标签和仓库版本：

```powershell
$env:RELEASE_TAG = "app-v0.1.0"
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

任一命令失败都停止发布。正式构建时必须提供与 GitHub Secrets 相同的 Tauri 更新签名私钥环境变量，确保本地产物包含对应签名。

## 5. 创建 Draft Release

只有获得明确发布授权后，才创建并推送与仓库版本完全一致的标签：

```powershell
git tag app-v0.1.0
git push origin app-v0.1.0
```

后续版本沿用 `app-v` 前缀，例如 `app-v0.1.1`。也可以手动运行 `Publish Mora` workflow，并输入完全一致的 `release_tag`；这同样属于发布操作，需要明确授权。

工作流只在 `windows-latest` 构建 Windows x64，并创建 Draft Release。

## 6. 审核并公开

在公开 Draft 前逐项确认：

- NSIS `.exe` 安装包和 MSI `.msi` 安装包均存在。
- 更新安装包对应的 `.sig` 文件存在。
- `latest.json` 存在，版本、下载 URL 和签名字段正确。
- Release 标题、说明和目标提交正确。
- 在一台非开发机上验证安装、手动检查更新、下载、未保存文档保护和安装重启。

全部通过后，在 GitHub Releases 页面手动发布 Draft。流水线不会替你执行这一步。

## 7. 错误版本处理

发现坏版本时，先停止其公开分发或移除对应公开 Release，再发布更高的补丁版本，例如从 `0.1.0` 升到 `0.1.1`。

- 不复用已经发布的标签或版本号。
- 不降低版本号覆盖旧版本。
- 不替换同一版本的签名资产来规避升级规则。

## 8. Authenticode 与更新签名

Tauri 更新签名用于让 Mora 验证下载的更新包没有被替换；它不是 Windows Authenticode。未配置 Authenticode 时，Windows 仍可能显示“未知发布者”。

后续取得可信代码签名证书后，应在发布流水线中单独配置 Windows 代码签名，再验证 MSI、NSIS 和自动更新产物。不要把证书私钥与 `TAURI_SIGNING_PRIVATE_KEY` 混用，也不要因为增加 Authenticode 而移除 Tauri 更新签名。
