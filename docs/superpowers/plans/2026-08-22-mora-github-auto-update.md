# Mora GitHub Releases Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Mora Windows 桌面版增加经过签名校验的 GitHub Releases 自动更新、可重复的 Draft Release 流水线，并同步当前功能与发布文档。

**Architecture:** 客户端直接使用 Tauri 2 官方 updater/process 插件；`useAppUpdater.ts` 管理更新状态，`UpdateDialog.vue` 负责呈现，`App.vue` 在安装前复用多文档离开保护。GitHub Actions 使用 Tauri signer 私钥和 `tauri-action` 生成 MSI、NSIS、`.sig` 与 `latest.json`，不引入自建服务器。

**Tech Stack:** Vue 3、TypeScript、Vitest、Tauri 2、Rust、GitHub Actions、Tauri updater/process plugins

**Spec:** `docs/superpowers/specs/2026-08-22-mora-github-auto-update-design.md`

## Global Constraints

- 仅支持 Windows x64 和 GitHub Releases，不增加其他平台或动态更新服务器。
- endpoint 固定为 `https://github.com/windzhu0514/mdx/releases/latest/download/latest.json`。
- 后台仅检查，不自动下载、安装或重启。
- 安装前必须通过现有 `session.prepareWindowClose(closeActions)` 多文档离开保护。
- 更新私钥只允许位于 `C:\Users\ljc01\.tauri\mora-updater.key` 和 GitHub Secrets，绝不进入仓库或日志。
- 当前工作树包含用户已有修改；禁止 `git add -A`、禁止提交不属于本任务的内容、禁止覆盖或格式化无关文件。
- 由于 `App.vue`、`package.json`、Cargo 文件和文档已有修改，实施阶段只报告精确差异，不自动提交这些重叠文件。
- 每个行为变更先写测试并确认因缺少该行为而失败，再写最小实现。

---

### Task 1: Tauri updater/process 基础配置与签名身份

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`
- Test: `src/tauriCapabilities.test.ts`
- External secret: `C:\Users\ljc01\.tauri\mora-updater.key`

**Interfaces:**
- Produces: Tauri guest imports `check` and `relaunch`; endpoint and public key available to the updater plugin.
- Consumes: existing `tauriRuntime = isTauri()` runtime boundary.

- [ ] **Step 1: Extend the configuration test and verify RED**

Add assertions to `src/tauriCapabilities.test.ts`:

```ts
it("只开放更新检查、安装和重启所需权限", () => {
    expect(capability.permissions).toContain("updater:default");
    expect(capability.permissions).toContain("process:allow-restart");
});

it("只从 GitHub Releases HTTPS endpoint 获取签名更新", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
        "https://github.com/windzhu0514/mdx/releases/latest/download/latest.json",
    ]);
    expect(tauriConfig.plugins.updater.pubkey).not.toMatch(/placeholder|replace/i);
    expect(tauriConfig.plugins.updater.pubkey.length).toBeGreaterThan(40);
    expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
});
```

Run: `npx vitest run src/tauriCapabilities.test.ts`

Expected: FAIL because updater/process permissions and config are absent.

- [ ] **Step 2: Add official dependencies**

Run:

```powershell
npm install @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2
cargo add --manifest-path src-tauri/Cargo.toml tauri-plugin-updater@2 tauri-plugin-process@2
```

- [ ] **Step 3: Generate the updater signing identity without exposing the private key**

First verify the target does not already exist:

```powershell
Test-Path -LiteralPath 'C:\Users\ljc01\.tauri\mora-updater.key'
```

If false, create the directory and key without printing private-key contents:

```powershell
New-Item -ItemType Directory -Path 'C:\Users\ljc01\.tauri' -Force | Out-Null
npx tauri signer generate --ci --write-keys 'C:\Users\ljc01\.tauri\mora-updater.key'
```

Read only the public `.pub` file and copy its complete public value into `tauri.conf.json`. Never print or read the private key through tool output.

- [ ] **Step 4: Initialize plugins and apply least-privilege config**

Add to `tauri::Builder` before page load setup:

```rust
.plugin(tauri_plugin_process::init())
.plugin(tauri_plugin_updater::Builder::new().build())
```

Add permissions:

```json
"updater:default",
"process:allow-restart"
```

Add the Tauri config keys below, and set `pubkey` to the exact complete text read from
`C:\Users\ljc01\.tauri\mora-updater.key.pub` in Step 3:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "createUpdaterArtifacts": true,
  "icon": ["icons/icon.ico"]
},
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/windzhu0514/mdx/releases/latest/download/latest.json"
    ],
    "windows": {
      "installMode": "passive"
    }
  }
}
```

The committed `plugins.updater` object must additionally contain the real `pubkey`
string and no substitute or example value.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
npx vitest run src/tauriCapabilities.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: configuration tests PASS and Cargo check exits 0.

- [ ] **Step 6: Inspect exact diff without committing unrelated work**

Run:

```powershell
git diff -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/tauri.conf.json src/tauriCapabilities.test.ts
```

Expected: only updater/process dependencies, initialization, permissions, endpoint, public key and assertions are added to the pre-existing file changes.

---

### Task 2: Release version consistency gate

**Files:**
- Create: `scripts/check-release-version.mjs`
- Create: `scripts/check-release-version.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateReleaseVersions({ packageVersion, cargoVersion, tauriVersion, releaseTag })` and CLI command `npm run release:check`.
- Consumes: JSON versions, Cargo package version, optional `--tag app-vX.Y.Z` or `RELEASE_TAG`.

- [ ] **Step 1: Write the failing Node test**

Create `scripts/check-release-version.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseVersions } from "./check-release-version.mjs";

test("accepts matching repository and tag versions", () => {
    assert.equal(
        validateReleaseVersions({
            packageVersion: "0.1.0",
            cargoVersion: "0.1.0",
            tauriVersion: "0.1.0",
            releaseTag: "app-v0.1.0",
        }),
        "0.1.0",
    );
});

test("rejects a mismatched repository version", () => {
    assert.throws(
        () =>
            validateReleaseVersions({
                packageVersion: "0.1.0",
                cargoVersion: "0.1.1",
                tauriVersion: "0.1.0",
                releaseTag: "app-v0.1.0",
            }),
        /版本不一致/,
    );
});

test("rejects a malformed or mismatched release tag", () => {
    assert.throws(
        () =>
            validateReleaseVersions({
                packageVersion: "0.1.0",
                cargoVersion: "0.1.0",
                tauriVersion: "0.1.0",
                releaseTag: "v0.2.0",
            }),
        /app-v0\.1\.0/,
    );
});
```

Run: `node --test scripts/check-release-version.test.mjs`

Expected: FAIL with module-not-found for `check-release-version.mjs`.

- [ ] **Step 2: Implement the validator and CLI**

Create `scripts/check-release-version.mjs` with these exports and behavior:

```js
export function validateReleaseVersions({
    packageVersion,
    cargoVersion,
    tauriVersion,
    releaseTag,
}) {
    const versions = new Set([packageVersion, cargoVersion, tauriVersion]);
    if (versions.size !== 1) {
        throw new Error(
            `发布版本不一致：package=${packageVersion}, cargo=${cargoVersion}, tauri=${tauriVersion}`,
        );
    }
    const version = packageVersion;
    if (releaseTag && releaseTag !== `app-v${version}`) {
        throw new Error(`发布标签必须为 app-v${version}，实际为 ${releaseTag}`);
    }
    return version;
}
```

The CLI must read `package.json`, `src-tauri/tauri.conf.json`, and only the root `[package]` version from `src-tauri/Cargo.toml`; resolve tag from `--tag`, then `RELEASE_TAG`, then empty; print only `release version X.Y.Z verified`.

Add scripts:

```json
"test:release": "node --test scripts/check-release-version.test.mjs",
"release:check": "node scripts/check-release-version.mjs"
```

- [ ] **Step 3: Verify GREEN and mismatch behavior**

Run:

```powershell
npm run test:release
npm run release:check -- --tag app-v0.1.0
npm run release:check -- --tag app-v9.9.9
```

Expected: first two commands exit 0; the final command exits non-zero and names expected tag `app-v0.1.0`.

- [ ] **Step 4: Inspect exact diff**

Run: `git diff -- scripts/check-release-version.mjs scripts/check-release-version.test.mjs package.json`

Expected: only the reusable version gate and its two package scripts are present.

---

### Task 3: Updater state machine composable

**Files:**
- Create: `src/composables/useAppUpdater.ts`
- Create: `src/composables/useAppUpdater.test.ts`

**Interfaces:**
- Produces:
  - `type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error"`
  - `type UpdateCheckResult = "available" | "current" | "failed" | "skipped"`
  - `useAppUpdater(enabled: boolean)` returning readonly state plus `checkForUpdate`, `downloadUpdate`, `installUpdate`, `clearError`.
- Consumes: official `check()` result and process `relaunch()`.

- [ ] **Step 1: Write failing tests for check behavior**

Mock only the two official modules and assert:

```ts
expect(await updater.checkForUpdate({ silent: false })).toBe("current");
expect(updater.phase.value).toBe("idle");
```

Then return a fake update with `version`, `date`, `body`, `download`, and `install` and assert result `available`, phase `available`, and metadata preservation. Add disabled and concurrent-check cases expecting `skipped`.

Run: `npx vitest run src/composables/useAppUpdater.test.ts`

Expected: FAIL because the composable does not exist.

- [ ] **Step 2: Implement minimal check state**

Use `ref`/`shallowRef`; do not wrap the official `Update` object in a deep Vue proxy. `checkForUpdate({ silent })` must:

- return `skipped` when disabled or busy;
- set `checking`, clear the previous user-visible error, await `check()`;
- return `current` and restore `idle` for null;
- retain the `Update` object and metadata for a result;
- on failure return `failed`, silently restore `idle` for background checks, otherwise enter `error`.

- [ ] **Step 3: Verify check tests GREEN**

Run: `npx vitest run src/composables/useAppUpdater.test.ts`

Expected: check cases PASS.

- [ ] **Step 4: Add failing download/install tests**

Assert download events produce exact byte counts, download errors keep metadata and enter `error`, install errors never call relaunch, and successful install calls relaunch once. Assert a second download/install request returns false while busy.

Run: `npx vitest run src/composables/useAppUpdater.test.ts`

Expected: FAIL because download/install methods are missing.

- [ ] **Step 5: Implement download/install behavior**

`downloadUpdate(): Promise<boolean>` calls `Update.download(listener)`, accumulates `Progress.chunkLength`, records `Started.contentLength`, and enters `downloaded` only after `Finished` or successful completion. `installUpdate(): Promise<boolean>` requires `downloaded`, enters `installing`, awaits `Update.install()`, then awaits `relaunch()`; installation failure enters `error`, while relaunch failure reports `更新已安装，请手动重启 Mora`.

- [ ] **Step 6: Verify full composable GREEN**

Run: `npx vitest run src/composables/useAppUpdater.test.ts`

Expected: all state, error and concurrency tests PASS.

---

### Task 4: Update dialog

**Files:**
- Create: `src/components/UpdateDialog.vue`
- Create: `src/components/UpdateDialog.test.ts`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes props: `open`, `phase`, `version`, `date`, `notes`, `downloadedBytes`, `totalBytes`, `error`.
- Produces emits: `close`, `download`, `install`, `retry`.

- [ ] **Step 1: Write the failing render and interaction tests**

Test accessible dialog title “发现新版本”, version/date/notes rendering, progressbar values, disabled close during `installing`, and exact emitted events for “稍后”“下载更新”“安装并重启”“重试检查”.

Run: `npx vitest run src/components/UpdateDialog.test.ts`

Expected: FAIL because `UpdateDialog.vue` does not exist.

- [ ] **Step 2: Implement the minimal semantic dialog**

Use existing `panel-backdrop`/dialog visual language. Show:

- `available`: “下载更新” and “稍后”.
- `downloading`: progressbar and byte progress, close disabled.
- `downloaded`: “安装并重启” and “稍后”.
- `installing`: blocking “正在安装更新…”.
- `error`: error text, retry appropriate to whether metadata is retained, and close.

Do not parse Markdown release notes; render them as plain text.

- [ ] **Step 3: Verify dialog GREEN**

Run: `npx vitest run src/components/UpdateDialog.test.ts`

Expected: all dialog tests PASS.

---

### Task 5: App menu, startup check and document-safe installation

**Files:**
- Modify: `src/App.vue`
- Modify: `src/App.web.test.ts`
- Modify: `src/App.editor-integration.test.ts`

**Interfaces:**
- Consumes: `useAppUpdater(updatesEnabled)`, `UpdateDialog`, `session.prepareWindowClose(closeActions)`.
- Produces: About command `about.check-updates`, startup silent check, manual feedback and safe installation orchestration.

- [ ] **Step 1: Write failing menu and runtime-boundary tests**

In `App.web.test.ts`, assert “检查更新” appears under About and is disabled in Web preview. Mock the composable in a desktop-shaped test and assert manual action calls `checkForUpdate({ silent: false })`; current result sets status “已是最新版”.

Run: `npx vitest run src/App.web.test.ts`

Expected: FAIL because the command and controller are absent.

- [ ] **Step 2: Add minimal App wiring**

Define:

```ts
const updatesEnabled = tauriRuntime && import.meta.env.PROD;
const appUpdater = useAppUpdater(updatesEnabled);
const showUpdateDialog = ref(false);
```

Add `about.check-updates`, disabled when updater is not enabled or busy. Manual check reports current/failed/available. At the end of desktop startup, fire one non-blocking `checkForUpdate({ silent: true })` and open the dialog only when available.

- [ ] **Step 3: Verify menu/startup GREEN**

Run: `npx vitest run src/App.web.test.ts`

Expected: menu and runtime-boundary cases PASS.

- [ ] **Step 4: Write failing safe-install integration tests**

In `App.editor-integration.test.ts`, mock a downloaded updater and assert:

- canceling the leave dialog does not call `installUpdate`;
- a save failure does not call `installUpdate`;
- successful resolution calls `installUpdate` once;
- the installing dialog blocks editor/menu interaction.

Run: `npx vitest run src/App.editor-integration.test.ts`

Expected: FAIL because installation is not connected to leave protection.

- [ ] **Step 5: Implement safe download/install orchestration**

After a successful download, call a single `installDownloadedUpdate()` function. It awaits `session.prepareWindowClose(closeActions)`; false leaves phase `downloaded` and status “更新安装已取消”; true enables blocking UI and calls `appUpdater.installUpdate()`. It never sets `allowWindowClose` and never closes the native window itself.

Mount `UpdateDialog` beside existing dialogs and connect download/install/retry/close events.

- [ ] **Step 6: Verify App integration GREEN**

Run:

```powershell
npx vitest run src/App.web.test.ts
npx vitest run src/App.editor-integration.test.ts
```

Expected: all updated App tests PASS.

---

### Task 6: GitHub Draft Release workflow

**Files:**
- Create: `.github/workflows/publish.yml`
- Create: `src/releaseWorkflow.test.ts`

**Interfaces:**
- Consumes: `npm run release:check`, updater signing Secrets, current repository tag.
- Produces: Draft Release containing NSIS/MSI artifacts, `.sig` files and `latest.json`.

- [ ] **Step 1: Write failing workflow contract test**

Read `.github/workflows/publish.yml` as text and assert it contains:

```ts
expect(workflow).toContain("windows-latest");
expect(workflow).toContain("app-v*");
expect(workflow).toContain("npm ci");
expect(workflow).toContain("npm run release:check");
expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
expect(workflow).toContain("tauri-apps/tauri-action@v1");
expect(workflow).toContain("releaseDraft: true");
expect(workflow).toContain("uploadUpdaterJson: true");
expect(workflow).toContain("updaterJsonPreferNsis: true");
```

Run: `npx vitest run src/releaseWorkflow.test.ts`

Expected: FAIL because the workflow file does not exist.

- [ ] **Step 2: Implement Windows-only publish workflow**

The workflow must support pushed `app-v*` tags and `workflow_dispatch` with required `release_tag`; resolve one `RELEASE_TAG`, grant `contents: write`, install Node LTS and Rust stable, run all gates, then invoke `tauri-action@v1` with:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
with:
  tagName: ${{ env.RELEASE_TAG }}
  releaseName: Mora __VERSION__
  generateReleaseNotes: true
  releaseDraft: true
  prerelease: false
  uploadUpdaterJson: true
  updaterJsonPreferNsis: true
```

Before the action, run frontend tests/lint/format/build and Rust test/check. Do not add automatic release publication.

- [ ] **Step 3: Verify workflow contract GREEN**

Run:

```powershell
npx vitest run src/releaseWorkflow.test.ts
npm run release:check -- --tag app-v0.1.0
```

Expected: both commands PASS.

---

### Task 7: Current-version and release documentation convergence

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`
- Create: `docs/RELEASE.md`

**Interfaces:**
- Consumes: implemented updater behavior and exact GitHub workflow/Secret names.
- Produces: user-facing capability status and maintainer release runbook.

- [ ] **Step 1: Correct stale feature status**

Update `TODO.md` to mark Word export, six themes, command palette, menu refinement, Mermaid, AI and automatic updates complete. Correct `Wod` to `Word`. Replace the obsolete “PDF depends on system print” limitation with the current independent Typst PDF behavior; keep Print as a separate command.

- [ ] **Step 2: Update README behavior and limitations**

Describe startup/manual update checks, explicit user confirmation, signature verification, GitHub Releases, and the current lack of Authenticode trusted-publisher identity. Do not claim a public release exists before a Release is actually published.

- [ ] **Step 3: Write exact release runbook**

`docs/RELEASE.md` must include:

1. Back up `C:\Users\ljc01\.tauri\mora-updater.key` securely.
2. Set GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` without printing them.
3. Update all three repository version files to the intended SemVer.
4. For the first release, run `npm run release:check -- --tag app-v0.1.0` and all local gates.
5. Create/push `app-v0.1.0` only with explicit release authorization; later releases use the same `app-v` prefix plus their exact repository version.
6. Inspect Draft assets for NSIS, MSI, `.sig`, and `latest.json`.
7. Publish the Draft manually.
8. For a bad release, unpublish it and issue a higher patch version; do not reuse or lower versions.
9. Explain how to add Authenticode later without conflating it with updater signing.

- [ ] **Step 4: Validate docs and diff hygiene**

Run:

```powershell
npx prettier --check README.md TODO.md docs/RELEASE.md
git diff --check
```

Expected: formatting and whitespace checks PASS.

---

### Task 8: Full verification and signed artifact audit

**Files:**
- Verify only; no feature expansion.

**Interfaces:**
- Consumes: all previous tasks and local signing key.
- Produces: fresh evidence for tests, builds and signed installer artifacts.

- [ ] **Step 1: Run all source gates**

Run:

```powershell
npm test
npm run test:release
npm run lint
npm run format:check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run build:exe
```

Expected: every command exits 0. Existing non-fatal chunk-size information may be reported, but no test/lint/type/Cargo error is accepted.

- [ ] **Step 2: Run signed formal Tauri build without logging secrets**

Set process-local environment values to the private-key path and empty password, then build:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY='C:\Users\ljc01\.tauri\mora-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
npm run tauri -- build
```

Do not print either environment variable.

- [ ] **Step 3: Verify artifacts by exact filesystem checks**

Assert these categories exist under `src-tauri/target/release/bundle`:

- one `.msi` and its `.sig`;
- one NSIS setup `.exe` and its `.sig`.

Record full resolved paths and sizes. Do not claim `latest.json` was generated locally; that file is a GitHub Action acceptance item.

- [ ] **Step 4: Review scope and preserve unrelated changes**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Compare changed files against this plan. Report pre-existing modifications separately, do not stage or delete them, and do not publish/tag/push.
