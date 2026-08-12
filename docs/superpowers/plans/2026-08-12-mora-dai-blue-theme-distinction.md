# Mora Dai Blue Theme Distinction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Dai Blue theme visibly distinct from Ink Black through a brighter, clearly blue-gray night palette while keeping its name and dark-theme behavior unchanged.

**Architecture:** Keep the existing six-theme semantic CSS-token system and modify only the `dai-blue` token block. Extend the existing theme regression test to assert the approved anchor colors and prevent Dai Blue from collapsing back into the Ink Black palette.

**Tech Stack:** CSS custom properties, Vitest, Vite, Tauri 2, Rust

## Global Constraints

- Keep the theme identifier `dai-blue` and the interface name “黛蓝” unchanged.
- Do not modify Ink Black or any of the four light themes.
- Do not add components, dependencies, theme variants, or settings.
- Keep `color-scheme: dark` and preserve all existing theme selection behavior.
- Run `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `npm run tauri -- build` after the modification.
- Do not create an implementation commit unless the user explicitly requests one.

---

### Task 1: Replace the Dai Blue Palette

**Files:**
- Modify: `src/theme.test.ts`
- Modify: `src/experience.css`
- Verify: `docs/superpowers/specs/2026-08-12-mora-dai-blue-theme-distinction-design.md`

**Interfaces:**
- Consumes: the existing `:root[data-theme="dai-blue"]` semantic token block.
- Produces: the same token names with the approved Night Dai Blue values; no component API changes.

- [x] **Step 1: Write the failing palette regression test**

Add this test inside `describe("dark application theme", ...)` in `src/theme.test.ts`:

```ts
it("keeps dai blue visibly distinct from ink black", () => {
    const readThemeToken = (theme: string, token: string) => {
        const block = experienceCss.match(
            new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "su"),
        )?.[1];
        expect(block).toBeDefined();
        return block?.match(new RegExp(`--${token}:\\s*([^;]+);`, "u"))?.[1];
    };

    expect(readThemeToken("dai-blue", "color-bg-base")).toBe("#162334");
    expect(readThemeToken("dai-blue", "color-bg-surface")).toBe("#1c2b3d");
    expect(readThemeToken("dai-blue", "color-bg-sidebar")).toBe("#18283a");
    expect(readThemeToken("dai-blue", "color-bg-elevated")).toBe("#24364b");
    expect(readThemeToken("dai-blue", "color-text-main")).toBe("#e7edf3");
    expect(readThemeToken("dai-blue", "color-primary")).toBe("#83add1");

    for (const token of ["color-bg-base", "color-bg-surface", "color-bg-sidebar", "color-primary"]) {
        expect(readThemeToken("dai-blue", token)).not.toBe(readThemeToken("ink-black", token));
    }
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/theme.test.ts`

Expected: FAIL because the current Dai Blue base is `#111820`, not `#162334`.

- [x] **Step 3: Apply the approved Night Dai Blue tokens**

Replace only the values inside the existing Dai Blue block with:

```css
:root[data-theme="dai-blue"],
.theme-card[data-theme-preview="dai-blue"] {
    --color-bg-base: #162334;
    --color-bg-surface: #1c2b3d;
    --color-bg-chrome: rgba(19, 31, 47, 0.97);
    --color-bg-sidebar: #18283a;
    --color-bg-sidebar-subtle: #142235;
    --color-bg-sidebar-header: #1d2e42;
    --color-bg-elevated: #24364b;
    --color-bg-popup: rgba(36, 54, 75, 0.98);
    --color-bg-input: #172638;
    --color-bg-control: rgba(222, 233, 244, 0.07);
    --color-bg-control-hover: rgba(222, 233, 244, 0.12);
    --color-border: rgba(190, 211, 232, 0.18);
    --color-text-main: #e7edf3;
    --color-text-muted: #aab9c7;
    --color-primary: #83add1;
    --color-primary-light: rgba(96, 145, 188, 0.24);
    --color-danger: #f09aa4;
    --color-success: #82c9ad;
    --color-inset-highlight: rgba(255, 255, 255, 0.06);
    --app-background-image: radial-gradient(
        circle at 50% -18%,
        rgba(83, 129, 171, 0.22) 0%,
        rgba(22, 35, 52, 0) 60%
    );
    --shadow-lg: 0 24px 72px rgba(3, 10, 20, 0.4);
    color-scheme: dark;
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/theme.test.ts`

Expected: all theme tests pass.

- [x] **Step 5: Run the full frontend test suite**

Run: `npm test`

Expected: all test files pass with zero failures.

- [x] **Step 6: Run required builds**

Run sequentially:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected: all three commands exit with code 0. Existing bundle-size and unused Rust code warnings may remain.

- [x] **Step 7: Verify release artifacts and scope**

Confirm fresh timestamps for:

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

Run `git diff -- src/experience.css src/theme.test.ts` and confirm no other implementation file changed.
