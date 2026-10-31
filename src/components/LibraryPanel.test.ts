// @vitest-environment jsdom
import { it, expect } from "vitest";
import { createApp, h } from "vue";
import LibraryPanel from "./LibraryPanel.vue";
it("未搜索时笔记列表显示摘要而非整篇正文", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
        render: () =>
            h(LibraryPanel, {
                open: true,
                query: "",
                loading: false,
                results: [],
                notes: [
                    {
                        path: "a.md",
                        title: "A",
                        tags: [],
                        summary: "简短摘要",
                        content: "长篇正文".repeat(100),
                        updatedAt: "",
                    },
                ],
            }),
    });
    app.mount(host);
    try {
        expect(host.querySelector(".result-snippet")?.textContent?.trim()).toBe(
            "简短摘要",
        );
    } finally {
        app.unmount();
        host.remove();
    }
});
