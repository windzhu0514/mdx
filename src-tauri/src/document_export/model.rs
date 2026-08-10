use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocumentRequest {
    pub destination_path: String,
    pub title: String,
    pub markdown: String,
    #[serde(default)]
    pub resources: Vec<ExportResource>,
    #[serde(default)]
    pub mermaid_diagrams: Vec<ExportMermaidDiagram>,
    pub format: ExportFormat,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Docx,
    Pdf,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResource {
    pub name: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
    pub base64: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportMermaidDiagram {
    pub source: String,
    pub png_base64: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentModel {
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading {
        level: u8,
        content: Vec<Inline>,
    },
    Quote(Vec<Block>),
    List {
        start: Option<u64>,
        items: Vec<ListItem>,
    },
    Code {
        language: String,
        source: String,
    },
    Table {
        alignments: Vec<TableAlignment>,
        rows: Vec<TableRow>,
    },
    Image {
        alt: String,
        path: String,
        bytes: Option<Vec<u8>>,
    },
    Mermaid {
        source: String,
        image: Option<Vec<u8>>,
    },
    Rule,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListItem {
    pub checked: Option<bool>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TableAlignment {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TableRow {
    pub is_header: bool,
    pub cells: Vec<Vec<Inline>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String),
    Emphasis(Vec<Inline>),
    Strong(Vec<Inline>),
    Strike(Vec<Inline>),
    Code(String),
    Link {
        label: Vec<Inline>,
        destination: String,
    },
    HardBreak,
}
