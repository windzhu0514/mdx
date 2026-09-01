use mdxnote_lib::file_watch::{DocumentWatchState, EchoSuppressor};
use mdxnote_lib::{disk_revision, path_identity, DiskRevision};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tempfile::tempdir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

fn revision(modified_at_ms: u128, size: u64) -> DiskRevision {
    DiskRevision {
        path: "note.mdx".to_string(),
        modified_at_ms,
        size,
    }
}

fn write_mdx(path: &Path, content: &str) {
    let file = File::create(path).unwrap();
    let mut archive = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    archive.start_file("manifest.json", options).unwrap();
    archive
        .write_all(
            br#"{"format":"MDXNote","formatVersion":"1.0.0","packageType":"single-note","contentFile":"content.md","metadataFile":"meta.json","assetsDir":"assets/","attachmentsDir":"attachments/","thumbnailsDir":"thumbnails/","encoding":"utf-8","encrypted":false,"compression":"zip"}"#,
        )
        .unwrap();
    archive.start_file("meta.json", options).unwrap();
    archive
        .write_all(br#"{"id":"watch-test","title":"Watch test"}"#)
        .unwrap();
    archive.start_file("content.md", options).unwrap();
    archive.write_all(content.as_bytes()).unwrap();
    archive.finish().unwrap();
}

fn atomic_replace(target: &Path, replacement: &Path) {
    let backup = target.with_extension("mdx.test-bak");
    fs::rename(target, &backup).unwrap();
    fs::rename(replacement, target).unwrap();
    fs::remove_file(backup).unwrap();
}

fn receive_target(
    receiver: &mpsc::Receiver<Vec<String>>,
    target: &Path,
) -> Result<Vec<String>, mpsc::RecvTimeoutError> {
    let expected = path_identity(target).unwrap();
    let paths = receiver.recv_timeout(Duration::from_secs(6))?;
    assert!(paths
        .iter()
        .any(|path| path_identity(Path::new(path)).unwrap() == expected));
    Ok(paths)
}

#[test]
fn expected_internal_revision_is_suppressed_once() {
    let mut suppressor = EchoSuppressor::default();
    suppressor.begin(Path::new("note.mdx"));
    suppressor.finish(Path::new("note.mdx"), revision(42, 900));

    assert!(suppressor.should_suppress(Path::new("note.mdx"), &revision(42, 900)));
    assert!(!suppressor.should_suppress(Path::new("note.mdx"), &revision(43, 901)));
}

#[test]
fn a_real_external_revision_next_to_a_save_is_not_suppressed() {
    let mut suppressor = EchoSuppressor::default();
    suppressor.begin(Path::new("note.mdx"));
    suppressor.finish(Path::new("note.mdx"), revision(42, 900));

    assert!(!suppressor.should_suppress(Path::new("note.mdx"), &revision(43, 901)));
    assert!(!suppressor.should_suppress(Path::new("note.mdx"), &revision(42, 900)));
}

#[test]
fn parent_directory_watch_observes_atomic_target_replacement() {
    let root = tempdir().unwrap();
    let target = root.path().join("note.mdx");
    let replacement = root.path().join("note.mdx.tmp");
    write_mdx(&target, "original");
    write_mdx(&replacement, "external replacement");
    let (sender, receiver) = mpsc::channel();
    let watch = DocumentWatchState::with_emitter(move |paths| {
        sender.send(paths).unwrap();
    });
    watch
        .set_paths(vec![target.to_string_lossy().to_string()])
        .unwrap();

    atomic_replace(&target, &replacement);

    receive_target(&receiver, &target).unwrap();
    watch.shutdown_now();
}

#[test]
fn incomplete_zip_is_retried_until_the_atomic_write_stabilizes() {
    let root = tempdir().unwrap();
    let target = root.path().join("note.mdx");
    let incomplete = root.path().join("note.mdx.incomplete");
    let complete = root.path().join("note.mdx.complete");
    write_mdx(&target, "original");
    fs::write(&incomplete, b"incomplete zip").unwrap();
    write_mdx(&complete, "completed archive");
    let (sender, receiver) = mpsc::channel();
    let watch = DocumentWatchState::with_emitter(move |paths| {
        sender.send(paths).unwrap();
    });
    watch
        .set_paths(vec![target.to_string_lossy().to_string()])
        .unwrap();

    atomic_replace(&target, &incomplete);
    thread::sleep(Duration::from_millis(250));
    atomic_replace(&target, &complete);

    receive_target(&receiver, &target).unwrap();
    let revision = disk_revision(&target);
    assert!(revision.available);
    watch.shutdown_now();
}
