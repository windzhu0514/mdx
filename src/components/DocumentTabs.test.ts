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

function documentItem(
    id: string,
    dirty = false,
    state: Partial<Pick<OpenDocument, "conflict" | "unavailable">> = {},
): OpenDocument {
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
        conflict: state.conflict ?? false,
        unavailable: state.unavailable ?? false,
    };
}

function mountTabs(
    activeDocumentId = "b",
    documents = [documentItem("a", true), documentItem("b")],
) {
    const emitted = new Map<string, string[]>();
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(DocumentTabs, {
                documents,
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

    it("renders conflict and unavailable states visibly and in accessible names", () => {
        const { host } = mountTabs("b", [
            documentItem("a", false, { conflict: true }),
            documentItem("b", false, { unavailable: true }),
        ]);
        const conflictTab = host.querySelector<HTMLElement>('[aria-label^="切换到 a"]');
        const unavailableTab = host.querySelector<HTMLElement>(
            '[aria-label^="切换到 b"]',
        );

        expect(conflictTab?.textContent).toContain("冲突");
        expect(conflictTab?.getAttribute("aria-label")).toContain("外部更改冲突");
        expect(unavailableTab?.textContent).toContain("不可用");
        expect(unavailableTab?.getAttribute("aria-label")).toContain("路径不可用");
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

    it("keeps close buttons out of the sequential tab order", () => {
        const { host } = mountTabs();
        const closeButtons =
            host.querySelectorAll<HTMLButtonElement>(".document-tab-close");

        expect(Array.from(closeButtons).map((button) => button.tabIndex)).toEqual([
            -1, -1,
        ]);
    });

    it("emits close from Delete on the focused tab", async () => {
        const { host, emitted } = mountTabs();
        host.querySelector<HTMLButtonElement>('[aria-label^="切换到 b"]')?.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }),
        );
        await nextTick();

        expect(emitted.get("close")).toEqual(["b"]);
    });
});
