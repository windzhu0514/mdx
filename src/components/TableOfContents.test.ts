/** @vitest-environment jsdom */
/* eslint-disable vue/one-component-per-file */

import { createApp, h, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import TableOfContents from "./TableOfContents.vue";

let app: App<Element> | null = null;
afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
});

describe("TableOfContents", () => {
    it("renders a controlled right outline and emits heading selection", () => {
        const selected: string[] = [];
        const host = document.createElement("div");
        document.body.append(host);
        app = createApp({
            render: () =>
                h(TableOfContents, {
                    items: [{ level: 1, text: "标题", id: 0 }],
                    visible: true,
                    compact: true,
                    onSelect: (text: string) => selected.push(text),
                }),
        });
        app.mount(host);
        expect(host.querySelector(".toc-sidebar.is-compact")).not.toBeNull();
        expect(host.querySelector('[aria-label="隐藏目录"]')).toBeNull();
        host.querySelector<HTMLButtonElement>('[title="标题"]')?.click();
        expect(selected).toEqual(["标题"]);
    });

    it("does not render when hidden or empty", () => {
        const host = document.createElement("div");
        document.body.append(host);
        app = createApp({
            render: () =>
                h(TableOfContents, { items: [], visible: true, compact: false }),
        });
        app.mount(host);
        expect(host.querySelector(".toc-sidebar")).toBeNull();
    });
});
