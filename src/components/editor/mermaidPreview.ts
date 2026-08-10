export type MermaidRenderResult = {
    svg: string;
    bindFunctions?: (element: Element) => void;
};

export type MermaidRenderer = {
    initialize: (config: {
        startOnLoad: false;
        securityLevel: "strict";
        theme: "neutral" | "dark";
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
    activate(event: Event, documentSources: readonly string[]): boolean;
    dispose(): void;
};

export type MermaidDiagramSnapshot = {
    label: string;
    source: string;
    svg: string;
};

export type MermaidViewerRequest = {
    diagrams: MermaidDiagramSnapshot[];
    activeIndex: number;
};

const supportedHeaders =
    /^(?:flowchart|graph|stateDiagram(?:-v2)?|classDiagram|erDiagram|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment)|architecture-beta|block-beta|sequenceDiagram|gantt|timeline|journey|mindmap)\b/u;
let renderSequence = 0;
const MERMAID_PREVIEW_TOKEN = "mermaidPreviewToken";

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

function mermaidDiagramLabel(source: string): string {
    const declaration = firstMermaidDeclaration(source).match(/^\S+/u)?.[0] ?? "";
    if (/^(?:flowchart|graph)$/iu.test(declaration)) return "流程图";
    if (/^sequenceDiagram$/iu.test(declaration)) return "时序图";
    if (/^classDiagram$/iu.test(declaration)) return "类图";
    if (/^stateDiagram(?:-v2)?$/iu.test(declaration)) return "状态图";
    if (/^erDiagram$/iu.test(declaration)) return "实体关系图";
    if (/^gantt$/iu.test(declaration)) return "甘特图";
    if (/^timeline$/iu.test(declaration)) return "时间线";
    if (/^journey$/iu.test(declaration)) return "用户旅程图";
    if (/^mindmap$/iu.test(declaration)) return "思维导图";
    if (/^requirementDiagram$/iu.test(declaration)) return "需求图";
    if (/^C4/iu.test(declaration)) return "C4 架构图";
    if (/^architecture-beta$/iu.test(declaration)) return "架构图";
    if (/^block-beta$/iu.test(declaration)) return "块图";
    return "Mermaid 图表";
}

export async function renderMermaidForExport(
    mermaid: MermaidRenderer,
    sources: readonly string[],
): Promise<MermaidDiagramSnapshot[]> {
    const restoreTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "neutral";
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        suppressErrorRendering: true,
    });
    try {
        const diagrams: MermaidDiagramSnapshot[] = [];
        for (const [index, source] of sources.entries()) {
            if (!isSupportedMermaidSource(source)) continue;
            try {
                const { svg } = await mermaid.render(`mora-export-mermaid-${index}`, source);
                diagrams.push({ label: mermaidDiagramLabel(source), source, svg });
            } catch {
                // Missing entries deliberately fall back to code blocks in Rust.
            }
        }
        return diagrams;
    } finally {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: restoreTheme,
            suppressErrorRendering: true,
        });
    }
}

export function createMermaidPreview(
    mermaid: MermaidRenderer,
    openViewer?: (request: MermaidViewerRequest) => void,
): CodeBlockPreview {
    let initializedTheme: "neutral" | "dark" | null = null;
    const pendingRenders = new Set<Promise<void>>();
    const renderedDiagrams = new Map<
        (value: HTMLElement | null) => void,
        MermaidDiagramSnapshot & { order: number; token: string }
    >();
    const latestRequestForCallback = new WeakMap<
        (value: HTMLElement | null) => void,
        number
    >();

    const removeRenderedDiagram = (applyPreview: (value: HTMLElement | null) => void) => {
        renderedDiagrams.delete(applyPreview);
    };

    const preview: CodeBlockPreview = (language, source, applyPreview) => {
        if (
            language.trim().toLowerCase() !== "mermaid" ||
            !isSupportedMermaidSource(source)
        ) {
            removeRenderedDiagram(applyPreview);
            return null;
        }

        const theme =
            document.documentElement.dataset.theme === "dark" ? "dark" : "neutral";
        if (theme !== initializedTheme) {
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                theme,
                suppressErrorRendering: true,
            });
            initializedTheme = theme;
        }

        const requestId = renderSequence++;
        const token = `mermaid-preview-${requestId}`;
        removeRenderedDiagram(applyPreview);
        latestRequestForCallback.set(applyPreview, requestId);
        const host = openViewer
            ? document.createElement("button")
            : document.createElement("div");
        host.className = "mermaid-preview";
        const label = mermaidDiagramLabel(source);
        if (openViewer) {
            (host as HTMLButtonElement).type = "button";
            host.dataset[MERMAID_PREVIEW_TOKEN] = token;
            host.setAttribute("role", "button");
            host.setAttribute("aria-label", `打开${label}查看器`);
        } else {
            host.setAttribute("role", "img");
            host.setAttribute("aria-label", "Mermaid 图表");
        }

        const render = mermaid
            .render(`mora-mermaid-${requestId}`, source)
            .then(({ svg, bindFunctions }) => {
                if (latestRequestForCallback.get(applyPreview) !== requestId) return;
                host.innerHTML = svg;
                bindFunctions?.(host);
                if (openViewer) {
                    renderedDiagrams.set(applyPreview, {
                        order: requestId,
                        token,
                        label,
                        source,
                        svg,
                    });
                }
                applyPreview(host);
            })
            .catch(() => {
                if (latestRequestForCallback.get(applyPreview) !== requestId) return;
                removeRenderedDiagram(applyPreview);
                host.classList.add("mermaid-preview-error");
                host.removeAttribute("role");
                host.removeAttribute("aria-label");
                delete host.dataset[MERMAID_PREVIEW_TOKEN];
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

    preview.activate = (event, documentSources) => {
        if (!openViewer) return false;
        const target = event
            .composedPath()
            .find(
                (item): item is HTMLElement =>
                    item instanceof HTMLElement &&
                    Boolean(item.dataset[MERMAID_PREVIEW_TOKEN]),
            );
        const activeToken = target?.dataset[MERMAID_PREVIEW_TOKEN];
        if (!activeToken) return false;

        const available = [...renderedDiagrams.values()].sort(
            (first, second) => first.order - second.order,
        );
        const usedTokens = new Set<string>();
        const ordered = documentSources.flatMap((source) => {
            const diagram = available.find(
                (candidate) =>
                    candidate.source === source && !usedTokens.has(candidate.token),
            );
            if (!diagram) return [];
            usedTokens.add(diagram.token);
            return [diagram];
        });
        const activeIndex = ordered.findIndex(({ token }) => token === activeToken);
        if (activeIndex < 0) return false;
        openViewer({
            activeIndex,
            diagrams: ordered.map(
                ({ order: _order, token: _token, ...diagram }) => diagram,
            ),
        });
        return true;
    };

    preview.dispose = () => {
        renderedDiagrams.clear();
        pendingRenders.clear();
    };

    return preview;
}
