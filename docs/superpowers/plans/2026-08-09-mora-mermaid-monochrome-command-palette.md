# Mora Mermaid、阅读黑白主题与命令面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 Mora 编辑器增加受控 Mermaid 渲染、阅读黑白主题和覆盖全部菜单操作的命令面板。

**Architecture:** Mermaid 通过 Crepe CodeMirror 功能的公开 `renderPreview` 配置桥接 `mermaid@11.16.1`，Markdown 仍是唯一保存来源。黑白主题扩展现有 `usePreferences` 的枚举和 CSS 变量。命令面板是一个局部 Vue 对话框，从 `App.vue` 的现有菜单数组派生命令并回调同一个 action，不建立命令注册中心。

**Tech Stack:** Vue 3 Composition API、TypeScript、Milkdown/Crepe 7.21.3、Mermaid 11.16.1、Vitest + jsdom、Tauri 2。

## Global Constraints

- `.mdx` 是 MDXNote ZIP；不引入 Web MDX / JSX，不改变 Rust command、包结构或 `.tmp + .bak` 保存流程。
- `App.vue` 的规范 Markdown 是唯一权威正文；Mermaid 块始终以 `mermaid` 围栏代码原文保存。
- Mermaid 仅支持：流程图、状态图、类图、ER 图、需求图、C4、架构图、方块图、时序图、甘特图、时间线、用户旅程图、思维导图。
- Mermaid 配置固定 `securityLevel: "strict"`，不执行图表源码中的 HTML 或脚本。
- 仅使用 Milkdown/Crepe、ProseMirror、CodeMirror 的公开 API；禁止访问编辑器内部 DOM、定时器补丁和第二份预览正文。
- WYSIWYG、垂直双栏右侧预览和打印临时编辑器使用同一个 Mermaid 代码块预览桥接；仅源码模式保留源码编辑。
- 命令面板列出文件、编辑、格式、插入、视图、关于和“最近打开”子菜单的全部现有操作。菜单与面板必须调用同一个 `action` 与 `disabled` 状态。
- 现有 `TODO.md` 在开始实施前已脏；只允许通过精确 hunk 更新本功能对应条目，禁止整文件暂存、重置或覆盖。
- 每项功能先跑定向测试；所有代码改动完成后必须运行 `npm test`、`npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run tauri -- build`。

---

### Task 1: Mermaid 代码块预览桥接

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/editor/mermaidPreview.ts`
- Test: `src/components/editor/mermaidPreview.test.ts`

**Interfaces:**
- Produces: `createMermaidPreview(mermaid: MermaidRenderer): CodeBlockPreview`，供 Crepe `CodeMirror` 功能的 `renderPreview` 调用。
- Produces: `isSupportedMermaidSource(source: string): boolean`，只允许本期约定的 Mermaid 图类型进入渲染器。
- Consumes: Mermaid 11.16.1 的公开 `initialize` 和 `render` API。

- [ ] **Step 1: 安装固定 Mermaid 运行时并写失败测试**

运行：

```powershell
npm install mermaid@11.16.1
```

创建 `src/components/editor/mermaidPreview.test.ts`，先覆盖受支持图、未支持图、渲染成功和渲染失败：

```ts
import { describe, expect, it, vi } from "vitest";
import {
    createMermaidPreview,
    isSupportedMermaidSource,
    type MermaidRenderer,
} from "./mermaidPreview";

describe("mermaidPreview", () => {
    it.each([
        "flowchart LR\nA --> B",
        "stateDiagram-v2\n[*] --> Ready",
        "classDiagram\nclass Note",
        "erDiagram\nNOTE ||--o{ ASSET : contains",
        "requirementDiagram\nrequirement note { id: 1 }",
        "C4Context\nSystem(note, \\"Note\\")",
        "architecture-beta\nservice api(server)[API]",
        "block-beta\ncolumns 2\nA B",
        "sequenceDiagram\nAlice->>Bob: Hi",
        "gantt\ntitle Plan\nsection Work\nBuild :a1, 2026-08-09, 1d",
        "timeline\ntitle History\n2026 : Start",
        "journey\ntitle Reading\nsection Write\nDraft: 5: User",
        "mindmap\n  root((Mora))\n    Note",
    ])("accepts supported Mermaid source: %s", (source) => {
        expect(isSupportedMermaidSource(source)).toBe(true);
    });

    it("keeps data-chart Mermaid source as an ordinary code block", () => {
        expect(isSupportedMermaidSource("pie\ntitle Usage\n\\\"Mora\\\" : 100")).toBe(false);
    });

    it("applies rendered SVG through the Milkdown preview callback", async () => {
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(async () => ({ svg: "<svg data-chart=\\\"flow\\\"></svg>" })),
        };
        const applyPreview = vi.fn();
        const preview = createMermaidPreview(mermaid);

        expect(preview("mermaid", "flowchart LR\nA --> B", applyPreview)).toBeUndefined();
        await vi.waitFor(() => expect(applyPreview).toHaveBeenCalled());
        expect(mermaid.render).toHaveBeenCalledOnce();
    });

    it("replaces a rejected render with a readable error without changing source", async () => {
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(async () => Promise.reject(new Error("syntax error"))),
        };
        const applyPreview = vi.fn();
        createMermaidPreview(mermaid)("mermaid", "flowchart LR\nA -->", applyPreview);

        await vi.waitFor(() => {
            const host = applyPreview.mock.calls[0]?.[0] as HTMLElement;
            expect(host.textContent).toContain("无法渲染");
            expect(host.classList.contains("mermaid-preview-error")).toBe(true);
        });
    });
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `npm test -- src/components/editor/mermaidPreview.test.ts`

Expected: FAIL，提示无法解析 `./mermaidPreview`。

- [ ] **Step 3: 实现范围检测和异步预览桥接**

创建 `src/components/editor/mermaidPreview.ts`。不要调用 `querySelector`；预览节点由 Crepe 的公开 `applyPreview` 接管。

```ts
export type MermaidRenderResult = { svg: string; bindFunctions?: (element: Element) => void };

export type MermaidRenderer = {
    initialize: (config: { startOnLoad: false; securityLevel: "strict"; theme: "neutral" }) => void;
    render: (id: string, source: string) => Promise<MermaidRenderResult>;
};

export type CodeBlockPreview = (
    language: string,
    source: string,
    applyPreview: (value: HTMLElement | null) => void,
) => void | null;

const supportedHeaders = /^(?:flowchart|graph|stateDiagram(?:-v2)?|classDiagram|erDiagram|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|architecture-beta|block-beta|sequenceDiagram|gantt|timeline|journey|mindmap)\b/mu;
let renderSequence = 0;

export function isSupportedMermaidSource(source: string): boolean {
    return supportedHeaders.test(source.replace(/^%%\{[\s\S]*?\}%%\s*/u, ""));
}

export function createMermaidPreview(mermaid: MermaidRenderer): CodeBlockPreview {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });

    return (language, source, applyPreview) => {
        if (language.trim().toLowerCase() !== "mermaid" || !isSupportedMermaidSource(source)) {
            return null;
        }

        const host = document.createElement("div");
        host.className = "mermaid-preview";
        host.setAttribute("role", "img");
        host.setAttribute("aria-label", "Mermaid 图表");
        applyPreview(host);

        void mermaid
            .render(`mora-mermaid-${renderSequence++}`, source)
            .then(({ svg, bindFunctions }) => {
                host.innerHTML = svg;
                bindFunctions?.(host);
            })
            .catch(() => {
                host.classList.add("mermaid-preview-error");
                host.removeAttribute("role");
                host.textContent = "Mermaid 图表无法渲染，请检查源码。";
            });
    };
}
```

只让 Mermaid 的受信任渲染结果写入由 Mermaid 产生的 SVG；`securityLevel: "strict"` 是该边界的必要条件。

- [ ] **Step 4: 运行桥接测试确认绿灯**

Run: `npm test -- src/components/editor/mermaidPreview.test.ts`

Expected: PASS，支持范围、普通代码回退、异步成功与失败路径全部通过。

- [ ] **Step 5: 提交 Mermaid 桥接基础**

```powershell
git add package.json package-lock.json src/components/editor/mermaidPreview.ts src/components/editor/mermaidPreview.test.ts
git commit -m "feat: add mermaid preview bridge"
```

### Task 2: 将 Mermaid 桥接接入现有 Crepe 代码块

**Files:**
- Modify: `src/components/editor/MilkdownEditor.vue`
- Modify: `src/components/editor/MilkdownEditor.test.ts`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes: `createMermaidPreview`，作为 `[Crepe.Feature.CodeMirror]` 的 `renderPreview`。
- Produces: Mermaid 代码块在可编辑和只读 Milkdown 实例中默认显示图表，并可通过现有预览切换按钮回到源码。

- [ ] **Step 1: 扩展 Milkdown mock，写接入失败测试**

在 `MilkdownEditor.test.ts` 的 Crepe mock 中加入 `CodeMirror: "code-mirror"`，并新增断言：

```ts
it.each([false, true])("configures the public CodeMirror preview hook for Mermaid blocks in readonly=%s", async (readonly) => {
    const editor = mountEditor("```mermaid\nflowchart LR\nA --> B\n```", readonly);
    cleanup = editor.unmount;
    await nextTick();

    const options = mocks.instances[0].options as {
        featureConfigs: Record<string, { previewOnlyByDefault?: boolean; renderPreview?: unknown }>;
    };
    expect(options.featureConfigs["code-mirror"].previewOnlyByDefault).toBe(true);
    expect(options.featureConfigs["code-mirror"].renderPreview).toEqual(expect.any(Function));
});
```

- [ ] **Step 2: 运行定向测试确认红灯**

Run: `npm test -- src/components/editor/MilkdownEditor.test.ts`

Expected: FAIL，`featureConfigs["code-mirror"]` 尚不存在。

- [ ] **Step 3: 通过 Crepe 公开功能配置接入**

在 `MilkdownEditor.vue` 增加导入：

```ts
import mermaid from "mermaid";
import { createMermaidPreview } from "./mermaidPreview";
```

在 `onMounted` 之前创建一个模块级稳定函数，避免文档切换重新初始化 Mermaid：

```ts
const renderMermaidPreview = createMermaidPreview(mermaid);
```

将现有 `featureConfigs` 的开头改为：

```ts
const featureConfigs = {
    [Crepe.Feature.CodeMirror]: {
        renderPreview: renderMermaidPreview,
        previewOnlyByDefault: true,
    },
    [Crepe.Feature.ImageBlock]: {
        onUpload: async (file: File) => {
            if (!props.uploadImage) throw new Error("图片上传不可用");
            return props.uploadImage(file);
        },
    },
    // 保留现有 AI 条件配置
};
```

`previewOnlyByDefault: true` 只会隐藏存在预览结果的代码块；非 Mermaid 代码块的预览结果为 `null`，继续显示源码。只读 Milkdown 本来就使用预览优先模式，因此垂直双栏和打印路径无需新增 renderer。

在 `experience.css` 添加受限布局样式：

```css
.mermaid-preview {
    display: grid;
    place-items: center;
    min-height: 96px;
    overflow-x: auto;
    padding: 16px;
    color: var(--color-text-main);
}

.mermaid-preview svg {
    max-width: 100%;
    height: auto;
}

.mermaid-preview-error {
    color: var(--color-danger);
    font-family: var(--font-mono);
}
```

- [ ] **Step 4: 运行编辑器测试确认绿灯**

Run: `npm test -- src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts`

Expected: PASS，既有 AI、文档切换、只读预览和新 CodeMirror 预览配置同时通过。

- [ ] **Step 5: 提交编辑器接入**

```powershell
git add src/components/editor/MilkdownEditor.vue src/components/editor/MilkdownEditor.test.ts src/experience.css
git commit -m "feat: render supported mermaid diagrams"
```

### Task 3: 阅读黑白主题

**Files:**
- Modify: `src/composables/usePreferences.ts`
- Modify: `src/composables/usePreferences.test.ts`
- Modify: `src/components/SettingsPanel.vue`
- Modify: `src/experience.css`
- Test: `src/components/SettingsPanel.test.ts`

**Interfaces:**
- Produces: `ThemePreference = "system" | "light" | "dark" | "monochrome"`。
- Produces: `data-theme="monochrome"` 的阅读灰阶变量组。

- [ ] **Step 1: 为偏好归一化写失败测试**

在 `usePreferences.test.ts` 添加：

```ts
it("persists the monochrome reading theme", () => {
    const storage = createStorage();
    const preferences = normalizePreferences({ theme: "monochrome" });

    expect(preferences.theme).toBe("monochrome");
    savePreferences(storage, preferences);
    expect(loadPreferences(storage).theme).toBe("monochrome");
    expect(resolveTheme("monochrome", true)).toBe("monochrome");
});
```

创建 `SettingsPanel.test.ts`，验证主题选项可见并向父级发出更新：

```ts
it("emits monochrome theme selection", async () => {
    const wrapper = mount(SettingsPanel, { props: settingsProps() });
    const select = wrapper.get("select");
    await select.setValue("monochrome");

    expect(wrapper.emitted("update")).toContainEqual([{ theme: "monochrome" }]);
});
```

- [ ] **Step 2: 运行主题测试确认红灯**

Run: `npm test -- src/composables/usePreferences.test.ts src/components/SettingsPanel.test.ts`

Expected: FAIL，`monochrome` 不在主题类型和设置选项中。

- [ ] **Step 3: 最小扩展主题偏好和界面**

在 `usePreferences.ts` 修改枚举和允许列表：

```ts
export type ThemePreference = "system" | "light" | "dark" | "monochrome";

const themes: ThemePreference[] = ["system", "light", "dark", "monochrome"];

export function resolveTheme(theme: ThemePreference, prefersDark: boolean) {
    return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}
```

在 `SettingsPanel.vue` 的主题 `<select>` 增加：

```vue
<option value="monochrome">阅读黑白</option>
```

在 `experience.css` 的 dark block 后添加：

```css
:root[data-theme="monochrome"] {
    --color-bg-base: #ededed;
    --color-bg-surface: #ffffff;
    --color-bg-elevated: rgba(255, 255, 255, 0.98);
    --color-border: rgba(20, 20, 20, 0.18);
    --color-text-main: #161616;
    --color-text-muted: #5f5f5f;
    --color-primary: #242424;
    --color-primary-light: #e2e2e2;
    --color-danger: #444444;
    --color-success: #363636;
    --shadow-lg: 0 16px 44px rgba(0, 0, 0, 0.14);
    color-scheme: light;
}
```

- [ ] **Step 4: 运行主题测试确认绿灯**

Run: `npm test -- src/composables/usePreferences.test.ts src/components/SettingsPanel.test.ts`

Expected: PASS，黑白主题可以归一化、持久化、解析并从设置面板选择。

- [ ] **Step 5: 提交主题功能**

```powershell
git add src/composables/usePreferences.ts src/composables/usePreferences.test.ts src/components/SettingsPanel.vue src/components/SettingsPanel.test.ts src/experience.css
git commit -m "feat: add monochrome reading theme"
```

### Task 4: 命令面板组件

**Files:**
- Create: `src/components/CommandPalette.vue`
- Test: `src/components/CommandPalette.test.ts`
- Modify: `src/experience.css`

**Interfaces:**
- Produces: `CommandPaletteCommand` 类型，字段为 `id`、`category`、`label`、`shortcut`、`disabled`。
- Produces: `run`、`close` 事件；组件不保存业务 action。
- Consumes: `open: boolean` 和命令列表，使用父级事件执行命令。

- [ ] **Step 1: 编写组件交互失败测试**

创建 `CommandPalette.test.ts`：

```ts
const commands = [
    { id: "file.new", category: "文件", label: "新建", shortcut: "Ctrl+N", disabled: false },
    { id: "edit.undo", category: "编辑", label: "撤销", shortcut: "Ctrl+Z", disabled: true },
    { id: "view.settings", category: "视图", label: "偏好设置...", disabled: false },
];

it("filters commands and executes the keyboard-selected enabled result", async () => {
    const wrapper = mount(CommandPalette, { props: { open: true, commands } });
    await wrapper.get("input[aria-label='搜索命令']").setValue("偏好");
    await wrapper.get("input[aria-label='搜索命令']").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("run")).toEqual([["view.settings"]]);
});

it("keeps disabled commands visible but does not execute them", async () => {
    const wrapper = mount(CommandPalette, { props: { open: true, commands } });
    await wrapper.get("input[aria-label='搜索命令']").setValue("撤销");
    await wrapper.get("input[aria-label='搜索命令']").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("run")).toBeUndefined();
});

it("moves with arrows and restores the invoking focus after Escape", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const wrapper = mount(CommandPalette, { attachTo: document.body, props: { open: true, commands } });
    await wrapper.get("input[aria-label='搜索命令']").trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.get("[role='option'][aria-selected='true']").text()).toContain("撤销");

    await wrapper.get("input[aria-label='搜索命令']").trigger("keydown", { key: "Escape" });
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(trigger);
});
```

- [ ] **Step 2: 运行组件测试确认红灯**

Run: `npm test -- src/components/CommandPalette.test.ts`

Expected: FAIL，组件尚不存在。

- [ ] **Step 3: 实现无业务逻辑的可访问命令面板**

创建 `CommandPalette.vue`，核心接口和交互如下：

```ts
export type CommandPaletteCommand = {
    id: string;
    category: string;
    label: string;
    shortcut?: string;
    disabled: boolean;
};
```

```ts
const props = defineProps<{ open: boolean; commands: CommandPaletteCommand[] }>();
const emit = defineEmits<{ close: []; run: [id: string] }>();
const query = ref("");
const activeIndex = ref(0);
const input = ref<HTMLInputElement | null>(null);
let returnFocus: HTMLElement | null = null;

const filteredCommands = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase("zh-CN");
    return props.commands.filter((command) => {
        const haystack = `${command.category} ${command.label}`.toLocaleLowerCase("zh-CN");
        return !needle || haystack.includes(needle);
    });
});

function executeActive(): void {
    const command = filteredCommands.value[activeIndex.value];
    if (command && !command.disabled) emit("run", command.id);
}
```

监听 `open`：打开时记录 `document.activeElement` 并在 `nextTick` 聚焦 `input`；关闭时清空查询和索引，并在 `nextTick` 恢复仍连接的 `returnFocus`。键盘处理只支持 ArrowUp、ArrowDown、Enter、Escape；列表使用 `role="listbox"`，每个命令使用 `role="option"` 和 `aria-selected`。

在 `experience.css` 添加 `.command-palette`、`.command-palette-list`、`.command-palette-item` 的样式，复用 `--color-*`、`.panel-backdrop` 和 `.icon-button`，不嵌套卡片，不引入渐变。

- [ ] **Step 4: 运行组件测试确认绿灯**

Run: `npm test -- src/components/CommandPalette.test.ts`

Expected: PASS，筛选、禁用、上下键、Enter、Escape 和焦点恢复均通过。

- [ ] **Step 5: 提交命令面板组件**

```powershell
git add src/components/CommandPalette.vue src/components/CommandPalette.test.ts src/experience.css
git commit -m "feat: add command palette component"
```

### Task 5: 将命令面板接入现有菜单动作

**Files:**
- Modify: `src/App.vue`
- Modify: `src/App.web.test.ts`

**Interfaces:**
- Consumes: `CommandPaletteCommand`、`CommandPalette.vue`。
- Produces: `Ctrl+Shift+P` 打开命令面板；所有六组菜单命令与最近打开子菜单以同一 action 由菜单和面板执行。

- [ ] **Step 1: 写 App 集成失败测试**

在 `App.web.test.ts` 添加：

```ts
it("opens the command palette and runs the existing file-menu new action", async () => {
    const host = await mountApp();
    window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, shiftKey: true, key: "p" }),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("搜索命令"));

    const input = host.querySelector<HTMLInputElement>("input[aria-label='搜索命令']");
    input?.dispatchEvent(new InputEvent("input", { bubbles: true, data: "新建" }));
    input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    await vi.waitFor(() => expect(host.textContent).toContain("未命名文档 1"));
});

it("lists disabled document commands without running them when no document is open", async () => {
    const host = await mountApp();
    window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, shiftKey: true, key: "p" }),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("保存"));
    expect(host.querySelector("[data-command-id='file.save']")?.getAttribute("aria-disabled")).toBe("true");
});

it("includes the existing recent-file submenu actions", async () => {
    const host = await mountAppWithRecentFiles(["C:\\\\Notes\\\\today.mdx"]);
    window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, shiftKey: true, key: "p" }),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("today.mdx"));
    expect(host.textContent).toContain("查看全部……");
    expect(host.textContent).toContain("清空最近打开");
});
```

- [ ] **Step 2: 运行 App 测试确认红灯**

Run: `npm test -- src/App.web.test.ts`

Expected: FAIL，尚无快捷键、面板和 `data-command-id`。

- [ ] **Step 3: 从现有菜单数组派生面板命令**

在 `App.vue` 导入组件和类型：

```ts
import CommandPalette, { type CommandPaletteCommand } from "./components/CommandPalette.vue";
```

为既有 `MarkdownCommand` 加入稳定 id，并为六组菜单项显式赋值。例如：

```ts
type MarkdownCommand = {
    id: string;
    label: string;
    action: () => void | Promise<void>;
    disabled?: boolean;
    shortcut?: string;
};

const fileMenu = computed<MarkdownCommand[]>(() => [
    { id: "file.new", label: "新建", shortcut: "Ctrl+N", action: createNewNote },
    { id: "file.open", label: "打开文件...", shortcut: "Ctrl+O", action: openFiles },
    { id: "file.open-folder", label: "打开文件夹...", action: openFolder },
]);
```

为所有其余既有菜单项使用以下固定 id；不得从显示文案生成 id：

| 菜单 | id |
| --- | --- |
| 文件 | `file.close`、`file.library`、`file.save`、`file.save-as`、`file.export-markdown`、`file.export-pdf` |
| 编辑 | `edit.undo`、`edit.redo`、`edit.cut`、`edit.copy`、`edit.paste`、`edit.select-all`、`edit.find`、`edit.replace` |
| 格式 | `format.paragraph`、`format.heading-1` 至 `format.heading-6`、`format.bold`、`format.italic`、`format.strike`、`format.code` |
| 插入 | `insert.block-quote`、`insert.bullet-list`、`insert.ordered-list`、`insert.task-list`、`insert.indent`、`insert.outdent`、`insert.hr`、`insert.code-block`、`insert.link`、`insert.image-reference`、`insert.resource`、`insert.table` |
| 视图 | `view.wysiwyg`、`view.split`、`view.source`、`view.toggle-outline`、`view.history`、`view.settings`、`view.cursor-start`、`view.cursor-end` |
| 关于 | `about.app` |

增加状态和带 action 的派生列表：

```ts
const showCommandPalette = ref(false);

type PaletteEntry = CommandPaletteCommand & { action: MarkdownCommand["action"] };

const paletteEntries = computed<PaletteEntry[]>(() =>
    ([
        ["file", "文件", fileMenu.value],
        ["edit", "编辑", editMenu.value],
        ["format", "格式", formatMenu.value],
        ["insert", "插入", insertMenu.value],
        ["view", "视图", viewMenu.value],
        ["about", "关于", aboutMenu.value],
    ] as const).flatMap(([groupId, category, commands]) =>
        commands.map((command) => ({
            id: command.id,
            category,
            label: command.label,
            shortcut: command.shortcut,
            disabled: Boolean(command.disabled) ||
                ((groupId === "format" || groupId === "insert") && !activeDocument.value),
            action: command.action,
        })),
    ),
);

const recentPaletteEntries = computed<PaletteEntry[]>(() => [
    ...recentMenuItems.value.map((item) => ({
        id: `recent.open.${item.path}`,
        category: "最近打开",
        label: formatRecentFileLabel(item),
        shortcut: item.path,
        disabled: false,
        action: () => openRecentFile(item.path),
    })),
    {
        id: "recent.show-all",
        category: "最近打开",
        label: "查看全部……",
        disabled: recentFiles.value.length === 0,
        action: () => {
            showRecentFiles.value = true;
        },
    },
    {
        id: "recent.clear",
        category: "最近打开",
        label: "清空最近打开",
        disabled: recentFiles.value.length === 0,
        action: clearRecentFiles,
    },
]);

const paletteCommands = computed<CommandPaletteCommand[]>(() =>
    [...paletteEntries.value, ...recentPaletteEntries.value].map(({ action: _action, ...command }) => command),
);

function runPaletteCommand(id: string): void {
    const command = [...paletteEntries.value, ...recentPaletteEntries.value].find((item) => item.id === id);
    if (!command || command.disabled) return;
    showCommandPalette.value = false;
    void command.action();
}
```

在全局快捷键处理函数的最前方处理 `Ctrl+Shift+P`，允许文本输入框内触发：

```ts
if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "p") {
    event.preventDefault();
    showCommandPalette.value = true;
    return;
}
```

在 `main` 的末尾、其他模态组件附近挂载：

```vue
<CommandPalette
    :open="showCommandPalette"
    :commands="paletteCommands"
    @close="showCommandPalette = false"
    @run="runPaletteCommand"
/>
```

为命令行添加 `:data-command-id="command.id"`。执行逻辑只按稳定 id 查找，不依赖本地化 `label`；六组菜单继续使用 `file.new`、`file.save`、`edit.undo`、`format.heading-1`、`insert.table`、`view.settings`、`about.app` 等 id，最近文件使用 `recent.open.<path>`。

- [ ] **Step 4: 运行 App 集成测试确认绿灯**

Run: `npm test -- src/App.web.test.ts src/components/CommandPalette.test.ts`

Expected: PASS，快捷键、完整菜单派生、禁用状态和已有 action 复用都通过。

- [ ] **Step 5: 提交命令面板集成**

```powershell
git add src/App.vue src/App.web.test.ts
git commit -m "feat: expose menu actions through command palette"
```

### Task 6: 文档收口与完整验证

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`（仅功能对应 hunk）
- Modify: `docs/superpowers/specs/2026-08-09-mora-mermaid-monochrome-command-palette-design.md`

- [ ] **Step 1: 更新用户可见能力说明**

在 `README.md` 的“当前限制”后添加已支持范围，避免承诺未支持图表：

```markdown
## 图表与命令

- 支持 `mermaid` 围栏代码块中的流程与结构、时序与计划、思维导图；仅源码模式保留源码，其他 Milkdown 预览和打印路径显示图表。
- 提供“阅读黑白”主题和 `Ctrl+Shift+P` 命令面板；命令面板复用所有既有菜单操作。
```

在 `TODO.md` 中把“黑白主题”“命令窗口”“Mermaid 图表渲染”对应行改为 `[x]`，并将 Mermaid 子项替换为当前支持分类和未支持分类的准确说明。先运行 `git diff -- TODO.md`，只暂存本次变更 hunk。

- [ ] **Step 2: 运行全部验证命令**

Run: `npm test`

Expected: 现有测试和新增测试全部通过，零失败。

Run: `npm run build`

Expected: exit 0；可记录既有大 chunk 警告，但不得出现类型或打包错误。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit 0。

Run: `npm run tauri -- build`

Expected: exit 0，生成 `src-tauri/target/release/mora.exe` 与安装包。

- [ ] **Step 3: 审查最终差异并提交文档**

```powershell
git diff --check
git status --short
git add README.md
git add -p TODO.md
git add docs/superpowers/specs/2026-08-09-mora-mermaid-monochrome-command-palette-design.md
git commit -m "docs: document diagram and command features"
```

若 `TODO.md` 含有无法与本功能分离的既有 hunk，保留它未提交，并在交付中明确报告；禁止把用户已有内容纳入提交。
