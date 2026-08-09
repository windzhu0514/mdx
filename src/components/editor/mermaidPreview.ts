export type MermaidRenderResult = { svg: string; bindFunctions?: (element: Element) => void };

export type MermaidRenderer = {
    initialize: (config: { startOnLoad: false; securityLevel: "strict"; theme: "neutral" }) => void;
    render: (id: string, source: string) => Promise<MermaidRenderResult>;
};

export type CodeBlockPreview = (
    language: string,
    source: string,
    applyPreview: (value: HTMLElement | null) => void,
) => void | null;

const supportedHeaders = /^(?:flowchart|graph|stateDiagram(?:-v2)?|classDiagram|erDiagram|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|architecture-beta|block-beta|sequenceDiagram|gantt|timeline|journey|mindmap)\b/mu;
let renderSequence = 0;

export function isSupportedMermaidSource(source: string): boolean {
    return supportedHeaders.test(source.replace(/^%%\{[\s\S]*?\}%%\s*/u, ""));
}

export function createMermaidPreview(mermaid: MermaidRenderer): CodeBlockPreview {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });

    return (language, source, applyPreview) => {
        if (language.trim().toLowerCase() !== "mermaid" || !isSupportedMermaidSource(source)) {
            return null;
        }

        const host = document.createElement("div");
        host.className = "mermaid-preview";
        host.setAttribute("role", "img");
        host.setAttribute("aria-label", "Mermaid 图表");
        applyPreview(host);

        void mermaid
            .render(`mora-mermaid-${renderSequence++}`, source)
            .then(({ svg, bindFunctions }) => {
                host.innerHTML = svg;
                bindFunctions?.(host);
            })
            .catch(() => {
                host.classList.add("mermaid-preview-error");
                host.removeAttribute("role");
                host.textContent = "Mermaid 图表无法渲染，请检查源码。";
            });
    };
}
