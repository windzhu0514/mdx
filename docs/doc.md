---
# MDXNote 笔记软件需求总结

## 一、软件目标

开发一个本地桌面笔记软件，技术栈使用：

- **Tauri**
- **Vue**
- **TypeScript**
- **Rust**

软件主要运行在：

- Windows
- 后续可兼容 Linux / 国产 Linux

核心目标是做一个类似 Markdown 笔记软件，但文件格式像 Word 一样可以把图片、附件保存在文件内部。
---

# 二、主文件格式

软件主格式使用：

```/dev/null/file-extension.txt#L1-1
.mdx
```

但这里的 `.mdx` 不是 Web 开发里的 `Markdown + JSX`，而是自定义格式：

```/dev/null/format-name.txt#L1-1
MDXNote = Markdown eXtended Note Package
```

中文可称为：

```/dev/null/format-cn.txt#L1-1
MDX 扩展笔记文件
```

---

# 三、`.mdx` 文件本质

`.mdx` 文件本质是一个 **ZIP 压缩包**。

用户看到的是：

```/dev/null/user-file.txt#L1-3
会议记录.mdx
学习笔记.mdx
项目方案.mdx
```

但内部结构是：

```/dev/null/mdx-structure.txt#L1-10
example.mdx
├── manifest.json
├── meta.json
├── content.md
├── assets/
│   └── image-20260501-190206-a8f3c91d.png
├── attachments/
│   └── file-20260501-190230-a93bc82e.pdf
└── thumbnails/
    └── cover.png
```

---

# 四、第一版 `.mdx` 内部结构

第一版采用单篇笔记模式：

```/dev/null/mdx-v1-structure.txt#L1-11
note.mdx
├── manifest.json
├── meta.json
├── content.md
├── assets/
│   ├── image-001.png
│   └── image-002.jpg
├── attachments/
│   └── document.pdf
└── thumbnails/
    └── cover.png
```

## 必需文件

| 文件            | 必需 | 说明          |
| --------------- | ---: | ------------- |
| `manifest.json` |   是 | 格式说明      |
| `meta.json`     |   是 | 笔记元数据    |
| `content.md`    |   是 | Markdown 正文 |

## 可选目录

| 目录           | 用途             |
| -------------- | ---------------- |
| `assets/`      | 保存图片         |
| `attachments/` | 保存附件         |
| `thumbnails/`  | 保存封面和缩略图 |
| `history/`     | 后续保存历史版本 |
| `exports/`     | 后续保存导出预览 |

---

# 五、`manifest.json` 设计

`manifest.json` 用于声明文件格式。

第一版内容：

```/dev/null/manifest.json#L1-15
{
  "format": "MDXNote",
  "formatVersion": "1.0.0",
  "packageType": "single-note",
  "contentFile": "content.md",
  "metadataFile": "meta.json",
  "assetsDir": "assets/",
  "attachmentsDir": "attachments/",
  "thumbnailsDir": "thumbnails/",
  "encoding": "utf-8",
  "encrypted": false,
  "compression": "zip"
}
```

字段说明：

| 字段             | 说明                   |
| ---------------- | ---------------------- |
| `format`         | 固定为 `MDXNote`       |
| `formatVersion`  | 格式版本               |
| `packageType`    | 第一版为 `single-note` |
| `contentFile`    | 正文文件路径           |
| `metadataFile`   | 元数据文件路径         |
| `assetsDir`      | 图片目录               |
| `attachmentsDir` | 附件目录               |
| `thumbnailsDir`  | 缩略图目录             |
| `encoding`       | 默认 `utf-8`           |
| `encrypted`      | 第一版为 `false`       |
| `compression`    | `zip`                  |

---

# 六、`meta.json` 设计

`meta.json` 保存笔记元数据。

第一版建议结构：

```/dev/null/meta.json#L1-33
{
  "id": "note_20260501_190206_a8f3c91d",
  "title": "会议记录",
  "summary": "项目会议记录",
  "author": "",
  "createdAt": "2026-05-01T19:02:06+08:00",
  "updatedAt": "2026-05-01T19:30:00+08:00",
  "tags": [
    "工作",
    "会议"
  ],
  "category": "工作笔记",
  "favorite": false,
  "archived": false,
  "cover": "thumbnails/cover.png",
  "wordCount": 532,
  "assets": [
    {
      "id": "asset_a8f3c91d",
      "originalName": "截图.png",
      "storedName": "image-20260501-190206-a8f3c91d.png",
      "path": "assets/image-20260501-190206-a8f3c91d.png",
      "type": "image/png",
      "size": 248102,
      "width": 1280,
      "height": 720,
      "createdAt": "2026-05-01T19:10:00+08:00"
    }
  ],
  "attachments": []
}
```

第一版可以先简化，但字段最好预留。

---

# 七、`content.md` 设计

`content.md` 保存真正的 Markdown 正文。

示例：

```/dev/null/content.md#L1-13
# 会议记录

今天讨论了项目计划。

## 会议截图

![会议截图](assets/image-20260501-190206-a8f3c91d.png)

## 附件

[项目方案.pdf](attachments/file-20260501-190230-a93bc82e.pdf)
```

规则：

- Markdown 正文使用 UTF-8。
- 图片使用相对路径引用 `assets/xxx`。
- 附件使用相对路径引用 `attachments/xxx`。
- 解压 `.mdx` 后，`content.md` 应该仍然能正常找到图片和附件。

---

# 八、图片和附件命名规则

为避免文件名冲突，**内部不直接使用用户原文件名**。

## 图片内部命名

```/dev/null/image-name-rule.txt#L1-1
assets/image-{yyyyMMdd-HHmmss}-{random8}.{ext}
```

示例：

```/dev/null/image-name-examples.txt#L1-4
assets/image-20260501-190206-a8f3c91d.png
assets/paste-20260501-190210-b72e19ac.png
assets/screenshot-20260501-190215-c93f82db.webp
assets/photo-20260501-190220-d10a75fb.jpg
```

## 附件内部命名

```/dev/null/attachment-name-rule.txt#L1-1
attachments/file-{yyyyMMdd-HHmmss}-{random8}.{ext}
```

示例：

```/dev/null/attachment-name-examples.txt#L1-3
attachments/file-20260501-190230-a93bc82e.pdf
attachments/file-20260501-190235-d81ab30f.docx
attachments/file-20260501-190240-e71c920a.xlsx
```

## 冲突处理

保存新资源时流程：

```/dev/null/resource-conflict-flow.txt#L1-7
1. 根据时间戳和 random8 生成内部文件名
2. 检查 assets/ 或 attachments/ 中是否已存在
3. 如果不存在，保存
4. 如果存在，重新生成 random8
5. 最多重试 5 次
6. 如果仍冲突，使用 UUID
7. 保存原始文件名到 meta.json
```

---

# 九、原文件名保留策略

用户原始文件名保存在 `meta.json` 中。

例如用户拖入：

```/dev/null/original-file.txt#L1-1
项目方案.pdf
```

内部保存为：

```/dev/null/internal-file.txt#L1-1
attachments/file-20260501-190230-a93bc82e.pdf
```

`meta.json` 中记录：

```/dev/null/file-meta.json#L1-10
{
  "id": "att_a93bc82e",
  "originalName": "项目方案.pdf",
  "storedName": "file-20260501-190230-a93bc82e.pdf",
  "path": "attachments/file-20260501-190230-a93bc82e.pdf",
  "type": "application/pdf",
  "size": 1024000,
  "createdAt": "2026-05-01T19:02:30+08:00"
}
```

界面显示 `originalName`，正文和内部存储使用 `path`。

---

# 十、第一版软件功能

第一版先实现 MVP：

## 必须功能

| 功能          | 说明                                    |
| ------------- | --------------------------------------- |
| 新建笔记      | 创建一个 `.mdx` 文件                    |
| 打开笔记      | 读取 `.mdx` 文件                        |
| 保存笔记      | 保存为 `.mdx` ZIP 包                    |
| 编辑标题      | 修改 `meta.json.title`                  |
| 编辑正文      | 修改 `content.md`                       |
| Markdown 编辑 | 第一版先文本编辑，后续加预览            |
| 安全保存      | `.tmp` + `.bak` 机制                    |
| 文件格式校验  | 检查 `manifest.json.format === MDXNote` |

---

# 十一、第一版暂不实现，但要预留

| 功能          | 说明                          |
| ------------- | ----------------------------- |
| 图片粘贴      | 粘贴图片保存到 `assets/`      |
| 图片拖拽      | 拖入图片保存到 `assets/`      |
| 附件拖拽      | 拖入文件保存到 `attachments/` |
| Markdown 预览 | 右侧预览                      |
| 搜索          | 搜索标题和正文                |
| 标签管理      | 编辑 `tags`                   |
| 笔记列表      | 管理多个 `.mdx` 文件          |
| 历史版本      | 保存到 `history/`             |
| 加密          | AES-256-GCM                   |
| 导出 Markdown | 导出 `.md` + 附件文件夹       |
| 导出 PDF      | 阅读版                        |
| 云同步        | 后续功能                      |

---

# 十二、打开 `.mdx` 文件流程

```/dev/null/open-mdx-flow.txt#L1-9
1. 用户选择 .mdx 文件
2. 软件按 ZIP 打开文件
3. 读取 manifest.json
4. 检查 format 是否为 MDXNote
5. 检查 formatVersion 是否兼容
6. 读取 meta.json
7. 读取 content.md
8. 加载图片和附件索引
9. 在编辑器中显示标题和正文
```

错误提示：

```/dev/null/error-message.txt#L1-2
这不是有效的 MDXNote 笔记文件。
文件格式版本过高，当前软件无法打开。
```

---

# 十三、保存 `.mdx` 文件流程

```/dev/null/save-mdx-flow.txt#L1-10
1. 获取当前标题和正文
2. 更新 meta.json.title
3. 更新 meta.json.updatedAt
4. 更新 meta.json.wordCount
5. 写入 content.md
6. 写入 meta.json
7. 写入 manifest.json
8. 保留 assets/、attachments/、thumbnails/
9. 打包为 ZIP
10. 保存为 .mdx 文件
```

安全保存机制：

```/dev/null/safe-save-flow.txt#L1-6
1. 先写入 note.mdx.tmp
2. 如果原 note.mdx 存在，先备份为 note.mdx.bak
3. 将 note.mdx.tmp 重命名为 note.mdx
4. 如果重命名失败，恢复 note.mdx.bak
5. 保存成功后删除 .bak
6. 保存失败时保留错误信息
```

---

# 十四、建议技术方案

## 前端

- Vue 3
- TypeScript
- Vite
- Tauri API

第一版界面：

```/dev/null/ui-layout.txt#L1-10
┌────────────────────────────────────┐
│ 顶部工具栏：新建 打开 保存 另存为 │
├────────────────────────────────────┤
│ 标题输入框                         │
├────────────────────────────────────┤
│                                    │
│ Markdown 正文编辑区                │
│                                    │
└────────────────────────────────────┘
```

后续界面：

```/dev/null/future-ui-layout.txt#L1-12
┌──────────────┬─────────────────────┬────────────────────┐
│ 笔记列表      │ Markdown 编辑区       │ 预览区              │
│              │                     │                    │
│ 搜索          │ 标题                 │ 渲染后的 Markdown    │
│ 标签          │ 正文                 │ 图片/附件显示        │
└──────────────┴─────────────────────┴────────────────────┘
```

## 后端

Rust / Tauri commands：

| 命令             | 用途             |
| ---------------- | ---------------- |
| `create_mdx`     | 创建 `.mdx`      |
| `open_mdx`       | 打开 `.mdx`      |
| `save_mdx`       | 保存 `.mdx`      |
| `save_mdx_as`    | 另存为 `.mdx`    |
| `validate_mdx`   | 校验 `.mdx` 文件 |
| `add_asset`      | 后续添加图片     |
| `add_attachment` | 后续添加附件     |

---

# 十五、项目位置

目标项目目录：

```/dev/null/project-path.txt#L1-1
E:\WorkspaceGo\mdx
```

使用技术栈：

```/dev/null/tech-stack.txt#L1-4
Tauri
Vue 3
TypeScript
Rust
```

---

# 十六、第一版开发任务

下一步需要直接创建或修改项目文件：

```/dev/null/files-to-create.txt#L1-8
E:\WorkspaceGo\mdx\package.json
E:\WorkspaceGo\mdx\src\App.vue
E:\WorkspaceGo\mdx\src\main.ts
E:\WorkspaceGo\mdx\src\style.css
E:\WorkspaceGo\mdx\src-tauri\Cargo.toml
E:\WorkspaceGo\mdx\src-tauri\src\lib.rs
E:\WorkspaceGo\mdx\src-tauri\tauri.conf.json
```

---

# 十七、第一版验收标准

第一版完成后，应满足：

1. 可以启动桌面软件。
2. 可以输入标题和正文。
3. 点击保存可以生成 `.mdx` 文件。
4. 将 `.mdx` 改名为 `.zip` 后可以解压。
5. 解压后能看到：
    - `manifest.json`
    - `meta.json`
    - `content.md`
    - `assets/`
    - `attachments/`
    - `thumbnails/`
6. 再次打开 `.mdx` 可以恢复标题和正文。
7. 修改后保存不会破坏文件。
8. 如果打开非 MDXNote 文件，会提示错误。

---

# 十八、后续继续开发时可以这样对我说

如果会话断了，你重新打开后可以直接发我：

> 继续开发 MDXNote。项目在 `E:\WorkspaceGo\mdx`。  
> 需求是：Tauri + Vue + TypeScript + Rust，本地桌面笔记软件。  
> `.mdx` 是 ZIP 包，内部包含 `manifest.json`、`meta.json`、`content.md`、`assets/`、`attachments/`、`thumbnails/`。  
> 第一版实现新建、打开、保存、编辑标题、编辑正文、安全保存。  
> 图片和附件内部文件名使用 `时间戳 + random8` 避免冲突，原文件名保存在 `meta.json`。  
> 请直接写代码。
