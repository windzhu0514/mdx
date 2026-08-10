import { describe, expect, it, vi } from "vitest";
import { prepareDocumentExportRequest } from "./documentExport";

describe("prepareDocumentExportRequest", () => {
    it("converts neutral Mermaid SVGs to PNG without mutating the snapshot", async () => {
        const resource = {
            name: "assets/diagram.png",
            originalName: "diagram.png",
            mimeType: "image/png",
            size: 4,
            kind: "asset" as const,
            base64: "cG5n",
        };
        const input = {
            format: "docx" as const,
            destinationPath: "C:\\Notes\\draft.docx",
            title: "草稿",
            markdown: "# 标题",
            resources: [resource],
            diagrams: [
                { label: "流程图", source: "flowchart TD\nA-->B", svg: "<svg />" },
            ],
        };
        const convert = vi.fn(async () => "UE5H");

        const request = await prepareDocumentExportRequest(input, convert);

        expect(request.mermaidDiagrams).toEqual([
            { source: "flowchart TD\nA-->B", pngBase64: "UE5H" },
        ]);
        expect(request.markdown).toBe("# 标题");
        expect(request.resources).toEqual([resource]);
        expect(request.resources[0]).not.toBe(resource);
        expect(convert).toHaveBeenCalledWith("<svg />", "light");
    });
});
