/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenDocument } from "../composables/useDocumentSession";
import DocumentTabs from "./DocumentTabs.vue";

let app: App<Element> | null = null;

beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
    });
});

afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

function documentItem(id: string, dirty = false): OpenDocument {
    return {
        id,
        path: `C:\\notes\\${id}.mdx`,
        pathIdentity: `c:\\notes\\${id}.mdx`,
        sourceKind: "mdx",
        importSourcePath: null,
        displayName: id,
        content: `# ${id}`,
        meta: null,
        dirty,
        diskRevision: null,
        conflict: false,
        unavailable: false,
    };
}

function mountTabs(activeDocumentId = "b") {
    const emitted = new Map<string, string[]>();
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(DocumentTabs, {
                documents: [documentItem("a", true), documentItem("b")],
                activeDocumentId,
                onActivate: (id: string) =>
                    emitted.set("activate", [...(emitted.get("activate") ?? []), id]),
                onClose: (id: string) =>
                    emitted.set("close", [...(emitted.get("close") ?? []), id]),
            }),
    });
    app.mount(host);
    return { host, emitted };
}

describe("DocumentTabs", () => {
    it("renders ordinary tabs with active and dirty semantics", () => {
        const { host } = mountTabs();
        const tabs = host.querySelectorAll<HTMLElement>('[role="tab"]');
        expect(tabs).toHaveLength(2);
        expect(tabs[0].getAttribute("aria-label")).toContain("未保存");
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(tabs[1].getAttribute("tabindex")).toBe("0");
    });

    it("emits activate and close without owning document state", async () => {
        const { host, emitted } = mountTabs();
        host.querySelector<HTMLButtonElement>('[aria-label^="切换到 a"]')?.click();
        host.querySelector<HTMLButtonElement>('[aria-label="关闭 b"]')?.click();
        await nextTick();
        expect(emitted.get("activate")).toEqual(["a"]);
        expect(emitted.get("close")).toEqual(["b"]);
    });

    it("uses arrow keys and scrolls the active tab into view", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const { host, emitted } = mountTabs("a");
        host.querySelector<HTMLButtonElement>('[aria-label^="切换到 a"]')?.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
        );
        await nextTick();
        expect(emitted.get("activate")).toEqual(["b"]);
        expect(scrollIntoView).toHaveBeenCalled();
    });
});
