# Mora 正文与代码字体偏好设计

## 背景

Mora 当前只有一个字体偏好。该偏好已经用于 WYSIWYG、源码模式和只读预览的普通正文，而 WYSIWYG 与只读预览中的代码仍使用固定的 `--font-mono`。这使用户无法统一决定源码模式、行内代码和代码块的字体，也让“正文字体”的职责不够明确。

本次将偏好设置拆成“字体”和“代码字体”两个选择，并内置 Maple Mono CN Regular，保证默认代码字体离线可用且覆盖中英文。

## 已确认需求

### 字体

“字体”控制：

- WYSIWYG 普通正文。
- 只读预览普通正文。

它不控制源码模式、行内代码或代码块。

### 代码字体

“代码字体”控制：

- 源码模式的全部文本，包括 Markdown 标记和正文。
- WYSIWYG 中的行内代码与代码块。
- 只读预览中的行内代码与代码块。

代码字体只提供等宽字体，避免源码、缩进和 Markdown 表格失去对齐。

## 设置界面

偏好设置中保留两个相邻的原生下拉框：

1. `字体`
2. `代码字体`

“字体”继续使用现有正文列表。“代码字体”按以下顺序提供：

1. Maple Mono CN
2. 等距更纱黑体
3. JetBrains Mono
4. Cascadia Code
5. Fira Code
6. Consolas
7. SF Mono

不增加字体搜索、系统字体扫描、已安装状态标记、下载按钮或连字开关。

## 内置字体资产

内置 Maple Mono CN v7.9 的 `MapleMono-CN-Regular.ttf`，来源为 Maple Mono 官方 Release。字体通过 `@font-face` 仅在 Mora 内加载，不安装到 Windows，也不修改系统字体。

- 字重：仅 Regular 400。
- 粗体：由 WebView 合成，本次不内置 Bold。
- 原始字体文件约 17.7 MB。
- 安装包经过压缩后的预计增量约 8.1–8.6 MB；最终以实际 Tauri 打包结果为准。
- 随字体保留 SIL Open Font License 1.1 文本及来源说明。

选择其他代码字体时，字体栈先使用所选字体，再回退到内置 Maple Mono CN，最后回退到通用 `monospace`。因此用户未安装外部字体时仍能稳定显示中英文与代码。

## 偏好数据与迁移

在现有 `EditorPreferences` 中新增独立字段 `codeFontFamily`，使用独立的 `CodeFontPreference` 类型和 `CODE_FONT_OPTIONS` 元数据。正文 `fontFamily` 保持现有类型、标识和行为。

默认值：

```text
fontFamily: system-default
codeFontFamily: maple-mono-cn
```

继续沿用 `mora.preferences.v1` 存储键，不升级版本：

- 旧数据没有 `codeFontFamily` 时补为 `maple-mono-cn`。
- 合法代码字体标识原样保留。
- 未知、损坏或非字符串代码字体值回退到 `maple-mono-cn`。
- 现有正文旧值迁移规则不变。

该偏好只影响应用显示，不写入 `.mdx`，不改变文档格式或导出结果。

## 样式映射

新增 CSS 变量：

```css
--editor-code-font-family
```

职责如下：

- `--editor-font-family`：WYSIWYG 和只读预览普通正文。
- `--editor-code-font-family`：CodeMirror 源码内容、Crepe 行内代码和代码块。
- `--font-mono`：保留给应用界面中其他固定等宽场景，不再承担可配置的编辑器代码字体。

偏好变更后，由现有 `usePreferences.apply()` 同时写入正文和代码字体变量，无需新增状态管理模块。

## 错误处理

- 内置字体资源加载失败时，CSS 字体栈回退到系统等宽字体，编辑器仍可使用。
- 用户选择但系统未安装的外部字体自动回退到内置 Maple Mono CN，不弹错误提示。
- 偏好数据异常时由规范化函数恢复默认代码字体。

## 测试与验收

### 自动测试

- 验证代码字体选项的标识、顺序和字体栈。
- 验证缺失、合法、未知及非字符串 `codeFontFamily` 的规范化结果。
- 验证偏好设置渲染两个字体选择，并能分别发出正文和代码字体更新。
- 验证 `--editor-code-font-family` 被应用到源码模式、Crepe 行内代码和代码块。
- 验证普通正文仍只使用 `--editor-font-family`。
- 验证内置字体和 OFL 许可证文件进入前端构建产物。

### 构建验证

按仓库规则运行：

```text
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

记录打包前后的 MSI 与 NSIS 大小，确认内置 Regular 字体的实际增量；体积差异用于报告，不设置脆弱的精确字节门槛。

### 用户验收

1. 偏好设置显示“字体”和“代码字体”两个选择。
2. 修改“字体”只改变 WYSIWYG 与只读预览的普通正文。
3. 修改“代码字体”同时改变源码模式全部文本，以及 WYSIWYG、只读预览的行内代码和代码块。
4. 未安装任何第三方代码字体时，Maple Mono CN 仍可离线显示中英文和代码。
5. 重启应用后恢复两个字体选择。

## 最小范围与删减检查

当前必须新增：

- 一个代码字体偏好字段和选项表，用于表达已确认的第二个选择。
- 一个编辑器代码字体 CSS 变量，用于隔离正文和代码作用域。
- 一份 Maple Mono CN Regular 字体资产及许可证，用于保证默认字体离线可用。
- 对应偏好、组件和样式测试，用于保护迁移与作用范围。

不新增模块、接口、工厂或字体服务。现有 `usePreferences`、`SettingsPanel` 和 CSS 变量已能直接承担全部需求。

本次不实现：

- Maple Mono CN Bold、Italic 或其他字重。
- 字体在线下载、自动更新或系统安装。
- 系统字体枚举和安装状态检测。
- 中文字体与英文字体分别设置。
- 连字开关、字体高级特性或文档级字体配置。
- 导出文件字体配置。
