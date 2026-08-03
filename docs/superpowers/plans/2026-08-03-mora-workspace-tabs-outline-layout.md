# Mora Workspace Tabs and Outline Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有多文档会话呈现为“左侧工作区 + 中间普通标签页与编辑器 + 右侧当前文档目录”，并用底栏两端按钮控制侧栏显示。

**Architecture:** 继续以 `useDocumentSession` 作为唯一文档状态来源，新建纯展示型 `DocumentTabs.vue`；现有工作区只保留文件夹树，目录继续从活动文档 canonical Markdown 派生。宽/窄窗口协调留在 `App.vue`，复用现有 `showToc`、工作区持久化和关闭状态机，不新增状态库、适配层或 Rust 命令。

**Tech Stack:** Vue 3 `<script setup>`、TypeScript、Vitest + jsdom、现有 CSS、Tauri 2；本计划预计不修改 Rust。

## Global Constraints

- `.mdx` 继续表示 Mora 的 MDXNote ZIP 格式，不引入 Web MDX / JSX。
- `App.vue` 中的 canonical Markdown 仍是唯一权威正文；标签、工作区和目录不得复制正文状态。
- 编辑器固定使用 Milkdown/Crepe + CodeMirror 6；本次不调整现有编辑器模式切换按钮。
- 不新增 Pinia、状态库、WorkspaceAdapter、注册中心、工厂或插件协议。
- 标签只实现普通固定标签、判重激活、关闭、脏标记和单行横向滚动；不实现预览标签、固定标签、拖拽排序、标签组或拆分编辑器。
- 左侧工作区继续可调宽；右侧目录保持现有固定宽度，不增加新的宽度偏好。
- 响应式分界必须使用精确的 `max-width: 980px`。
- 所有文件系统行为继续复用现有 Tauri commands；本计划不改变 Rust 文件格式、扫描或会话模型。
- 不修改或暂存用户当前未提交的 `README.md` 与 `TODO.md`。
- 每个代码任务完成后必须运行 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run tauri -- build`；同时运行该任务列出的测试。

---

## File Structure

- Create `src/components/DocumentTabs.vue`: 标签展示、键盘切换、关闭意图、横向滚动和活动标签滚入视野。
- Create `src/components/DocumentTabs.test.ts`: 标签组件的渲染、事件、键盘和溢出测试。
- Modify `src/components/WorkspaceSidebar.vue`: 删除独立打开文件分区，只保留文件夹树与空态入口。
- Modify `src/components/WorkspaceSidebar.test.ts`: 固化文件夹专属职责和现有树形可访问性。
- Modify `src/components/TableOfContents.vue`: 变为由 App 控制的右侧面板，移除组件内部显隐入口，支持紧凑覆盖样式。
- Create `src/components/TableOfContents.test.ts`: 目录显示、紧凑态、选择事件和空目录测试。
- Modify `src/components/StatusBar.vue`: 在最左/最右增加镜像侧栏按钮。
- Create `src/components/StatusBar.test.ts`: 按钮位置、状态、禁用和事件测试。
- Modify `src/App.vue`: 接入标签、三段式布局、打开文件夹自动展开、目录可用性和 `980px` 覆盖层协调。
- Modify `src/App.web.test.ts`: 把独立文档切换断言迁移到标签，并覆盖宽/窄窗口侧栏规则。
- Modify `src/App.markdown-layout.test.ts`: 固化三栏顺序、底栏按钮接线和模式切换位置不变。
- Modify `src/style.css`: 标签栏、中央列、右侧目录、底栏按钮与覆盖层样式。
- Modify `src/experience.css`: 将旧的 `900px` 目录隐藏规则替换为统一的 `980px` 紧凑布局规则。

---

### Task 1: Add and integrate ordinary document tabs

**Files:**
- Create: `src/components/DocumentTabs.vue`
- Create: `src/components/DocumentTabs.test.ts`
- Modify: `src/App.vue:1-18,2023-2093`
- Modify: `src/App.web.test.ts:406-409,796-849`
- Modify: `src/style.css:62-68`

**Interfaces:**
- Consumes: `OpenDocument[]` and `activeDocumentId: string | null` from `useDocumentSession`.
- Produces: `activate(id: string)` and `close(id: string)` events; CSS classes `.document-tabs`, `.document-tabs-scroll`, `.document-tab`, `.document-tab-target`, `.document-tab-close`, `.workspace-center`.
- Does not own: document content, order, duplicate detection, dirty mutation, save confirmation or editor state.

- [ ] **Step 1: Write the failing component tests**

Create `src/components/DocumentTabs.test.ts` with jsdom and explicit `OpenDocument` fixtures:

```ts
/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenDocument } from "../composables/useDocumentSession";
import DocumentTabs from "./DocumentTabs.vue";

let app: App<Element> | null = null;

afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

function documentItem(id: string, dirty = false): OpenDocument {
    return {
        id,
        path: `C:\\notes\\${id}.mdx`,
        pathIdentity: `c:\\notes\\${id}.mdx`,
        sourceKind: "mdx",
        importSourcePath: null,
        displayName: id,
        content: `# ${id}`,
        meta: null,
        dirty,
        diskRevision: null,
        conflict: false,
        unavailable: false,
    };
}

function mountTabs(activeDocumentId = "b") {
    const emitted = new Map<string, string[]>();
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(DocumentTabs, {
                documents: [documentItem("a", true), documentItem("b")],
                activeDocumentId,
                onActivate: (id: string) => emitted.set("activate", [...(emitted.get("activate") ?? []), id]),
                onClose: (id: string) => emitted.set("close", [...(emitted.get("close") ?? []), id]),
            }),
    });
    app.mount(host);
    return { host, emitted };
}

describe("DocumentTabs", () => {
    it("renders ordinary tabs with active and dirty semantics", () => {
        const { host } = mountTabs();
        const tabs = host.querySelectorAll<HTMLElement>('[role="tab"]');
        expect(tabs).toHaveLength(2);
        expect(tabs[0].getAttribute("aria-label")).toContain("未保存");
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(tabs[1].getAttribute("tabindex")).toBe("0");
    });

    it("emits activate and close without owning document state", async () => {
        const { host, emitted } = mountTabs();
        host.querySelector<HTMLButtonElement>('[aria-label^="切换到 a"]')?.click();
        host.querySelector<HTMLButtonElement>('[aria-label="关闭 b"]')?.click();
        await nextTick();
        expect(emitted.get("activate")).toEqual(["a"]);
        expect(emitted.get("close")).toEqual(["b"]);
    });

    it("uses arrow keys and scrolls the active tab into view", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const { host, emitted } = mountTabs("a");
        host.querySelector<HTMLButtonElement>('[aria-label^="切换到 a"]')?.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
        );
        await nextTick();
        expect(emitted.get("activate")).toEqual(["b"]);
        expect(scrollIntoView).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npm test -- src/components/DocumentTabs.test.ts
```

Expected: FAIL because `src/components/DocumentTabs.vue` does not exist.

- [ ] **Step 3: Implement the minimal `DocumentTabs` component**

Create `src/components/DocumentTabs.vue` with this public contract and behavior:

```vue
<script setup lang="ts">
import { nextTick, ref, watch, type ComponentPublicInstance } from "vue";

import type { OpenDocument } from "../composables/useDocumentSession";

const props = defineProps<{
    documents: OpenDocument[];
    activeDocumentId: string | null;
}>();
const emit = defineEmits<{
    activate: [id: string];
    close: [id: string];
}>();

const scrollHost = ref<HTMLElement | null>(null);
const tabTargets = new Map<string, HTMLButtonElement>();

function setTabTarget(
    id: string,
    element: Element | ComponentPublicInstance | null,
) {
    if (element instanceof HTMLButtonElement) tabTargets.set(id, element);
    else tabTargets.delete(id);
}

function activateAt(index: number) {
    const document = props.documents[index];
    if (!document) return;
    emit("activate", document.id);
    tabTargets.get(document.id)?.focus();
}

function onKeydown(event: KeyboardEvent, index: number) {
    if (event.key === "ArrowRight") {
        event.preventDefault();
        activateAt((index + 1) % props.documents.length);
    } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        activateAt((index - 1 + props.documents.length) % props.documents.length);
    } else if (event.key === "Home") {
        event.preventDefault();
        activateAt(0);
    } else if (event.key === "End") {
        event.preventDefault();
        activateAt(props.documents.length - 1);
    }
}

function onWheel(event: WheelEvent) {
    const host = scrollHost.value;
    if (!host || host.scrollWidth <= host.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    host.scrollLeft += event.deltaY;
}

watch(
    () => props.activeDocumentId,
    async (id) => {
        await nextTick();
        if (id) tabTargets.get(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    { immediate: true, flush: "post" },
);
</script>

<template>
    <nav v-if="documents.length" class="document-tabs" aria-label="打开的文档">
        <div ref="scrollHost" class="document-tabs-scroll" role="tablist" @wheel="onWheel">
            <div
                v-for="(document, index) in documents"
                :key="document.id"
                class="document-tab"
                :class="{ active: document.id === activeDocumentId }"
            >
                <button
                    :ref="(element) => setTabTarget(document.id, element)"
                    type="button"
                    class="document-tab-target"
                    role="tab"
                    aria-controls="document-editor-panel"
                    :aria-selected="document.id === activeDocumentId"
                    :aria-label="`切换到 ${document.displayName}${document.dirty ? '，未保存' : ''}`"
                    :tabindex="document.id === activeDocumentId ? 0 : -1"
                    @click="emit('activate', document.id)"
                    @keydown="onKeydown($event, index)"
                >
                    <span v-if="document.dirty" class="document-tab-dirty" aria-hidden="true" />
                    <span class="document-tab-name">{{ document.displayName }}</span>
                </button>
                <button
                    type="button"
                    class="document-tab-close"
                    :aria-label="`关闭 ${document.displayName}`"
                    @click.stop="emit('close', document.id)"
                >
                    ×
                </button>
            </div>
        </div>
    </nav>
</template>
```

- [ ] **Step 4: Run the component test and verify GREEN**

Run:

```bash
npm test -- src/components/DocumentTabs.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Integrate tabs without removing the existing workspace document list yet**

In `src/App.vue`:

```ts
import DocumentTabs from "./components/DocumentTabs.vue";
```

Leave the current `WorkspaceSidebar` and `TableOfContents` order unchanged for this task. Immediately before the current `section v-if="activeDocument"` at `src/App.vue:2047`, insert:

```vue
<div class="workspace-center">
    <DocumentTabs
        :documents="documents"
        :active-document-id="activeDocumentId"
        @activate="activateDocument"
        @close="closeDocument"
    />
```

Add `id="document-editor-panel"` and `role="tabpanel"` to the existing active-document section. Move the complete current active-document section (`src/App.vue:2047-2078`) and welcome section (`src/App.vue:2079-2092`) inside `.workspace-center` without changing their child markup. Insert the matching `</div>` immediately after the welcome section.

Add the minimal central-column and tab CSS in `src/style.css`:

```css
.workspace-center {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
}

.document-tabs {
    min-width: 0;
    flex: 0 0 34px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-base);
}

.document-tabs-scroll {
    height: 100%;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
}

.document-tab {
    min-width: 128px;
    max-width: 220px;
    display: flex;
    align-items: stretch;
    border-right: 1px solid var(--color-border);
}

.document-tab.active {
    background: var(--color-bg-surface);
    box-shadow: inset 0 2px var(--color-primary);
}

.document-tab-target {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 0 10px;
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
}

.document-tab.active .document-tab-target {
    color: var(--color-text-main);
}

.document-tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.document-tab-dirty {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    border-radius: 50%;
    background: var(--color-primary);
}

.document-tab-close {
    width: 26px;
    flex: 0 0 26px;
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
}
```

Do not move or rewrite `.mode-switch.compact`.

- [ ] **Step 6: Add an App-level tab regression while retaining existing tree-based tests**

In `src/App.web.test.ts`, add:

```ts
function documentTab(host: HTMLElement, name: string) {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (item) => item.textContent?.trim() === name,
    );
}

it("一次打开多个文件会生成普通标签并通过标签切换活动文档", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.openDialog.mockResolvedValue(["C:\\notes\\a.mdx", "C:\\notes\\b.mdx"]);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();

    findButton(host, "打开文件...")?.click();
    await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2));
    documentTab(host, "a")?.click();
    await vi.waitFor(() => expect(mocks.getMoraEditorMarkdown?.()).toBe("# a"));
    documentTab(host, "b")?.click();
    await vi.waitFor(() => expect(mocks.getMoraEditorMarkdown?.()).toBe("# b"));
});
```

- [ ] **Step 7: Run targeted tests and the required build gate**

Run:

```bash
npm test -- src/components/DocumentTabs.test.ts src/App.web.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected: all targeted tests pass; build, Cargo check and Tauri packaging exit 0. Existing chunk-size and Windows incremental-cache warnings may remain warnings only.

- [ ] **Step 8: Commit Task 1 only**

```bash
git add src/components/DocumentTabs.vue src/components/DocumentTabs.test.ts src/App.vue src/App.web.test.ts src/style.css
git diff --cached --check
git commit -m "feat: add multi-document tabs"
```

Before committing, verify `git diff --cached --name-only` does not include `README.md` or `TODO.md`.

---

### Task 2: Make the workspace sidebar folder-only

**Files:**
- Modify: `src/components/WorkspaceSidebar.vue:20-176,343-478`
- Modify: `src/components/WorkspaceSidebar.test.ts:20-232,282-392`
- Modify: `src/App.vue:2023-2038`
- Modify: `src/App.web.test.ts:406-409` and every independent-document selector in the `App 多文档工作区` suites

**Interfaces:**
- Keeps: `documents`, `folders`, `activeDocumentId`, `expandedPaths`, `collapsed`, `width`, `activate`, `open-path`, `close-folder`, `refresh-folder`, `toggle-expanded`, `update:collapsed`, `update:width` until Task 3 moves visibility control fully to App.
- Adds: `open-folder` event for the empty workspace action.
- Removes: rendered `打开的文件` section and document-close toolbar behavior; tabs become the sole primary UI for independent documents.

- [ ] **Step 1: Rewrite the sidebar expectations first and verify RED**

Replace the first sidebar test with:

```ts
it("renders only folder roots and never duplicates independent open documents", () => {
    const sidebar = mountSidebar({
        documents: [
            documentItem("C:\\Root\\inside.mdx"),
            documentItem("C:\\Other\\outside.mdx"),
            untitled(),
        ],
        folders: [folder("C:\\Root", [file("C:\\Root\\inside.mdx")])],
        expandedPaths: ["C:\\Root"],
    });

    expect(sidebar.host.textContent).toContain("inside.mdx");
    expect(sidebar.host.textContent).not.toContain("outside.mdx");
    expect(sidebar.host.textContent).not.toContain("未命名文档 1");
    expect(sidebar.host.textContent).not.toContain("打开的文件");
});
```

Add an empty-state event test:

```ts
it("offers opening a folder when the workspace has no roots", () => {
    const sidebar = mountSidebar();
    sidebar.host.querySelector<HTMLButtonElement>('[aria-label="打开文件夹"]')?.click();
    expect(sidebar.emitted("open-folder")).toEqual([[]]);
});
```

Before adding the test, make the mount helper record zero-argument events without inserting `undefined`:

```ts
const record = (event: string, ...values: unknown[]) => {
    emitted.set(event, [...(emitted.get(event) ?? []), values]);
};
```

Add `onOpenFolder: () => record("open-folder")` to the rendered component props. Existing one-argument handlers continue to call the same variadic helper.

Change the status test so the dirty/conflict/unavailable document is inside an expanded folder. Remove assertions that close an independent document from `.workspace-action-toolbar`; retain the folder refresh/close assertions.

Run:

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: FAIL because independent rows still render and `open-folder` is not emitted.

- [ ] **Step 2: Remove the independent document projection from `WorkspaceSidebar.vue`**

Apply these exact structural changes:

```ts
type TreeRow = {
    key: string;
    label: string;
    path: string;
    depth: number;
    kind: "folder" | "directory" | "file";
    expanded: boolean | null;
    active: boolean;
    statuses: string[];
    documentId: string | null;
    folderPath: string | null;
};
```

Delete `independentRows`. Change:

```ts
const rows = computed(() => folderRows.value);
```

Add the emit:

```ts
"open-folder": [];
```

Render the empty action outside the ARIA tree, and render one tree only when roots exist:

```vue
<div v-if="!folderRows.length" class="workspace-empty">
    <p>尚未打开文件夹</p>
    <button type="button" aria-label="打开文件夹" @click="emit('open-folder')">
        打开文件夹
    </button>
</div>
<div v-else class="workspace-tree" role="tree" aria-label="工作区文件" @keydown="onTreeKeydown">
    <div v-for="row in folderRows" :key="row.key" class="workspace-tree-row" role="none">
        <div
            :ref="(element) => setTreeItem(row.key, element)"
            class="workspace-tree-item"
            :class="{ active: row.active }"
            role="treeitem"
            :data-tree-key="row.key"
            :aria-level="row.depth"
            :aria-expanded="row.expanded === null ? undefined : row.expanded"
            :aria-current="row.active ? 'page' : undefined"
            :tabindex="rowTabindex(row)"
            :style="{ paddingInlineStart: `${8 + (row.depth - 1) * 14}px` }"
            @click="selectRow(row)"
            @focus="rovingKey = row.key"
        >
            <span v-if="row.expanded !== null" class="workspace-disclosure">
                {{ row.expanded ? "⌄" : "›" }}
            </span>
            <span class="workspace-name">{{ row.label }}</span>
            <span v-for="status in row.statuses" :key="status" class="workspace-status">
                {{ status }}
            </span>
        </div>
    </div>
</div>
```

Restrict the bottom action toolbar to `currentActionRow?.kind === 'folder'`; remove the document close branch. Keep `documentsByPath` because folder-owned files still need active, dirty and conflict status.

- [ ] **Step 3: Run sidebar tests and verify GREEN**

Run:

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: PASS; the longest-root, keyboard, resize, compact and folder-action cases remain covered.

- [ ] **Step 4: Wire the empty action and move independent-document App tests to tabs**

In `src/App.vue`, declare `compactLayout`, `compactPanel` and `compactMedia` near the existing sidebar/TOC preferences. Declare the computed values below immediately after the existing `const toc = computed(...)` so every dependency is initialized before use:

```vue
@open-folder="openFolder"
```

Keep `@close-document` only until every App test below is migrated, then remove it from the sidebar binding because document closing is owned by tabs and application commands.

In `src/App.web.test.ts`, retain `documentRow()` for files that are actually inside a workspace root, and use `documentTab()` for independent/untitled/restored documents. Apply these mappings:

```ts
// independent restored or dialog-opened documents
documentTab(host, "a")?.click();
documentTab(host, "b")?.click();

// close a non-active independent document
host.querySelector<HTMLButtonElement>('[aria-label="关闭 a"]')?.click();

// folder-owned file: continue to use the workspace tree
documentRow(host, "folder-save.md")?.click();
```

Update assertions that counted standalone `[role="treeitem"]` nodes to count `[role="tab"]`. Keep tree counts only in tests that open folder roots. In the existing dirty-switch test, the central expectation becomes:

```ts
await vi.waitFor(() => expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2));
documentTab(host, "a")?.click();
mocks.editorUpdate?.("dirty a");
await nextTick();
documentTab(host, "b")?.click();
await nextTick();
documentTab(host, "a")?.click();
expect(mocks.getMoraEditorMarkdown?.()).toBe("dirty a");
```

Do not weaken the existing save, conflict, resource hydration, folder-close or AI-cancel assertions.

- [ ] **Step 5: Run full frontend tests and the required build gate**

Run:

```bash
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected: all existing frontend tests pass after selector migration; all three required builds exit 0.

- [ ] **Step 6: Commit Task 2 only**

```bash
git add src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts src/App.vue src/App.web.test.ts
git diff --cached --check
git commit -m "refactor: make workspace navigation folder-only"
```

Verify the staged set excludes `README.md` and `TODO.md`.

---

### Task 3: Move the outline right and add edge-aligned status controls

**Files:**
- Modify: `src/components/TableOfContents.vue`
- Create: `src/components/TableOfContents.test.ts`
- Modify: `src/components/StatusBar.vue`
- Create: `src/components/StatusBar.test.ts`
- Modify: `src/components/WorkspaceSidebar.vue`
- Modify: `src/components/WorkspaceSidebar.test.ts`
- Modify: `src/App.vue:90-245,570-590,1037-1059,2023-2155`
- Modify: `src/App.web.test.ts:525-577` and `App 多文档工作区` layout cases
- Modify: `src/App.markdown-layout.test.ts`
- Modify: `src/style.css:62-285,774-840`
- Modify: `src/experience.css:580-584`

**Interfaces:**
- `TableOfContents`: consumes `items`, `visible`, `compact`; emits only `select(text)`.
- `StatusBar`: additionally consumes `workspaceVisible`, `outlineVisible`, `outlineAvailable`; emits `toggle-workspace` and `toggle-outline`.
- `WorkspaceSidebar`: consumes App-controlled `visible` and `compact`; no longer owns `matchMedia`, local compact-open state or floating edge toggle.
- `App.vue`: owns ephemeral `compactPanel: "workspace" | "outline" | null`, while persisted `sidebarCollapsed` and `showToc` remain the wide-window preferences.

- [ ] **Step 1: Write failing tests for the right outline and status buttons**

Create `src/components/TableOfContents.test.ts`:

```ts
/** @vitest-environment jsdom */

import { createApp, h, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import TableOfContents from "./TableOfContents.vue";

let app: App<Element> | null = null;
afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
});

describe("TableOfContents", () => {
    it("renders a controlled right outline and emits heading selection", () => {
        const selected: string[] = [];
        const host = document.createElement("div");
        document.body.append(host);
        app = createApp({
            render: () => h(TableOfContents, {
                items: [{ level: 1, text: "标题", id: 0 }],
                visible: true,
                compact: true,
                onSelect: (text: string) => selected.push(text),
            }),
        });
        app.mount(host);
        expect(host.querySelector(".toc-sidebar.is-compact")).not.toBeNull();
        expect(host.querySelector('[aria-label="隐藏目录"]')).toBeNull();
        host.querySelector<HTMLButtonElement>('[title="标题"]')?.click();
        expect(selected).toEqual(["标题"]);
    });

    it("does not render when hidden or empty", () => {
        const host = document.createElement("div");
        document.body.append(host);
        app = createApp({ render: () => h(TableOfContents, { items: [], visible: true, compact: false }) });
        app.mount(host);
        expect(host.querySelector(".toc-sidebar")).toBeNull();
    });
});
```

Create `src/components/StatusBar.test.ts` and assert DOM order and event behavior:

```ts
/** @vitest-environment jsdom */

import { createApp, h, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import StatusBar from "./StatusBar.vue";

let app: App<Element> | null = null;
afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
});

it("places workspace and outline controls at opposite status-bar edges", () => {
    const events: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () => h(StatusBar, {
            errorMessage: "",
            statusMessage: "准备就绪",
            path: "C:\\note.mdx",
            dirty: false,
            modeLabel: "所见即所得",
            wordCount: 10,
            workspaceVisible: true,
            outlineVisible: false,
            outlineAvailable: false,
            onToggleWorkspace: () => events.push("workspace"),
            onToggleOutline: () => events.push("outline"),
        }),
    });
    app.mount(host);

    const footer = host.querySelector(".status-bar");
    expect(footer?.firstElementChild?.getAttribute("aria-label")).toBe("隐藏工作区");
    expect(footer?.lastElementChild?.getAttribute("aria-label")).toBe("当前文档没有目录");
    expect(footer?.lastElementChild).toHaveProperty("disabled", true);
    (footer?.firstElementChild as HTMLButtonElement | null)?.click();
    expect(events).toEqual(["workspace"]);
});
```

Run:

```bash
npm test -- src/components/TableOfContents.test.ts src/components/StatusBar.test.ts
```

Expected: FAIL because both final component contracts are absent.

- [ ] **Step 2: Make `TableOfContents` fully controlled by App**

Use this interface:

```ts
const props = defineProps<{
    items: TocItem[];
    visible: boolean;
    compact: boolean;
}>();
const emit = defineEmits<{ select: [text: string] }>();
```

The template root becomes:

```vue
<aside
    v-if="props.visible && props.items.length"
    class="toc-sidebar"
    :class="{ 'is-compact': props.compact }"
    aria-label="本文目录"
>
    <div class="toc-header"><span>目录</span></div>
    <ul class="toc-list">
        <li
            v-for="item in props.items"
            :key="item.text + item.id"
            :style="{ paddingLeft: `${(item.level - 1) * 12 + 4}px` }"
        >
            <button type="button" :title="item.text" @click="emit('select', item.text)">
                {{ item.text }}
            </button>
        </li>
    </ul>
</aside>
```

Delete the internal close button, `visibility` emit and `.toc-show-button`; the bottom status control becomes the sole persistent recovery entry.

- [ ] **Step 3: Add mirror-image controls to `StatusBar`**

Extend props and emits:

```ts
defineProps<{
    errorMessage: string;
    statusMessage: string;
    path: string;
    dirty: boolean;
    modeLabel: string;
    wordCount: number;
    workspaceVisible: boolean;
    outlineVisible: boolean;
    outlineAvailable: boolean;
}>();

const emit = defineEmits<{
    "toggle-workspace": [];
    "toggle-outline": [];
}>();
```

Place the existing `.status-left` and `.status-right` between these exact buttons:

```vue
<button
    type="button"
    class="status-sidebar-toggle workspace-toggle"
    :class="{ active: workspaceVisible }"
    :aria-label="workspaceVisible ? '隐藏工作区' : '显示工作区'"
    :aria-pressed="workspaceVisible"
    @click="emit('toggle-workspace')"
>
    <svg aria-hidden="true" viewBox="0 0 16 16"><rect x="1.5" y="2" width="13" height="12" rx="1" /><path d="M5 2v12" /></svg>
</button>
<div class="status-left">
    <div v-if="errorMessage" class="status-cell status error">{{ errorMessage }}</div>
    <div v-else class="status-cell">{{ statusMessage }}</div>
    <div class="status-cell path" :title="path">{{ path }}</div>
</div>
<div class="status-right">
    <div class="status-cell">{{ dirty ? "未保存" : "已保存" }}</div>
    <div class="status-cell">{{ modeLabel }}</div>
    <div class="status-cell">{{ wordCount }} 字</div>
</div>
<button
    type="button"
    class="status-sidebar-toggle outline-toggle"
    :class="{ active: outlineVisible }"
    :disabled="!outlineAvailable"
    :aria-label="!outlineAvailable ? '当前文档没有目录' : outlineVisible ? '隐藏目录' : '显示目录'"
    :aria-pressed="outlineVisible"
    @click="emit('toggle-outline')"
>
    <svg aria-hidden="true" viewBox="0 0 16 16"><rect x="1.5" y="2" width="13" height="12" rx="1" /><path d="M11 2v12" /></svg>
</button>
```

Use existing theme tokens; do not introduce an icon dependency.

- [ ] **Step 4: Move responsive ownership from `WorkspaceSidebar` into `App.vue`**

Remove `matchMedia`, `compactOpen`, the internal collapse button and `.workspace-sidebar-toggle` from `WorkspaceSidebar.vue`. Replace `collapsed` with controlled props:

```ts
const props = defineProps<{
    documents: OpenDocument[];
    folders: WorkspaceFolder[];
    activeDocumentId: string | null;
    expandedPaths: string[];
    visible: boolean;
    compact: boolean;
    width: number;
}>();
```

Render the aside with:

```vue
<aside
    v-if="visible"
    class="workspace-sidebar"
    :class="{ 'is-compact': compact }"
    :style="{ width: `${clampWidth(props.width)}px` }"
    aria-label="工作区侧栏"
>
```

Remove `update:collapsed`; keep `update:width`. Update `WorkspaceSidebar.test.ts` so compact rendering is controlled by `{ visible: true, compact: true }`, and verify no floating `.workspace-sidebar-toggle` remains.

- [ ] **Step 5: Implement App-owned wide/compact panel state**

In `src/App.vue`, add:

```ts
const compactLayout = ref(false);
const compactPanel = ref<"workspace" | "outline" | null>(null);
let compactMedia: MediaQueryList | null = null;

const outlineAvailable = computed(() => Boolean(activeDocument.value && toc.value.length));
const workspaceVisible = computed(() =>
    compactLayout.value ? compactPanel.value === "workspace" : !sidebarCollapsed.value,
);
const outlineVisible = computed(() =>
    compactLayout.value
        ? compactPanel.value === "outline" && outlineAvailable.value
        : showToc.value && outlineAvailable.value,
);

function syncCompactLayout(event: MediaQueryListEvent | MediaQueryList) {
    compactLayout.value = event.matches;
    compactPanel.value = null;
}

function toggleWorkspacePanel() {
    if (compactLayout.value) {
        compactPanel.value = compactPanel.value === "workspace" ? null : "workspace";
        return;
    }
    updateSidebarCollapsed(!sidebarCollapsed.value);
}

function toggleOutlinePanel() {
    if (!outlineAvailable.value) return;
    if (compactLayout.value) {
        compactPanel.value = compactPanel.value === "outline" ? null : "outline";
        return;
    }
    setTocVisibility(!showToc.value);
}
```

Register and remove `window.matchMedia("(max-width: 980px)")` in the existing mount/unmount lifecycle. Watch `outlineAvailable`; if it becomes false while `compactPanel === "outline"`, set `compactPanel` to `null` without changing `showToc`.

Update the existing `setTocVisibility` status text to `已显示目录` / `已隐藏目录`; this is now a right-side outline, not a generic sidebar.

After a successful folder open:

```ts
await session.openFolder(selected);
if (compactLayout.value) compactPanel.value = "workspace";
else updateSidebarCollapsed(false);
```

After selecting a workspace file or a directory heading in compact mode, close only the ephemeral overlay:

```ts
if (compactLayout.value) compactPanel.value = null;
```

Do not change persisted `showToc` or `sidebarCollapsed` merely because the viewport crosses `980px`.

- [ ] **Step 6: Reorder the App shell and wire final component contracts**

The `main-body` order must be exactly:

```vue
<WorkspaceSidebar
    :documents="documents"
    :folders="folders"
    :active-document-id="activeDocumentId"
    :expanded-paths="expandedPaths"
    :visible="workspaceVisible"
    :compact="compactLayout"
    :width="sidebarWidth"
    @activate="activateDocument"
    @open-path="openWorkspacePath"
    @open-folder="openFolder"
    @close-folder="closeFolder"
    @toggle-expanded="toggleWorkspacePath"
    @update:width="updateSidebarWidth"
/>

<div class="workspace-center">
    <DocumentTabs
        :documents="documents"
        :active-document-id="activeDocumentId"
        @activate="activateDocument"
        @close="closeDocument"
    />
</div>

<TableOfContents
    v-if="activeDocument"
    :items="toc"
    :visible="outlineVisible"
    :compact="compactLayout"
    @select="scrollToHeading"
/>
```

Move the current active-document `section.note-panel` and the following welcome `section.note-panel.welcome` from `src/App.vue:2047-2092` immediately after `DocumentTabs` and before the closing `workspace-center` div. Preserve their child markup and conditions verbatim.

Wire `StatusBar`:

```vue
<StatusBar
    :error-message="errorMessage"
    :status-message="statusMessage"
    :path="displayPath"
    :dirty="dirty"
    :mode-label="modeLabel"
    :word-count="wordCount"
    :workspace-visible="workspaceVisible"
    :outline-visible="outlineVisible"
    :outline-available="outlineAvailable"
    @toggle-workspace="toggleWorkspacePanel"
    @toggle-outline="toggleOutlinePanel"
/>
```

Keep `.mode-switch.compact` in its current menu-bar location.

- [ ] **Step 7: Implement final CSS and remove conflicting old rules**

In `src/style.css`:

```css
.toc-sidebar {
    width: 240px;
    flex: 0 0 240px;
    order: 3;
    border-left: 1px solid var(--color-border);
    border-right: 0;
    background: rgba(255, 255, 255, 0.4);
    overflow-y: auto;
}

.toc-sidebar.is-compact {
    position: absolute;
    z-index: 50;
    top: 0;
    right: 0;
    bottom: 0;
    box-shadow: var(--shadow-lg);
}

.status-bar {
    gap: 10px;
    padding: 4px 8px;
}

.status-left {
    min-width: 0;
    flex: 1;
}

.status-right {
    flex: 0 0 auto;
}

.status-sidebar-toggle {
    width: 26px;
    height: 24px;
    flex: 0 0 26px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
}

.status-sidebar-toggle.active {
    color: var(--color-primary);
    background: var(--color-primary-light);
}

.status-sidebar-toggle svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
}
```

Delete `.workspace-sidebar-toggle` rules. Change the old `@media (max-width: 900px)` status layout to `980px` without wrapping the outer status bar; allow `.status-left` path text to ellipsize instead.

In `src/experience.css`, delete the rule that unconditionally sets `.toc-sidebar, .toc-show-button { display: none; }` at `900px`; App now controls both overlays at `980px`.

In the global print block at the end of `src/App.vue`, remove the obsolete `.toc-show-button` selector and add `.workspace-sidebar` plus `.document-tabs` to the controls hidden with `display: none !important`.

- [ ] **Step 8: Add App-level responsive and layout tests before final GREEN**

Replace the fixed `window.matchMedia` stub in `src/App.web.test.ts` with a controllable helper:

```ts
function installCompactViewport(initial: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
        matches: initial,
        media: "(max-width: 980px)",
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    window.matchMedia = vi.fn(() => media);
    return {
        setCompact(matches: boolean) {
            Object.defineProperty(media, "matches", { configurable: true, value: matches });
            listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
        },
    };
}
```

Add these cases:

```ts
it("opens the workspace after opening a folder and keeps edge controls in the status bar", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.workspaceSession = {
        version: 1,
        documents: [],
        folderPaths: [],
        expandedPaths: [],
        activeDocumentId: null,
        sidebarCollapsed: true,
        sidebarWidth: 260,
    };
    mocks.openDialog.mockResolvedValue("C:\\Root");
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();

    findButton(host, "打开文件夹...")?.click();
    await vi.waitFor(() => expect(host.querySelector(".workspace-sidebar")).not.toBeNull());
    const status = host.querySelector(".status-bar");
    expect(status?.firstElementChild?.getAttribute("aria-label")).toBe("隐藏工作区");
    expect(status?.lastElementChild?.getAttribute("aria-label")).toBe("当前文档没有目录");
});

it("uses mutually exclusive side overlays at 980px and preserves wide preferences", async () => {
    installCompactViewport(true);
    mocks.isTauri.mockReturnValue(true);
    mocks.diskContents.set("c:\\notes\\a.mdx", "# a");
    mocks.workspaceSession = {
        version: 1,
        documents: [
            {
                id: "compact-a",
                path: "C:\\notes\\a.mdx",
                sourceKind: "mdx",
                importSourcePath: null,
                draftKey: "compact-a-draft",
            },
        ],
        folderPaths: ["C:\\Root"],
        expandedPaths: ["C:\\Root"],
        activeDocumentId: "compact-a",
        sidebarCollapsed: false,
        sidebarWidth: 260,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(App);
    app.mount(host);
    cleanup = () => app.unmount();

    await vi.waitFor(() => expect(host.querySelector('[aria-label="显示工作区"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('[aria-label="显示工作区"]')?.click();
    expect(host.querySelector(".workspace-sidebar.is-compact")).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[aria-label="显示目录"]')?.click();
    await nextTick();
    expect(host.querySelector(".workspace-sidebar")).toBeNull();
    expect(host.querySelector(".toc-sidebar.is-compact")).not.toBeNull();
});
```

In `src/App.markdown-layout.test.ts`, add static guards:

```ts
it("orders workspace, tabbed editor and outline without moving the mode switch", () => {
    expect(appSource.indexOf("<WorkspaceSidebar")).toBeLessThan(appSource.indexOf('class="workspace-center"'));
    expect(appSource.indexOf('class="workspace-center"')).toBeLessThan(appSource.indexOf("<TableOfContents"));
    expect(appSource.indexOf('class="mode-switch compact"')).toBeLessThan(appSource.indexOf('class="main-body"'));
    expect(appSource).toContain('@toggle-workspace="toggleWorkspacePanel"');
    expect(appSource).toContain('@toggle-outline="toggleOutlinePanel"');
    const printBlock = appSource.slice(appSource.indexOf("@media print"));
    expect(printBlock).toContain(".workspace-sidebar");
    expect(printBlock).toContain(".document-tabs");
});
```

- [ ] **Step 9: Run focused tests, then full verification from final bytes**

Run in this order:

```bash
npm test -- src/components/DocumentTabs.test.ts src/components/WorkspaceSidebar.test.ts src/components/TableOfContents.test.ts src/components/StatusBar.test.ts src/App.web.test.ts src/App.markdown-layout.test.ts
npm test
npm run lint
npm run format:check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected:

- Focused and full frontend suites pass.
- ESLint and Prettier checks pass for final files.
- Frontend build, Cargo check and Tauri packaging exit 0.
- `src-tauri/target/release/mora.exe`, MSI and NSIS outputs are regenerated.
- No tracked file outside the planned list changes except the already-user-modified `README.md` and `TODO.md`.

- [ ] **Step 10: Review the final diff and commit Task 3**

Review:

```bash
git diff -- src/components/DocumentTabs.vue src/components/WorkspaceSidebar.vue src/components/TableOfContents.vue src/components/StatusBar.vue src/App.vue src/style.css src/experience.css
git diff --check
git status --short
```

Confirm:

- No duplicate independent-document list remains in the workspace.
- No timer, internal editor DOM access, second Markdown state or new dependency was introduced.
- Compact viewport uses overlay state only and does not persist forced hiding.
- Existing mode-switch markup is unchanged.
- `README.md` and `TODO.md` remain unstaged.

Commit:

```bash
git add src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts src/components/TableOfContents.vue src/components/TableOfContents.test.ts src/components/StatusBar.vue src/components/StatusBar.test.ts src/App.vue src/App.web.test.ts src/App.markdown-layout.test.ts src/style.css src/experience.css
git diff --cached --check
git commit -m "feat: complete workspace tabs and outline layout"
```

---

## Final Acceptance Checklist

- [ ] Open a folder at a window wider than `980px`; the left workspace becomes visible.
- [ ] Open two independent files and one untitled document; all appear as ordinary tabs and do not appear in the workspace tree.
- [ ] Reopen the same path; the existing tab activates and no duplicate appears.
- [ ] Edit one tab, switch twice, and confirm canonical content, dirty state, undo, cursor and resources remain isolated.
- [ ] Close a dirty non-active tab and exercise Save, Discard and Cancel through the existing dialog.
- [ ] Activate a document containing H1–H6; the right outline appears when the saved `showToc` preference is enabled.
- [ ] Activate a heading-free document; the right outline disappears and the bottom-right button is disabled without changing `showToc`.
- [ ] Use the bottom-left and bottom-right buttons; each controls only its spatially matching sidebar.
- [ ] Resize to exactly `980px`; sidebars become mutually exclusive overlays and the editor width is not compressed.
- [ ] Resize back above `980px`; the prior wide-window preferences return.
- [ ] Confirm the editor mode buttons remain in their current menu-bar location and behavior.
- [ ] Confirm `README.md` and `TODO.md` are still the only unrelated user changes.
