import { describe, expect, it } from "vitest";

interface NodeProcess {
    cwd(): string;
    getBuiltinModule(name: "fs"): {
        existsSync(path: string): boolean;
        readFileSync(path: string): Uint8Array;
        statSync(path: string): { size: number };
    };
}

const nodeProcess = (globalThis as typeof globalThis & { process: NodeProcess }).process;
const fs = nodeProcess.getBuiltinModule("fs");
const assetRoot = nodeProcess.cwd() + "/public/fonts/maple-mono-cn";

describe("bundled Maple Mono CN", () => {
    it("ships the regular font and its license metadata", () => {
        const fontPath = assetRoot + "/MapleMono-CN-Regular.ttf";
        expect(fs.existsSync(fontPath)).toBe(true);
        expect(fs.existsSync(assetRoot + "/OFL.txt")).toBe(true);
        expect(fs.existsSync(assetRoot + "/SOURCE.md")).toBe(true);

        const bytes = fs.readFileSync(fontPath);
        expect(Array.from(bytes.slice(0, 4))).toEqual([0, 1, 0, 0]);
        expect(fs.statSync(fontPath).size).toBeGreaterThan(17_000_000);
        expect(fs.statSync(fontPath).size).toBeLessThan(19_000_000);
    });
});
