# Mora 统一字体列表设计

## 目标

借鉴 MarKing 的预置字体列表，在 Mora 现有偏好设置中用具体字体替代“清晰无衬线 / 宋体阅读 / 等宽写作”三种抽象选项。继续保留一个字体偏好，并让所选字体统一作用于 WYSIWYG、源码编辑和源码旁的只读预览。

## 方案选择

采用固定、分组的单一字体列表，并使用浏览器原生 `select`：

- 选项稳定、无需新增依赖或 Tauri command。
- 未安装字体时由 CSS 字体栈自动回退，不阻止用户选择，也不伪装成字体已安装。
- 单一偏好保持三种编辑视图的显示一致，不引入第二份字体状态。

未采用的方案：

- 完整复制 MarKing 的“编辑器字体 / 预览字体”双设置：与本次确认的统一显示目标冲突。
- 动态扫描系统字体：需要新增平台能力、权限和异常处理，本次固定列表不依赖它即可通过验收。
- 打包或在线下载字体：增加安装包体积、许可证和网络依赖，不是“借鉴字体列表”的必要条件。

## 字体列表

列表首项为“系统默认”，其后按字体用途分组。分组只帮助查找，不改变单一选择模型。

| 分组 | 显示名称 | 首选 CSS 字体族 |
| --- | --- | --- |
| 默认 | 系统默认 | 平台 UI 字体栈 |
| 等宽 | JetBrains Mono | `"JetBrains Mono"` |
| 等宽 | Fira Code | `"Fira Code"` |
| 等宽 | Cascadia Code | `"Cascadia Code"` |
| 等宽 | Consolas | `Consolas` |
| 等宽 | SF Mono | `"SF Mono"` |
| 等宽 | 等距更纱黑体 | `"Sarasa Mono SC"` |
| 无衬线 | 微软雅黑 | `"Microsoft YaHei"` |
| 无衬线 | 苹方 | `"PingFang SC"` |
| 无衬线 | 思源黑体 | `"Source Han Sans SC"` |
| 无衬线 | Inter | `Inter` |
| 无衬线 | Segoe UI | `"Segoe UI"` |
| 衬线 | 思源宋体 | `"Source Han Serif SC"` |
| 衬线 | 宋体 | `SimSun` |
| 衬线 | 楷体 | `KaiTi` |
| 衬线 | 霞鹜文楷 | `"LXGW WenKai"` |
| 衬线 | Georgia | `Georgia` |
| 衬线 | Times New Roman | `"Times New Roman"` |

选项文本本身以对应字体栈预览。若首选字体未安装，该选项和正文均显示同类回退字体；设置面板不声称字体可用。

## 字体栈与显示规则

- “系统默认”沿用 Mora 当前正文取向：`"Segoe UI", "Microsoft YaHei", sans-serif`。
- 每个具体字体以自身为首选，随后使用覆盖中英文的同类回退字体，最后落到通用族：
  - 等宽：`"Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace`。
  - 无衬线：`"Segoe UI", "Microsoft YaHei", sans-serif`。
  - 衬线：`"LXGW WenKai", "Source Han Serif SC", "Songti SC", SimSun, serif`。
- 选中的完整字体栈继续写入现有 `--editor-font-family` CSS 变量。
- WYSIWYG、CodeMirror 源码区和只读 Milkdown 预览继续消费同一个 `--editor-font-family`，不在组件内复制字体映射。
- 行内代码、代码块及其他明确使用 `--font-mono` 的内容保持现有等宽字体，不随正文字体变化。这样既统一正文，又不破坏代码可读性。
- 字体设置只影响应用内显示，不写入 `.mdx`，也不改变 Word、PDF 或其他导出的字体配置。

## 偏好模型与兼容迁移

`usePreferences.ts` 继续作为字体选项、规范化、CSS 应用和持久化的唯一入口：

- 将 `FontPreference` 从 `"sans" | "serif" | "mono"` 扩展为稳定的具体字体标识联合类型。
- 导出一份只读字体选项元数据，供设置面板渲染分组、标签和预览样式；不新增字体注册中心、工厂或 composable。
- 默认值使用新的“系统默认”标识。
- 读取现有 `mora.preferences.v1` 时兼容旧值：
  - `sans` → 系统默认。
  - `serif` → 霞鹜文楷。
  - `mono` → Cascadia Code。
- 未知或损坏的字体值回退到系统默认；其他偏好字段和存储键保持不变，无需迁移版本或清空用户设置。

## 设置面板交互

- 保留现有“正文字体”字段和原生下拉控件，不新增弹窗或自定义选择器。
- 选项顺序固定为“系统默认、等宽、无衬线、衬线”。
- 使用 `optgroup` 展示三个字体分类；“系统默认”位于分组外。
- 每个字体选项通过内联 `font-family` 展示自身效果；选中后立即沿用现有 `update` 事件更新并持久化。
- 键盘选择、原生焦点和屏幕阅读器语义由 `select` / `optgroup` / `option` 保持，不用自绘菜单重做无障碍行为。

## 组件与文件边界

- `src/composables/usePreferences.ts`：定义字体标识、选项元数据、字体栈、旧值迁移和 CSS 变量应用。
- `src/components/SettingsPanel.vue`：按元数据渲染单一分组字体列表，不持有第二份选项或偏好状态。
- `src/composables/usePreferences.test.ts`：验证新默认值、全部合法字体、未知值回退和三种旧值迁移。
- `src/components/SettingsPanel.test.ts`：验证字体分组、顺序、选项预览样式及更新事件。
- 仅在现有集成测试未覆盖三种视图共同消费 `--editor-font-family` 时，补充最小断言；不为字体列表新增组件或端到端测试框架。

## 错误处理

- 字体未安装不是错误，由 CSS 回退栈保证内容仍可阅读。
- 本地存储含旧值、未知值或非字符串值时，通过偏好规范化得到可用的字体标识。
- 字体设置不改变文档正文、资源路径或保存请求，因此不会影响 `.mdx` 数据完整性。

## 当前不实现

- 编辑器字体与预览字体分离。
- 系统字体扫描、仅显示已安装字体或手动输入字体名称。
- 字体下载、内置字体文件或云字体。
- 字重、字距、代码字体的独立设置。
- 将字体选择带入 Word、PDF、HTML 等导出文件。

## 验收

1. 偏好设置仅显示一个“正文字体”字段，包含“系统默认”及 17 个具体字体，并按等宽、无衬线、衬线分组。
2. 每个具体字体选项使用自身字体栈展示；字体未安装时仍可选择且界面可读。
3. 切换字体后，WYSIWYG、源码编辑和只读预览的普通正文立即统一变化；行内代码和代码块保持等宽字体。
4. 重新启动后恢复所选字体；旧 `sans`、`serif`、`mono` 偏好分别迁移为系统默认、霞鹜文楷、Cascadia Code。
5. 未知或损坏的字体值安全回退到系统默认。
6. `.mdx` 内容和导出字体不受此偏好影响。
7. 偏好测试、设置面板测试及仓库规定的 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`、`npm run tauri -- build` 全部通过。

## 删减检查

本设计不新增组件、接口、状态库、Tauri command、权限或依赖。字体元数据必须集中在现有偏好模块，因为设置渲染、值校验和 CSS 应用都需要同一组事实；删除它会导致列表、持久化或显示映射不一致。设置面板只消费元数据，三个编辑视图继续复用现有 CSS 变量，因此没有可删的并行实现。
