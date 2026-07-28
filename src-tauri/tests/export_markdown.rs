use std::fs;
use std::io::{Cursor, Write};

use mdxnote_lib::export_markdown_file;
use uuid::Uuid;
use zip::write::FileOptions;
use zip::ZipWriter;

fn write_source(path: &std::path::Path) {
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
        ("content.md", "![图](assets/a.png)".as_bytes()),
        ("assets/a.png", b"image"),
    ];
    for (name, bytes) in entries {
        writer.start_file(name, FileOptions::default()).unwrap();
        writer.write_all(bytes).unwrap();
    }
    fs::write(path, writer.finish().unwrap().into_inner()).unwrap();
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
