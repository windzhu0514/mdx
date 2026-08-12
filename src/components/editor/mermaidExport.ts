import { isDarkTheme, type ThemeId } from "../../composables/usePreferences";

export type MermaidExportTheme = ThemeId | "light";

const DEFAULT_SIZE = { width: 1200, height: 800 } as const;

function positiveDimension(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readSvgDimensions(svg: string): { width: number; height: number } {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const element = document.documentElement;
    const viewBox = element
        .getAttribute("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
    if (
        viewBox?.length === 4 &&
        Number.isFinite(viewBox[2]) &&
        Number.isFinite(viewBox[3]) &&
        viewBox[2] > 0 &&
        viewBox[3] > 0
    ) {
        return { width: viewBox[2], height: viewBox[3] };
    }

    const width = positiveDimension(element.getAttribute("width"));
    const height = positiveDimension(element.getAttribute("height"));
    return width && height ? { width, height } : { ...DEFAULT_SIZE };
}

function normalizedSvg(svg: string): string {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const element = document.documentElement;
    if (element.nodeName.toLocaleLowerCase() !== "svg") {
        throw new Error("Mermaid 图表不是有效的 SVG");
    }
    element.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(element);
}

function loadSvgImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("无法加载 Mermaid SVG"));
        image.src = url;
    });
}

export async function svgToPngBase64(
    svg: string,
    theme: MermaidExportTheme,
): Promise<string> {
    const { width, height } = readSvgDimensions(svg);
    const scale = Math.min(2, 8192 / width, 8192 / height);
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    const url = URL.createObjectURL(
        new Blob([normalizedSvg(svg)], { type: "image/svg+xml;charset=utf-8" }),
    );

    try {
        const image = await loadSvgImage(url);
        const canvas = document.createElement("canvas");
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前环境无法创建 PNG 画布");

        context.fillStyle = isDarkTheme(theme) ? "#111827" : "#ffffff";
        context.fillRect(0, 0, outputWidth, outputHeight);
        context.drawImage(image, 0, 0, outputWidth, outputHeight);
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1];
        if (!base64) throw new Error("PNG 编码失败");
        return base64;
    } finally {
        URL.revokeObjectURL(url);
    }
}
