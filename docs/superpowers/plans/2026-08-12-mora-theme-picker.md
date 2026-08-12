# Mora Theme Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six persistent Mora themes and a docked, horizontally scrollable bottom theme picker opened from the View menu.

**Architecture:** Keep `usePreferences` as the only theme state and persistence owner. Add one presentational `ThemePicker` component that emits selection and close events; `App.vue` owns only panel visibility and forwards selection to preferences. Define palettes as CSS variables shared by the application root and miniature card previews.

**Tech Stack:** Vue 3 Composition API, TypeScript, CSS custom properties, Vitest + jsdom, Tauri 2.

## Global Constraints

- Themes are exactly 宣白、墨黑、黛蓝、松青、绛红、藤紫 in that order.
- The picker is docked above the status bar, horizontally scrollable, switches immediately, and closes from its upper-right button.
- Keep Follow System in preferences and migrate legacy `light`, `dark`, and `monochrome` values.
- 墨黑 and 黛蓝 are dark themes; the other four themes are light.
- Do not add dependencies, duplicate document state, or modify Rust behavior.
- Preserve all pre-existing uncommitted changes in the worktree.

---

### Task 1: Theme preference model

**Files:**

- Modify: `src/composables/usePreferences.ts`
- Test: `src/composables/usePreferences.test.ts`

**Interfaces:**

- Produces: `ThemeId`, `ThemePreference`, `THEME_OPTIONS`, `isDarkTheme(theme)`, and `resolveTheme(theme, prefersDark)`.
- `ThemeId` is the six concrete theme IDs; `ThemePreference` is `"system" | ThemeId`.

- [ ] **Step 1: Write failing tests** for the six ordered theme options, system resolution, dark classification, persistence, and migration of `light`, `dark`, and `monochrome`.
- [ ] **Step 2: Run `npm test -- src/composables/usePreferences.test.ts`** and confirm failures are caused by missing IDs and migration.
- [ ] **Step 3: Implement the minimal model** in `usePreferences.ts`; keep storage key `mora.preferences.v1` and map legacy values during normalization.
- [ ] **Step 4: Re-run the focused test** and confirm it passes.

### Task 2: Bottom theme picker component

**Files:**

- Create: `src/components/ThemePicker.vue`
- Create: `src/components/ThemePicker.test.ts`
- Modify: `src/experience.css`

**Interfaces:**

- Consumes: `theme: ThemeId` and `THEME_OPTIONS`.
- Produces: `select(theme: ThemeId)` and `close()` events.

- [ ] **Step 1: Write failing component tests** asserting six ordered buttons, radiogroup semantics, selected state, emitted selection, and the upper-right close action.
- [ ] **Step 2: Run `npm test -- src/components/ThemePicker.test.ts`** and confirm failure because the component is absent.
- [ ] **Step 3: Implement the component** with a header, close button, and one native horizontal overflow track containing preview cards.
- [ ] **Step 4: Add scoped picker layout rules** and shared miniature-preview variables without creating a second palette data source.
- [ ] **Step 5: Re-run the focused test** and confirm it passes.

### Task 3: App menu integration

**Files:**

- Modify: `src/App.vue`
- Modify: `src/components/SettingsPanel.vue`
- Test: `src/App.web.test.ts`
- Test: `src/components/SettingsPanel.test.ts`

**Interfaces:**

- App passes `resolvedTheme` to `ThemePicker` and handles `select` with `updatePreferences({ theme })`.
- View menu command `view.theme` opens the picker.

- [ ] **Step 1: Write failing integration tests** that open “选择主题...”, select 藤紫, observe immediate `data-theme`, close the panel, and verify dark native-window synchronization for 黛蓝.
- [ ] **Step 2: Update the settings test** to expect Follow System plus all six concrete theme choices.
- [ ] **Step 3: Run both focused test files** and confirm expected failures.
- [ ] **Step 4: Add picker visibility and menu action to `App.vue`**, render `ThemePicker` immediately above `StatusBar`, and use `isDarkTheme` for Tauri synchronization.
- [ ] **Step 5: Update the settings theme select** to the new IDs and labels while retaining Follow System.
- [ ] **Step 6: Re-run both focused tests** and confirm they pass.

### Task 4: Six palettes and theme consumers

**Files:**

- Modify: `src/experience.css`
- Modify: `src/theme.test.ts`
- Modify: `src/components/editor/mermaidPreview.ts`
- Modify: `src/components/editor/mermaidPreview.test.ts`
- Modify: `src/components/editor/mermaidExport.ts`
- Modify: `src/components/editor/mermaidExport.test.ts`

**Interfaces:**

- CSS responds to `data-theme` with all palette variables.
- Mermaid consumers use `isDarkTheme` rather than matching one legacy string.

- [ ] **Step 1: Write failing tests** that require all six root selectors, dark editor surfaces for both dark themes, and dark Mermaid rendering for 黛蓝.
- [ ] **Step 2: Run the focused theme and Mermaid tests** and confirm the failures target missing palette selectors and classification.
- [ ] **Step 3: Add six palette variable blocks** and update dark-only selectors to cover 墨黑 and 黛蓝.
- [ ] **Step 4: Replace Mermaid exact-string checks** with the shared dark-theme helper.
- [ ] **Step 5: Run focused tests and then `npm test`**; confirm all frontend tests pass.

### Task 5: Required repository verification

**Files:**

- No production file changes expected.

- [ ] **Step 1: Run `npm run build`** and require exit code 0.
- [ ] **Step 2: Run `cargo check --manifest-path src-tauri/Cargo.toml`** and require exit code 0.
- [ ] **Step 3: Run `npm run tauri -- build`** and require exit code 0.
- [ ] **Step 4: Run `git diff --check` and `git status --short`**, inspect only task-related diffs, and verify unrelated dirty changes remain intact.
