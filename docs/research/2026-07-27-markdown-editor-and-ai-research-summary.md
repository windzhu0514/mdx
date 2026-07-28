# Mora Markdown 编辑器与 AI 能力调研总结

> 调研日期：2026-07-27  
> 适用项目：Mora 墨笺  
> 文档性质：阶段性选型结论与 PoC 输入，不代表已完成编辑器迁移

## 1. 调研范围

本次调研围绕以下问题展开：

1. Mora 是什么工具，当前使用什么编辑器内核。
2. 哪些产品正在使用 Milkdown。
3. Notion、Obsidian 分别采用什么编辑模型或编辑器内核。
4. 除 Milkdown、CodeMirror 6、Toast UI Editor 外，还有哪些主流 Markdown 编辑器核心。
5. Milkdown、CodeMirror 6、Toast UI Editor、Tiptap 哪些更适合 Mora。
6. Tiptap 为什么值得关注，以及它对 Markdown-first 产品的风险。
7. Milkdown 的 WYSIWYG AI 与源码模式 AI 应该如何实现。

本总结继承并补充
[2026-07-21 Markdown 编辑器组件调研记录](./2026-07-21-markdown-editor-component-evaluation.md)。
原文保留候选矩阵、活跃度快照和完整 PoC 验收清单；本文集中记录 2026-07-27
新增结论和最终建议。

## 2. 项目与当前实现

### 2.1 Mora 简介

Mora 墨笺是一款本地桌面 MDX 扩展笔记编辑器，目标是提供类似 Typora
的所见即所得 Markdown 编辑体验，同时像 Word 一样，将正文、图片、附件和其他资源封装在单个
`.mdx` 文件中。

Mora 的 `.mdx` 是自定义 MDXNote ZIP 容器，与 Web 开发中的 Markdown + JSX
完全无关。包内以 `content.md` 保存正文，并使用 `assets/`、`attachments/`
等相对路径引用资源。

### 2.2 当前编辑器核心

当前项目使用：

- Tauri 2
- Vue 3 + TypeScript + Vite
- Rust
- `@toast-ui/editor@3.2.2`

`src/App.vue` 直接创建 Toast UI Editor，并调用其公开 API 切换 WYSIWYG、
Markdown 和垂直预览模式。当前版本应继续保持可发布，不能在 PoC 完成前直接移除 Toast UI。

阶段性判断：

- Toast UI 目前能覆盖 Mora 已实现的基础模式，适合维持现有版本。
- Toast UI 3.2.2 长期缺少活跃版本迭代，不适合作为新增 AI、插件和块编辑能力的长期承载层。
- 新功能不应继续依赖 Toast UI 内部 DOM、内部 CSS 类名或私有状态。

## 3. 不同产品的编辑器模型

### 3.1 Milkdown 的实际使用案例

可确认或公开声明使用 Milkdown 的案例包括：

| 产品或项目 | 使用方式 | 对 Mora 的参考价值 |
| --- | --- | --- |
| TagSpaces | 内置 Markdown 编辑器基于 Milkdown | 已有本地文件、Front Matter、表格、数学公式和媒体场景 |
| MarkBun | Milkdown WYSIWYG + CodeMirror 源码模式 | 与 Mora 的候选双引擎架构高度相似 |
| Simple MD | Milkdown/ProseMirror WYSIWYG + CodeMirror 6 源码 | 证明双引擎桌面 Markdown 工具是现实路线 |
| Milkdown VS Code 扩展 | 在 VS Code 中提供 WYSIWYG Markdown | 证明 Milkdown 可嵌入已有桌面编辑环境 |
| Milkdown 官方 examples | Vue、React、Svelte、OpenAI Copilot、协作等示例 | 适合验证插件和框架集成，不等于生产级完整方案 |

另有 NyaMark、Blog Buddy、GeekDown 等社区项目采用 Milkdown，但社区项目的活跃度、
完成度和长期维护不稳定，只能作为实现参考，不能作为技术选型的主要证据。

结论：Milkdown 已有真实产品使用，但生态规模仍明显小于 CodeMirror、ProseMirror/Tiptap。
它的优势不是“采用者最多”，而是 Markdown-first WYSIWYG、开放插件体系和 Mora
需求之间的匹配度较高。

### 3.2 Obsidian

Obsidian 官方开发文档确认其底层文本编辑器使用 CodeMirror。当前主要编辑体验是
CodeMirror 6 加自研 Markdown 扩展：

- Source mode 直接编辑 Markdown。
- Live Preview 在源码编辑器上隐藏或装饰部分 Markdown 标记。
- Reading view 使用独立 Markdown 渲染链路。

Obsidian 不是 Milkdown、Tiptap 或 Toast UI Editor。它证明 CodeMirror 6
适合作为长期 Markdown 源码内核，但不能证明“只接入 CodeMirror 6
就能低成本获得 Typora 级 WYSIWYG”；Live Preview 仍需要大量自研扩展。

### 3.3 Notion

Notion 没有公开确认采用 Milkdown、Tiptap、ProseMirror 或 Slate
作为完整编辑器核心。官方 API 显示其页面内容以块和块内 rich text 对象表示，
因此可以确认它是块数据模型，而不是以 Markdown 字符串作为权威文档模型。

对 Notion 前端内部框架的判断只能来自公开技术文章或行为观察，不能将
“可能基于 React”进一步推断为“使用某个开源富文本内核”。

对 Mora 的启示：

- Notion 式块交互可以借鉴。
- Notion 的块模型不能直接照搬，因为 Mora 必须保持 `content.md`
  作为可移植、可读、可恢复的权威内容。

## 4. 主流编辑器核心分类

### 4.1 Markdown-first WYSIWYG

- Milkdown：ProseMirror + Remark，插件驱动，Markdown-first。
- Vditor：WYSIWYG、即时渲染、分屏预览三种形态较完整。
- Toast UI Editor：WYSIWYG + Markdown + Preview，Mora 当前方案。
- Muya：MarkText 使用过的即时渲染 Markdown 编辑器核心。
- Wysimark：面向 Markdown 输出的富文本编辑器。

### 4.2 通用富文本或块编辑框架

- ProseMirror：底层文档模型和事务系统，能力强但开发门槛高。
- Tiptap：ProseMirror 的 headless 上层框架，Vue 3 支持和扩展生态成熟。
- Lexical：Meta 维护，适合结构化富文本和自定义节点。
- Slate：React 生态的可编程富文本框架。
- BlockNote：基于 Tiptap/ProseMirror 的块编辑体验。
- CKEditor、TinyMCE：完整传统富文本产品，Markdown-first 适配成本较高。

### 4.3 源码编辑器

- CodeMirror 6：模块化、轻量、扩展体系成熟，最适合 Mora 的 Markdown 源码模式。
- Monaco Editor：VS Code 编辑器核心，能力完整但更重。
- Ace：成熟源码编辑器，现代扩展能力和 Markdown 产品案例不如 CodeMirror 6。

### 4.4 源码加预览型 Markdown 编辑器

- Cherry Markdown
- ByteMD
- md-editor-v3
- EasyMDE

这些方案适合 Markdown 源码、工具栏和预览，但不等价于完整文档 WYSIWYG。

## 5. 核心候选对比

| 方案 | 最适合承担的职责 | 主要优势 | 主要风险 |
| --- | --- | --- | --- |
| Toast UI Editor | 维持当前发布版本 | 已集成，三种基础视图可用 | 维护停滞，扩展和 AI 上限较低 |
| Milkdown/Crepe | WYSIWYG 主编辑层 | Markdown-first、Vue 3、插件和 Crepe AI | 没有整篇 Markdown 源码模式，双模型往返需要验证 |
| CodeMirror 6 | Markdown 源码层 | 字符串权威模型、查找替换、补全和装饰能力成熟 | 不提供完整 WYSIWYG |
| Tiptap | WYSIWYG 对照与长期备选 | Vue 3、生态、组织维护、AI/协作路线强 | 内部 JSON/ProseMirror 模型更强势，Markdown 包仍为 Beta |
| Vditor | 单组件低迁移成本对照 | 三模式覆盖接近 Toast UI | 插件与 AI 抽象较弱，长期活跃度一般 |

这里的 CodeMirror 6 指整篇 `content.md` 的源码编辑器。Crepe 中名为
`CodeMirror` 的 Feature 只用于代码块编辑和高亮，不代表 Crepe
自带整篇 Markdown Source mode。

## 6. Tiptap 为什么值得关注

Tiptap 值得关注的原因不是“它天然最适合 Markdown”，而是其工程生态和长期可持续性明显增强：

1. Tiptap 3 已发布稳定版。
2. 官方提供 `@tiptap/vue-3`，与 Mora 的 Vue 3 技术栈直接匹配。
3. Drag Handle、Emoji、Math、File Handling 等更多扩展已经开源。
4. `@tiptap/markdown` 提供 Markdown 与 Tiptap JSON 的双向解析和序列化。
5. 官方持续投入 AI Toolkit、协作、文档转换和服务端能力。
6. 公司化维护、文档、模板和商业支持降低了单维护者项目的持续性风险。

但 Tiptap 仍不是 Mora 当前的第一推荐：

- Tiptap 推荐的核心文档形态是 Tiptap JSON/ProseMirror 文档，而 Mora
  要求 `content.md` 是唯一权威。
- `@tiptap/markdown` 当前官方仍标记为 Beta。
- Markdown 往返可能规范化空行、列表缩进、序号、强调符号、转义和 HTML。
- Front Matter、特殊容器、自定义语法、相对资源路径必须单独扩展和测试。
- AI Toolkit 是付费 Beta 附加项，不能作为 Mora 开源或离线 AI
  架构的必要依赖。

因此：

- Milkdown + CodeMirror 6 是主 PoC。
- Tiptap + CodeMirror 6 是必须保留的对照 PoC。
- 若 Milkdown 的维护风险、Vue 集成成本或 Markdown 往返结果不达标，
  Tiptap 是最有价值的替补 WYSIWYG 层。

## 7. Milkdown 与双模式 AI

### 7.1 WYSIWYG 模式

Milkdown Crepe 当前提供可选的 AI Feature，包含：

- AI 工具栏入口和指令面板。
- 润色、语法修复、语气调整、翻译等指令。
- 流式输出。
- 修改差异预览。
- 接受或拒绝 AI 修改。
- 自定义 Provider，以及内置的 OpenAI、Anthropic Provider。

Milkdown 官方也提供过简单 Copilot 示例：通过 ProseMirror 插件读取光标前内容，
调用 AI，以 Decoration 显示建议，并将返回的 Markdown 解析为
ProseMirror 节点后插入。

因此，Milkdown WYSIWYG 层可以支持续写、改写、翻译、总结和差异确认。
但模型密钥、Provider 选择、网络请求、错误恢复和隐私策略仍应由 Mora
自己的应用层管理。

### 7.2 源码模式

Milkdown 本身没有整篇 Markdown 源码模式，所以不能说
“Milkdown 原生支持源码模式 AI”。

源码模式应由独立的 CodeMirror 6 实现：

- 获取精确 Markdown 选区、光标和字符偏移。
- 使用异步 CompletionSource 提供候选补全。
- 使用 ViewPlugin、Decoration 和 Widget 显示幽灵文字或建议。
- 通过 CodeMirror Transaction 一次性接受或拒绝修改。
- 将一次 AI 修改保持为一次可撤销操作。

适合优先实现的源码 AI：

1. 选区润色。
2. 改写、翻译、扩写、缩写。
3. 当前段落总结。
4. 光标处续写。
5. Tab 接受、Esc 拒绝的幽灵文字。

### 7.3 统一 AI 架构

推荐结构：

```text
Milkdown WYSIWYG ── MilkdownAIAdapter ─┐
                                      ├─ AICommandService ─ AIProvider
CodeMirror 源码 ─── CodeMirrorAIAdapter ┘
```

公共层负责：

- AI 指令和提示词。
- 模型 Provider 抽象。
- 上下文裁剪和 token 预算。
- 请求取消、超时、错误和重试。
- 隐私、密钥和日志策略。

编辑器适配器分别负责：

- 获取当前编辑器的选区和上下文。
- 展示流式建议。
- 接受、拒绝和撤销。
- 将结果通过各自的正式事务 API 写回。

不能直接共享 Milkdown 和 CodeMirror 的数值位置：

- Milkdown 使用 ProseMirror 文档位置。
- CodeMirror 使用 Markdown 字符偏移。

每个适配器应保存自己的选区书签和文档版本。AI 返回后先验证文档没有发生冲突，
再由原适配器应用结果。

流式输出不宜逐 token 写入正文，否则会造成撤销栈碎裂、选区漂移和语法中间态。
更稳妥的方式是先用 Decoration、Widget 或差异面板展示，用户确认后一次事务写入。

## 8. Mora 的阶段性决策

1. 当前正式版本继续使用 Toast UI Editor，PoC 通过前不删除。
2. `content.md` 始终是唯一权威内容，不持久化 Milkdown/Tiptap 私有 JSON。
3. 长期目标为：
   - Milkdown/Crepe：WYSIWYG。
   - CodeMirror 6：整篇 Markdown 源码。
   - 独立 Markdown Renderer：只读预览和垂直预览。
4. 两个可写编辑器不做逐键实时双向同步；仅在模式切换时交换 Markdown 快照。
5. 在迁移第三方编辑器前先建立 `EditorAdapter`，避免 `App.vue`
   直接依赖厂商类型和命令。
6. AI 先建立第三方无关的 `AIProvider` 和 `AICommandService`。
7. WYSIWYG 与源码模式分别使用自己的 AI Adapter，共享 Provider、提示词和设置。
8. Tiptap + CodeMirror 6 作为对照 PoC，重点评估 Markdown 往返和维护成本。
9. Vditor 只作为单组件迁移成本对照，不作为 AI-first 主路线。
10. `.mdx` 的 ZIP 结构、资源相对路径和 `.tmp + .bak`
    保存流程不因编辑器迁移而改变。

## 9. 推荐实施顺序

### 阶段一：建立中立契约

- 定义 `EditorAdapter`。
- 定义 `AIProvider`、`AICommandService` 和取消协议。
- 建立 Markdown 回归样本。
- 固定资源路径、Front Matter、GFM 和自定义语法用例。

### 阶段二：主 PoC

- Milkdown/Crepe WYSIWYG。
- CodeMirror 6 源码编辑。
- 独立预览渲染。
- 模式切换时 Markdown 快照交接。
- 两种模式都实现选区改写、翻译和总结。

### 阶段三：对照 PoC

- 用相同样本验证 Tiptap + CodeMirror 6。
- 记录 Markdown 规范化差异、扩展工作量、包体积和输入性能。
- 验证不购买 Tiptap AI Toolkit 时，自有 AIProvider 的实现边界。

### 阶段四：高级 AI

- CodeMirror 幽灵文字和异步续写。
- Milkdown 流式续写和差异确认。
- 文档版本冲突检测。
- 上下文预算、隐私过滤和取消恢复。

### 阶段五：迁移决策

仅在同一套验收用例通过后选择最终 WYSIWYG 层。迁移必须保留：

- 当前全部菜单和快捷键。
- WYSIWYG、源码、只读预览和垂直预览。
- 图片和附件资源会话。
- 中文输入法。
- 撤销、选区、光标和滚动体验。
- 离线 Tauri CSP。
- `.mdx` 格式及安全保存。

## 10. 关键验证项

除原评估文档中的完整 PoC 清单外，本次新增强调：

1. Crepe 的 `CodeMirror` Feature 不能误判为整篇 Markdown Source mode。
2. Milkdown AI Feature 必须能够替换为 Mora 自有 Provider。
3. AI 密钥不得进入前端持久化、日志或 `.mdx`。
4. 中文 IME 组合输入期间不得触发错误补全或接受幽灵文字。
5. AI 请求返回时必须检查文档版本，防止覆盖用户的新编辑。
6. AI 修改必须可以一次撤销。
7. Markdown 往返必须覆盖 Front Matter、GFM 表格、嵌套列表、HTML、
   代码围栏、相对图片和附件路径。
8. Milkdown 与 Tiptap 都不能以演示页面效果代替 Markdown
   保存、重开和资源持久化验证。

## 11. 参考资料

### Milkdown

- [Milkdown 官方仓库](https://github.com/Milkdown/milkdown)
- [Milkdown Crepe 使用指南](https://milkdown.dev/docs/guide/using-crepe)
- [Milkdown Crepe API](https://milkdown.dev/docs/api/crepe)
- [Milkdown Vue 3 集成](https://milkdown.dev/docs/recipes/vue)
- [Build Your Own Milkdown Copilot](https://milkdown.dev/blog/build-your-own-milkdown-copilot)
- [Milkdown 官方示例](https://github.com/Milkdown/examples)
- [TagSpaces Markdown Editor](https://docs.tagspaces.org/extensions/md-editor/)
- [MarkBun](https://markbun.com/)
- [Simple MD](https://simple-md.robrighter.com/)

### CodeMirror 与产品内核

- [CodeMirror 6 Reference Manual](https://codemirror.net/docs/ref/)
- [CodeMirror 6 Autocompletion](https://codemirror.net/examples/autocompletion/)
- [CodeMirror 6 Decoration](https://codemirror.net/examples/decoration/)
- [Obsidian Editor 开发文档](https://docs.obsidian.md/Plugins/Editor/Editor)
- [Notion Block API](https://developers.notion.com/reference/block)
- [Notion Rich Text API](https://developers.notion.com/reference/rich-text)

### Tiptap

- [Tiptap 3 Stable](https://tiptap.dev/blog/release-notes/tiptap-3-0-is-stable)
- [Tiptap Vue 3](https://tiptap.dev/docs/editor/getting-started/install/vue3)
- [Tiptap Markdown Editor API](https://tiptap.dev/docs/editor/markdown/api/editor)
- [Tiptap 双向 Markdown 支持](https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap)
- [Tiptap AI Toolkit](https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/overview)

## 12. 最终结论

Mora 不应在 Milkdown、CodeMirror 6 和 Tiptap 中选择一个组件承担所有职责。
当前最合理的目标架构是：

> Milkdown/Crepe 负责 Markdown-first WYSIWYG，CodeMirror 6
> 负责源码和源码 AI，独立 Renderer 负责预览，Mora 自己的
> EditorAdapter 与 AIProvider 隔离所有第三方实现。

Tiptap 的生态、Vue 3 支持、组织维护和 AI 路线使其成为值得认真验证的备选；
Milkdown 与 Mora 的 Markdown-first 目标更接近，因此仍作为主 PoC。
最终选择必须由相同 Markdown 回归样本和桌面验收结果决定，而不是由 Star 数、
官方演示或单项 AI 功能决定。
