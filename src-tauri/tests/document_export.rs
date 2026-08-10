#[path = "../src/document_export/mod.rs"]
#[allow(dead_code)]
mod document_export;

use base64::{engine::general_purpose, Engine as _};
use document_export::{
    parse_document, Block, ExportDocumentRequest, ExportFormat, ExportMermaidDiagram,
    ExportResource, Inline, ListItem,
};

fn fixture_request(markdown: &str) -> ExportDocumentRequest {
    ExportDocumentRequest {
        destination_path: "C:\\exports\\note.docx".to_string(),
        title: "标题".to_string(),
        markdown: markdown.to_string(),
        resources: vec![ExportResource {
            name: "assets/a.png".to_string(),
            original_name: "a.png".to_string(),
            mime_type: "image/png".to_string(),
            size: png_bytes(2, 3).len() as u64,
            kind: "asset".to_string(),
            base64: png_base64(2, 3),
        }],
        mermaid_diagrams: vec![ExportMermaidDiagram {
            source: "flowchart TD\nA-->B".to_string(),
            png_base64: png_base64(4, 5),
        }],
        format: ExportFormat::Docx,
    }
}

#[test]
fn parses_supported_markdown_into_one_shared_model() {
    let request = fixture_request(
        "# 标题\n\n**粗体**与[链接](https://example.com)\n\n- [x] **完成**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![图](assets/a.png)\n\n```mermaid\nflowchart TD\nA-->B\n```",
    );

    let model = parse_document(&request).unwrap();

    assert!(matches!(model.blocks[0], Block::Heading { level: 1, .. }));
    assert!(model
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Table { .. })));
    let task_item_blocks = model
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::List { items, .. } => Some(&items[0].blocks),
            _ => None,
        })
        .expect("任务列表应保留列表项");
    assert!(matches!(
        task_item_blocks.first(),
        Some(Block::Paragraph(inlines)) if matches!(inlines.as_slice(), [Inline::Strong(_)])
    ));
    assert!(model.blocks.iter().any(
        |block| matches!(block, Block::Image { path, image: Some(_), .. } if path == "assets/a.png")
    ));
    assert!(model
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Mermaid { image: Some(_), .. })));
}

#[test]
fn parses_edge_cases_into_readable_export_blocks() {
    let diagram_source = "flowchart TD\nA-->B";
    let mut request = fixture_request(&format!(
        "> 引用\n>\n> 1. 外层\n>    - [ ] 内层\n\n第一行\\\n第二行 [附件](attachments/report.pdf)\n\n![缺图](assets/missing.png)\n\n![附件图片](attachments/plan.pdf)\n\n```mermaid\n{diagram_source}\n```\n\n```mermaid\n{diagram_source}\n```\n\n```mermaid\n未渲染\n```"
    ));
    request.mermaid_diagrams = vec![
        ExportMermaidDiagram {
            source: diagram_source.to_string(),
            png_base64: png_base64(6, 7),
        },
        ExportMermaidDiagram {
            source: diagram_source.to_string(),
            png_base64: png_base64(8, 9),
        },
    ];

    let model = parse_document(&request).unwrap();

    assert!(matches!(model.blocks[0], Block::Quote(_)));
    let Block::Quote(quote_blocks) = &model.blocks[0] else {
        unreachable!();
    };
    let items = quote_blocks
        .iter()
        .find_map(|block| match block {
            Block::List { items, .. } => Some(items),
            _ => None,
        })
        .expect("引用内容应保留嵌套列表");
    assert_nested_task_item(items);
    assert!(model.blocks.iter().any(|block| {
        matches!(block, Block::Paragraph(inlines) if inlines.contains(&Inline::HardBreak)
            && inlines.contains(&Inline::Text("附件：report.pdf".to_string())))
    }));
    assert!(model.blocks.iter().any(|block| {
        matches!(block, Block::Image { path, image: None, .. } if path == "assets/missing.png")
    }));
    assert!(model.blocks.iter().any(|block| {
        matches!(block, Block::Paragraph(inlines) if inlines == &vec![Inline::Text("附件：plan.pdf".to_string())])
    }));

    let mermaid_images: Vec<_> = model
        .blocks
        .iter()
        .filter_map(|block| match block {
            Block::Mermaid {
                source,
                image: Some(image),
            } if source == diagram_source => Some(image),
            _ => None,
        })
        .collect();
    assert_eq!(mermaid_images.len(), 2);
    assert_eq!(mermaid_images[0].bytes, png_bytes(6, 7));
    assert_eq!(mermaid_images[1].bytes, png_bytes(8, 9));
    assert_eq!((mermaid_images[0].width, mermaid_images[0].height), (6, 7));
    assert_eq!((mermaid_images[1].width, mermaid_images[1].height), (8, 9));
    assert!(model.blocks.iter().any(|block| {
        matches!(block, Block::Code { language, source } if language == "mermaid" && source == "未渲染")
    }));
}

#[test]
fn rejects_invalid_resource_base64_with_a_stable_error() {
    let mut request = fixture_request("![图](assets/a.png)");
    request.resources[0].base64 = "not base64".to_string();

    let error = parse_document(&request).unwrap_err();

    assert!(error.starts_with("资源「assets/a.png」的 Base64 数据无效："));
}

#[test]
fn preserves_asset_images_in_every_inline_context() {
    let request = fixture_request(
        "前缀 ![段落图](assets/a.png) 后缀\n\n- ![列表图](assets/a.png)\n\n| 单元格 |\n|---|\n| ![表格图](assets/a.png) |\n\n[![链接图](assets/a.png)](https://example.com)",
    );

    let model = parse_document(&request).unwrap();

    let Block::Paragraph(paragraph) = &model.blocks[0] else {
        panic!("应保留文字相邻图片所在段落");
    };
    assert_inline_image(&paragraph[1], "段落图");

    let list_image = model
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::List { items, .. } => match &items[0].blocks[0] {
                Block::Paragraph(inlines) => inlines.first(),
                _ => None,
            },
            _ => None,
        })
        .expect("紧凑列表项应保留图片");
    assert_inline_image(list_image, "列表图");

    let table_image = model
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::Table { rows, .. } => rows[1].cells[0].first(),
            _ => None,
        })
        .expect("表格单元格应保留图片");
    assert_inline_image(table_image, "表格图");

    let Block::Paragraph(link_paragraph) = model.blocks.last().expect("应保留链接图片段落")
    else {
        panic!("链接图片应在段落中");
    };
    let Inline::Link { label, destination } = &link_paragraph[0] else {
        panic!("图片链接应保留链接容器");
    };
    assert_eq!(destination, "https://example.com");
    assert_inline_image(&label[0], "链接图");
}

#[test]
fn validates_asset_image_resource_metadata_and_payload() {
    let markdown = "![图](assets/a.png)";

    let mut non_image_mime = fixture_request(markdown);
    non_image_mime.resources[0].mime_type = "text/plain".to_string();
    assert_resource_error(non_image_mime, "MIME");

    let mut attachment_kind = fixture_request(markdown);
    attachment_kind.resources[0].kind = "attachment".to_string();
    assert_resource_error(attachment_kind, "图片资产");

    let mut mismatched_format = fixture_request(markdown);
    mismatched_format.resources[0].mime_type = "image/jpeg".to_string();
    assert_resource_error(mismatched_format, "实际图片格式");

    let mut damaged_png = fixture_request(markdown);
    damaged_png.resources[0].base64 = general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");
    damaged_png.resources[0].size = 8;
    assert_resource_error(damaged_png, "图片数据损坏");

    let mut wrong_size = fixture_request(markdown);
    wrong_size.resources[0].size += 1;
    assert_resource_error(wrong_size, "声明大小");
}

#[test]
fn falls_back_when_mermaid_png_is_invalid() {
    let mut request = fixture_request("```mermaid\nflowchart TD\nA-->B\n```");
    request.mermaid_diagrams[0].png_base64 = general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n");

    let model = parse_document(&request).unwrap();

    assert!(matches!(
        model.blocks.as_slice(),
        [Block::Code { language, source }] if language == "mermaid" && source == "flowchart TD\nA-->B"
    ));
}

fn assert_nested_task_item(items: &[ListItem]) {
    let nested = items[0]
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::List { items, .. } => Some(items),
            _ => None,
        })
        .expect("外层列表项应包含嵌套列表");
    assert_eq!(nested[0].checked, Some(false));
}

fn assert_inline_image(inline: &Inline, expected_alt: &str) {
    let Inline::Image {
        alt,
        path,
        image: Some(image),
    } = inline
    else {
        panic!("应保留有图片数据的行内图片");
    };
    assert_eq!(alt, expected_alt);
    assert_eq!(path, "assets/a.png");
    assert_eq!(image.path, "assets/a.png");
    assert_eq!(image.original_name, "a.png");
    assert_eq!(image.mime_type, "image/png");
    assert_eq!(image.kind, "asset");
    assert_eq!(image.declared_size, image.bytes.len() as u64);
    assert_eq!((image.width, image.height), (2, 3));
}

fn assert_resource_error(request: ExportDocumentRequest, expected: &str) {
    let error = parse_document(&request).unwrap_err();
    assert!(error.contains("assets/a.png"));
    assert!(error.contains(expected), "实际错误：{error}");
}

fn png_base64(width: u32, height: u32) -> String {
    general_purpose::STANDARD.encode(png_bytes(width, height))
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes
}
