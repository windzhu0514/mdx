# Word and PDF Direct Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct, offline `.docx` and `.pdf` export for the current in-memory Mora document while preserving Markdown export and system printing.

**Architecture:** The frontend snapshots canonical Markdown, all resource-session data, and neutral-theme Mermaid diagrams, then sends one immutable request to Tauri. Rust parses Markdown once into a small shared document model; `docx-rs` and embedded Typst consume that model, and a generic safe-write helper protects existing destination files.

**Tech Stack:** Vue 3 + TypeScript + Vitest, Tauri 2 + Rust, `pulldown-cmark 0.13.4`, `docx-rs 0.4.22`, `typst-as-lib 0.16.0`, `typst-pdf 0.15`, Poppler `pdftoppm`.

## Global Constraints

- Export the latest canonical in-memory Markdown; do not require saving `.mdx` first.
- Preserve Markdown export and expose system printing as a separate menu command.
- Support headings, paragraphs, inline emphasis/strike/code/link, ordered/unordered/task lists, quotes, code blocks, rules, hard breaks, GFM tables, images, attachments as references, and Mermaid diagrams.
- Produce real OOXML DOCX and searchable/copyable PDF; never rename HTML or rasterize full pages.
- Use A4 portrait pages, approximately 25 mm margins, Chinese-capable font fallback, proportional image sizing, and neutral light Mermaid output.
- Do not access or modify Milkdown internal DOM and do not create a second authoritative Markdown state.
- Cancelled save dialogs are silent; failed exports do not overwrite existing targets or leave partial files.
- Preserve unrelated working-tree changes.

---

### Task 1: Expose all resources and neutral Mermaid export snapshots

**Files:**
- Modify: `src/composables/useResources.ts`
- Modify: `src/composables/useResources.test.ts`
- Modify: `src/components/editor/editorTypes.ts`
- Modify: `src/components/editor/mermaidPreview.ts`
- Modify: `src/components/editor/mermaidPreview.test.ts`
- Modify: `src/components/editor/MilkdownEditor.vue`
- Modify: `src/components/editor/MilkdownEditor.test.ts`
- Modify: `src/components/editor/MoraEditor.vue`
- Modify: `src/components/editor/MoraEditor.test.ts`

**Interfaces:**
- Produces: `ResourceSession.exportResources(): ResourceSaveData[]`
- Produces: `MoraEditorHandle.getMermaidDiagrams(): Promise<MermaidDiagramSnapshot[]>`
- Produces: `renderMermaidForExport(renderer, sources): Promise<MermaidDiagramSnapshot[]>`

- [ ] **Step 1: Write failing resource and Mermaid tests**

```ts
it("exports loaded and new resources without exposing mutable session state", () => {
    const session = createResourceSession();
    session.registerLoaded({ ...newImage, isNew: false });
    const exported = session.exportResources();
    expect(exported).toEqual([{ name: "assets/a.png", originalName: "a.png", mimeType: "image/png", size: 1, kind: "asset", base64: "YQ==" }]);
    exported[0]!.base64 = "changed";
    expect(session.exportResources()[0]!.base64).toBe("YQ==");
});

it("renders export diagrams with neutral theme and restores the application theme", async () => {
    document.documentElement.dataset.theme = "dark";
    const diagrams = await renderMermaidForExport(renderer, ["flowchart TD\nA-->B"]);
    expect(renderer.initialize).toHaveBeenNthCalledWith(1, expect.objectContaining({ theme: "neutral" }));
    expect(renderer.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(diagrams[0]).toMatchObject({ source: "flowchart TD\nA-->B", svg: "<svg />" });
});
```

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/composables/useResources.test.ts src/components/editor/mermaidPreview.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts`

Expected: FAIL because `exportResources`, `renderMermaidForExport`, and `getMermaidDiagrams` do not exist.

- [ ] **Step 3: Implement the minimal read-only APIs**

```ts
function exportResources(): ResourceSaveData[] {
    return Array.from(resources.values(), (resource) => ({
        name: resource.path,
        originalName: resource.originalName,
        mimeType: resource.mimeType,
        size: resource.size,
        kind: resource.kind,
        base64: resource.base64,
    }));
}

export async function renderMermaidForExport(
    mermaid: MermaidRenderer,
    sources: readonly string[],
): Promise<MermaidDiagramSnapshot[]> {
    const restoreTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "neutral";
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true });
    try {
        const diagrams: MermaidDiagramSnapshot[] = [];
        for (const [index, source] of sources.entries()) {
            if (!isSupportedMermaidSource(source)) continue;
            try {
                const { svg } = await mermaid.render(`mora-export-mermaid-${index}`, source);
                diagrams.push({ label: mermaidDiagramLabel(source), source, svg });
            } catch {
                // Missing entries deliberately fall back to code blocks in Rust.
            }
        }
        return diagrams;
    } finally {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: restoreTheme, suppressErrorRendering: true });
    }
}
```

Add `getMermaidDiagrams()` to `MoraEditorHandle`. In `MilkdownEditor.vue`, collect Mermaid sources from `editorViewCtx.state.doc.descendants`, call `renderMermaidForExport`, and delegate through `MoraEditor.vue` to the always-mounted editable Milkdown instance.

- [ ] **Step 4: Run GREEN tests**

Run: `npm test -- src/composables/useResources.test.ts src/components/editor/mermaidPreview.test.ts src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useResources.ts src/composables/useResources.test.ts src/components/editor/editorTypes.ts src/components/editor/mermaidPreview.ts src/components/editor/mermaidPreview.test.ts src/components/editor/MilkdownEditor.vue src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.vue src/components/editor/MoraEditor.test.ts
git commit -m "feat: expose document export resources"
```

### Task 2: Build an immutable frontend export request and menu workflow

**Files:**
- Create: `src/documentExport.ts`
- Create: `src/documentExport.test.ts`
- Modify: `src/App.vue`
- Modify: `src/App.web.test.ts`
- Modify: `src/App.editor-integration.test.ts`

**Interfaces:**
- Consumes: `ResourceSession.exportResources()` and `MoraEditorHandle.getMermaidDiagrams()`
- Produces: `DocumentExportRequest` and `prepareDocumentExportRequest(input)`

- [ ] **Step 1: Write failing request-preparation tests**

```ts
it("converts neutral Mermaid SVGs to PNG without mutating the snapshot", async () => {
    const input = {
        format: "docx" as const,
        destinationPath: "C:\\Notes\\draft.docx",
        title: "草稿",
        markdown: "# 标题",
        resources: [resource],
        diagrams: [{ label: "流程图", source: "flowchart TD\nA-->B", svg: "<svg />" }],
    };
    const request = await prepareDocumentExportRequest(input, vi.fn(async () => "UE5H"));
    expect(request.mermaidDiagrams).toEqual([{ source: "flowchart TD\nA-->B", pngBase64: "UE5H" }]);
    expect(request.markdown).toBe("# 标题");
});
```

- [ ] **Step 2: Run RED helper test**

Run: `npm test -- src/documentExport.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement request types and preparation**

```ts
export type DocumentExportFormat = "docx" | "pdf";
export type ExportMermaidDiagram = { source: string; pngBase64: string };
export type DocumentExportRequest = {
    destinationPath: string;
    title: string;
    markdown: string;
    resources: ResourceSaveData[];
    mermaidDiagrams: ExportMermaidDiagram[];
    format: DocumentExportFormat;
};

export async function prepareDocumentExportRequest(
    input: Omit<DocumentExportRequest, "mermaidDiagrams"> & { diagrams: MermaidDiagramSnapshot[] },
    convert: (svg: string, theme: "light") => Promise<string> = svgToPngBase64,
): Promise<DocumentExportRequest> {
    return {
        destinationPath: input.destinationPath,
        title: input.title,
        markdown: input.markdown,
        resources: input.resources.map((resource) => ({ ...resource })),
        format: input.format,
        mermaidDiagrams: await Promise.all(
            input.diagrams.map(async ({ source, svg }) => ({ source, pngBase64: await convert(svg, "light") })),
        ),
    };
}
```

- [ ] **Step 4: Write failing App workflow tests**

Test that the file menu order is Markdown, Word, PDF, Print; Word uses a `.docx` filter; PDF uses a `.pdf` filter; cancellation never invokes Tauri; an unsaved dirty document exports current Markdown and all resources without calling `save_mdx`; Print still calls `window.print()`.

```ts
expect(mocks.invoke).toHaveBeenCalledWith("export_document", {
    request: expect.objectContaining({ format: "docx", destinationPath: "C:\\Exports\\draft.docx", markdown: "# newest" }),
});
expect(mocks.invoke).not.toHaveBeenCalledWith("save_mdx", expect.anything());
```

- [ ] **Step 5: Run RED App tests**

Run: `npm test -- src/App.web.test.ts src/App.editor-integration.test.ts`

Expected: FAIL because Word/direct-PDF commands and request assembly are absent.

- [ ] **Step 6: Implement the menu and snapshot workflow**

Add `exportDocument(format)` that snapshots `id`, `displayName/title`, canonical `content`, and `resources.exportResources()` before awaiting; awaits `editorRef.whenSettled()` and `getMermaidDiagrams()`; opens the matching save dialog; calls `prepareDocumentExportRequest`; invokes `export_document`; and updates success/error status. Rename current `exportPdf()` to `printDocument()` and label it `打印...`.

- [ ] **Step 7: Run GREEN App tests**

Run: `npm test -- src/documentExport.test.ts src/App.web.test.ts src/App.editor-integration.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/documentExport.ts src/documentExport.test.ts src/App.vue src/App.web.test.ts src/App.editor-integration.test.ts
git commit -m "feat: add word and pdf export workflow"
```

### Task 3: Parse Markdown once into a shared Rust document model

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/document_export/mod.rs`
- Create: `src-tauri/src/document_export/model.rs`
- Create: `src-tauri/tests/document_export.rs`

**Interfaces:**
- Produces: `ExportDocumentRequest`, `ExportFormat`, `DocumentModel`, `Block`, `Inline`, `parse_document(request)`
- Dependencies: `pulldown-cmark = "0.13.4"`, `docx-rs = "0.4.22"`, `typst-as-lib = { version = "0.16.0", features = ["typst-kit-fonts", "typst-kit-embed-fonts"] }`, `typst-pdf = "0.15"`

- [ ] **Step 1: Add only the parser dependency and write parser RED tests**

```rust
#[test]
fn parses_supported_markdown_into_one_shared_model() {
    let request = fixture_request("# 标题\n\n**粗体**与[链接](https://example.com)\n\n- [x] 完成\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![图](assets/a.png)\n\n```mermaid\nflowchart TD\nA-->B\n```");
    let model = parse_document(&request).unwrap();
    assert!(matches!(model.blocks[0], Block::Heading { level: 1, .. }));
    assert!(model.blocks.iter().any(|block| matches!(block, Block::Table { .. })));
    assert!(model.blocks.iter().any(|block| matches!(block, Block::Image { path, .. } if path == "assets/a.png")));
    assert!(model.blocks.iter().any(|block| matches!(block, Block::Mermaid { image: Some(_), .. })));
}
```

- [ ] **Step 2: Run parser RED test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export parses_supported_markdown_into_one_shared_model`

Expected: FAIL because `document_export` and its model do not exist.

- [ ] **Step 3: Implement request/model types and event-stack parser**

```rust
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocumentRequest {
    pub destination_path: String,
    pub title: String,
    pub markdown: String,
    pub resources: Vec<ExportResource>,
    pub mermaid_diagrams: Vec<ExportMermaidDiagram>,
    pub format: ExportFormat,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat { Docx, Pdf }

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading { level: u8, content: Vec<Inline> },
    Quote(Vec<Block>),
    List { start: Option<u64>, items: Vec<ListItem> },
    Code { language: String, source: String },
    Table { alignments: Vec<TableAlignment>, rows: Vec<TableRow> },
    Image { alt: String, path: String, bytes: Option<Vec<u8>> },
    Mermaid { source: String, image: Option<Vec<u8>> },
    Rule,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String), Emphasis(Vec<Inline>), Strong(Vec<Inline>), Strike(Vec<Inline>),
    Code(String), Link { label: Vec<Inline>, destination: String }, HardBreak,
}
```

Use `Options::ENABLE_TABLES | ENABLE_STRIKETHROUGH | ENABLE_TASKLISTS`. Maintain explicit block and inline stacks for `Event::Start`/`End`; resolve `assets/...` against decoded request resources; turn `attachments/...` images/links into readable references; consume Mermaid PNGs by source and occurrence order; leave a failed Mermaid as `Block::Code`.

- [ ] **Step 4: Add edge-case parser tests and run GREEN**

Cover duplicate Mermaid sources, missing images, invalid Base64, nested lists, hard breaks, quoted blocks, and attachment links.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export parse`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/document_export/mod.rs src-tauri/src/document_export/model.rs src-tauri/tests/document_export.rs
git commit -m "feat: parse markdown for document export"
```

### Task 4: Generate valid DOCX with styles, numbering, tables, links, and images

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/document_export/docx.rs`
- Modify: `src-tauri/src/document_export/mod.rs`
- Modify: `src-tauri/tests/document_export.rs`

**Interfaces:**
- Consumes: `DocumentModel`
- Produces: `render_docx(model: &DocumentModel) -> Result<Vec<u8>, String>`

- [ ] **Step 1: Add `docx-rs` and write a DOCX RED integration test**

```rust
#[test]
fn renders_real_docx_with_structure_and_media() {
    let bytes = render_docx(&parse_document(&rich_request()).unwrap()).unwrap();
    assert!(bytes.starts_with(b"PK"));
    let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let document_xml = read_zip_entry(&mut zip, "word/document.xml");
    assert!(document_xml.contains("标题"));
    assert!(document_xml.contains("<w:tbl>"));
    assert!(document_xml.contains("w:numId"));
    assert!(zip.file_names().any(|name| name.starts_with("word/media/")));
}
```

- [ ] **Step 2: Run DOCX RED test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export renders_real_docx_with_structure_and_media`

Expected: FAIL because `render_docx` does not exist.

- [ ] **Step 3: Implement the DOCX renderer**

Create a `Docx::new()` with A4 page size `11906 x 16838` twentieths of a point, 1440-twip margins, default fonts `Microsoft YaHei, SimSun, Arial`, named paragraph/run styles, bullet/ordered/task numberings, explicit table widths and cell margins, and hyperlink relationships. Use `Pic::new(bytes).size(width_emu, height_emu)` for images and preserve aspect ratio within 6.27 inches. Build into a `Cursor<Vec<u8>>` with `docx.build().pack(cursor)` and return its inner bytes.

- [ ] **Step 4: Add structural tests and run GREEN**

Verify `[Content_Types].xml`, styles, numbering, external hyperlink relationships, table cells, image media, heading text, Unicode, and fallback text for missing images/Mermaid.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export docx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/document_export/docx.rs src-tauri/src/document_export/mod.rs src-tauri/tests/document_export.rs
git commit -m "feat: generate docx exports"
```

### Task 5: Generate searchable PDF with embedded Typst and system fonts

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/document_export/pdf.rs`
- Modify: `src-tauri/src/document_export/mod.rs`
- Modify: `src-tauri/tests/document_export.rs`

**Interfaces:**
- Consumes: `DocumentModel`
- Produces: `render_pdf(model: &DocumentModel) -> Result<Vec<u8>, String>`
- Produces for tests: `render_typst_source(model: &DocumentModel) -> String`

- [ ] **Step 1: Add Typst dependencies and write PDF RED tests**

```rust
#[test]
fn renders_searchable_pdf_with_a4_content() {
    let model = parse_document(&rich_request()).unwrap();
    let source = render_typst_source(&model);
    assert!(source.contains("#set page(paper: \"a4\""));
    assert!(source.contains("标题"));
    let bytes = render_pdf(&model).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes.len() > 1_000);
}
```

- [ ] **Step 2: Run PDF RED test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export renders_searchable_pdf_with_a4_content`

Expected: FAIL because the PDF renderer does not exist.

- [ ] **Step 3: Implement safe Typst escaping and source rendering**

Generate a complete source beginning with:

```typst
#set page(paper: "a4", margin: 25mm, numbering: "1")
#set text(font: ("Microsoft YaHei", "SimSun", "Noto Sans CJK SC", "Arial"), size: 10.5pt, lang: "zh")
#set par(leading: 0.72em, spacing: 0.75em, justify: false)
#show heading.where(level: 1): set text(size: 22pt, weight: "bold")
#show raw.where(block: true): set block(fill: rgb("f5f6f8"), inset: 8pt, radius: 3pt)
```

Escape `#`, `[`, `]`, `\`, and Typst string delimiters in text; render tables with `table(...)`, images with static resolver paths, links with `link(...)`, and Mermaid with the same image path pipeline.

- [ ] **Step 4: Compile in-process with system-font search**

```rust
let engine = TypstEngine::builder()
    .main_file(source)
    .search_fonts_with(
        TypstKitFontOptions::default()
            .include_system_fonts(true)
            .include_embedded_fonts(true),
    )
    .with_static_file_resolver(image_files)
    .build();
let document = engine.compile().output.map_err(format_typst_errors)?;
typst_pdf::pdf(&document, &Default::default()).map_err(|error| format!("PDF 生成失败：{error}"))
```

Before compilation, ensure at least one configured font covers a representative Chinese glyph; return `未找到可用于 PDF 导出的中文字体。` when none exists.

- [ ] **Step 5: Run PDF GREEN tests**

Use ASCII-only unit fixtures for platform-independent compilation and a Windows-only Chinese fixture guarded by `#[cfg(target_os = "windows")]`.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export pdf`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/document_export/pdf.rs src-tauri/src/document_export/mod.rs src-tauri/tests/document_export.rs
git commit -m "feat: generate pdf exports"
```

### Task 6: Register the Tauri command and protect destination files

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/document_export/mod.rs`
- Modify: `src-tauri/tests/document_export.rs`
- Modify: `src/tauriCapabilities.test.ts`

**Interfaces:**
- Produces: Tauri command `export_document(request: ExportDocumentRequest) -> Result<String, String>` returning the final normalized path.
- Produces: generic `safe_write_bytes(target: &Path, bytes: &[u8])` reused by `.mdx`, DOCX, and PDF saves.

- [ ] **Step 1: Write RED tests for extension normalization and safe replacement**

```rust
#[test]
fn export_adds_the_selected_extension_and_replaces_atomically() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("report");
    let mut request = rich_request();
    request.destination_path = target.to_string_lossy().into_owned();
    request.format = ExportFormat::Docx;
    let final_path = export_document_file(request).unwrap();
    assert_eq!(final_path.extension().unwrap(), "docx");
    assert!(!dir.path().join("report.docx.tmp").exists());
    assert!(!dir.path().join("report.docx.bak").exists());
}
```

Add a failure-injection unit around the rename stage and assert the old target bytes are restored.

- [ ] **Step 2: Run RED safe-write tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export export_`

Expected: FAIL because export dispatch and generic safe writing are not registered.

- [ ] **Step 3: Refactor generic safe writing and register the command**

Move MDX signature validation before a new `safe_write_bytes`. Derive `.tmp` and `.bak` paths from the final extension (`report.docx.tmp`, `report.docx.bak`), preserve the existing recovery sequence, and make `safe_write_file` call the generic helper after MDX validation. Dispatch `Docx` to `render_docx` and `Pdf` to `render_pdf`; normalize only missing/wrong extensions; add `export_document` to `tauri::generate_handler!`.

- [ ] **Step 4: Run GREEN backend tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_export`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/document_export/mod.rs src-tauri/tests/document_export.rs src/tauriCapabilities.test.ts
git commit -m "feat: save document exports safely"
```

### Task 7: Full regression, real export artifacts, and visual verification

**Files:**
- Create temporarily outside Git: `tmp/document-export-qa/sample.mdx`, exported DOCX/PDF, extracted DOCX files, and rendered PDF PNGs.
- Modify only if defects are found: files from Tasks 1-6 plus their tests.

- [ ] **Step 1: Run formatting, lint, and all automated tests**

```bash
npx prettier --check src src-tauri/src
npx eslint src/documentExport.ts src/documentExport.test.ts src/App.vue src/App.web.test.ts src/components/editor src/composables/useResources.ts src/composables/useResources.test.ts
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0. Record unrelated pre-existing full-repo lint failures separately without changing them.

- [ ] **Step 2: Build a representative export fixture**

The fixture must include Chinese title/body, all heading levels, emphasis/strike/inline code/link, ordered/unordered/task lists, quote, fenced code, GFM table, PNG image, attachment reference, valid Mermaid, invalid Mermaid fallback, and enough paragraphs for multiple PDF pages. Call `export_document_file` from an integration-test helper to produce stable `sample.docx` and `sample.pdf` under `tmp/document-export-qa/`.

- [ ] **Step 3: Verify DOCX structurally**

Use bundled Python with `python-docx` and ZIP inspection to assert that the DOCX opens, paragraphs contain expected Chinese text, tables and hyperlinks exist, media files are non-empty, numbering relationships exist, and no placeholder/internal tokens leak. Because this machine has no Word or LibreOffice, explicitly record that visual DOCX pagination was not verified.

- [ ] **Step 4: Verify PDF text and every rendered page**

Use bundled `pypdf`/`pdfplumber` to extract expected Chinese and table text. Render all pages with:

```bash
pdftoppm -png tmp/document-export-qa/sample.pdf tmp/document-export-qa/page
```

Inspect every generated page image at 100% for clipping, overlap, missing glyphs, broken table layout, image/Mermaid scale, margins, page numbers, and section transitions. Fix defects and repeat the render loop.

- [ ] **Step 5: Run required project build gates**

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Expected: all exit 0. If the default release executable is locked by a running Mora process, do not terminate it; rerun with an isolated `CARGO_TARGET_DIR` and report the isolated artifact paths.

- [ ] **Step 6: Final completion audit**

Check each design requirement against menu tests, parser tests, DOCX structure, extracted PDF text, rendered pages, safe-write tests, and build outputs. Run `git diff --check` and `git status --short`; preserve unrelated changes. Only then mark the active goal complete.

- [ ] **Step 7: Commit any verification fixes**

```bash
git add src/documentExport.ts src/documentExport.test.ts src/App.vue src/App.web.test.ts src/App.editor-integration.test.ts src/composables/useResources.ts src/composables/useResources.test.ts src/components/editor/editorTypes.ts src/components/editor/mermaidPreview.ts src/components/editor/mermaidPreview.test.ts src/components/editor/MilkdownEditor.vue src/components/editor/MilkdownEditor.test.ts src/components/editor/MoraEditor.vue src/components/editor/MoraEditor.test.ts src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/document_export src-tauri/tests/document_export.rs src/tauriCapabilities.test.ts
git commit -m "fix: polish document export output"
```
