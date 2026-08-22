# Mora Xuan White NyaMark Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use NyaMark's sampled `#fffffd` as the unified background for the entire Xuan White window while retaining Mora's text and accent colors.

**Architecture:** Keep the existing semantic CSS token system. Map every Xuan White background token to one literal value and disable its decorative window gradient; all components continue consuming the same variables.

**Tech Stack:** CSS custom properties, Vue 3, Vitest, Vite, Tauri 2, Rust

## Global Constraints

- Use `#fffffd` for every Xuan White background surface and `#eeeeec` for borders.
- Preserve Mora's existing Xuan White text, accent, danger, and success colors.
- Do not modify the other five themes or introduce components, dependencies, or a second theme mechanism.
- Preserve all unrelated working-tree changes.
- Do not create a Git commit unless the user explicitly requests one.

---

### Task 1: Update Xuan White Semantic Tokens

**Files:**
- Modify: `src/theme.test.ts`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes: existing `xuan-white` theme selector and semantic CSS variables.
- Produces: the approved NyaMark-derived Xuan White background hierarchy.

- [ ] **Step 1: Write the failing regression test**

Assert that every `color-bg-*` background token resolves to `#fffffd`, `app-background-image` is `none`, and `color-border` remains `#eeeeec`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/theme.test.ts`

Expected: FAIL because Xuan White still assigns `#fafafa`, `#feffff`, and `#ffffff` to some surfaces and retains a radial gradient.

- [ ] **Step 3: Apply the minimal token update**

Set every Xuan White background, surface, popup, and input variable to `#fffffd`; set the app background image to `none`. Leave borders, text, and semantic accent variables unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/theme.test.ts`

Expected: all theme tests pass.

- [ ] **Step 5: Run complete verification**

Run `npm test`, `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, `npm run tauri -- build`, and `git diff --check`; every command must exit with code 0.

### Task 2: Align Xuan White, Ink Black, and Dai Blue Accent Semantics

**Files:**
- Modify: `src/theme.test.ts`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes: the existing `--color-primary` and `--color-primary-light` variables used by active mode and sidebar-toggle styles.
- Produces: theme-native accent colors for Xuan White, Ink Black, and Dai Blue without adding component-specific variables.

- [ ] **Step 1: Add exact accent-token assertions**

Assert these pairs in the three theme blocks: Xuan White `#596164` / `#eef0ef`, Ink Black `#b8c0c3` / `rgba(184, 192, 195, 0.16)`, Dai Blue `#668db3` / `rgba(102, 141, 179, 0.24)`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/theme.test.ts`

Expected: FAIL because all three themes still contain their previous cyan or light-blue accent pairs.

- [ ] **Step 3: Update only the six accent token values**

Replace `--color-primary` and `--color-primary-light` in Xuan White, Ink Black, and Dai Blue. Do not change Pine Green, Crimson, or Wisteria.

- [ ] **Step 4: Run focused and complete verification**

Run the focused theme test followed by the repository's full test and build commands; all commands must exit with code 0.
