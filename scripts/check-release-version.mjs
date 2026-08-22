import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateReleaseVersions({
    packageVersion,
    cargoVersion,
    tauriVersion,
    releaseTag,
}) {
    const versions = new Set([packageVersion, cargoVersion, tauriVersion]);
    if (versions.size !== 1) {
        throw new Error(
            `发布版本不一致：package=${packageVersion}, cargo=${cargoVersion}, tauri=${tauriVersion}`,
        );
    }

    const version = packageVersion;
    if (releaseTag && releaseTag !== `app-v${version}`) {
        throw new Error(`发布标签必须为 app-v${version}，实际为 ${releaseTag}`);
    }
    return version;
}

function readCargoPackageVersion(cargoToml) {
    const packageHeader = /^\[package\]\s*$/m.exec(cargoToml);
    if (!packageHeader) {
        throw new Error("无法读取 src-tauri/Cargo.toml 的 [package] version");
    }
    const afterHeader = cargoToml.slice(packageHeader.index + packageHeader[0].length);
    const nextSection = afterHeader.search(/^\[/m);
    const packageSection =
        nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
    const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!version) {
        throw new Error("无法读取 src-tauri/Cargo.toml 的 [package] version");
    }
    return version;
}

function readTagArgument(args) {
    const tagIndex = args.indexOf("--tag");
    if (tagIndex === -1) {
        return process.env.RELEASE_TAG ?? process.env.npm_config_tag ?? "";
    }
    const tag = args[tagIndex + 1];
    if (!tag) {
        throw new Error("--tag 必须提供发布标签");
    }
    return tag;
}

async function main() {
    const [packageJson, tauriJson, cargoToml] = await Promise.all([
        readFile(new URL("../package.json", import.meta.url), "utf8"),
        readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
        readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    ]);
    const packageVersion = JSON.parse(packageJson).version;
    const tauriVersion = JSON.parse(tauriJson).version;
    const cargoVersion = readCargoPackageVersion(cargoToml);
    const releaseTag = readTagArgument(process.argv.slice(2));
    const version = validateReleaseVersions({
        packageVersion,
        cargoVersion,
        tauriVersion,
        releaseTag,
    });
    console.log(`release version ${version} verified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
