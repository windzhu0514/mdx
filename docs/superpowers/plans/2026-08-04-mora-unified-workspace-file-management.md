# Mora Unified Workspace File Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除顶部多标签栏，将所有已打开文档的激活、状态查看和关闭操作统一到左侧工作区，同时保留文件夹树的磁盘浏览能力。

**Architecture:** 继续由 `useDocumentSession` 持有唯一的多文档状态；`WorkspaceSidebar.vue` 只把 `documents` 投影成固定的“已打开文件”区，并与现有文件夹树共用一套树形键盘导航。`App.vue` 继续执行保存确认、文档关闭和编辑器资源释放，仅把关闭后的焦点交还工作区公开方法，不新增 store、composable 或第二份文件状态。

**Tech Stack:** Vue 3 Composition API、TypeScript、Vitest + jsdom、Tauri 2、Rust。

## Global Constraints

- 已确认规格：`docs/superpowers/specs/2026-08-04-mora-unified-workspace-file-management-design.md`。
- `.mdx` 内容、保存流程和 Rust command 均不变；本功能只调整前端文件管理入口。
- “已打开文件”固定在工作区顶部，不折叠；文件夹树位于其下方。
- 同一文件允许同时出现在“已打开文件”和文件夹树：前者管理会话，后者浏览磁盘。
- 文档关闭仍复用 `session.closeDocument(id, closeActions)` 的保存 / 放弃 / 取消流程。
- 所有新交互使用 Vue 和浏览器公开 API；不使用定时器、DOM 查询补丁或第二套正文状态。
- 当前工作树已有未提交改动。禁止整文件暂存已脏文件；只有能通过 `git add -p` 明确隔离本任务 hunks 时才创建阶段提交，否则保留工作树并在最终交付中报告，不得覆盖、重置或误提交既有改动。
- 每个任务完成后先运行对应的定向测试；全部任务完成后必须运行项目规定的三条完整构建验证命令。

---

### Task 1: 在工作区顶部展示全部已打开文档

**Files:**
- Modify: `src/components/WorkspaceSidebar.test.ts`
- Modify: `src/components/WorkspaceSidebar.vue`
- Modify: `src/style.css`

- [ ] **Step 1: 把旧的“只显示文件夹文件”测试改成统一文件管理验收测试**

在 `mountSidebar` 中记录新事件：

```ts
onCloseDocument: (value: string) => record("close-document", value),
```

将 `renders only folder roots...` 用例替换为以下覆盖面：

```ts
it("renders every open document before folder roots and keeps folder duplicates", () => {
    const sidebar = mountSidebar({
        documents: [
            documentItem("C:\\Root\\inside.mdx"),
            documentItem("C:\\Other\\outside.mdx"),
            documentItem("C:\\imports\\draft.md", {
                id: "imported-draft",
                path: null,
                pathIdentity: null,
                sourceKind: "markdown-import",
                importSourcePath: "C:\\imports\\draft.md",
                displayName: "draft.md",
            }),
            untitled(),
        ],
        folders: [folder("C:\\Root", [file("C:\\Root\\inside.mdx")])],
        expandedPaths: ["C:\\Root"],
    });

    expect(sidebar.host.textContent).toContain("已打开文件");
    expect(sidebar.host.textContent).toContain("文件夹");
    expect(sidebar.host.textContent).toContain("outside.mdx");
    expect(sidebar.host.textContent).toContain("draft.md");
    expect(sidebar.host.textContent).toContain("未命名文档 1");
    expect(sidebar.host.textContent?.match(/inside\.mdx/gu)).toHaveLength(2);
    const keys = Array.from(
        sidebar.host.querySelectorAll<HTMLElement>("[role=treeitem]"),
        (item) => item.dataset.treeKey,
    );
    expect(keys.slice(0, 4)).toEqual([
        "document:c:\\root\\inside.mdx",
        "document:c:\\other\\outside.mdx",
        "document:imported-draft",
        "document:untitled-1",
    ]);
});
```

再新增空状态测试，确认没有文档时仍显示“没有打开文件”，没有文件夹时仍保留“打开文件夹”按钮。

- [ ] **Step 2: 运行组件测试并确认红灯**

Run:

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: FAIL；当前没有“已打开文件”区，也没有 `document:*` 树项。

- [ ] **Step 3: 在侧栏行模型中加入会话文档行**

在 `WorkspaceSidebar.vue` 中：

```ts
type TreeRow = {
    key: string;
    label: string;
    path: string;
    depth: number;
    kind: "document" | "folder" | "directory" | "file";
    expanded: boolean | null;
    active: boolean;
    statuses: string[];
    documentId: string | null;
    folderPath: string | null;
};
```

为 emit 增加：

```ts
"close-document": [id: string];
```

为每一行提供包含状态的明确无障碍名称：

```ts
function rowAriaLabel(row: TreeRow) {
    return row.statuses.length > 0
        ? `${row.label}，${row.statuses.join("，")}`
        : row.label;
}
```

在 `folderRows` 之前建立文档投影，并让键盘顺序使用统一 rows：

```ts
const documentRows = computed<TreeRow[]>(() =>
    props.documents.map((document) => ({
        key: `document:${document.id.toLowerCase()}`,
        label: document.displayName,
        path: document.path ?? document.importSourcePath ?? document.id,
        depth: 1,
        kind: "document",
        expanded: null,
        active: document.id === props.activeDocumentId,
        statuses: documentStatuses(document),
        documentId: document.id,
        folderPath: null,
    })),
);

const rows = computed(() => [...documentRows.value, ...folderRows.value]);
```

注意：key 只依赖稳定的 `document.id`；导入文档和未命名文档不能依赖空路径。

- [ ] **Step 4: 将模板改为一个可滚动树中的两个固定分区**

保留一个 `.workspace-tree[role=tree]` 和一套 `onTreeKeydown`。用 `workspaceSections` 提供两个 section，每个 section 内只有一个共享的行模板，避免复制文档行和文件夹行 DOM：

```ts
const workspaceSections = computed(() => [
    { id: "open-documents", title: "已打开文件", rows: documentRows.value },
    { id: "workspace-folders", title: "文件夹", rows: folderRows.value },
]);
```

模板结构为：

```vue
<div class="workspace-tree" role="tree" aria-label="工作区文件" @keydown="onTreeKeydown">
    <section
        v-for="section in workspaceSections"
        :key="section.id"
        class="workspace-section"
        :aria-labelledby="`${section.id}-heading`"
    >
        <h2 :id="`${section.id}-heading`">{{ section.title }}</h2>
        <div role="group">
            <p v-if="section.id === 'open-documents' && !section.rows.length"
                class="workspace-empty">没有打开文件</p>
            <div v-if="section.id === 'workspace-folders' && !section.rows.length"
                class="workspace-empty">
                <p>尚未打开文件夹</p>
                <button ref="openFolderButton" type="button" aria-label="打开文件夹"
                    @click="emit('open-folder')">打开文件夹</button>
            </div>
            <template v-for="row in section.rows" :key="row.key">
                <div class="workspace-tree-row" role="none">
                    <div
                        :ref="(element) => setTreeItem(row.key, element)"
                        class="workspace-tree-item"
                        :class="{ active: row.active }"
                        role="treeitem"
                        :data-tree-key="row.key"
                        :aria-label="rowAriaLabel(row)"
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
                        <span v-for="status in row.statuses" :key="status"
                            class="workspace-status">{{ status }}</span>
                    </div>
                    <span v-if="row.kind === 'document'" class="workspace-row-actions">
                        <button type="button" class="workspace-row-action"
                            :aria-label="`关闭 ${row.label}`" title="关闭文档"
                            @click.stop="closeDocument(row.documentId)">×</button>
                    </span>
                    <span v-else-if="row.kind === 'folder'" class="workspace-row-actions">
                        <button type="button" class="workspace-row-action"
                            :aria-label="`刷新 ${row.label}`" title="刷新文件夹"
                            @click="refreshFolder(row.folderPath)">↻</button>
                        <button type="button" class="workspace-row-action"
                            :aria-label="`关闭文件夹 ${row.label}`" title="关闭文件夹"
                            @click="closeFolder(row.folderPath)">×</button>
                    </span>
                </div>
            </template>
        </div>
    </section>
</div>
```

共享行模板设置 `:aria-label="rowAriaLabel(row)"`。文档行显示单独的可聚焦关闭按钮，文件夹根继续显示刷新和关闭按钮。用小函数缩窄 nullable id，不在模板使用非空断言：

```ts
function closeDocument(id: string | null) {
    if (id) emit("close-document", id);
}
```

- [ ] **Step 5: 调整分区样式并运行绿灯测试**

复用现有 `.workspace-section h2`、`.workspace-empty` 和 `.workspace-row-actions`，只补充分区内部行列表所需布局；不得复制 `document-tab-*` 样式。

Run:

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: PASS；已打开文档、空状态、文件夹根、状态标签和缩放测试均通过。

- [ ] **Step 6: 提交本任务**

```bash
git diff -- src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts src/style.css
```

仅当本任务 hunks 可与既有改动清晰隔离时，使用 `git add -p` 暂存、`git diff --cached --check` 校验并提交 `feat: show open documents in workspace`；否则跳过提交并继续 Task 2。

---

### Task 2: 把激活、关闭和焦点恢复统一到工作区

**Files:**
- Modify: `src/components/WorkspaceSidebar.test.ts`
- Modify: `src/components/WorkspaceSidebar.vue`

- [ ] **Step 1: 先写激活、关闭、键盘和公开焦点方法测试**

新增测试覆盖：

```ts
it("activates and closes open documents without changing folder browsing", async () => {
    const sidebar = mountSidebar({
        documents: [documentItem("C:\\notes\\a.mdx"), untitled()],
        folders: [folder("C:\\notes", [file("C:\\notes\\a.mdx")])],
        expandedPaths: ["C:\\notes"],
    });

    treeItem(sidebar, "document:c:\\notes\\a.mdx").click();
    sidebar.host.querySelector<HTMLButtonElement>('[aria-label="关闭 未命名文档 1"]')?.click();
    await nextTick();

    expect(sidebar.emitted("activate")).toEqual([["C:\\notes\\a.mdx"]]);
    expect(sidebar.emitted("close-document")).toEqual([["untitled-1"]]);
});
```

把原 ArrowDown 测试的首个焦点期望改为首个 `document:*` 行，并新增：

- `Delete` 在聚焦的文档行发出 `close-document`，在文件夹/文件行不关闭文档。
- `ArrowDown` 能从最后一个文档行进入第一个文件夹根，`ArrowUp` 能返回。
- 文档关闭按钮的 `tabIndex` 为 0，且 `aria-label` 包含文档名。
- 活动文档在打开区和文件夹树的两个同路径行上都具有 `aria-current="page"`。
- `focusDocument(id)` 聚焦对应 `document:*` 行。
- `focusFirstAvailable()` 在无文档时聚焦首个文件夹根；文档和文件夹都为空时聚焦“打开文件夹”按钮。

为测试公开方法，让 `mountSidebar` 保存 `app.mount(host)` 的组件代理并随返回值暴露。

- [ ] **Step 2: 运行测试确认新增焦点契约红灯**

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: FAIL；当前组件未暴露焦点方法，也未处理文档行 Delete。

- [ ] **Step 3: 用现有 roving tabindex 实现焦点 API**

导入 `nextTick`，添加打开文件夹按钮 ref，并在现有 `treeItems` Map 上实现：

```ts
const openFolderButton = ref<HTMLButtonElement | null>(null);

async function focusDocument(id: string) {
    const key = `document:${id.toLowerCase()}`;
    rovingKey.value = key;
    await nextTick();
    treeItems.get(key)?.focus();
}

async function focusFirstAvailable() {
    const first = rows.value[0];
    if (first) {
        rovingKey.value = first.key;
        await nextTick();
        treeItems.get(first.key)?.focus();
        return;
    }
    await nextTick();
    openFolderButton.value?.focus();
}

defineExpose({ focusDocument, focusFirstAvailable });
```

在 `onTreeKeydown` 中增加仅对 `kind === "document"` 生效的 Delete 分支：

```ts
} else if (event.key === "Delete" && row.kind === "document" && row.documentId) {
    event.preventDefault();
    emit("close-document", row.documentId);
}
```

关闭按钮保持默认 `tabindex="0"`，满足键盘可聚焦和可读标签要求；树项的方向键顺序仍只覆盖 `role="treeitem"`，Delete 作为聚焦文档行的快捷关闭方式。

- [ ] **Step 4: 运行组件测试并确认全绿**

```bash
npm test -- src/components/WorkspaceSidebar.test.ts
```

Expected: PASS；统一树顺序、Delete、关闭 emit 和三个焦点落点全部通过。

- [ ] **Step 5: 提交本任务**

```bash
git diff -- src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts
```

仅当本任务 hunks 可隔离时，使用 `git add -p` 暂存、检查并提交 `feat: manage document focus from workspace`；否则跳过提交，不触碰既有未提交 hunks。

---

### Task 3: 从 App 移除标签栏并接入工作区文档管理

**Files:**
- Modify: `src/App.web.test.ts`
- Modify: `src/App.vue`
- Delete: `src/components/DocumentTabs.vue`
- Delete: `src/components/DocumentTabs.test.ts`
- Modify: `src/style.css`

- [ ] **Step 1: 将 App 集成测试的标签辅助函数迁移为已打开文档行**

删除 `documentTab`，把 `documentRow` 收紧为只查找 `data-tree-key^="document:"` 的工作区行：

```ts
function openDocumentRow(host: HTMLElement, name: string) {
    return Array.from(
        host.querySelectorAll<HTMLElement>('[role="treeitem"][data-tree-key^="document:"]'),
    ).find((item) => item.querySelector(".workspace-name")?.textContent === name);
}

function folderDocumentRow(host: HTMLElement, name: string) {
    return Array.from(
        host.querySelectorAll<HTMLElement>(
            '[role="treeitem"][data-tree-key^="file:"]',
        ),
    ).find((item) => item.querySelector(".workspace-name")?.textContent === name);
}
```

机械迁移所有多文档场景：

- `documentTab(host, name)` 改为 `openDocumentRow(host, name)`。
- `querySelectorAll('[role="tab"]')` 改为已打开文档行选择器。
- “活动标签”用例名称改为“活动文档行”。
- 状态断言改查 `.workspace-status` 和文档行的 `aria-label` / `aria-current`。
- 文件夹浏览用例使用 `folderDocumentRow`，避免同名文档在两个分区时命中错误行。
- 新增断言 `host.querySelector('[role="tablist"]')` 和 `.document-tabs` 均为 `null`。

关闭焦点用例保持原行为，但改为在文档行发送 Delete：

```ts
const activeRow = openDocumentRow(host, "b");
activeRow?.focus();
activeRow?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
await vi.waitFor(() => expect(openDocumentRow(host, "b")).toBeUndefined());
expect(document.activeElement).toBe(openDocumentRow(host, "a"));
```

- [ ] **Step 2: 运行 App 测试并确认红灯**

```bash
npm test -- src/App.web.test.ts
```

Expected: FAIL；App 仍渲染 `DocumentTabs`，工作区尚未接管关闭和焦点恢复。

- [ ] **Step 3: 在 App 中把关闭焦点目标切换到 WorkspaceSidebar**

删除：

```ts
import DocumentTabs from "./components/DocumentTabs.vue";
const documentTabsRef = ref<{ focusDocument: (id: string) => void } | null>(null);
```

增加明确的工作区公开接口类型和 ref：

```ts
type WorkspaceSidebarHandle = {
    focusDocument: (id: string) => Promise<void>;
    focusFirstAvailable: () => Promise<void>;
};

const workspaceSidebarRef = ref<WorkspaceSidebarHandle | null>(null);
```

将 `closeDocument` 的两个标签焦点调用替换为：

```ts
if (savingDocumentIds.has(id)) {
    statusMessage.value = "请先完成当前保存操作";
    await nextTick();
    await workspaceSidebarRef.value?.focusDocument(id);
    return false;
}

editorRef.value?.cancelAi();
const closed = await session.closeDocument(id, closeActions);
if (closed) editorRef.value?.releaseDocument(id);
await nextTick();
const focusId = closed ? activeDocumentId.value : id;
if (focusId) await workspaceSidebarRef.value?.focusDocument(focusId);
else await workspaceSidebarRef.value?.focusFirstAvailable();
return closed;
```

这保证：取消关闭回到原文档；成功关闭回到新的活动文档；最后一个文档关闭后落到文件夹根或“打开文件夹”。

- [ ] **Step 4: 更新模板接线并删除顶部标签组件**

给 `WorkspaceSidebar` 增加：

```vue
ref="workspaceSidebarRef"
@close-document="closeDocument"
```

删除 `.workspace-center` 内完整的 `<DocumentTabs ... />` 块，保留编辑器 section 直接占据中心区顶部。

使用 `apply_patch` 删除 `src/components/DocumentTabs.vue` 和 `src/components/DocumentTabs.test.ts`，不要用文件系统删除命令。

从 `src/style.css` 删除 `.document-tabs` 到 `.document-tab-close` 的全部规则，并删除窄窗口 media query 中只针对 `.document-tabs` 的规则；不得删除 `.workspace-center` 和编辑器布局。

- [ ] **Step 5: 运行前端定向回归测试**

```bash
npm test -- src/components/WorkspaceSidebar.test.ts src/App.web.test.ts src/composables/useDocumentSession.test.ts
```

Expected: PASS；标签栏不存在，所有已打开文档都从工作区切换和关闭，多文档会话与保存确认不变。

- [ ] **Step 6: 提交本任务**

```bash
git diff -- src/App.vue src/App.web.test.ts src/style.css src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts
```

删除文件的暂存项可以用 `git add -u src/components/DocumentTabs.vue src/components/DocumentTabs.test.ts` 隔离；其余已脏文件仅在本任务 hunks 可用 `git add -p` 清晰隔离时暂存。检查 `git diff --cached --check` 后提交 `refactor: unify document management in workspace`；无法隔离则跳过提交。

---

### Task 4: 完整验证与删减检查

**Files:**
- Verify only: `src/`
- Verify only: `src-tauri/`
- Verify only: `docs/superpowers/specs/2026-08-04-mora-unified-workspace-file-management-design.md`

- [ ] **Step 1: 搜索并清除标签栏残留**

```bash
rg -n "DocumentTabs|documentTabsRef|document-tabs|document-tab|role=\"tab\"|role=\"tablist\"" src
```

Expected: no output。若业务中仍有真正需要的 `role="tabpanel"`，保留编辑器面板语义，但不能再引用不存在的 tab 控件；必要时将编辑器 section 的 `role="tabpanel"` 改为普通 `region` 并设置可理解的 `aria-label`。

- [ ] **Step 2: 运行全部前端测试**

```bash
npm test
```

Expected: PASS，0 failed。

- [ ] **Step 3: 运行项目规定的三条完整验证命令**

```bash
npm run build
CARGO_INCREMENTAL=0 cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Windows PowerShell 实际执行第二条时使用：

```powershell
$env:CARGO_INCREMENTAL='0'; cargo check --manifest-path src-tauri/Cargo.toml
```

Expected:

- `npm run build`: Vue 类型检查与 Vite build 成功。
- `cargo check`: Rust 静态检查成功。
- `npm run tauri -- build`: 生成 `src-tauri/target/release/mora.exe`、MSI 和 NSIS 安装包。

若 `mora.exe` 正在运行导致打包文件被占用，关闭应用且不保存测试内容后只重跑失败的打包命令。

- [ ] **Step 4: 对照规格做最终人工验收**

逐项确认：

1. 顶部没有多标签栏，编辑区得到释放的垂直空间。
2. 无论来源是文件夹、独立 `.mdx`、Markdown 导入还是未命名文档，都出现在“已打开文件”。
3. 同一文件在打开区和文件夹树可重复显示，两个位置都能激活同一会话。
4. 打开区关闭按钮走保存 / 放弃 / 取消；文件夹根仍有刷新 / 关闭按钮。
5. 未保存、外部更改、不可用和活动状态在打开区可见。
6. 上下方向键跨两个分区连续移动；Delete 只关闭文档行。
7. 关闭取消、关闭成功、最后一个文档关闭后的焦点均符合规格。
8. 窄窗口仍保持工作区与目录互斥覆盖层行为。

- [ ] **Step 5: 执行最小设计删减检查**

最终实现只允许以下新增结构：

- `documentRows`：满足“全部打开文件固定显示”的必要投影；删除会导致核心验收失败。
- `WorkspaceSidebarHandle` 的两个焦点方法：满足关闭后的无障碍焦点恢复；删除会导致焦点验收失败。
- `close-document` emit：把 UI 意图交给现有 `App.closeDocument`；删除会迫使侧栏复制保存逻辑。

确认未新增 store、composable、服务层、接口工厂、第二份文档列表或新依赖。

- [ ] **Step 6: 检查工作树并提交最终验证修正（仅当 Step 1-5 产生修正时）**

```bash
git status --short
git diff -- src/App.vue src/App.web.test.ts src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts src/style.css
```

若完整验证促成了修正，仅在这些 hunks 可与既有改动清晰隔离时，使用 `git add -p` 暂存并提交 `test: verify unified workspace file management`；否则保留未暂存状态并在交付中列出。

Expected: 本任务相关文件无遗漏；用户原有的 README、TODO、Milkdown 或 session 等非本任务修改仍保持原样。
