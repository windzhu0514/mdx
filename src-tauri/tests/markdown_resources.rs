use mdxnote_lib::prepare_markdown_resources;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("mora-markdown-resources-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn preserves_remote_and_rewrites_local_markdown_and_html_links() {
    let root = fixture();
    write(&root.join("image.png"), b"png");
    write(&root.join("manual.pdf"), b"pdf");
    let markdown =
        "![图](image.png)\n[手册](manual.pdf)\n![远程](https://x/y.png)\n<img src=\"image.png\">";

    let plan = prepare_markdown_resources(&root.join("note.md"), markdown).unwrap();

    assert!(plan.rewritten_content.contains("assets/image.png"));
    assert!(plan.rewritten_content.contains("attachments/manual.pdf"));
    assert!(plan.rewritten_content.contains("https://x/y.png"));
    assert_eq!(plan.resources.len(), 2);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deduplicates_sources_and_uses_numeric_collision_suffixes() {
    let root = fixture();
    write(&root.join("a/photo.png"), b"a");
    write(&root.join("b/photo.png"), b"b");
    let plan = prepare_markdown_resources(
        &root.join("note.md"),
        "![a](a/photo.png) ![again](a/photo.png) ![b](b/photo.png) ![missing](none.png)",
    )
    .unwrap();

    assert_eq!(
        plan.resources
            .iter()
            .map(|resource| resource.name.as_str())
            .collect::<Vec<_>>(),
        ["assets/photo.png", "assets/photo-2.png"]
    );
    assert_eq!(
        plan.items
            .iter()
            .filter(|item| item.status == "missing")
            .count(),
        1
    );
    assert!(plan.rewritten_content.contains("none.png"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn keeps_explicit_uri_schemes_and_unreadable_references_unchanged() {
    let root = fixture();
    fs::create_dir(root.join("folder")).unwrap();
    let markdown = "[mail](mailto:test@example.com) [anchor](#heading) <a href=\"custom:thing\">x</a> [dir](folder/)";

    let plan = prepare_markdown_resources(&root.join("note.md"), markdown).unwrap();

    assert_eq!(plan.rewritten_content, markdown);
    assert!(plan.items.iter().any(|item| item.status == "unreadable"));

    fs::remove_dir_all(root).unwrap();
}
