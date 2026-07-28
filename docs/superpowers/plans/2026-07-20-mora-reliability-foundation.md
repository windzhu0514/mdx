# Mora Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复资源链路、快捷键、未保存保护和 MDXNote 安全保存，并建立前后端回归测试基础。

**Architecture:** 将可测试的路径、快捷键和资源映射逻辑提取为纯函数；前端使用单文档资源会话管理对象 URL 与待保存资源；Rust 在 ZIP 入口和写入入口统一校验，并用可恢复的临时文件流程保存。

**Tech Stack:** Vue 3、TypeScript、Vitest、Toast UI Editor、Tauri 2、Rust、zip 0.6

## Global Constraints

- 保持现有 MDXNote `.mdx` v1 文件兼容，继续写入 `formatVersion: 1.0.0`。
- 持久化正文始终使用 `assets/...` 和 `attachments/...` 相对路径。
- 不重写 Toast UI Editor，不直接操作其内部 DOM。
- 新增元数据字段必须有默认值。
- Windows 是本阶段主要验收平台。
- 每个行为改动必须先有失败测试，再写实现。

---

### Task 1: Frontend Test Harness and Shared Types

**Files:**

- Modify: `package.json`
- Create: `src/types/mdx.ts`
- Create: `src/utils/resourcePaths.ts`
- Test: `src/utils/resourcePaths.test.ts`

**Interfaces:**

- Produces: `ResourceMeta`, `MdxMetadata`, `MdxNote`, `PendingResource`, `toDisplayMarkdown()`, `toPersistedMarkdown()`。

- [ ] **Step 1: Add Vitest and test scripts**

在 `package.json` 增加 `vitest` 开发依赖和脚本：

```json
{
    "scripts": {
        "test": "vitest run",
        "test:watch": "vitest"
    },
    "devDependencies": {
        "vitest": "^3.2.4"
    }
}
```

- [ ] **Step 2: Write failing resource mapping tests**

```ts
import { describe, expect, it } from "vitest";
import { toDisplayMarkdown, toPersistedMarkdown } from "./resourcePaths";

describe("resource markdown mapping", () => {
    const urls = new Map([["assets/photo.png", "blob:mora-photo"]]);

    it("maps package paths to object URLs for display", () => {
        expect(toDisplayMarkdown("![图](assets/photo.png)", urls)).toBe(
            "![图](blob:mora-photo)",
        );
    });

    it("maps object URLs back before persistence", () => {
        expect(toPersistedMarkdown("![图](blob:mora-photo)", urls)).toBe(
            "![图](assets/photo.png)",
        );
    });

    it("does not rewrite external URLs", () => {
        expect(toDisplayMarkdown("![图](https://example.com/a.png)", urls)).toBe(
            "![图](https://example.com/a.png)",
        );
    });
});
```

- [ ] **Step 3: Run the test and verify failure**

Run: `npm test -- src/utils/resourcePaths.test.ts`

Expected: FAIL because `resourcePaths.ts` does not exist.

- [ ] **Step 4: Implement shared types and mapping**

`src/utils/resourcePaths.ts` 使用转义后的路径进行精确替换，同时支持 Markdown 链接和 HTML `src`；逆向映射遍历相同 Map，将对象 URL 恢复为包内路径。`src/types/mdx.ts` 移入当前 `App.vue` 中的 MDXNote 类型，并增加：

```ts
export type PendingResource = {
    path: string;
    originalName: string;
    mimeType: string;
    size: number;
    base64: string;
    objectUrl: string;
    kind: "asset" | "attachment";
    isNew: boolean;
};
```

- [ ] **Step 5: Run the focused test**

Run: `npm test -- src/utils/resourcePaths.test.ts`

Expected: PASS, 3 tests.

### Task 2: Shortcut Target Guard

**Files:**

- Create: `src/utils/shortcuts.ts`
- Test: `src/utils/shortcuts.test.ts`
- Modify: `src/App.vue`

**Interfaces:**

- Produces: `isTextInputTarget(target: EventTarget | null): boolean` and `shouldHandleEditorShortcut(event: KeyboardEvent): boolean`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { isTextInputTarget } from "./shortcuts";

describe("shortcut target guard", () => {
    it("preserves native shortcuts in inputs", () => {
        expect(isTextInputTarget(document.createElement("input"))).toBe(true);
    });

    it("preserves native shortcuts in textareas", () => {
        expect(isTextInputTarget(document.createElement("textarea"))).toBe(true);
    });

    it("allows application shortcuts outside editable controls", () => {
        expect(isTextInputTarget(document.createElement("div"))).toBe(false);
    });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- src/utils/shortcuts.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the guard**

`isTextInputTarget` 对 `input`、`textarea`、`select`、`contenteditable` 和其后代返回 `true`。`App.vue` 的窗口快捷键先处理 `Ctrl+S/N/O` 等应用级文件操作；编辑、格式和查找快捷键在文本输入目标中直接返回，使标题和查找框保留原生 Ctrl+A/C/X/V/Z。

- [ ] **Step 4: Run focused and full frontend tests**

Run: `npm test -- src/utils/shortcuts.test.ts`

Expected: PASS, 3 tests.

Run: `npm test`

Expected: all frontend tests PASS.

### Task 3: Rust Manifest and ZIP Safety

**Files:**

- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `validate_archive_entry_name(name: &str)`, stricter `validate_manifest()`, archive size constants.

- [ ] **Step 1: Add failing Rust tests**

在 `lib.rs` 的 `#[cfg(test)]` 模块增加：

```rust
#[test]
fn rejects_invalid_manifest_versions() {
    let mut manifest = MdxManifest::default();
    manifest.format_version = "not-a-version".into();
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn rejects_parent_and_absolute_zip_paths() {
    assert!(validate_archive_entry_name("../evil.txt").is_err());
    assert!(validate_archive_entry_name("/evil.txt").is_err());
    assert!(validate_archive_entry_name("C:/evil.txt").is_err());
    assert!(validate_archive_entry_name("assets/ok.png").is_ok());
}

#[test]
fn rejects_resources_outside_allowed_directories() {
    assert!(validate_new_resource_name("content.md").is_err());
    assert!(validate_new_resource_name("assets/image.png").is_ok());
    assert!(validate_new_resource_name("attachments/file.pdf").is_ok());
}
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml rejects_ -- --nocapture`

Expected: compile failure because validation functions do not exist, or assertion failure for malformed version.

- [ ] **Step 3: Implement strict validation**

增加常量 `MAX_ARCHIVE_ENTRIES = 4096`、`MAX_TEXT_ENTRY_BYTES = 16 MiB`、`MAX_RESOURCE_ENTRY_BYTES = 512 MiB`、`MAX_TOTAL_UNCOMPRESSED_BYTES = 2 GiB`。版本必须恰好包含三个十进制段，主版本必须等于 1。Manifest 必须声明 `single-note`、`utf-8`、`zip`，正文和元数据路径必须是安全的包内普通文件路径。打开 ZIP 时先扫描所有条目，拒绝重复条目、不安全名称、超限数量和解压体积。

- [ ] **Step 4: Validate new resources before writing**

`build_mdx_archive` 在 Base64 解码前调用 `validate_new_resource_name`，仅允许 `assets/` 或 `attachments/` 下的单个普通文件；拒绝反斜杠、空段、`.`、`..`、冒号和目录结尾。

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

### Task 4: Resource Session and Image Persistence

**Files:**

- Create: `src/composables/useResources.ts`
- Test: `src/composables/useResources.test.ts`
- Modify: `src/App.vue`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `createResourceSession()`, `loadPackageResources()`, `addImageBlob()`, `addAttachmentFile()`, `displayMarkdown()`, `persistedMarkdown()`, `markSaved()`, `clear()`.

- [ ] **Step 1: Write failing session tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createResourceSession } from "./useResources";

describe("resource session", () => {
    it("clears and revokes every object URL", () => {
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const session = createResourceSession();
        session.registerLoaded("assets/a.png", "blob:a", "image/png", "");
        session.clear();
        expect(revoke).toHaveBeenCalledWith("blob:a");
    });

    it("does not resend a resource after save", () => {
        const session = createResourceSession();
        session.registerNew({
            path: "assets/a.png",
            objectUrl: "blob:a",
            base64: "YQ==",
            originalName: "a.png",
            mimeType: "image/png",
            size: 1,
            kind: "asset",
            isNew: true,
        });
        expect(session.newResources()).toHaveLength(1);
        session.markSaved();
        expect(session.newResources()).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- src/composables/useResources.test.ts`

Expected: FAIL because `useResources.ts` does not exist.

- [ ] **Step 3: Implement document-scoped resource session**

使用 `Map<packagePath, PendingResource>` 和反向 `Map<objectUrl, packagePath>`。`clear()` 撤销全部对象 URL；`markSaved()` 将 `isNew` 设为 false；新文件名使用 `crypto.randomUUID()`，并按 MIME 白名单得到扩展名，不再使用 `Date.now() + Math.random()`。

- [ ] **Step 4: Integrate display and persistence mapping**

打开笔记前清理旧会话；加载元数据中的资源并按需调用 `read_asset`。向 Toast UI 设置正文前调用 `displayMarkdown()`；从 Toast UI 获取正文后调用 `persistedMarkdown()`。保存成功只更新元数据和会话状态，不重新把同名资源加入新资源列表。

- [ ] **Step 5: Update Rust metadata for saved resources**

将 `ResourceData` 扩展为包含 `original_name`、`mime_type`、`size` 和 `kind`。`save_to_path` 去重后把资源写入 `meta.assets` 或 `meta.attachments`，同一路径只保留一条记录。

- [ ] **Step 6: Run focused tests and builds**

Run: `npm test -- src/composables/useResources.test.ts src/utils/resourcePaths.test.ts`

Expected: all focused tests PASS.

Run: `npm run build`

Expected: type check and Vite build PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

### Task 5: Leave Guard, Close Protection, and Draft Recovery

**Files:**

- Create: `src/composables/useDraftRecovery.ts`
- Test: `src/composables/useDraftRecovery.test.ts`
- Modify: `src/App.vue`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**

- Produces Tauri commands: `write_draft`, `read_draft`, `delete_draft`; frontend `scheduleDraft()`, `flushDraft()`, `restoreDraft()`, `clearDraft()`.

- [ ] **Step 1: Write failing draft key and freshness tests**

```ts
import { describe, expect, it } from "vitest";
import { draftKey, shouldOfferDraftRestore } from "./useDraftRecovery";

describe("draft recovery", () => {
    it("uses a stable key for unsaved and saved notes", () => {
        expect(draftKey(null, "note-1")).toBe("note-1");
        expect(draftKey("C:/notes/a.mdx", "note-1")).toContain("C:/notes/a.mdx");
    });

    it("offers a newer draft", () => {
        expect(
            shouldOfferDraftRestore("2026-07-20T10:00:00Z", "2026-07-20T09:00:00Z"),
        ).toBe(true);
    });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- src/composables/useDraftRecovery.test.ts`

Expected: FAIL because the composable does not exist.

- [ ] **Step 3: Implement Rust draft commands**

草稿 JSON 存入 `app_data_dir/drafts/<sha256-key>.json`。为避免新增散列依赖，键由前端传入 UUID 或路径的 Base64URL 编码，Rust 再验证仅包含字母、数字、`-`、`_`。写入使用临时文件替换；损坏 JSON 返回可识别错误但不阻止启动。

- [ ] **Step 4: Implement debounce and recovery prompt**

正文或标题改变后 1.5 秒调度草稿；新建、打开和关闭前先 `flushDraft()`。成功保存后删除当前草稿。应用启动时读取未保存草稿和当前文件草稿，若更新时间更新则询问恢复。

- [ ] **Step 5: Add unified leave guard**

新建和打开调用同一 `confirmLeave()`：保存成功返回 `true`，放弃返回 `true`，取消或保存失败返回 `false`。监听 Tauri 窗口关闭事件；脏状态时阻止关闭，等待守卫结果后显式关闭。

- [ ] **Step 6: Run tests and checks**

Run: `npm test`

Expected: all frontend tests PASS.

Run: `npm run build`

Expected: PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

### Task 6: Durable Safe Save and Phase Verification

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `README.md`

**Interfaces:**

- Produces: durable `safe_write_file()` with unique temp files, ZIP self-validation and recoverable backup handling.

- [ ] **Step 1: Write failing safe-save tests**

使用 `std::env::temp_dir().join(format!("mora-test-{}", Uuid::new_v4()))` 创建隔离目录，覆盖：首次保存、覆盖保存、遗留备份不被无条件删除、保存后的 ZIP 可重新打开。每个测试在结束时删除自身创建的目录。

- [ ] **Step 2: Run and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml safe_write -- --nocapture`

Expected: at least the stale-backup or self-validation assertion FAILS with the current implementation.

- [ ] **Step 3: Implement durable replacement**

临时文件名使用 UUID；写入后调用 `File::sync_all()`；在替换目标前用 `ZipArchive` 验证新文件；仅在确认目标有效或用户已恢复后清理旧备份。成功替换后同步父目录（平台支持时），备份删除失败记录警告但不把已成功保存报告为失败。

- [ ] **Step 4: Update README**

记录草稿目录、恢复行为、图片资源规则和安全保存策略；修复代码块信息字符串，确保 Markdown 正常渲染。

- [ ] **Step 5: Run phase verification**

Run: `npm test`

Expected: all frontend tests PASS.

Run: `npm run build`

Expected: PASS without TypeScript errors.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS without Rust errors.

Run: `npm run tauri -- build`

Expected: desktop bundle build PASS.
