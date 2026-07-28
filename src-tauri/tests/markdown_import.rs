use mdxnote_lib::markdown_import::parse_markdown;
use std::path::Path;

#[test]
fn markdown_without_front_matter_uses_file_stem_as_title() {
    let imported = parse_markdown(Path::new("旅行计划.md"), "# 北京\n\n正文").unwrap();

    assert_eq!(imported.title, "旅行计划");
    assert_eq!(imported.content, "# 北京\n\n正文");
    assert!(imported.front_matter.is_none());
}

#[test]
fn markdown_front_matter_is_typed_and_unknown_fields_are_preserved() {
    let raw = r#"---
title: "同步测试"
date: 2026-07-22
tags:
  - Mora
  - Markdown
draft: true
author: "测试作者"
summary: "测试摘要"
customField: "保留值"
---

# 正文
"#;

    let imported = parse_markdown(Path::new("fallback.md"), raw).unwrap();
    let front_matter = imported.front_matter.unwrap();

    assert_eq!(imported.title, "同步测试");
    assert_eq!(imported.content, "# 正文\n");
    assert_eq!(front_matter.date, "2026-07-22");
    assert_eq!(front_matter.tags, vec!["Mora", "Markdown"]);
    assert!(front_matter.draft);
    assert_eq!(front_matter.author, "测试作者");
    assert_eq!(front_matter.summary, "测试摘要");
    assert_eq!(front_matter.extra["customField"], "保留值");
}
