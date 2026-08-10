# Mora Mermaid 代码块语言选项设计

**日期：** 2026-08-10
**状态：** 待审核

## 目标

在 Milkdown/Crepe 代码块语言选择列表中增加小写 `mermaid` 选项。用户选中后，规范 Markdown 保存为 `mermaid` 围栏代码块，并继续使用 Mora 现有 Mermaid 预览桥接渲染图表。

## 已确认边界

- 保留 CodeMirror 现有全部默认语言。
- 本次不实现 Mermaid 专用语法高亮，编辑状态按纯文本处理。
- 不新增编辑器组件、渲染器或正文状态。
- 不修改 `.mdx` 文件格式、Rust command、资源保存和 AI 工作流。
- 不访问 Crepe 内部 DOM，不修改第三方依赖源码。

## 当前原因

Crepe 的代码块语言列表来自 `@codemirror/language-data`，其中没有 Mermaid。Mora 当前只配置了 Crepe 的公开 `renderPreview` 钩子；而 Crepe 对用户提供的 `languages` 数组采用整体替换，因此不能只传入单个 Mermaid 描述，否则会丢失默认语言。

## 方案

采用 CodeMirror 官方公开 API：

1. 将 `@codemirror/language` 和 `@codemirror/language-data` 声明为 Mora 的直接依赖。
2. 在 `MilkdownEditor.vue` 中创建名称为小写 `mermaid` 的 `LanguageDescription`。
3. 该描述使用最小 `StreamLanguage`，逐行按纯文本消费，不产生伪造的 Markdown 高亮。
4. 将 Crepe CodeMirror 配置设为默认语言列表加 Mermaid 描述：`[...codeLanguages, mermaidLanguage]`。
5. 保留现有 `renderPreview`、`previewOnlyByDefault` 和 Mermaid 渲染桥接不变。

不采用以下方案：

- 复用 Markdown 语言支持：会把 Mermaid 源码错误地按 Markdown 着色。
- 引入 Mermaid 专用 CodeMirror 解析器：超出“仅增加可选择项”的需求，并增加依赖与维护成本。
- 修改 Crepe 语言选择组件或内部 DOM：违反项目的官方 API 约束。

## 数据流

```text
Crepe 语言列表选择 mermaid
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

- 先在 `MilkdownEditor.test.ts` 增加失败测试，确认 CodeMirror 配置同时保留默认语言并包含小写 `mermaid`。
- 验证 Mermaid 描述提供可加载的纯文本语言支持，且现有预览配置不变。
- 实现后运行聚焦测试和全量 `npm test`。
- 按仓库要求运行 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run tauri -- build`。

## 删减检查

- 不新增模块：单个语言描述由现有 `MilkdownEditor.vue` 直接配置即可。
- 两个直接依赖是源码直接导入所必需；删除任一项都会使默认语言列表追加或官方语言描述无法构建。
- 不增加专用解析器；删除纯文本 `StreamLanguage` 会使 Crepe 语言加载器无法为 `mermaid` 提供合法的 `LanguageSupport`。
