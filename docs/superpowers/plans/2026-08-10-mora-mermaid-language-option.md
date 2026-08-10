# Mora Mermaid Language Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Crepe 代码块语言选择列表中保留全部默认语言并增加小写 `mermaid` 选项，使选择结果继续进入 Mora 现有 Mermaid SVG 预览链路。

**Architecture:** 通过 Crepe CodeMirror 功能的公开 `languages` 配置传入 `@codemirror/language-data` 默认列表与一个自定义 `LanguageDescription`。Mermaid 描述使用无高亮的最小 `StreamLanguage`，只满足代码块语言加载契约；图表渲染继续完全由现有 `renderMermaidPreview` 负责。

**Tech Stack:** Vue 3、TypeScript、Milkdown/Crepe 7.21.3、CodeMirror 6、Mermaid 11.16.1、Vitest/jsdom

## Global Constraints

- 保留 CodeMirror 现有全部默认语言。
- Mermaid 选项名称与写入代码块的语言属性必须是小写 `mermaid`。
- 本次不实现 Mermaid 专用语法高亮、第二个渲染器或第二份正文状态。
- 不修改 `.mdx` 文件格式、Rust command、资源保存和 AI 工作流。
- 只使用 CodeMirror、Crepe 和 Mermaid 的公开 API，不访问内部 DOM。
- 保留工作区中已有的 `TODO.md`、Mermaid 渲染修复、旧计划文档和 `examples/` 变更；禁止覆盖或纳入无关差异。
- 未获得用户明确授权时，不执行 `git add`、`git commit` 或 `git push`。

## File Map

- Modify: `package.json` — 声明源码直接导入的 CodeMirror 语言包。
- Modify: `package-lock.json` — 锁定直接依赖关系，不改变已解析版本。
- Modify: `src/components/editor/MilkdownEditor.vue` — 定义纯文本 Mermaid 语言描述并追加到 Crepe 默认语言列表。
- Modify: `src/components/editor/MilkdownEditor.test.ts` — 验证默认语言保留、Mermaid 可选择且预览配置不变。
- Modify after verification: `docs/superpowers/specs/2026-08-10-mora-mermaid-language-option-design.md` — 将规范状态更新为已实施。

---

### Task 1: Add the Mermaid code-block language option

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/components/editor/MilkdownEditor.vue:5-38`
- Modify: `src/components/editor/MilkdownEditor.vue:150-166`
- Test: `src/components/editor/MilkdownEditor.test.ts:320-348`
- Modify after verification: `docs/superpowers/specs/2026-08-10-mora-mermaid-language-option-design.md:1-4`

**Interfaces:**
- Consumes: `languages: LanguageDescription[]` from `@codemirror/language-data`; `LanguageDescription.of(...)`, `LanguageSupport`, and `StreamLanguage.define(...)` from `@codemirror/language`; Crepe `featureConfigs[Crepe.Feature.CodeMirror].languages`.
- Produces: a `LanguageDescription` whose `name === "mermaid"`, whose aliases include `mermaid`, and whose `support` is a valid plain-text `LanguageSupport`; Crepe receives `[...codeLanguages, mermaidLanguage]`.

- [ ] **Step 1: Write the failing configuration test**

Extend the existing `configures the public CodeMirror preview hook...` test in `src/components/editor/MilkdownEditor.test.ts` so its CodeMirror config type includes languages and it asserts all required behavior:

```ts
const options = mocks.instances[0].options as {
    featureConfigs: Record<
        string,
        {
            languages?: Array<{
                name: string;
                alias: readonly string[];
                support?: unknown;
            }>;
            previewOnlyByDefault?: boolean;
            renderPreview?: unknown;
        }
    >;
};
const codeMirrorConfig = options.featureConfigs["code-mirror"];
const configuredLanguages = codeMirrorConfig.languages ?? [];

expect(configuredLanguages.some(({ name }) => name === "JavaScript")).toBe(true);
expect(configuredLanguages.find(({ name }) => name === "mermaid")).toMatchObject({
    name: "mermaid",
    alias: expect.arrayContaining(["mermaid"]),
    support: expect.anything(),
});
expect(codeMirrorConfig.previewOnlyByDefault).toBe(true);
expect(codeMirrorConfig.renderPreview).toEqual(expect.any(Function));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/components/editor/MilkdownEditor.test.ts
```

Expected: FAIL because `featureConfigs["code-mirror"].languages` is currently absent, so the JavaScript and Mermaid assertions receive an empty array. Existing unrelated tests in the file remain green.

- [ ] **Step 3: Declare the directly imported CodeMirror packages**

Run:

```powershell
npm install --save-exact @codemirror/language@6.12.4 @codemirror/language-data@6.5.2
```

Expected: `package.json` gains both packages under `dependencies`; `package-lock.json` records them as root dependencies without resolving a second CodeMirror version.

Verify:

```powershell
npm ls @codemirror/language @codemirror/language-data --depth=0
```

Expected:

```text
@codemirror/language@6.12.4
@codemirror/language-data@6.5.2
```

- [ ] **Step 4: Add the minimal Mermaid language description**

Add these imports near the existing editor imports in `src/components/editor/MilkdownEditor.vue`:

```ts
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages as codeLanguages } from "@codemirror/language-data";
```

Define the description beside `renderMermaidPreview`:

```ts
const mermaidLanguage = LanguageDescription.of({
    name: "mermaid",
    support: new LanguageSupport(
        StreamLanguage.define<null>({
            startState: () => null,
            token: (stream) => {
                stream.skipToEnd();
                return null;
            },
        }),
    ),
});

const renderMermaidPreview = createMermaidPreview(mermaid);
```

Add the list to the existing CodeMirror feature config without changing its other fields:

```ts
[Crepe.Feature.CodeMirror]: {
    languages: [...codeLanguages, mermaidLanguage],
    renderPreview: renderMermaidPreview,
    previewOnlyByDefault: true,
},
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
npm test -- src/components/editor/MilkdownEditor.test.ts
```

Expected: PASS. Both editable and readonly parameter cases retain `JavaScript`, include lowercase `mermaid` with a loaded support object, and keep the existing preview hook.

- [ ] **Step 6: Run the complete frontend test suite**

Run:

```powershell
npm test
```

Expected: all test files and tests pass with zero failures, including `MilkdownEditor.test.ts` and `mermaidPreview.test.ts`.

- [ ] **Step 7: Update the approved design status**

In `docs/superpowers/specs/2026-08-10-mora-mermaid-language-option-design.md`, change only:

```markdown
**状态：** 已实施
```

- [ ] **Step 8: Run all repository-required builds**

Run each command and require exit code 0:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected:

- Vue TypeScript checking and Vite production build complete successfully.
- Rust `cargo check` completes successfully; a Windows incremental-directory cleanup warning may be reported separately but must not conceal a nonzero exit code.
- Tauri creates `src-tauri/target/release/mora.exe`, the MSI bundle, and the NSIS installer.

- [ ] **Step 9: Inspect the final delivery diff without staging**

Run:

```powershell
git diff --check
git status --short
git diff -- package.json package-lock.json src/components/editor/MilkdownEditor.vue src/components/editor/MilkdownEditor.test.ts docs/superpowers/specs/2026-08-10-mora-mermaid-language-option-design.md
```

Expected: no whitespace errors; the delivery diff contains only the direct dependency declarations, Mermaid language description/configuration, regression assertions, and design status. Existing unrelated changes remain present but untouched and unstaged.

- [ ] **Step 10: Commit only if separately authorized**

Do not run this step unless the user explicitly requests a commit. If authorized, stage only the files listed in this task and run:

```powershell
git add package.json package-lock.json src/components/editor/MilkdownEditor.vue src/components/editor/MilkdownEditor.test.ts docs/superpowers/specs/2026-08-10-mora-mermaid-language-option-design.md docs/superpowers/plans/2026-08-10-mora-mermaid-language-option.md
git commit -m "feat: add mermaid code block language option"
```
