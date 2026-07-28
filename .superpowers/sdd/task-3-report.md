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

## 生命周期竞态修复（审查后追加）

- 问题：`CrepeBuilder.create()`/`destroy()` 解析底层 `Editor` Promise；原实现未等待 create 即处理外部 `modelValue` 或 destroy，存在 action/destroy 与初始化并发的竞态。
- 最小修复：增加一个 `readiness: Promise<void>`、`ready`、`disposed` 与当前实例比较。create 完成后仅对仍是当前且未释放的实例设置 ready，并一次性应用最新 `modelValue`；卸载将 destroy 串到 readiness 后。create/destroy 的 rejection 都通过 `.catch(reportLifecycleError)` 显式报告，未使用裸 `void` 或静默吞错。
- 保持既有 API、命令和配置不变；没有新增 service、adapter、计时器或 DOM 补丁。

### 生命周期 TDD 证据

1. RED：先在 `src/components/editor/MilkdownEditor.test.ts` 新增 deferred-create 测试，运行 `npm test -- src/components/editor/MilkdownEditor.test.ts`。
   - 失败 1：create 未完成时，旧 watcher 已调用 `replaceAll` 两次（过期值与最新值）。
   - 失败 2：create 未完成即卸载时，旧实现已调用 `destroy` 一次。
2. GREEN：实现 readiness 串行化与守卫后，同一覆盖测试通过，5/5。
   - 验证 create 前不调用 action，create 后只以一次 `replaceAll` 应用最新 Markdown。
   - 验证 destroy 仅在 create settle 后调用一次，测试结束无未处理 Promise。
   - 新增空选区 taskList 覆盖：仅以一次 `replaceRange` 在光标插入 `- [ ] `。
3. 类型修正：`destroy()` 解析为 `Editor`，将销毁回调显式 `await` 以维持 `readiness: Promise<void>`；`npm run build` 通过。

### 生命周期修复验证结果

- `npm test -- src/components/editor/MilkdownEditor.test.ts`：通过，5/5。
- `npm test`：通过，17 个文件、56 个测试。
- `npm run build`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；同样仅有 Windows 增量编译目录拒绝访问 warning。
- `npm run tauri -- build`：通过，生成 exe、MSI 和 NSIS 安装包。

## rejection 与旧实例守卫证据（复审后追加）

- 覆盖文件：`src/components/editor/MilkdownEditor.test.ts`。
- 新增 create rejection 回归：deferred `create()` reject 后，断言 `console.error("Crepe 初始化失败", error)` 被调用；随后更新 `modelValue` 不调用 `editor.action`。
- 新增 destroy rejection 回归：create 已成功后卸载，deferred `destroy()` reject；flush 后断言 `console.error("Crepe 销毁失败", error)` 被调用且测试正常完成，证明 rejection 已被承接。
- 新增旧实例回归：卸载后手动触发捕获的 `markdownUpdated`，断言既不 emit 也不更新父级 Markdown。

### 本轮 TDD/验证记录

- 测试先行命令：`npm test -- src/components/editor/MilkdownEditor.test.ts`。
- 该测试首跑输出为 `Test Files 1 passed`、`Tests 8 passed`：复审已确认上一提交的 `disposed`/实例 guard 与 `.catch(reportLifecycleError)` 实现正确，因此没有通过破坏已验证的生产代码来人为制造 RED；本轮只补足独立回归证据。
- GREEN 复跑同一命令：`Test Files 1 passed`、`Tests 8 passed`。
- `npm test`：通过，17 个文件、59 个测试。
- `npm run build`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；仅有 Windows 增量编译目录拒绝访问 warning。
- `npm run tauri -- build`：通过，生成 exe、MSI 和 NSIS 安装包。
