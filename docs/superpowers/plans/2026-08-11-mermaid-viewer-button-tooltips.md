# Mermaid Viewer Button Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Mermaid 查看器的全部工具栏控件增加准确的原生鼠标提示，并让全屏按钮提示随状态变化。

**Architecture:** 只修改现有 `MermaidViewer` 模板属性，不新增组件、状态或样式。提示文字使用原生 `title`，并与 `aria-label` 保持同一语义；现有 Vitest 组件测试验证静态提示和全屏动态提示。

**Tech Stack:** Vue 3 `<script setup>`、TypeScript、Vitest、jsdom。

## Global Constraints

- 不新增按钮，不改变缩放、适应视图、全屏、导出或关闭行为。
- 不新增 Tooltip 组件、依赖、全局状态或 CSS。
- 每个按钮的 `title` 与 `aria-label` 语义一致。
- 全屏按钮普通状态使用“全屏查看”，全屏状态使用“退出全屏”。
- 缩放比例选择器使用“缩放比例”。

---

### Task 1: Mermaid 查看器原生提示

**Files:**
- Modify: `src/components/editor/MermaidViewer.vue`
- Test: `src/components/editor/MermaidViewer.test.ts`

**Interfaces:**
- Consumes: 现有 `fullscreen: Ref<boolean>` 状态和工具栏控件。
- Produces: 每个控件的原生 `title` 提示；全屏按钮的动态 `aria-label` 与 `title`。

- [ ] **Step 1: 写入失败测试**

在 `src/components/editor/MermaidViewer.test.ts` 中新增：

```ts
it("shows native hover tips for every toolbar control", async () => {
    const viewer = mountViewer();
    cleanup = viewer.unmount;
    await nextTick();

    for (const label of [
        "上一张图",
        "下一张图",
        "缩小",
        "放大",
        "适应视图",
        "导出 PNG",
        "关闭查看器",
    ]) {
        expect(button(viewer.host, label).title).toBe(label);
    }

    const zoomSelect = viewer.host.querySelector<HTMLSelectElement>(
        'select[aria-label="缩放比例"]',
    );
    expect(zoomSelect?.title).toBe("缩放比例");

    const fullscreen = button(viewer.host, "全屏查看");
    expect(fullscreen.title).toBe("全屏查看");
    fullscreen.click();
    await nextTick();
    expect(button(viewer.host, "退出全屏").title).toBe("退出全屏");
});
```

- [ ] **Step 2: 运行测试并确认 RED**

运行：

```powershell
npm test -- src/components/editor/MermaidViewer.test.ts
```

预期：FAIL；现有控件没有 `title`，且适应按钮仍使用旧名称“适合窗口”。

- [ ] **Step 3: 增加最小实现**

在 `src/components/editor/MermaidViewer.vue` 的现有控件上增加与无障碍名称一致的提示：

```vue
<button type="button" aria-label="上一张图" title="上一张图">…</button>
<button type="button" aria-label="下一张图" title="下一张图">…</button>

<button type="button" aria-label="缩小" title="缩小">…</button>
<select aria-label="缩放比例" title="缩放比例">…</select>
<button type="button" aria-label="放大" title="放大">…</button>

<button type="button" aria-label="适应视图" title="适应视图" @click="resetView">
    …
</button>
<button
    type="button"
    :aria-label="fullscreen ? '退出全屏' : '全屏查看'"
    :title="fullscreen ? '退出全屏' : '全屏查看'"
    :aria-pressed="fullscreen"
    @click="fullscreen = !fullscreen"
>
    …
</button>
<button type="button" aria-label="导出 PNG" title="导出 PNG">…</button>
<button type="button" aria-label="关闭查看器" title="关闭查看器">…</button>
```

同步把现有测试中查询“适合窗口”的位置改为“适应视图”。

- [ ] **Step 4: 运行目标测试并确认 GREEN**

运行：

```powershell
npm test -- src/components/editor/MermaidViewer.test.ts
```

预期：PASS；Mermaid 查看器全部测试通过。

- [ ] **Step 5: 运行完整验证**

依次运行：

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

预期：全部退出码为 0；Tauri 生成 EXE、MSI 和 NSIS 产物。允许报告既有 Vite chunk-size 和 Rust dead-code 警告，但不得忽略新错误。

- [ ] **Step 6: 自审并提交**

```powershell
git diff --check
git add -- src/components/editor/MermaidViewer.vue src/components/editor/MermaidViewer.test.ts
git commit -m "feat: add mermaid viewer tooltips"
```

提交必须只包含上述两个实现文件；保留 `TODO.md`、旧计划和 `examples/` 的现有未提交内容。
