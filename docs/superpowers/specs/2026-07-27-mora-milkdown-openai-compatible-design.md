# Mora Milkdown 与 OpenAI-compatible AI 设计

日期：2026-07-27  
状态：设计已批准，规格待书面审核  
适用范围：Mora 墨笺编辑器内核迁移与第一阶段 AI

## 1. 决策背景

Mora 当前使用 Toast UI Editor，但项目仍处于开发阶段，无须维护 Toast UI
过渡版本或双内核兼容层。编辑器内核确定后通常不会频繁替换，因此本次直接迁移到：

- Milkdown/Crepe：Markdown-first WYSIWYG 编辑。
- CodeMirror 6：整篇 `content.md` 源码编辑。
- 只读 Milkdown：源码模式的垂直预览。
- OpenAI-compatible Provider：第一阶段 AI 的唯一模型接入方式。

本设计更新以下既有结论：

- `docs/research/2026-07-27-markdown-editor-and-ai-research-summary.md`
  中关于保留 Toast UI、建立通用 `EditorAdapter`、独立 Markdown Renderer、
  Tiptap 对照 PoC 的阶段性建议不再适用。
- `docs/superpowers/specs/2026-07-20-mora-complete-modernization-design.md`
  中“保留 Toast UI Editor”的约束被本设计替代；文件格式、安全保存、资源会话、
  草稿恢复等其他约束继续有效。

## 2. 目标

本次交付必须形成一个可独立使用的闭环：

1. 完全移除 Toast UI Editor。
2. 提供 WYSIWYG、源码、源码加预览三种视图。
3. 保持 `content.md` 为唯一持久化正文。
4. 保留现有 `.mdx` 打开、保存、资源、草稿、查找、菜单和快捷键能力。
5. 在 WYSIWYG 中同期提供 Crepe 内置 AI 交互。
6. 接入一个由用户配置的 OpenAI-compatible Provider。
7. API Key 只保存在操作系统凭据库，模型请求由 Rust 发起。

## 3. 不在本次范围

- 独立的仅预览模式。
- Toast UI 回退、功能开关或双内核运行。
- 通用 Editor Adapter 框架、编辑器工厂或插件注册表。
- 独立 Markdown Renderer。
- 多 AI Provider、Provider 注册表或模型路由。
- AI 对话侧边栏、Prompt 历史、知识库、Agent 或图片生成。
- CodeMirror 6 源码 AI。
- VS Code 风格幽灵文字、Tab 接受或自动行内补全。
- Tiptap、Vditor 等对照 PoC。

源码 AI 和行内补全属于后续独立阶段；本次不为其创建空接口、空组件或 UI 占位。

## 4. 总体架构

```text
App.vue
└─ MoraEditor.vue
   ├─ MilkdownEditor.vue
   │  ├─ 可编辑：WYSIWYG
   │  └─ 只读：源码分屏预览
   └─ SourceEditor.vue
      └─ CodeMirror 6：整篇 Markdown 源码
```

编辑器组件只处理正文编辑、选择区和编辑命令，不管理标题、文件路径、元数据、
资源持久化、草稿或保存流程。

`App.vue` 继续持有 Markdown 字符串。`content` 始终是使用 `assets/...`、
`attachments/...` 相对路径的规范持久态，也是保存到 `content.md` 的唯一正文状态。
`displayContent` 仅由 `resourceSession.displayMarkdown(content)` 计算，用于向
Milkdown 投影 Blob URL；CodeMirror 始终接收规范持久态。应用不持久化 Blob URL、
ProseMirror JSON、Milkdown 内部状态或 CodeMirror EditorState。

## 5. 编辑视图

### 5.1 WYSIWYG

- 使用可编辑 Milkdown/Crepe。
- 使用 Milkdown 官方命令和插件 API。
- Crepe AI 只在该视图启用。

### 5.2 源码

- 使用 CodeMirror 6 编辑整篇 Markdown。
- 占用完整编辑区域。
- 不加载只读预览实例。

### 5.3 源码加预览

- 左侧 CodeMirror 6 可编辑。
- 右侧只读 Milkdown 预览。
- 预览只单向接收源码内容，不能编辑。
- 首版直接同步 Markdown，不预设 debounce、增量解析或虚拟化。
- 只有大文档测试证明存在输入卡顿时才增加性能策略。

独立仅预览模式删除。WYSIWYG 已覆盖阅读效果，单独预览没有独立产品价值。

## 6. Markdown 状态与模式切换

数据流如下：

```text
Milkdown 内容变化 ── persistedMarkdown() ──┐
CodeMirror 内容变化 ────────────────────────┤
                                            ↓
App.vue 中的规范 Markdown（content）
        ├─ 保存为 content.md / 草稿
        ├─ 原样传给 CodeMirror
        └─ displayMarkdown() → 可编辑或只读 Milkdown
```

规则：

1. 打开、新建或恢复草稿时，将规范相对路径正文直接写入 `content`。
2. `MoraEditor` 的更新事件先经过 `resourceSession.persistedMarkdown()`；只有规范化
   结果与当前 `content` 不同时才写入并标脏。
3. 保存和草稿快照直接读取规范 `content`，不再调用第三方 `getMarkdown()`。
4. 子组件收到外部正文时先比较新旧字符串；相同内容的回传不得误标脏。
5. 使用 `v-if` 只挂载当前需要的编辑器实例。
6. 切换编辑器后，目标实例以最新 Markdown 初始化。
7. 不在 Milkdown 与 CodeMirror 之间转换撤销历史；切换模式形成新的撤销边界。

用户已接受以下约束：

- Markdown 进入 WYSIWYG 后，Milkdown 可能规范化空白、列表标记、强调符号等源码格式。
- 正文语义和资源相对路径必须保持，但不保证字节级原样往返。
- 仅在源码视图编辑且未进入 WYSIWYG 时，保持用户输入的原始 Markdown 字符串。

## 7. 最小编辑器组件接口

不建立通用 `EditorAdapter`。`MoraEditor.vue` 作为 Vue 组件边界，内部隔离
Milkdown 和 CodeMirror 类型。

正文和模式通过 props/emits 传递：

- `modelValue`：使用包内相对路径的规范 Markdown 正文。
- `displayValue?`：只供 Milkdown 使用的显示投影；未提供时回退到 `modelValue`。
- `mode`：`"wysiwyg" | "source"`。
- `sourcePreview`：源码模式是否显示右侧预览。
- `readonly`：文件级只读状态。

根据现有 `App.vue` 的真实调用，只暴露：

```ts
type MoraEditorHandle = {
    focus(): void;
    getSelectedText(): string;
    replaceSelection(text: string): void;
    moveCursor(position: "start" | "end"): void;
    execute(command: EditorCommand): void;
    scrollToHeading(text: string): boolean;
};
```

其中：

- `undo`、`redo`、`selectAll` 和格式操作统一走 `execute()`。
- 不暴露 `getMarkdown()`、`setMarkdown()`，正文统一走 props/emits。
- `EditorCommand` 只列出现有菜单实际使用的命令，不为未来命令创建注册机制。
- `MoraEditor.vue` 根据当前模式将命令交给 Milkdown 或 CodeMirror 的官方 API。

## 8. 资源处理

现有 `resourceSession` 保留，不新增资源适配层：

```text
content / content.md：assets/... 或 attachments/...
        ├─ 原样传给 CodeMirror、保存和草稿
        └─ resourceSession.displayMarkdown()
                  ↓
          Blob URL 仅进入 Milkdown displayValue
                  ↓ 编辑事件
          resourceSession.persistedMarkdown()
                  ↓
          与 content 比较后更新
```

要求：

- 已有图片和附件继续使用包内相对路径。
- Milkdown 图片粘贴和拖拽接入官方上传钩子，再调用现有 `resourceSession`。
- 不查询或修改 Milkdown 内部 DOM。
- 不拦截原生事件制造编辑器补丁。
- 保存、另存为、草稿恢复和重新打开后，资源引用必须继续有效。
- Blob URL 不得进入 App 权威正文、CodeMirror、草稿或保存请求。

### 8.1 PDF 与目录辅助行为

- 从源码或垂直双栏导出 PDF 时，临时切换为单一可编辑 WYSIWYG，等待 Vue
  完成渲染后调用系统打印，再恢复原模式；不建立独立 Markdown Renderer，且该切换
  不改变正文或脏状态。
- App、CodeMirror 与 Milkdown 的目录定位共用一个最小标题文本规范化函数，处理
  尾部闭合 `#`、链接、行内代码和常见强调标记；它不是完整 Markdown 解析器。

## 9. 第一阶段 AI 功能

第一阶段直接复用 Crepe AI Feature，提供：

- 改善表达。
- 修正语法和拼写。
- 缩短、扩写。
- 调整语气。
- 翻译。
- 自定义指令。
- 流式生成。
- 取消生成。
- Diff 审阅。
- 接受、拒绝和重试。

不重复实现 AI 工具栏、指令菜单、流式结果面板或 Diff UI。

## 10. AI 边界与数据流

Mora 只定义一个编辑器无关的流式函数契约，不建立 Provider 工厂或注册表：

```ts
type MoraAIProvider = (
    request: AIRequest,
    signal: AbortSignal,
) => AsyncIterable<string>;
```

当前只有一个实现：

- `openAICompatibleProvider`：调用 Tauri 命令并把 Channel 事件转换为
  `AsyncIterable<string>`。
- `createCrepeAIProvider`：将 Mora 请求和流式结果适配到 Crepe 官方
  `AIProvider` 契约。

完整数据流：

```text
Crepe AI 菜单
  → createCrepeAIProvider
  → openAICompatibleProvider
  → Tauri Channel
  → Rust ai.rs
  → OpenAI-compatible /chat/completions
  → SSE 增量文本
  → Delta / Done / Error
  → AsyncIterable<string>
  → Crepe Diff 审阅
```

该函数契约当前服务于 Crepe，同时避免 Milkdown 类型进入 Rust 调用和设置层。
源码 AI 后续可以复用它，但本次不实现源码侧适配。

## 11. Rust AI 实现

首版集中在一个 `src-tauri/src/ai.rs`，达到清晰度或测试需要前不拆分目录。

职责：

1. 校验 Base URL 和请求字段。
2. 从操作系统凭据库读取 API Key。
3. 向用户配置的 OpenAI-compatible Base URL 发送流式
   `/chat/completions` 请求。
4. 使用可靠的 SSE 解析库处理跨分块事件，不手写字符串分块解析器。
5. 提取 `choices[0].delta.content`。
6. 通过 Tauri Channel 返回事件。
7. 响应前端取消请求。

最小 Tauri 命令：

- `save_ai_api_key`
- `delete_ai_api_key`
- `has_ai_api_key`
- `stream_ai`
- `cancel_ai`

同一时间只允许一个 AI 请求，因此原生状态只保存一个当前取消句柄，不建立
request ID Map。只有产品增加并行 AI 操作时才升级为多请求状态。

Channel 事件：

```ts
type AIStreamEvent =
    | { type: "delta"; text: string }
    | { type: "done" }
    | { type: "error"; code: string; message: string };
```

Crepe 自己管理开始状态，因此不增加 `started` 事件。

## 12. AI 配置与安全

设置项：

- Base URL：必填，例如 `https://api.openai.com/v1`。
- Model：必填。
- API Key：可以设置、替换和删除。

存储规则：

- Base URL 和 Model 沿用现有偏好设置持久化。
- API Key 只写入操作系统凭据库。
- 前端只能查询是否已配置，不能读回明文。
- API Key 不进入 LocalStorage、`.mdx`、日志、错误文本或草稿。

网络规则：

- 默认只允许 HTTPS。
- 仅 `localhost`、`127.0.0.1` 和 `::1` 可以使用 HTTP。
- 请求由 Rust 发起，不放宽 WebView `connect-src`。
- Base URL 去除尾部 `/` 后追加 `/chat/completions`。

首版不提供“测试连接”按钮。OpenAI-compatible 服务对探测接口的实现不一致，
实际流式生成请求才是可靠的兼容性验证。设置保存时只校验 URL 和必填字段。

## 13. AI 取消与错误处理

- `AbortSignal` 触发 `cancel_ai`。
- 用户取消时丢弃未确认的 AI 结果并保留原文。
- AI 结果在用户接受前不作为最终正文。
- 不自动重试流式请求，避免重复生成或重复插入。
- 用户可以通过 Crepe 的重试操作重新发起完整请求。

错误映射：

| 情况 | 用户反馈 |
| --- | --- |
| 未配置 Base URL、Model 或 API Key | 引导打开 AI 设置 |
| 非法 URL 或非本地 HTTP | 请求前拒绝并说明限制 |
| 系统凭据库失败 | 明确提示凭据保存或读取失败 |
| `401/403` | API Key 无效或无权限 |
| `404` | Base URL、接口路径或模型不兼容 |
| `429` | 请求频率或额度受限 |
| `5xx`、网络错误、超时 | 生成失败，可手动重试 |
| SSE 或响应结构错误 | 服务不符合当前 OpenAI-compatible 流式协议 |

错误和调试日志不得包含 Authorization Header、API Key 或完整敏感请求内容。

## 14. Toast UI 清理边界

直接删除：

- `@toast-ui/editor` 依赖。
- Toast UI 导入、动态初始化和实例变量。
- `env.d.ts` 中的 Toast UI 类型声明。
- `.toastui-*` 专用样式。
- Toast UI Mock 和布局测试。
- `changeMode`、`changePreviewStyle`、`getMarkdown`、`setMarkdown`
  等兼容调用。
- 仅源码和仅预览的 Toast CSS 布局模拟。

不保留 Toast Adapter、回退开关、兼容模式或迁移期双写。

保留：

- `.mdx` 新建、打开、保存、另存为和安全备份。
- 草稿恢复和未保存保护。
- `resourceSession`。
- 最近文件。
- 查找替换。
- 菜单、快捷键和状态栏。
- 脏状态和元数据管理。

只抽离编辑器相关代码，不顺带重构整个 `App.vue`。其他职责只有在后续任务中
出现明确需求或文件继续增长造成实际维护问题时再拆分。

## 15. 分阶段交付

### 当前交付：编辑器迁移与 WYSIWYG AI

- 完全移除 Toast UI。
- 接入 Milkdown/Crepe。
- 接入 CodeMirror 6。
- 提供 WYSIWYG、源码、源码加预览。
- 保留现有文件和资源能力。
- 接入 OpenAI-compatible 原生流式请求。
- 提供 Crepe 内置 AI 交互。

### 后续第二阶段：源码选区 AI

- CodeMirror 6 获取选区和字符偏移。
- 复用同一个 `MoraAIProvider`。
- AI 结果确认后以单次 CodeMirror Transaction 写入。
- 该阶段开始前单独完成交互和冲突处理设计。

### 后续第三阶段：源码行内补全

- 根据实际使用需求评估幽灵文字、Tab 接受、Esc 拒绝和上下文截取。
- 只有普通选区 AI 无法满足源码写作需求时实施。
- 中文 IME、取消、并发和文档版本冲突必须作为该阶段验收项。

## 16. 测试策略

沿用现有 Vitest 和 Rust 测试能力，不新增测试框架。

### 16.1 编辑器

- WYSIWYG、源码、源码加预览切换。
- 分屏只有 CodeMirror 侧可编辑。
- 打开、新建和外部正文可以正确更新当前编辑器。
- 模式切换后 Markdown 语义不丢失。
- Milkdown 规范化后的 Markdown 可以保存并重新打开。
- 格式命令、选择、剪切、粘贴、撤销、全选和光标移动可用。
- 切换模式后形成新的撤销边界。

### 16.2 资源

- 已有 `assets/...` 图片可以显示。
- 已有 `attachments/...` 链接可以访问。
- 粘贴或拖入图片后进入现有资源会话。
- 保存时 Blob URL 恢复为包内相对路径。
- 保存并重新打开后资源仍可访问。

### 16.3 AI 前端

- Channel Delta 按顺序转为 `AsyncIterable<string>`。
- Done 正常结束流。
- Error 中止流并显示映射后的错误。
- AbortSignal 触发取消。
- 取消、拒绝或失败后原文保持不变。
- 接受结果后正文和脏状态更新。

### 16.4 AI Rust

- Base URL 校验，包括 HTTPS、本地 HTTP 和被拒绝的远程 HTTP。
- SSE 跨网络分块解析。
- Delta、Done 和错误事件映射。
- HTTP 状态码映射。
- 取消当前请求。
- 凭据接口不返回 API Key 明文。

### 16.5 回归和构建

必须运行：

```bash
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

任何 Rust AI 单元测试同时运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## 17. 验收标准

只有同时满足以下条件才视为完成：

1. 仓库中不存在 Toast UI 依赖、导入、类型、样式或测试 Mock。
2. WYSIWYG、源码、源码加预览三个视图可用。
3. 独立仅预览入口已经删除。
4. 现有 `.mdx` 可以打开、编辑、保存并重新打开。
5. `content.md` 仍是唯一持久化正文。
6. 图片和附件仍使用包内相对路径。
7. 新建、打开、保存、另存为、草稿恢复和未保存保护没有回归。
8. WYSIWYG AI 可以流式生成、取消、接受、拒绝和重试。
9. API Key 只存在操作系统凭据库，前端不能读取明文。
10. AI 失败或取消不会覆盖原文。
11. 项目规定的三项构建命令全部通过。

## 18. 减法检查

本设计明确不引入：

- 一个实现对应一个接口的 Editor Adapter 层。
- 独立预览渲染器。
- 多 Provider 工厂或注册中心。
- AI Command Service 层级。
- 多请求 Map。
- Toast 兼容和迁移代码。
- 未经数据证明的性能优化。
- 后续阶段的占位实现。

保留的组件、函数契约和原生边界均对应当前已确认的产品需求、安全边界或现有功能回归要求。

## 19. 参考资料

- [Milkdown Crepe 使用指南](https://milkdown.dev/docs/guide/using-crepe)
- [Milkdown Crepe API](https://milkdown.dev/docs/api/crepe)
- [Milkdown Copilot 示例](https://milkdown.dev/blog/build-your-own-milkdown-copilot)
- [CodeMirror 6 Reference Manual](https://codemirror.net/docs/ref/)
- [Tauri Rust 调用与 Channel](https://v2.tauri.app/develop/calling-rust/)
- [Rust keyring crate](https://docs.rs/crate/keyring/latest)
