# Mora Light Theme Unified Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor, top bar, workspace sidebar, outline sidebar, and sidebar headers share one background in Xuan White, Pine Green, Crimson, and Wisteria.

**Architecture:** Keep the existing six-theme semantic token system. For the four light themes only, map `--color-bg-chrome`, `--color-bg-sidebar`, `--color-bg-sidebar-subtle`, and `--color-bg-sidebar-header` to the same hex value as `--color-bg-base`; retain surface and elevated tokens for controls, cards, menus, and dialogs.

**Tech Stack:** CSS custom properties, Vue 3, Vitest, Vite, Tauri 2, Rust

## Global Constraints

- Do not change Ink Black or Dai Blue.
- Do not add components, dependencies, or a second theme mechanism.
- Preserve borders, text hierarchy, selection states, and focus styles.
- Run `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `npm run tauri -- build` after the modification.
- Do not create a Git commit unless the user explicitly requests one.

---

### Task 1: Unify the Four Light Theme Backgrounds

**Files:**
- Modify: `src/theme.test.ts`
- Modify: `src/experience.css`
- Verify: `docs/superpowers/specs/2026-08-12-mora-theme-picker-design.md`

**Interfaces:**
- Consumes: existing `data-theme` values and semantic CSS variables.
- Produces: identical main-window background tokens for `xuan-white`, `pine-green`, `crimson`, and `wisteria`.

- [ ] **Step 1: Write the failing regression test**

Add a test that extracts each light-theme CSS block and asserts that these five variables contain one identical value:

```ts
it("uses one main background across each light theme window", () => {
    for (const theme of ["xuan-white", "pine-green", "crimson", "wisteria"]) {
        const block = experienceCss.match(
            new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "su"),
        )?.[1];
        expect(block).toBeDefined();
        const values = [
            "base",
            "chrome",
            "sidebar",
            "sidebar-subtle",
            "sidebar-header",
        ].map((token) =>
            block?.match(new RegExp(`--color-bg-${token}:\\s*([^;]+);`, "u"))?.[1],
        );
        expect(new Set(values).size).toBe(1);
    }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/theme.test.ts`

Expected: FAIL because the four themes currently assign different values to base, chrome, sidebar, sidebar-subtle, and sidebar-header.

- [ ] **Step 3: Apply the minimal token change**

In each of the four light-theme blocks, keep `--color-bg-base` unchanged and set the other four main-window variables to the same literal value:

```css
--color-bg-chrome: var(--color-bg-base-value);
--color-bg-sidebar: var(--color-bg-base-value);
--color-bg-sidebar-subtle: var(--color-bg-base-value);
--color-bg-sidebar-header: var(--color-bg-base-value);
```

Use the actual existing base hex for each theme rather than introducing a new custom property:

- Xuan White: `#f6f7f7`
- Pine Green: `#f3f5f1`
- Crimson: `#f7f4f2`
- Wisteria: `#f6f4f6`

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/theme.test.ts`

Expected: all theme tests pass.

- [ ] **Step 5: Run required verification**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected: all commands exit with code 0; the existing bundle-size and unused-code warnings may remain.

- [ ] **Step 6: Verify official artifacts**

Confirm fresh timestamps for:

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```
