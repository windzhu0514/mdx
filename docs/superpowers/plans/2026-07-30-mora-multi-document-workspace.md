# Mora Multi-Document Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Mora 增加单一中央编辑区下的多文档、多文件夹会话，支持 `.md` 导入、逐文档草稿与编辑器状态、会话恢复、外部修改冲突和 50 条最近打开历史。

**Architecture:** Vue 侧用一个具体的 `useDocumentSession` 管理打开文档、资源会话、草稿和关闭状态机，`WorkspaceSidebar` 只负责展示与发出意图；CodeMirror 与 Milkdown 组件用官方 `EditorState` API 按 `documentId` 缓存当前进程内状态。Rust 侧增加路径身份、目录扫描、磁盘版本、会话文件和 Markdown 本地资源准备命令，所有磁盘访问仍经 Tauri command。

**Tech Stack:** Tauri 2、Rust 2021、Vue 3 Composition API、TypeScript、Vite、Vitest、Milkdown/Crepe 7.21.3、ProseMirror、CodeMirror 6。

## Global Constraints

- `.mdx` 始终表示 ZIP 形式的自定义 MDXNote，禁止引入 Web MDX / JSX 语义。
- 编辑区只保留 WYSIWYG、仅源码、源码 + 只读预览三种视图。
- 规范 Markdown 是唯一权威正文；Blob URL 只用于显示，禁止写入源码、草稿、会话或保存请求。
- AI 只接入当前可编辑 WYSIWYG；切换或关闭文档时取消未完成生成。
- 每个规范路径只打开一次；Windows 路径身份比较忽略大小写。
- 最近打开完整历史最多 50 条，文件菜单只展示最近 10 条。
- 单个文件夹最多扫描 10,000 个条目，不跟随目录符号链接，不自动索引正文。
- `.md` 永不原地修改，首次保存必须另存为 `.mdx`。
- 保存继续严格使用现有 `.tmp`、`.bak`、失败恢复和历史版本流程。
- 不新增 Pinia、WorkspaceAdapter、EditorAdapter、工厂、注册中心、实时文件监听或每文档完整编辑器实例。
- 现有目录（TOC）、笔记库、全文搜索、导出、历史版本和 AI 功能必须保留。

---

## File Structure

### Create

- `src-tauri/src/path_identity.rs`：规范化路径和 Windows 不区分大小写的路径身份。
- `src-tauri/src/recent_files.rs`：50 条最近打开持久化、去重、可用性标记。
- `src-tauri/src/workspace.rs`：文件夹树扫描与打开文件磁盘版本查询。
- `src-tauri/src/workspace_session.rs`：版本化 `workspace-session.json` 原子读写。
- `src-tauri/src/markdown_resources.rs`：提取、检查、命名和准备 `.md` 本地资源。
- `src-tauri/tests/path_identity.rs`
- `src-tauri/tests/recent_files.rs`
- `src-tauri/tests/workspace.rs`
- `src-tauri/tests/workspace_session.rs`
- `src-tauri/tests/markdown_resources.rs`
- `src/types/workspace.ts`：前后端工作区数据契约。
- `src/composables/useDocumentSession.ts`：唯一多文档会话实现。
- `src/composables/useDocumentSession.test.ts`
- `src/components/WorkspaceSidebar.vue`
- `src/components/WorkspaceSidebar.test.ts`
- `src/components/RecentFilesDialog.vue`
- `src/components/RecentFilesDialog.test.ts`
- `src/components/ExternalConflictDialog.vue`
- `src/components/MarkdownResourcesDialog.vue`
- `src/components/workspaceDialogs.test.ts`

### Modify

- `src-tauri/src/lib.rs:1-929`：注册新模块、Tauri commands，并删除原内联最近打开实现。
- `src-tauri/src/draft_store.rs:1-95`：增加按 key 读取草稿。
- `src-tauri/src/resource_import.rs:1-100`：公开现有单文件/总资源限制供 Markdown 资源准备复用。
- `src-tauri/Cargo.toml:12-29`：加入 `regex` 定位 Markdown/HTML 资源目的地址，加入 `tempfile` 完成跨平台原子会话替换。
- `src/types/mdx.ts:1-103`：补充最近打开可用性及 Markdown 导入源路径。
- `src/composables/useDraftRecovery.ts:1-89`：允许每文档显式 flush/remove，不再只恢复“最新一份”。
- `src/composables/useResources.ts:1-80`：增加资源会话快照/恢复和幂等释放。
- `src/components/editor/editorTypes.ts:1-32`：增加 `cancelAi`、`releaseDocument`。
- `src/components/editor/SourceEditor.vue:1-161`：按 `documentId` 缓存 CodeMirror `EditorState`、选择与滚动。
- `src/components/editor/MilkdownEditor.vue:1-310`：按 `documentId` 缓存 ProseMirror `EditorState`，使用 `abortAICmd`。
- `src/components/editor/MoraEditor.vue:1-141`：透传 `documentId`，保持两种可编辑内核实例，统一释放状态。
- `src/components/editor/SourceEditor.test.ts`
- `src/components/editor/MilkdownEditor.test.ts`
- `src/components/editor/MoraEditor.test.ts`
- `src/App.vue:1-1917`：接入会话、侧栏、空会话、打开/保存/关闭/恢复/冲突/最近打开流程。
- `src/App.web.test.ts`
- `src/App.editor-integration.test.ts`
- `src/App.resource-loading.test.ts`
- `src/App.markdown-layout.test.ts`
- `src/style.css:1-590`：工作区侧栏、空会话、状态标记与窄窗口布局。
- `src/experience.css`：新对话框的桌面交互细节。
- `README.md`：更新当前功能与操作入口。
- `TODO.md`：移除本次已经完成的多文档和文件夹事项。

---

### Task 1: Path Identity and 50-Item Recent History

**Files:**

- Create: `src-tauri/src/path_identity.rs`
- Create: `src-tauri/src/recent_files.rs`
- Create: `src-tauri/tests/path_identity.rs`
- Create: `src-tauri/tests/recent_files.rs`
- Create: `src/types/workspace.ts`
- Modify: `src-tauri/src/lib.rs:1-29,417-490,824-850`
- Modify: `src/types/mdx.ts:70-78`

**Interfaces:**

- Produces: `normalize_path(path: &Path) -> Result<String, String>`
- Produces: `path_identity(path: &Path) -> Result<String, String>`
- Produces Tauri command: `resolve_path(path: String) -> PathIdentity`
- Produces: `RecentFileEntry { path, title, last_opened_at, available }`
- Produces Tauri commands: `get_recent_files`, `push_recent_file`, `remove_recent_file`, `clear_recent_files`

- [ ] **Step 1: Write failing path identity tests**

```rust
use mdxnote_lib::{normalize_path, path_identity};
use std::path::Path;

#[test]
fn normalizes_dot_segments_to_an_absolute_path() {
    let normalized = normalize_path(Path::new("./notes/../notes/a.mdx")).unwrap();
    assert!(normalized.ends_with("notes\\a.mdx") || normalized.ends_with("notes/a.mdx"));
}

#[test]
#[cfg(windows)]
fn windows_identity_is_case_insensitive() {
    assert_eq!(
        path_identity(Path::new(r"C:\Notes\A.mdx")).unwrap(),
        path_identity(Path::new(r"c:\notes\a.mdx")).unwrap()
    );
}
```

- [ ] **Step 2: Run the path tests and verify the missing exports**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test path_identity`

Expected: FAIL because `normalize_path` and `path_identity` are not exported.

- [ ] **Step 3: Implement lexical normalization with canonicalization for existing paths**

```rust
pub fn normalize_path(path: &Path) -> Result<String, String> {
    let absolute = if path.exists() {
        std::fs::canonicalize(path).map_err(|error| error.to_string())?
    } else {
        std::path::absolute(path).map_err(|error| error.to_string())?
    };
    Ok(absolute.to_string_lossy().to_string())
}

pub fn path_identity(path: &Path) -> Result<String, String> {
    let normalized = normalize_path(path)?;
    #[cfg(windows)]
    return Ok(normalized.to_lowercase());
    #[cfg(not(windows))]
    return Ok(normalized);
}
```

Export both functions from `lib.rs`.

Add the command wrapper and matching frontend contract so every open/save/folder flow deduplicates before reading content:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathIdentity {
    path: String,
    identity: String,
    available: bool,
}

#[tauri::command]
fn resolve_path(path: String) -> Result<PathIdentity, String> {
    let normalized = normalize_path(Path::new(&path))?;
    Ok(PathIdentity {
        identity: path_identity(Path::new(&normalized))?,
        available: Path::new(&normalized).exists(),
        path: normalized,
    })
}
```

```ts
export type PathIdentity = { path: string; identity: string; available: boolean };
```

- [ ] **Step 4: Write failing recent-history tests**

```rust
#[test]
fn deduplicates_by_identity_and_keeps_only_fifty() {
    let mut entries = Vec::new();
    for index in 0..52 {
        entries = push_recent_entry(entries, format!("note-{index}.mdx"), format!("N{index}"), format!("{index:02}"));
    }
    entries = push_recent_entry(entries, "note-20.mdx".into(), "Latest".into(), "99".into()).unwrap();
    assert_eq!(entries.len(), 50);
    assert_eq!(entries[0].title, "Latest");
    assert_eq!(entries.iter().filter(|item| item.title == "Latest").count(), 1);
}
```

- [ ] **Step 5: Run the recent-history test and verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test recent_files`

Expected: FAIL because `recent_files` and `push_recent_entry` do not exist.

- [ ] **Step 6: Move recent persistence into `recent_files.rs`**

```rust
pub const MAX_RECENT_FILES: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileEntry {
    pub path: String,
    pub title: String,
    pub last_opened_at: String,
    #[serde(default)]
    pub available: bool,
}

pub fn push_recent_entry(
    mut entries: Vec<RecentFileEntry>,
    path: String,
    title: String,
    opened_at: String,
) -> Result<Vec<RecentFileEntry>, String> {
    let normalized = normalize_path(Path::new(&path))?;
    let identity = path_identity(Path::new(&normalized))?;
    entries.retain(|entry| path_identity(Path::new(&entry.path)).ok().as_deref() != Some(&identity));
    entries.insert(0, RecentFileEntry {
        available: Path::new(&normalized).is_file(),
        path: normalized,
        title,
        last_opened_at: opened_at,
    });
    entries.truncate(MAX_RECENT_FILES);
    Ok(entries)
}
```

The Tauri command returns all 50 entries. Do not call `ensure_mdx_extension`; recent history must accept both `.md` and `.mdx`.
When reading the JSON file, recompute `available` from current metadata so an older unavailable entry can become available again without being reopened.

- [ ] **Step 7: Update the frontend recent type**

```ts
export type RecentFileEntry = {
    path: string;
    title: string;
    lastOpenedAt: string;
    available: boolean;
};
```

- [ ] **Step 8: Run focused and full Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test path_identity --test recent_files`

Expected: PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS with all existing archive, history, import and index tests.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/path_identity.rs src-tauri/src/recent_files.rs src-tauri/tests/path_identity.rs src-tauri/tests/recent_files.rs src-tauri/src/lib.rs src/types/mdx.ts src/types/workspace.ts
git commit -m "feat: retain fifty recent workspace files"
```

### Task 2: Folder Scan and Disk Revisions

**Files:**

- Create: `src-tauri/src/workspace.rs`
- Create: `src-tauri/tests/workspace.rs`
- Modify: `src-tauri/src/lib.rs:1-29,824-850`
- Modify: `src/types/workspace.ts`

**Interfaces:**

- Consumes: `normalize_path`, `path_identity`
- Produces: `scan_workspace_folder(path: String) -> Result<FolderScan, String>`
- Produces: `get_disk_revisions(paths: Vec<String>) -> Vec<DiskRevisionResult>`
- Produces TS types: `FolderScan`, `WorkspaceTreeEntry`, `DiskRevision`, `DiskRevisionResult`

- [ ] **Step 1: Write failing folder scan tests**

```rust
#[test]
fn scan_filters_hidden_symlink_and_non_markdown_entries() {
    let root = test_dir();
    write(&root.join("b.md"), "b");
    write(&root.join("a.mdx"), "a");
    write(&root.join("ignored.txt"), "x");
    std::fs::create_dir(root.join(".hidden")).unwrap();

    let result = scan_folder(&root, 10_000).unwrap();
    assert_eq!(result.entries.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), ["a.mdx", "b.md"]);
    assert!(!result.truncated);
}

#[test]
fn scan_stops_at_the_entry_limit() {
    let root = test_dir();
    for index in 0..5 { write(&root.join(format!("{index}.md")), "x"); }
    let result = scan_folder(&root, 3).unwrap();
    assert_eq!(result.entry_count, 3);
    assert!(result.truncated);
}
```

- [ ] **Step 2: Run the workspace test and verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace`

Expected: FAIL because `scan_folder` is not exported.

- [ ] **Step 3: Implement metadata-only recursive scanning**

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTreeEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub children: Vec<WorkspaceTreeEntry>,
}

pub fn scan_folder(root: &Path, limit: usize) -> Result<FolderScan, String> {
    let path = normalize_path(root)?;
    let mut remaining = limit;
    let mut truncated = false;
    let entries = scan_directory(Path::new(&path), &mut remaining, &mut truncated)?;
    Ok(FolderScan { path, entries, entry_count: limit - remaining, truncated })
}
```

`scan_directory` must use `symlink_metadata`, skip symlinks, skip names beginning with `.`, and on Windows use `std::os::windows::fs::MetadataExt::file_attributes()` to skip the local `FILE_ATTRIBUTE_HIDDEN = 0x2` and `FILE_ATTRIBUTE_SYSTEM = 0x4` bits. Include directories only when they contain a visible descendant or are needed for traversal, include only `.md`/`.mdx`, sort directories before files with a numeric-aware comparator (`note2.md` before `note10.md`), and never read file contents. Add the Windows-attribute and numeric-order assertions to `src-tauri/tests/workspace.rs`.

- [ ] **Step 4: Add disk revision tests**

```rust
#[test]
fn revision_reports_size_mtime_and_missing_path() {
    let root = test_dir();
    let file = root.join("note.mdx");
    write(&file, "abc");
    let found = disk_revision(&file);
    assert!(found.available);
    assert_eq!(found.revision.unwrap().size, 3);
    assert!(!disk_revision(&root.join("missing.mdx")).available);
}
```

- [ ] **Step 5: Implement disk revision values**

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevision {
    pub path: String,
    pub modified_at_ms: u128,
    pub size: u64,
}
```

Use `metadata.modified()?.duration_since(UNIX_EPOCH)?.as_millis()` and return one result per requested path so a missing drive does not fail the whole batch.

- [ ] **Step 6: Register Tauri commands and add matching TS contracts**

```ts
export type DiskRevision = { path: string; modifiedAtMs: number; size: number };
export type DiskRevisionResult = {
    path: string;
    available: boolean;
    revision: DiskRevision | null;
    error: string | null;
};
export type WorkspaceTreeEntry = {
    path: string;
    name: string;
    kind: "directory" | "md" | "mdx";
    children: WorkspaceTreeEntry[];
};
export type FolderScan = {
    path: string;
    entries: WorkspaceTreeEntry[];
    entryCount: number;
    truncated: boolean;
};
export type WorkspaceFolder = FolderScan & {
    name: string;
    unavailable: boolean;
    error: string | null;
};
```

- [ ] **Step 7: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace`

Expected: PASS, including filtering, sorting, limit and unavailable-path cases.

```bash
git add src-tauri/src/workspace.rs src-tauri/tests/workspace.rs src-tauri/src/lib.rs src/types/workspace.ts
git commit -m "feat: scan workspace folders and disk revisions"
```

### Task 3: Versioned Workspace Session and Per-Document Draft Reads

**Files:**

- Create: `src-tauri/src/workspace_session.rs`
- Create: `src-tauri/tests/workspace_session.rs`
- Modify: `src-tauri/src/draft_store.rs:1-95`
- Modify: `src-tauri/tests/draft_store.rs`
- Modify: `src-tauri/src/lib.rs:1-29,393-415,824-850`
- Modify: `src-tauri/Cargo.toml:12-29`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src/types/workspace.ts`
- Modify: `src/composables/useDraftRecovery.ts:1-89`

**Interfaces:**

- Produces commands: `read_workspace_session`, `write_workspace_session`, `read_draft`
- Produces: `WorkspaceSessionSnapshot` version `1`
- Produces: `read_draft_file(directory, key) -> Result<Option<Value>, String>`

- [ ] **Step 1: Write failing atomic session tests**

```rust
#[test]
fn writes_and_reads_version_one_session() {
    let dir = test_dir();
    let value = json!({"version":1,"documents":[],"folderPaths":[]});
    write_workspace_session_file(&dir.join("workspace-session.json"), &value).unwrap();
    let result = read_workspace_session_file(&dir.join("workspace-session.json")).unwrap();
    assert_eq!(result.session, Some(value));
    assert!(result.warning.is_none());
}

#[test]
fn corrupt_session_falls_back_with_warning() {
    let path = test_dir().join("workspace-session.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{bad").unwrap();
    let result = read_workspace_session_file(&path).unwrap();
    assert!(result.session.is_none());
    assert!(result.warning.unwrap().contains("损坏"));
}
```

- [ ] **Step 2: Run and verify missing functions**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_session`

Expected: FAIL because the session module does not exist.

- [ ] **Step 3: Implement version validation and atomic replacement**

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionRead {
    pub session: Option<Value>,
    pub warning: Option<String>,
}

pub fn write_workspace_session_file(path: &Path, session: &Value) -> Result<(), String> {
    if session.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("工作区会话版本无效。".into());
    }
    atomic_write_json(path, session)
}
```

Use `tempfile::NamedTempFile::new_in(parent)`, write and `sync_all`, then call `persist(path)`. `tempfile` performs a same-directory replace with the platform operation needed for atomic persistence, including replacement on Windows. A corrupt or unsupported file returns `{ session: None, warning: Some(...) }`, not a startup error.

```toml
tempfile = "3"
```

- [ ] **Step 4: Add a per-key draft read test**

```rust
#[test]
fn reads_a_specific_draft_without_selecting_the_latest() {
    let dir = test_dir();
    write_draft_file(&dir, "note-a", &json!({"updatedAt":"2026-01-01T00:00:00Z"})).unwrap();
    write_draft_file(&dir, "note-b", &json!({"updatedAt":"2026-02-01T00:00:00Z"})).unwrap();
    assert_eq!(read_draft_file(&dir, "note-a").unwrap().unwrap()["updatedAt"], "2026-01-01T00:00:00Z");
}
```

- [ ] **Step 5: Implement `read_draft_file` and expose it through Tauri**

```rust
pub fn read_draft_file(directory: &Path, key: &str) -> Result<Option<Value>, String> {
    let path = draft_path(directory, key)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
```

- [ ] **Step 6: Define the exact frontend session schema**

```ts
export type WorkspaceSessionDocument = {
    id: string;
    path: string | null;
    sourceKind: "mdx" | "markdown-import" | "untitled";
    importSourcePath: string | null;
    draftKey: string;
};

export type WorkspaceSessionSnapshot = {
    version: 1;
    documents: WorkspaceSessionDocument[];
    folderPaths: string[];
    expandedPaths: string[];
    activeDocumentId: string | null;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
};

export type WorkspaceSessionRead = {
    session: WorkspaceSessionSnapshot | null;
    warning: string | null;
};
```

- [ ] **Step 7: Update draft recovery to read a supplied key**

```ts
export type DraftStore = {
    write(key: string, draft: DraftSnapshot): Promise<void>;
    read(key: string): Promise<DraftSnapshot | null>;
    remove(key: string): Promise<void>;
};
```

Keep debounce per document, but remove `readLatest` from the new session path. Retain the Rust `read_latest_draft` command only for one-version migration compatibility.

- [ ] **Step 8: Verify and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_session --test draft_store`

Expected: PASS.

Run: `npm test -- src/composables/useDraftRecovery.test.ts`

Expected: PASS after tests use `store.read(key)`.

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/workspace_session.rs src-tauri/tests/workspace_session.rs src-tauri/src/draft_store.rs src-tauri/tests/draft_store.rs src-tauri/src/lib.rs src/types/workspace.ts src/composables/useDraftRecovery.ts src/composables/useDraftRecovery.test.ts
git commit -m "feat: persist multi-document workspace sessions"
```

### Task 4: Markdown Local Resource Preparation

**Files:**

- Create: `src-tauri/src/markdown_resources.rs`
- Create: `src-tauri/tests/markdown_resources.rs`
- Modify: `src-tauri/src/resource_import.rs:1-100`
- Modify: `src-tauri/src/lib.rs:1-29,229-241,824-850`
- Modify: `src-tauri/Cargo.toml:12-29`
- Modify: `src/types/workspace.ts`

**Interfaces:**

- Produces command: `prepare_markdown_resources(source_path, markdown) -> MarkdownResourcePlan`
- Produces: `MarkdownResourcePlan { rewritten_content, resources, items }`

- [ ] **Step 1: Add failing extraction and classification tests**

```rust
#[test]
fn preserves_remote_and_rewrites_local_markdown_and_html_links() {
    let root = fixture();
    write(&root.join("image.png"), b"png");
    write(&root.join("manual.pdf"), b"pdf");
    let markdown = "![图](image.png)\n[手册](manual.pdf)\n![远程](https://x/y.png)\n<img src=\"image.png\">";
    let plan = prepare_markdown_resources(&root.join("note.md"), markdown).unwrap();
    assert!(plan.rewritten_content.contains("assets/image.png"));
    assert!(plan.rewritten_content.contains("attachments/manual.pdf"));
    assert!(plan.rewritten_content.contains("https://x/y.png"));
    assert_eq!(plan.resources.len(), 2);
}
```

- [ ] **Step 2: Add failing dedupe, collision and unresolved tests**

```rust
#[test]
fn deduplicates_sources_and_uses_numeric_collision_suffixes() {
    let root = fixture();
    write(&root.join("a/photo.png"), b"a");
    write(&root.join("b/photo.png"), b"b");
    let plan = prepare_markdown_resources(
        &root.join("note.md"),
        "![a](a/photo.png) ![again](a/photo.png) ![b](b/photo.png) ![missing](none.png)",
    ).unwrap();
    assert_eq!(plan.resources.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["assets/photo.png", "assets/photo-2.png"]);
    assert_eq!(plan.items.iter().filter(|item| item.status == "missing").count(), 1);
    assert!(plan.rewritten_content.contains("none.png"));
}
```

- [ ] **Step 3: Run and verify missing resource planner**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test markdown_resources`

Expected: FAIL because `prepare_markdown_resources` is not exported.

- [ ] **Step 4: Add `regex` and implement exact reference discovery**

```toml
regex = "1"
```

```rust
static MARKDOWN_DESTINATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(!?\[[^\]]*\]\()(?P<url><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?(\))"#).unwrap());
static HTML_DESTINATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\b(?:src|href)=(?P<quote>["'])(?P<url>[^"']+)(?:["'])"#).unwrap());
```

Record byte ranges for each `url`, strip surrounding `<...>` only for resolution, and leave `http`, `https`, `data`, `mailto`, anchors and any other explicit URI scheme unchanged.

- [ ] **Step 5: Reuse existing limits and produce stable resources**

```rust
pub const MAX_IMPORTED_RESOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_IMPORTED_RESOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
```

For each unique normalized source path: require a regular file, enforce individual and cumulative limits, classify `image/*` into `assets/`, classify everything else into `attachments/`, sanitize the original basename, then allocate `name.ext`, `name-2.ext`, and so on. Readable resources become existing `ImportedResource` values; missing, unreadable and oversized items retain the original Markdown destination.

- [ ] **Step 6: Define frontend plan types**

```ts
export type MarkdownResourceItem = {
    originalReference: string;
    resolvedPath: string | null;
    status: "ready" | "missing" | "unreadable" | "oversized";
    targetPath: string | null;
    message: string | null;
};

export type MarkdownResourcePlan = {
    rewrittenContent: string;
    resources: ResourceSaveData[];
    items: MarkdownResourceItem[];
};
```

- [ ] **Step 7: Verify archive safety remains intact**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test markdown_resources --test resource_import --test archive_security --test archive_limits`

Expected: PASS; no generated resource path escapes `assets/` or `attachments/`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/markdown_resources.rs src-tauri/tests/markdown_resources.rs src-tauri/src/resource_import.rs src-tauri/src/lib.rs src/types/workspace.ts
git commit -m "feat: prepare markdown resources for mdx import"
```

### Task 5: Multi-Document Session State

**Files:**

- Create: `src/composables/useDocumentSession.ts`
- Create: `src/composables/useDocumentSession.test.ts`
- Modify: `src/composables/useResources.ts:1-80`
- Modify: `src/types/workspace.ts`

**Interfaces:**

- Consumes: Tauri note, draft, revision and session commands directly through `invoke`; tests mock `@tauri-apps/api/core`.
- Produces: `useDocumentSession(desktop: boolean)`
- Produces methods: `newDocument`, `openMdx`, `openMarkdown`, `activate`, `updateContent`, `save`, `saveAs`, `closeDocument`, `closeFolder`, `restore`, `persist`, `refreshDiskState`, `dispose`

- [ ] **Step 1: Write failing document identity and untitled numbering tests**

```ts
it("deduplicates saved and imported paths but permits multiple untitled documents", async () => {
    const session = useDocumentSession(true);
    const first = await session.openMdx("C:\\Notes\\A.mdx");
    expect(await session.openMdx("c:\\notes\\a.mdx")).toBe(first);
    const imported = await session.openMarkdown("C:\\Notes\\source.md");
    expect(await session.openMarkdown("c:\\notes\\SOURCE.md")).toBe(imported);
    expect(session.newDocument().displayName).toBe("未命名文档 1");
    expect(session.newDocument().displayName).toBe("未命名文档 2");
});
```

- [ ] **Step 2: Write failing dirty isolation and close-state tests**

```ts
it("keeps dirty content isolated and leaves the folder untouched on cancel", async () => {
    const decisions: Array<"discard" | "cancel"> = ["discard", "cancel"];
    const session = useDocumentSession(true);
    const a = await session.openMdx("C:\\Root\\a.mdx");
    const b = await session.openMdx("C:\\Root\\b.mdx");
    session.updateContent(a.id, "changed a");
    session.updateContent(b.id, "changed b");
    expect(
        await session.closeFolder("C:\\Root", {
            decide: async () => decisions.shift() ?? "cancel",
            save: async () => true,
        }),
    ).toBe(false);
    expect(session.documents.value.map((doc) => doc.id)).toEqual([a.id, b.id]);
    expect(session.document(a.id).dirty).toBe(true);
});
```

- [ ] **Step 3: Run and verify the composable is missing**

Run: `npm test -- src/composables/useDocumentSession.test.ts`

Expected: FAIL because `useDocumentSession.ts` does not exist.

- [ ] **Step 4: Define the concrete document runtime**

```ts
export type OpenDocument = {
    id: string;
    path: string | null;
    pathIdentity: string | null;
    sourceKind: "mdx" | "markdown-import" | "untitled";
    importSourcePath: string | null;
    displayName: string;
    content: string;
    meta: MdxMetadata | null;
    dirty: boolean;
    diskRevision: DiskRevision | null;
    conflict: boolean;
    unavailable: boolean;
};

export type SessionDocument = OpenDocument & {
    resources: ResourceSession;
    draft: ReturnType<typeof createDraftRecovery>;
};

export type CloseActions = {
    decide(document: OpenDocument): Promise<"save" | "discard" | "cancel">;
    save(documentId: string): Promise<boolean>;
};
```

Use `shallowRef<SessionDocument[]>([])`; do not put CodeMirror or ProseMirror states in this composable. `openMdx`, `openMarkdown`, `saveAs` and `openFolder` first call `resolve_path`; saved documents use the target identity, Markdown imports use the source identity until first save, and untitled documents use their session ID. The test file mocks `invoke` with in-memory Maps for session and drafts and explicit responses for path, note, folder and revision commands.

- [ ] **Step 5: Implement open, activate and update without save prompts**

```ts
function activate(id: string) {
    if (!documents.value.some((document) => document.id === id)) return false;
    activeDocumentId.value = id;
    scheduleSessionWrite();
    return true;
}

function updateContent(id: string, markdown: string) {
    const document = requireDocument(id);
    const canonical = document.resources.persistedMarkdown(markdown);
    if (canonical === document.content) return;
    document.content = canonical;
    document.dirty = true;
    document.draft.schedule();
    triggerRef(documents);
}
```

- [ ] **Step 6: Implement sequential close semantics**

```ts
async function closeDocument(id: string, actions: CloseActions): Promise<boolean> {
    const document = requireDocument(id);
    if (document.dirty) {
        const decision = await actions.decide(document);
        if (decision === "cancel") return false;
        if (decision === "save" && !(await actions.save(id))) return false;
        if (decision === "discard") await document.draft.remove();
    }
    releaseDocument(document);
    documents.value = documents.value.filter((item) => item.id !== id);
    chooseNextActiveDocument(id);
    await persist();
    return true;
}
```

`closeFolder` first preflights a snapshot of documents under that root in opening order. It records discard decisions without deleting drafts or documents, performs requested saves, and stops immediately on cancel or save failure. Only after every document passes preflight may it delete recorded drafts, release every document, remove them as one state update, and remove the root. A later cancel therefore leaves all documents open; an earlier successful save may remain saved.

- [ ] **Step 7: Add save-target conflict tests**

```ts
it("rejects save-as when another open document owns the target", async () => {
    const session = useDocumentSession(true);
    const existing = await session.openMdx("C:\\Notes\\taken.mdx");
    const untitled = session.newDocument();
    await expect(
        session.saveAs(untitled.id, "c:\\notes\\TAKEN.mdx"),
    ).rejects.toMatchObject({
        code: "TARGET_ALREADY_OPEN",
        documentId: existing.id,
    });
});
```

- [ ] **Step 8: Add resource snapshot/restore without revoking on switch**

```ts
export type ResourceSessionSnapshot = {
    newResources: ResourceSaveData[];
};
```

Add `snapshot()` and `restore(snapshot)` to `useResources`; `clear()` remains the only operation that revokes all Blob URLs. Activation must never call `clear()`.

- [ ] **Step 9: Verify and commit**

Run: `npm test -- src/composables/useDocumentSession.test.ts src/composables/useResources.test.ts`

Expected: PASS for dedupe, untitled numbering, dirty isolation, close decisions, target conflict, restore and disposal.

```bash
git add src/composables/useDocumentSession.ts src/composables/useDocumentSession.test.ts src/composables/useResources.ts src/composables/useResources.test.ts src/types/workspace.ts
git commit -m "feat: manage isolated open document sessions"
```

### Task 6: Official EditorState Switching and AI Cancellation

**Files:**

- Modify: `src/components/editor/editorTypes.ts:1-32`
- Modify: `src/components/editor/SourceEditor.vue:1-161`
- Modify: `src/components/editor/MilkdownEditor.vue:1-310`
- Modify: `src/components/editor/MoraEditor.vue:1-141`
- Modify: `src/components/editor/SourceEditor.test.ts`
- Modify: `src/components/editor/MilkdownEditor.test.ts`
- Modify: `src/components/editor/MoraEditor.test.ts`

**Interfaces:**

- Consumes prop: `documentId: string`
- Produces handle methods: `cancelAi(): void`, `releaseDocument(documentId: string): void`

- [ ] **Step 1: Add failing CodeMirror state-isolation test**

```ts
it("restores document text, selection and scroll with setState", async () => {
    const editor = mountEditor("doc-a", "alpha");
    editor.handle.value?.replaceSelection("A ");
    setScrollTop(editor.host, 120);
    editor.documentId.value = "doc-b";
    editor.markdown.value = "beta";
    await nextTick();
    editor.handle.value?.replaceSelection("B ");
    editor.documentId.value = "doc-a";
    editor.markdown.value = "A alpha";
    await nextTick();
    expect(text(editor.host)).toBe("A alpha");
    expect(scrollTop(editor.host)).toBe(120);
    editor.handle.value?.execute({ name: "undo" });
    expect(editor.updates.at(-1)).toBe("alpha");
});
```

- [ ] **Step 2: Implement CodeMirror state cache with public APIs**

```ts
type SourceState = { state: EditorState; scrollTop: number };
const states = new Map<string, SourceState>();

function switchDocument(nextId: string, markdown: string) {
    if (!editorView) return;
    states.set(activeDocumentId, {
        state: editorView.state,
        scrollTop: editorView.scrollDOM.scrollTop,
    });
    const cached = states.get(nextId);
    editorView.setState(cached?.state ?? createState(markdown));
    editorView.scrollDOM.scrollTop = cached?.scrollTop ?? 0;
    activeDocumentId = nextId;
}
```

`createState` owns the existing `basicSetup`, Markdown, editability compartment and update listener. `releaseDocument` deletes the map entry.

- [ ] **Step 3: Add failing Milkdown updateState and AI-abort tests**

```ts
it("switches ProseMirror states and aborts AI before changing documents", async () => {
    const editor = mountEditor("doc-a", "# A", false, provider);
    await editor.handle.value?.whenReady();
    editor.documentId.value = "doc-b";
    editor.markdown.value = "# B";
    await nextTick();
    expect(mocks.commands.call).toHaveBeenCalledWith("abort-ai", { keep: false });
    expect(mocks.editorView.updateState).toHaveBeenCalled();
});
```

- [ ] **Step 4: Implement Milkdown state creation and switching**

```ts
import { commandsCtx, editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { EditorState } from "@milkdown/kit/prose/state";
import { abortAICmd } from "@milkdown/crepe/feature/ai";

type MilkdownState = { state: EditorState; scrollTop: number };
const states = new Map<string, MilkdownState>();

function cancelAi() {
    if (!crepe || !ready || disposed) return;
    crepe.editor.action((ctx) =>
        ctx.get(commandsCtx).call(abortAICmd.key, { keep: false }),
    );
}

function createState(ctx: Ctx, markdown: string, current: EditorState) {
    return EditorState.create({
        schema: current.schema,
        doc: ctx.get(parserCtx)(markdown),
        plugins: current.plugins,
    });
}
```

On `documentId` change: call `cancelAi`, save the previous `view.state` and `view.scrollDOM.scrollTop`, then call `view.updateState(targetState)` and restore scroll. Same-document `modelValue` updates continue through `replaceAll`; document switches must not call `replaceAll`. After `setState`/`updateState`, reapply the current readonly compartment or Crepe readonly value so a state cached under another mode cannot restore stale editability.

- [ ] **Step 5: Keep both editable kernels mounted without adding per-document instances**

```vue
<MilkdownEditor
    v-show="mode === 'wysiwyg'"
    :document-id="documentId"
    :readonly="readonly || mode !== 'wysiwyg'"
/>
<div v-show="mode === 'source'" class="source-layout" :class="{ split: sourcePreview }">
    <SourceEditor :document-id="documentId" />
    <MilkdownEditor
        v-if="sourcePreview"
        :document-id="`${documentId}:preview`"
        readonly
    />
</div>
```

This retains exactly one WYSIWYG and one CodeMirror instance for the central editor; it does not create one editor instance per document.

- [ ] **Step 6: Extend the public handle**

```ts
export type MoraEditorHandle = {
    // existing methods remain
    cancelAi(): void;
    releaseDocument(documentId: string): void;
};
```

`MoraEditor.releaseDocument(id)` forwards to SourceEditor, editable Milkdown and `${id}:preview`; mode changes call `cancelAi`.

- [ ] **Step 7: Run editor tests**

Run: `npm test -- src/components/editor/SourceEditor.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts`

Expected: PASS for independent undo, selection, scroll, preview, readonly AI and state release.

- [ ] **Step 8: Commit**

```bash
git add src/components/editor/editorTypes.ts src/components/editor/SourceEditor.vue src/components/editor/MilkdownEditor.vue src/components/editor/MoraEditor.vue src/components/editor/SourceEditor.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts
git commit -m "feat: isolate editor state by document"
```

### Task 7: Workspace Sidebar

**Files:**

- Create: `src/components/WorkspaceSidebar.vue`
- Create: `src/components/WorkspaceSidebar.test.ts`
- Modify: `src/style.css:45-115,370-430,545-590`

**Interfaces:**

- Consumes: `documents`, `folders`, `activeDocumentId`, `expandedPaths`, `collapsed`, `width`
- Emits: `activate`, `open-path`, `close-document`, `close-folder`, `refresh-folder`, `toggle-expanded`, `update:collapsed`, `update:width`

- [ ] **Step 1: Write failing rendering and dedupe tests**

```ts
it("shows independent files separately and places folder-owned files only in the tree", () => {
    const sidebar = mountSidebar({
        documents: [
            doc("C:\\Root\\inside.mdx"),
            doc("C:\\Other\\outside.mdx"),
            untitled(),
        ],
        folders: [folder("C:\\Root", ["C:\\Root\\inside.mdx"])],
    });
    expect(sectionText(sidebar, "打开的文件")).toContain("outside.mdx");
    expect(sectionText(sidebar, "打开的文件")).toContain("未命名文档 1");
    expect(sectionText(sidebar, "打开的文件")).not.toContain("inside.mdx");
    expect(sectionText(sidebar, "打开的文件夹")).toContain("inside.mdx");
});
```

- [ ] **Step 2: Write failing keyboard and overlapping-root tests**

```ts
it("uses the longest folder root and supports arrows plus Enter", async () => {
    const sidebar = mountSidebar({
        folders: [folder("C:\\Root"), folder("C:\\Root\\Specific")],
        documents: [doc("C:\\Root\\Specific\\note.mdx")],
    });
    expect(sidebar.text()).toContain("Specific");
    await sidebar.triggerKey("ArrowDown");
    await sidebar.triggerKey("ArrowRight");
    await sidebar.triggerKey("Enter");
    expect(sidebar.emitted("activate")).toEqual([["C:\\Root\\Specific\\note.mdx"]]);
});
```

- [ ] **Step 3: Implement pure display helpers and accessible tree semantics**

```ts
export function owningRoot(path: string, roots: string[]) {
    return (
        roots
            .filter((root) => isPathInside(path, root))
            .sort((left, right) => right.length - left.length)[0] ?? null
    );
}

function isPathInside(path: string, root: string) {
    const normalizedPath = path.replaceAll("/", "\\").toLowerCase();
    const normalizedRoot = root.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    return (
        normalizedPath === normalizedRoot ||
        normalizedPath.startsWith(`${normalizedRoot}\\`)
    );
}
```

Use `role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-current`, visible dirty/conflict/unavailable labels, explicit close buttons with `aria-label`, and roving `tabindex`. Do not bind `Delete`.

- [ ] **Step 4: Implement resize and collapse**

```ts
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const emitWidth = (value: number) =>
    emit("update:width", Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)));
```

Use Pointer Events on the component’s own resize handle and release capture on `pointerup`; do not query or mutate third-party editor DOM.

- [ ] **Step 5: Add layout CSS**

The main body order is `WorkspaceSidebar`, existing `TableOfContents`, then `.note-panel`. Add `.workspace-sidebar`, `.workspace-tree`, `.workspace-status`, `.workspace-resize-handle`, and `.workspace-sidebar-toggle`. At narrow widths collapse the workspace sidebar to its explicit toggle; retain the existing TOC behavior.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- src/components/WorkspaceSidebar.test.ts src/components/panelAccessibility.test.ts`

Expected: PASS for display ownership, ordering, status labels, keyboard actions and resize bounds.

```bash
git add src/components/WorkspaceSidebar.vue src/components/WorkspaceSidebar.test.ts src/style.css
git commit -m "feat: add workspace session sidebar"
```

### Task 8: Recent, Conflict and Markdown Resource Dialogs

**Files:**

- Create: `src/components/RecentFilesDialog.vue`
- Create: `src/components/RecentFilesDialog.test.ts`
- Create: `src/components/ExternalConflictDialog.vue`
- Create: `src/components/MarkdownResourcesDialog.vue`
- Create: `src/components/workspaceDialogs.test.ts`
- Modify: `src/components/LeaveConfirmDialog.vue`
- Modify: `src/experience.css`

**Interfaces:**

- Recent emits: `open-file`, `remove-file`, `clear`, `close`
- Conflict emits: `decide` with `"overwrite" | "reload" | "save-as" | "cancel"`
- Markdown resources emits: `decide` with `"continue" | "cancel"`
- Leave dialog accepts `documentName`

- [ ] **Step 1: Write failing recent search and unavailable-state test**

```ts
it("filters up to fifty entries and keeps unavailable entries actionable", async () => {
    const panel = mountRecent(entries(50, { unavailableIndex: 3 }));
    await panel.setQuery("note-3");
    expect(panel.visibleRows()).toHaveLength(11);
    expect(panel.row(3).text()).toContain("不可用");
    await panel.row(3).remove();
    expect(panel.emitted("remove-file")).toEqual([[panel.row(3).path]]);
});
```

- [ ] **Step 2: Implement `RecentFilesDialog`**

Use a labeled search input, listbox rows, full path, last-opened time, unavailable status, per-row remove, clear-all and close. Opening an unavailable entry remains enabled so the backend can retry and show the real error.

- [ ] **Step 3: Write failing decision-dialog tests**

```ts
it("offers all conflict outcomes and reports the exact decision", async () => {
    const dialog = mountConflict("note.mdx");
    await dialog.click("重新加载磁盘版本");
    expect(dialog.emitted("decide")).toEqual([["reload"]]);
});

it("lists ready and unresolved resources before continuing", () => {
    const dialog = mountResources(planWith("ready", "missing", "oversized"));
    expect(dialog.text()).toContain("可导入");
    expect(dialog.text()).toContain("缺失");
    expect(dialog.text()).toContain("超限");
});
```

- [ ] **Step 4: Implement explicit accessible dialogs**

Each dialog uses `role="dialog"`, `aria-modal="true"`, a unique `aria-labelledby`, clear destructive copy and an explicit cancel button. `ExternalConflictDialog` must not default-focus overwrite. `MarkdownResourcesDialog` explains that unresolved links remain unchanged when continuing.

- [ ] **Step 5: Add document context to close confirmation**

```vue
<h2 id="leave-dialog-title">保存“{{ documentName }}”？</h2>
```

Keep the existing `save | discard | cancel` event contract so `useDocumentSession` can request decisions sequentially.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- src/components/RecentFilesDialog.test.ts src/components/workspaceDialogs.test.ts src/components/panelAccessibility.test.ts`

Expected: PASS.

```bash
git add src/components/RecentFilesDialog.vue src/components/RecentFilesDialog.test.ts src/components/ExternalConflictDialog.vue src/components/MarkdownResourcesDialog.vue src/components/workspaceDialogs.test.ts src/components/LeaveConfirmDialog.vue src/experience.css
git commit -m "feat: add workspace decision dialogs"
```

### Task 9: App Shell Multi-Document and Folder Integration

**Files:**

- Modify: `src/App.vue:1-1917`
- Modify: `src/App.web.test.ts`
- Modify: `src/App.markdown-layout.test.ts`
- Modify: `src/style.css`

**Interfaces:**

- Consumes: `useDocumentSession`, `WorkspaceSidebar`, three dialogs, Tauri commands from Tasks 1-4
- Produces: user-facing New/Open File/Open Folder/Switch/Save/Save As/Close/Refresh flows

- [ ] **Step 1: Update App test stubs and write failing empty-session test**

```ts
it("starts with an empty welcome screen and creates documents only on request", async () => {
    const app = mountApp();
    await app.ready();
    expect(app.text()).toContain("新建文档");
    expect(app.query(".mora-editor-stub")).toBeNull();
    await app.click("新建文档");
    expect(app.text()).toContain("未命名文档 1");
    expect(app.query(".mora-editor-stub")).not.toBeNull();
});
```

- [ ] **Step 2: Write failing multi-open and no-switch-prompt test**

```ts
it("opens multiple files and switches without a save prompt", async () => {
    const app = mountDesktopApp({ openPaths: ["C:\\a.mdx", "C:\\b.mdx"] });
    await app.openFile();
    app.edit("dirty a");
    await app.openFile();
    await app.activate("a.mdx");
    expect(app.editorMarkdown()).toBe("dirty a");
    expect(app.query('[aria-labelledby="leave-dialog-title"]')).toBeNull();
});
```

- [ ] **Step 3: Replace the single-document refs with computed active-document projections**

```ts
const session = useDocumentSession(tauriRuntime);
const activeDocument = computed(() => session.activeDocument.value);
const content = computed({
    get: () => activeDocument.value?.content ?? "",
    set: (markdown) => {
        if (activeDocument.value)
            session.updateContent(activeDocument.value.id, markdown);
    },
});
const currentPath = computed(() => activeDocument.value?.path ?? null);
const dirty = computed(() => activeDocument.value?.dirty ?? false);
```

Remove the singleton `resourceSession` and singleton `draftRecovery`. AI canonicalization, pasted images, save requests and display Markdown use `activeDocument.value.resources`.

- [ ] **Step 4: Wire File menu commands**

The menu commands become:

```ts
[
    { label: "新建", shortcut: "Ctrl+N", action: createNewNote },
    { label: "打开文件...", shortcut: "Ctrl+O", action: openFiles },
    { label: "打开文件夹...", action: openFolder },
    { label: "关闭当前文档", shortcut: "Ctrl+W", action: closeActiveDocument },
    { label: "保存", shortcut: "Ctrl+S", action: saveActiveDocument },
    { label: "另存为...", shortcut: "Ctrl+Shift+S", action: saveActiveDocumentAs },
];
```

`openFiles` uses `multiple: true` and accepts `mdx`, `md`, `markdown`; each returned path is opened independently. Scanning a folder never pushes files to recents or the note index.

- [ ] **Step 5: Render sidebar, existing TOC and empty state**

```vue
<div class="main-body">
    <WorkspaceSidebar
        :documents="session.documents.value"
        :folders="session.folders.value"
        :active-document-id="session.activeDocumentId.value"
        @activate="activateDocument"
        @open-path="openWorkspacePath"
        @close-document="closeDocument"
        @close-folder="closeFolder"
    />
    <TableOfContents v-if="activeDocument" ... />
    <section v-if="activeDocument" class="note-panel">...</section>
    <section v-else class="workspace-welcome">
        <button @click="createNewNote">新建文档</button>
        <button @click="openFiles">打开文件</button>
        <button @click="openFolder">打开文件夹</button>
    </section>
</div>
```

- [ ] **Step 6: Pass document identity to the editor and release closed states**

```vue
<MoraEditor
    v-if="activeDocument"
    :document-id="activeDocument.id"
    :model-value="activeDocument.content"
    :display-value="activeDocument.resources.displayMarkdown(activeDocument.content)"
/>
```

Before activation and successful close, call `editorRef.cancelAi()`. After close, call `editorRef.releaseDocument(closedId)`. Do not revoke the document resource session on switch.

- [ ] **Step 7: Preserve active-document commands**

Find/replace, TOC, history, export, insert resource, word count, window title and status bar must read the active document only. Disable document-specific menu commands when no active document exists.

- [ ] **Step 8: Run App integration tests**

Run: `npm test -- src/App.web.test.ts src/App.markdown-layout.test.ts src/App.editor-integration.test.ts`

Expected: PASS for empty startup, multiple opens, switch without prompt, menu commands, existing three editor modes and TOC retention.

- [ ] **Step 9: Commit**

```bash
git add src/App.vue src/App.web.test.ts src/App.markdown-layout.test.ts src/App.editor-integration.test.ts src/style.css
git commit -m "feat: integrate multi-document workspace shell"
```

### Task 10: Restore, Drafts, Focus Refresh and External Conflicts

**Files:**

- Modify: `src/composables/useDocumentSession.ts`
- Modify: `src/composables/useDocumentSession.test.ts`
- Modify: `src/App.vue`
- Modify: `src/App.web.test.ts`
- Modify: `src/App.editor-integration.test.ts`

**Interfaces:**

- Consumes: `read_workspace_session`, `write_workspace_session`, `read_draft`, `get_disk_revisions`
- Produces: complete startup restore and conflict resolution state machine

- [ ] **Step 1: Write failing partial restore test**

```ts
it("restores available documents, keeps unavailable roots, and restores active dirty draft", async () => {
    mockInvoke.workspace = snapshotWith(["ok.mdx", "missing.mdx"], ["D:\\offline"]);
    mockInvoke.drafts.set("file-ok", draft("unsaved"));
    const session = useDocumentSession(true);
    await session.restore();
    expect(
        session.documents.value.find((doc) => doc.path?.endsWith("ok.mdx"))?.content,
    ).toBe("unsaved");
    expect(
        session.documents.value.find((doc) => doc.path?.endsWith("missing.mdx"))
            ?.unavailable,
    ).toBe(true);
    expect(session.folders.value[0].unavailable).toBe(true);
});
```

- [ ] **Step 2: Implement restore and debounced session writes**

Restore each document independently; an invalid `.mdx`, missing drive or failed folder scan records a warning and continues. Restore drafts by their exact session `draftKey`. Persist only session references and sidebar state; document content and resource data remain in draft files.

- [ ] **Step 3: Write failing clean-reload and dirty-conflict tests**

```ts
it("auto reloads clean documents and marks dirty documents as conflicted", async () => {
    const session = await openedSession(["clean.mdx", "dirty.mdx"]);
    session.updateContent(session.id("dirty.mdx"), "local");
    fakeDisk.changeBoth();
    await session.refreshDiskState();
    expect(session.document("clean.mdx").content).toBe("disk changed");
    expect(session.document("dirty.mdx").content).toBe("local");
    expect(session.document("dirty.mdx").conflict).toBe(true);
});
```

- [ ] **Step 4: Check revisions on focus and before save**

```ts
async function handleWindowFocus() {
    await session.refreshFolders();
    const reloadedIds = await session.refreshDiskState();
    for (const id of reloadedIds) editorRef.value?.releaseDocument(id);
}
```

Register the Tauri window `onFocusChanged` listener and run only when `payload` is `true`. Also compare the target revision immediately before every save, preventing an unnoticed overwrite between focus events.

- [ ] **Step 5: Implement all conflict outcomes**

```ts
type ConflictDecision = "overwrite" | "reload" | "save-as" | "cancel";
```

- `overwrite`: retain the existing conflict flag until `save_mdx` succeeds; existing backend save automatically appends the current disk note to `history/`.
- `reload`: require confirmation, remove the draft, reopen disk content, clear conflict, update revision, and release the editor state so undo starts clean.
- `save-as`: save Mora content to a different unowned path and leave the original disk file untouched.
- `cancel`: leave content, draft and conflict unchanged.

- [ ] **Step 6: Handle window close across all dirty documents**

Preflight dirty documents in opening order through the existing close dialog. Prevent the native close until all return save/discard; cancel or save failure leaves the window and the complete document list open. Defer discard draft deletion until every decision succeeds. Do not remove any document from the visible session merely to test whether closing is allowed.

- [ ] **Step 7: Verify**

Run: `npm test -- src/composables/useDocumentSession.test.ts src/App.web.test.ts src/App.editor-integration.test.ts`

Expected: PASS for partial restore, active restoration, draft mapping, clean reload, inactive conflict marker, three conflict actions and sequential window close.

- [ ] **Step 8: Commit**

```bash
git add src/composables/useDocumentSession.ts src/composables/useDocumentSession.test.ts src/App.vue src/App.web.test.ts src/App.editor-integration.test.ts
git commit -m "feat: restore workspaces and protect external changes"
```

### Task 11: Markdown Import Save-As Conversion and Recent-Files UI

**Files:**

- Modify: `src/App.vue`
- Modify: `src/App.resource-loading.test.ts`
- Modify: `src/App.web.test.ts`
- Modify: `src/components/RecentFilesDialog.vue`
- Modify: `src/types/mdx.ts`

**Interfaces:**

- Consumes: `prepare_markdown_resources`, `MarkdownResourcesDialog`
- Consumes: all 50 recent entries and `RecentFilesDialog`

- [ ] **Step 1: Write failing Markdown import flow test**

```ts
it("opens md as dirty import and saves only to mdx after resource confirmation", async () => {
    const app = mountDesktopApp({ openPath: "C:\\Notes\\source.md" });
    await app.openFile();
    expect(app.activeSourceKind()).toBe("markdown-import");
    await app.save();
    expect(dialogSave).toHaveBeenCalledWith(
        expect.objectContaining({
            defaultPath: "C:\\Notes\\source.mdx",
        }),
    );
    expect(invoke).toHaveBeenCalledWith("prepare_markdown_resources", {
        sourcePath: "C:\\Notes\\source.md",
        markdown: expect.any(String),
    });
    await app.continueResourceImport();
    expect(saveRequest().content).toContain("assets/photo.png");
});
```

- [ ] **Step 2: Implement `.md` open and first-save rules**

`openMarkdown` stores the normalized `importSourcePath`, uses it for dedupe, imports front matter into metadata, marks the document dirty, and pushes the source `.md` to recent history only after the user opens it. `save` always delegates to `saveAs` while `sourceKind === "markdown-import"`.

- [ ] **Step 3: Prepare and confirm resources before save**

If the plan has no local candidates, save immediately. Otherwise show `MarkdownResourcesDialog`. On continue, register returned `ResourceSaveData` into that document’s resource session, replace its canonical content with `rewrittenContent`, then call existing `save_mdx_as`. Missing, unreadable and oversized references stay byte-for-byte unchanged.

- [ ] **Step 4: Finish recent menu and full-history dialog**

```ts
const recentMenuItems = computed(() => recentFiles.value.slice(0, 10));
```

Always append “查看全部……” when at least one history item exists. The dialog receives all 50, performs local search, supports retry-open, remove one and clear all. A failed open marks/retains the entry; it must not automatically delete unavailable history.

- [ ] **Step 5: Verify**

Run: `npm test -- src/App.resource-loading.test.ts src/App.web.test.ts src/components/RecentFilesDialog.test.ts`

Expected: PASS for `.md` dedupe, default `.mdx` path, prompt, rewrite, unresolved preservation, recent 10/50 and unavailable entries.

- [ ] **Step 6: Commit**

```bash
git add src/App.vue src/App.resource-loading.test.ts src/App.web.test.ts src/components/RecentFilesDialog.vue src/types/mdx.ts
git commit -m "feat: convert markdown imports and browse recent files"
```

### Task 12: Full Regression, Desktop Acceptance and Documentation

**Files:**

- Modify: `src/App.editor-integration.test.ts`
- Modify: `src/App.markdown-layout.test.ts`
- Modify: `README.md`
- Modify: `TODO.md`

**Interfaces:**

- Verifies all interfaces from Tasks 1-11.

- [ ] **Step 1: Add final editor regression cases**

```ts
it.each(["wysiwyg", "source", "split"] as const)(
    "keeps canonical markdown after switching documents in %s mode",
    async (mode) => {
        const app = await twoDocumentApp(mode);
        app.edit("A edit");
        await app.activate("b");
        app.edit("B edit");
        await app.activate("a");
        expect(app.canonicalMarkdown()).toBe("A edit");
    },
);
```

Add explicit cases for CodeMirror undo isolation, Milkdown undo isolation, selection restoration, scroll restoration, composition events, AI cancellation on switch, resource Blob URL survival across switch and revocation on close.

- [ ] **Step 2: Run the complete frontend suite**

Run: `npm test`

Expected: PASS with no skipped workspace or editor isolation tests.

- [ ] **Step 3: Run frontend static checks**

Run: `npm run lint`

Expected: PASS with no ESLint errors.

Run: `npm run format:check`

Expected: PASS.

Run: `npm run build`

Expected: PASS; the existing large-chunk warning may remain, but no TypeScript or Vite errors.

- [ ] **Step 4: Run complete Rust validation**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS for all existing and new integration tests.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS; the existing non-fatal Windows incremental-directory warning is acceptable.

- [ ] **Step 5: Run packaged desktop build**

Run: `npm run tauri -- build`

Expected: PASS and produce:

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

- [ ] **Step 6: Perform manual desktop acceptance**

Launch `src-tauri/target/release/mora.exe` and verify this exact sequence:

1. Empty startup shows New/Open File/Open Folder.
2. Open two `.mdx`, one `.md`, two overlapping folders and two untitled documents.
3. Edit each document in WYSIWYG and source modes; switch without prompts; undo stays in the correct document.
4. Close a folder containing two dirty documents; choose Save, then Cancel; confirm the remaining close is aborted.
5. Save the `.md`; inspect resource list; continue with one missing link; open the resulting `.mdx`.
6. Modify one clean and one dirty `.mdx` externally, refocus Mora, verify auto-reload and conflict marker.
7. Restart Mora and verify files, folders, active document, drafts, sidebar width/collapse and unavailable paths restore.
8. Confirm TOC, library search, export, history panel and AI still work for the active document.

- [ ] **Step 7: Update documentation**

In `README.md`, add user-facing “工作区” instructions for multi-open, folder tree, `.md` import, recent 50 and conflicts. In `TODO.md`, mark only the implemented multi-document, folder list and restore items complete; leave realtime watchers, file management and auto-indexing unimplemented.

- [ ] **Step 8: Review scope and commit**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only files from this plan are changed; pre-existing unrelated work must remain separately identifiable.

```bash
git add README.md TODO.md src/App.editor-integration.test.ts src/App.markdown-layout.test.ts
git commit -m "docs: document multi-document workspace"
```

## Final Acceptance Matrix

| Confirmed requirement                                    | Implemented by                   |
| -------------------------------------------------------- | -------------------------------- |
| Open files vs open folders sections                      | Tasks 7, 9                       |
| Multiple files, roots and untitled documents             | Tasks 2, 5, 9                    |
| No duplicates under open roots; longest root wins        | Tasks 5, 7                       |
| Per-document content, resource, dirty, draft state       | Tasks 3, 5, 10                   |
| Per-document CodeMirror/Milkdown undo, selection, scroll | Task 6                           |
| AI only active WYSIWYG and cancelled on switch           | Tasks 6, 9, 12                   |
| Restart restore without undo history                     | Tasks 3, 10                      |
| Sequential file/folder/window close                      | Tasks 5, 8, 10                   |
| Focus/manual folder refresh                              | Tasks 2, 7, 10                   |
| `.md` import and resource conversion                     | Tasks 4, 11                      |
| Clean reload and dirty external conflict                 | Tasks 2, 8, 10                   |
| Recent menu 10 and searchable history 50                 | Tasks 1, 8, 11                   |
| Empty welcome page                                       | Task 9                           |
| Preserve TOC, library, exports, history and AI           | Tasks 9, 12                      |
| No file manager, watcher, Pinia or adapter layer         | Global Constraints and all tasks |
