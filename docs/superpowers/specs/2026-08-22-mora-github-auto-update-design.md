# Mora GitHub Releases 自动更新设计

**日期：** 2026-08-22
**状态：** 已批准
**范围：** Windows 桌面版首次正式发布、GitHub Releases 自动更新、当前版本文档收敛

## 目标

1. 使用 Tauri 2 官方 updater，从 `windzhu0514/mdx` 的 GitHub Releases 检查、下载并安装可信更新。
2. 应用启动后静默检查一次；用户也可以从“关于”菜单主动检查。
3. 发现更新后由用户明确确认下载；安装前必须通过 Mora 现有的多文档未保存保护。
4. 使用 GitHub Actions 生成 Windows MSI、NSIS、更新签名和 `latest.json`，先创建 Draft Release，人工确认后发布。
5. 收敛当前功能清单和发布文档，避免已实现功能继续显示为待办。

## 非目标

- 本次不购买或配置 Windows Authenticode 商业代码签名证书；安装包可能显示“未知发布者”。
- 不自动推送 Git 标签、不自动发布 Draft Release、不代替用户修改 GitHub Secrets。
- 不新增动态更新服务器、更新渠道系统、灰度发布、回滚协议或强制更新。
- 不扩展 Linux、macOS、移动端发布。
- 不修改 `.mdx` 文件格式、保存流程或编辑器内核。

## 方案比较

### 方案 A：Tauri 官方 updater + GitHub Releases（采用）

使用官方 updater/process 插件，GitHub Actions 通过 `tauri-action` 生成签名产物和静态更新清单。

- 优点：组件最少；与现有 GitHub 远端一致；不维护服务器；Tauri 原生校验更新签名。
- 缺点：依赖 GitHub 可访问性；静态清单不支持复杂灰度和服务端回滚。

### 方案 B：自建动态更新服务

- 优点：可按渠道、设备和版本动态控制更新。
- 缺点：新增服务、部署、鉴权、监控和可用性责任，当前没有已确认需求支持这些成本。

### 方案 C：先进入 Microsoft Store

- 优点：商店承担部分分发与更新体验。
- 缺点：引入商店打包、审核和发布边界，偏离当前 GitHub Releases 方向。

## 客户端设计

### 组件边界

- `src/composables/useAppUpdater.ts`
  - 持有更新状态和官方 `Update` 对象。
  - 负责检查、下载、安装、进度和错误转换。
  - 防止重复检查、重复下载和重复安装。
- `src/components/UpdateDialog.vue`
  - 只渲染版本、发布日期、说明、进度、错误和操作按钮。
  - 不直接调用 Tauri API，不拥有文档离开决策。
- `src/App.vue`
  - 在“关于”菜单暴露“检查更新”。
  - 启动后触发一次静默检查。
  - 在安装前调用现有多文档离开保护；只有保护成功才允许安装和重启。

不创建 updater 接口、工厂、注册中心或自定义 Rust 更新命令。官方 JavaScript API 已满足单一实现需求。

### 状态

更新状态限定为：

- `idle`：未执行操作。
- `checking`：正在请求 `latest.json`。
- `available`：发现新版本，等待用户操作。
- `downloading`：正在下载，记录已下载字节和总字节。
- `downloaded`：下载完成，等待文档离开保护和安装。
- `installing`：正在安装，禁止重复操作。
- `error`：手动操作或下载/安装失败，可重试。

“没有更新”不是持久状态：手动检查通过状态消息反馈，随后回到 `idle`；后台检查无更新直接回到 `idle`。

### 数据流

1. `App.vue` 挂载后，在真实 Tauri 环境调用静默检查；Web 预览跳过。
2. updater 请求 `https://github.com/windzhu0514/mdx/releases/latest/download/latest.json`。
3. 没有更新时静默结束；手动检查显示“已是最新版”。
4. 发现更新时打开更新对话框，显示 `version`、`date` 和 `body`。
5. 用户点击“下载更新”，调用 `Update.download()` 并更新进度。
6. 下载完成后，`App.vue` 执行现有多文档保存／放弃／取消流程。
7. 任一保存失败或用户取消时保持已下载状态，不安装、不重启。
8. 离开保护成功后以阻塞遮罩禁止新编辑，调用 `Update.install()`，成功后调用 process 插件 `relaunch()`。

安装和重启绝不在后台检查阶段自动发生。

### 错误处理

- 后台检查失败：恢复 `idle`，不弹窗、不覆盖编辑状态，只记录可诊断警告。
- 手动检查失败：显示简洁错误并允许重试。
- 下载失败：保留更新元数据，用户可重试下载。
- 离开保护取消或保存失败：不安装，关闭阻塞态，保留当前文档。
- 安装失败：显示错误，不调用重启。
- 重启失败：显示“更新已安装，请手动重启”，避免再次安装。

## Tauri 配置

新增官方依赖：

- Rust：`tauri-plugin-updater`、`tauri-plugin-process`
- 前端：`@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`

初始化两个插件，并在 `src-tauri/capabilities/default.json` 仅开放：

- updater 检查、下载和安装所需默认权限。
- process 重启权限。

`tauri.conf.json` 配置：

- `bundle.createUpdaterArtifacts: true`
- GitHub `latest.json` HTTPS endpoint
- Tauri signer 生成的公钥内容
- Windows `installMode: "passive"`

不允许 HTTP endpoint，不在运行时覆盖签名公钥。

## 发布与版本设计

### 版本来源

发布前必须保证以下四项一致：

- Git 标签：`app-vX.Y.Z`
- `package.json.version`
- `src-tauri/Cargo.toml` 的 package version
- `src-tauri/tauri.conf.json.version`

新增一个 Node 版本检查脚本，供本地和 CI 共用。标签存在时还要验证标签版本相同。失败时在构建前终止。

### GitHub Actions

新增 Windows-only 发布工作流：

1. `app-v*` 标签推送或手动触发。
2. Checkout、Node LTS、Rust stable 和缓存。
3. `npm ci`。
4. 版本一致性检查。
5. `npm test`、`npm run lint`、`npm run format:check`、`npm run build`。
6. `cargo test` 与 `cargo check`。
7. `tauri-apps/tauri-action` 构建 MSI、NSIS、`.sig` 和 `latest.json`。
8. 使用 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets。
9. 创建 Draft Release，人工确认后发布。

### 密钥

- 本地私钥默认保存到 `C:\Users\ljc01\.tauri\mora-updater.key`，仓库只保存公钥。
- 私钥不得出现在命令输出、Git、日志、文档示例值或持久化映射中。
- 私钥必须由用户另行安全备份；遗失后不能向既有安装发布可信更新。
- GitHub Secrets 的实际写入需要用户另行授权。

## 文档收敛

- 更新 `TODO.md`：把 Word、主题、命令面板、Mermaid、AI 和独立 PDF 导出标为已完成；修正 `Wod` 拼写；自动更新在实现后标为完成。
- 更新 `README.md`：修正 PDF 描述，补充当前更新行为、发布状态和未知发布者说明。
- 新增 `docs/RELEASE.md`：记录密钥备份、Secrets、版本提升、标签、Draft 检查、发布以及故障版本处理。

## 测试与验收

### 自动化

- composable：无更新、发现更新、静默错误、手动错误、下载进度、下载失败、安装失败、重启失败和并发保护。
- 对话框：元数据、按钮状态、进度和错误呈现。
- App 集成：启动静默检查、菜单手动检查、离开保护取消、保存失败、安装成功后重启。
- 配置：插件权限、HTTPS endpoint、公钥非占位符、更新产物开关和发布版本一致性。
- 完整门禁：前端测试、Lint、格式、前端构建、Rust 测试、Cargo 检查、EXE 构建和正式 Tauri 构建。

### 签名产物

使用本地更新私钥执行正式构建，确认 MSI/NSIS 更新产物及对应 `.sig` 存在。`latest.json` 由 GitHub Action 在真实 Draft Release 构建中最终验证。

### 人工验收

- 无更新、网络失败和发现更新三种检查结果。
- 下载进度、失败重试和稍后处理。
- 多个脏文档的保存、放弃、取消和保存失败。
- 安装成功后的应用重启。
- Draft Release 人工检查后发布，旧版本能够发现新版本。

## 删减检查

| 新增项 | 解决的已确认需求 | 现有组件不能直接承担的原因 | 删除后的失败项 |
| --- | --- | --- | --- |
| `useAppUpdater.ts` | 更新异步状态、下载进度和并发保护 | `App.vue` 已承担文档、菜单和工作区编排；继续内联会把独立生命周期混入主状态 | 无法隔离测试更新状态和错误路径 |
| `UpdateDialog.vue` | 展示更新详情与进度 | 现有对话框均面向其他业务，复用会混淆语义 | 用户无法确认、观察或重试更新 |
| 版本检查脚本 | 阻止标签和三处版本漂移 | Tauri 构建只读取配置，不验证整个仓库的发布一致性 | 可能发布错误版本或生成错误更新清单 |
| GitHub 工作流 | 可重复地产出签名安装包和更新清单 | 本地构建不能自动生成 GitHub Release `latest.json` | 自动更新没有可信发布源 |
| `docs/RELEASE.md` | 保存密钥和发布操作边界 | README 面向使用者，不适合承载敏感发布流程 | 发布者容易丢密钥或漏配 Secrets |

不增加动态服务器、数据库、更新渠道抽象、强制更新策略或 Authenticode 自动分支。只有出现灰度发布、私有下载鉴权或 GitHub 可用性不达标等可测问题时，才重新评估动态更新服务。

## 参考资料

- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [Tauri Process](https://v2.tauri.app/plugin/process/)
- [Tauri GitHub 发布流水线](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri Windows 代码签名](https://v2.tauri.app/distribute/sign/windows/)
