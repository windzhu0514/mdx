//! Typst-backed PDF renderer for the shared document export model.

use super::{
    Block, DocumentModel, ImageData, ImageFormat, Inline, ListItem, MermaidImage, TableAlignment,
    TableRow,
};
use typst::World;
use typst_as_lib::{typst_kit_options::TypstKitFontOptions, TypstEngine, TypstTemplateMainFile};

const CHINESE_FONT_ERROR: &str = "未找到可用于 PDF 导出的中文字体。";
const FONT_FALLBACK: &str = "(\"Microsoft YaHei\", \"SimSun\", \"Noto Sans CJK SC\", \"Arial\")";
const FONT_FAMILIES: [&str; 4] = ["Microsoft YaHei", "SimSun", "Noto Sans CJK SC", "Arial"];
const CHINESE_FONT_PROBE: &str = "中文测试";
const HEADER: &str = r#"#set page(paper: "a4", margin: 25mm, numbering: "1")
#set text(font: ("Microsoft YaHei", "SimSun", "Noto Sans CJK SC", "Arial"), size: 10.5pt, lang: "zh")
#set par(leading: 0.72em, spacing: 0.75em, justify: false)
#show heading.where(level: 1): set text(size: 22pt, weight: "bold")
#show raw.where(block: true): set block(fill: rgb("f5f6f8"), inset: 8pt, radius: 3pt)
"#;

/// Renders the shared document model into PDF bytes without writing a file.
pub fn render_pdf(model: &DocumentModel) -> Result<Vec<u8>, String> {
    let rendered = render(model);
    let engine = build_engine(rendered.source, rendered.files);
    ensure_chinese_font_available(&engine)?;
    let document = engine.compile().output.map_err(format_typst_errors)?;
    typst_pdf::pdf(&document, &Default::default())
        .map_err(|_| "PDF 生成失败：Typst 无法生成 PDF。".to_string())
}

/// Produces the deterministic Typst source used by [`render_pdf`].
///
/// This is public for integration tests. Resources are represented by stable,
/// generated static-resolver paths rather than user-provided paths.
pub fn render_typst_source(model: &DocumentModel) -> String {
    render(model).source
}

fn ensure_chinese_font_available(
    engine: &TypstEngine<TypstTemplateMainFile>,
) -> Result<(), String> {
    let supported = engine
        .with_world(|world| configured_font_covers_chinese(world))
        .map_err(|_| CHINESE_FONT_ERROR.to_string())?;
    supported
        .then_some(())
        .ok_or_else(|| CHINESE_FONT_ERROR.to_string())
}

fn configured_font_covers_chinese(world: &dyn World) -> bool {
    FONT_FAMILIES.iter().any(|family| {
        let family = family.to_lowercase();
        world.book().select_family(&family).any(|index| {
            world.font(index).is_some_and(|font| {
                CHINESE_FONT_PROBE
                    .chars()
                    .all(|character| font.info().coverage.contains(character as u32))
            })
        })
    })
}

fn build_engine(
    source: String,
    image_files: Vec<(String, Vec<u8>)>,
) -> TypstEngine<TypstTemplateMainFile> {
    build_engine_with_font_options(source, image_files, TypstKitFontOptions::default())
}

fn build_engine_with_font_options(
    source: String,
    image_files: Vec<(String, Vec<u8>)>,
    font_options: TypstKitFontOptions,
) -> TypstEngine<TypstTemplateMainFile> {
    TypstEngine::builder()
        .main_file(source)
        .search_fonts_with(font_options)
        .with_static_file_resolver(
            image_files
                .iter()
                .map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
        )
        .build()
}

fn format_typst_errors(_error: impl std::fmt::Display) -> String {
    "PDF 排版失败：Typst 源码无法编译。".to_string()
}

struct RenderedDocument {
    source: String,
    files: Vec<(String, Vec<u8>)>,
}

struct Renderer {
    source: String,
    files: Vec<(String, Vec<u8>)>,
}

fn render(model: &DocumentModel) -> RenderedDocument {
    let mut renderer = Renderer {
        source: String::new(),
        files: Vec::new(),
    };
    renderer.source.push_str("#set document(title: \"");
    renderer.source.push_str(&typst_string(&model.title));
    renderer.source.push_str("\")\n");
    renderer.source.push_str(HEADER);
    renderer
        .source
        .push_str("\n#align(center)[#text(size: 22pt, weight: \"bold\")[");
    renderer.render_text(&model.title);
    renderer.source.push_str("]]\n");
    renderer.render_blocks(&model.blocks);
    RenderedDocument {
        source: renderer.source,
        files: renderer.files,
    }
}

impl Renderer {
    fn render_blocks(&mut self, blocks: &[Block]) {
        for block in blocks {
            self.render_block(block);
            self.source.push('\n');
        }
    }

    fn render_block(&mut self, block: &Block) {
        match block {
            Block::Paragraph(inlines) => self.render_inlines(inlines),
            Block::Heading { level, content } => {
                self.source.push_str("#heading(level: ");
                self.source.push_str(&(*level).clamp(1, 6).to_string());
                self.source.push_str(")[");
                self.render_inlines(content);
                self.source.push(']');
            }
            Block::Quote(blocks) => {
                self.source.push_str("#quote[");
                self.render_blocks(blocks);
                self.source.push(']');
            }
            Block::List { start, items } => self.render_list(*start, items),
            Block::Code { language, source } => self.render_code(source, language),
            Block::Table { alignments, rows } => self.render_table(alignments, rows),
            Block::Image { alt, path, image } => self.render_block_image(alt, path, image.as_ref()),
            Block::Mermaid { source, image } => match image {
                Some(image) => self.render_mermaid_image(image),
                None => self.render_code(source, "mermaid"),
            },
            Block::Rule => self.source.push_str("#line(length: 100%)"),
        }
    }

    fn render_list(&mut self, start: Option<u64>, items: &[ListItem]) {
        match start {
            Some(start) => {
                self.source.push_str("#enum(start: ");
                self.source.push_str(&start.to_string());
                self.source.push_str(")[\n");
                for item in items {
                    self.source.push_str("+ ");
                    self.render_list_item(item);
                    self.source.push('\n');
                }
                self.source.push(']');
            }
            None => {
                self.source.push_str("#list[\n");
                for item in items {
                    self.source.push_str("- ");
                    self.render_list_item(item);
                    self.source.push('\n');
                }
                self.source.push(']');
            }
        }
    }

    fn render_list_item(&mut self, item: &ListItem) {
        if let Some(checked) = item.checked {
            self.source.push_str("#text(\"");
            self.source.push_str(if checked { "☒ " } else { "☐ " });
            self.source.push_str("\")");
        }
        for (index, block) in item.blocks.iter().enumerate() {
            if index > 0 {
                self.source.push_str(" #linebreak() ");
            }
            self.render_block(block);
        }
    }

    fn render_table(&mut self, alignments: &[TableAlignment], rows: &[TableRow]) {
        let columns = alignments
            .len()
            .max(rows.iter().map(|row| row.cells.len()).max().unwrap_or(0));
        if columns == 0 {
            return;
        }
        self.source.push_str("#table(\n  columns: ");
        self.source.push_str(&columns.to_string());
        self.source.push_str(",\n");
        for row in rows {
            if row.is_header {
                self.source.push_str("  table.header(\n");
            }
            for index in 0..columns {
                self.source.push_str("    align(");
                self.source.push_str(table_alignment(alignments.get(index)));
                self.source.push_str(")[");
                if let Some(cell) = row.cells.get(index) {
                    self.render_inlines(cell);
                }
                self.source.push_str("],\n");
            }
            if row.is_header {
                self.source.push_str("  ),\n");
            }
        }
        self.source.push(')');
    }

    fn render_block_image(&mut self, alt: &str, path: &str, image: Option<&ImageData>) {
        match image {
            Some(image) => {
                let file = self.add_image_file(&image.bytes, &image.format);
                self.source.push_str("#align(center)[#image(\"");
                self.source.push_str(&file);
                self.source.push_str("\", ");
                self.source
                    .push_str(&image_size_arguments(image.width, image.height));
                self.source.push_str(", alt: \"");
                self.source.push_str(&typst_string(alt));
                self.source.push_str("\")]");
            }
            None => self.render_missing_image(path),
        }
    }

    fn render_mermaid_image(&mut self, image: &MermaidImage) {
        let file = self.add_image_file(&image.bytes, &image.format);
        self.source.push_str("#align(center)[#image(\"");
        self.source.push_str(&file);
        self.source.push_str("\", ");
        self.source
            .push_str(&image_size_arguments(image.width, image.height));
        self.source.push_str(", alt: \"Mermaid diagram\")]");
    }

    fn render_code(&mut self, source: &str, language: &str) {
        self.source.push_str("#raw(\"");
        self.source.push_str(&typst_string(source));
        self.source.push_str("\", block: true, lang: \"");
        self.source.push_str(&typst_string(language));
        self.source.push_str("\")");
    }

    fn render_inlines(&mut self, inlines: &[Inline]) {
        for inline in inlines {
            self.render_inline(inline);
        }
    }

    fn render_inline(&mut self, inline: &Inline) {
        match inline {
            Inline::Text(text) => self.render_text(text),
            Inline::Emphasis(content) => self.render_wrapped_inlines("emph", content),
            Inline::Strong(content) => self.render_wrapped_inlines("strong", content),
            Inline::Strike(content) => self.render_wrapped_inlines("strike", content),
            Inline::Code(code) => {
                self.source.push_str("#raw(\"");
                self.source.push_str(&typst_string(code));
                self.source.push_str("\")");
            }
            Inline::Link { label, destination } => {
                self.source.push_str("#link(\"");
                self.source.push_str(&typst_string(destination));
                self.source.push_str("\")[");
                self.render_inlines(label);
                self.source.push(']');
            }
            Inline::Image { alt, path, image } => match image {
                Some(image) => {
                    let file = self.add_image_file(&image.bytes, &image.format);
                    self.source.push_str("#image(\"");
                    self.source.push_str(&file);
                    self.source.push_str("\", height: 1.2em, alt: \"");
                    self.source.push_str(&typst_string(alt));
                    self.source.push_str("\")");
                }
                None => self.render_missing_image(path),
            },
            Inline::HardBreak => self.source.push_str("#linebreak()"),
        }
    }

    fn render_wrapped_inlines(&mut self, function: &str, content: &[Inline]) {
        self.source.push('#');
        self.source.push_str(function);
        self.source.push('[');
        self.render_inlines(content);
        self.source.push(']');
    }

    fn render_text(&mut self, text: &str) {
        self.source.push_str("#text(\"");
        self.source.push_str(&typst_string(text));
        self.source.push_str("\")");
    }

    fn render_missing_image(&mut self, path: &str) {
        self.render_text(&format!("[图片不可用：{path}]"));
    }

    fn add_image_file(&mut self, bytes: &[u8], format: &ImageFormat) -> String {
        let filename = format!(
            "mora-image-{}.{}",
            self.files.len(),
            image_extension(format)
        );
        self.files.push((filename.clone(), bytes.to_vec()));
        filename
    }
}

fn typst_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{{{:x}}}", character as u32))
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn image_extension(format: &ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
    }
}

fn image_size_arguments(width: u32, height: u32) -> String {
    const MILLIMETRES_PER_INCH: f64 = 25.4;
    const REFERENCE_DPI: f64 = 96.0;
    const CONTENT_WIDTH_MM: f64 = 160.0;

    let natural_width = f64::from(width) * MILLIMETRES_PER_INCH / REFERENCE_DPI;
    let natural_height = f64::from(height) * MILLIMETRES_PER_INCH / REFERENCE_DPI;
    let scale = (CONTENT_WIDTH_MM / natural_width).min(1.0);
    format!(
        "width: {:.3}mm, height: {:.3}mm",
        natural_width * scale,
        natural_height * scale
    )
}

fn table_alignment(alignment: Option<&TableAlignment>) -> &'static str {
    match alignment {
        Some(TableAlignment::Center) => "center",
        Some(TableAlignment::Right) => "right",
        Some(TableAlignment::Left | TableAlignment::None) | None => "left",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_engine_without_system_or_embedded_cjk_fonts() {
        let engine = build_engine_with_font_options(
            "#text(\"ASCII only\")".to_string(),
            Vec::new(),
            TypstKitFontOptions::default()
                .include_system_fonts(false)
                .include_embedded_fonts(false),
        );

        assert_eq!(
            ensure_chinese_font_available(&engine).unwrap_err(),
            CHINESE_FONT_ERROR
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn accepts_the_current_windows_engine_when_a_configured_font_covers_chinese() {
        let engine = build_engine("#text(\"中文测试\")".to_string(), Vec::new());

        assert!(ensure_chinese_font_available(&engine).is_ok());
    }
}
