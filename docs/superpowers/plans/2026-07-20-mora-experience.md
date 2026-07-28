# Mora Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and frontend-design.

**Goal:** 提供浅色/深色主题、阅读排版偏好、响应式窗口和完整键盘可访问性。

**Design tokens:** 冷纸白 `#f5f7f8`、深靛墨 `#17232d`、青黛 `#187f86`、雾灰 `#687681`、夜墨 `#11181e`。界面字体使用 Segoe UI/微软雅黑，阅读字体可切换霞鹜文楷/宋体回退，代码使用 Cascadia Code。

### Task 1: Preferences

- [ ] 测试偏好值归一化、持久化和系统主题解析。
- [ ] 实现主题、字体、字号、行高、内容宽度和目录默认状态。
- [ ] 增加设置面板与视图菜单入口。

### Task 2: Visual System

- [ ] 重构 CSS 变量，增加浅色与深色 token。
- [ ] 样式化标签、搜索、历史、设置和状态面板。
- [ ] 标题聚焦使用单一墨迹线作为品牌识别。

### Task 3: Responsive and Accessibility

- [ ] 移除 CSS 强制最小宽度，小窗口收起目录和模式文字。
- [ ] 为按钮、目录项、菜单和对话框增加可见焦点。
- [ ] 使用按钮代替不可聚焦点击元素，增加 aria-live 和语义标签。
- [ ] 尊重 `prefers-reduced-motion`。

### Task 4: Final Verification

- [ ] 执行全部前端/Rust 测试、Lint、格式、构建和安装包打包。
- [ ] 审计设计文档中每项需求，确认没有遗漏。
