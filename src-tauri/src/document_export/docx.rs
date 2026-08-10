use super::{Block, DocumentModel, ImageData, Inline, ListItem, MermaidImage, TableAlignment};
use docx_rs::*;
use std::io::Cursor;

const PAGE_WIDTH_TWIPS: u32 = 11_906;
const PAGE_HEIGHT_TWIPS: u32 = 16_838;
const PAGE_MARGIN_TWIPS: i32 = 1_440;
const CONTENT_WIDTH_TWIPS: usize = 9_026;
const MAX_IMAGE_EMU: u64 = 5_733_288;

const BULLET_NUMBERING_ID: usize = 1;
const ORDERED_NUMBERING_ID: usize = 2;
const TASK_CHECKED_NUMBERING_ID: usize = 3;
const TASK_UNCHECKED_NUMBERING_ID: usize = 4;

pub fn render_docx(model: &DocumentModel) -> Result<Vec<u8>, String> {
    let mut document = Docx::new()
        .page_size(PAGE_WIDTH_TWIPS, PAGE_HEIGHT_TWIPS)
        .page_margin(
            PageMargin::new()
                .top(PAGE_MARGIN_TWIPS)
                .right(PAGE_MARGIN_TWIPS)
                .bottom(PAGE_MARGIN_TWIPS)
                .left(PAGE_MARGIN_TWIPS),
        )
        .default_size(21);

    for style in document_styles() {
        document = document.add_style(style);
    }
    document = add_numbering_definitions(document);

    let mut renderer = Renderer { document };
    renderer.render_blocks(&model.blocks, false);

    let mut cursor = Cursor::new(Vec::new());
    renderer
        .document
        .build()
        .pack(&mut cursor)
        .map_err(|error| format!("DOCX 打包失败：{error}"))?;
    Ok(cursor.into_inner())
}

struct Renderer {
    document: Docx,
}

impl Renderer {
    fn push_paragraph(&mut self, paragraph: Paragraph) {
        let document = std::mem::replace(&mut self.document, Docx::new());
        self.document = document.add_paragraph(paragraph);
    }

    fn push_table(&mut self, table: Table) {
        let document = std::mem::replace(&mut self.document, Docx::new());
        self.document = document.add_table(table);
    }

    fn render_blocks(&mut self, blocks: &[Block], quote: bool) {
        for block in blocks {
            self.render_block(block, quote);
        }
    }

    fn render_block(&mut self, block: &Block, quote: bool) {
        match block {
            Block::Paragraph(inlines) => self.add_inline_paragraph(inlines, paragraph_style(quote)),
            Block::Heading { level, content } => {
                self.add_inline_paragraph(content, heading_style(*level));
            }
            Block::Quote(blocks) => self.render_blocks(blocks, true),
            Block::List { start, items } => self.render_list(items, start.is_some(), 0, quote),
            Block::Code { source, .. } => self.add_code_paragraph(source, quote),
            Block::Table { alignments, rows } => self.add_table(alignments, rows),
            Block::Image { path, image, .. } => {
                self.add_image_paragraph(path, image.as_ref(), quote)
            }
            Block::Mermaid { source, image } => {
                if let Some(image) = image {
                    self.add_mermaid_paragraph(image, quote);
                } else {
                    self.add_code_paragraph(source, quote);
                }
            }
            Block::Rule => self.add_rule(),
        }
    }

    fn render_list(&mut self, items: &[ListItem], ordered: bool, depth: usize, quote: bool) {
        for item in items {
            let mut emitted_marker = false;
            for block in &item.blocks {
                if !emitted_marker {
                    match block {
                        Block::Paragraph(inlines) => {
                            self.add_list_paragraph(
                                inlines,
                                list_numbering_id(ordered, item.checked),
                                depth,
                                quote,
                            );
                            emitted_marker = true;
                            continue;
                        }
                        Block::Image { path, image, .. } => {
                            self.add_list_image_paragraph(
                                path,
                                image.as_ref(),
                                list_numbering_id(ordered, item.checked),
                                depth,
                                quote,
                            );
                            emitted_marker = true;
                            continue;
                        }
                        Block::Mermaid {
                            image: Some(image), ..
                        } => {
                            self.add_list_mermaid_paragraph(
                                image,
                                list_numbering_id(ordered, item.checked),
                                depth,
                                quote,
                            );
                            emitted_marker = true;
                            continue;
                        }
                        _ => {
                            self.add_list_paragraph(
                                &[],
                                list_numbering_id(ordered, item.checked),
                                depth,
                                quote,
                            );
                            emitted_marker = true;
                        }
                    }
                }

                match block {
                    Block::List { start, items } => {
                        self.render_list(items, start.is_some(), depth.saturating_add(1), quote)
                    }
                    _ => self.render_block(block, quote),
                }
            }

            if !emitted_marker {
                self.add_list_paragraph(
                    &[],
                    list_numbering_id(ordered, item.checked),
                    depth,
                    quote,
                );
            }
        }
    }

    fn add_inline_paragraph(&mut self, inlines: &[Inline], style: &str) {
        let paragraph = append_inlines(
            Paragraph::new().style(style),
            inlines,
            InlineFormat::default(),
        );
        self.push_paragraph(paragraph);
    }

    fn add_list_paragraph(
        &mut self,
        inlines: &[Inline],
        numbering_id: usize,
        depth: usize,
        quote: bool,
    ) {
        let paragraph = append_inlines(
            Paragraph::new().style(paragraph_style(quote)).numbering(
                NumberingId::new(numbering_id),
                IndentLevel::new(depth.min(8)),
            ),
            inlines,
            InlineFormat::default(),
        );
        self.push_paragraph(paragraph);
    }

    fn add_image_paragraph(&mut self, path: &str, image: Option<&ImageData>, quote: bool) {
        let paragraph =
            add_image_to_paragraph(Paragraph::new().style(paragraph_style(quote)), path, image);
        self.push_paragraph(paragraph);
    }

    fn add_mermaid_paragraph(&mut self, image: &MermaidImage, quote: bool) {
        let paragraph = Paragraph::new()
            .style(paragraph_style(quote))
            .add_run(image_run(&image.bytes, image.width, image.height));
        self.push_paragraph(paragraph);
    }

    fn add_list_image_paragraph(
        &mut self,
        path: &str,
        image: Option<&ImageData>,
        numbering_id: usize,
        depth: usize,
        quote: bool,
    ) {
        let paragraph = add_image_to_paragraph(
            Paragraph::new().style(paragraph_style(quote)).numbering(
                NumberingId::new(numbering_id),
                IndentLevel::new(depth.min(8)),
            ),
            path,
            image,
        );
        self.push_paragraph(paragraph);
    }

    fn add_list_mermaid_paragraph(
        &mut self,
        image: &MermaidImage,
        numbering_id: usize,
        depth: usize,
        quote: bool,
    ) {
        let paragraph = Paragraph::new()
            .style(paragraph_style(quote))
            .numbering(
                NumberingId::new(numbering_id),
                IndentLevel::new(depth.min(8)),
            )
            .add_run(image_run(&image.bytes, image.width, image.height));
        self.push_paragraph(paragraph);
    }

    fn add_code_paragraph(&mut self, source: &str, quote: bool) {
        let style = if quote { "MoraQuoteCode" } else { "MoraCode" };
        self.push_paragraph(Paragraph::new().style(style).add_run(code_run(source)));
    }

    fn add_rule(&mut self) {
        self.push_paragraph(
            Paragraph::new()
                .style("MoraRule")
                .add_run(Run::new().add_text(" ")),
        );
    }

    fn add_table(&mut self, alignments: &[TableAlignment], rows: &[super::TableRow]) {
        let column_count = rows
            .iter()
            .map(|row| row.cells.len())
            .max()
            .unwrap_or(1)
            .max(1);
        let base_width = CONTENT_WIDTH_TWIPS / column_count;
        let remainder = CONTENT_WIDTH_TWIPS % column_count;
        let widths: Vec<usize> = (0..column_count)
            .map(|index| base_width + usize::from(index < remainder))
            .collect();

        let table_rows = rows
            .iter()
            .map(|row| {
                let cells = (0..column_count)
                    .map(|index| {
                        let inlines = row.cells.get(index).map(Vec::as_slice).unwrap_or(&[]);
                        let mut paragraph = append_inlines(
                            Paragraph::new().style("MoraBody"),
                            inlines,
                            InlineFormat {
                                bold: row.is_header,
                                ..InlineFormat::default()
                            },
                        );
                        if let Some(alignment) = alignments.get(index).and_then(table_alignment) {
                            paragraph = paragraph.align(alignment);
                        }
                        TableCell::new()
                            .width(widths[index], WidthType::Dxa)
                            .vertical_align(VAlignType::Center)
                            .add_paragraph(paragraph)
                    })
                    .collect();
                TableRow::new(cells)
            })
            .collect();

        let table = Table::new(table_rows)
            .width(CONTENT_WIDTH_TWIPS, WidthType::Dxa)
            .set_grid(widths)
            .layout(TableLayoutType::Fixed)
            .margins(TableCellMargins::new().margin(80, 120, 80, 120));
        self.push_table(table);
    }
}

#[derive(Clone, Copy, Default)]
struct InlineFormat {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
}

fn append_inlines(mut paragraph: Paragraph, inlines: &[Inline], format: InlineFormat) -> Paragraph {
    for inline in inlines {
        paragraph = append_inline(paragraph, inline, format);
    }
    paragraph
}

fn append_inline(paragraph: Paragraph, inline: &Inline, format: InlineFormat) -> Paragraph {
    match inline {
        Inline::Text(value) => paragraph.add_run(formatted_run(value, format)),
        Inline::Emphasis(content) => append_inlines(
            paragraph,
            content,
            InlineFormat {
                italic: true,
                ..format
            },
        ),
        Inline::Strong(content) => append_inlines(
            paragraph,
            content,
            InlineFormat {
                bold: true,
                ..format
            },
        ),
        Inline::Strike(content) => append_inlines(
            paragraph,
            content,
            InlineFormat {
                strike: true,
                ..format
            },
        ),
        Inline::Code(value) => paragraph.add_run(formatted_run(
            value,
            InlineFormat {
                code: true,
                ..format
            },
        )),
        Inline::Link { label, destination } => {
            let mut hyperlink = Hyperlink::new(destination, HyperlinkType::External);
            for child in label {
                hyperlink = append_inline_to_hyperlink(hyperlink, child, format);
            }
            paragraph.add_hyperlink(hyperlink)
        }
        Inline::Image { path, image, .. } => {
            add_image_to_paragraph(paragraph, path, image.as_ref())
        }
        Inline::HardBreak => paragraph.add_run(Run::new().add_break(BreakType::TextWrapping)),
    }
}

fn append_inline_to_hyperlink(
    hyperlink: Hyperlink,
    inline: &Inline,
    format: InlineFormat,
) -> Hyperlink {
    match inline {
        Inline::Text(value) => hyperlink.add_run(formatted_run(value, format)),
        Inline::Emphasis(content) => append_hyperlink_inlines(
            hyperlink,
            content,
            InlineFormat {
                italic: true,
                ..format
            },
        ),
        Inline::Strong(content) => append_hyperlink_inlines(
            hyperlink,
            content,
            InlineFormat {
                bold: true,
                ..format
            },
        ),
        Inline::Strike(content) => append_hyperlink_inlines(
            hyperlink,
            content,
            InlineFormat {
                strike: true,
                ..format
            },
        ),
        Inline::Code(value) => hyperlink.add_run(formatted_run(
            value,
            InlineFormat {
                code: true,
                ..format
            },
        )),
        Inline::Link { label, .. } => append_hyperlink_inlines(hyperlink, label, format),
        Inline::Image { path, image, .. } => {
            hyperlink.add_run(image_or_fallback_run(path, image.as_ref()))
        }
        Inline::HardBreak => hyperlink.add_run(Run::new().add_break(BreakType::TextWrapping)),
    }
}

fn append_hyperlink_inlines(
    mut hyperlink: Hyperlink,
    inlines: &[Inline],
    format: InlineFormat,
) -> Hyperlink {
    for inline in inlines {
        hyperlink = append_inline_to_hyperlink(hyperlink, inline, format);
    }
    hyperlink
}

fn add_image_to_paragraph(
    paragraph: Paragraph,
    path: &str,
    image: Option<&ImageData>,
) -> Paragraph {
    paragraph.add_run(image_or_fallback_run(path, image))
}

fn image_or_fallback_run(path: &str, image: Option<&ImageData>) -> Run {
    image
        .map(|image| image_run(&image.bytes, image.width, image.height))
        .unwrap_or_else(|| Run::new().add_text(format!("[图片不可用：{path}]")))
}

fn image_run(bytes: &[u8], width: u32, height: u32) -> Run {
    let (width_emu, height_emu) = image_size_emu(width, height);
    Run::new().add_image(Pic::new(bytes).size(width_emu, height_emu))
}

fn image_size_emu(width: u32, height: u32) -> (u32, u32) {
    let width_emu = u64::from(width).saturating_mul(9_525).max(1);
    let height_emu = u64::from(height).saturating_mul(9_525).max(1);
    let largest = width_emu.max(height_emu);
    let scale_numerator = MAX_IMAGE_EMU.min(largest);
    let scaled_width =
        (u128::from(width_emu) * u128::from(scale_numerator) / u128::from(largest)) as u64;
    let scaled_height =
        (u128::from(height_emu) * u128::from(scale_numerator) / u128::from(largest)) as u64;
    (scaled_width as u32, scaled_height as u32)
}

fn formatted_run(value: &str, format: InlineFormat) -> Run {
    let mut run = Run::new().add_text(value);
    if format.bold {
        run = run.bold();
    }
    if format.italic {
        run = run.italic();
    }
    if format.strike {
        run = run.strike();
    }
    if format.code {
        run = run.style("MoraInlineCode");
    }
    run
}

fn code_run(source: &str) -> Run {
    let mut run = Run::new().style("MoraCodeText");
    for (index, line) in source.split('\n').enumerate() {
        if index > 0 {
            run = run.add_break(BreakType::TextWrapping);
        }
        run = run.add_text(line.trim_end_matches('\r'));
    }
    run
}

fn paragraph_style(quote: bool) -> &'static str {
    if quote {
        "MoraQuote"
    } else {
        "MoraBody"
    }
}

fn heading_style(level: u8) -> &'static str {
    match level.clamp(1, 6) {
        1 => "MoraHeading1",
        2 => "MoraHeading2",
        3 => "MoraHeading3",
        4 => "MoraHeading4",
        5 => "MoraHeading5",
        _ => "MoraHeading6",
    }
}

fn table_alignment(alignment: &TableAlignment) -> Option<AlignmentType> {
    match alignment {
        TableAlignment::None => None,
        TableAlignment::Left => Some(AlignmentType::Left),
        TableAlignment::Center => Some(AlignmentType::Center),
        TableAlignment::Right => Some(AlignmentType::Right),
    }
}

fn list_numbering_id(ordered: bool, checked: Option<bool>) -> usize {
    match checked {
        Some(true) => TASK_CHECKED_NUMBERING_ID,
        Some(false) => TASK_UNCHECKED_NUMBERING_ID,
        None if ordered => ORDERED_NUMBERING_ID,
        None => BULLET_NUMBERING_ID,
    }
}

fn add_numbering_definitions(document: Docx) -> Docx {
    document
        .add_abstract_numbering(numbering_definition(1, "bullet", "•"))
        .add_abstract_numbering(ordered_numbering_definition(2))
        .add_abstract_numbering(numbering_definition(3, "bullet", "☑"))
        .add_abstract_numbering(numbering_definition(4, "bullet", "☐"))
        .add_numbering(Numbering::new(BULLET_NUMBERING_ID, 1))
        .add_numbering(Numbering::new(ORDERED_NUMBERING_ID, 2))
        .add_numbering(Numbering::new(TASK_CHECKED_NUMBERING_ID, 3))
        .add_numbering(Numbering::new(TASK_UNCHECKED_NUMBERING_ID, 4))
}

fn numbering_definition(id: usize, format: &str, text: &str) -> AbstractNumbering {
    (0..9).fold(AbstractNumbering::new(id), |numbering, level| {
        numbering.add_level(numbering_level(
            level,
            NumberFormat::new(format),
            LevelText::new(text),
        ))
    })
}

fn ordered_numbering_definition(id: usize) -> AbstractNumbering {
    (0..9).fold(AbstractNumbering::new(id), |numbering, level| {
        let text = (1..=level + 1)
            .map(|part| format!("%{part}"))
            .collect::<Vec<_>>()
            .join(".")
            + ".";
        numbering.add_level(numbering_level(
            level,
            NumberFormat::new("decimal"),
            LevelText::new(text),
        ))
    })
}

fn numbering_level(level: usize, format: NumberFormat, text: LevelText) -> Level {
    Level::new(level, Start::new(1), format, text, LevelJc::new("left")).indent(
        Some(720 + i32::try_from(level).unwrap_or(8) * 360),
        Some(SpecialIndentType::Hanging(360)),
        None,
        None,
    )
}

fn document_styles() -> Vec<Style> {
    let body_fonts = body_fonts();
    let mut styles = vec![
        Style::new("MoraBody", StyleType::Paragraph)
            .name("Mora Body")
            .fonts(body_fonts.clone())
            .size(21),
        Style::new("MoraQuote", StyleType::Paragraph)
            .name("Mora Quote")
            .fonts(body_fonts.clone())
            .size(21)
            .color("4A5568")
            .indent(Some(360), None, None, None),
        Style::new("MoraCode", StyleType::Paragraph)
            .name("Mora Code Block")
            .fonts(code_fonts())
            .size(19)
            .highlight("F5F6F8"),
        Style::new("MoraQuoteCode", StyleType::Paragraph)
            .name("Mora Quote Code Block")
            .fonts(code_fonts())
            .size(19)
            .highlight("F5F6F8")
            .indent(Some(360), None, None, None),
        Style::new("MoraInlineCode", StyleType::Character)
            .name("Mora Inline Code")
            .fonts(code_fonts())
            .size(19)
            .highlight("F5F6F8"),
        Style::new("MoraCodeText", StyleType::Character)
            .name("Mora Code Text")
            .fonts(code_fonts())
            .size(19),
    ];

    for level in 1..=6 {
        styles.push(
            Style::new(format!("MoraHeading{level}"), StyleType::Paragraph)
                .name(format!("Mora Heading {level}"))
                .fonts(body_fonts.clone())
                .size(heading_size(level))
                .bold()
                .outline_lvl(level - 1),
        );
    }

    let mut rule = Style::new("MoraRule", StyleType::Paragraph)
        .name("Mora Horizontal Rule")
        .q_format(false);
    rule.paragraph_property = rule.paragraph_property.set_border(
        ParagraphBorder::new(ParagraphBorderPosition::Bottom)
            .size(6)
            .color("A0AEC0"),
    );
    styles.push(rule);
    styles
}

fn body_fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Arial")
        .hi_ansi("Arial")
        .east_asia("Microsoft YaHei")
        .cs("SimSun")
}

fn code_fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Consolas")
        .hi_ansi("Consolas")
        .east_asia("Microsoft YaHei")
        .cs("SimSun")
}

fn heading_size(level: usize) -> usize {
    match level {
        1 => 36,
        2 => 30,
        3 => 26,
        4 => 24,
        5 => 22,
        _ => 21,
    }
}

#[cfg(test)]
mod tests {
    use super::image_size_emu;

    #[test]
    fn scales_model_image_dimensions_to_the_document_width_without_distortion() {
        assert_eq!(image_size_emu(12_000, 6_000), (5_733_288, 2_866_644));
    }

    #[test]
    fn scales_maximum_model_dimensions_without_overflow() {
        assert_eq!(image_size_emu(u32::MAX, u32::MAX), (5_733_288, 5_733_288));
    }
}
