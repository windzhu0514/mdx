# Mora Cross-Platform Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Mora 0.1.1 的 GitHub Draft Release 扩展为 Windows x64、macOS ARM64/x64 和 Linux x64，并生成已确认的安装包格式。

**Architecture:** 保留现有 Tauri updater 和单一 `publish.yml`。通用质量门禁先执行一次，平台矩阵随后串行运行目标检查、原生打包和 Draft Release 上传，以避免共享 `latest.json` 的并发竞争。

**Tech Stack:** GitHub Actions、Tauri 2、tauri-action v1、Rust、Node.js 22、Vitest

**Spec:** `docs/superpowers/specs/2026-08-27-mora-cross-platform-release-design.md`

## Global Constraints

- 目标版本固定为 `0.1.1`，标签格式固定为 `app-v0.1.1`。
- 仅生成 Windows `nsis,msi`、macOS `dmg`、Linux `appimage,deb`。
- 不生成 RPM，不配置 Apple Developer、公证或 Windows Authenticode。
- Release 始终先创建为 Draft，不自动创建标签、不推送、不公开。
- updater 私钥只从现有 GitHub Actions Secrets 读取，不输出其内容。
- 保留用户已有 `TODO.md` 修改；不得格式化、暂存或覆盖无关文件。
- `src-tauri/icons/*` 是当前已确认的第一版图标，本任务只引用，不重新设计。

---

### Task 1: Cross-platform release contract tests

**Files:**

- Modify: `src/releaseWorkflow.test.ts`

**Interfaces:**

- Consumes: `.github/workflows/publish.yml` and `src-tauri/tauri.conf.json`.
- Produces: regression contract for matrix targets, bundles, installer languages and macOS ad-hoc signing.

- [ ] **Step 1: Add failing workflow assertions**

Extend the workflow test with assertions equivalent to:

```ts
expect(workflow).toContain("ubuntu-22.04");
expect(workflow).toContain("macos-latest");
expect(workflow).toContain("x86_64-pc-windows-msvc");
expect(workflow).toContain("aarch64-apple-darwin");
expect(workflow).toContain("x86_64-apple-darwin");
expect(workflow).toContain("x86_64-unknown-linux-gnu");
expect(workflow).toContain("--bundles nsis,msi");
expect(workflow).toContain("--bundles dmg");
expect(workflow).toContain("--bundles appimage,deb");
expect(workflow).toContain("max-parallel: 1");
expect(workflow).toContain("libwebkit2gtk-4.1-dev");
expect(workflow).toContain("retryAttempts: 3");
expect(workflow).not.toContain("--bundles rpm");
```

- [ ] **Step 2: Add failing bundler assertions**

Parse `src-tauri/tauri.conf.json` with a typed local interface and assert:

```ts
expect(config.bundle.windows.wix.language).toBe("zh-CN");
expect(config.bundle.windows.nsis.languages).toEqual(["SimpChinese"]);
expect(config.bundle.windows.nsis.displayLanguageSelector).toBe(false);
expect(config.bundle.macOS.signingIdentity).toBe("-");
expect(config.bundle.icon).toEqual([
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
]);
```

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/releaseWorkflow.test.ts`

Expected: FAIL because the current workflow has no macOS/Linux matrix and the bundler has no installer-language or macOS signing config.

---

### Task 2: Bundler configuration and 0.1.1 version convergence

**Files:**

- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**

- Produces: repository version `0.1.1`, Chinese Windows installers and ad-hoc-signed macOS bundles.

- [ ] **Step 1: Configure platform bundles**

Add this minimal platform configuration under `bundle`:

```json
"windows": {
    "wix": { "language": "zh-CN" },
    "nsis": {
        "languages": ["SimpChinese"],
        "displayLanguageSelector": false
    }
},
"macOS": {
    "signingIdentity": "-"
}
```

- [ ] **Step 2: Bump repository version**

Change only the root application versions from `0.1.0` to `0.1.1`; do not rewrite dependency versions in either lockfile.

- [ ] **Step 3: Validate configuration GREEN**

Run:

```powershell
npx vitest run src/releaseWorkflow.test.ts
npm run release:check -- --tag app-v0.1.1
```

Expected: the bundler assertions pass; workflow assertions remain RED until Task 3.

---

### Task 3: Cross-platform Draft Release workflow

**Files:**

- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: version check, signing Secrets and the four platform definitions.
- Produces: one Draft Release with Windows, macOS and Linux assets plus merged updater metadata.

- [ ] **Step 1: Extract common verification job**

Create `verify` on `ubuntu-22.04` that installs Linux prerequisites, Node 22 and Rust stable, then runs:

```text
npm ci
npm run release:check
npm test
npm run lint
npm run format:check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Add serial publish matrix**

Create `publish` with `needs: verify`, `fail-fast: false`, `max-parallel: 1` and four exact matrix entries from the design. Each row supplies `platform`, `target`, and `args`.

- [ ] **Step 3: Install platform prerequisites and target**

On Ubuntu install:

```text
libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev patchelf xdg-utils
```

Set up Rust with `${{ matrix.target }}`, install npm dependencies, and run:

```text
cargo check --manifest-path src-tauri/Cargo.toml --target ${{ matrix.target }}
```

- [ ] **Step 4: Build and upload Draft assets**

Keep the existing Tauri signer Secrets, `releaseDraft: true`, `uploadUpdaterJson: true` and `updaterJsonPreferNsis: true`. Add `retryAttempts: 3` and pass `${{ matrix.args }}` to `tauri-action@v1`.

- [ ] **Step 5: Verify workflow GREEN**

Run: `npx vitest run src/releaseWorkflow.test.ts`

Expected: PASS with all platform and bundler contracts.

---

### Task 4: Release documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/RELEASE.md`

**Interfaces:**

- Produces: accurate public-version status and a cross-platform release audit checklist.

- [ ] **Step 1: Update README status**

State that `0.1.0` is the current published Windows version and `0.1.1` is preparing Windows/macOS/Linux packages. Do not claim the 0.1.1 Release exists.

- [ ] **Step 2: Expand the release runbook**

Replace Windows-only wording with the exact target matrix, artifact checklist, macOS ad-hoc/Gatekeeper limitation, Linux package list and the fact that real macOS/Linux verification occurs in GitHub Actions.

- [ ] **Step 3: Check document formatting**

Run:

```powershell
npx prettier --check README.md docs/RELEASE.md
git diff --check
```

Expected: PASS.

---

### Task 5: Full local verification and scope review

**Files:**

- Verify only.

**Interfaces:**

- Produces: fresh Windows evidence and a clear list of CI-only acceptance items.

- [ ] **Step 1: Run all local gates**

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

- [ ] **Step 2: Build Windows installers**

Run `npm run tauri -- build` with the existing process-local updater signing key variables without printing secret contents. Verify one `zh-CN.msi`, one NSIS setup `.exe`, and their updater signatures.

- [ ] **Step 3: Audit the worktree**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Report `TODO.md` as pre-existing and untouched. Do not tag, commit, push or dispatch the publish workflow without a new explicit request.

- [ ] **Step 4: Record CI-only acceptance**

State that macOS ARM64/x64 DMG and Linux AppImage/Deb can only be truthfully confirmed after the workflow runs on GitHub-hosted macOS/Ubuntu runners.
