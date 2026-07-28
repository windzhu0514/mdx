# Mora Product Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Follow TDD for every behavior.

**Goal:** 增加附件、标签、笔记索引与全文搜索、历史版本、Markdown 和 PDF 导出。

**Architecture:** 文件读取、索引、历史和导出全部由 Rust Tauri commands 实现；前端只维护编辑会话和展示状态。搜索索引位于应用数据目录，历史快照位于 `.mdx/history/`。

### Task 1: Attachment Import

- [ ] 测试 MIME 推断、UUID 包内名称和大小限制。
- [ ] 实现 `import_resource` command，返回 Base64 资源数据。
- [ ] 前端增加附件选择和 Tauri 文件拖放；图片插入图片语法，其他文件插入链接语法。
- [ ] 保存后写入 `meta.assets` 或 `meta.attachments`。

### Task 2: Tags

- [ ] 测试标签规范化、去重和数量限制。
- [ ] 增加标签编辑组件，更新 `meta.tags` 并标记文档为未保存。

### Task 3: Note Index and Full-text Search

- [ ] 测试索引更新、损坏索引回退和搜索排序。
- [ ] 保存/打开时更新应用数据目录索引。
- [ ] 实现 `search_notes` 和 `list_notes` commands。
- [ ] 增加笔记列表与全文搜索面板，点击结果打开笔记。

### Task 4: History

- [ ] 测试保存时创建快照、快照上限和恢复。
- [ ] 每次覆盖保存前把旧标题、正文和元数据写入 `history/<timestamp>.json`，最多保留 20 份。
- [ ] 实现历史列表和恢复 command，并增加前端历史面板。

### Task 5: Export

- [ ] 测试 Markdown 导出目录结构和资源复制。
- [ ] 实现 Markdown 导出 command，输出 `.md` 和 `<name>_files/`。
- [ ] 增加打印样式并调用系统打印完成 PDF 导出。
- [ ] 执行全套测试、Lint、格式、构建和桌面打包。
