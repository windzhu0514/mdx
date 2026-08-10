mod model;

pub use model::{
    Block, DocumentModel, ExportDocumentRequest, ExportFormat, ExportMermaidDiagram,
    ExportResource, ImageData, ImageFormat, Inline, ListItem, MermaidImage, TableAlignment,
    TableRow,
};

use base64::{engine::general_purpose, Engine as _};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{HashMap, VecDeque};

enum BlockFrame {
    Paragraph {
        inlines: Vec<Inline>,
    },
    Heading {
        level: u8,
        inlines: Vec<Inline>,
    },
    Quote {
        blocks: Vec<Block>,
    },
    List {
        start: Option<u64>,
        items: Vec<ListItem>,
    },
    ListItem {
        checked: Option<bool>,
        blocks: Vec<Block>,
    },
    Code {
        language: String,
        source: String,
    },
    Table {
        alignments: Vec<TableAlignment>,
        rows: Vec<TableRow>,
        in_header: bool,
    },
    TableRow {
        is_header: bool,
        cells: Vec<Vec<Inline>>,
    },
    TableCell {
        inlines: Vec<Inline>,
    },
    Image {
        destination: String,
        alt: Vec<Inline>,
    },
}

enum InlineFrame {
    Emphasis(Vec<Inline>),
    Strong(Vec<Inline>),
    Strike(Vec<Inline>),
    Link {
        destination: String,
        label: Vec<Inline>,
    },
}

#[derive(Clone)]
struct DecodedResource {
    original_name: String,
    mime_type: String,
    size: u64,
    kind: String,
    bytes: Vec<u8>,
}

pub fn parse_document(request: &ExportDocumentRequest) -> Result<DocumentModel, String> {
    let resources = decode_resources(&request.resources)?;
    let mut mermaid_images = mermaid_images(&request.mermaid_diagrams);
    let mut blocks = Vec::new();
    let mut block_stack = Vec::new();
    let mut inline_stack = Vec::new();
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;

    for event in Parser::new_ext(&request.markdown, options) {
        match event {
            Event::Start(tag) => start_tag(tag, &mut block_stack, &mut inline_stack)?,
            Event::End(tag) => end_tag(
                tag,
                &mut blocks,
                &mut block_stack,
                &mut inline_stack,
                &resources,
                &mut mermaid_images,
            )?,
            Event::Text(text) => push_inline_or_code(
                Inline::Text(text.into_string()),
                &mut block_stack,
                &mut inline_stack,
            )?,
            Event::Code(code) => push_inline_or_code(
                Inline::Code(code.into_string()),
                &mut block_stack,
                &mut inline_stack,
            )?,
            Event::SoftBreak => push_inline_or_code(
                Inline::Text(" ".to_string()),
                &mut block_stack,
                &mut inline_stack,
            )?,
            Event::HardBreak => {
                push_inline_or_code(Inline::HardBreak, &mut block_stack, &mut inline_stack)?
            }
            Event::Rule => push_block(Block::Rule, &mut blocks, &mut block_stack)?,
            Event::TaskListMarker(checked) => set_task_checked(checked, &mut block_stack)?,
            _ => {}
        }
    }

    if !block_stack.is_empty() || !inline_stack.is_empty() {
        return Err("Markdown 结构未正常结束。".to_string());
    }

    Ok(DocumentModel { blocks })
}

fn start_tag(
    tag: Tag<'_>,
    block_stack: &mut Vec<BlockFrame>,
    inline_stack: &mut Vec<InlineFrame>,
) -> Result<(), String> {
    match tag {
        Tag::Paragraph => block_stack.push(BlockFrame::Paragraph {
            inlines: Vec::new(),
        }),
        Tag::Heading { level, .. } => block_stack.push(BlockFrame::Heading {
            level: heading_level(level),
            inlines: Vec::new(),
        }),
        Tag::BlockQuote(_) => block_stack.push(BlockFrame::Quote { blocks: Vec::new() }),
        Tag::List(start) => block_stack.push(BlockFrame::List {
            start,
            items: Vec::new(),
        }),
        Tag::Item => block_stack.push(BlockFrame::ListItem {
            checked: None,
            blocks: Vec::new(),
        }),
        Tag::CodeBlock(kind) => block_stack.push(BlockFrame::Code {
            language: code_language(kind),
            source: String::new(),
        }),
        Tag::Table(alignments) => block_stack.push(BlockFrame::Table {
            alignments: alignments.into_iter().map(table_alignment).collect(),
            rows: Vec::new(),
            in_header: false,
        }),
        Tag::TableHead => {
            set_table_header(true, block_stack)?;
            block_stack.push(BlockFrame::TableRow {
                is_header: true,
                cells: Vec::new(),
            });
        }
        Tag::TableRow => {
            let is_header = current_table_header(block_stack)?;
            block_stack.push(BlockFrame::TableRow {
                is_header,
                cells: Vec::new(),
            });
        }
        Tag::TableCell => block_stack.push(BlockFrame::TableCell {
            inlines: Vec::new(),
        }),
        Tag::Emphasis => inline_stack.push(InlineFrame::Emphasis(Vec::new())),
        Tag::Strong => inline_stack.push(InlineFrame::Strong(Vec::new())),
        Tag::Strikethrough => inline_stack.push(InlineFrame::Strike(Vec::new())),
        Tag::Link { dest_url, .. } => inline_stack.push(InlineFrame::Link {
            destination: dest_url.into_string(),
            label: Vec::new(),
        }),
        Tag::Image { dest_url, .. } => block_stack.push(BlockFrame::Image {
            destination: dest_url.into_string(),
            alt: Vec::new(),
        }),
        _ => {}
    }
    Ok(())
}

fn end_tag(
    tag: TagEnd,
    root: &mut Vec<Block>,
    block_stack: &mut Vec<BlockFrame>,
    inline_stack: &mut Vec<InlineFrame>,
    resources: &HashMap<String, DecodedResource>,
    mermaid_images: &mut HashMap<String, VecDeque<Option<MermaidImage>>>,
) -> Result<(), String> {
    match tag {
        TagEnd::Paragraph => {
            let frame = pop_block(block_stack, "段落")?;
            let block = match frame {
                BlockFrame::Paragraph { inlines } => paragraph_block(inlines),
                _ => return Err("Markdown 段落结构不匹配。".to_string()),
            };
            push_block(block, root, block_stack)?;
        }
        TagEnd::Heading(_) => {
            let frame = pop_block(block_stack, "标题")?;
            let BlockFrame::Heading { level, inlines } = frame else {
                return Err("Markdown 标题结构不匹配。".to_string());
            };
            push_block(
                Block::Heading {
                    level,
                    content: inlines,
                },
                root,
                block_stack,
            )?;
        }
        TagEnd::BlockQuote(_) => {
            let frame = pop_block(block_stack, "引用")?;
            let BlockFrame::Quote { blocks } = frame else {
                return Err("Markdown 引用结构不匹配。".to_string());
            };
            push_block(Block::Quote(blocks), root, block_stack)?;
        }
        TagEnd::List(_) => {
            let frame = pop_block(block_stack, "列表")?;
            let BlockFrame::List { start, items } = frame else {
                return Err("Markdown 列表结构不匹配。".to_string());
            };
            push_block(Block::List { start, items }, root, block_stack)?;
        }
        TagEnd::Item => {
            let frame = pop_block(block_stack, "列表项")?;
            let BlockFrame::ListItem { checked, blocks } = frame else {
                return Err("Markdown 列表项结构不匹配。".to_string());
            };
            let Some(BlockFrame::List { items, .. }) = block_stack.last_mut() else {
                return Err("Markdown 列表项缺少列表容器。".to_string());
            };
            items.push(ListItem { checked, blocks });
        }
        TagEnd::CodeBlock => {
            let frame = pop_block(block_stack, "代码块")?;
            let BlockFrame::Code { language, source } = frame else {
                return Err("Markdown 代码块结构不匹配。".to_string());
            };
            let block = if language.eq_ignore_ascii_case("mermaid") {
                let source = trim_code_fence_newline(&source).to_string();
                match mermaid_images
                    .get_mut(&source)
                    .and_then(VecDeque::pop_front)
                {
                    Some(Some(image)) => Block::Mermaid {
                        source,
                        image: Some(image),
                    },
                    _ => Block::Code { language, source },
                }
            } else {
                Block::Code { language, source }
            };
            push_block(block, root, block_stack)?;
        }
        TagEnd::Table => {
            let frame = pop_block(block_stack, "表格")?;
            let BlockFrame::Table {
                alignments, rows, ..
            } = frame
            else {
                return Err("Markdown 表格结构不匹配。".to_string());
            };
            push_block(Block::Table { alignments, rows }, root, block_stack)?;
        }
        TagEnd::TableHead => {
            let frame = pop_block(block_stack, "表头")?;
            let BlockFrame::TableRow { is_header, cells } = frame else {
                return Err("Markdown 表头结构不匹配。".to_string());
            };
            let Some(BlockFrame::Table { rows, .. }) = block_stack.last_mut() else {
                return Err("Markdown 表头缺少表格容器。".to_string());
            };
            rows.push(TableRow { is_header, cells });
            set_table_header(false, block_stack)?;
        }
        TagEnd::TableRow => {
            let frame = pop_block(block_stack, "表格行")?;
            let BlockFrame::TableRow { is_header, cells } = frame else {
                return Err("Markdown 表格行结构不匹配。".to_string());
            };
            let Some(BlockFrame::Table { rows, .. }) = block_stack.last_mut() else {
                return Err("Markdown 表格行缺少表格容器。".to_string());
            };
            rows.push(TableRow { is_header, cells });
        }
        TagEnd::TableCell => {
            let frame = pop_block(block_stack, "表格单元格")?;
            let BlockFrame::TableCell { inlines } = frame else {
                return Err("Markdown 表格单元格结构不匹配。".to_string());
            };
            let Some(BlockFrame::TableRow { cells, .. }) = block_stack.last_mut() else {
                return Err("Markdown 表格单元格缺少表格行。".to_string());
            };
            cells.push(inlines);
        }
        TagEnd::Image => finish_image(block_stack, inline_stack, resources)?,
        TagEnd::Emphasis => finish_inline(inline_stack, InlineKind::Emphasis, block_stack)?,
        TagEnd::Strong => finish_inline(inline_stack, InlineKind::Strong, block_stack)?,
        TagEnd::Strikethrough => finish_inline(inline_stack, InlineKind::Strike, block_stack)?,
        TagEnd::Link => finish_inline(inline_stack, InlineKind::Link, block_stack)?,
        _ => {}
    }
    Ok(())
}

fn decode_resources(
    resources: &[ExportResource],
) -> Result<HashMap<String, DecodedResource>, String> {
    resources
        .iter()
        .map(|resource| {
            general_purpose::STANDARD
                .decode(&resource.base64)
                .map(|bytes| {
                    (
                        resource.name.clone(),
                        DecodedResource {
                            original_name: resource.original_name.clone(),
                            mime_type: resource.mime_type.clone(),
                            size: resource.size,
                            kind: resource.kind.clone(),
                            bytes,
                        },
                    )
                })
                .map_err(|error| format!("资源「{}」的 Base64 数据无效：{error}", resource.name))
        })
        .collect()
}

fn paragraph_block(inlines: Vec<Inline>) -> Block {
    match inlines.as_slice() {
        [Inline::Image { alt, path, image }] => Block::Image {
            alt: alt.clone(),
            path: path.clone(),
            image: image.clone(),
        },
        _ => Block::Paragraph(inlines),
    }
}

fn mermaid_images(
    diagrams: &[ExportMermaidDiagram],
) -> HashMap<String, VecDeque<Option<MermaidImage>>> {
    let mut images = HashMap::new();
    for diagram in diagrams {
        let decoded = general_purpose::STANDARD
            .decode(&diagram.png_base64)
            .ok()
            .and_then(|bytes| {
                png_dimensions(&bytes).map(|(width, height)| MermaidImage {
                    bytes,
                    format: ImageFormat::Png,
                    width,
                    height,
                })
            });
        images
            .entry(diagram.source.clone())
            .or_insert_with(VecDeque::new)
            .push_back(decoded);
    }
    images
}

fn asset_image(
    path: &str,
    resources: &HashMap<String, DecodedResource>,
) -> Result<Option<ImageData>, String> {
    let Some(resource) = resources.get(path) else {
        return Ok(None);
    };

    if resource.kind != "asset" {
        return Err(format!(
            "资源「{path}」不是可导出的图片资产，kind 必须为 asset。"
        ));
    }
    if resource.size != resource.bytes.len() as u64 {
        return Err(format!(
            "资源「{path}」的声明大小与解码后的数据长度不一致。"
        ));
    }

    let expected_format = image_format_for_mime(&resource.mime_type).ok_or_else(|| {
        format!(
            "资源「{path}」的 MIME 类型「{}」不支持图片导出。",
            resource.mime_type
        )
    })?;
    let (format, width, height) = inspect_image(&resource.bytes)
        .ok_or_else(|| format!("资源「{path}」的图片数据损坏或格式不受支持。"))?;
    if format != expected_format {
        return Err(format!("资源「{path}」的 MIME 类型与实际图片格式不一致。"));
    }

    Ok(Some(ImageData {
        path: path.to_string(),
        original_name: resource.original_name.clone(),
        mime_type: resource.mime_type.clone(),
        kind: resource.kind.clone(),
        declared_size: resource.size,
        bytes: resource.bytes.clone(),
        format,
        width,
        height,
    }))
}

fn image_format_for_mime(mime_type: &str) -> Option<ImageFormat> {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/gif" => Some(ImageFormat::Gif),
        _ => None,
    }
}

fn inspect_image(bytes: &[u8]) -> Option<(ImageFormat, u32, u32)> {
    png_dimensions(bytes)
        .map(|(width, height)| (ImageFormat::Png, width, height))
        .or_else(|| {
            jpeg_dimensions(bytes).map(|(width, height)| (ImageFormat::Jpeg, width, height))
        })
        .or_else(|| gif_dimensions(bytes).map(|(width, height)| (ImageFormat::Gif, width, height)))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(PNG_SIGNATURE) {
        return None;
    }
    let mut offset = PNG_SIGNATURE.len();
    let mut dimensions = None;
    let mut saw_idat = false;
    let mut first_chunk = true;

    while offset < bytes.len() {
        let length = read_u32(bytes, offset)? as usize;
        let type_start = offset.checked_add(4)?;
        let data_start = type_start.checked_add(4)?;
        let data_end = data_start.checked_add(length)?;
        let crc_end = data_end.checked_add(4)?;
        if crc_end > bytes.len() {
            return None;
        }

        let chunk_type = bytes.get(type_start..data_start)?;
        let data = bytes.get(data_start..data_end)?;
        let actual_crc = read_u32(bytes, data_end)?;
        if crc32(bytes.get(type_start..data_end)?) != actual_crc {
            return None;
        }

        if first_chunk {
            if chunk_type != b"IHDR" || data.len() != 13 {
                return None;
            }
            let width = read_u32(data, 0)?;
            let height = read_u32(data, 4)?;
            if width == 0 || height == 0 {
                return None;
            }
            dimensions = Some((width, height));
            first_chunk = false;
        } else if chunk_type == b"IHDR" {
            return None;
        }

        if chunk_type == b"IDAT" {
            saw_idat = true;
        }
        if chunk_type == b"IEND" {
            return (data.is_empty() && saw_idat && crc_end == bytes.len()).then_some(dimensions?);
        }
        offset = crc_end;
    }

    None
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0..2] != [0xff, 0xd8] {
        return None;
    }

    let mut offset = 2;
    let mut dimensions = None;
    while offset < bytes.len() {
        if *bytes.get(offset)? != 0xff {
            return None;
        }
        while *bytes.get(offset)? == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if marker == 0xd9 {
            return None;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let segment_length = read_u16(bytes, offset)? as usize;
        let segment_end = offset.checked_add(segment_length)?;
        if segment_length < 2 || segment_end > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if dimensions.is_some() || segment_length < 8 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            let component_count = bytes[offset + 7] as usize;
            if width == 0
                || height == 0
                || component_count == 0
                || segment_length != 8 + component_count.checked_mul(3)?
            {
                return None;
            }
            dimensions = Some((width, height));
        }
        if marker == 0xda {
            let component_count = *bytes.get(offset + 2)? as usize;
            if dimensions.is_none()
                || component_count == 0
                || segment_length != 6 + component_count.checked_mul(2)?
            {
                return None;
            }
            return jpeg_scan_to_eoi(bytes, segment_end).and_then(|()| dimensions);
        }
        offset = segment_end;
    }
    None
}

fn gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 13 || (!bytes.starts_with(b"GIF87a") && !bytes.starts_with(b"GIF89a")) {
        return None;
    }
    let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
    let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
    if width == 0 || height == 0 {
        return None;
    }

    let mut offset: usize = 13;
    let packed = bytes[10];
    if packed & 0x80 != 0 {
        offset = offset.checked_add(gif_color_table_size(packed)?)?;
        if offset > bytes.len() {
            return None;
        }
    }

    let mut saw_image = false;
    while offset < bytes.len() {
        match *bytes.get(offset)? {
            0x3b => return (saw_image && offset + 1 == bytes.len()).then_some((width, height)),
            0x21 => {
                offset = offset.checked_add(2)?;
                offset = gif_sub_blocks(bytes, offset)?;
            }
            0x2c => {
                let descriptor_end = offset.checked_add(10)?;
                if descriptor_end > bytes.len() {
                    return None;
                }
                let image_width =
                    u16::from_le_bytes(bytes[offset + 5..offset + 7].try_into().ok()?);
                let image_height =
                    u16::from_le_bytes(bytes[offset + 7..offset + 9].try_into().ok()?);
                if image_width == 0 || image_height == 0 {
                    return None;
                }
                let image_packed = bytes[offset + 9];
                offset = descriptor_end;
                if image_packed & 0x80 != 0 {
                    offset = offset.checked_add(gif_color_table_size(image_packed)?)?;
                    if offset > bytes.len() {
                        return None;
                    }
                }
                let lzw_min_code_size = *bytes.get(offset)?;
                if !(2..=8).contains(&lzw_min_code_size) {
                    return None;
                }
                offset = gif_sub_blocks(bytes, offset.checked_add(1)?)?;
                saw_image = true;
            }
            _ => return None,
        }
    }
    None
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn jpeg_scan_to_eoi(bytes: &[u8], mut offset: usize) -> Option<()> {
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = *bytes.get(offset.checked_add(1)?)?;
        offset = offset.checked_add(2)?;
        match marker {
            0x00 | 0xd0..=0xd7 => {}
            0xd9 => return (offset == bytes.len()).then_some(()),
            0xff => return None,
            _ => return None,
        }
    }
    None
}

fn gif_color_table_size(packed: u8) -> Option<usize> {
    3usize.checked_mul(1usize.checked_shl(u32::from((packed & 0x07) + 1))?)
}

fn gif_sub_blocks(bytes: &[u8], mut offset: usize) -> Option<usize> {
    loop {
        let size = *bytes.get(offset)? as usize;
        offset = offset.checked_add(1)?;
        if size == 0 {
            return Some(offset);
        }
        offset = offset.checked_add(size)?;
        if offset > bytes.len() {
            return None;
        }
    }
}

fn finish_image(
    block_stack: &mut Vec<BlockFrame>,
    inline_stack: &mut Vec<InlineFrame>,
    resources: &HashMap<String, DecodedResource>,
) -> Result<(), String> {
    let frame = pop_block(block_stack, "图片")?;
    let BlockFrame::Image { destination, alt } = frame else {
        return Err("Markdown 图片结构不匹配。".to_string());
    };

    if destination.starts_with("attachments/") {
        return push_inline_or_code(
            Inline::Text(attachment_reference(&destination)),
            block_stack,
            inline_stack,
        );
    }

    let alt = inline_text(&alt);
    let image = if destination.starts_with("assets/") {
        asset_image(&destination, resources)?
    } else {
        None
    };
    let inline_image = Inline::Image {
        alt: alt.clone(),
        path: destination.clone(),
        image: image.clone(),
    };

    push_inline_or_code(inline_image, block_stack, inline_stack)
}

enum InlineKind {
    Emphasis,
    Strong,
    Strike,
    Link,
}

fn finish_inline(
    inline_stack: &mut Vec<InlineFrame>,
    expected: InlineKind,
    block_stack: &mut Vec<BlockFrame>,
) -> Result<(), String> {
    let frame = inline_stack
        .pop()
        .ok_or_else(|| "Markdown 行内结构未开始。".to_string())?;
    let inline = match (expected, frame) {
        (InlineKind::Emphasis, InlineFrame::Emphasis(content)) => Inline::Emphasis(content),
        (InlineKind::Strong, InlineFrame::Strong(content)) => Inline::Strong(content),
        (InlineKind::Strike, InlineFrame::Strike(content)) => Inline::Strike(content),
        (InlineKind::Link, InlineFrame::Link { destination, label }) => {
            if destination.starts_with("attachments/") {
                Inline::Text(attachment_reference(&destination))
            } else {
                Inline::Link { label, destination }
            }
        }
        _ => return Err("Markdown 行内结构不匹配。".to_string()),
    };
    push_inline_or_code(inline, block_stack, inline_stack)
}

fn push_inline_or_code(
    inline: Inline,
    block_stack: &mut [BlockFrame],
    inline_stack: &mut [InlineFrame],
) -> Result<(), String> {
    if let (Some(BlockFrame::Code { source, .. }), Inline::Text(text)) =
        (block_stack.last_mut(), &inline)
    {
        source.push_str(text);
        return Ok(());
    }

    if let Some(BlockFrame::Image { alt, .. }) = block_stack.last_mut() {
        alt.push(inline);
        return Ok(());
    }

    if let Some(frame) = inline_stack.last_mut() {
        match frame {
            InlineFrame::Emphasis(content)
            | InlineFrame::Strong(content)
            | InlineFrame::Strike(content) => content.push(inline),
            InlineFrame::Link { label, .. } => label.push(inline),
        }
        return Ok(());
    }

    if let Some(BlockFrame::ListItem { blocks, .. }) = block_stack.last_mut() {
        match blocks.last_mut() {
            Some(Block::Paragraph(inlines)) => inlines.push(inline),
            _ => blocks.push(Block::Paragraph(vec![inline])),
        }
        return Ok(());
    }

    let target = block_stack
        .iter_mut()
        .rev()
        .find(|frame| {
            matches!(
                frame,
                BlockFrame::Paragraph { .. }
                    | BlockFrame::Heading { .. }
                    | BlockFrame::TableCell { .. }
                    | BlockFrame::Image { .. }
            )
        })
        .ok_or_else(|| "Markdown 行内内容缺少容器。".to_string())?;
    match target {
        BlockFrame::Paragraph { inlines, .. }
        | BlockFrame::Heading { inlines, .. }
        | BlockFrame::TableCell { inlines } => inlines.push(inline),
        BlockFrame::Image { alt, .. } => alt.push(inline),
        _ => unreachable!(),
    }
    Ok(())
}

fn push_block(
    block: Block,
    root: &mut Vec<Block>,
    block_stack: &mut [BlockFrame],
) -> Result<(), String> {
    if let Some(parent) = block_stack.last_mut() {
        match parent {
            BlockFrame::Quote { blocks } | BlockFrame::ListItem { blocks, .. } => {
                blocks.push(block)
            }
            _ => return Err("Markdown 块结构缺少可容纳的父级。".to_string()),
        }
    } else {
        root.push(block);
    }
    Ok(())
}

fn pop_block(stack: &mut Vec<BlockFrame>, name: &str) -> Result<BlockFrame, String> {
    stack
        .pop()
        .ok_or_else(|| format!("Markdown {name} 结构未开始。"))
}

fn set_task_checked(checked: bool, block_stack: &mut [BlockFrame]) -> Result<(), String> {
    let item = block_stack
        .iter_mut()
        .rev()
        .find_map(|frame| match frame {
            BlockFrame::ListItem { checked, .. } => Some(checked),
            _ => None,
        })
        .ok_or_else(|| "任务列表标记缺少列表项。".to_string())?;
    *item = Some(checked);
    Ok(())
}

fn set_table_header(in_header: bool, block_stack: &mut [BlockFrame]) -> Result<(), String> {
    let table = block_stack
        .iter_mut()
        .rev()
        .find_map(|frame| match frame {
            BlockFrame::Table { in_header, .. } => Some(in_header),
            _ => None,
        })
        .ok_or_else(|| "Markdown 表头缺少表格容器。".to_string())?;
    *table = in_header;
    Ok(())
}

fn current_table_header(block_stack: &[BlockFrame]) -> Result<bool, String> {
    block_stack
        .iter()
        .rev()
        .find_map(|frame| match frame {
            BlockFrame::Table { in_header, .. } => Some(*in_header),
            _ => None,
        })
        .ok_or_else(|| "Markdown 表格行缺少表格容器。".to_string())
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn code_language(kind: CodeBlockKind<'_>) -> String {
    match kind {
        CodeBlockKind::Indented => String::new(),
        CodeBlockKind::Fenced(language) => language.into_string(),
    }
}

fn table_alignment(alignment: Alignment) -> TableAlignment {
    match alignment {
        Alignment::None => TableAlignment::None,
        Alignment::Left => TableAlignment::Left,
        Alignment::Center => TableAlignment::Center,
        Alignment::Right => TableAlignment::Right,
    }
}

fn trim_code_fence_newline(source: &str) -> &str {
    source.trim_end_matches(['\r', '\n'])
}

fn inline_text(inlines: &[Inline]) -> String {
    inlines
        .iter()
        .map(|inline| match inline {
            Inline::Text(value) | Inline::Code(value) => value.clone(),
            Inline::Emphasis(content) | Inline::Strong(content) | Inline::Strike(content) => {
                inline_text(content)
            }
            Inline::Link { label, .. } => inline_text(label),
            Inline::Image { alt, .. } => alt.clone(),
            Inline::HardBreak => " ".to_string(),
        })
        .collect()
}

fn attachment_reference(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    format!("附件：{name}")
}
