/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readSvgDimensions, svgToPngBase64 } from "./mermaidExport";

afterEach(() => vi.restoreAllMocks());

describe("Mermaid PNG export", () => {
    it("reads dimensions from viewBox and caps invalid sizes", () => {
        expect(readSvgDimensions('<svg viewBox="0 0 1280 720"></svg>')).toEqual({
            width: 1280,
            height: 720,
        });
        expect(readSvgDimensions('<svg width="640" height="480"></svg>')).toEqual({
            width: 640,
            height: 480,
        });
        expect(readSvgDimensions("<svg></svg>")).toEqual({ width: 1200, height: 800 });
    });

    it("renders an SVG onto a themed canvas and returns PNG base64", async () => {
        const context = {
            drawImage: vi.fn(),
            fillRect: vi.fn(),
            fillStyle: "",
        };
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
            context as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
            "data:image/png;base64,cG5nLWRhdGE=",
        );
        Object.defineProperty(URL, "createObjectURL", {
            configurable: true,
            value: vi.fn(() => "blob:mermaid-svg"),
        });
        Object.defineProperty(URL, "revokeObjectURL", {
            configurable: true,
            value: vi.fn(),
        });
        class LoadedImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            set src(_value: string) {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal("Image", LoadedImage);

        const result = await svgToPngBase64(
            '<svg viewBox="0 0 800 500"><rect width="800" height="500" /></svg>',
            "dark",
        );

        expect(result).toBe("cG5nLWRhdGE=");
        expect(context.fillStyle).toBe("#111827");
        expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1000);
        expect(context.drawImage).toHaveBeenCalledOnce();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-svg");
    });
});
