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
    it("runs release-quality gates on master pushes and pull requests", () => {
        const workflow = readRepositoryFile(".github/workflows/ci.yml");

        expect(workflow).toContain("name: Mora CI");
        expect(workflow).toContain("push:");
        expect(workflow).toContain("pull_request:");
        expect(workflow.match(/master/g)?.length).toBeGreaterThanOrEqual(2);
        expect(workflow).toContain("ubuntu-22.04");
        expect(workflow).toContain("npm run release:check");
        expect(workflow).toContain("npm test");
        expect(workflow).toContain("npm run lint");
        expect(workflow).toContain("npm run format:check");
        expect(workflow).toContain("npm run build");
        expect(workflow).toContain("npm run prepare:agent");
        expect(workflow).toContain(
            "cargo test --manifest-path src-tauri/Cargo.toml --features agent-bin",
        );
        expect(workflow).toContain("cargo check --manifest-path src-tauri/Cargo.toml");
        expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    });

    it("builds signed cross-platform updater assets behind all release gates", () => {
        const workflow = readRepositoryFile(".github/workflows/publish.yml");
        const buildStart = workflow.indexOf("\n    build:");
        const releaseStart = workflow.indexOf("\n    release:");
        const verifyJob = workflow.slice(0, buildStart);
        const buildJob = workflow.slice(buildStart, releaseStart);
        const releaseJob = workflow.slice(releaseStart);

        expect(workflow).toContain("windows-latest");
        expect(workflow).toContain("macos-latest");
        expect(workflow).toContain("ubuntu-22.04");
        expect(workflow).toContain("x86_64-pc-windows-msvc");
        expect(workflow).toContain("aarch64-apple-darwin");
        expect(workflow).toContain("x86_64-apple-darwin");
        expect(workflow).toContain("x86_64-unknown-linux-gnu");
        expect(workflow).toContain("--bundles nsis,msi");
        expect(workflow.match(/--bundles app,dmg/g)).toHaveLength(2);
        expect(workflow).not.toContain("--bundles dmg");
        expect(workflow).toContain("--bundles appimage,deb");
        expect(workflow).not.toContain("max-parallel: 1");
        expect(workflow).toContain("libwebkit2gtk-4.1-dev");
        expect(workflow).toContain("fonts-noto-cjk");
        expect(workflow).toContain("app-v*");
        expect(workflow.match(/ref: \$\{\{ env\.RELEASE_TAG \}\}/g)).toHaveLength(3);
        expect(workflow).toContain("npm ci");
        expect(workflow).toContain("npm run release:check");
        expect(workflow).toContain("npm test");
        expect(workflow).toContain("npm run lint");
        expect(workflow).toContain("npm run format:check");
        expect(verifyJob).toContain(
            "cargo test --manifest-path src-tauri/Cargo.toml --features agent-bin",
        );
        expect(workflow).toContain("cargo check");
        expect(buildJob).toContain("TAURI_SIGNING_PRIVATE_KEY");
        expect(buildJob).toContain("tauri-apps/tauri-action@v1");
        expect(buildJob).toContain("uses: actions/upload-artifact@v4");
        expect(buildJob).toContain("name: mora-release-${{ matrix.target }}");
        expect(buildJob).toContain("Normalize macOS updater archive names");
        expect(buildJob).toContain("Mora.app.tar.gz");
        expect(buildJob).toContain("matrix.asset_arch");
        expect(buildJob).toContain("if-no-files-found: error");
        expect(buildJob).not.toContain("tagName:");
        expect(buildJob).not.toContain("releaseDraft:");
        expect(buildJob).not.toContain("uploadUpdaterJson: true");
        expect(releaseJob).toContain("needs: build");
        expect(releaseJob).toContain("uses: actions/download-artifact@v4");
        expect(releaseJob).toContain("fetch-depth: 0");
        expect(releaseJob).toContain("pattern: mora-release-*");
        expect(releaseJob).toContain("node scripts/assemble-release.mjs");
        expect(releaseJob).toContain("gh release create");
        expect(releaseJob).toContain("--draft");
        expect(releaseJob).toContain("--verify-tag");
        expect(releaseJob).toContain("gh release upload");
        expect(releaseJob).toContain("--clobber");
        expect(releaseJob).toContain("git rev-parse HEAD");
        expect(releaseJob).not.toContain("gh release publish");
        expect(workflow).not.toContain("--bundles rpm");
        expect(workflow).not.toContain("releaseDraft: false");
    });

    it("keeps stable installation guidance in the shared release preamble", () => {
        const preamble = readRepositoryFile(".github/release-preamble.md");

        expect(preamble).toContain("## 下载与安装");
        expect(preamble).toContain("xattr -dr com.apple.quarantine");
        expect(preamble).toContain("系统设置 → 隐私与安全性 → 仍要打开");
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

    it("prepares the Linux mora-agent sidecar before Rust tests", () => {
        const workflow = readRepositoryFile(".github/workflows/publish.yml");
        const verifyJob = workflow.slice(0, workflow.indexOf("\n    build:"));
        const prepareSidecar = "run: npm run prepare:agent";
        const rustTests =
            "run: cargo test --manifest-path src-tauri/Cargo.toml --features agent-bin";

        expect(verifyJob).toContain('TAURI_ENV_DEBUG: "true"');
        expect(verifyJob).toContain(prepareSidecar);
        expect(verifyJob.indexOf(prepareSidecar)).toBeLessThan(
            verifyJob.indexOf(rustTests),
        );
    });

    it("prepares each target mora-agent sidecar before target-specific Rust checks", () => {
        const workflow = readRepositoryFile(".github/workflows/publish.yml");
        const buildJob = workflow.slice(
            workflow.indexOf("\n    build:"),
            workflow.indexOf("\n    release:"),
        );
        const prepareSidecar =
            "run: npm run prepare:agent -- --target ${{ matrix.target }}";
        const targetCheck =
            "run: cargo check --manifest-path src-tauri/Cargo.toml --target ${{ matrix.target }}";

        expect(buildJob).toContain('TAURI_ENV_DEBUG: "true"');
        expect(buildJob).toContain(prepareSidecar);
        expect(buildJob.indexOf(prepareSidecar)).toBeLessThan(
            buildJob.indexOf(targetCheck),
        );
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
            "npm run build && npm run prepare:agent && npm run prepare:notices",
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
