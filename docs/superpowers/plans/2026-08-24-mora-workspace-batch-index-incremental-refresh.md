# Mora Workspace Batch Index And Incremental Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mora 在打开工作区时批量索引全部可见 Markdown 笔记，并在既有刷新入口只重新读取新增、变化和删除的文件。

**Architecture:** Rust 的一次 `refresh_workspace_folder` command 同时生成目录树和索引刷新结果；`note_index.rs` 用持久化磁盘版本、路径身份和单次锁内读改写实现增量更新。Vue 的 `useDocumentSession` 统一打开、恢复、聚焦和单目录刷新，`App.vue` 只负责触发动作与展示汇总，不新增第二份搜索状态。

**Tech Stack:** Rust 2021、Tauri 2、serde/serde_json、Vue 3 Composition API、TypeScript、Vitest

**Spec:** `docs/superpowers/specs/2026-08-24-mora-workspace-batch-index-incremental-refresh-design.md`

## Global Constraints

- 不增加实时文件监听、事件防抖队列、数据库、索引任务中心或新依赖。
- 保留当前工作区 10,000 条扫描上限、隐藏/系统/符号链接过滤和自然排序。
- `.mdx` 必须通过现有 MDXNote archive 与 manifest 校验；普通 `.md` 必须复用 `import_markdown_file`。
- 单文件失败不得终止批次；保留其上一次有效索引并返回失败统计。
- 扫描截断时不得删除未扫描区域的旧索引。
- 索引只写应用数据目录，不修改用户笔记或 `.mdx` 文件格式。
- `App.vue` 中规范 Markdown 仍是唯一权威正文；不增加第二份编辑或搜索状态。
- 保留用户现有未提交 `TODO.md` 改动，只对目标行做精确修改和精确暂存。

## File Map

- Modify `src-tauri/src/note_index.rs`: 索引磁盘版本、路径去重、批量增量刷新、锁和安全写入。
- Modify `src-tauri/tests/note_index.rs`: 批量新增、跳过、修改、删除、失败、截断和旧格式兼容测试。
- Modify `src-tauri/src/workspace.rs`: 从同一次 `FolderScan` 收集 Markdown 文件路径。
- Modify `src-tauri/tests/workspace.rs`: 验证路径收集不重新扫描且保持树顺序。
- Modify `src-tauri/src/lib.rs`: 加载 `.md/.mdx` 索引项，增加异步 `refresh_workspace_folder` command。
- Modify `src/types/workspace.ts`: command 返回值和索引统计类型。
- Modify `src/composables/useDocumentSession.ts`: 统一文件夹刷新路径并暴露单目录/全部目录刷新。
- Modify `src/composables/useDocumentSession.test.ts`: command 接线、恢复、增量统计和失败隔离测试。
- Modify `src/App.vue`: 聚焦、侧栏、工作区查找刷新和状态栏汇总。
- Modify `src/App.web.test.ts`: 搜索面板刷新顺序、单目录刷新和文案测试。
- Modify `src/components/LibraryPanel.vue`: 更新索引空状态文案。
- Modify `README.md`: 说明工作区自动批量索引与增量刷新。
- Modify `TODO.md`: 将任意文件夹批量索引限制项改为已实现，同时保留用户追加内容。

---

### Task 1: Versioned Batch Index Core

**Files:**
- Modify: `src-tauri/src/note_index.rs`
- Modify: `src-tauri/tests/note_index.rs`

**Interfaces:**
- Produces: `IndexSourceRevision { modified_at_ms: u128, size: u64 }`
- Produces: `WorkspaceIndexFailure { path: String, error: String }`
- Produces: `WorkspaceIndexRefresh { discovered, indexed, unchanged, removed, failed, truncated }`
- Produces: `source_revision(path: &Path) -> Result<IndexSourceRevision, String>`
- Produces: `refresh_workspace_index<F>(index_path: &Path, root: &Path, files: &[PathBuf], truncated: bool, load: F) -> Result<WorkspaceIndexRefresh, String>` where `F: FnMut(&Path) -> Result<NoteIndexEntry, String>`

- [ ] **Step 1: Extend the test fixture without changing behavior**

Update the existing test helper so every explicitly created entry can carry an optional revision:

```rust
fn entry(path: &str, title: &str, content: &str) -> NoteIndexEntry {
    NoteIndexEntry {
        path: path.to_string(),
        title: title.to_string(),
        tags: vec!["工作".to_string()],
        summary: String::new(),
        updated_at: "2026-07-20T10:00:00Z".to_string(),
        content: content.to_string(),
        source_revision: None,
    }
}
```

- [ ] **Step 2: Write failing batch refresh tests**

Add tests with real temporary `.md` paths and a counting loader:

```rust
#[test]
fn batch_refresh_indexes_once_then_skips_unchanged_files() {
    let root = test_dir();
    let index = root.join("notes.json");
    let first = root.join("first.md");
    let second = root.join("second.md");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();

    let mut loads = 0;
    let initial = refresh_workspace_index(
        &index,
        &root,
        &[first.clone(), second.clone()],
        false,
        |path| {
            loads += 1;
            Ok(entry(&path.to_string_lossy(), &path.file_stem().unwrap().to_string_lossy(), "body"))
        },
    ).unwrap();
    assert_eq!((initial.indexed, initial.unchanged, loads), (2, 0, 2));

    let repeated = refresh_workspace_index(&index, &root, &[first, second], false, |_| {
        panic!("unchanged files must not be loaded")
    }).unwrap();
    assert_eq!((repeated.indexed, repeated.unchanged), (0, 2));
}
```

Add separate tests that assert:

- changing one file re-loads only that path;
- adding one path indexes it;
- removing one path removes its old entry when `truncated == false`;
- `truncated == true` keeps an unseen old entry;
- a loader error is returned in `failed` and keeps the old valid entry;
- a legacy JSON entry without `sourceRevision` loads and is upgraded on refresh;
- equivalent Windows path casing does not create duplicate entries under `#[cfg(windows)]`.

- [ ] **Step 3: Run the focused Rust test and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test note_index
```

Expected: compilation fails because `source_revision`, `WorkspaceIndexRefresh` and `refresh_workspace_index` do not exist.

- [ ] **Step 4: Add versioned stored types and a shared index lock**

Add to `note_index.rs`:

```rust
use crate::path_identity;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

static INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexSourceRevision {
    pub modified_at_ms: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexRefresh {
    pub discovered: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub failed: Vec<WorkspaceIndexFailure>,
    pub truncated: bool,
}
```

Add `source_revision: Option<IndexSourceRevision>` to `NoteIndexEntry` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.

Create `lock_index()` using `INDEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())`. Split `read_entries`, `write_entries`, list, search and upsert into lock-owning public functions and private unlocked helpers so empty-query search does not recursively lock.

- [ ] **Step 5: Implement disk revision, identity and one-read/one-write refresh**

Implement:

```rust
pub fn source_revision(path: &Path) -> Result<IndexSourceRevision, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .and_then(|value| value.duration_since(UNIX_EPOCH).map_err(std::io::Error::other))
        .map_err(|error| error.to_string())?;
    Ok(IndexSourceRevision {
        modified_at_ms: modified.as_millis(),
        size: metadata.len(),
    })
}
```

Inside `refresh_workspace_index`:

1. Normalize root and scanned file identities with `path_identity`.
2. Read the index once under `INDEX_LOCK` and map existing entries by identity.
3. Deduplicate the file list by identity.
4. Compare `source_revision`; skip identical entries.
5. Load changed entries, assign normalized path and revision, or append `WorkspaceIndexFailure` while retaining the previous entry.
6. When not truncated, retain only current files for entries whose identity is under the root.
7. Sort once and write only if at least one item was indexed, removed or upgraded.

Use `Path::new(&entry_identity).starts_with(Path::new(&root_identity))` for root containment after Windows identities have already been lowercased.

- [ ] **Step 6: Make index replacement recoverable**

Change `write_entries` to use temporary and backup paths:

```text
write temporary -> sync
existing index -> unique backup
temporary -> index
on promotion failure: backup -> index
on success: remove backup
```

Return an error if promotion fails. Never touch source note files.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test note_index
```

Expected: all `note_index` tests pass.

- [ ] **Step 8: Commit Task 1 precisely**

```powershell
git add -- src-tauri/src/note_index.rs src-tauri/tests/note_index.rs
git commit -m "feat: add incremental workspace index core"
```

---

### Task 2: One-Scan Workspace Refresh Command

**Files:**
- Modify: `src-tauri/src/workspace.rs`
- Modify: `src-tauri/tests/workspace.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `refresh_workspace_index`, `source_revision`, `WorkspaceIndexRefresh` from Task 1.
- Produces: `markdown_file_paths(scan: &FolderScan) -> Vec<PathBuf>`.
- Produces Tauri command: `async fn refresh_workspace_folder(app: AppHandle, path: String) -> Result<WorkspaceRefreshResult, String>`.

- [ ] **Step 1: Write a failing scan-tree path collection test**

Add to `src-tauri/tests/workspace.rs`:

```rust
#[test]
fn collects_only_markdown_files_from_the_existing_scan_tree() {
    let root = test_dir();
    fs::create_dir(root.join("nested")).unwrap();
    write(&root.join("root.mdx"), "not parsed by this test");
    write(&root.join("nested").join("child.md"), "child");

    let scan = scan_folder(&root, 10_000).unwrap();
    let files = mdxnote_lib::workspace::markdown_file_paths(&scan);
    assert_eq!(files.len(), 2);
    assert!(files.iter().any(|path| path.ends_with("root.mdx")));
    assert!(files.iter().any(|path| path.ends_with("child.md")));
    fs::remove_dir_all(root).unwrap();
}
```

- [ ] **Step 2: Run the workspace test and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test workspace collects_only_markdown_files
```

Expected: compilation fails because `markdown_file_paths` is missing.

- [ ] **Step 3: Implement pure path collection**

Add a recursive visitor in `workspace.rs` that consumes only `WorkspaceTreeEntry` values already returned by `scan_folder`; do not call `fs::read_dir` or metadata APIs.

```rust
pub fn markdown_file_paths(scan: &FolderScan) -> Vec<PathBuf> {
    fn collect(entries: &[WorkspaceTreeEntry], files: &mut Vec<PathBuf>) {
        for entry in entries {
            match entry.kind {
                EntryKind::Directory => collect(&entry.children, files),
                EntryKind::Md | EntryKind::Mdx => files.push(PathBuf::from(&entry.path)),
            }
        }
    }
    let mut files = Vec::new();
    collect(&scan.entries, &mut files);
    files
}
```

- [ ] **Step 4: Add failing production-loader unit tests**

Add private unit tests inside the existing `src-tauri/src/lib.rs` `tests` module, which can call `load_index_entry`, `save_to_path` and the existing MDX archive builder without exposing a test-only public API.

For Markdown, write this fixture and assert the mapped fields:

```rust
#[test]
fn index_loader_maps_markdown_front_matter() {
    let dir = temp_test_dir("index-markdown");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    fs::write(
        &path,
        "---\ntitle: 项目计划\ntags: [工作, 计划]\nsummary: 本周目标\n---\n正文内容",
    ).unwrap();

    let entry = load_index_entry(&path).unwrap();
    assert_eq!(entry.title, "项目计划");
    assert_eq!(entry.tags, ["工作", "计划"]);
    assert_eq!(entry.summary, "本周目标");
    assert_eq!(entry.content, "正文内容");
    fs::remove_dir_all(dir).unwrap();
}
```

For MDXNote, call `save_to_path` with a request containing title, tags, summary and content, then assert `load_index_entry` returns those values. Add a third test that writes `b"not-a-zip"` to `.mdx` and asserts `load_index_entry` returns the existing stable invalid-MDX error. Batch continuation and old-entry retention remain covered by Task 1's loader-error test, so these tests do not duplicate the batch algorithm.

- [ ] **Step 5: Implement the command and production loader in `lib.rs`**

Export the Task 1 types/functions and Task 2 path collector. Add:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRefreshResult {
    folder: FolderScan,
    index: WorkspaceIndexRefresh,
}
```

Add `load_index_entry(path: &Path) -> Result<NoteIndexEntry, String>`:

- `.mdx`: call `read_mdx(path)` and map its validated note fields.
- `.md`: call `markdown_import::import_markdown_file(path)` and map Front Matter; use the source file modified time as RFC3339 `updated_at`.
- any other extension: return a stable unsupported-file error.

Replace the old command with:

```rust
#[tauri::command]
async fn refresh_workspace_folder(
    app: AppHandle,
    path: String,
) -> Result<WorkspaceRefreshResult, String> {
    let index_path = note_index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = scan_folder(Path::new(&path), 10_000)?;
        let files = workspace::markdown_file_paths(&folder);
        let index = refresh_workspace_index(
            &index_path,
            Path::new(&folder.path),
            &files,
            folder.truncated,
            load_index_entry,
        )?;
        Ok(WorkspaceRefreshResult { folder, index })
    })
    .await
    .map_err(|error| format!("工作区索引任务失败：{error}"))?
}
```

Register `refresh_workspace_folder` and remove `scan_workspace_folder` from the invoke handler.

Update `index_note` to populate `source_revision` after open/save so subsequent workspace refreshes can skip the file.

- [ ] **Step 6: Run Rust integration tests and verify GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test workspace --test note_index
```

Expected: both integration test binaries pass.

- [ ] **Step 7: Commit Task 2 precisely**

```powershell
git add -- src-tauri/src/workspace.rs src-tauri/tests/workspace.rs src-tauri/src/lib.rs
git commit -m "feat: refresh workspace tree and index together"
```

---

### Task 3: Session-Level Folder Refresh Integration

**Files:**
- Modify: `src/types/workspace.ts`
- Modify: `src/composables/useDocumentSession.ts`
- Modify: `src/composables/useDocumentSession.test.ts`

**Interfaces:**
- Consumes command result: `WorkspaceRefreshResult { folder: FolderScan; index: WorkspaceIndexRefresh }`.
- Produces: `refreshFolder(path: string) -> Promise<WorkspaceIndexRefresh | null>`.
- Produces: `refreshFolders() -> Promise<WorkspaceIndexRefresh[]>`.
- Extends: `WorkspaceFolder` with `index: WorkspaceIndexRefresh`.

- [ ] **Step 1: Add exact TypeScript result types**

Add to `src/types/workspace.ts`:

```ts
export type WorkspaceIndexFailure = {
    path: string;
    error: string;
};

export type WorkspaceIndexRefresh = {
    discovered: number;
    indexed: number;
    unchanged: number;
    removed: number;
    failed: WorkspaceIndexFailure[];
    truncated: boolean;
};

export type WorkspaceRefreshResult = {
    folder: FolderScan;
    index: WorkspaceIndexRefresh;
};
```

Add `index: WorkspaceIndexRefresh` to `WorkspaceFolder`.

- [ ] **Step 2: Update the command mock and write failing session tests**

Change the test invoke mock from `scan_workspace_folder -> FolderScan` to `refresh_workspace_folder -> WorkspaceRefreshResult`.

Add tests asserting:

```ts
it("indexes a folder through one refresh command when opening it", async () => {
    const session = useDocumentSession({ desktop: true });
    const folder = await session.openFolder("C:\\workspace");
    expect(invokeMock).toHaveBeenCalledWith("refresh_workspace_folder", {
        path: "C:\\workspace",
    });
    expect(folder.index.indexed).toBe(2);
});
```

Also assert:

- restore uses `refresh_workspace_folder`;
- `refreshFolder(target)` replaces only the matching root and returns its report;
- `refreshFolders()` returns all successful reports;
- one failed root becomes unavailable while another root still refreshes;
- unavailable placeholders contain a zeroed index report and preserve their prior path/name.

- [ ] **Step 3: Run the focused Vitest file and verify RED**

Run:

```powershell
npx vitest run src/composables/useDocumentSession.test.ts
```

Expected: failures reference the old `scan_workspace_folder` command and missing `index`/`refreshFolder` members.

- [ ] **Step 4: Centralize scan/index result mapping**

In `useDocumentSession.ts`, add:

```ts
const emptyIndexRefresh = (): WorkspaceIndexRefresh => ({
    discovered: 0,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    failed: [],
    truncated: false,
});

async function loadFolder(resolved: PathIdentity) {
    const result = await invoke<WorkspaceRefreshResult>("refresh_workspace_folder", {
        path: resolved.path,
    });
    const folder: WorkspaceFolder = {
        ...result.folder,
        name: baseName(result.folder.path),
        unavailable: false,
        error: null,
        index: result.index,
    };
    folderIdentities.set(folder.path, resolved.identity);
    return folder;
}
```

Use `loadFolder` from `openFolder`, restore and all refresh paths. For unavailable folders, preserve existing fields, clear entries, set `index: emptyIndexRefresh()`, mark unavailable and append the root error once per operation.

- [ ] **Step 5: Implement target and all-folder refresh methods**

`refreshFolder(path)` resolves and refreshes one matching folder, updates `folders.value` immutably and returns its report. `refreshFolders()` loops roots, isolates failures, assigns the final array once and returns reports for successful roots.

Expose both methods from the composable return object.

- [ ] **Step 6: Run the focused Vitest file and verify GREEN**

Run:

```powershell
npx vitest run src/composables/useDocumentSession.test.ts
```

Expected: all document-session tests pass.

- [ ] **Step 7: Commit Task 3 precisely**

```powershell
git add -- src/types/workspace.ts src/composables/useDocumentSession.ts src/composables/useDocumentSession.test.ts
git commit -m "feat: integrate incremental folder refresh"
```

---

### Task 4: User Refresh Entry Points And Feedback

**Files:**
- Modify: `src/App.vue`
- Modify: `src/App.web.test.ts`
- Modify: `src/components/LibraryPanel.vue`

**Interfaces:**
- Consumes: `session.refreshFolder(path)` and `session.refreshFolders()` from Task 3.
- Produces UI helper: `formatIndexRefresh(reports: WorkspaceIndexRefresh[]) -> string`.

- [ ] **Step 1: Write failing App integration tests**

Update the existing Tauri `invoke` mock so `refresh_workspace_folder` returns `{ folder, index }` and records invocation order with `list_notes`/`search_notes`. Add tests asserting:

- clicking the sidebar refresh action calls `session.refreshFolder(root)` but not all-folder refresh;
- clicking “刷新列表” awaits `session.refreshFolders()` before `list_notes`/`search_notes`;
- opening the search panel only loads the existing index and does not force another workspace scan;
- manual refresh status contains updated, removed, unchanged and failed totals;
- focus refresh still calls all-folder refresh before disk-revision handling.

Use deferred promises in the “刷新列表” test so list invocation can be asserted absent until folder refresh resolves.

- [ ] **Step 2: Run focused App tests and verify RED**

Run:

```powershell
npx vitest run src/App.web.test.ts
```

Expected: sidebar refresh has no App listener and library refresh reads the index before refreshing folders.

- [ ] **Step 3: Add report formatting and single-folder action**

Import `WorkspaceIndexRefresh`. Add:

```ts
function formatIndexRefresh(reports: WorkspaceIndexRefresh[]) {
    const totals = reports.reduce(
        (sum, report) => ({
            indexed: sum.indexed + report.indexed,
            removed: sum.removed + report.removed,
            unchanged: sum.unchanged + report.unchanged,
            failed: sum.failed + report.failed.length,
        }),
        { indexed: 0, removed: 0, unchanged: 0, failed: 0 },
    );
    return `索引已刷新：更新 ${totals.indexed}，移除 ${totals.removed}，跳过 ${totals.unchanged}，失败 ${totals.failed}`;
}
```

Add `refreshWorkspaceFolder(path)` using `runAction`, set the returned one-report summary, and bind `@refresh-folder="refreshWorkspaceFolder"` on `WorkspaceSidebar`.

- [ ] **Step 4: Separate index loading from workspace refresh**

Rename the existing list-only behavior to `loadLibrary()`. Implement `refreshLibrary()` as:

```ts
async function refreshLibrary() {
    libraryLoading.value = true;
    try {
        const reports = await session.refreshFolders();
        await loadLibraryEntries();
        statusMessage.value = formatIndexRefresh(reports);
    } finally {
        libraryLoading.value = false;
    }
}
```

`openLibrary()` opens the panel and calls list-only `loadLibrary`; it must not scan. Avoid nested `libraryLoading` toggles by extracting `loadLibraryEntries()` and `runLibrarySearchEntries()` private helpers that assume the loading guard is already owned by the caller.

On window focus, inspect returned reports. Keep normal refresh silent; if failures exist, set a concise partial-failure status without listing source content.

- [ ] **Step 5: Update empty search copy**

In `LibraryPanel.vue`, replace “打开或保存笔记后会自动加入索引” with “打开工作区会自动建立索引，也可以刷新当前工作区。”

- [ ] **Step 6: Run focused App tests and verify GREEN**

Run:

```powershell
npx vitest run src/App.web.test.ts src/components/WorkspaceSidebar.test.ts
```

Expected: both files pass and existing sidebar keyboard/accessibility behavior remains intact.

- [ ] **Step 7: Commit Task 4 precisely**

```powershell
git add -- src/App.vue src/App.web.test.ts src/components/LibraryPanel.vue
git commit -m "feat: expose workspace index refresh actions"
```

---

### Task 5: Documentation And Complete Verification

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes the completed user-visible behavior from Tasks 1-4.
- Produces current product documentation only; no runtime interface.

- [ ] **Step 1: Update current behavior documentation precisely**

In `README.md`, document that opening a workspace recursively indexes visible `.md` and `.mdx` files and that open/restore/focus/manual refresh only reparses changed files.

In `TODO.md`:

- add “工作区批量索引与增量刷新” to implemented search capabilities;
- remove or rewrite the current limitation “全文搜索目前只覆盖在 Mora 中打开或保存过的笔记，尚不会扫描任意磁盘目录”；
- preserve the user's appended “附件管理能力” TODO and do not normalize unrelated whitespace unless the user asks.

- [ ] **Step 2: Run format and static validation**

Run:

```powershell
npm run format:check
npm run lint
```

Expected: Prettier passes; ESLint reports zero errors. Existing warnings may remain only if unchanged from baseline.

- [ ] **Step 3: Run complete frontend and Rust tests**

Run:

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Vitest files and all Rust unit/integration tests pass.

- [ ] **Step 4: Run required project builds**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run build:exe
```

Expected: Vue/TypeScript/Vite build, Rust check and development `mora.exe` build all succeed.

- [ ] **Step 5: Inspect the final diff and protect unrelated work**

Run:

```powershell
git diff --check -- . ':(exclude)TODO.md'
git status --short
git diff -- README.md TODO.md
```

Confirm the only unrelated working-tree content is the user's pre-existing `TODO.md` addition, and that the feature's targeted TODO edits do not remove it.

- [ ] **Step 6: Commit documentation and any final targeted fixes**

```powershell
git add -- README.md TODO.md
git commit -m "docs: document workspace incremental indexing"
```

If verification required code/test fixes, stage those exact files in the same final fix commit; never use `git add -A`.
