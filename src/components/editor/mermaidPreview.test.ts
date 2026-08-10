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
        'C4Context\nSystem(note, "Note")',
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
        expect(isSupportedMermaidSource('pie\ntitle Usage\n"Mora" : 100')).toBe(false);
    });

    it("checks only the first declaration after frontmatter, directives, and comments", () => {
        expect(
            isSupportedMermaidSource(
                "---\ntitle: flowchart\n---\n%%{init: { 'theme': 'neutral' }}%%\n%% flowchart LR\npie\ntitle Usage",
            ),
        ).toBe(false);
        expect(
            isSupportedMermaidSource(
                "---\ntitle: pie\n---\n%% comment\nflowchart LR\nA --> B",
            ),
        ).toBe(true);
    });

    it("applies rendered SVG through the Milkdown preview callback", async () => {
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(async () => ({ svg: '<svg data-chart="flow"></svg>' })),
        };
        const applyPreview = vi.fn();
        const preview = createMermaidPreview(mermaid);

        expect(mermaid.initialize).toHaveBeenCalledWith({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
            suppressErrorRendering: true,
        });
        expect(preview("mermaid", "flowchart LR\nA --> B", applyPreview)).toBeUndefined();
        expect(applyPreview).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            const host = applyPreview.mock.calls[0]?.[0] as HTMLElement;
            expect(host.innerHTML).toBe('<svg data-chart="flow"></svg>');
        });
        expect(mermaid.render).toHaveBeenCalledOnce();
        expect(mermaid.render).toHaveBeenCalledWith(
            expect.stringMatching(/^mora-mermaid-/u),
            "flowchart LR\nA --> B",
        );
        expect(applyPreview).toHaveBeenCalledTimes(1);
    });

    it("submits only the latest completed render for the same preview callback", async () => {
        let resolveFirst: ((value: { svg: string }) => void) | undefined;
        let resolveSecond: ((value: { svg: string }) => void) | undefined;
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveFirst = resolve;
                        }),
                )
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveSecond = resolve;
                        }),
                ),
        };
        const applyPreview = vi.fn();
        const preview = createMermaidPreview(mermaid);

        preview("mermaid", "flowchart LR\nA --> B", applyPreview);
        preview("mermaid", "flowchart LR\nA --> C", applyPreview);
        resolveSecond?.({ svg: '<svg data-chart="latest"></svg>' });
        await vi.waitFor(() => expect(applyPreview).toHaveBeenCalledTimes(1));
        resolveFirst?.({ svg: '<svg data-chart="stale"></svg>' });
        await Promise.resolve();

        expect((applyPreview.mock.calls[0]?.[0] as HTMLElement).innerHTML).toContain(
            "latest",
        );
        expect(applyPreview).toHaveBeenCalledTimes(1);
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
            expect(host.textContent).toContain("flowchart LR\nA -->");
            expect(host.classList.contains("mermaid-preview-error")).toBe(true);
        });
    });

    it("reports pending Mermaid work until the render settles", async () => {
        let resolveRender: ((value: { svg: string }) => void) | undefined;
        const mermaid: MermaidRenderer = {
            initialize: vi.fn(),
            render: vi.fn(
                () =>
                    new Promise<{ svg: string }>((resolve) => {
                        resolveRender = resolve;
                    }),
            ),
        };
        const preview = createMermaidPreview(mermaid);
        preview("mermaid", "flowchart LR\nA --> B", vi.fn());

        let settled = false;
        const waiting = preview.whenSettled().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveRender?.({ svg: "<svg></svg>" });
        await waiting;
        expect(settled).toBe(true);
    });
});
