use mdxnote_lib::{trim_history_entries, HistoryArchiveEntry};

#[test]
fn history_rotation_keeps_the_newest_twenty_entries() {
    let entries = (0..25)
        .map(|index| HistoryArchiveEntry {
            name: format!("history/20260720-{:02}.json", index),
            bytes: vec![index as u8],
        })
        .collect();

    let rotated = trim_history_entries(entries, 20);
    assert_eq!(rotated.len(), 20);
    assert_eq!(rotated.first().unwrap().bytes, vec![5]);
    assert_eq!(rotated.last().unwrap().bytes, vec![24]);
}

#[test]
fn history_rotation_does_not_touch_other_entries() {
    let entries = vec![
        HistoryArchiveEntry {
            name: "assets/a.png".to_string(),
            bytes: vec![1],
        },
        HistoryArchiveEntry {
            name: "history/20260720-01.json".to_string(),
            bytes: vec![2],
        },
    ];
    let rotated = trim_history_entries(entries, 20);
    assert_eq!(rotated.len(), 2);
    assert!(rotated.iter().any(|entry| entry.name == "assets/a.png"));
}
