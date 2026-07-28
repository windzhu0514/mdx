# Mora 墨笺

Mora 墨笺是一款本地优先、所见即所得的 MDX 扩展笔记编辑器，使用 Tauri 2、Vue 3、TypeScript、Rust 和 Toast UI Editor 构建。

> 本项目中的 `.mdx` 表示自定义的 **MDXNote 笔记包**，与 Web 开发中的 Markdown + JSX（MDX）无关。

## 主要能力

### 编辑体验

- Toast UI 所见即所得编辑、Markdown 源码、预览和垂直双栏模式。
- 标题、标签、文档目录、当前文档查找替换和常用 Markdown 命令。
- 浅色、深色、跟随系统主题，以及字体、字号、行高、阅读宽度偏好。
- 紧凑桌面菜单和状态栏，支持 760px 最小窗口、键盘焦点和减少动态效果。

### 本地笔记与资源

- 新建、打开、保存、另存为自定义 `.mdx` 笔记包。
- 图片粘贴、图片/附件选择和 Tauri 文件拖放，资源保存到包内 `assets/` 或 `attachments/`。
- 正文持久化时始终使用相对路径，显示时映射为临时 Blob URL。
- 本地笔记列表和全文搜索；索引覆盖在 Mora 中打开或保存过的笔记。

### 数据可靠性

- 新建、打开和关闭前提供“保存 / 放弃 / 取消”未保存保护。
- 自动保存恢复草稿，草稿包含尚未写入笔记包的新资源。
- 严格执行 `.tmp + .bak` 安全保存，失败时尝试恢复原文件。
- 覆盖保存时自动创建历史快照，包内最多保留 20 份，可从界面恢复。
- 保存前验证新 ZIP，打开时校验格式、版本、路径、重复条目、条目数和解压体积。

### 导出

- 导出 Markdown 正文及同名资源目录，并重写资源路径。
- 通过系统打印对话框导出 PDF，使用专用打印样式。

## MDXNote 文件格式

`.mdx` 本质是 ZIP 压缩包。标准结构如下：

```text
note.mdx
├── manifest.json
├── meta.json
├── content.md
├── assets/
├── attachments/
├── thumbnails/
├── history/        # 可选，自动历史快照
└── exports/        # 可选，兼容保留目录
```

`content.md` 中的资源引用必须使用包内相对路径：

```markdown
![图片](assets/image.png)
[附件](attachments/file.pdf)
```

打开文件时会验证：

- `manifest.json.format === "MDXNote"`。
- 格式主版本为当前支持的 v1，且不允许加密包。
- 必需条目唯一，所有 ZIP 路径均为安全的包内相对路径。
- 最多 4096 个条目；文本条目最大 16 MiB；单个资源最大 512 MiB；总解压体积最大 2 GiB。

旧版 v1 笔记无需迁移即可打开；缺少的新元数据字段会使用默认值。

## 本地数据

笔记正文和资源只保存在用户选择的 `.mdx` 文件中。以下应用状态保存在 Tauri 应用数据目录：

- 自动恢复草稿。
- 最近打开列表。
- 已打开或保存笔记的全文索引。

主题和排版偏好保存在 WebView 的本地存储中。当前版本不包含云同步、多人协作或加密。

## 环境要求

Windows 桌面开发需要：

1. Node.js 和 npm。
2. Rust 和 Cargo，建议通过 `rustup` 安装。
3. Microsoft Visual Studio Build Tools，包含 MSVC 和 Windows SDK。
4. WebView2 Runtime。

## 开发

```bash
npm install

# Web 前端预览；Tauri 专属初始化会自动跳过
npm run dev

# 启动桌面开发环境
npm run tauri -- dev
```

## 测试与质量门禁

```bash
npm test
npm run lint
npm run format:check
npm run build

cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

npm run tauri -- build
```

任何代码修改都应至少运行前端构建、Rust 静态检查和 Tauri 打包；完整验收使用上面的全部命令。

## 构建产物

成功打包后，Windows 产物通常位于：

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

## 目录结构

```text
src/                         Vue 3 前端
  App.vue                    主应用编排
  components/                面板、状态栏、目录、标签等组件
  composables/               资源、草稿、偏好等状态逻辑
  utils/                     快捷键、路径、标签、离开守卫

src-tauri/src/               Rust / Tauri 后端
  lib.rs                     Commands 与笔记包读写编排
  archive_security.rs        ZIP 与版本安全校验
  draft_store.rs             草稿存储
  history.rs                 历史快照
  note_index.rs              本地笔记索引与搜索
  resource_import.rs         图片和附件导入
  export.rs                  Markdown 导出

docs/                        需求、设计和分阶段实施计划
```

## 技术文档

- [Markdown 编辑器组件调研与迁移决策](docs/research/2026-07-21-markdown-editor-component-evaluation.md)：记录 Toast UI Editor 后续替代方案、能力矩阵、阶段性决策和 PoC 验收标准。

## 当前限制

- 全文索引不会扫描任意磁盘目录，只包含在 Mora 中打开或保存过的笔记。
- 资源读写已有严格体积限制，但当前仍采用内存缓冲和 Base64 传输，不适合超大附件。
- PDF 导出依赖系统打印能力，不内置独立 PDF 渲染器。
- 加密、云同步、全文目录扫描和移动端支持仍为后续扩展方向。
