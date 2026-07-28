# Mora Architecture and Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 降低 `App.vue` 和 Rust 单文件耦合，移除私有/废弃 API，建立 CSP、Lint、格式化与前端分包门禁。

**Architecture:** 保留 Toast UI Editor，通过适配层和 Vue 组件隔离编辑器细节；使用 CSS 布局实现源码/预览单栏，不调用私有事件；将纯类型、状态栏、离开对话框和查找界面拆分。

**Tech Stack:** Vue 3、TypeScript、Vite、Vitest、ESLint、Prettier、Tauri 2、Rust

## Global Constraints

- 不删除现有编辑、模式切换、查找替换、资源和保存功能。
- 不调用 Toast UI 私有 `eventEmitter`，不使用 `document.execCommand`。
- CSP 必须允许 Tauri IPC、本地 Blob 图片和内联编辑器样式，但禁止任意远程脚本。
- 每次修改后运行前端构建、Rust 检查和 Tauri 打包。

### Task 1: Editor Adapter and Official APIs

- [ ] 用现有测试作为重构保护。
- [ ] 将 Toast UI 改为动态导入，`initializeEditor()` 返回 Promise。
- [ ] 使用 `changePreviewStyle("vertical")` 与根节点类实现源码/预览单栏。
- [ ] 删除 `EditorWithEmitter`、`setMarkdownTab()` 和 `document.execCommand`。
- [ ] 复制、剪切、粘贴使用 Clipboard API；撤销、重做、全选通过编辑器 `exec()`。
- [ ] 运行 `npm test` 和 `npm run build`，确认 Toast UI 形成独立 JS chunk。

### Task 2: Type and Component Decomposition

- [ ] `App.vue` 改用 `src/types/mdx.ts`，删除重复类型。
- [ ] 创建 `LeaveConfirmDialog.vue`、`StatusBar.vue`、`FindReplacePanel.vue`、`TableOfContents.vue`。
- [ ] 使用 props 与 emit 保留现有行为，不在子组件读取编辑器实例。
- [ ] 运行前端测试和构建。

### Task 3: Lint and Format Gates

- [ ] 安装 ESLint、TypeScript ESLint、Vue ESLint、Prettier。
- [ ] 创建 flat ESLint 配置，禁止显式 `any`，检查 Vue 和 TypeScript。
- [ ] 增加 `lint`、`format`、`format:check` 脚本。
- [ ] 修复全部 lint/format 错误并运行门禁。

### Task 4: CSP and Phase Verification

- [ ] 在 `tauri.conf.json` 配置最小 CSP，允许 `self`、Tauri IPC、`blob:`/`data:` 图片和必要内联样式。
- [ ] 将 CSS 最小宽度与 Tauri 760px 窗口限制对齐。
- [ ] 运行 `npm test`、`npm run lint`、`npm run format:check`、`npm run build`、`cargo test`、`cargo check` 和 `npm run tauri -- build`。
