# Mora Mermaid 代码块语言选项设计

**日期：** 2026-08-10
**状态：** 显示与排序调整已确认，待实施

## 目标

在 Milkdown/Crepe 代码块语言选择列表中增加显示名为 `Mermaid` 的选项，并将其放在当前列表的 `Markdown` 与 `MS SQL` 之间。用户选中后，规范 Markdown 仍保存为小写 `mermaid` 围栏代码块，并继续使用 Mora 现有 Mermaid 预览桥接渲染图表。

## 已确认边界

- 保留 CodeMirror 现有全部默认语言。
- 保留所有默认语言的现有相对顺序，不对完整列表重新排序。
- 选择器显示 `Mermaid`，语言别名和 Markdown 围栏标识保持小写 `mermaid`。
- 本次不实现 Mermaid 专用语法高亮，编辑状态按纯文本处理。
- 不新增编辑器组件、渲染器或正文状态。
- 不修改 `.mdx` 文件格式、Rust command、资源保存和 AI 工作流。
- 不访问 Crepe 内部 DOM，不修改第三方依赖源码。

## 当前原因

Crepe 的代码块语言列表来自 `@codemirror/language-data`，其中没有 Mermaid。Mora 当前只配置了 Crepe 的公开 `renderPreview` 钩子；而 Crepe 对用户提供的 `languages` 数组采用整体替换，因此不能只传入单个 Mermaid 描述，否则会丢失默认语言。现有实现使用 `[...codeLanguages, mermaidLanguage]`，导致 Mermaid 显示为小写并位于列表末尾，与相邻默认语言的名称格式和顺序不一致。

## 方案

采用 CodeMirror 官方公开 API：

1. 将 `@codemirror/language` 和 `@codemirror/language-data` 声明为 Mora 的直接依赖。
2. 在 `MilkdownEditor.vue` 中创建名称为 `Mermaid` 的 `LanguageDescription`；CodeMirror 公开 API 会将名称的小写形式加入别名，因此语言标识仍为 `mermaid`。
3. 该描述使用最小 `StreamLanguage`，逐行按纯文本消费，不产生伪造的 Markdown 高亮。
4. 在默认列表中找到第一个按当前名称顺序位于 `Mermaid` 之后的语言，将 Mermaid 插入该位置；当前结果为 `Markdown → Mermaid → MS SQL`。只插入新项，不重排其他默认语言。
5. 保留现有 `renderPreview`、`previewOnlyByDefault` 和 Mermaid 渲染桥接不变。

不采用以下方案：

- 复用 Markdown 语言支持：会把 Mermaid 源码错误地按 Markdown 着色。
- 引入 Mermaid 专用 CodeMirror 解析器：超出“仅增加可选择项”的需求，并增加依赖与维护成本。
- 修改 Crepe 语言选择组件或内部 DOM：违反项目的官方 API 约束。

## 数据流

```text
Crepe 语言列表选择 Mermaid
        ↓
代码块 language 属性写入 mermaid
        ↓
Markdown 序列化为 ```mermaid 围栏
        ↓
现有 renderPreview 识别 mermaid
        ↓
现有 mermaidPreview.ts 生成 SVG
```

## 测试与验证

- 先在 `MilkdownEditor.test.ts` 增加失败测试，确认显示名为 `Mermaid`，别名包含小写 `mermaid`，且顺序满足 `Markdown < Mermaid < MS SQL`。
- 验证调整前的测试因名称或排序不符合要求而失败。
- 验证 Mermaid 描述提供可加载的纯文本语言支持，且现有预览配置不变。
- 实现后运行聚焦测试和全量 `npm test`。
- 按仓库要求运行 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run tauri -- build`。

## 删减检查

- 不新增模块：单个语言描述由现有 `MilkdownEditor.vue` 直接配置即可。
- 不新增通用排序器：只计算单个插入位置即可；全量排序会无必要地改变默认列表中既有语言的相对顺序。
- 两个直接依赖是源码直接导入所必需；删除任一项都会使默认语言列表追加或官方语言描述无法构建。
- 不增加专用解析器；删除纯文本 `StreamLanguage` 会使 Crepe 语言加载器无法为 `mermaid` 提供合法的 `LanguageSupport`。
