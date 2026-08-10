#[path = "../src/document_export/mod.rs"]
#[allow(dead_code)]
mod document_export;

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
            size: 8,
            kind: "asset".to_string(),
            base64: "iVBORw0KGgo=".to_string(),
        }],
        mermaid_diagrams: vec![ExportMermaidDiagram {
            source: "flowchart TD\nA-->B".to_string(),
            png_base64: "iVBORw0KGgo=".to_string(),
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
    assert!(model
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Image { path, .. } if path == "assets/a.png")));
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
            png_base64: "iVBORw0KGgpB".to_string(),
        },
        ExportMermaidDiagram {
            source: diagram_source.to_string(),
            png_base64: "iVBORw0KGgpC".to_string(),
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
        matches!(block, Block::Image { path, bytes: None, .. } if path == "assets/missing.png")
    }));
    assert!(model.blocks.iter().any(|block| {
        matches!(block, Block::Paragraph(inlines) if inlines == &vec![Inline::Text("附件：plan.pdf".to_string())])
    }));

    let mermaid_images: Vec<&Vec<u8>> = model
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
    assert_eq!(
        mermaid_images,
        vec![
            &b"\x89PNG\r\n\x1a\nA".to_vec(),
            &b"\x89PNG\r\n\x1a\nB".to_vec()
        ]
    );
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
