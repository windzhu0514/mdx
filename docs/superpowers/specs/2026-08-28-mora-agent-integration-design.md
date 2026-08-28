# Mora Agent 实时读写与 MCP 接入设计

**日期：** 2026-08-28

**状态：** 待用户审阅

**范围：** 本地 Agent 对 Mora 当前文档的读写、CLI、MCP、外部文件变更同步

## 1. 目标

让本机 Agent 能安全地读取和修改 Mora 中的文档，包括尚未保存到磁盘的正文，并让修改立即反映到编辑器。首版同时提供：

- 面向脚本和通用 Agent 的 CLI。
- 面向支持 Model Context Protocol 的客户端的 MCP stdio 服务。
- 对其他程序直接修改 `.mdx` 文件的自动感知。
- 明确的版本冲突检测，避免覆盖用户或另一 Agent 的新修改。

## 2. 已确认决策

1. **实时状态以 Mora 当前内存文档为准。** Agent 可读取未保存内容；Agent 写入后立即更新当前编辑器并标记文档为未保存。
2. **默认不开放网络端口。** Mora 使用 Windows Named Pipe；macOS/Linux 使用 Unix Domain Socket。
3. **Agent 接入默认关闭。** 用户在设置中显式开启后，Mora 才创建本地 IPC 端点。
4. **只增加一个可执行文件。** 现有 GUI 为 `mora.exe`；新增控制台程序为 Windows 的 `mora-agent.exe`、macOS/Linux 的 `mora-agent`。
5. **CLI 与 MCP 共用同一实现。** `mora-agent mcp` 以 stdio 运行 MCP Server，不增加 `mora-mcp.exe`。
6. **首版不引入 CRDT、协同服务器或第二份正文状态。** 使用乐观并发控制处理多写者冲突。
7. **正常同步由事件驱动。** 仅在文件监视器失效或平台事件不可靠时才启用低频轮询回退。

## 3. 当前基础与缺口

Mora 当前已有以下能力：

- `useDocumentSession` 持有打开文档的规范 Markdown、脏状态、磁盘版本和冲突状态。
- Rust 后端负责 `.mdx` 校验、读取和 `.tmp` + `.bak` 安全保存。
- 窗口重新获得焦点时检查磁盘版本：干净文档可重载，脏文档进入冲突状态。

当前缺口是：外部进程无法访问渲染进程中的未保存正文；磁盘变更只在焦点切换时检查；CLI 和 MCP 都没有稳定的本地协议入口。

## 4. 最小架构

```text
Agent / 脚本 / MCP Client
          |
          | CLI 参数或 MCP stdio
          v
   mora-agent(.exe)
          |
          | 本机 IPC（带版本的请求/响应）
          v
  Mora Rust Agent Bridge
          |
          | Tauri 事件与关联请求
          v
 Vue useDocumentSession
   （唯一权威正文）
          |
          | 显式保存
          v
 Rust 现有 MDX 安全保存
```

### 4.1 Mora Agent Bridge

Agent Bridge 位于现有 Mora GUI 进程的 Rust 后端，职责仅为：

- 根据设置创建或关闭本地 IPC 端点。
- 校验协议版本、请求大小、连接身份和超时。
- 将请求转交给前端当前文档会话，并按请求 ID 返回结果。
- 串行提交写操作，广播轻量级文档版本变更事件。

它不保存第二份正文，不实现编辑器逻辑，也不直接修改前端 DOM。

### 4.2 前端会话适配

前端通过公开的会话方法处理 Agent 请求：

- 列出当前打开的文档及其基本状态。
- 返回规范 Markdown 和当前实时版本。
- 在版本匹配时替换正文，走与用户编辑相同的规范化、脏状态和草稿流程。
- 调用现有保存能力，并返回新的磁盘版本。

Blob URL 仍只用于编辑器资源投影；Agent 读取和写入的 Markdown 必须保留 `assets/...`、`attachments/...` 相对路径。

### 4.3 `mora-agent`

`mora-agent` 是无 GUI 的控制台二进制，包含两个薄适配层：

- CLI：解析参数，将结果以稳定 JSON 输出到 stdout，日志写入 stderr。
- MCP：在 stdio 上实现 MCP 初始化、工具发现和工具调用，再调用同一个 IPC 客户端核心。

CLI 与 MCP 不包含 MDX 业务逻辑，也不绕过 Mora 直接写入已打开的文档。

## 5. 文档标识与版本模型

### 5.1 文档标识

实时 API 使用 Mora 当前会话分配的 `documentId`。列表结果同时返回路径、标题、是否脏、是否冲突等信息。路径用于展示和筛选，但调用方应使用 `documentId` 消除同名歧义。

### 5.2 两类版本

- `liveRevision`：应用会话 UUID 加单调递增序号，例如 `8f...:42`。任何正文修改都会递增，包括用户输入、Agent 写入和外部磁盘重载。Mora 重启后旧值自动失效。
- `diskRevision`：沿用当前磁盘版本，用于检测保存目标是否被外部修改。

Agent 的替换请求必须携带上次读取到的 `baseLiveRevision`。版本不一致时返回 `REVISION_CONFLICT`，调用方必须重新读取并自行合并或重试。所有写请求在 Mora 内串行执行，因此不会出现两个请求都基于同一旧版本成功覆盖的情况。

首版采用全文读取和全文替换。只有当实测典型文档超过 5 MiB，或本机 P95 读写延迟超过 100 ms 时，才评估增量 patch；不提前引入 OT/CRDT。

## 6. 数据流

### 6.1 读取未保存内容

1. Agent 调用 CLI 或 MCP 工具。
2. `mora-agent` 连接当前用户的 Mora IPC 端点。
3. Agent Bridge 将读取请求发送给前端文档会话。
4. 前端返回规范 Markdown、元数据摘要、`liveRevision` 和 `diskRevision`。
5. Bridge 原样返回结构化结果，不写磁盘。

### 6.2 Agent 实时写入

1. Agent 先读取文档并取得 `liveRevision`。
2. Agent 提交完整 Markdown 和 `baseLiveRevision`。
3. 前端再次比较版本；不一致则拒绝。
4. 版本一致时，通过文档会话更新规范正文。
5. 编辑器立即显示新内容，文档进入脏状态，草稿机制照常工作，`liveRevision` 递增。
6. 写入响应返回新版本。此操作默认**不自动保存**。

将“修改内存”和“保存磁盘”分开，能让用户审阅 Agent 改动，并避免每次流式修改都重打包 ZIP。

### 6.3 显式保存

Agent 可单独调用保存。保存继续使用现有 `.tmp` + `.bak` 流程，并以 `diskRevision` 阻止覆盖外部新版本。保存成功只更新磁盘状态，不另建 Agent 专用保存路径。

### 6.4 Mora 未运行或接入关闭

首版 CLI/MCP 只操作正在 Mora 中打开的文档，不提供离线 `.mdx` 修改模式：

- Mora 未运行：返回 `MORA_NOT_RUNNING`。
- Agent 接入关闭：返回 `AGENT_ACCESS_DISABLED` 或无法发现端点。
- 文档未打开：返回 `DOCUMENT_NOT_OPEN`。

这能确保同一文件只有 Mora 的校验、资源保留和安全保存路径，不产生绕过会话状态的第二套写入实现。普通 Agent 仍可使用其已有文件工具直接操作磁盘，但 Mora 会按第 9 节处理这类外部改动。

## 7. CLI 与 MCP 表面

### 7.1 CLI

首版命令：

```text
mora-agent status --json
mora-agent list --json
mora-agent read <document-id> --json
mora-agent replace <document-id> --base-revision <revision> --content-file <path|-> --json
mora-agent save <document-id> --base-revision <revision> --json
mora-agent watch [<document-id>] --jsonl
mora-agent mcp
```

约束：

- 机器可读数据只写 stdout；诊断日志只写 stderr。
- `replace` 使用文件或 stdin 接收正文，避免把大型内容和敏感文本放入进程参数。
- `watch` 只推送文档 ID、版本、脏状态和变更来源，不主动重复发送全文。
- 稳定错误码同时映射到非零退出码。

### 7.2 MCP 工具

`mora-agent mcp` 首版暴露：

- `mora_list_documents`
- `mora_read_document`
- `mora_replace_document`
- `mora_save_document`

MCP 首版不实现持续订阅工具；Agent 需要新版本时重新读取。CLI `watch` 保留给脚本和需要持续事件流的集成。MCP 的工具实现必须调用与 CLI 相同的 IPC 客户端方法。

## 8. 设置、权限与可见性

新增布尔设置 `agentAccessEnabled`，默认值为 `false`，持久化到现有 Mora 偏好设置。设置界面新增“本地 Agent 接入”区：

- 开关开启时显示本地接入已启用、CLI 路径和当前连接数。
- 首次开启说明：同一系统用户运行的程序可读取和修改当前打开文档，包括未保存内容。
- 关闭时立即停止监听并断开现有客户端。
- 提供复制 MCP 配置示例的操作，但不自动修改第三方客户端配置。

安全边界：

- Windows Named Pipe 的 ACL 仅允许当前登录用户；Unix socket 权限为 `0600`。
- 端点名称包含当前用户范围和实例标识；禁止绑定 `0.0.0.0` 或暴露局域网。
- 实时接口只接受 Mora 已打开的 `documentId`，不接受任意文件系统输出路径。
- 设置最大请求体、最大并发连接、请求超时和协议版本。
- 日志不得记录正文、API 密钥或完整敏感路径。
- 开关只能控制 Mora 的内存接口，不能阻止同一用户下其他进程直接访问其本来就有权限读取的文件。

首版不增加每次写入弹窗确认。可见性通过设置状态、连接数和短暂的“Agent 已修改”提示提供；冲突依靠版本检查保证数据安全。

## 9. 外部磁盘变更同步

CLI/MCP 实时写入走内存接口；其他编辑器或命令行直接修改 `.mdx` 时走文件监视器：

1. 监视已打开文档的父目录，而不是只监视旧 inode，兼容 `.tmp` 原子替换和重命名。
2. 文件事件经 100–200 ms 防抖后检查目标的稳定性和磁盘版本。
3. 只有在 ZIP 写入完成且能通过 Mora 格式校验后才处理；短暂不完整状态进行有限重试。
4. 当前文档干净时自动重载并递增 `liveRevision`。
5. 当前文档为脏时不覆盖内存，进入现有冲突流程。
6. Mora 自己保存产生的事件通过预期磁盘版本抑制回声。
7. 文件监视器报错或平台事件丢失时，才对已打开文档启用约 1 秒低频轮询；窗口聚焦检查继续作为最终兜底。

这与 VS Code、Zed 等编辑器的合理行为一致：外部改动自动感知，但不会静默覆盖本地未保存编辑。

## 10. IPC 协议

IPC 使用版本化、长度前缀 JSON 帧，避免 Markdown 中的换行或任意字符破坏消息边界。每条请求包含：

- `protocolVersion`
- `requestId`
- `method`
- `params`

每条响应包含相同 `requestId`，以及 `result` 或稳定的 `error.code`、`error.message`、可选冲突详情。协议首版为 `1`；不兼容版本必须明确拒绝。

稳定错误码至少包括：

- `AGENT_ACCESS_DISABLED`
- `MORA_NOT_RUNNING`
- `BRIDGE_UNAVAILABLE`
- `DOCUMENT_NOT_FOUND`
- `DOCUMENT_NOT_OPEN`
- `REVISION_CONFLICT`
- `DISK_CONFLICT`
- `INVALID_MDX`
- `REQUEST_TOO_LARGE`
- `PERMISSION_DENIED`
- `TIMEOUT`

## 11. 构建与分发

- GUI 二进制保持 `mora.exe` / `mora`。
- 新增 `mora-agent.exe` / `mora-agent`，与 GUI 一同进入安装包。
- 不新增常驻服务、不注册系统服务、不自动启动后台进程。
- 安装器首版不自动修改用户 `PATH`，避免污染环境和卸载残留；设置页提供准确路径与配置示例。
- 开发构建和发布校验必须同时确认两个二进制可运行。
- MCP 客户端配置直接把命令指向 `mora-agent mcp`，不需要额外端口或守护进程。

## 12. 验收标准

### 12.1 功能

- 默认安装后 Agent 接入关闭，且没有 IPC 监听端点。
- 开启后，CLI 能列出文档并读到尚未保存的最新正文。
- Agent 使用正确版本替换正文后，WYSIWYG/源码视图立即显示修改，文档标记为脏。
- 使用旧版本写入必定返回 `REVISION_CONFLICT`，原内容不变。
- Agent 显式保存后，重新打开 `.mdx` 内容正确，已有资源目录保持不丢失。
- MCP 客户端可完成 initialize、tools/list、tools/call，并得到与 CLI 一致的结果。
- 多客户端并发写入时最多一个基于同一旧版本的请求成功。
- 关闭开关后现有连接断开，后续调用不能访问内存内容。
- 外部程序原子替换磁盘文件时，干净文档自动重载；脏文档进入冲突状态。

### 12.2 安全与稳定性

- 其他系统用户不能连接 IPC 端点。
- 超大请求、协议版本错误和超时不会卡死 GUI。
- Agent 进程异常退出不影响 Mora 编辑与保存。
- Mora 退出后 IPC 端点不残留为可用状态。
- 日志与错误输出不包含正文。

### 12.3 验证

实现阶段至少覆盖：

- Rust 协议编解码、ACL/权限、并发版本检查和 IPC 集成测试。
- 前端会话的读取、替换、脏状态、草稿、冲突和设置持久化测试。
- CLI JSON/JSONL、stdin、退出码测试。
- MCP stdio 协议测试。
- 外部原子替换、无效 ZIP、中途写入、内部保存回声抑制测试。
- Windows、macOS、Linux 安装包中的双二进制存在性与启动验证。
- 仓库规定的 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run build:exe`。

## 13. 当前必须、指标触发后增加、本次不实现

### 当前必须实现

- Agent 开关与连接状态。
- 跨平台本机 IPC。
- `mora-agent` CLI 和 MCP stdio。
- 打开文档的实时读、带版本替换、显式保存。
- 外部文件事件监视及脏文档冲突保护。
- 权限、大小、超时和稳定错误码。

### 仅在指标不达标时增加

- 文本 patch：典型文档大于 5 MiB 或 P95 全文读写超过 100 ms。
- 轮询常驻回退：平台监视器在测试中存在可复现的漏事件；正常路径仍保持事件驱动。
- 更细粒度写入授权：出现用户明确需要的安全场景后，再增加只读模式或逐 Agent 权限。

### 本次不实现

- HTTP/Streamable HTTP、局域网或远程接入。
- CRDT、OT、字符级多人光标和实时协同 UI。
- 独立 Agent 文档副本、第二套 Markdown 状态或第二套保存器。
- Agent 对资源、附件和归档内部文件的增删改 API。
- 离线 `.mdx` 编辑模式。
- 自动修改第三方 MCP 配置、自动加入 `PATH`、系统服务或开机启动。

## 14. 删减检查

| 新增部分 | 解决的已确认需求 | 删除后的直接失败 |
| --- | --- | --- |
| Agent Bridge | 将外部进程连接到 Mora 内存状态 | 无法读取未保存内容或实时写回 |
| 前端会话适配 | 复用唯一正文、脏状态与草稿流程 | 会产生第二份状态或绕过编辑器规则 |
| `mora-agent` | 提供 CLI 和 MCP 的控制台入口 | Agent 无稳定可调用接口 |
| MCP 适配层 | 满足已确认的 MCP 客户端接入 | MCP 客户端无法自动发现和调用工具 |
| 文件监视器 | 感知绕过 IPC 的外部文件改动 | Mora 只能在重新聚焦时发现变化 |
| 双版本检查 | 防止实时写和磁盘保存互相覆盖 | 并发 Agent 或外部编辑可能丢数据 |

不单独增加 MCP 二进制、HTTP 服务、守护进程、插件注册中心、抽象工厂、同步数据库或 CRDT；这些组件都无法对应当前必须验收项。

## 15. 实施顺序

1. 抽取可复用的协议类型和文档会话 Agent 方法，先用测试锁定版本语义。
2. 实现 GUI 内 Agent Bridge 与开关生命周期、权限和超时。
3. 实现 `mora-agent` IPC 客户端及 CLI。
4. 在同一二进制中增加 MCP stdio 适配。
5. 增加外部文件监视、回声抑制与轮询兜底。
6. 完成设置 UI、连接可见性、安装包和跨平台验证。

实际 IPC 库的选择留到实施计划阶段，通过 Windows Named Pipe ACL、Unix socket 权限和 Tauri 运行时兼容性的小型验证后确定；这不会改变上述协议与组件边界。
