use std::fs;
use std::io::{Cursor, Write};

use mdxnote_lib::export_markdown_file;
use uuid::Uuid;
use zip::write::FileOptions;
use zip::ZipWriter;

fn write_source(path: &std::path::Path) {
    write_source_content(path, "![图](assets/a.png)");
}

fn write_source_content(path: &std::path::Path, content: &str) {
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let entries: [(&str, &[u8]); 4] = [
        (
            "manifest.json",
            br#"{"format":"MDXNote","formatVersion":"1.0.0","packageType":"single-note","contentFile":"content.md","metadataFile":"meta.json","assetsDir":"assets/","attachmentsDir":"attachments/","thumbnailsDir":"thumbnails/","encoding":"utf-8","encrypted":false,"compression":"zip"}"#,
        ),
        (
            "meta.json",
            br#"{"id":"note","title":"Test","createdAt":"2026-07-20T00:00:00Z","updatedAt":"2026-07-20T00:00:00Z"}"#,
        ),
        ("content.md", content.as_bytes()),
        ("assets/a.png", b"image"),
    ];
    for (name, bytes) in entries {
        writer.start_file(name, FileOptions::default()).unwrap();
        writer.write_all(bytes).unwrap();
    }
    fs::write(path, writer.finish().unwrap().into_inner()).unwrap();
}

#[test]
fn export_rewrites_only_real_resource_destinations() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mdx");
    let destination = dir.path().join("export.md");
    let content = "说明 assets/a.png\n\n`![示例](assets/a.png)`\n\n```md\n![示例](assets/a.png)\n```\n\n![远程](https://example.com/assets/a.png)\n\n![图](assets/a.png \"标题\")\n\n[附件](<attachments/a b.pdf>)\n\n![引用][photo]\n\n[photo]: assets/a.png\n\n<img src=\"assets/a.png\">";
    write_source_content(&source, content);
    export_markdown_file(&source, &destination).unwrap();
    let exported = fs::read_to_string(destination).unwrap();
    assert!(exported.contains("说明 assets/a.png"));
    assert!(exported.contains("`![示例](assets/a.png)`"));
    assert!(exported.contains("```md\n![示例](assets/a.png)\n```"));
    assert!(exported.contains("https://example.com/assets/a.png"));
    assert!(exported.contains("![图](export_files/assets/a.png \"标题\")"));
    assert!(exported.contains("[附件](<export_files/attachments/a b.pdf>)"));
    assert!(exported.contains("[photo]: export_files/assets/a.png"));
    assert!(exported.contains("<img src=\"export_files/assets/a.png\">"));
}

#[test]
fn exported_resource_urls_escape_the_destination_folder_name() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mdx");
    let destination = dir.path().join("my notes #1.md");
    write_source(&source);
    export_markdown_file(&source, &destination).unwrap();
    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "![图](my%20notes%20%231_files/assets/a.png)"
    );
    assert!(dir.path().join("my notes #1_files/assets/a.png").is_file());
}

#[test]
fn export_preserves_html_comments_attributes_and_raw_text() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mdx");
    let destination = dir.path().join("export.md");
    let content = "<!--\n<img src='assets/a.png'>\n-->\n\n<script>const sample = '<img src=\"assets/a.png\">';</script>\n\n<img title=\"src='assets/a.png'\" data-src=\"assets/a.png\" SRC = 'assets/a.png'>\n\n<a href=attachments/a.pdf>附件</a>";
    write_source_content(&source, content);
    export_markdown_file(&source, &destination).unwrap();

    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "<!--\n<img src='assets/a.png'>\n-->\n\n<script>const sample = '<img src=\"assets/a.png\">';</script>\n\n<img title=\"src='assets/a.png'\" data-src=\"assets/a.png\" SRC = 'export_files/assets/a.png'>\n\n<a href=export_files/attachments/a.pdf>附件</a>",
    );
}

#[test]
fn export_preserves_nested_labels_escaped_urls_and_reference_formatting() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mdx");
    let destination = dir.path().join("export.md");
    let content = "[![inner](assets/a.png)](attachments/a.pdf \"assets/a.png\")\n\n[code `](assets/fake)`](assets/a\\(1\\).png)\n\n> [photo\\]: label]:\n>   <assets/a.png> \"title\"\n>\n> ![image][photo\\]: label]";
    write_source_content(&source, content);
    export_markdown_file(&source, &destination).unwrap();

    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "[![inner](export_files/assets/a.png)](export_files/attachments/a.pdf \"assets/a.png\")\n\n[code `](assets/fake)`](export_files/assets/a\\(1\\).png)\n\n> [photo\\]: label]:\n>   <export_files/assets/a.png> \"title\"\n>\n> ![image][photo\\]: label]",
    );
}

#[test]
fn exports_markdown_and_resources() {
    let dir = std::env::temp_dir().join(format!("mora-export-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.mdx");
    let destination = dir.join("export.md");
    write_source(&source);

    export_markdown_file(&source, &destination).unwrap();

    let markdown = fs::read_to_string(&destination).unwrap();
    assert_eq!(markdown, "![图](export_files/assets/a.png)");
    assert_eq!(
        fs::read(dir.join("export_files/assets/a.png")).unwrap(),
        b"image"
    );
    fs::remove_dir_all(dir).unwrap();
}
