import { svgToPngBase64 } from "./components/editor/mermaidExport";
import type { MermaidDiagramSnapshot } from "./components/editor/mermaidPreview";
import type { ResourceSaveData } from "./types/mdx";

export type DocumentExportFormat = "docx" | "pdf";

export type ExportMermaidDiagram = {
    source: string;
    pngBase64: string;
};

export type DocumentExportRequest = {
    destinationPath: string;
    title: string;
    markdown: string;
    resources: ResourceSaveData[];
    mermaidDiagrams: ExportMermaidDiagram[];
    format: DocumentExportFormat;
};

export async function prepareDocumentExportRequest(
    input: Omit<DocumentExportRequest, "mermaidDiagrams"> & {
        diagrams: MermaidDiagramSnapshot[];
    },
    convert: (svg: string, theme: "light") => Promise<string> = svgToPngBase64,
): Promise<DocumentExportRequest> {
    const mermaidDiagrams: ExportMermaidDiagram[] = [];
    for (const { source, svg } of input.diagrams) {
        try {
            mermaidDiagrams.push({
                source,
                pngBase64: await convert(svg, "light"),
            });
        } catch {
            // Rust receives no snapshot for this source and exports its Mermaid code block.
        }
    }

    return {
        destinationPath: input.destinationPath,
        title: input.title,
        markdown: input.markdown,
        resources: input.resources.map((resource) => ({ ...resource })),
        format: input.format,
        mermaidDiagrams,
    };
}
