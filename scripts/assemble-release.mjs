import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_OPTIONS = new Map([
    ["--artifacts-dir", "artifactsDir"],
    ["--output-dir", "outputDir"],
    ["--repository", "repository"],
    ["--tag", "releaseTag"],
    ["--notes-file", "notesFile"],
    ["--generated-notes-file", "generatedNotesFile"],
]);
const REQUIRED_CLI_OPTIONS = [
    "--artifacts-dir",
    "--output-dir",
    "--repository",
    "--tag",
    "--notes-file",
];

function expectedAssetNames(version) {
    return [
        `Mora_${version}_x64-setup.exe`,
        `Mora_${version}_x64-setup.exe.sig`,
        `Mora_${version}_x64_zh-CN.msi`,
        `Mora_${version}_x64_zh-CN.msi.sig`,
        `Mora_${version}_aarch64.dmg`,
        `Mora_${version}_aarch64.app.tar.gz`,
        `Mora_${version}_aarch64.app.tar.gz.sig`,
        `Mora_${version}_x64.dmg`,
        `Mora_${version}_x64.app.tar.gz`,
        `Mora_${version}_x64.app.tar.gz.sig`,
        `Mora_${version}_amd64.AppImage`,
        `Mora_${version}_amd64.AppImage.sig`,
        `Mora_${version}_amd64.deb`,
        `Mora_${version}_amd64.deb.sig`,
    ];
}

export function parseCliOptions(args) {
    const parsed = {};
    const supplied = new Set();

    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const property = CLI_OPTIONS.get(option);
        if (!property) {
            throw new Error(`Unknown option: ${option}`);
        }
        if (supplied.has(option)) {
            throw new Error(`Repeated option: ${option}`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new Error(`Missing value for option: ${option}`);
        }
        supplied.add(option);
        parsed[property] = value;
    }

    for (const option of REQUIRED_CLI_OPTIONS) {
        if (!supplied.has(option)) {
            throw new Error(`Missing required option: ${option}`);
        }
    }

    return parsed;
}

export function combineNotes(...sections) {
    return sections
        .map((section) => section.trim())
        .filter(Boolean)
        .join("\n\n");
}

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(path)));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }

    return files;
}

function downloadUrl(repository, releaseTag, assetName) {
    return `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`;
}

function validateReleaseIdentity({ repository, releaseTag, version }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error("Repository must use owner/repository format");
    }
    if (releaseTag !== `app-v${version}`) {
        throw new Error(`Release tag must be app-v${version}`);
    }
}

async function assertEmptyOutputDirectory(outputDir) {
    try {
        if ((await readdir(outputDir)).length > 0) {
            throw new Error("Release output directory must be empty");
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

async function indexReleaseAssets(artifactsDir, expectedNames) {
    const filesByName = new Map();
    for (const path of await listFiles(artifactsDir)) {
        const name = basename(path);
        const paths = filesByName.get(name) ?? [];
        paths.push(path);
        filesByName.set(name, paths);
    }

    const expected = new Set(expectedNames);
    for (const name of filesByName.keys()) {
        if (name.startsWith("Mora_") && !expected.has(name)) {
            throw new Error(`Unexpected Mora release asset: ${name}`);
        }
    }

    const indexedFiles = new Map();
    for (const name of expectedNames) {
        const paths = filesByName.get(name) ?? [];
        if (paths.length === 0) {
            throw new Error(`Missing required release asset: ${name}`);
        }
        if (paths.length > 1) {
            throw new Error(`Duplicate release asset: ${name}`);
        }
        if (name.endsWith(".sig") && !(await readFile(paths[0], "utf8")).trim()) {
            throw new Error(`Empty updater signature: ${name}`);
        }
        indexedFiles.set(name, paths[0]);
    }

    return indexedFiles;
}

export async function assembleRelease({
    artifactsDir,
    outputDir,
    repository,
    releaseTag,
    version,
    notes,
    pubDate,
}) {
    validateReleaseIdentity({ repository, releaseTag, version });
    await assertEmptyOutputDirectory(outputDir);
    const assetNames = expectedAssetNames(version);
    const indexedFiles = await indexReleaseAssets(artifactsDir, assetNames);
    const assetsDir = join(outputDir, "assets");
    await mkdir(assetsDir, { recursive: true });

    const assetPaths = [];
    for (const name of assetNames) {
        const destination = join(assetsDir, name);
        await copyFile(indexedFiles.get(name), destination);
        assetPaths.push(destination);
    }

    const releaseNotes = notes.trim();
    const entry = async (assetName) => ({
        signature: (await readFile(indexedFiles.get(`${assetName}.sig`), "utf8")).trim(),
        url: downloadUrl(repository, releaseTag, assetName),
    });
    const windowsNsis = await entry(`Mora_${version}_x64-setup.exe`);
    const windowsMsi = await entry(`Mora_${version}_x64_zh-CN.msi`);
    const darwinArm = await entry(`Mora_${version}_aarch64.app.tar.gz`);
    const darwinIntel = await entry(`Mora_${version}_x64.app.tar.gz`);
    const linuxAppImage = await entry(`Mora_${version}_amd64.AppImage`);
    const linuxDeb = await entry(`Mora_${version}_amd64.deb`);
    const latest = {
        version,
        notes: releaseNotes,
        pub_date: pubDate,
        platforms: {
            "windows-x86_64": windowsNsis,
            "windows-x86_64-nsis": windowsNsis,
            "windows-x86_64-msi": windowsMsi,
            "darwin-aarch64": darwinArm,
            "darwin-aarch64-app": darwinArm,
            "darwin-x86_64": darwinIntel,
            "darwin-x86_64-app": darwinIntel,
            "linux-x86_64": linuxAppImage,
            "linux-x86_64-appimage": linuxAppImage,
            "linux-x86_64-deb": linuxDeb,
        },
    };
    const latestJsonPath = join(outputDir, "latest.json");
    await writeFile(latestJsonPath, `${JSON.stringify(latest, null, 2)}\n`);
    await writeFile(join(outputDir, "release-notes.md"), `${releaseNotes}\n`);

    return { assetPaths, latestJsonPath };
}

async function runCli(args) {
    const options = parseCliOptions(args);
    const scriptPath = fileURLToPath(import.meta.url);
    const repositoryRoot = dirname(dirname(scriptPath));
    const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, "package.json"), "utf8"),
    );
    const preamble = await readFile(resolve(options.notesFile), "utf8");
    const generatedNotes = options.generatedNotesFile
        ? await readFile(resolve(options.generatedNotesFile), "utf8")
        : "";
    const result = await assembleRelease({
        artifactsDir: resolve(options.artifactsDir),
        outputDir: resolve(options.outputDir),
        repository: options.repository,
        releaseTag: options.releaseTag,
        version: packageJson.version,
        notes: combineNotes(preamble, generatedNotes),
        pubDate: new Date().toISOString(),
    });
    console.log(
        `Prepared ${result.assetPaths.length} release assets and ${result.latestJsonPath}`,
    );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
    try {
        await runCli(process.argv.slice(2));
    } catch (error) {
        console.error(`Release assembly failed: ${error.message}`);
        process.exitCode = 1;
    }
}
