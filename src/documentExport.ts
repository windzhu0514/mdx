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
    return {
        destinationPath: input.destinationPath,
        title: input.title,
        markdown: input.markdown,
        resources: input.resources.map((resource) => ({ ...resource })),
        format: input.format,
        mermaidDiagrams: await Promise.all(
            input.diagrams.map(async ({ source, svg }) => ({
                source,
                pngBase64: await convert(svg, "light"),
            })),
        ),
    };
}
