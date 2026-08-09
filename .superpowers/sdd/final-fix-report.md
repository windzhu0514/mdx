# Final review fix report

Baseline: `8f76b3b`

## Finding closure

1. **Mermaid final-node submission and stale work** — closed. `mermaidPreview.ts` no longer calls `applyPreview` before rendering. It submits the completed success/error element once and ignores an older request sharing the same Crepe callback. Covered by `mermaidPreview.test.ts` and the public preview-hook coverage in `MilkdownEditor.test.ts`.
2. **Whitelist first declaration** — closed. Frontmatter, leading Mermaid directives, blank space, BOM, and leading comments are stripped before matching one anchored first declaration. A frontmatter `flowchart` followed by `pie` remains an ordinary code block. Covered by `mermaidPreview.test.ts`.
3. **Print Mermaid readiness** — closed. The preview bridge tracks pending renders; `MilkdownEditor` and `MoraEditor` expose `whenSettled()`; `App.exportPdf()` awaits it after Crepe readiness and before `window.print()`. Covered by `MilkdownEditor.test.ts`, `MoraEditor.test.ts`, and deferred print coverage in `App.editor-integration.test.ts`.
4. **Dialog Escape and focus loop** — closed. Escape and Tab/Shift+Tab are handled on the palette dialog, with focus targets held by Vue template refs. Covered by `CommandPalette.test.ts`.
5. **Command focus handoff** — closed. Palette command execution suppresses stale invoker restoration; Settings and History dialogs focus their own panel on open. Covered by `CommandPalette.test.ts`, `App.web.test.ts`, and `panelAccessibility.test.ts`.
6. **Single modal owner** — closed. `App` blocks Ctrl/Cmd+Shift+P while Recent Files, Library, History, Settings, leave confirmation, conflict confirmation, or Markdown-resource confirmation owns the modal layer. Covered by `App.web.test.ts`.
7. **Mermaid error keeps source visible** — closed. A rejected render submits a readable alert and a `pre > code` containing the unchanged source, so `previewOnlyByDefault` cannot hide the only source representation. Covered by `mermaidPreview.test.ts`.
8. **Monochrome interaction states** — closed. Workspace/search/focus states use theme variables; monochrome overrides are grayscale; CodeMirror selection, active line, and active-line gutter use public CSS hooks and shared variables. Covered by `theme.test.ts`.
9. **Suppress Mermaid error DOM** — closed. Mermaid initializes with `suppressErrorRendering: true` and renders into a detached isolated container. Covered by `mermaidPreview.test.ts`.
10. **Active option visibility** — closed. Arrow navigation calls `scrollIntoView({ block: "nearest" })` on the active option template ref. Covered by `CommandPalette.test.ts`.

## TDD and verification evidence

- Tests for A, B, and C were authored before their corresponding production changes.
- RED command attempted: `npm.cmd test -- src/components/editor/mermaidPreview.test.ts`.
- RED could not reach assertions: Vite config loading failed with `Error: spawn EPERM` from `node:internal/child_process` while starting esbuild. Per task instruction, npm/cargo commands were not retried.
- GREEN assertion runs remain pending for the controller; no passing Vitest/build result is claimed here.
- Passed static checks:
  - `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`
  - direct ESLint invocation over every changed TypeScript/Vue file
  - Prettier formatting over every changed source/test/report-adjacent file
  - `git diff --check`

## Controller commands to run

```powershell
npm.cmd test -- src/components/editor/mermaidPreview.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts src/App.editor-integration.test.ts src/components/CommandPalette.test.ts src/App.web.test.ts src/components/panelAccessibility.test.ts src/theme.test.ts
npm.cmd test
npm.cmd run build
cargo check --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri -- build
git diff --check
```

## Changed files

- Mermaid/editor/print: `src/components/editor/mermaidPreview.ts`, `mermaidPreview.test.ts`, `MilkdownEditor.vue`, `MilkdownEditor.test.ts`, `MoraEditor.vue`, `MoraEditor.test.ts`, `SourceEditor.vue`, `editorTypes.ts`, `src/App.vue`, `src/App.editor-integration.test.ts`.
- Palette/modal/accessibility: `src/components/CommandPalette.vue`, `CommandPalette.test.ts`, `SettingsPanel.vue`, `HistoryPanel.vue`, `panelAccessibility.test.ts`, `src/App.vue`, `src/App.web.test.ts`.
- Theme: `src/style.css`, `src/experience.css`, `src/theme.test.ts`.

## Unclosed items

- Code findings: none known after self-review.
- Verification: focused/full Vitest and required npm/cargo/Tauri builds are pending because of the recorded esbuild spawn restriction.
