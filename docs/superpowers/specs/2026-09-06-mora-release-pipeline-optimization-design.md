# Mora 发布流水线优化设计

**日期：** 2026-09-06

**状态：** 已批准

## 背景与目标

`app-v0.1.2` 从第一次发布流水线到正式公开耗时 11 小时 7 分。最终成功流水线只耗时约 60 分钟，主要可控问题是发布门禁只在标签触发后运行、四个平台因共享 `latest.json` 串行构建，以及产物完整性直到人工审核时才被发现。

本次目标是：

1. 在普通提交和 Pull Request 阶段提前运行通用质量门禁。
2. 并行构建 Windows x64、macOS Apple Silicon、macOS Intel 和 Linux x64。
3. 所有平台成功后，由单一汇总任务校验资产、生成 `latest.json` 并创建 Draft Release。
4. 保持人工公开 Release，不修改 `app-v0.1.2`，不创建新版本标签。

## 方案比较

### 方案 A：矩阵任务并发写同一个 Draft Release

改动最少，但多个 `tauri-action` 会并发创建或更新同一个 Release；即使关闭各自的 `latest.json` 上传，也会把不完整中间产物暴露到 Draft，并增加重试和清理复杂度。不采用。

### 方案 B：并行构建 Actions Artifact，单任务汇总发布

每个平台只构建并上传 GitHub Actions Artifact，不直接修改 Release。汇总任务下载全部 Artifact，验证后一次性创建 Draft Release。该方案隔离构建和发布职责，只有完整产物集才能进入 Draft，采用此方案。

### 方案 C：保留串行发布，仅优化缓存

风险最低，但关键路径仍是四个平台耗时相加，无法解决发布耗时持续超过 60 分钟的问题。不采用。

## 当前必须实现

### 1. 日常 CI

新增 `.github/workflows/ci.yml`，在以下事件运行：

- 向 `master` 推送。
- 针对 `master` 的 Pull Request。

CI 在 Ubuntu 上执行当前 `verify` 的质量门禁：依赖安装、版本文件一致性、前端测试、Lint、格式、前端构建、Agent sidecar 准备、Rust 测试和 Rust 检查。日常 CI 不要求发布标签一致，发布标签校验仍只属于发布工作流。

### 2. 并行平台构建

保留 `publish.yml` 的 `verify` 前置任务，删除 `max-parallel: 1`。四个平台构建任务继续使用原生 Runner 和现有 bundles：

| 平台                | Runner           | Rust target                | Bundles        |
| ------------------- | ---------------- | -------------------------- | -------------- |
| Windows x64         | `windows-latest` | `x86_64-pc-windows-msvc`   | `nsis,msi`     |
| macOS Apple Silicon | `macos-latest`   | `aarch64-apple-darwin`     | `app,dmg`      |
| macOS Intel         | `macos-latest`   | `x86_64-apple-darwin`      | `app,dmg`      |
| Linux x64           | `ubuntu-22.04`   | `x86_64-unknown-linux-gnu` | `appimage,deb` |

矩阵中的 `tauri-action` 不设置 `tagName`、`releaseName` 或 `releaseId`，因此只构建、不创建 Release。构建完成后使用 `actions/upload-artifact` 上传 bundle 文件和 updater 签名，Artifact 名称包含目标平台，避免文件混淆。

### 3. 发布资产汇总器

新增一个无第三方运行时依赖的 Node.js 脚本，职责限定为：

1. 递归读取下载后的平台产物目录。
2. 按仓库版本验证每个必要安装包、updater 包和 `.sig` 恰好存在一份。
3. 拒绝未知版本、重复匹配、空签名或缺少平台的资产集合。
4. 使用 `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` 生成 updater URL。
5. 生成覆盖 Windows NSIS/MSI、macOS ARM/Intel 和 Linux AppImage/Deb 的 `latest.json`。
6. 输出最终 Release notes，由安装说明和 GitHub 自动生成的变更记录组成。

脚本只处理已生成文件，不调用 GitHub API，不持有签名私钥。其输入、输出和错误均可通过 Node 内置测试框架本地验证。

### 4. 单一 Draft 发布任务

新增 `release` Job，`needs` 指向全部平台矩阵结果，并执行：

1. 下载和合并所有 Actions Artifact。
2. 调用 GitHub Release Notes API 生成版本变更记录。
3. 运行资产汇总器；任何校验失败立即停止，不创建 Draft。
4. 不存在同标签 Release 时，使用 `gh release create --draft --verify-tag` 创建 Draft；同标签 Draft 已存在且目标提交一致时复用该 Draft。
5. 使用 `gh release upload --clobber` 上传经校验的资产和 `latest.json`，使上传中断后的同一工作流可以安全重跑。

公开 Release 仍由发布者审核后手动执行。构建失败时不会留下新的不完整 Draft。

## 错误处理与重跑

- 日常 CI 失败：阻止把问题推迟到发布阶段。
- 任一平台失败：汇总 Job 不运行，不创建 Draft。
- Artifact 缺失、重复、版本不符或签名为空：汇总脚本失败，不创建 Draft。
- 同标签 Draft 已存在且目标提交一致：复用 Draft 并覆盖同名资产；提交不一致或 Release 已公开时明确失败。
- 上传中断：保留 Draft 供同标签、同提交的工作流重跑；人工公开前仍必须通过完整资产审核。
- GitHub API 或上传瞬时失败：由 `gh` 命令和 Job 重跑处理；不在脚本内实现通用重试框架。

## 测试与验收

### 自动化测试

- 先为资产汇总器编写失败测试，覆盖完整资产集、缺失资产、重复资产、错误版本、空签名和 URL 编码。
- 更新发布工作流契约测试，要求并行矩阵、Workflow Artifact、单独汇总 Job、Draft 边界和禁止矩阵直接写 Release。
- 增加日常 CI 契约测试，确认 push/PR 触发和质量门禁。

### 本地验证

按仓库规则运行：

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run build:exe`

同时运行相关 Node/Vitest 测试、Lint、格式检查和 `git diff --check`。正式安装包构建只在发布代码本身影响应用打包时执行；本次工作流改造仍需在后续测试标签或下一个正式版本的 GitHub-hosted Runner 上完成跨平台实证。

## 仅在指标不达标时增加

- 若并行化后发布流水线仍持续超过 45 分钟，再让发布 Job 复用已准备的 release sidecar，减少 debug/release 双 profile 构建。
- 若 GitHub-hosted Runner 排队成为主要耗时，再评估自托管 Runner；本次不引入。

## 本次不实现

- 自动公开 Release。
- 自动创建或推送标签。
- 修改 `app-v0.1.2` 或重新上传其资产。
- Apple Developer 公证、Windows Authenticode、新平台或新安装包格式。
- 自建制品库、更新服务器、灰度发布和通用发布框架。

## 删减检查

| 新增项             | 必要性                                          | 删除后的验收失败                    |
| ------------------ | ----------------------------------------------- | ----------------------------------- |
| `ci.yml`           | 在标签发布前发现通用测试问题                    | Unix/Agent 回归仍只能在发布时发现   |
| 并行平台构建       | 将关键路径从平台耗时之和降为最大单个平台耗时    | 发布仍持续超过 60 分钟              |
| Actions Artifact   | 隔离并行构建与 Release 写入                     | 多任务并发写 Release 或无法汇总     |
| 资产汇总脚本       | 在创建 Draft 前验证资产并生成唯一 `latest.json` | 可能发布缺平台或错误 updater 元数据 |
| 单一 `release` Job | 保证只有完整资产集写入 GitHub Release           | 并发写入和不完整 Draft 风险保留     |

没有新增服务、守护进程、依赖库、插件协议或发布数据库。

## 参考资料

- https://github.com/tauri-apps/tauri-action
- https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts
- https://cli.github.com/manual/gh_release_create
