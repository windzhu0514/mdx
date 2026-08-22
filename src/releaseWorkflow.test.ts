import { describe, expect, it } from "vitest";

interface NodeProcess {
    cwd(): string;
    getBuiltinModule(name: "fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
    };
}

const nodeProcess = (globalThis as typeof globalThis & { process: NodeProcess }).process;

describe("GitHub Draft Release workflow", () => {
    it("builds signed Windows updater assets behind all release gates", () => {
        const workflow = nodeProcess
            .getBuiltinModule("fs")
            .readFileSync(nodeProcess.cwd() + "/.github/workflows/publish.yml", "utf8");

        expect(workflow).toContain("windows-latest");
        expect(workflow).toContain("app-v*");
        expect(workflow).toContain("npm ci");
        expect(workflow).toContain("npm run release:check");
        expect(workflow).toContain("npm test");
        expect(workflow).toContain("npm run lint");
        expect(workflow).toContain("npm run format:check");
        expect(workflow).toContain("cargo test");
        expect(workflow).toContain("cargo check");
        expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
        expect(workflow).toContain("tauri-apps/tauri-action@v1");
        expect(workflow).toContain("releaseDraft: true");
        expect(workflow).toContain("uploadUpdaterJson: true");
        expect(workflow).toContain("updaterJsonPreferNsis: true");
        expect(workflow).not.toContain("releaseDraft: false");
    });
});
