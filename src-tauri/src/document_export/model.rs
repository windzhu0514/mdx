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
    pub title: String,
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
        image: Option<ImageData>,
    },
    Mermaid {
        source: String,
        image: Option<MermaidImage>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageData {
    pub path: String,
    pub original_name: String,
    pub mime_type: String,
    pub kind: String,
    pub declared_size: u64,
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MermaidImage {
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
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
    Image {
        alt: String,
        path: String,
        image: Option<ImageData>,
    },
    HardBreak,
}
