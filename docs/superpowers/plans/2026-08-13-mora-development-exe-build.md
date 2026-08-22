# Mora Development EXE Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make routine development validation generate only `mora.exe` while retaining full MSI and NSIS packaging for releases.

**Architecture:** Add one npm command that forwards to Tauri's public `build --no-bundle` option. Update the repository rules and README so development and release workflows have separate, explicit commands.

**Tech Stack:** npm scripts, Tauri 2 CLI, Markdown documentation

## Global Constraints

- Development builds must generate `src-tauri/target/release/mora.exe` without bundling MSI or NSIS.
- Release builds must retain the existing `npm run tauri -- build` behavior.
- Do not change `tauri.conf.json`, dependencies, or historical plan documents.
- Do not commit unless the user explicitly requests it.

---

### Task 1: Add and document the development EXE build

**Files:**
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Produces: npm script `build:exe` invoking `tauri build --no-bundle`

- [x] **Step 1: Add the npm script**

Add `"build:exe": "tauri build --no-bundle"` to `package.json`.

- [x] **Step 2: Split development and release documentation**

Make `npm run build:exe` the required development executable build and retain `npm run tauri -- build` for formal releases.

- [x] **Step 3: Run frontend and Rust validation**

Run `npm run build` and `cargo check --manifest-path src-tauri/Cargo.toml`; require exit code 0.

- [x] **Step 4: Build the development executable**

Run `npm run build:exe`; require exit code 0 and verify `src-tauri/target/release/mora.exe` exists.

- [x] **Step 5: Check the patch**

Run `git diff --check` and inspect `git diff -- package.json AGENTS.md README.md docs/superpowers/specs/2026-08-13-mora-development-exe-build-design.md docs/superpowers/plans/2026-08-13-mora-development-exe-build.md`.
