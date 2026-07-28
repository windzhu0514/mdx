# Mora Markdown 编辑器组件调研记录

> 调研日期：2026-07-21  
> 调研目的：评估 Toast UI Editor 停止活跃开发后的替代方案，并确认哪些组件能够覆盖 Mora 当前的编辑能力。

## 1. 背景

Mora 当前使用 `@toast-ui/editor@3.2.2`。Toast UI Editor 仓库虽然没有被标记为 Archived，但最新正式版本仍是 2023-02-24 发布的 3.2.2，默认分支的主要代码活动也停留在 2023 年，因此应按“事实上停止活跃维护”处理。

参考：

- [Toast UI Editor 仓库](https://github.com/nhn/tui.editor)
- [Toast UI Editor 3.2.2](https://github.com/nhn/tui.editor/releases/tag/editor%403.2.2)

本次调研只讨论编辑器前端内核。以下能力属于 Mora 自身的 Vue/Tauri/Rust 应用层，不应迁移进第三方编辑器：

- 自定义 `.mdx` ZIP 笔记包读写和格式校验。
- `assets/`、`attachments/` 等包内资源管理。
- `.tmp + .bak` 安全保存、草稿恢复和历史快照。
- 标签、笔记库、全文索引、Markdown/PDF 导出。
- Blob URL 与包内相对路径之间的转换。

## 2. Mora 当前编辑能力基线

候选组件至少需要支持或允许通过公开 API 实现以下能力：

1. 所见即所得编辑。
2. Markdown 源码、仅预览和垂直双栏模式。
3. 标题一至六级、粗体、斜体、删除线和行内代码。
4. 引用、无序列表、有序列表、任务列表、缩进、分割线和代码块。
5. 链接、图片、附件引用和表格插入。
6. 图片粘贴、文件拖放和自定义资源处理钩子。
7. Markdown 内容读取、整体设置、选区替换和变更监听。
8. 撤销、重做、复制、剪切、粘贴和全选。
9. 当前文档查找与替换。
10. 光标定位、焦点管理、主题和排版样式定制。
11. 中文输入法、键盘快捷键、760px 窗口和离线 Tauri WebView 环境。
12. 通过公开扩展 API 增加块、节点、命令、快捷键和工具栏，而不是操作内部 DOM。
13. 支持接入 Mora 自己的 AI Provider，实现流式续写、选区改写、翻译和摘要。
14. 支持异步补全和行内建议；若组件没有原生“幽灵文字”，也必须允许通过正式插件实现。

## 3. 主流 Markdown 产品使用的内核

调研结果表明，热门 Markdown 产品没有统一采用某个完整 WYSIWYG 组件。

| 产品     | 编辑器内核              | 主要形态                        |
| -------- | ----------------------- | ------------------------------- |
| Obsidian | CodeMirror 6 + 自研扩展 | Markdown 与 Live Preview        |
| Zettlr   | CodeMirror 6 + 自研渲染 | Markdown 与行内渲染             |
| Joplin   | CodeMirror 6 + TinyMCE  | Markdown 与富文本双引擎         |
| VS Code  | Monaco Editor           | 源码编辑与独立预览              |
| MarkText | 自研 Muya + CodeMirror  | Muya 实时预览与 CodeMirror 源码 |
| 思源笔记 | 自研 Protyle            | 块级所见即所得                  |
| Typora   | 闭源自研                | 实现细节未公开                  |

参考：

- [Obsidian API](https://github.com/obsidianmd/obsidian-api)
- [Zettlr](https://github.com/Zettlr/Zettlr)
- [Joplin](https://github.com/laurent22/joplin)
- [MarkText 架构](https://github.com/marktext/marktext/blob/develop/docs/dev/ARCHITECTURE.md)
- [思源 Protyle](https://github.com/siyuan-note/siyuan/blob/master/app/src/protyle/index.ts)

阶段性判断：

- Markdown-first 产品最常见的基础内核是 CodeMirror 6。
- Typora 风格的完整即时渲染通常需要大量自研能力。
- WYSIWYG 产品常采用 ProseMirror、TinyMCE 或自研块模型，并承担 Markdown 与内部文档模型之间的转换成本。

## 4. 候选组件能力矩阵

说明：

- “原生”表示组件直接提供主要能力。
- “适配”表示可以通过公开 API 和 Mora 自己的适配层实现。
- “组合”表示还需要第二个编辑器或独立渲染器。
- 所有富文本方案都必须额外执行 Markdown 往返保真测试，不能仅凭 `getMarkdown()` API 判断无损。

| 候选方案                | WYSIWYG                    | 源码/双栏/预览                 | AI 与自动补全                                | 插件扩展                 | Markdown 原文模型        | 覆盖当前能力         |
| ----------------------- | -------------------------- | ------------------------------ | -------------------------------------------- | ------------------------ | ------------------------ | -------------------- |
| Vditor                  | 原生                       | 原生三模式，外部菜单切换需验证 | 无正式 AI 层，需从回调和工具栏外围接入       | 以配置、回调和工具栏为主 | Markdown API，可能规范化 | 最接近单组件完整覆盖 |
| Milkdown Crepe          | 原生                       | 缺少源码、双栏和仅预览         | 原生 AI Feature 支持流式 Provider 和差异确认 | ProseMirror 插件体系完整 | Remark/ProseMirror 往返  | 单独使用不能完整覆盖 |
| CodeMirror 6            | 需要自研 Live Preview      | 原生适合                       | 原生异步补全；幽灵文字可用 ViewPlugin 实现   | 扩展机制成熟             | 字符串为唯一文档模型     | 能覆盖，但开发量最大 |
| Milkdown + CodeMirror 6 | 原生                       | 组合实现                       | 改写、续写与源码行内补全均可覆盖             | 两侧均有正式插件机制     | 双文档模型               | 能覆盖，但同步复杂   |
| Tiptap + CodeMirror 6   | 原生                       | 组合实现                       | AI Toolkit 完整但为付费 Beta                 | 扩展生态最成熟           | Markdown 扩展仍为 Beta   | 技术上能覆盖，不优先 |
| Cherry Markdown         | 仅图片、表格等局部 WYSIWYG | 原生源码与预览                 | 有流式渲染和自动补全，缺少统一 AI 编辑层     | 支持插件和二次开发       | Markdown-first           | 不满足完整 WYSIWYG   |
| md-editor-v3 / ByteMD   | 不支持完整 WYSIWYG         | 原生源码与预览                 | 需自行接入                                   | 可扩展                   | Markdown-first           | 不满足完整 WYSIWYG   |

主要参考：

- [Vditor](https://b3log.org/vditor/)
- [Milkdown Crepe](https://milkdown.dev/docs/guide/using-crepe)
- [Milkdown 架构](https://milkdown.dev/docs/guide/architecture-overview)
- [Milkdown Crepe AI](https://milkdown.dev/docs/api/crepe)
- [CodeMirror 6 Decoration](https://codemirror.net/examples/decoration/)
- [CodeMirror 6 自动补全](https://codemirror.net/examples/autocompletion/)
- [CodeMirror 6 文档模型](https://codemirror.net/docs/guide/)
- [Tiptap Markdown](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage)
- [Tiptap AI Toolkit](https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/overview)
- [Tiptap 自定义扩展](https://tiptap.dev/docs/editor/extensions/custom-extensions)
- [Cherry Markdown](https://github.com/Tencent/cherry-markdown)
- [md-editor-v3](https://github.com/imzbf/md-editor-v3)

## 5. 各方案结论

### 5.1 Vditor：最接近当前功能的单组件兼容方案

Vditor 原生提供 WYSIWYG、Typora 风格即时渲染和分屏预览，并具备 Markdown 读取与设置、格式工具栏、表格、任务列表、主题和图片上传钩子。

若目标只是尽快移除 Toast UI 且不降低现有功能，Vditor 仍是投入较小的候选。但它没有 Milkdown、CodeMirror 或 Tiptap 那样清晰的正式插件模型和 AI 编辑抽象，近期发布与合并开发也明显放缓，因此不再作为面向未来的第一候选。正式迁移前必须验证以下风险：

- Mora 外部菜单能否只通过公开 API 切换 WYSIWYG、双栏、源码和预览，不操作组件内部 DOM。
- 当前查找/替换面板能否通过公开的选区和光标 API 精确定位匹配项。
- 模式切换时能否保留撤销栈、选区和滚动位置。
- 图片粘贴和拖放能否全部进入 Mora 的资源会话，不触发网络上传或 Base64 正文内嵌。
- Lute、图标和语言资源必须随应用本地打包，Tauri 离线运行时不能访问 CDN。
- 禁用 Vditor 自带缓存，由 Mora 草稿系统保持唯一所有权。

### 5.2 CodeMirror 6：最稳妥的长期 Markdown 内核

CodeMirror 6 直接以字符串保存文档，最符合 Mora 将 `content.md` 作为权威数据源的设计。源码、双栏、仅预览、查找替换、选区和撤销能力都很成熟。

主要成本是它不提供完整 WYSIWYG。标题、强调、链接、任务框、图片、表格等即时渲染需要通过 Decoration、Widget 和语法树扩展实现。若追求 Obsidian/Typora 级体验，这会成为独立的长期子项目。

### 5.3 Milkdown：Markdown-first 的 WYSIWYG 与 AI 主候选

Milkdown Crepe 已具备可用的 WYSIWYG、表格、任务列表、代码块、图片上传、工具栏和 Markdown 更新监听。

Crepe 的 `AI` Feature 可接入自定义异步生成器 Provider，流式插入 Markdown，并对选区改写显示差异、接受、拒绝和重试。这适合实现续写、润色、翻译和摘要。Copilot 风格的逐字“幽灵文字”更适合放在 CodeMirror 6 源码模式，通过异步补全源或 ViewPlugin/Decoration 实现。

Milkdown 单独使用无法覆盖 Mora 的源码、双栏和仅预览模式。完整覆盖需要搭配 CodeMirror 6 和 Markdown 渲染器，并处理 Markdown、Remark AST 与 ProseMirror 文档之间的往返转换。因此它是组合架构中的 WYSIWYG 主候选，而不是单组件替代品。

### 5.4 暂不优先的方案

- Tiptap：Vue 3、扩展生态和商业维护能力最强，AI Toolkit 也有明确产品路线；但 Markdown 扩展和 AI Toolkit 当前仍为 Beta，AI Toolkit 属于付费能力，并且同样缺少源码/双栏模式。
- Cherry Markdown：适合 Markdown 源码和预览，图片、表格支持局部 WYSIWYG，但不等价于完整文档 WYSIWYG。
- md-editor-v3、ByteMD、Monaco：适合源码/预览，不满足当前完整 WYSIWYG 基线。

## 6. 活跃度、维护积极性与未来发展

### 6.1 评估方法

以下数据是 2026-07-21 的快照。GitHub 项目统计采用最近 12 个月的提交、关闭 Issue 和合并 PR；机器人依赖更新会抬高提交数，因此还检查了最近 100 次提交的作者集中度。活跃度只能反映维护信号，不能替代 API 稳定性、回归保真和 Mora PoC 验收。

| 项目            | Star   | 最近发布                 | 近 12 月提交 | 关闭 Issue | 合并 PR | 维护结构与判断                                                                                    |
| --------------- | ------ | ------------------------ | -----------: | ---------: | ------: | ------------------------------------------------------------------------------------------------- |
| Tiptap          | 37,698 | v3.28.0，2026-07-15      |          845 |        383 |     530 | 公司与商业产品支撑，多位活跃维护者，AI 和协作编辑投入明确；长期可持续性最强                       |
| Cherry Markdown | 4,797  | Client 0.4.0，2026-07-15 |          318 |        177 |     330 | 腾讯组织项目，多位主要贡献者，桌面端、流式渲染和 AI 场景仍在推进                                  |
| Milkdown        | 11,737 | v7.21.3，2026-07-12      |          277 |         54 |     243 | 发布和功能迭代活跃，但最近提交高度集中于一位核心维护者，且包含较多机器人更新，Bus Factor 风险较高 |
| Vditor          | 11,158 | v3.11.2，2025-09-02      |           16 |         41 |       1 | 仍有维护和 Issue 处理，但发布与功能开发明显变慢，维护者集中，更接近维护期                         |

CodeMirror 6 需要单独说明：原 GitHub `codemirror/dev` 仓库在 2026-04-15 归档，是因为开发迁移至自托管仓库，不代表停止维护。官方 npm 包仍持续发布，例如 `@codemirror/view@6.43.6` 发布于 2026-07-06、`@codemirror/lang-markdown@6.5.1` 发布于 2026-07-15。其长期记录、模块边界和生态稳定，但核心维护仍较集中。

数据来源：

- [Milkdown 仓库](https://github.com/Milkdown/milkdown)
- [Tiptap 仓库](https://github.com/ueberdosis/tiptap)
- [Vditor 仓库](https://github.com/Vanessa219/vditor)
- [Cherry Markdown 仓库](https://github.com/Tencent/cherry-markdown)
- [CodeMirror 新开发仓库](https://code.haverbeke.berlin/codemirror/dev)
- [CodeMirror GitHub 迁移说明](https://github.com/codemirror/dev)
- [CodeMirror 更新日志](https://codemirror.net/docs/changelog/)

### 6.2 综合排序

只看维护可持续性与未来投入：

1. Tiptap：组织化和商业化程度最高，AI 产品路线最清晰。
2. CodeMirror 6：成熟、稳定、持续发布，是长期源码编辑基础设施的安全选择。
3. Cherry Markdown：真实开发活跃，中文与桌面场景契合，但功能形态不满足完整 WYSIWYG。
4. Milkdown：技术方向和 Mora 最契合，AI 与插件能力强，但单核心维护者风险必须通过架构隔离控制。
5. Vditor：当前功能契合度高，但未来扩展与维护增长信号最弱。

结合 Mora 的 Markdown-first、完整 WYSIWYG、源码/双栏、AI 和插件要求，推荐顺序不是简单照搬上述维护排名，而是：

1. **开源主路线：Milkdown + CodeMirror 6。** Milkdown 负责 WYSIWYG、选区 AI 和块扩展；CodeMirror 6 负责源码、查找替换、异步补全和幽灵文字；独立 Markdown 渲染器负责预览。
2. **商业支撑备选：Tiptap + CodeMirror 6。** 若可以接受付费 AI、Beta Markdown 转换和更强的 ProseMirror 数据模型依赖，它的维护可持续性最好。
3. **快速兼容兜底：Vditor。** 仅在 PoC 证明单组件迁移成本显著更低，且不把 AI/插件作为核心战略时采用。
4. **观察候选：Cherry Markdown。** 保持关注其完整 WYSIWYG 和 AI 编辑扩展的发展，不作为当前主路线。

### 6.3 降低上游风险的架构措施

- `content.md` 始终是权威数据，不持久化 Milkdown/Tiptap 私有 JSON 文档。
- 通过 `EditorAdapter` 隔离编辑器命令、选区、更新和资源事件。
- AI 使用独立 `AIProvider`，组件只负责显示建议，不绑定模型厂商和密钥存储。
- WYSIWYG 与源码模式不要实时双向维护两个可写状态；切换模式时以 Markdown 快照交接，并做版本/脏状态校验。
- 固定依赖版本，建立 Markdown 往返、中文 IME、资源路径和插件 API 契约测试。
- 禁止直接访问内部 DOM 或私有状态，确保未来可以单独替换 WYSIWYG 层。

## 7. 当前决策

本次调研形成以下阶段性决策：

1. 不继续把新增编辑能力深度绑定到 Toast UI 私有实现。
2. 面向 AI 和插件扩展的第一 PoC 为 Milkdown + CodeMirror 6，而不是 Vditor。
3. CodeMirror 6 作为长期 Markdown 源码内核；Milkdown 作为可替换的 WYSIWYG 层。
4. Tiptap + CodeMirror 6 作为维护可持续性更强、但成本和 Markdown 风险更高的对照 PoC。
5. Vditor 降为低迁移成本兼容兜底，Cherry Markdown 保持观察。
6. 在 PoC 通过前不直接删除 Toast UI，也不修改 `.mdx` 文件格式。
7. 最终迁移必须引入 Mora 自己的 `EditorAdapter`，`App.vue` 不再直接依赖第三方编辑器类型和命令名称。
8. 禁止通过 `querySelector`、模拟点击、事件拦截或延时脚本控制第三方编辑器内部状态；缺少公开 API 时应更换方案、实现正式扩展或向上游贡献 API。

## 8. PoC 验收清单

PoC 应使用同一组 Markdown 样本比较 Milkdown + CodeMirror 6、Tiptap + CodeMirror 6，并将 Vditor 作为迁移成本对照，至少包含：

- 六级标题、粗体、斜体、删除线、行内代码和嵌套引用。
- 有序、无序、嵌套和任务列表。
- GFM 表格、围栏代码块、链接、相对路径图片和附件链接。
- 中文、Emoji、中英文标点、超长段落和大文档。
- 图片粘贴、图片/附件拖放、Blob URL 显示和相对路径持久化。

必须通过以下验收项：

1. Markdown 打开、编辑、保存、重新打开后语义不丢失。
2. 四种 Mora 视图入口都能通过公开 API 实现。
3. 全部菜单命令和快捷键可通过适配层调用。
4. 查找、查找下一个、替换和全部替换行为正确。
5. 模式切换后撤销重做、光标、选区和滚动位置可接受。
6. 中文输入法组合输入不丢字、不跳光标。
7. 图片和附件始终进入 `.mdx` 包内，不产生网络依赖。
8. 浅色、深色、跟随系统主题以及排版偏好正常。
9. 760px 窗口无关键控件遮挡，打印和预览可用。
10. Tauri CSP 下完全离线启动，不动态请求 CDN。
11. 记录首屏加载时间、输入延迟、内存和构建产物体积。
12. 现有前端、Rust、Tauri 打包和回归测试全部通过。
13. AI 流式输出可取消、可撤销，不破坏选区和 Markdown 语法。
14. AI 密钥不进入前端持久化、日志或 `.mdx` 文件；模型调用通过独立 Provider 接口。
15. 源码模式可显示、接受和拒绝异步行内补全，中文输入法组合期间不触发错误建议。
16. 至少实现一个自定义块插件和一个菜单命令插件，验证扩展只依赖公开 API。

## 9. 下一步

建议先建立第三方无关的 `EditorAdapter`、`AIProvider` 契约和 Markdown 回归样本，再实现 Milkdown + CodeMirror 6 主 PoC。对照 PoC 只验证 Tiptap 的 Markdown 往返、AI 成本边界和 Vditor 的单组件迁移成本。最终选择以同一套验收结果为准，不因 Star 数或单次演示效果直接决定。
