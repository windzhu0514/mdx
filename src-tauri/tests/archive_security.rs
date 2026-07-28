use mdxnote_lib::{
    parse_supported_format_version, validate_archive_entry_name, validate_new_resource_name,
};

#[test]
fn rejects_invalid_manifest_versions() {
    assert!(parse_supported_format_version("not-a-version").is_err());
    assert!(parse_supported_format_version("1.0").is_err());
    assert!(parse_supported_format_version("1.0.0.0").is_err());
    assert!(parse_supported_format_version("2.0.0").is_err());
    assert_eq!(parse_supported_format_version("1.2.3"), Ok((1, 2, 3)));
}

#[test]
fn rejects_parent_absolute_and_windows_zip_paths() {
    assert!(validate_archive_entry_name("../evil.txt").is_err());
    assert!(validate_archive_entry_name("assets/../evil.txt").is_err());
    assert!(validate_archive_entry_name("/evil.txt").is_err());
    assert!(validate_archive_entry_name("C:/evil.txt").is_err());
    assert!(validate_archive_entry_name("assets\\evil.png").is_err());
    assert!(validate_archive_entry_name("assets/ok.png").is_ok());
}

#[test]
fn accepts_only_new_assets_and_attachments() {
    assert!(validate_new_resource_name("content.md").is_err());
    assert!(validate_new_resource_name("history/snapshot.json").is_err());
    assert!(validate_new_resource_name("assets/").is_err());
    assert!(validate_new_resource_name("assets/nested/image.png").is_err());
    assert!(validate_new_resource_name("assets/image.png").is_ok());
    assert!(validate_new_resource_name("attachments/file.pdf").is_ok());
}
