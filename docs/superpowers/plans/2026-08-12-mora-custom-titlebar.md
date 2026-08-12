# Mora Custom Titlebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Windows titlebar with one compact, theme-aware row that combines the existing application menu, document title, mode switch, and native window controls.

**Architecture:** Keep `App.vue` responsible for the existing menu and titlebar layout, and add one focused `WindowControls.vue` for Tauri window commands and maximize-state synchronization. Use Tauri's official drag-region attribute, existing close-request protection, existing semantic theme tokens, and existing Rust window-state persistence rather than introducing parallel abstractions.

**Tech Stack:** Vue 3 Composition API, TypeScript, CSS custom properties, Vitest/jsdom, Tauri 2, Rust

## Global Constraints

- Keep the titlebar to one row of approximately `42px`; do not add a second menu row.
- Do not render an application icon in the titlebar.
- Keep the existing six themes and use `--color-bg-chrome` for the titlebar.
- Keep the existing `onCloseRequested` unsaved-document and save-in-progress protection as the only close guard.
- Use Tauri's `data-tauri-drag-region`; do not add manual drag timers, document-level pointer interception, or a second maximize handler for drag-region double-clicks.
- Hide the mode shortcut group below the existing `780px` breakpoint; keep modes available through the View menu and shortcuts.
- Do not add dependencies, a window service, a new persistence store, or a second window-state mechanism.
- Do not commit implementation changes unless the user explicitly requests a commit.
- After any code change run `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `npm run tauri -- build`.

---

### Task 1: Configure a Frameless Window with Minimal Permissions

**Files:**
- Modify: `src/tauriCapabilities.test.ts`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Tauri main-window configuration and capability permission identifiers.
- Produces: a frameless main window and permission to minimize, toggle maximize, and start native dragging.

- [x] **Step 1: Write failing configuration tests**

Extend `src/tauriCapabilities.test.ts` with the Tauri configuration import and these assertions:

```ts
import tauriConfig from "../src-tauri/tauri.conf.json";

it("关闭原生标题栏装饰", () => {
    expect(tauriConfig.app.windows[0]?.decorations).toBe(false);
});

it("只补充自绘标题栏所需的窗口命令权限", () => {
    expect(capability.permissions).toContain("core:window:allow-minimize");
    expect(capability.permissions).toContain("core:window:allow-toggle-maximize");
    expect(capability.permissions).toContain("core:window:allow-start-dragging");
    expect(capability.permissions).not.toContain("core:window:allow-set-decorations");
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/tauriCapabilities.test.ts`

Expected: FAIL because `decorations` is undefined and the three explicit permissions are absent.

- [x] **Step 3: Apply minimal configuration and permissions**

Add this property to the existing main-window object in `src-tauri/tauri.conf.json`:

```json
"decorations": false
```

Add only these entries to `src-tauri/capabilities/default.json`:

```json
"core:window:allow-minimize",
"core:window:allow-toggle-maximize",
"core:window:allow-start-dragging"
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/tauriCapabilities.test.ts`

Expected: all Tauri capability tests pass.

---

### Task 2: Add Tested Native Window Controls

**Files:**
- Create: `src/components/WindowControls.vue`
- Create: `src/components/WindowControls.test.ts`

**Interfaces:**
- Consumes: `getCurrentWindow()` methods `minimize()`, `toggleMaximize()`, `isMaximized()`, `close()`, and `onResized()`.
- Produces: a no-prop `WindowControls` component rendering `.window-control-minimize`, `.window-control-maximize`, and `.window-control-close` buttons.

- [x] **Step 1: Write the failing component tests**

Create `src/components/WindowControls.test.ts` using a hoisted Tauri window mock. Test that:

```ts
expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "最小化窗口",
    "最大化窗口",
    "关闭窗口",
]);

minimizeButton.click();
maximizeButton.click();
closeButton.click();

expect(mocks.minimize).toHaveBeenCalledOnce();
expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
expect(mocks.close).toHaveBeenCalledOnce();
```

Also mock `isMaximized()` as `false`, capture the `onResized` callback, switch it to `true`, invoke the callback, and assert that the maximize button changes its `aria-label` and `title` to `还原窗口`.

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/components/WindowControls.test.ts`

Expected: FAIL because `WindowControls.vue` does not exist.

- [x] **Step 3: Implement the component**

Create `WindowControls.vue` with:

```ts
const appWindow = getCurrentWindow();
const maximized = ref(false);
let unlistenResize: (() => void) | undefined;

async function syncMaximized() {
    maximized.value = await appWindow.isMaximized();
}

async function runWindowCommand(command: () => Promise<void>) {
    try {
        await command();
    } catch (error) {
        console.error("窗口命令执行失败", error);
    }
}

onMounted(async () => {
    await syncMaximized();
    unlistenResize = await appWindow.onResized(syncMaximized);
});

onBeforeUnmount(() => unlistenResize?.());
```

Render three `type="button"` buttons with inline SVG icons. Bind the maximize button label and icon to `maximized`; invoke `minimize`, `toggleMaximize`, and `close` through `runWindowCommand`. After `toggleMaximize()`, call `syncMaximized()` immediately instead of waiting only for resize.

Use scoped CSS with a `42px` control height, approximately `46px` button width, theme-token hover states, visible focus, and this close hover/focus rule:

```css
.window-control-close:hover,
.window-control-close:focus-visible {
    background: #c42b1c;
    color: #ffffff;
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/components/WindowControls.test.ts`

Expected: all window-control tests pass.

---

### Task 3: Integrate the One-Row Titlebar

**Files:**
- Modify: `src/App.markdown-layout.test.ts`
- Modify: `src/App.web.test.ts`
- Modify: `src/App.vue`
- Modify: `src/style.css`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes: `WindowControls`, `tauriRuntime`, current document `title`, existing menu groups, and the existing mode switch.
- Produces: `.menu-bar.custom-titlebar` with `.menu-document-name[data-tauri-drag-region]`, a compact mode switch, and Tauri-only `WindowControls`.

- [x] **Step 1: Write failing layout and Web-preview tests**

Extend `src/App.markdown-layout.test.ts` to assert:

```ts
expect(appSource).toContain('import WindowControls from "./components/WindowControls.vue"');
expect(appSource).toContain('class="menu-bar custom-titlebar"');
expect(appSource).toContain("data-tauri-drag-region");
expect(appSource).toContain('<WindowControls v-if="tauriRuntime"');
expect(appSource).not.toContain("titlebar-app-icon");
expect(appSource.indexOf('class="mode-switch compact"')).toBeLessThan(
    appSource.indexOf("<WindowControls"),
);
```

Add an assertion to an existing Web-preview mount test in `src/App.web.test.ts`:

```ts
expect(host.querySelector(".window-controls")).toBeNull();
```

This proves Web preview keeps the row but does not expose inert native controls.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- --run src/App.markdown-layout.test.ts src/App.web.test.ts
```

Expected: FAIL because the icon, drag region, custom-titlebar class, and window controls are absent.

- [x] **Step 3: Integrate markup and imports**

In `App.vue`, add:

```ts
import WindowControls from "./components/WindowControls.vue";
```

Change the existing menu navigation opening tag to:

```vue
<nav class="menu-bar custom-titlebar" aria-label="应用菜单">
```

Add `data-tauri-drag-region` to `.menu-document-name`, and render this immediately after the existing mode switch:

```vue
<WindowControls v-if="tauriRuntime" />
```

Do not add a new close handler; `WindowControls` must call the same current window's `close()` so the existing `onCloseRequested` listener remains authoritative.

- [x] **Step 4: Apply compact titlebar styles**

Update the existing `.menu-bar` rule in `src/style.css` to use a fixed `42px` height, `padding: 0 0 0 8px`, `gap: 2px`, and `flex: 0 0 42px`.

```css
.menu-document-name {
    align-self: stretch;
    display: grid;
    place-items: center;
    cursor: default;
    user-select: none;
}

.mode-switch.compact {
    height: 28px;
    padding: 2px;
}

.mode-switch.compact button {
    padding: 4px 10px;
    font-size: 12px;
}
```

Keep `background: var(--color-bg-chrome)` and the existing border. Ensure menu summaries and the mode switch remain outside the drag-region element.

At the existing `@media (max-width: 780px)` block in `src/experience.css`, keep `.mode-switch.compact { display: none; }`, replace titlebar horizontal scrolling with `overflow: visible`, and reduce menu summary inline padding only if needed to keep all menus plus the three control buttons visible at `760px`.

- [x] **Step 5: Run focused integration tests and verify GREEN**

Run:

```powershell
npm test -- --run src/components/WindowControls.test.ts src/App.markdown-layout.test.ts src/App.web.test.ts src/tauriCapabilities.test.ts
```

Expected: all focused files pass.

---

### Task 4: Verify Behavior, Builds, and Artifacts

**Files:**
- Verify only: all changed implementation and test files.

**Interfaces:**
- Consumes: the completed frameless configuration, permissions, controls, and titlebar integration.
- Produces: verified Web behavior and fresh Windows release artifacts.

- [x] **Step 1: Run the full frontend test suite**

Run: `npm test`

Expected: every test file passes with zero failures, including existing close-request tests.

- [x] **Step 2: Run the frontend production build**

Run: `npm run build`

Expected: exit code 0; the existing large-chunk warning may remain.

- [x] **Step 3: Run Rust static verification**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit code 0; existing unused-code or incremental-cache warnings may remain.

- [x] **Step 4: Run the complete Tauri bundle build**

Before building, confirm no `mora.exe` process is running. Then run:

```powershell
npm run tauri -- build
```

Expected: exit code 0 and both MSI and NSIS bundles produced.

- [x] **Step 5: Verify release artifacts and exact change scope**

Confirm fresh timestamps for:

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

Run `git diff --check` and `git status --short`. Confirm `TODO.md`, `examples/`, and `src-tauri/target-scrollbar-build/` remain outside this feature's change scope.
