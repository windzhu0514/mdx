import type { MdxMetadata } from "../types/mdx";

export function createEmptyMetadata(title = "无标题笔记"): MdxMetadata {
    const now = new Date().toISOString();

    return {
        id: crypto.randomUUID(),
        title,
        summary: "",
        author: "",
        createdAt: now,
        updatedAt: now,
        tags: [],
        category: "",
        favorite: false,
        archived: false,
        cover: "",
        wordCount: 0,
        assets: [],
        attachments: [],
    };
}
