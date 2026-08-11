/** @vitest-environment jsdom */

import { createApp, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MermaidDiagramSnapshot, MermaidViewerRequest } from "./mermaidPreview";
import MermaidViewer from "./MermaidViewer.vue";

const request: MermaidViewerRequest = {
    activeIndex: 0,
    diagrams: [
        {
            label: "流程图",
            source: "flowchart LR\nA --> B",
            svg: '<svg data-diagram="first" viewBox="0 0 800 500"></svg>',
        },
        {
            label: "时序图",
            source: "sequenceDiagram\nA->>B: hello",
            svg: '<svg data-diagram="second" viewBox="0 0 600 400"></svg>',
        },
    ],
};

function mountViewer(initialRequest: MermaidViewerRequest | null = request) {
    const host = document.createElement("div");
    const viewerRequest = ref(initialRequest);
    const closes: number[] = [];
    const exports: MermaidDiagramSnapshot[] = [];
    const app = createApp({
        setup() {
            return () =>
                h(MermaidViewer, {
                    request: viewerRequest.value,
                    documentName: "架构说明",
                    exporting: false,
                    exportError: "",
                    onClose: () => closes.push(1),
                    onExport: (diagram: MermaidDiagramSnapshot) => exports.push(diagram),
                });
        },
    });
    document.body.append(host);
    app.mount(host);
    return {
        host,
        request: viewerRequest,
        closes,
        exports,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`未找到按钮：${label}`);
    return found;
}

let cleanup: (() => void) | undefined;

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
    });
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("MermaidViewer", () => {
    it("opens as a modal and navigates diagrams in document order", async () => {
        const viewer = mountViewer();
        cleanup = viewer.unmount;
        await nextTick();

        expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
        expect(viewer.host.textContent).toContain("流程图");
        expect(viewer.host.textContent).toContain("1 / 2");
        expect(viewer.host.querySelector('[data-diagram="first"]')).not.toBeNull();

        button(viewer.host, "下一张图").click();
        await nextTick();

        expect(viewer.host.textContent).toContain("时序图");
        expect(viewer.host.textContent).toContain("2 / 2");
        expect(viewer.host.querySelector('[data-diagram="second"]')).not.toBeNull();
        expect(button(viewer.host, "下一张图").disabled).toBe(true);

        button(viewer.host, "上一张图").click();
        await nextTick();
        expect(viewer.host.querySelector('[data-diagram="first"]')).not.toBeNull();
    });

    it("zooms, shows a minimap, pans, and fits the diagram", async () => {
        const viewer = mountViewer();
        cleanup = viewer.unmount;
        await nextTick();

        const viewport = viewer.host.querySelector<HTMLElement>(
            ".mermaid-viewer-viewport",
        );
        expect(viewport).not.toBeNull();
        button(viewer.host, "放大").click();
        await nextTick();

        expect(viewer.host.textContent).toContain("125%");
        expect(viewer.host.querySelector(".mermaid-viewer-minimap")).not.toBeNull();

        viewport?.dispatchEvent(
            new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }),
        );
        viewport?.dispatchEvent(
            new MouseEvent("pointermove", { bubbles: true, clientX: 135, clientY: 120 }),
        );
        viewport?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        await nextTick();

        expect(
            viewer.host.querySelector<HTMLElement>(".mermaid-viewer-canvas")?.style
                .transform,
        ).toContain("translate(35px, 20px)");

        button(viewer.host, "适应视图").click();
        await nextTick();
        expect(viewer.host.textContent).toContain("100%");
        expect(viewer.host.querySelector(".mermaid-viewer-minimap")).toBeNull();
        expect(
            viewer.host.querySelector<HTMLElement>(".mermaid-viewer-canvas")?.style
                .transform,
        ).toContain("translate(0px, 0px)");
    });

    it("shows native hover tips for every toolbar control", async () => {
        const viewer = mountViewer();
        cleanup = viewer.unmount;
        await nextTick();

        for (const label of [
            "上一张图",
            "下一张图",
            "缩小",
            "放大",
            "适应视图",
            "导出 PNG",
            "关闭查看器",
        ]) {
            expect(button(viewer.host, label).title).toBe(label);
        }

        const zoomSelect = viewer.host.querySelector<HTMLSelectElement>(
            'select[aria-label="缩放比例"]',
        );
        expect(zoomSelect?.title).toBe("缩放比例");

        const fullscreen = button(viewer.host, "全屏查看");
        expect(fullscreen.title).toBe("全屏查看");
        fullscreen.click();
        await nextTick();
        expect(button(viewer.host, "退出全屏").title).toBe("退出全屏");
    });

    it("supports wheel zoom and fullscreen mode", async () => {
        const viewer = mountViewer();
        cleanup = viewer.unmount;
        await nextTick();
        const viewport = viewer.host.querySelector<HTMLElement>(
            ".mermaid-viewer-viewport",
        );

        viewport?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -80 }));
        await nextTick();
        expect(viewer.host.textContent).toContain("125%");

        const fullscreen = button(viewer.host, "全屏查看");
        fullscreen.click();
        await nextTick();
        expect(viewer.host.querySelector(".mermaid-viewer-dialog")?.classList).toContain(
            "is-fullscreen",
        );
        expect(fullscreen.getAttribute("aria-pressed")).toBe("true");

        fullscreen.click();
        await nextTick();
        expect(fullscreen.getAttribute("aria-pressed")).toBe("false");
    });

    it("exports the active diagram and closes from button or Escape", async () => {
        const viewer = mountViewer();
        cleanup = viewer.unmount;
        await nextTick();

        button(viewer.host, "下一张图").click();
        await nextTick();
        button(viewer.host, "导出 PNG").click();
        expect(viewer.exports).toEqual([request.diagrams[1]]);

        button(viewer.host, "关闭查看器").click();
        expect(viewer.closes).toHaveLength(1);

        viewer.host
            .querySelector("dialog")
            ?.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
        expect(viewer.closes).toHaveLength(2);
    });
});
