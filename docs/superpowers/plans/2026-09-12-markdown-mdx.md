# Markdown / Mora MDX 双格式实施计划

> For agentic workers: use subagent-driven-development task-by-task; preserve the user's existing working tree.

**Goal:** .md/.markdown 原格式读写，.mdx 保持 MDXNote 单文件，支持显式新建和另存为转换。
**Architecture:** 共用现有 Milkdown + CodeMirror 和文档会话；新增普通 Markdown 文件存储职责，不建立第二套编辑器。原始路径用于 IO，资源 Blob 只作显示投影。
**Tech Stack:** Vue 3 / TypeScript / Tauri 2 / Rust；不引入新的依赖包；必要时显式复用已锁定的依赖。
**Spec:** 用户已批准本对话中的双格式建议；验收条目如下。

## 验收与边界
- [x] 打开 .md/.markdown 为已保存的 Markdown 文档；Ctrl+S 写回原文件。
- [x] 新建可选 Markdown / MDX，另存为可选择两者；转换保留原文件。
- [x] Markdown 文字、YAML/BOM 与本地资源在打开、源码、WYSIWYG、只读预览和重启恢复中保留。
- [x] 图片粘贴和添加附件在两种格式保存、重开后均可用；MDX→MD保留未引用附件。
- [x] 资源引用按实际 Markdown AST 位置处理，代码段中的示例路径不改。
- [x] 保存使用安全提交；资源不得覆盖不相关文件，保存失败保留内存和源文件。
- [x] 并发编辑期间保存不能丢失正文或资源；路径切换不能改变已有相对引用的含义。
- [x] 两种格式的外部更改、冲突处理、草稿恢复、同路径去重均生效。
- [x] 原有 MDX 导出、附件、AI 与 Agent 接口按适用范围保留；Markdown 不误用 ZIP 专属接口。
- [x] 完成相关单元/集成/真实文件 roundtrip 以及浏览器交互验证；按用户偏好本次不编译桌面 EXE。

## Task 1 后端文件与资源
Files: src-tauri/src/markdown_file.rs, lib.rs, export.rs, markdown_resources.rs, file_watch.rs (+必须的现有路径扫描入口)
Interfaces:
```ts
open_markdown({ path }): MarkdownNote
read_markdown_resource({ sourcePath, reference }): ResourceSaveData
save_markdown({ request: { path, title, content, meta, newAssets, removedResources, sourceFormat, expectedRevision, overwrite }, path: target }): MarkdownSaveResult
prepare_markdown_resources({ sourcePath, markdown, newAssets? }): MarkdownResourcePlan
```
- [x] 先测试标准文本/frontmatter/编码与 inline/reference/HTML 本地资源。
- [x] 实现标准文本读写；复用已有临时文件与备份提交，提交前 revision 检查。
- [x] MDX保存资源、pending/removed与跨目录MD资源复制，返回 resourceRewrites。
- [x] 资源使用唯一文件名；失败只清理本次创建且未提交的资源，旧资源不删除。
- [x] watcher 按扩展名验证普通文本或 ZIP。
- [x] Rust目标测试覆盖保存失败、缺失资源、目录逃逸、跨目录、未引用附件。

## Task 2 文档会话
Files: useDocumentSession.ts/tests, useResources.ts/tests, workspace.ts, resourcePaths.ts/tests
- [x] sourceKind 增加 markdown，旧 markdown-import 草稿恢复兼容。
- [x] newDocument(format)，save/saveAs 按文件格式分流；目标已打开时拒绝覆盖。
- [x] 使用后端写回快照的 rewrites 更新规范正文和资源 keys；并发新编辑保留 dirty。
- [x] reload/restore/外部变化读取按格式分流。
- [x] 测试原地MD保存、双向转换、并发输入、失败、恢复和冲突。

## Task 3 编辑器头部保留
Files: components/editor/MoraEditor.vue/tests
- [x] YAML/BOM通过纯计算投影从Milkdown正文分离，SourceEditor保留全量正文。
- [x] rich编辑回调拼回当前canonical头部；无另一份可写正文。
- [x] 测试 CRLF/BOM、闭合标记EOF、源码修改、跨文档和普通Markdown。

## Task 4 App UI / 附件 / 集成
Files: App.vue/App.web.test.ts, types/mdx.ts (+必要的既有UI测试)
- [x] 文件菜单新建Markdown/MDX，另存为带明确格式选项。
- [x] Ctrl+S原格式保存，Markdown→MDX继续资源预检/确认；原MD路径不传给ZIP保存。
- [x] 通过 read_markdown_resource 加载现有本地图片和附件，新增附件生成标准引用。
- [x] 元数据与附件打开/导出使用相应来源；专属MDX历史命令仅对MDX启用。
- [x] 导出Markdown应直接支持当前Markdown快照，避免先强制转换。
- [x] App测试覆盖新建/保存/转换/取消/失败/资源和三视图共享。

## Task 5 总体验证
- [x] 全部前端测试、TypeScript检查、对应Rust测试和cargo check通过。
- [x] 临时文件真实 .md→.mdx→.md roundtrip，包括图片、附件、frontmatter、Unicode/空格路径。
- [x] 浏览器验证新建与格式选项、三种视图、主题/侧栏等已有UI无回归。
- [x] 最终代码审查；逐项完成上面的验收证据后再完成目标。

## 执行裁定
- 当前代码在 E:/WorkspaceIdea/mdx；F:不存在。所有操作明确工作目录。
- 使用现有 codex/release-0.1.3 任务分支原位工作，保留用户先前的 UI 与 TODO.md 改动，不暂存/提交无关文件。
- 后端、会话、编辑器由不同 agent 负责互不重叠文件，App/集成由主线程负责。
- API一致性：后端与会话 sourceFormat 统一使用 markdown | mdx；MarkdownNote没有ZIP manifest。


## 完成验收（2026-09-12）

- 前端全量：557 项通过，0 失败；报告为本次本地验收产物 md-frontend-acceptance.json。
- 后端：库 162、document_export 46、export_markdown 5、markdown_import 2、markdown_resources 4、workspace 7，共 226 项通过。
- TypeScript：vue-tsc --noEmit 通过；修改的前端文件 ESLint 通过。
- Rust：CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo check --manifest-path src-tauri/Cargo.toml --locked --offline 通过。
- 浏览器：新建两种格式、格式标识、源码/WYSIWYG/分屏、头部保留、跨文档切换、另存为入口及窄窗口通过；没有运行时错误。
- 真实文件：Markdown → MDX → Markdown 往返，以及 MDX → Markdown → MDX 二次封装，确认源文件和源资源 SHA-256 不变，未引用图片/附件仍在 ZIP 中。
- 故障与边界：预存 .tmp/.bak 不被读操作或保存删除；独占临时文件、写入失败回滚、版本冲突、保存期间输入、草稿恢复期间外部改写、Unicode/编码路径/实体/fragment 均有回归。
- 最终独立复查确认“二次封装遗漏未引用附件”“实体路径解析不一致”两项已闭合。
- 未运行桌面 EXE 构建或安装包构建；没有提交或发布。

## 删减检查与最终裁定

- markdown_file.rs：现有 ZIP 读写无法原格式保存普通文本，必须承担 Markdown 安全读写和外置资源事务；无新仓储/工厂/适配层。
- markdownFrontMatter.ts：编辑器、资源定位、目录提取共同保留前缀，避免重复规则及头部被误改写；仅计算投影，无第二份正文。
- 显式复用已被 Tauri 锁定的 html5ever 0.38.0，使用公开 Tokenizer 处理 HTML 实体；Cargo.lock 仅增加根引用，没有新增依赖包/版本。
- Markdown 外部文件的重命名/删除不伪装为包内元数据操作，界面指向资源文件夹管理；添加/插入/打开/导出保留，MDX 原功能不变。
- 保存相关草稿新增可选 baseDiskRevision；旧 Markdown 草稿在内容不同且基线未知时要求处理冲突，原样草稿无需额外确认。
- 格式切换后关闭旧路径上下文面板，Markdown 不调用 ZIP 历史接口。
