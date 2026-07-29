# Task 4 实施报告：组合三种视图并替换 Toast UI

## 接管时现状

- 基线提交：`16265b9`（`test: cover Crepe lifecycle failures`）。
- 已有未提交测试：`MilkdownEditor.test.ts`、`SourceEditor.test.ts` 已增加 TOC 滚动测试，`MoraEditor.test.ts` 已新建；生产文件尚未修改。
- 未丢弃或重写既有测试需求，仅在 `vue-tsc` 报错后补齐 Milkdown mock 的真实 `doc.descendants` 和 transaction 返回类型。

## TDD 记录

### RED 1：编辑器与 TOC

命令：

```bash
npm test -- src/components/editor/MilkdownEditor.test.ts src/components/editor/SourceEditor.test.ts src/components/editor/MoraEditor.test.ts
```

预期失败：

- MilkdownEditor：`scrollToHeading is not a function`。
- SourceEditor：`scrollToHeading is not a function`。
- MoraEditor：无法解析 `./MoraEditor.vue`。

### GREEN 1：编辑器与 TOC

- `MoraEditorHandle` 增加 `scrollToHeading(text): boolean`。
- Milkdown 使用 `editorViewCtx`、ProseMirror `doc.descendants`、`TextSelection` 和 transaction `scrollIntoView()`。
- Source 使用 CodeMirror doc 行模型查找首个匹配 ATX 标题，并派发 selection 与 `EditorView.scrollIntoView()`。
- 新建 `MoraEditor.vue`，组合 WYSIWYG、源码、源码+只读预览三种视图；编辑命令只委托当前可编辑子组件，双栏 TOC 同时滚动两侧。
- 结果：3 个测试文件，20/20 通过。

### RED 2：App 迁移

先将 App 测试改为 MoraEditor 外部契约后运行：

```bash
npm test -- src/App.web.test.ts src/App.markdown-layout.test.ts
```

预期失败：

- 布局测试因 App 仍包含“仅预览”和 Toast 引用失败。
- Web 测试因旧 App 未挂载 MoraEditor，4 项失败。

### GREEN 2：App 迁移

- App 的 Markdown 唯一权威改为 `content`，删除 Toast 实例、初始化、生命周期和双向同步函数。
- 三视图收敛为 WYSIWYG、源码、源码+只读预览；删除仅预览和 Alt+4。
- 编辑命令、选择、剪贴板、查找替换、链接/图片/表格插入、首尾移动全部通过 `MoraEditorHandle`。
- 图片粘贴继续注册到 `useResources`，正文显示 Object URL，保存时恢复为相对 `assets/...` 路径。
- App TOC 仅调用 `scrollToHeading`，删除编辑器内部 `querySelectorAll`/DOM `scrollIntoView`。
- 卸载 `@toast-ui/editor`，删除类型声明、import、初始化、mock 和专用 CSS。
- 聚焦结果：5 个测试文件，26/26 通过。

## 最终验证

- `npm test -- src/components/editor/MoraEditor.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/SourceEditor.test.ts src/App.web.test.ts src/App.markdown-layout.test.ts`：通过，26/26。
- `npm test`：通过，18 个测试文件，66/66。
- `npm run build`：通过；`vue-tsc --noEmit` 与 Vite 构建成功。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；有 Windows 增量编译目录收尾“拒绝访问”警告，退出码为 0。
- `npm run tauri -- build`：通过；生成 `mora.exe`、MSI 和 NSIS 安装包。

---

## 最后三项门禁修复（2026-07-29）

### TDD 记录

- Crepe readiness rejection RED：`instance.create()` 失败后，初始化报告的 `.catch()`
  覆盖了公开 readiness，`whenReady()` 错误地 resolve。GREEN 后公开 Promise 保留原 rejection；
  独立观察 catch 仅报告错误，卸载链在成功或失败后各只销毁一次。
- PDF 防重入 RED：首次导出等待临时 WYSIWYG readiness 时连续触发两次，会造成两次
  `whenReady()` 调用。GREEN 后最早的 `printing` guard 立即拦截第二次调用；rejection 不打印、
  通过既有错误栏展示错误、恢复原 source/split 与 dirty 状态，并可再次导出。
- CommonMark ATX 缩进 RED：`   ## 缩进标题` 未被正文提取、App TOC 或 Source 定位识别。
  GREEN 仅放宽共享提取正则到最多三个前导空格；四个空格仍非标题，围栏的开闭仍严格遵循
  最多三个前导空格。

### 本轮验证

- 相关测试：`MilkdownEditor`、`SourceEditor`、`text`、`App editor integration`，33/33 通过。
- `npm test`：19 个测试文件，87/87 通过。
- `npm run build`：通过；仅保留既有大 chunk 提示。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；Windows 增量编译目录收尾仍有
  “拒绝访问”警告，退出码为 0。
- `npm run tauri -- build`：通过；生成 `mora.exe`、MSI 和 NSIS 安装包。
- `git diff --check`：通过。
- Toast/旧状态扫描：生产源码、`package.json`、`package-lock.json` 中无残余。

## 变更文件

- `src/components/editor/MoraEditor.vue`：新增三视图组合和统一 handle 委托。
- `src/components/editor/MoraEditor.test.ts`：覆盖三种视图、可编辑子组件委托和双栏 TOC。
- `src/components/editor/editorTypes.ts`：扩展 TOC 语义方法。
- `src/components/editor/MilkdownEditor.vue` / `.test.ts`：ProseMirror 标题定位与测试。
- `src/components/editor/SourceEditor.vue` / `.test.ts`：CodeMirror 标题定位与测试。
- `src/App.vue`：迁移唯一内容状态、编辑操作、视图、图片上传和 TOC；移除 Toast。
- `src/App.web.test.ts`：改用 MoraEditor emit 验证字数、脏状态和 Web 无 Tauri IPC。
- `src/App.markdown-layout.test.ts`：验证仅保留三种视图且无 Toast。
- `src/env.d.ts`：删除 Toast 声明。
- `src/style.css` / `src/experience.css`：删除 Toast 专用样式，保留 Milkdown/CodeMirror 布局与主题。
- `package.json` / `package-lock.json`：卸载 Toast 依赖。

## 自审与删减检查

- 当前新增模块仅 `MoraEditor.vue`：它解决三视图组合和统一命令/TOC 入口；删除后 App 无法在两个既有内核间切换并保持统一 handle，因此是验收必需。
- 未增加独立预览 renderer、EditorAdapter、工厂、注册中心、双内核兼容层或第二套 Markdown 状态。
- 未引入 `any`、定时器、编辑器内部 DOM 操作或事件拦截补丁。
- 文件/资源/菜单/快捷键/TOC/查找替换/导出入口保留；`.mdx` Rust 读写和安全保存流程未修改。

## 关注点

- Vite 仍报告主 chunk 超过 500 kB；属于现有依赖体积提示，本任务未引入代码分割抽象。
- `npm uninstall` 的审计输出仍报告 1 个 high severity 依赖漏洞；未执行可能扩大范围的 `npm audit fix`。
- 本任务完成自动测试、前端构建和完整桌面打包，未额外进行人工 GUI 交互冒烟。

---

## 方案 B 纠偏（2026-07-29）

前文“正文显示 Object URL，保存时恢复相对路径”的表述已被本轮纠正：
`App.content` 和 CodeMirror 始终只保存 `assets/...` / `attachments/...` 规范路径；
Blob URL 仅由 `displayContent` 投影给可编辑或只读 Milkdown。

### TDD 证据

- 标题规范化 RED：`normalizeMarkdownHeadingText` 尚不存在，Source/Milkdown 无法将
  `## **目标标题** ##` 匹配为“目标标题”；实现共享最小规范化函数后 18/18 GREEN。
- MoraEditor RED：Milkdown 未收到 `displayValue`；实现 WYSIWYG/只读预览显示投影、
  Source 规范值后 7/7 GREEN，并覆盖真实子 emit 和动态挂载/卸载。
- App 行为级 RED：保留真实 `App -> MoraEditor`、仅 Mock 最低层编辑器时 4/4 失败，
  分别证明旧实现按 Blob 统计、外部同内容回传误标脏、源码打印无 Milkdown、双栏打印
  仍含 Source。实现显式 `handleEditorUpdate`、规范内容边界和临时 WYSIWYG 打印后，
  与编辑器/标题聚焦测试合计 29/29 GREEN。
- 资源投影缓存 RED：同一规范正文只替换 URL 映射时，computed 仍返回旧 Blob URL；
  为资源会话加入最小响应式修订号后 9/9 GREEN。

### 实现结果

- `App.content`、保存请求、草稿和 CodeMirror 均保持规范相对路径；Milkdown 通过
  `displayValue` 接收 Blob 投影。Milkdown 回传先执行 `persistedMarkdown()`，只有规范
  结果变化才写入并标脏。
- `applyNote()` 和草稿恢复不再写入显示态 Markdown；资源映射变化会主动使
  `displayContent` 失效重算。
- PDF 从源码或垂直双栏导出时临时只挂载一个可编辑 WYSIWYG，`nextTick()` 后打印，
  并在 `finally` 恢复视图，不修改正文或脏状态。
- App、Source、Milkdown 共用最小标题规范化，覆盖尾部闭合 `#`、链接、行内代码与
  常见强调标记；未引入完整 Markdown 解析器。
- 已批准设计规格与实施计划已同步方案 B，删除 App/CodeMirror 持有 Blob 的冲突描述。

### 纠偏后最终验证

- `npm test`：19 个测试文件，75/75 通过。
- `npm run build`：通过；仅保留 Vite 主 chunk 超过 500 kB 的既有提示。
- `cargo check --manifest-path src-tauri/Cargo.toml`：退出码 0；仍有 Windows 增量编译
  目录收尾“拒绝访问”警告。
- `npm run tauri -- build`：通过；生成 `mora.exe`、MSI 和 NSIS 安装包。

## 提交前核对（2026-07-29）

- `git diff --stat`、`git diff --check` 与逐文件差异审查：通过；未提交范围仅包括方案 B 的规范路径/Blob 显示投影、PDF 临时单一 WYSIWYG、共享标题规范化、真实 App 到子编辑器集成测试与动态挂卸载、`useResources` 响应式映射修订，以及计划和设计规格同步。
- `npm test -- src/App.editor-integration.test.ts src/components/editor/MoraEditor.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/SourceEditor.test.ts src/composables/useResources.test.ts src/utils/text.test.ts`：通过，6 个测试文件、34/34 项测试。

## 最终复审修复（2026-07-29）

### TDD 证据

- PDF readiness RED：临时 WYSIWYG 的 deferred `whenReady()` 未被 App 调用，打印可以在
  Crepe 初始化前执行；修复后测试验证 resolve 前不调用 `window.print()`、打印期间新实例的
  规范化 emit 不改变正文或脏状态、resolve 后打印且恢复源码视图。
- fenced heading RED：`extractMarkdownHeadings` 缺失，SourceEditor 会定位 ``` fenced
  code 内的 `## 伪标题`；实现共享最小提取函数后，App TOC 仅展示真实 `# 外部`，Source
  不定位伪标题，并覆盖 ``` 与 ~~~ 两种 fence。

### 实现结果

- `MoraEditorHandle.whenReady()`：SourceEditor 立即完成，MilkdownEditor 返回 Crepe
  readiness，MoraEditor 只委托当前可编辑子组件。
- PDF 在 `nextTick()` 后等待 readiness；`printing` guard 在恢复原视图后才解除。
- Task 5/8 计划与设计明确：当前 App 未传 Provider、不发 AI 请求；后续 Provider 必须在
  IPC 前规范化 `AIPromptContext.document` 和 `selection`，Task 8 从 App 传入
  `resourceSession.persistedMarkdown`，验收证明 payload 无 Blob URL。本任务未实现 AI 生产代码。

### 最终验证

- 聚焦：5 个测试文件，36/36 通过。
- `npm test`：19 个测试文件，82/82 通过。
- `npm run build`：通过；仅保留既有大 chunk 提示。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；Windows 增量编译目录收尾仍有
  “拒绝访问”警告，退出码为 0。
- `npm run tauri -- build`：通过；生成 `mora.exe`、MSI 和 NSIS 安装包。

## CommonMark 标题与围栏收尾（2026-07-29）

### TDD 记录

- Tab 缩进 RED：`\t# 标题` 被错误提取，`\t``` ` / `\t~~~` 会错误开启围栏，
  `\t``` ` 也会错误关闭真实围栏。GREEN 后共享提取器只接受 0--3 个普通空格作为
  ATX 标题或围栏的前导缩进；既有 0--3 空格和四空格边界测试保持通过。
- 反引号信息串 RED：```` ```info`invalid ```` 被错误作为反引号围栏开启，继而隐藏真实
  标题。GREEN 后仅拒绝信息串含反引号的反引号围栏；波浪围栏仍允许反引号信息串并正常
  隐藏其围栏内伪标题。

### 验证

- 聚焦：`text`、`SourceEditor`、`App editor integration`，24/24 通过；保持既有 App
  集成测试边界，仅 Mock 最底层 MilkdownEditor/SourceEditor，未改 App 或 MoraEditor 测试。
- `npm test`：19 个测试文件，89/89 通过。
- `npm run build`：通过；仅有既有大 chunk 提示。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；Windows 增量编译目录收尾仍有
  “拒绝访问”警告，退出码为 0。
- `npm run tauri -- build`：通过；生成 `mora.exe`、MSI 和 NSIS 安装包。
