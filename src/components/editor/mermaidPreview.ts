export type MermaidRenderResult = {
    svg: string;
    bindFunctions?: (element: Element) => void;
};

export type MermaidRenderer = {
    initialize: (config: {
        startOnLoad: false;
        securityLevel: "strict";
        theme: "neutral";
        suppressErrorRendering: true;
    }) => void;
    render: (
        id: string,
        source: string,
        container?: HTMLElement,
    ) => Promise<MermaidRenderResult>;
};

export type CodeBlockPreview = {
    (
        language: string,
        source: string,
        applyPreview: (value: HTMLElement | null) => void,
    ): void | null;
    whenSettled(): Promise<void>;
};

const supportedHeaders =
    /^(?:flowchart|graph|stateDiagram(?:-v2)?|classDiagram|erDiagram|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|architecture-beta|block-beta|sequenceDiagram|gantt|timeline|journey|mindmap)\b/u;
let renderSequence = 0;

function firstMermaidDeclaration(source: string): string {
    let remaining = source
        .replace(/^\uFEFF/u, "")
        .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "");

    while (remaining) {
        remaining = remaining.trimStart();
        const withoutDirective = remaining.replace(
            /^%%\{[\s\S]*?\}%%[ \t]*(?:\r?\n|$)/u,
            "",
        );
        if (withoutDirective !== remaining) {
            remaining = withoutDirective;
            continue;
        }
        const withoutComment = remaining.replace(/^%%(?!\{)[^\r\n]*(?:\r?\n|$)/u, "");
        if (withoutComment !== remaining) {
            remaining = withoutComment;
            continue;
        }
        break;
    }

    return remaining.split(/\r?\n/u, 1)[0] ?? "";
}

export function isSupportedMermaidSource(source: string): boolean {
    return supportedHeaders.test(firstMermaidDeclaration(source));
}

export function createMermaidPreview(mermaid: MermaidRenderer): CodeBlockPreview {
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        suppressErrorRendering: true,
    });
    const pendingRenders = new Set<Promise<void>>();
    const latestRequestForCallback = new WeakMap<
        (value: HTMLElement | null) => void,
        number
    >();

    const preview: CodeBlockPreview = (language, source, applyPreview) => {
        if (
            language.trim().toLowerCase() !== "mermaid" ||
            !isSupportedMermaidSource(source)
        ) {
            return null;
        }

        const requestId = renderSequence++;
        latestRequestForCallback.set(applyPreview, requestId);
        const host = document.createElement("div");
        host.className = "mermaid-preview";
        host.setAttribute("role", "img");
        host.setAttribute("aria-label", "Mermaid 图表");
        const renderContainer = document.createElement("div");
        renderContainer.className = "mermaid-render-container";

        const render = mermaid
            .render(`mora-mermaid-${requestId}`, source, renderContainer)
            .then(({ svg, bindFunctions }) => {
                if (latestRequestForCallback.get(applyPreview) !== requestId) return;
                host.innerHTML = svg;
                bindFunctions?.(host);
                applyPreview(host);
            })
            .catch(() => {
                if (latestRequestForCallback.get(applyPreview) !== requestId) return;
                host.classList.add("mermaid-preview-error");
                host.removeAttribute("role");
                host.removeAttribute("aria-label");
                const message = document.createElement("p");
                message.className = "mermaid-preview-error-message";
                message.setAttribute("role", "alert");
                message.textContent = "Mermaid 图表无法渲染，请检查源码。";
                const sourceBlock = document.createElement("pre");
                const code = document.createElement("code");
                code.textContent = source;
                sourceBlock.append(code);
                host.append(message, sourceBlock);
                applyPreview(host);
            })
            .finally(() => {
                pendingRenders.delete(render);
            });
        pendingRenders.add(render);
    };

    preview.whenSettled = async () => {
        while (pendingRenders.size > 0) {
            await Promise.all([...pendingRenders]);
        }
    };

    return preview;
}
