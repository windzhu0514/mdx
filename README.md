# Mora 墨笺

> 像 Word 一样完整交付，像 Markdown 一样开放可读。

Mora 墨笺是一款本地优先的桌面笔记软件。它把 Markdown 正文、图片和附件封装在一个 `.mdx` 文件中，让一篇笔记既能像 Word 文档一样独立保存和传递，又保留 Markdown 的透明结构与可迁移性。

> **当前版本：** `app-v0.1.2`，提供 Windows x64、macOS Apple Silicon/Intel 和 Linux x64 安装包。

## 为什么需要 Mora

Word 擅长把内容和图片放进一个文档，Markdown 则胜在简单、开放和便于复用。常见 Markdown 笔记的问题是：正文只有一个 `.md` 文件，图片和附件却散落在旁边的目录或远程地址中。移动、备份或发送笔记时，必须同时维护整套路径结构。

Mora 希望在两者之间取得一个明确的平衡：**不复制 Word 的复杂排版，而是让 Markdown 获得完整的单文件交付能力。**

| 对比维度                   | Word 文档（`.docx`）                       | 常见 Markdown 笔记                 | Mora（`.mdx`）                           |
| -------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------------- |
| 文档结构                   | ZIP 容器中的 Office Open XML 与媒体资源    | 纯文本正文，资源通常独立存放       | ZIP 容器中的标准 `content.md` 与资源目录 |
| 是否能单文件携带图片和附件 | 图片可以内嵌；附件可通过链接或嵌入对象处理 | 通常需要同时携带资源目录           | 正文、图片和附件明确封装在同一个文件中   |
| 解包后的可读性             | 主要内容是 XML，需要兼容软件解释           | 正文可直接阅读，但外部资源可能缺失 | 可直接得到 Markdown 正文、图片和附件     |
| 主要目标                   | 复杂排版、页面布局和办公文档               | 轻量写作与文本可移植性             | Markdown 写作与完整文档交付              |

## 一篇笔记就是一个完整文件

Mora 使用自定义的 **MDXNote** 格式。这里的 `.mdx` 与 Web 开发中的 Markdown + JSX 无关，它本质上是一个结构明确的 ZIP 笔记包：

```text
note.mdx
├── manifest.json
├── meta.json
├── content.md
├── assets/          # 图片
├── attachments/     # 附件
├── thumbnails/      # 缩略图
└── history/         # 历史快照，可选
```

正文始终使用包内相对路径引用资源：

```markdown
![图片](assets/image.png)
[附件](attachments/file.pdf)
```

因此，即使将 `.mdx` 解压，`content.md` 仍然可以找到对应的图片和附件。

## Mora 重点解决的事情

- **笔记与资源不分家：** 粘贴图片、选择附件或拖入文件后，资源随笔记一同保存，不需要手动整理配套目录。
- **文件归用户管理：** 笔记保存在用户选择的位置，可以使用现有的文件夹、移动硬盘和备份工具管理。
- **保留 Markdown 出入口：** 可以导入 `.md`、`.markdown`，也可以导出 Markdown 正文和资源目录。
- **降低保存失败的损失：** 使用 `.tmp + .bak` 安全保存，并提供未保存保护、恢复草稿和历史快照。
- **谨慎处理外部变化：** 磁盘文件被其他程序修改时，根据当前编辑状态自动重新载入或提示用户选择。
- **工作区批量索引：** 打开、恢复或刷新工作区时扫描其中的 `.md` 与 `.mdx`，后续只重新解析新增或已变化的文件，并从搜索索引中移除已删除文件。
- **按用户决定更新：** 正式桌面版从 GitHub Releases 检查签名更新，只在用户确认后下载、安装和重启。

## 适合谁

- 笔记中经常包含截图、参考图片、PDF 或其他资料，希望一个文件即可完整保存。
- 重视本地文件所有权，希望自己决定笔记放在哪里、如何备份和迁移。
- 喜欢 Markdown 的简洁结构，但不想长期维护正文与资源目录之间的路径关系。
- 需要整理会议记录、研究资料、教程、项目文档或个人知识档案。

## 数据与隐私

笔记正文、图片和附件保存在用户选择的 `.mdx` 文件中。恢复草稿、最近打开记录和工作区全文搜索索引保存在 Mora 的应用数据目录中。索引刷新由打开工作区、窗口重新获得焦点或用户手动刷新触发，不会持续监听磁盘。

Mora 不要求登录，也不会为了保存笔记而上传文档。AI 功能是可选的：只有用户主动调用 AI 时，当前 Markdown 文档、选区和指令才会发送到用户配置的 OpenAI-compatible 服务；API Key 保存在系统凭据存储中。

## 本地 Agent 接入

本地 Agent 接入默认关闭。需要使用时，在 **设置 → Agent** 中显式开启“本地 Agent 接入”，并从同一页面复制安装后 `mora-agent` 的绝对路径。Mora 使用当前用户专属的本地 IPC（Windows Named Pipe；macOS/Linux 为 Unix Domain Socket），不是 HTTP 服务，不监听网络端口，也不需要常驻 daemon。

CLI 与 MCP 共用同一个 Windows `mora-agent.exe` 或 macOS/Linux `mora-agent`；没有单独的 `mora-mcp` 程序。开启接入后可执行：

```text
mora-agent status --json
mora-agent list --json
mora-agent read <document-id> --json
mora-agent replace <document-id> --base-revision <revision> --content-file - --json
mora-agent save <document-id> --base-revision <revision> --json
mora-agent watch [<document-id>] --jsonl
mora-agent mcp
```

`list` 返回当前已打开文档及其不透明 `liveRevision`。`read` 读取 Mora 内存中的最新正文，包括尚未保存的编辑；`replace` 只有在 `base-revision` 仍为当前版本时才立即更新编辑器，并将文档标记为未保存，但不会自动写盘；只有显式 `save` 才保存。旧 revision 会被拒绝且不改变正文。`watch` 只输出文档 ID、revision、dirty 和来源等变更元数据，不输出正文。

Mora 也会监视已打开 `.mdx` 的磁盘变化：文档干净时自动重新载入，存在未保存编辑时保留内存内容并进入冲突处理。关闭 Agent 接入会移除发现记录、断开 watcher，并拒绝后续请求。

MCP 使用 stdio，没有 URL 或端口。第三方 MCP 客户端配置应使用 **设置 → Agent** 显示或复制的安装后绝对路径，不要填写仓库开发路径：

```json
{
    "mcpServers": {
        "mora": {
            "command": "<设置中显示的 mora-agent 绝对路径>",
            "args": ["mcp"]
        }
    }
}
```

首版 MCP 只提供 `mora_list_documents`、`mora_read_document`、`mora_replace_document` 和 `mora_save_document` 四个工具。Mora 不会自动修改 `PATH` 或第三方 MCP 配置。

安全与错误约定：IPC 仅允许同一系统用户访问；JSON/JSONL/MCP 数据只写 stdout，诊断写 stderr，日志不得包含文档正文。CLI 成功返回 `0`；通用错误为 `1`，Mora 未运行为 `2`，接入关闭为 `3`，revision 冲突为 `4`，磁盘冲突为 `5`，权限错误为 `6`。`replace` 或 `save` 的请求帧已完整写入 Mora 后，若在等待响应阶段返回 `TIMEOUT`，操作可能仍在 Mora 内继续并稍后完成，错误详情会标记 `outcomeUnknown: true`；该标记不适用于连接阶段或请求帧未完整写入时的 `TIMEOUT`。收到 `outcomeUnknown: true` 后，调用方必须重新 `read` 并核对 live/disk revision 后再决定是否重试，不能直接重复写入。

当前实现包含 Windows 与 Unix 本地 IPC 代码及跨平台打包配置；本次本机验收只验证 Windows Named Pipe、Windows 可执行文件和 Windows 安装包。macOS/Linux 的打包由对应 CI Runner 验证，本 Windows 环境不声称已验证 Unix runtime。首版不提供远程访问、HTTP、云同步、CRDT/OT、离线 Agent 编辑器或资源变更工具。

## 当前限制

- Agent 本机运行与安装包验收当前以 Windows 为范围；macOS/Linux 由对应 CI Runner 验证。
- 不提供云同步、多人协作或加密笔记。
- 不以替代 Word 的分页、复杂排版、表单和审阅流程为目标。
- 资源目前使用内存缓冲和 Base64 传输，不适合超大附件。
- PDF 由内置 Typst 渲染链路直接导出；“打印”仍是独立的系统打印命令。
- 当前安装包尚未配置商业 Authenticode 代码签名证书，Windows 可能显示“未知发布者”；这不影响 Mora 对自动更新包执行 Tauri 签名校验。

## 图表与命令

- 支持 `mermaid` 围栏代码块中的流程与结构（流程图、状态图、类图、ER 图、需求图、C4、架构图、方块图）、时序与计划（时序图、甘特图、时间线、用户旅程图）和思维导图。仅源码模式保留源码；所见即所得、源码加只读预览和打印路径显示图表。
- 提供宣白、墨黑、黛蓝、松青、绛红、藤紫六套主题和 `Ctrl+Shift+P` 命令面板；命令面板复用全部既有菜单操作。

## 自动更新

正式桌面版启动后会静默检查一次更新，也可以通过“关于 → 检查更新”手动检查。发现新版本后，Mora 显示 GitHub Release 中的版本和说明；只有用户明确点击后才会下载，并在安装重启前逐一处理所有未保存文档。

更新清单、安装包和签名文件由 GitHub Actions 生成到 Draft Release，经发布后客户端才能下载。客户端必须通过内置公钥验证更新签名，签名不匹配时不会安装；未发布的本地构建不会自动成为更新来源。

## 从源码运行

需要 Node.js、Rust、Microsoft Visual Studio Build Tools、Windows SDK 和 WebView2 Runtime。

```bash
npm install
npm run tauri -- dev
```

构建开发版 Windows 程序（生成同目录的 `mora.exe` 与 `mora-agent.exe`；macOS/Linux 的 Agent 文件名为 `mora-agent`）：

```bash
npm run build:exe
```

正式发布时构建 Windows 安装包：

```bash
npm run tauri -- build
```

维护者发布步骤见 [`docs/RELEASE.md`](docs/RELEASE.md)，更多设计与技术资料见 [`docs/`](docs/)。
