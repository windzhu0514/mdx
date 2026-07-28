use std::fs;

use mdxnote_lib::{import_resource_file, infer_mime_type, resource_path_for};
use uuid::Uuid;

#[test]
fn infers_common_mime_types() {
    assert_eq!(infer_mime_type("photo.png"), "image/png");
    assert_eq!(infer_mime_type("report.pdf"), "application/pdf");
    assert_eq!(infer_mime_type("unknown.bin"), "application/octet-stream");
}

#[test]
fn creates_safe_resource_paths() {
    let image = resource_path_for("photo.png", true);
    let attachment = resource_path_for("report.pdf", false);
    assert!(image.starts_with("assets/image-"));
    assert!(image.ends_with(".png"));
    assert!(attachment.starts_with("attachments/file-"));
    assert!(attachment.ends_with(".pdf"));
}

#[test]
fn imports_a_file_as_resource_data() {
    let dir = std::env::temp_dir().join(format!("mora-import-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("报告.pdf");
    fs::write(&path, b"pdf-data").unwrap();

    let resource = import_resource_file(&path).unwrap();
    assert_eq!(resource.original_name, "报告.pdf");
    assert_eq!(resource.mime_type, "application/pdf");
    assert_eq!(resource.size, 8);
    assert_eq!(resource.kind, "attachment");
    assert!(resource.name.starts_with("attachments/file-"));

    fs::remove_dir_all(dir).unwrap();
}
