import { describe, expect, it } from "vitest";

interface NodeProcess {
    cwd(): string;
    getBuiltinModule(name: "fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
    };
}

const nodeProcess = (globalThis as typeof globalThis & { process: NodeProcess }).process;

interface ReleaseTauriConfig {
    build: {
        beforeBuildCommand: string;
    };
    bundle: {
        externalBin: string[];
        icon: string[];
        macOS: {
            signingIdentity: string;
        };
        windows: {
            nsis: {
                displayLanguageSelector: boolean;
                languages: string[];
            };
            wix: {
                language: string;
            };
        };
    };
}

function readRepositoryFile(path: string): string {
    return nodeProcess
        .getBuiltinModule("fs")
        .readFileSync(`${nodeProcess.cwd()}/${path}`, "utf8");
}

describe("GitHub Draft Release workflow", () => {
    it("builds signed cross-platform updater assets behind all release gates", () => {
        const workflow = readRepositoryFile(".github/workflows/publish.yml");

        expect(workflow).toContain("windows-latest");
        expect(workflow).toContain("macos-latest");
        expect(workflow).toContain("ubuntu-22.04");
        expect(workflow).toContain("x86_64-pc-windows-msvc");
        expect(workflow).toContain("aarch64-apple-darwin");
        expect(workflow).toContain("x86_64-apple-darwin");
        expect(workflow).toContain("x86_64-unknown-linux-gnu");
        expect(workflow).toContain("--bundles nsis,msi");
        expect(workflow).toContain("--bundles dmg");
        expect(workflow).toContain("--bundles appimage,deb");
        expect(workflow).toContain("max-parallel: 1");
        expect(workflow).toContain("libwebkit2gtk-4.1-dev");
        expect(workflow).toContain("fonts-noto-cjk");
        expect(workflow).toContain("retryAttempts: 3");
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
        expect(workflow).toContain("releaseBody: |");
        expect(workflow).toContain("xattr -dr com.apple.quarantine");
        expect(workflow).toContain("系统设置 → 隐私与安全性 → 仍要打开");
        expect(workflow).not.toContain("--bundles rpm");
        expect(workflow).not.toContain("releaseDraft: false");
    });

    it("configures localized Windows installers and ad-hoc signed macOS bundles", () => {
        const config = JSON.parse(
            readRepositoryFile("src-tauri/tauri.conf.json"),
        ) as ReleaseTauriConfig;

        expect(config.bundle.windows.wix.language).toBe("zh-CN");
        expect(config.bundle.windows.nsis.languages).toEqual(["SimpChinese"]);
        expect(config.bundle.windows.nsis.displayLanguageSelector).toBe(false);
        expect(config.bundle.macOS.signingIdentity).toBe("-");
        expect(config.bundle.icon).toEqual([
            "icons/32x32.png",
            "icons/128x128.png",
            "icons/128x128@2x.png",
            "icons/icon.icns",
            "icons/icon.ico",
        ]);
    });

    it("builds and bundles exactly one target-specific mora-agent sidecar", () => {
        const config = JSON.parse(
            readRepositoryFile("src-tauri/tauri.conf.json"),
        ) as ReleaseTauriConfig;
        const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
            scripts: Record<string, string>;
        };
        const gitignore = readRepositoryFile(".gitignore");
        const workflow = readRepositoryFile(".github/workflows/publish.yml");
        const cargoManifest = readRepositoryFile("src-tauri/Cargo.toml");
        const sidecarCheck =
            "node scripts/prepare-agent-sidecar.mjs --check --target ${{ matrix.target }}";

        expect(packageJson.scripts["prepare:agent"]).toBe(
            "node scripts/prepare-agent-sidecar.mjs",
        );
        expect(config.build.beforeBuildCommand).toBe(
            "npm run build && npm run prepare:agent",
        );
        expect(config.bundle.externalBin).toEqual(["binaries/mora-agent"]);
        expect(config.bundle.externalBin).not.toContain("binaries/mora-mcp");
        expect(cargoManifest).toMatch(/\[features\][\s\S]*agent-bin\s*=\s*\[\]/);
        expect(cargoManifest).toMatch(
            /\[\[bin\]\][\s\S]*name\s*=\s*"mora-agent"[\s\S]*required-features\s*=\s*\["agent-bin"\]/,
        );
        expect(cargoManifest).toContain('path = "src/mora_agent_main.rs"');
        expect(cargoManifest).not.toContain('path = "src/bin/mora-agent.rs"');
        expect(gitignore).toContain("src-tauri/binaries/mora-agent-*");
        expect(gitignore).not.toMatch(/^src-tauri\/binaries\/$/m);
        expect(workflow).toContain(sidecarCheck);
        expect(workflow.indexOf(sidecarCheck)).toBeGreaterThan(
            workflow.indexOf("uses: tauri-apps/tauri-action@v1"),
        );
    });
});
