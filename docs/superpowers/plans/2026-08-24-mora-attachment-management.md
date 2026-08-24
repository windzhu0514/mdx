# Mora Attachment Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 Mora 文档增加完整、可放弃、可恢复且随 `.mdx` 安全保存提交的附件管理能力。

**Architecture:** 继续以每文档 `ResourceSession` 为唯一前端资源状态，在其中增加待删除路径；附件元数据仍属于 `MdxMetadata`。Rust 重建 ZIP 时从明确的源归档复制保留资源、过滤删除项并写入新增资源；打开与另存复用同一安全附件字节读取函数。

**Tech Stack:** Vue 3 `<script setup>`、TypeScript、Vitest、Tauri 2、Rust、`zip`、`tauri-plugin-opener`

**Spec:** `docs/superpowers/specs/2026-08-24-mora-attachment-management-design.md`

## Global Constraints

- `.mdx` 是 MDXNote ZIP，不得引入 Web MDX 或 JSX 语义。
- `App.vue` 中的规范 Markdown 是唯一正文状态，持久态只允许 `assets/...` 和 `attachments/...`。
- 所有附件变化先进入当前文档 dirty 会话，保存成功后才提交到磁盘。
- 正文仍引用附件时必须阻止删除，不得自动改写正文或留下已知失效链接。
- 普通保存继续使用外部冲突检测和 `.tmp + .bak`；另存为从当前源文档复制资源，不从目标旧文件继承资源。
- 不增加数据库、资源接口层、插件协议或第二套 Markdown 解析器。
- 只新增一个前端组件和一个 Rust 依赖；图片资产管理不在本次范围。
- 每个生产行为先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 保留主工作区未提交的 `TODO.md`，不得加入本分支提交。

---

## File Map

**Create**

- `src/components/AttachmentPanel.vue`：附件列表、引用状态和行级操作界面。
- `src/components/AttachmentPanel.test.ts`：面板行为与无障碍测试。

**Modify**

- `src/utils/resourcePaths.ts`：统一提取 Markdown/HTML 包内资源引用。
- `src/utils/resourcePaths.test.ts`：引用提取边界。
- `src/composables/useResources.ts`：资源查询、重命名、删除与待删除快照。
- `src/composables/useResources.test.ts`：资源生命周期 RED/GREEN。
- `src/composables/useDraftRecovery.ts`：草稿持久化待删除路径。
- `src/composables/useDocumentSession.ts`：保存快照、另存为源路径、并发变化判断。
- `src/composables/useDocumentSession.test.ts`：保存、草稿和另存为契约。
- `src/types/mdx.ts`：附件面板项、附件读取请求和保存请求类型。
- `src/App.vue`：菜单、面板、附件导入、插入、打开、另存、重命名和删除接线。
- `src/App.editor-integration.test.ts`：当前文档附件操作及异步隔离。
- `src/App.web.test.ts`：菜单入口和面板打开。
- `src/experience.css`：附件面板桌面样式。
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：Rust opener 依赖。
- `src-tauri/src/lib.rs`：保存协议、源归档复制、删除过滤、附件读取/打开/导出命令和测试。

---

### Task 1: One resource-reference extractor

**Files:**
- Modify: `src/utils/resourcePaths.ts`
- Test: `src/utils/resourcePaths.test.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Produces: `referencedResourcePaths(markdown: string): Set<string>`
- Consumes: no new interfaces

- [ ] **Step 1: Write failing extractor tests**

Add literal expectations that catch a missing Markdown branch, missing HTML branch, accidental external URL inclusion and duplicate output:

```ts
import {
    referencedResourcePaths,
    toDisplayMarkdown,
    toPersistedMarkdown,
} from "./resourcePaths";

it("extracts unique package resources from Markdown and HTML", () => {
    expect(
        referencedResourcePaths(
            "[附件](attachments/a.pdf) ![图](assets/a.png) " +
                '<a href="attachments/a.pdf">重复</a><img src="assets/b.png">',
        ),
    ).toEqual(
        new Set([
            "attachments/a.pdf",
            "assets/a.png",
            "assets/b.png",
        ]),
    );
});

it("ignores external and blob destinations", () => {
    expect(
        referencedResourcePaths(
            "[站点](https://example.com/a.pdf) ![临时](blob:mora) " +
                '<a href="file:///C:/a.pdf">本地</a>',
        ),
    ).toEqual(new Set());
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- src/utils/resourcePaths.test.ts
```

Expected: FAIL because `referencedResourcePaths` is not exported.

- [ ] **Step 3: Implement the shared matcher**

Refactor the existing Markdown destination and HTML attribute regexes into iterators used by both replacement and extraction. Export:

```ts
export function referencedResourcePaths(markdown: string) {
    const paths = new Set<string>();
    for (const destination of resourceDestinations(markdown)) {
        if (/^(?:assets|attachments)\/[^/\\]+$/u.test(destination)) {
            paths.add(destination);
        }
    }
    return paths;
}
```

Keep current `toDisplayMarkdown` and `toPersistedMarkdown` results byte-for-byte compatible.

- [ ] **Step 4: Replace App hydration regex and verify GREEN**

Use `referencedResourcePaths(runtime.content)` inside `hydrateDocumentResources` and remove its private duplicate regex. Run:

```powershell
npm test -- src/utils/resourcePaths.test.ts src/App.resource-loading.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit the extractor**

```powershell
git add src/utils/resourcePaths.ts src/utils/resourcePaths.test.ts src/App.vue
git commit -m "refactor: unify resource reference discovery"
```

---

### Task 2: Transactional resource-session mutations

**Files:**
- Modify: `src/composables/useResources.ts`
- Test: `src/composables/useResources.test.ts`

**Interfaces:**
- Consumes: `ResourceSaveData`
- Produces:
  - `resource(path: string): ResourceSaveData | null`
  - `rename(path: string, originalName: string): void`
  - `remove(path: string): void`
  - `removedResources(): string[]`
  - `ResourceSessionSnapshot.removedResources: string[]`

- [ ] **Step 1: Write failing resource lifecycle tests**

Add tests whose mutations would catch returning internal objects, forgetting URL cleanup, or incorrectly deleting a new resource from the source archive:

```ts
it("renames a copied resource view without exposing internal state", () => {
    const session = createResourceSession();
    session.registerNew(newImage);
    session.rename("assets/a.png", "新名称.png");

    const resource = session.resource("assets/a.png");
    expect(resource?.originalName).toBe("新名称.png");
    if (resource) resource.originalName = "外部修改.png";
    expect(session.resource("assets/a.png")?.originalName).toBe("新名称.png");
});

it("removes a new resource without scheduling an archive deletion", () => {
    const session = createResourceSession();
    session.registerNew(newImage);
    session.remove("assets/a.png");

    expect(session.newResources()).toEqual([]);
    expect(session.removedResources()).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
});

it("schedules an existing or unloaded resource for deletion", () => {
    const session = createResourceSession();
    session.registerLoaded({ ...newImage, isNew: false });
    session.remove("assets/a.png");
    session.remove("attachments/unloaded.pdf");

    expect(session.removedResources()).toEqual([
        "assets/a.png",
        "attachments/unloaded.pdf",
    ]);
});

it("round trips removed resources through a draft snapshot", () => {
    const source = createResourceSession();
    source.remove("attachments/a.pdf");
    const restored = createResourceSession();
    restored.restore(source.snapshot());

    expect(restored.removedResources()).toEqual(["attachments/a.pdf"]);
    restored.markSaved();
    expect(restored.removedResources()).toEqual([]);
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- src/composables/useResources.test.ts
```

Expected: FAIL because query, rename, remove and removed snapshot APIs do not exist.

- [ ] **Step 3: Implement minimal state transitions**

Add `const removed = new Set<string>()`. `register` removes the path from `removed`; `rename` replaces only the stored `PendingResource`; `remove` revokes and removes a mapped resource, adding the path to `removed` only when the resource was persisted or absent. Sort the returned deletion array for stable save comparisons.

Extend snapshots and restore:

```ts
export type ResourceSessionSnapshot = {
    newResources: ResourceSaveData[];
    removedResources: string[];
};

function snapshot(): ResourceSessionSnapshot {
    return {
        newResources: newResources(),
        removedResources: removedResources(),
    };
}

function restore(state: ResourceSessionSnapshot) {
    for (const path of state.removedResources ?? []) removed.add(path);
    // Existing new-resource restoration follows unchanged.
}
```

`markSaved` clears `removed`; `clear` clears it after revoking object URLs.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm test -- src/composables/useResources.test.ts
```

Expected: all resource-session tests PASS.

- [ ] **Step 5: Commit resource session**

```powershell
git add src/composables/useResources.ts src/composables/useResources.test.ts
git commit -m "feat: track attachment resource mutations"
```

---

### Task 3: Draft and save-request consistency

**Files:**
- Modify: `src/types/mdx.ts`
- Modify: `src/composables/useDraftRecovery.ts`
- Modify: `src/composables/useDocumentSession.ts`
- Test: `src/composables/useDraftRecovery.test.ts`
- Test: `src/composables/useDocumentSession.test.ts`

**Interfaces:**
- Consumes: `ResourceSession.removedResources()` and extended snapshot
- Produces:
  - `DraftSnapshot.removedResources?: string[]`
  - `MdxSaveRequest.removedResources: string[]`
  - save IPC payload `newAssets`, `removedResources`, and source `path`

- [ ] **Step 1: Write failing save and restore tests**

Add a document-session test that removes an unloaded attachment, saves, and inspects the real IPC request:

```ts
runtime.resources.remove("attachments/old.pdf");
await session.save(runtime.id);

expect(invoke).toHaveBeenCalledWith("save_mdx", {
    request: expect.objectContaining({
        path: "C:\\Notes\\a.mdx",
        removedResources: ["attachments/old.pdf"],
    }),
});
```

Add an `saveAs` assertion that an existing document sends its original path inside `request.path` while the command `path` argument remains the selected target:

```ts
expect(invoke).toHaveBeenCalledWith("save_mdx_as", {
    request: expect.objectContaining({ path: "C:\\Notes\\source.mdx" }),
    path: "C:\\Notes\\copy.mdx",
});
```

Add a restored draft fixture with `removedResources: ["attachments/old.pdf"]` and assert the runtime resource session exposes that deletion. Add a legacy fixture without the field and assert restoration returns an empty deletion list.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- src/composables/useDraftRecovery.test.ts src/composables/useDocumentSession.test.ts
```

Expected: FAIL because drafts and IPC omit removed paths and Save As sends the target as request source.

- [ ] **Step 3: Extend draft snapshots and save comparisons**

Change `DraftSnapshot` to make `removedResources` optional for backward compatibility. Every new snapshot writes it. Restore with `draft.removedResources ?? []`.

Capture before both save commands:

```ts
const requestedRemovedResources = runtime.resources.removedResources();
```

Send `removedResources: requestedRemovedResources` and include a literal array comparison in `changedWhileSaving`. Keep the rule that `markSaved()` runs only when content, metadata, new resources and removed resources are all unchanged.

For Save As, send `path: runtime.path`; unsaved or Markdown-import documents therefore send `null` and cannot be mistaken for an MDX source archive.

- [ ] **Step 4: Verify GREEN and surrounding document tests**

Run:

```powershell
npm test -- src/composables/useDraftRecovery.test.ts src/composables/useDocumentSession.test.ts
```

Expected: all tests PASS, including legacy draft restoration.

- [ ] **Step 5: Commit save protocol frontend**

```powershell
git add src/types/mdx.ts src/composables/useDraftRecovery.ts src/composables/useDraftRecovery.test.ts src/composables/useDocumentSession.ts src/composables/useDocumentSession.test.ts
git commit -m "feat: persist pending attachment deletions"
```

---

### Task 4: Source-aware ZIP rebuild and physical deletion

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `MdxSaveRequest.path`, `new_assets`, `removed_resources`
- Produces: `build_mdx_archive(source_path, meta, content, new_assets, removed_resources)`

- [ ] **Step 1: Write failing Rust archive tests**

Add these concrete fixture helpers inside the existing `lib.rs` test module so tests exercise the real save and ZIP readers:

```rust
fn write_note_with_resources(path: &Path, resources: &[(&str, &[u8])]) {
    use base64::{engine::general_purpose, Engine as _};
    let new_assets = resources
        .iter()
        .map(|(name, bytes)| ResourceData {
            name: (*name).to_string(),
            original_name: name.rsplit('/').next().unwrap().to_string(),
            mime_type: "application/octet-stream".to_string(),
            size: bytes.len() as u64,
            kind: if name.starts_with("assets/") {
                ResourceKind::Asset
            } else {
                ResourceKind::Attachment
            },
            base64: general_purpose::STANDARD.encode(bytes),
        })
        .collect();
    save_to_path(
        MdxSaveRequest {
            path: None,
            title: "Fixture".to_string(),
            content: String::new(),
            meta: Some(MdxMetadata::default()),
            new_assets,
            removed_resources: Vec::new(),
        },
        path.to_path_buf(),
    )
    .unwrap();
}

fn save_request_for(source: &Path, removed_resources: Vec<String>) -> MdxSaveRequest {
    let note = read_mdx(source).unwrap();
    MdxSaveRequest {
        path: Some(source.to_string_lossy().into_owned()),
        title: note.title,
        content: note.content,
        meta: Some(note.meta),
        new_assets: Vec::new(),
        removed_resources,
    }
}

fn read_zip_bytes(path: &Path, name: &str) -> Result<Vec<u8>, String> {
    let mut archive = ZipArchive::new(File::open(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let mut entry = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes)
}
```

Then add tests that inspect real ZIP entries:

```rust
#[test]
fn saved_attachment_deletion_removes_metadata_and_zip_bytes() {
    let dir = temp_test_dir("attachment-delete");
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.mdx");
    write_note_with_resources(&source, &[("attachments/keep.txt", b"keep"), ("attachments/delete.txt", b"delete")]);

    let request = save_request_for(&source, vec!["attachments/delete.txt".to_string()]);
    let saved = save_to_path(request, source.clone()).unwrap();

    assert_eq!(saved.meta.attachments.iter().map(|item| item.path.as_str()).collect::<Vec<_>>(), vec!["attachments/keep.txt"]);
    assert_eq!(read_zip_bytes(&source, "attachments/keep.txt").unwrap(), b"keep");
    assert!(read_zip_bytes(&source, "attachments/delete.txt").is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn save_as_copies_source_resources_and_ignores_target_resources() {
    let dir = temp_test_dir("attachment-save-as");
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.mdx");
    let target = dir.join("target.mdx");
    write_note_with_resources(&source, &[("attachments/source.txt", b"source")]);
    write_note_with_resources(&target, &[("attachments/target.txt", b"target")]);

    save_to_path(save_request_for(&source, Vec::new()), target.clone()).unwrap();

    assert_eq!(read_zip_bytes(&target, "attachments/source.txt").unwrap(), b"source");
    assert!(read_zip_bytes(&target, "attachments/target.txt").is_err());
    fs::remove_dir_all(dir).unwrap();
}
```

Also add one test for an invalid removal path and one for a new resource replacing a preserved name without duplicate ZIP entries.

- [ ] **Step 2: Verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml attachment_ --lib
```

Expected: deletion test FAIL because preserved ZIP bytes remain; Save As test FAIL because target is currently used as the preservation source.

- [ ] **Step 3: Extend Rust request and validate deletions**

Add:

```rust
#[serde(default)]
removed_resources: Vec<String>,
```

Normalize with a `BTreeSet<String>` after calling `validate_new_resource_name` for every path. Remove matching entries from both `meta.assets` and `meta.attachments` before applying new resource metadata.

- [ ] **Step 4: Separate source and target semantics**

In `save_to_path`, derive `source_path` from `request.path` before consuming the request. Pass it to `build_mdx_archive`; continue passing `target_path` only to `safe_write_file`.

Change collection to accept excluded names and replacement names. A preserved entry is copied only when it is absent from both sets. Create the history snapshot from the source note, not from an unrelated existing target.

If an explicit source archive is missing or invalid, fail before writing the target instead of silently dropping preserved resources. When the existing safe-save `.bak` companion is valid, use it as the recovery source.

Update `apply_resource_metadata` so an existing same-path entry keeps `id` and `created_at` while its name, MIME, size and stored name are refreshed.

- [ ] **Step 5: Verify GREEN and archive security**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml attachment_ --lib
cargo test --manifest-path src-tauri/Cargo.toml --test archive_security
cargo test --manifest-path src-tauri/Cargo.toml --test history
```

Expected: all selected Rust tests PASS.

- [ ] **Step 6: Commit ZIP transaction behavior**

```powershell
git add src-tauri/src/lib.rs
git commit -m "feat: delete attachments during safe save"
```

---

### Task 5: Safe attachment bytes, open and export

**Files:**
- Modify: `src/types/mdx.ts`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces frontend type:

```ts
export type AttachmentReadRequest = {
    documentId: string;
    sourcePath: string | null;
    resourcePath: string;
    originalName: string;
    base64: string | null;
};
```

- Produces Tauri commands:
  - `open_attachment(app: AppHandle, request: AttachmentReadRequest) -> Result<(), String>`
  - `export_attachment(request: AttachmentReadRequest, destination_path: String) -> Result<(), String>`

- [ ] **Step 1: Write failing byte-source and cache tests**

Define this local request helper in the `lib.rs` test module:

```rust
fn attachment_request(
    source_path: Option<PathBuf>,
    base64: Option<&str>,
    resource_path: &str,
    original_name: &str,
) -> AttachmentReadRequest {
    AttachmentReadRequest {
        document_id: "note-fixture".to_string(),
        source_path: source_path.map(|path| path.to_string_lossy().into_owned()),
        resource_path: resource_path.to_string(),
        original_name: original_name.to_string(),
        base64: base64.map(str::to_string),
    }
}
```

Add Rust tests for saved and unsaved sources using literal bytes:

```rust
#[test]
fn attachment_bytes_are_read_from_archive_or_base64() {
    let archived = attachment_request(Some(source_path), None, "attachments/a.txt", "a.txt");
    let pending = attachment_request(None, Some("cGVuZGluZw=="), "attachments/b.txt", "b.txt");
    assert_eq!(read_attachment_bytes(&archived).unwrap(), b"archived");
    assert_eq!(read_attachment_bytes(&pending).unwrap(), b"pending");
}
```

Add tests rejecting `../escape.txt`, `assets/image.png`, missing sources and invalid Base64. Add a cache test with original name `..\\CON?.txt` and assert the resolved file stays below the supplied cache root and contains the exact bytes. Add an export test replacing an existing target through the existing safe writer.

- [ ] **Step 2: Verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml attachment_bytes --lib
cargo test --manifest-path src-tauri/Cargo.toml attachment_preview --lib
```

Expected: FAIL because request and helper functions do not exist.

- [ ] **Step 3: Add only the Rust opener dependency**

Add to `src-tauri/Cargo.toml`:

```toml
tauri-plugin-opener = "2"
```

Do not add JavaScript bindings or opener capabilities; the custom Rust command receives validated logical attachment data and calls `tauri_plugin_opener::open_path` itself.

- [ ] **Step 4: Implement one byte reader and two commands**

Deserialize camelCase request fields. Require `resource_path` to start with `attachments/` after the existing safe resource-path validator succeeds. When Base64 is present, decode and enforce `MAX_IMPORTED_RESOURCE_BYTES`; otherwise require `source_path` and read the exact ZIP entry after archive validation.

For preview, create:

```text
<app-cache>/attachment-preview/<document-key>/<stored-name>/<safe-original-name>
```

Before writing, remove and recreate only `<stored-name>`'s directory. Write bytes with `document_export::safe_write_bytes`, then call:

```rust
tauri_plugin_opener::open_path(&preview_path, None::<&str>)
```

For export, validate a non-empty destination and call the same safe writer. Register both commands in `generate_handler!`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml attachment_ --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: tests and check PASS; only the repository's pre-existing PDF dead-code warnings may remain.

- [ ] **Step 6: Commit attachment I/O**

```powershell
git add src/types/mdx.ts src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: open and export embedded attachments"
```

---

### Task 6: Accessible attachment management panel

**Files:**
- Create: `src/components/AttachmentPanel.vue`
- Create: `src/components/AttachmentPanel.test.ts`
- Modify: `src/types/mdx.ts`
- Modify: `src/experience.css`
- Modify: `src/components/panelAccessibility.test.ts`

**Interfaces:**
- Consumes:

```ts
export type AttachmentListItem = ResourceMeta & {
    referenced: boolean;
};
```

- Produces events: `close`, `add`, `openAttachment(path)`, `saveAttachment(path)`, `insertAttachment(path)`, `rename(path, originalName)`, `remove(path)`

- [ ] **Step 1: Write failing component tests**

Mount the real component and test:

```ts
expect(host.getAttribute("role")).toBe("dialog");
expect(document.activeElement).toBe(host);
expect(screenText()).toContain("2 个附件");
expect(row("a.pdf").textContent).toContain("正文已引用");
expect(deleteButton("a.pdf").disabled).toBe(true);
expect(deleteButton("b.zip").disabled).toBe(false);
```

Exercise “添加附件”, “插入引用”, “打开”, “另存为”. Enter rename mode, submit whitespace and assert no event plus an inline error; submit `方案终稿.pdf` and assert:

```ts
expect(emitted("rename")).toEqual([["attachments/a.pdf", "方案终稿.pdf"]]);
```

Click delete on an unreferenced row, assert no immediate `remove`, then confirm and assert the exact path. Verify Escape closes the panel only when no inline confirmation or rename edit is active.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- src/components/AttachmentPanel.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal panel**

Use `<section role="dialog" tabindex="-1" aria-modal="true">` inside the existing `panel-backdrop` visual language. Keep `renamingPath`, `renameValue`, `renameError` and `deletingPath` as local refs. Watch `open` to reset transient state and focus the panel with `nextTick`.

Use semantic `<ul>`/`<li>` rows, real buttons and a visible status label. Format bytes with B/KB/MB/GB units using one local pure function. Disable delete for `referenced` items and render “请先移除正文引用”.

- [ ] **Step 4: Add scoped desktop styling and verify GREEN**

Add only attachment panel selectors to `src/experience.css`; use existing color, radius, shadow, focus and button tokens. At narrow widths stack metadata above actions without horizontal page scrolling.

Run:

```powershell
npm test -- src/components/AttachmentPanel.test.ts src/components/panelAccessibility.test.ts
```

Expected: component and shared accessibility tests PASS.

- [ ] **Step 5: Commit the panel**

```powershell
git add src/components/AttachmentPanel.vue src/components/AttachmentPanel.test.ts src/components/panelAccessibility.test.ts src/types/mdx.ts src/experience.css
git commit -m "feat: add attachment management panel"
```

---

### Task 7: App attachment workflows and document isolation

**Files:**
- Modify: `src/App.vue`
- Test: `src/App.editor-integration.test.ts`
- Test: `src/App.web.test.ts`

**Interfaces:**
- Consumes: `AttachmentPanel`, `AttachmentListItem`, `AttachmentReadRequest`, `referencedResourcePaths`, resource-session mutation APIs and Rust commands
- Produces: complete user-visible attachment workflow

- [ ] **Step 1: Write failing menu and panel integration tests**

In Web tests, assert “插入·Markdown” contains “导入图片或附件” followed by “附件管理”, and clicking the latter opens a dialog titled “附件管理”.

In editor integration, open a note with one referenced and one unreferenced attachment, then assert the panel shows both. Confirm that adding a mocked ordinary attachment:

- registers it in the target document;
- appends `ResourceMeta` with path, stored name, type, size and created time;
- marks only that document dirty;
- does not change canonical content.

Add a delayed import test: switch documents before `import_resource` resolves and assert neither the new active document nor the old document is mutated.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- src/App.web.test.ts src/App.editor-integration.test.ts
```

Expected: FAIL because menu, panel and workflows are absent.

- [ ] **Step 3: Wire panel state and derived items**

Add `showAttachments`. Close it whenever the active document changes, matching history-panel isolation. Build items from a copied `activeDocument.meta?.attachments ?? []` plus:

```ts
const references = referencedResourcePaths(activeDocument.content);
```

Pass `referenced: references.has(item.path)`.

Add “附件管理” to the insert menu, disabled without an active document. Mount `AttachmentPanel` beside existing panels.

- [ ] **Step 4: Implement add, rename, insert and delete**

`chooseAttachments` opens a multi-select dialog and snapshots the active document ID. For each resolved `import_resource`, re-check that ID. Skip `kind === "asset"` and report the skipped count. For attachments, call `registerResourceInSession`, append a `ResourceMeta` using `crypto.randomUUID()`, and call `session.updateMetadata` only after the resource session mutation so the scheduled draft captures both.

Rename updates the mapped pending resource when present and clones only the matching metadata item. Insert writes `[${originalName}](${path})` directly; no Blob URL enters canonical content. Delete re-checks `referencedResourcePaths(runtime.content)` before mutating, calls `runtime.resources.remove(path)`, removes metadata, and schedules dirty state through `session.updateMetadata`.

- [ ] **Step 5: Write failing open/export wiring tests**

For a pending attachment assert `open_attachment` receives Base64 and a null source path. For an unloaded saved attachment assert it receives the `.mdx` source path and null Base64. For “另存为”, mock dialog cancellation and assert no invoke; then select a path and assert `export_attachment` receives the target and the same attachment request.

- [ ] **Step 6: Verify second RED**

Run:

```powershell
npm test -- src/App.editor-integration.test.ts
```

Expected: the new open/export expectations FAIL until handlers are wired.

- [ ] **Step 7: Implement open/export with stale-target guards**

Create `attachmentReadRequest(documentId, resourcePath)` from the target runtime, copied metadata and `runtime.resources.resource(resourcePath)`. Prefer pending Base64 when available; otherwise pass `runtime.path`. Use `runAction`, but after every awaited dialog or command check that the original document still exists and is still active before setting document-specific status or opening follow-up UI.

- [ ] **Step 8: Verify GREEN and full App regression**

Run:

```powershell
npm test -- src/App.web.test.ts src/App.editor-integration.test.ts src/App.resource-loading.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit application workflows**

```powershell
git add src/App.vue src/App.web.test.ts src/App.editor-integration.test.ts
git commit -m "feat: wire current-document attachment management"
```

---

### Task 8: Completion audit, desktop build and delivery

**Files:**
- Modify if needed: files changed by Tasks 1–7 only
- Verify: `docs/superpowers/specs/2026-08-24-mora-attachment-management-design.md`

**Interfaces:**
- Consumes: all completed tasks
- Produces: verified feature branch, merged `master`, pushed `origin/master`

- [ ] **Step 1: Run formatter on changed code only**

Run Prettier with explicit changed frontend paths and `cargo fmt --manifest-path src-tauri/Cargo.toml`. Do not format `TODO.md` or unrelated files.

- [ ] **Step 2: Run full automated verification**

```powershell
npm test
npm run lint
npm run format:check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run build:exe
```

Expected:

- all frontend tests PASS;
- ESLint and Prettier checks exit 0;
- Vite production build exits 0;
- all Rust tests and check exit 0, with any pre-existing warnings reported separately;
- `src-tauri/target/release/mora.exe` exists and has a current modification time.

- [ ] **Step 3: Audit every approved requirement**

Inspect the current diff and map evidence to all nine “当前必须实现” items in the spec. Specifically inspect a test or real output proving: all metadata attachments list, add-without-insert, five row operations, deferred deletion, reference blocking, draft recovery, source-aware Save As and canonical relative paths. Any missing evidence returns to a RED/GREEN cycle.

- [ ] **Step 4: Review the diff for scope and data loss**

Run:

```powershell
git diff --check
git status --short
git diff master...HEAD
```

Confirm only approved files changed, no credential/Base64 fixture leaks, no Blob URL persistence, no target-archive resource inheritance, and no user `TODO.md` change.

- [ ] **Step 5: Commit documentation and final fixes**

```powershell
git add docs/superpowers/specs/2026-08-24-mora-attachment-management-design.md docs/superpowers/plans/2026-08-24-mora-attachment-management.md
git commit -m "docs: specify attachment management"
```

If Task 8 produced code fixes, commit those with a separate conventional commit before the docs commit.

- [ ] **Step 6: Merge and push without touching the dirty main checkout**

Fetch and verify `origin/master` still matches the feature base. From the main checkout, preserve its dirty `TODO.md`, merge `codex/attachment-management` using a normal non-interactive merge, verify the dirty file remains unstaged and unchanged, then push `master` to `origin`.

After push, verify:

```powershell
git status --short --branch
git log -1 --oneline origin/master
```

Expected: `master` and `origin/master` point to the delivered merge or fast-forward commit; only the user's pre-existing `TODO.md` remains modified.

---

## Plan Self-Review

- Spec coverage: Tasks 1–7 map to every current requirement; Task 8 verifies the mapping rather than assuming it.
- Placeholder scan: no deferred implementation markers or unspecified error-handling steps remain.
- Type consistency: `removedResources`, `AttachmentReadRequest`, `AttachmentListItem`, event names and Tauri command names are defined once and reused verbatim.
- Scope check: frontend session changes, ZIP transaction changes and UI form one inseparable document-attachment workflow; splitting them would not produce independently usable software.
- Execution decision: the user already requested direct inline execution after the plan, so no additional handoff question is required.
