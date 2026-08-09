/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
    createMermaidPreview,
    isSupportedMermaidSource,
    type MermaidRenderer,
} from "./mermaidPreview";

describe("mermaidPreview", () => {
    it.each([
        "flowchart LR\nA --> B",
        "stateDiagram-v2\n[*] --> Ready",
        "classDiagram\nclass Note",
        "erDiagram\nNOTE ||--o{ ASSET : contains",
        "requirementDiagram\nrequirement note { id: 1 }",
        "C4Context\nSystem(note, \"Note\")",
        "architecture-beta\nservice api(server)[API]",
        "block-beta\ncolumns 2\nA B",
        "sequenceDiagram\nAlice->>Bob: Hi",
        "gantt\ntitle Plan\nsection Work\nBuild :a1, 2026-08-09, 1d",
        "timeline\ntitle History\n2026 : Start",
        "journey\ntitle Reading\nsection Write\nDraft: 5: User",
        "mindmap\n  root((Mora))\n    Note",
    ])("accepts supported Mermaid source: %s", (source) => {
        expect(isSupportedMermaidSource(source)).toBe(true);
    });

    it("keeps data-chart Mermaid source as an ordinary code block", () => {
        expect(isSupportedMermaidSource("pie\ntitle Usage\n\"Mora\" : 100")).toBe(false);
    });

    it("applies rendered SVG through the Milkdown preview callback", async () => {
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(async () => ({ svg: "<svg data-chart=\"flow\"></svg>" })),
        };
        const applyPreview = vi.fn();
        const preview = createMermaidPreview(mermaid);

        expect(mermaid.initialize).toHaveBeenCalledWith({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
        });
        expect(preview("mermaid", "flowchart LR\nA --> B", applyPreview)).toBeUndefined();
        await vi.waitFor(() => {
            const host = applyPreview.mock.calls[0]?.[0] as HTMLElement;
            expect(host.innerHTML).toBe("<svg data-chart=\"flow\"></svg>");
        });
        expect(mermaid.render).toHaveBeenCalledOnce();
    });

    it("replaces a rejected render with a readable error without changing source", async () => {
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(async () => Promise.reject(new Error("syntax error"))),
        };
        const applyPreview = vi.fn();
        createMermaidPreview(mermaid)("mermaid", "flowchart LR\nA -->", applyPreview);

        await vi.waitFor(() => {
            const host = applyPreview.mock.calls[0]?.[0] as HTMLElement;
            expect(host.textContent).toContain("无法渲染");
            expect(host.classList.contains("mermaid-preview-error")).toBe(true);
        });
    });
});
