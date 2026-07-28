# AGENTS.md — Mora 墨笺

> 本文件是 AI 编码助手（Antigravity / Copilot / Cursor 等）的全局系统指南。
> 所有 Agent 在修改本仓库代码前，**必须完整阅读本文件**。

---

## 项目概述

**Mora 墨笺** 是一款本地桌面 MDX 扩展笔记编辑器。

- **Slogan**：Mora 墨笺，一款所见即所得的 MDX 扩展笔记编辑器。
- **核心目标**：类似 Typora 的 WYSIWYG Markdown 编辑体验，同时像 Word 一样将图片、附件等资源全部封装在单个 `.mdx` 文件内。

---

## 技术栈

| 层级            | 技术                      |
| --------------- | ------------------------- |
| 桌面框架        | Tauri 2                   |
| 前端框架        | Vue 3 + TypeScript + Vite |
| 系统后端        | Rust                      |
| Markdown 编辑器 | Toast UI Editor           |

---

## 项目目录结构

```
src/                         # Vue 前端
  App.vue                    # 主界面：菜单、编辑器、打开/保存交互
  style.css                  # 全局样式
  main.ts                    # Vue 入口
  env.d.ts                   # 前端类型声明

src-tauri/                   # Tauri / Rust 后端
  src/
    lib.rs                   # Tauri commands、.mdx 读写逻辑
    main.rs                  # Tauri 应用入口
  tauri.conf.json            # Tauri 配置

docs/
  doc.md                     # 原始需求文档
```

---

## .mdx 文件格式规范

> ⚠️ `.mdx` 是 Mora 的**自定义 MDXNote 格式**，与 Web 开发中的 Markdown + JSX（`.mdx`）**完全无关**，严禁混淆。

`.mdx` 本质是一个 **ZIP 压缩包**，内部结构必须包含：

```
manifest.json      # 格式声明，打开时必须校验
meta.json          # 笔记元数据
content.md         # Markdown 正文
assets/            # 图片资源
attachments/       # 附件
thumbnails/        # 缩略图
```

### manifest.json 校验规则

打开 `.mdx` 时**必须**校验以下条件，任一失败则拒绝打开：

- `format === "MDXNote"`
- `formatVersion` ≤ 当前支持的最高版本
- 第一版**不支持** `encrypted: true`

### meta.json 字段

元数据字段包含（不限于）：

```json
{
    "id": "",
    "title": "",
    "createdAt": "",
    "updatedAt": "",
    "wordCount": 0,
    "assets": [],
    "attachments": []
}
```

### content.md 路径约定

正文中引用图片和附件必须使用**相对路径**：

```markdown
![图片](assets/image.png)
[附件](attachments/file.pdf)
```

解压 `.mdx` 后，`content.md` 中的相对路径必须仍可正常访问。

---

## 已实现功能

- [x] 新建笔记
- [x] 打开 `.mdx`（含格式校验）
- [x] 保存 `.mdx`
- [x] 另存为 `.mdx`
- [x] 编辑标题
- [x] 编辑 Markdown 正文
- [x] Toast UI 所见即所得（WYSIWYG）编辑
- [x] Markdown 源码 + 垂直预览模式
- [x] 菜单栏：文件 / 格式 / 插入·Markdown / 视图 / 关于
- [x] 桌面风格菜单栏和状态栏
- [x] `.tmp` + `.bak` 安全保存机制
- [x] 保存时保留已有 `assets/`、`attachments/`、`thumbnails/`、`history/`、`exports/` 资源

---

## 规划中（第一版暂不实现，但须预留扩展点）

- [ ] 图片粘贴 / 拖拽自动保存到 `assets/`
- [ ] 附件拖拽自动保存到 `attachments/`
- [ ] 标签管理
- [ ] 笔记列表
- [ ] 全文搜索
- [ ] 历史版本
- [ ] 加密
- [ ] 导出 Markdown / PDF
- [ ] 云同步

---

## 开发规则

### 前端规则

- 使用 **Vue 3 Composition API**（`<script setup>`）。
- 使用 **TypeScript**，禁止使用 `any`。
- UI 风格：简洁、清爽、接近原生桌面软件，避免 Web 感过强。
- 菜单栏和状态栏保持**紧凑**，不占用多余编辑空间。
- Markdown 编辑器固定使用 **Toast UI Editor**，优先调用其官方 API：
    ```ts
    initialEditType: "wysiwyg";
    editor.changeMode("wysiwyg");
    editor.changeMode("markdown");
    editor.changePreviewStyle("vertical");
    ```
- **禁止**自行实现复杂 Markdown 输入规则，避免与 Toast UI Editor 产生冲突。

### 后端规则

- 后端逻辑通过 **Tauri commands** 暴露给前端，不直接操作 DOM 或调用浏览器 API。
- `.mdx` 的全部读写逻辑在 **Rust** 中实现，前端只调用 command。
- 保存必须使用 `.tmp` + `.bak` 安全保存流程（见下方）。
- 保存失败时**必须尝试恢复**原文件。
- 打开文件必须先校验 `manifest.json.format === "MDXNote"`。
- **严禁**将 Web MDX / JSX 语义混入 `.mdx` 文件格式。

### 文件保存流程（必须严格遵循）

```
1. 将新内容写入目标路径旁的 <filename>.tmp
2. 若原 .mdx 存在，将其重命名为 <filename>.bak
3. 将 .tmp 重命名为正式 .mdx
4. 若步骤 3 失败，尝试将 .bak 恢复为原 .mdx
5. 保存成功后，删除 .bak
```

---

## 常用命令

```bash
# 安装依赖
npm install

# 前端构建检查
npm run build

# 启动 Tauri 开发环境
npm run tauri -- dev

# 打包桌面应用
npm run tauri -- build

# Rust 后端静态检查（修改 Rust 代码后必须运行）
cargo check --manifest-path src-tauri/Cargo.toml
```

> 如果终端找不到 Rust / Cargo，确认 `~/.cargo/bin` 已加入 `PATH` 后重试。

---

## 构建验证要求

每次代码修改后，Agent **必须**运行对应的验证命令：

| 修改范围 | 必须运行                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------- |
| 任何修改 | `npm run build` 和 `cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run tauri -- build` |

---

## 构建产物

Tauri 打包成功后生成：

```
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

---

## AI Agent 行为准则

- **语言**：始终使用中文回答。
- **诚实性**：不编造不存在的 API、文件路径或测试结果。
- **变更说明**：每次修改代码后，必须列出改动的文件及原因。
- **构建验证**：修改代码后必须按上表运行对应验证命令，并报告结果。
- **功能保护**：不删除已实现功能，除非用户明确要求。
- **格式兼容**：不向 `.mdx` 文件格式中引入任何 Web MDX / JSX 语义。
- **构建失败**：构建失败时，说明错误原因并给出下一步处理建议，不要静默忽略。
- **禁打补丁**：集成第三方状态库（如富文本、Canvas）遇 Bug 时，优先排查框架冲突（如 Vue 响应式代理）并使用官方 API。严禁滥用 `setTimeout`、`querySelector` 暴力操纵内部 DOM，或拦截原生事件来打“膏药式”补丁。
- **方案先行 (Design First)**：遇到复杂 Bug 或开发新功能时，严禁未经思考直接“试错式”修改代码。必须先查阅文档或分析源码，在实际修改前明确输出包含原理的“具体修复/实现步骤”，确保方案有理有据（符合官方推荐做法或框架标准模式）后，即可直接执行代码修改。

---

## 最小设计约束

进行架构设计或新增功能时，必须遵守以下规则：

1. 先从已确认的用户需求推导最少组件，禁止先画完整架构再为组件寻找理由。
2. 每增加一个模块、接口、适配层或依赖，必须明确回答：
   - 它解决哪个已确认需求？
   - 现有组件为什么不能直接承担？
   - 删除它会导致哪个验收项失败？
3. 优先使用当前已确定内核的官方公开 API。已有能力能够满足需求时，禁止并行实现第二套方案。
4. 禁止为以下理由提前增加抽象：
   - 未来可能更换框架或内核。
   - 未来可能增加第二个实现。
   - 未来可能需要更多配置。
5. 只有一个实现时，默认不创建接口、工厂、注册中心或插件协议。
6. 将设计内容明确分为：
   - 当前必须实现。
   - 仅在指标不达标时增加。
   - 本次不实现。
7. 用户修改关键约束后，必须从新约束重新推导架构，不得直接继承旧方案中的组件。
8. 提交设计前必须执行一次“删减检查”，列出每个新增模块的必要性，并删除无法证明必要的设计。
9. 如果简单方案和通用方案都可行，默认选择简单方案；同时写明升级到通用方案的可测量触发条件。
10. 安全、数据完整性、可访问性和明确要求的错误处理不得以简化为由删除。
