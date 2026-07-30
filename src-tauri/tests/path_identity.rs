use mdxnote_lib::{normalize_path, path_identity};
use std::path::Path;

#[test]
fn normalizes_dot_segments_to_an_absolute_path() {
    let normalized = normalize_path(Path::new("./notes/../notes/a.mdx")).unwrap();

    assert!(normalized.ends_with("notes\\a.mdx") || normalized.ends_with("notes/a.mdx"));
}

#[test]
#[cfg(windows)]
fn windows_identity_is_case_insensitive() {
    assert_eq!(
        path_identity(Path::new(r"C:\Notes\A.mdx")).unwrap(),
        path_identity(Path::new(r"c:\notes\a.mdx")).unwrap()
    );
}
