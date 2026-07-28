# Task 3 Report: Milkdown/Crepe 编辑器

## 实现

- 新增 `src/components/editor/MilkdownEditor.vue`，使用 Crepe 7.21.3 管理可编辑/只读生命周期。
- 通过 `markdownUpdated` 发出受控的 `update:modelValue`；父级更新通过 `replaceAll` 写入编辑器。
- 公开 `MoraEditorHandle` 的焦点、选区、替换、光标和格式化命令；命令仅通过 Milkdown action/context 或 ProseMirror 公共 API 调用。
- 图片仅配置 Crepe `ImageBlock.onUpload` 并委托 `uploadImage`；AI 仅在传入 provider 时启用 `Crepe.Feature.AI`，错误通过 `ai-error` 发出。
- 任务列表通过 `getMarkdown` 与单次 `replaceRange` 处理，不读取编辑器 DOM。

## TDD 证据

1. RED：先创建 `MilkdownEditor.test.ts`，执行 `npm test -- src/components/editor/MilkdownEditor.test.ts`。
   - 预期失败：`Failed to resolve import "./MilkdownEditor.vue"`，因为组件不存在。
2. GREEN：实现最小组件后，同一命令通过：`2 passed`。
3. 类型修正：构建发现 `$Command` 应传入 `commands.call(command.key)`，而 `undo`、`redo`、`selectAll` 为 ProseMirror `(state, dispatch)` 命令；按 7.21.3 声明修正后组件测试仍为 `2 passed`。

测试验证了组件自身的初始输入、Crepe 创建/只读/销毁、编辑器 Markdown 输出、父级 Markdown 同步，以及暴露的选区替换、光标、标题和任务列表操作。Crepe mock 仅隔离第三方编辑器/DOM 边界。

## 验证结果

- `npm test -- src/components/editor/MilkdownEditor.test.ts`：通过，2/2。
- `npm run build`：通过。
- `npm test`：通过，17 个文件、53 个测试。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；Rust 产生一个 Windows 增量编译目录拒绝访问 warning，但检查成功完成。
- `npm run tauri -- build`：通过；生成 exe、MSI 和 NSIS 安装包。

## 文件清单

- `src/components/editor/MilkdownEditor.vue`：Crepe 编辑器组件。
- `src/components/editor/MilkdownEditor.test.ts`：组件行为测试。
- `.superpowers/sdd/task-3-report.md`：本报告。

## 自审与关注点

- 已确认 7.21.3 的 Crepe AI、图片上传、action、上下文和命令导出与实现匹配。
- 未使用 `any`、`querySelector`、内部 DOM 操作或 `setTimeout` 补丁。
- 本任务不迁移 `App`/`MoraEditor`，不实现 Rust AI，也不引入 Web MDX/JSX 语义。
