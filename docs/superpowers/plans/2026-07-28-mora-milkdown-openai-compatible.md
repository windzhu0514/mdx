# Mora Milkdown 与 OpenAI-compatible AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 直接移除 Toast UI，以 Milkdown/Crepe 和 CodeMirror 6 提供三种编辑视图，并同期交付由 Rust 安全调用的 OpenAI-compatible WYSIWYG AI。

**Architecture:** `App.vue` 继续拥有正文和文件生命周期，`MoraEditor.vue` 隔离两个编辑器实现；Milkdown 同时承担 WYSIWYG 与只读预览，CodeMirror 6 承担整篇源码。AI 通过一个前端流式函数、Tauri Channel 和单文件 Rust `ai.rs` 接入，API Key 仅保存在系统凭据库。

**Tech Stack:** Vue 3.5、TypeScript 6、Vite 8、Milkdown/Crepe 7.21.3、CodeMirror 6、Tauri 2、Rust 2021、reqwest 0.13、keyring 4.1、SSE。

## Global Constraints

- Mora 的 `.mdx` 是 MDXNote ZIP，不得加入 Web MDX/JSX 语义。
- `content.md` 是唯一持久化正文，不保存 Milkdown、ProseMirror 或 CodeMirror 私有状态。
- 仅保留 WYSIWYG、源码、源码加预览；删除独立仅预览。
- 允许 Milkdown 规范化 Markdown 表面格式，但语义和资源相对路径不得丢失。
- 不保留 Toast UI、双内核、EditorAdapter、独立 Renderer、Provider 注册表或多请求 Map。
- 只使用 Milkdown、CodeMirror 和 Tauri 官方公开 API；禁止查询内部 DOM 或用定时器补丁修复编辑器。
- Vue 代码使用 `<script setup>` 和 TypeScript，禁止 `any`。
- API Key 不得进入 LocalStorage、`.mdx`、草稿、日志或可读回的前端状态。
- 远程 Base URL 必须是 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1`、`::1`。
- 当前工作目录没有 `.git` 元数据，因此各任务以验证检查点结束；恢复 Git 后再按任务边界提交。
- 每次修改后至少运行 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`、`npm run tauri -- build`。

---

## File Map

### 新建

- `src/components/editor/editorTypes.ts`：三个编辑视图共享的最小类型。
- `src/components/editor/sourceTransforms.ts`：CodeMirror 源码菜单命令的纯文本变换。
- `src/components/editor/sourceTransforms.test.ts`：源码变换回归。
- `src/components/editor/SourceEditor.vue`：CodeMirror 6 生命周期和正式 API。
- `src/components/editor/SourceEditor.test.ts`：源码编辑器同步和公开方法。
- `src/components/editor/MilkdownEditor.vue`：Crepe 生命周期、官方命令、上传和 AI。
- `src/components/editor/MilkdownEditor.test.ts`：Crepe 配置与更新回路。
- `src/components/editor/MoraEditor.vue`：模式组合和当前编辑器方法转发。
- `src/components/editor/MoraEditor.test.ts`：三种视图和只读预览。
- `src/ai/openAICompatible.ts`：Tauri Channel 到 `AsyncIterable<string>`。
- `src/ai/openAICompatible.test.ts`：流顺序、错误和取消。
- `src-tauri/src/ai.rs`：凭据、URL、HTTP、SSE、错误和取消。

### 修改

- `package.json`、`package-lock.json`：替换前端编辑器依赖。
- `src/App.vue`：移除 Toast 实例并使用 `MoraEditor`。
- `src/env.d.ts`：删除 Toast UI 手写声明。
- `src/style.css`、`src/experience.css`：删除 `.toastui-*`，增加 Mora/Milkdown/CodeMirror 样式。
- `src/App.web.test.ts`：改为 Mock `MoraEditor`。
- `src/App.markdown-layout.test.ts`：改为三视图结构测试。
- `src/composables/usePreferences.ts`、`src/composables/usePreferences.test.ts`：保存 Base URL 和模型。
- `src/components/SettingsPanel.vue`、`src/components/panelAccessibility.test.ts`：AI 设置和凭据操作。
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：原生 AI 依赖。
- `src-tauri/src/lib.rs`：注册 AI 状态和命令。

### 删除

- `@toast-ui/editor` 依赖。
- `src/env.d.ts` 中的 Toast UI module declarations。
- `App.vue` 和测试中的 Toast 初始化、Mock、CSS 类和模式 API。

---

### Task 1: 锁定依赖并定义编辑器契约

**Files:**
- Create: `src/components/editor/editorTypes.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `EditorMode`、`EditorCommand`、`MoraEditorHandle`、`ImageUploadHandler`。
- Consumes: 无。

- [ ] **Step 1: 安装直接使用的官方依赖**

Run:

```bash
npm install --save-exact @milkdown/crepe@7.21.3 @milkdown/kit@7.21.3 codemirror@6.0.2 @codemirror/commands@6.10.4 @codemirror/lang-markdown@6.5.1 @codemirror/state@6.7.1
```

Expected: `package.json` 增加六个精确版本，Toast UI 暂时保留到 Task 4。

- [ ] **Step 2: 创建最小编辑器类型**

Create `src/components/editor/editorTypes.ts`:

```ts
export type EditorMode = "wysiwyg" | "source";

export type EditorCommand =
    | { name: "undo" | "redo" | "selectAll" }
    | { name: "heading"; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
    | {
          name:
              | "bold"
              | "italic"
              | "strike"
              | "code"
              | "blockQuote"
              | "bulletList"
              | "orderedList"
              | "taskList"
              | "indent"
              | "outdent"
              | "hr"
              | "codeBlock";
      };

export type MoraEditorHandle = {
    focus(): void;
    getSelectedText(): string;
    replaceSelection(text: string): void;
    moveCursor(position: "start" | "end"): void;
    execute(command: EditorCommand): void;
};

export type ImageUploadHandler = (file: File) => Promise<string>;
```

- [ ] **Step 3: 验证依赖和类型可以解析**

Run:

```bash
npm run build
```

Expected: PASS；现有 Toast 实现仍能构建。

**Checkpoint:** `build: add Milkdown and CodeMirror dependencies`

---

### Task 2: 实现 CodeMirror 6 源码编辑器

**Files:**
- Create: `src/components/editor/sourceTransforms.ts`
- Create: `src/components/editor/sourceTransforms.test.ts`
- Create: `src/components/editor/SourceEditor.vue`
- Create: `src/components/editor/SourceEditor.test.ts`

**Interfaces:**
- Consumes: `EditorCommand` from `editorTypes.ts`。
- Produces: `SourceEditor.vue`，公开 `MoraEditorHandle` 中的五个方法并发出 `update:modelValue`。

- [ ] **Step 1: 写源码变换失败测试**

Create `src/components/editor/sourceTransforms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { transformSourceSelection } from "./sourceTransforms";

describe("source markdown commands", () => {
    it("wraps a selection with strong markers", () => {
        expect(
            transformSourceSelection("hello", 0, 5, { name: "bold" }),
        ).toEqual({ from: 0, to: 5, insert: "**hello**", anchor: 9 });
    });

    it("replaces an existing heading prefix", () => {
        expect(
            transformSourceSelection("## Title", 0, 8, {
                name: "heading",
                level: 3,
            }),
        ).toEqual({ from: 0, to: 8, insert: "### Title", anchor: 9 });
    });

    it("prefixes every selected line as a task list", () => {
        expect(
            transformSourceSelection("one\ntwo", 0, 7, { name: "taskList" }),
        ).toEqual({
            from: 0,
            to: 7,
            insert: "- [ ] one\n- [ ] two",
            anchor: 19,
        });
    });
});
```

- [ ] **Step 2: 运行并确认测试失败**

Run:

```bash
npm test -- src/components/editor/sourceTransforms.test.ts
```

Expected: FAIL，因为 `sourceTransforms.ts` 尚不存在。

- [ ] **Step 3: 实现最小源码变换**

Create `src/components/editor/sourceTransforms.ts` with these exact rules:

- `bold`、`italic`、`strike`、`code` 分别使用 `**`、`*`、`~~`、`` ` `` 包裹选区。
- `heading` 只处理选中行，先移除已有 `#{1,6}` 前缀；level 0 生成普通段落。
- `blockQuote`、`bulletList`、`orderedList`、`taskList` 逐行增加 `> `、`- `、递增数字、`- [ ] `。
- `indent` 逐行增加四个空格；`outdent` 每行最多移除四个前导空格或一个 Tab。
- `hr` 在选区位置插入 `\n---\n`。
- `codeBlock` 使用三反引号包裹选区。
- `undo`、`redo`、`selectAll` 返回 `null`，由 CodeMirror 官方命令处理。

The exported signature must be:

```ts
import type { EditorCommand } from "./editorTypes";

export type SourceChange = {
    from: number;
    to: number;
    insert: string;
    anchor: number;
};

export function transformSourceSelection(
    document: string,
    from: number,
    to: number,
    command: EditorCommand,
): SourceChange | null;
```

- [ ] **Step 4: 运行纯函数测试**

Run:

```bash
npm test -- src/components/editor/sourceTransforms.test.ts
```

Expected: PASS。

- [ ] **Step 5: 实现 `SourceEditor.vue`**

Use:

```ts
import { redo, selectAll, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
```

Required component behavior:

```ts
const props = defineProps<{ modelValue: string; readonly?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [markdown: string] }>();
```

- `onMounted` 创建一个 `EditorView`，extensions 为 `basicSetup`、`markdown()`、
  `EditorView.editable.of(!readonly)` 和 update listener。
- update listener 只在 `update.docChanged` 时发出完整 `state.doc.toString()`。
- `watch(modelValue)` 比较当前文档后，用一个 changes transaction 替换全文。
- 创建一个 `Compartment` 专门承载 `EditorView.editable`；`watch(readonly)` dispatch
  `editableCompartment.reconfigure(EditorView.editable.of(!value))`，不销毁实例。
- `onBeforeUnmount` 调用 `view.destroy()`。
- `getSelectedText()` 使用 `state.sliceDoc(from, to)`。
- `replaceSelection()` 通过一个 transaction 替换当前 selection。
- `moveCursor()` dispatch 到 0 或 `state.doc.length`。
- `execute()` 对 undo/redo/selectAll 调用官方命令，其余调用
  `transformSourceSelection()` 并 dispatch 一次 change。

- [ ] **Step 6: 写并运行组件测试**

`SourceEditor.test.ts` 使用现有 `createApp` + jsdom 模式，覆盖：

1. 初始 `modelValue` 写入 CodeMirror。
2. 外部 `modelValue` 更新不会形成 emit 循环。
3. `replaceSelection()` 只产生一次 `update:modelValue`。
4. `readonly` 时不可编辑。

Run:

```bash
npm test -- src/components/editor/SourceEditor.test.ts src/components/editor/sourceTransforms.test.ts
```

Expected: PASS。

**Checkpoint:** `feat: add CodeMirror markdown source editor`

---

### Task 3: 实现 Milkdown/Crepe 编辑器

**Files:**
- Create: `src/components/editor/MilkdownEditor.vue`
- Create: `src/components/editor/MilkdownEditor.test.ts`

**Interfaces:**
- Consumes: `EditorCommand`、`ImageUploadHandler`、可选 Crepe `AIProvider`。
- Produces: 可编辑或只读 Milkdown，公开与 `SourceEditor` 相同的方法。

- [ ] **Step 1: 写 Crepe 生命周期失败测试**

Mock `@milkdown/crepe` with a class that records:

- constructor options；
- `create()`、`destroy()`、`setReadonly()`；
- `on(listener => listener.markdownUpdated(handler))`；
- `editor.action()`。

Tests:

```ts
expect(constructorOptions.defaultValue).toBe("# 初始");
expect(mockCreate).toHaveBeenCalledTimes(1);
expect(mockSetReadonly).toHaveBeenCalledWith(true);
expect(mockDestroy).toHaveBeenCalledTimes(1);
```

Also trigger the captured `markdownUpdated` callback and assert one
`update:modelValue` emission.

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
npm test -- src/components/editor/MilkdownEditor.test.ts
```

Expected: FAIL，因为组件尚不存在。

- [ ] **Step 3: 实现 Crepe 初始化**

`MilkdownEditor.vue` props/emits:

```ts
import type { AIProvider } from "@milkdown/crepe/feature/ai";
import type { EditorCommand, ImageUploadHandler } from "./editorTypes";

const props = defineProps<{
    modelValue: string;
    readonly?: boolean;
    uploadImage?: ImageUploadHandler;
    aiProvider?: AIProvider;
}>();

const emit = defineEmits<{
    "update:modelValue": [markdown: string];
    "ai-error": [message: string];
}>();
```

Crepe configuration requirements:

```ts
const features = {
    [Crepe.Feature.AI]: props.aiProvider ? true : false,
};

const featureConfigs = {
    [Crepe.Feature.ImageBlock]: {
        onUpload: async (file: File) => {
            if (!props.uploadImage) throw new Error("图片上传不可用");
            return props.uploadImage(file);
        },
    },
    ...(props.aiProvider
        ? {
              [Crepe.Feature.AI]: {
                  provider: props.aiProvider,
                  diffReviewOnEnd: true,
                  onError: (error: Error) => emit("ai-error", error.message),
              },
          }
        : {}),
};
```

Import exactly one Crepe theme:

```ts
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
```

Use `crepe.on` `markdownUpdated` to emit only when `markdown !== props.modelValue`.
Use `crepe.editor.action(replaceAll(markdown))` for external updates.
Use `crepe.setReadonly(value)` for readonly changes.

- [ ] **Step 4: 实现正式编辑方法**

Use Milkdown public APIs:

```ts
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
    createCodeBlockCommand,
    insertHrCommand,
    liftListItemCommand,
    sinkListItemCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import {
    insertTableCommand,
    toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { redo, undo } from "@milkdown/kit/prose/history";
import { selectAll } from "@milkdown/kit/prose/commands";
import { TextSelection } from "@milkdown/kit/prose/state";
import { getMarkdown, replaceAll, replaceRange } from "@milkdown/kit/utils";
```

Map commands as follows:

| Mora command | Milkdown public API |
| --- | --- |
| heading 0 | `turnIntoTextCommand` |
| heading 1-6 | `wrapInHeadingCommand` with level |
| bold | `toggleStrongCommand` |
| italic | `toggleEmphasisCommand` |
| strike | `toggleStrikethroughCommand` |
| code | `toggleInlineCodeCommand` |
| blockQuote | `wrapInBlockquoteCommand` |
| bulletList | `wrapInBulletListCommand` |
| orderedList | `wrapInOrderedListCommand` |
| indent/outdent | `sinkListItemCommand` / `liftListItemCommand` |
| hr | `insertHrCommand` |
| codeBlock | `createCodeBlockCommand` |
| undo/redo/selectAll | ProseMirror official commands |

For `taskList`, read `{ from, to }` from `editorViewCtx`, obtain the selection Markdown
with `crepe.editor.action(getMarkdown({ from, to }))`, prefix every selected line with
`- [ ] `，then call
`crepe.editor.action(replaceRange(taskMarkdown, { from, to }))` exactly once.
When the selection is empty, insert `- [ ] ` at the cursor. Do not inspect Crepe DOM.

Selection methods must use `editorViewCtx`:

- `getSelectedText()` → `state.doc.textBetween(from, to, "\n")`。
- `replaceSelection(text)` → `state.tr.insertText(text, from, to)`。
- `moveCursor(start/end)` → `TextSelection.create(state.doc, target)`。

- [ ] **Step 5: 运行组件测试和类型检查**

Run:

```bash
npm test -- src/components/editor/MilkdownEditor.test.ts
npm run build
```

Expected: PASS。

**Checkpoint:** `feat: add Milkdown Crepe editor`

---

### Task 4: 组合三种视图并替换 App 中的 Toast UI

**Files:**
- Create: `src/components/editor/MoraEditor.vue`
- Create: `src/components/editor/MoraEditor.test.ts`
- Modify: `src/App.vue:1-110`
- Modify: `src/App.vue:208-380`
- Modify: `src/App.vue:390-590`
- Modify: `src/App.vue:1034-1175`
- Modify: `src/App.vue:1580-1730`
- Modify: `src/App.vue:1850-1920`
- Modify: `src/App.web.test.ts`
- Create: `src/App.editor-integration.test.ts`
- Modify: `src/App.markdown-layout.test.ts`
- Modify: `src/utils/text.ts`
- Modify: `src/utils/text.test.ts`
- Modify: `src/env.d.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `MilkdownEditor`、`SourceEditor`、`MoraEditorHandle`。
- Produces: App 的唯一编辑器入口和三视图行为。

- [ ] **Step 1: 写三视图失败测试**

`MoraEditor.test.ts` Mock 两个子编辑器并验证：

```ts
mode="wysiwyg", sourcePreview=false
  => one editable Milkdown, zero SourceEditor

mode="source", sourcePreview=false
  => one SourceEditor, zero Milkdown

mode="source", sourcePreview=true
  => one SourceEditor, one readonly Milkdown
```

Also assert `execute()` forwards only to the currently editable child.

- [ ] **Step 2: 实现 `MoraEditor.vue`**

Props/emits:

```ts
const props = defineProps<{
    modelValue: string;
    displayValue?: string;
    mode: EditorMode;
    sourcePreview: boolean;
    readonly?: boolean;
    uploadImage?: ImageUploadHandler;
    aiProvider?: AIProvider;
}>();

const emit = defineEmits<{
    "update:modelValue": [markdown: string];
    "ai-error": [message: string];
}>();
```

Template rules:

```vue
<MilkdownEditor
    v-if="mode === 'wysiwyg'"
    ref="milkdownEditor"
    :model-value="displayValue ?? modelValue"
    :readonly="readonly"
    :upload-image="uploadImage"
    :ai-provider="aiProvider"
    @update:model-value="emit('update:modelValue', $event)"
    @ai-error="emit('ai-error', $event)"
/>

<div v-else class="source-layout" :class="{ split: sourcePreview }">
    <SourceEditor
        ref="sourceEditor"
        :model-value="modelValue"
        :readonly="readonly"
        @update:model-value="emit('update:modelValue', $event)"
    />
    <MilkdownEditor
        v-if="sourcePreview"
        :model-value="displayValue ?? modelValue"
        readonly
    />
</div>
```

Forward the six `MoraEditorHandle` methods to the writable child only; in split mode,
`scrollToHeading()` also synchronizes the readonly preview.

- [ ] **Step 3: 迁移 App 状态和模板**

Replace:

```ts
const editorRoot = ref<HTMLDivElement | null>(null);
let editorInstance: Editor | null = null;
const editorMode = ref<EditorType>("wysiwyg");
const markdownLayout = ref<"vertical" | "source" | "preview">("vertical");
```

with:

```ts
const editorRef = ref<MoraEditorHandle | null>(null);
const editorMode = ref<EditorMode>("wysiwyg");
const sourcePreview = ref(true);
const displayContent = computed(() => resourceSession.displayMarkdown(content.value));

function handleEditorUpdate(markdown: string) {
    const persistedContent = resourceSession.persistedMarkdown(markdown);
    if (persistedContent === content.value) return;
    content.value = persistedContent;
    markDirty();
}
```

Use:

```vue
<MoraEditor
    ref="editorRef"
    :model-value="content"
    :display-value="displayContent"
    :mode="editorMode"
    :source-preview="sourcePreview"
    :upload-image="registerPastedImage"
    @update:model-value="handleEditorUpdate"
    @ai-error="handleAiError"
/>
```

Delete `initializeEditor`、`setEditorMarkdown`、`syncContentFromEditor` and all
`editorInstance` lifecycle code. `buildDraftSnapshot()` and `buildRequest()` read
`content.value` directly.

`applyNote()` and draft restore write persisted Markdown directly to `content.value`.
CodeMirror always receives `modelValue`; editable and readonly Milkdown receive
`displayValue`. Blob URL must never become App authoritative content.

`exportPdf()` temporarily switches source-only or split mode to one editable WYSIWYG,
awaits `nextTick()`, calls `window.print()`, and restores the previous mode in `finally`.
This view-only transition must not mark the note dirty.

Mode actions become:

```ts
function setEditorMode(mode: EditorMode) {
    editorMode.value = mode;
    if (mode === "source") sourcePreview.value = false;
    editorRef.value?.focus();
}

function setSourcePreview(visible: boolean) {
    editorMode.value = "source";
    sourcePreview.value = visible;
    editorRef.value?.focus();
}
```

The visible choices are:

- Alt+1：WYSIWYG。
- Alt+2：源码加预览。
- Alt+3：源码。
- 删除 Alt+4 和仅预览按钮。

- [ ] **Step 4: 迁移 App 编辑命令和图片上传**

`runEditorCommand(name, payload)` converts the current string/payload into an
`EditorCommand` and calls `editorRef.value?.execute(command)`.

Clipboard、find/replace、link、image、table helpers use:

```ts
editorRef.value?.getSelectedText();
editorRef.value?.replaceSelection(markdown);
editorRef.value?.focus();
```

Move-to-start/end uses `editorRef.value?.moveCursor("start" | "end")`。

Extract the body of Toast `addImageBlobHook` into:

```ts
async function registerPastedImage(file: File): Promise<string> {
    const extension = imageExtension(file.type);
    const filename = `assets/image-${crypto.randomUUID()}.${extension}`;
    const base64 = await blobToBase64(file);
    const objectUrl = URL.createObjectURL(file);
    resourceSession.registerNew({
        path: filename,
        originalName: file.name || `图片.${extension}`,
        mimeType: file.type || `image/${extension}`,
        size: file.size,
        base64,
        objectUrl,
        kind: "asset",
        isNew: true,
    });
    return objectUrl;
}
```

- [ ] **Step 5: 删除 Toast UI**

Run:

```bash
npm uninstall @toast-ui/editor
```

Then delete all Toast module declarations from `src/env.d.ts`, leaving:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 6: 更新 App 测试**

- `App.web.test.ts` Mock `MoraEditor.vue`，通过 emitting
  `update:modelValue` 验证字数、脏状态和 Web 预览不调用 Tauri。
- `App.editor-integration.test.ts` 保留真实 `App -> MoraEditor`，只 Mock 最底层
  `MilkdownEditor` 和 `SourceEditor`，验证子更新规范化、字数/脏状态、外部同内容
  回传不标脏，以及 Blob URL 只进入 Milkdown `displayValue`。
- PDF 测试验证源码和垂直双栏打印时临时只挂载一个可编辑 Milkdown，随后恢复原视图。
- `src/utils/text.ts` 提供 App、Source 与 Milkdown 共用的最小标题规范化函数，测试
  `## **标题** ##`、链接和行内代码；不实现完整 Markdown 解析器。
- `App.markdown-layout.test.ts` 不再匹配 Toast CSS；改为断言 App 只提供
  “所见即所得”“仅源码”“垂直双栏”，且不出现“仅预览”。

Run:

```bash
npm test -- src/App.editor-integration.test.ts src/components/editor/MoraEditor.test.ts src/App.web.test.ts src/App.markdown-layout.test.ts
npm run build
```

Expected: PASS。

**Checkpoint:** `feat: replace Toast UI with Mora editor`

---

### Task 5: 增加 AI 偏好和前端流式 Provider

**Files:**
- Create: `src/ai/openAICompatible.ts`
- Create: `src/ai/openAICompatible.test.ts`
- Modify: `src/composables/usePreferences.ts:1-135`
- Modify: `src/composables/usePreferences.test.ts`
- Modify: `src/components/SettingsPanel.vue`
- Modify: `src/components/panelAccessibility.test.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Produces: `createOpenAICompatibleProvider(getConfig, canonicalizeMarkdown)`。
- Consumes: Tauri `invoke`、`Channel` 和 Crepe `AIPromptContext`。

- [ ] **Step 1: 扩展非敏感偏好并写失败测试**

Add to `EditorPreferences`:

```ts
aiBaseUrl: string;
aiModel: string;
```

Defaults:

```ts
aiBaseUrl: "";
aiModel: "";
```

Normalization:

```ts
function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
```

Test corrupted values normalize to empty strings and valid strings persist through
`savePreferences`/`loadPreferences`.

- [ ] **Step 2: 写 Provider 失败测试**

Mock `Channel` and `invoke` in `openAICompatible.test.ts` and cover:

1. delta `"A"` then `"B"` yields `["A", "B"]`。
2. done completes iterator。
3. error throws the supplied Chinese message。
4. AbortSignal invokes `cancel_ai` once。
5. Base URL or model empty throws before `stream_ai`。
6. A context whose `document` and `selection` contain Blob URLs invokes `stream_ai`
   only with both fields passed through `canonicalizeMarkdown`。

- [ ] **Step 3: 实现事件队列和 Provider**

Create these types:

```ts
export type AiStreamEvent =
    | { type: "delta"; text: string }
    | { type: "done" }
    | { type: "error"; code: string; message: string };

export type AiConfig = {
    baseUrl: string;
    model: string;
};

export type MoraAIProvider = (
    context: AIPromptContext,
    signal: AbortSignal,
) => AsyncIterable<string>;
```

`createOpenAICompatibleProvider` signature:

```ts
export function createOpenAICompatibleProvider(
    getConfig: () => AiConfig,
    canonicalizeMarkdown: (markdown: string) => string,
): MoraAIProvider;
```

Implementation requirements:

- Create `new Channel<AiStreamEvent>()` per request.
- Before constructing `AiRequest`, pass both `context.document` and
  `context.selection` through `canonicalizeMarkdown`; the IPC payload must never
  contain a Blob URL.
- Invoke `stream_ai` with `{ request, onEvent: channel }`。
- Queue events arriving before the iterator is awaiting.
- Yield only delta text.
- Return on done.
- Throw `new Error(event.message)` on error.
- Register one `{ once: true }` abort listener that calls `cancel_ai`。
- Remove the listener in `finally`。
- Start consuming Channel events immediately；do not await `invoke` before the event loop。
- Attach a rejection handler to the `invoke` promise that enqueues
  `{ type: "error", code: "AI_COMMAND", message }`，so startup/validation/keyring failures
  wake the iterator instead of leaving it pending。
- In the generator `finally` block, remove the abort listener and await the handled
  `invoke` promise，so command-side completion is observed without replacing a streamed
  protocol error。

- [ ] **Step 4: 增加设置 UI**

`SettingsPanel.vue` adds:

- Base URL text input。
- Model text input。
- Password input held only in local component state。
- “保存/替换 API Key” button。
- “删除 API Key” button，disabled when no key。
- Text “已配置”/“未配置”，never renders key value。

New props/emits:

```ts
defineProps<{
    open: boolean;
    preferences: EditorPreferences;
    aiKeyConfigured: boolean;
    aiKeySaving: boolean;
}>();

const emit = defineEmits<{
    close: [];
    update: [patch: Partial<EditorPreferences>];
    "save-ai-key": [key: string];
    "delete-ai-key": [];
}>();
```

Clear the local password input after emitting `save-ai-key`.

- [ ] **Step 5: 接入 App 凭据状态**

Add:

```ts
const aiKeyConfigured = ref(false);
const aiKeySaving = ref(false);
```

On desktop startup and settings open, call `has_ai_api_key`。
Save/delete use `save_ai_api_key` and `delete_ai_api_key`，then refresh the boolean.
Web preview keeps `aiKeyConfigured=false` and never invokes these commands.

Run:

```bash
npm test -- src/ai/openAICompatible.test.ts src/composables/usePreferences.test.ts src/components/panelAccessibility.test.ts
npm run build
```

Expected: PASS。

**Checkpoint:** `feat: add AI settings and Tauri stream provider`

---

### Task 6: 实现 Rust 凭据和 URL 安全边界

**Files:**
- Create: `src-tauri/src/ai.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs:1-20`
- Modify: `src-tauri/src/lib.rs:821-846`

**Interfaces:**
- Produces: `save_ai_api_key`、`delete_ai_api_key`、`has_ai_api_key`、
  `AiRequestState`、`validate_base_url`。
- Consumes: `keyring::v1::Entry`、`url::Url`。

- [ ] **Step 1: 添加原生依赖**

Add:

```toml
eventsource-stream = "0.2.3"
futures-util = "0.3.33"
keyring = "4.1.5"
reqwest = { version = "0.13.4", features = ["json", "stream"] }
tokio = { version = "1.53.1", features = ["macros", "sync"] }
url = "2.5.8"
```

- [ ] **Step 2: 写 URL 单元测试**

Tests in `ai.rs`:

```rust
#[test]
fn accepts_https_and_local_http() {
    assert!(validate_base_url("https://api.openai.com/v1").is_ok());
    assert!(validate_base_url("http://localhost:11434/v1").is_ok());
    assert!(validate_base_url("http://127.0.0.1:1234/v1").is_ok());
    assert!(validate_base_url("http://[::1]:1234/v1").is_ok());
}

#[test]
fn rejects_remote_http_and_non_http_schemes() {
    assert!(validate_base_url("http://example.com/v1").is_err());
    assert!(validate_base_url("file:///tmp/api").is_err());
}
```

- [ ] **Step 3: 实现 URL 规范化**

Signature:

```rust
pub fn validate_base_url(value: &str) -> Result<url::Url, String>;
```

Rules:

- trim 后不能为空。
- scheme 仅 `https` 或满足本地主机规则的 `http`。
- URL 必须有 host。
- 清除 query 和 fragment。
- path 去掉尾部 `/`，再追加 `/chat/completions`。

- [ ] **Step 4: 实现凭据命令**

Constants:

```rust
const AI_KEYRING_SERVICE: &str = "com.mora.mojian";
const AI_KEYRING_USER: &str = "openai-compatible-api-key";
```

Use:

```rust
fn ai_key_entry() -> Result<keyring::v1::Entry, String> {
    keyring::v1::Entry::new(AI_KEYRING_SERVICE, AI_KEYRING_USER)
        .map_err(|_| "无法访问系统凭据库".to_string())
}
```

Commands:

- `save_ai_api_key(key: String)` rejects trimmed empty input, calls `set_password`。
- `has_ai_api_key()` returns false only for `keyring::v1::Error::NoEntry`。
- `delete_ai_api_key()` treats NoEntry as success。
- No command returns the stored secret.
- Error strings never include the key.

- [ ] **Step 5: 注册模块、状态和命令**

In `lib.rs`:

```rust
mod ai;
use ai::AiRequestState;
```

Builder:

```rust
.manage(AiRequestState::default())
```

Generate handler adds:

```rust
ai::save_ai_api_key,
ai::delete_ai_api_key,
ai::has_ai_api_key,
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml ai::
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS。

**Checkpoint:** `feat: store AI credentials in native keyring`

---

### Task 7: 实现 Rust OpenAI-compatible SSE 与取消

**Files:**
- Modify: `src-tauri/src/ai.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `stream_ai`、`cancel_ai` 和 `AiStreamEvent`。
- Consumes: `AiRequestState`、Tauri `Channel<AiStreamEvent>`。

- [ ] **Step 1: 写协议解析失败测试**

Define tests for:

```rust
r#"{"choices":[{"delta":{"content":"你"}}]}"# => Some("你")
r#"{"choices":[{"delta":{}}]}"# => None
"[DONE]" => Done
invalid JSON => protocol error
```

Also test status mapping:

```text
401/403 -> AI_AUTH
404 -> AI_ENDPOINT
429 -> AI_RATE_LIMIT
500..599 -> AI_SERVER
other non-success -> AI_HTTP
```

- [ ] **Step 2: 定义 IPC 类型**

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub base_url: String,
    pub model: String,
    pub document: String,
    pub selection: String,
    pub instruction: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Delta { text: String },
    Done,
    Error { code: String, message: String },
}
```

`AiRequestState` stores exactly one cancellation sender:

```rust
#[derive(Default)]
pub(crate) struct AiRequestState {
    cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}
```

Starting a new request cancels and replaces an existing sender.
Normal completion does not clear the slot from the finishing task, because an older
cancelled request must never remove a newer request's sender. The next start/cancel
operation safely takes the closed sender.

- [ ] **Step 3: 构造最小 Chat Completions 请求**

Use system message:

```text
你是 Mora 墨笺的 Markdown 写作助手。只返回要插入或替换的 Markdown，
不要解释，不要用代码围栏包裹整个答案。
```

User message contains, in order:

```text
指令：
{instruction}

当前文档：
{document}

当前选区：
{selection or "无选区，请生成可插入光标位置的内容"}
```

POST body:

```json
{
  "model": "<configured model>",
  "stream": true,
  "messages": [
    {"role": "system", "content": "<system message>"},
    {"role": "user", "content": "<assembled user message>"}
  ]
}
```

Read API Key from keyring immediately before request and set Bearer auth without
logging request headers.

- [ ] **Step 4: 实现 SSE 和取消**

`stream_ai` signature:

```rust
#[tauri::command]
pub(crate) async fn stream_ai(
    request: AiRequest,
    on_event: tauri::ipc::Channel<AiStreamEvent>,
    state: tauri::State<'_, AiRequestState>,
) -> Result<(), String>;
```

Use `response.bytes_stream().eventsource()` and `tokio::select!` between:

- `cancel_rx`；
- `events.next()`。

For each event:

- data `[DONE]` → send Done and return。
- valid delta content → send Delta。
- empty delta → continue。
- parse/SSE error → send Error code `AI_PROTOCOL` and return `Ok(())`。
- channel send failure → stop request without retry。

`cancel_ai` takes the sender from state and sends once.
No partial generated content is persisted by Rust.

- [ ] **Step 5: 注册命令并运行 Rust 验证**

Add:

```rust
ai::stream_ai,
ai::cancel_ai,
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml ai::
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS。

**Checkpoint:** `feat: stream OpenAI-compatible responses through Tauri`

---

### Task 8: 接通 Crepe AI、清理样式并完成回归

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/editor/MoraEditor.vue`
- Modify: `src/components/editor/MilkdownEditor.vue`
- Modify: `src/style.css`
- Modify: `src/experience.css`
- Modify: all affected frontend tests
- Modify: `docs/superpowers/specs/2026-07-27-mora-milkdown-openai-compatible-design.md`

**Interfaces:**
- Consumes: `createOpenAICompatibleProvider`、AI preferences、Crepe `AIProvider`。
- Produces: 可配置、可取消、可 Diff 审阅的 WYSIWYG AI。

- [ ] **Step 1: 在 App 创建稳定 Provider**

Create once:

```ts
const aiProvider = createOpenAICompatibleProvider(() => ({
    baseUrl: preferences.value.aiBaseUrl,
    model: preferences.value.aiModel,
}), resourceSession.persistedMarkdown);
```

Pass it only to editable WYSIWYG:

```vue
<MoraEditor
    :ai-provider="tauriRuntime ? aiProvider : undefined"
/>
```

The provider closure reads latest preferences without recreating Milkdown.
Readonly preview never enables Crepe AI.
The current Task 4 App does not pass an `aiProvider` and makes no AI request.
Task 5/8 acceptance must prove the AI IPC request has canonicalized both
`AIPromptContext.document` and `selection`, with no `blob:` URL remaining.

- [ ] **Step 2: 映射 AI 错误到可见状态**

`handleAiError(message)` must:

```ts
errorMessage.value = message;
statusMessage.value = "AI 生成失败";
```

Missing Base URL、Model or Key must produce a visible message directing the user
to 偏好设置. No auto retry and no console log containing the request.

- [ ] **Step 3: 删除 Toast 专用样式**

Run:

```bash
rg -n "toastui|@toast-ui|preview-only" src package.json
```

Expected before cleanup: matches in CSS/tests; after cleanup: no matches.

Replace styles with:

- `.mora-editor` full-height layout。
- `.source-layout` one column。
- `.source-layout.split` two equal columns with one divider。
- `.milkdown-editor` and `.source-editor` height 100% and overflow auto。
- CodeMirror `.cm-editor` height 100%。
- Milkdown prose content uses existing `--editor-font-*` and `--content-width`。
- Dark theme uses documented public root classes and CSS variables only。
- Preserve `:focus-visible` and reduced-motion rules。

- [ ] **Step 4: 更新书面状态**

After implementation passes, change the design spec status from:

```text
设计已批准，规格待书面审核
```

to:

```text
已实现并验证
```

Only do this after every acceptance check below passes.

- [ ] **Step 5: 运行完整自动验证**

Run:

```bash
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected:

- all Vitest files pass；
- ESLint passes；
- Vue/TypeScript/Vite build passes；
- Rust tests and check pass；
- `mora.exe`、MSI、NSIS are generated。

- [ ] **Step 6: 运行最终静态验收**

Run:

```bash
rg -n "toastui|@toast-ui|preview-only|changePreviewStyle|changeMode" src package.json
```

Expected: no output。

Run:

```bash
rg -n "API.?Key|Authorization|api_key" src src-tauri/src
```

Expected: only field labels, command names and Bearer-header construction; no literal secret,
no LocalStorage persistence of key, no getter returning secret.

- [ ] **Step 7: 人工桌面验收**

In `npm run tauri -- dev` verify:

1. 新建、打开、保存、另存为和草稿恢复。
2. WYSIWYG、源码、源码加预览；没有仅预览入口。
3. 中文 IME、菜单格式、剪贴板、撤销、查找替换。
4. 已有图片显示，粘贴图片保存后重新打开仍显示。
5. 配置 Base URL、Model、Key；重启后显示“已配置”但不显示明文。
6. AI 流式生成、取消、拒绝、接受和重试。
7. 401、429 和不可访问服务显示可见错误，原文不变。

**Checkpoint:** `feat: complete Milkdown migration and WYSIWYG AI`

---

## Plan Self-Review

### Spec coverage

- Toast UI 直接删除：Task 4、Task 8。
- 三视图与单向预览：Task 2、Task 3、Task 4。
- `content.md` 唯一状态：Task 4。
- 现有资源链路：Task 3、Task 4、Task 8。
- Crepe 内置 AI：Task 3、Task 8。
- OpenAI-compatible、Channel、SSE：Task 5、Task 7。
- 系统凭据库与 URL 安全：Task 6。
- 错误、取消、Diff 和重试：Task 3、Task 7、Task 8。
- 无 EditorAdapter、Renderer、多 Provider 或多请求 Map：全局约束和文件地图。
- 测试与构建：每个任务检查点和 Task 8。

### Type consistency

- `EditorMode` 始终为 `"wysiwyg" | "source"`。
- 第三个视图只由 `sourcePreview: boolean` 表示。
- `MoraEditorHandle` 在三个组件中保持同一签名。
- AI IPC 统一使用 camelCase 参数和 `{type: "delta" | "done" | "error"}`。
- API Key 命令只接受写入/删除/存在性查询，不存在读取明文接口。

### Official references checked on 2026-07-28

- [Milkdown Crepe 7.21.3](https://www.npmjs.com/package/@milkdown/crepe)
- [Crepe guide and AI feature](https://milkdown.dev/docs/guide/using-crepe)
- [Milkdown commands](https://milkdown.dev/docs/guide/commands)
- [Milkdown replaceAll macro](https://milkdown.dev/docs/guide/faq)
- [CodeMirror system guide](https://codemirror.net/docs/guide/)
- [Tauri Channel](https://v2.tauri.app/develop/calling-rust/)
- [keyring 4.1.5](https://docs.rs/crate/keyring/latest)
- [reqwest 0.13.4](https://docs.rs/crate/reqwest/latest)
