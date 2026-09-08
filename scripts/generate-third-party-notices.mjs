import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_NAME =
    /^(?:licen[cs]e|copying|notice|copyright|unlicen[cs]e|ofl|patents)(?:$|[.\-_ ])/i;
const OMIT_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "target",
    "tests",
    "test",
    "benches",
    "examples",
]);
const REVIEWED_LICENSES = new Set([
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "MPL-2.0",
    "Unlicense",
    "Zlib",
    "Unicode-3.0",
    "CC0-1.0",
    "0BSD",
    "BSL-1.0",
    "LLVM-exception",
    "OFL-1.1",
]);

function hash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function json(file) {
    return JSON.parse(readFileSync(file, "utf8"));
}

function licenseFiles(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const file = join(directory, entry.name);
            if (entry.isFile() && LICENSE_NAME.test(entry.name)) return [file];
            return entry.isDirectory() && !OMIT_DIRECTORIES.has(entry.name)
                ? licenseFiles(file)
                : [];
        })
        .sort();
}

function confinedPath(directory, file) {
    const absolute = resolve(directory, file);
    if (
        absolute !== resolve(directory) &&
        !absolute.startsWith(resolve(directory) + sep)
    ) {
        throw new Error(`License source path leaves its package: ${file}`);
    }
    return absolute;
}

function licenseTokens(expression) {
    return expression
        .replace(/[()]/g, " ")
        .split(/[\s/]+/)
        .filter(Boolean);
}

function validateLicense(expression, label) {
    if (typeof expression !== "string" || !expression.trim()) {
        throw new Error(`Missing declared license for ${label}`);
    }
    const unknown = licenseTokens(expression).filter(
        (token) =>
            !["AND", "OR", "WITH"].includes(token) && !REVIEWED_LICENSES.has(token),
    );
    if (unknown.length) throw new Error(`Unreviewed license for ${label}: ${expression}`);
}

export function runtimeRustPackages(metadata) {
    if (!metadata.resolve?.root)
        throw new Error("Cargo metadata has no resolved root package");
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
    const visited = new Set();
    function visit(id) {
        if (visited.has(id)) return;
        visited.add(id);
        const node = nodes.get(id);
        if (!node) throw new Error(`Cargo metadata is missing dependency node ${id}`);
        for (const dependency of node.deps) {
            if (dependency.dep_kinds.some((kind) => kind.kind === null))
                visit(dependency.pkg);
        }
    }
    visit(metadata.resolve.root);
    return [...visited]
        .filter((id) => id !== metadata.resolve.root)
        .map((id) => {
            const entry = packages.get(id);
            if (!entry) throw new Error(`Cargo metadata is missing package ${id}`);
            return entry;
        });
}

function readSupplement(directory, record) {
    const file = confinedPath(directory, record.path);
    const bytes = readFileSync(file);
    if (hash(bytes) !== record.sha256)
        throw new Error(`License source SHA-256 mismatch: ${record.path}`);
    if (!record.sourceUrl?.startsWith("https://"))
        throw new Error(`Missing license source URL: ${record.path}`);
    return { label: record.path, sourceUrl: record.sourceUrl, kind: record.kind, bytes };
}

export function generateNotices({ root = ROOT, metadata, target }) {
    if (!target) throw new Error("An explicit distribution target is required");
    const lockFile = join(root, "package-lock.json");
    const cargoLockFile = join(root, "src-tauri/Cargo.lock");
    const sourceDirectory = join(root, "third-party-license-sources");
    const indexFile = join(sourceDirectory, "index.json");
    const supplements = json(indexFile);
    if (supplements.version !== 1)
        throw new Error("Unsupported supplemental license index version");
    const packages = [];

    function addPackage(entry) {
        const label = `${entry.name}@${entry.version}`;
        const supplement = supplements.packages[`${entry.ecosystem}:${label}`];
        const texts = licenseFiles(entry.directory).map((file) => ({
            label: relative(entry.directory, file).replaceAll("\\", "/"),
            sourceUrl: entry.sourceUrl,
            kind: "bundled-package-file",
            bytes: readFileSync(file),
        }));
        if (entry.licenseFile) {
            const file = confinedPath(entry.directory, entry.licenseFile);
            if (
                !texts.some(
                    (text) =>
                        text.label ===
                        relative(entry.directory, file).replaceAll("\\", "/"),
                )
            ) {
                texts.push({
                    label: relative(entry.directory, file),
                    sourceUrl: entry.sourceUrl,
                    kind: "bundled-package-file",
                    bytes: readFileSync(file),
                });
            }
        }
        let license = entry.license;
        if (!license && supplement?.licenseFromText) {
            const evidence = supplement.files.map((file) =>
                readSupplement(sourceDirectory, file),
            );
            if (
                supplement.declaredLicense !== "MIT" ||
                !evidence.some((file) =>
                    file.bytes.toString("utf8").includes("The MIT License (MIT)"),
                )
            ) {
                throw new Error(`Unconfirmed license text for ${label}`);
            }
            license = supplement.declaredLicense;
        }
        validateLicense(license, label);
        if (supplement) {
            if (supplement.declaredLicense !== license)
                throw new Error(`Supplemental license declaration changed for ${label}`);
            if (
                supplement.selectedLicense &&
                !licenseTokens(license).includes(supplement.selectedLicense)
            ) {
                throw new Error(
                    `Selected license is not declared by ${label}: ${supplement.selectedLicense}`,
                );
            }
            if (entry.ecosystem === "rust" && supplement.revision) {
                const actual = json(join(entry.directory, ".cargo_vcs_info.json")).git
                    ?.sha1;
                if (actual !== supplement.revision)
                    throw new Error(`Supplemental source revision changed for ${label}`);
            }
            const declarations = (supplement.declarations ?? []).map((file) =>
                readSupplement(sourceDirectory, file),
            );
            if (
                supplement.selectedLicense &&
                !declarations.some((file) =>
                    file.bytes.toString("utf8").includes(license),
                )
            ) {
                throw new Error(`Original license declaration not found for ${label}`);
            }
            texts.push(
                ...supplement.files.map((file) => readSupplement(sourceDirectory, file)),
                ...declarations,
            );
        }
        if (!texts.length || texts.some((text) => !text.bytes.toString("utf8").trim())) {
            throw new Error(`Missing license text for ${label}`);
        }
        if (
            entry.name === "typst-assets" &&
            !texts.some((text) => text.label === "NOTICE")
        ) {
            throw new Error("typst-assets requires its complete embedded-font NOTICE");
        }
        if (
            entry.ecosystem === "npm" &&
            entry.name === "katex" &&
            !texts.some((text) => text.kind === "embedded-font-notice")
        ) {
            throw new Error("katex requires its independent bundled-font NOTICE");
        }
        if (
            entry.ecosystem === "rust" &&
            entry.name === "webview2-com-sys" &&
            ["vendor-source-record", "vendor-license", "vendor-notice"].some(
                (kind) => !texts.some((text) => text.kind === kind),
            )
        ) {
            throw new Error(
                "WebView2 native loader requires its source record, license and NOTICE",
            );
        }
        packages.push({
            ...entry,
            license,
            selectedLicense: supplement?.selectedLicense,
            texts,
        });
    }

    for (const [location, locked] of Object.entries(json(lockFile).packages)) {
        if (!location || locked.dev === true) continue;
        const directory = confinedPath(root, location);
        const installed = json(join(directory, "package.json"));
        if (installed.version !== locked.version)
            throw new Error(`Installed npm version differs from lock: ${location}`);
        addPackage({
            ecosystem: "npm",
            name: installed.name,
            version: locked.version,
            license: installed.license ?? locked.license,
            directory,
            sourceUrl: `https://www.npmjs.com/package/${installed.name}/v/${locked.version}`,
        });
    }
    for (const entry of runtimeRustPackages(metadata)) {
        addPackage({
            ecosystem: "rust",
            name: entry.name,
            version: entry.version,
            license: entry.license,
            licenseFile: entry.license_file,
            directory: dirname(entry.manifest_path),
            sourceUrl: `https://crates.io/crates/${entry.name}/${entry.version}`,
            sourceArchive: `https://crates.io/api/v1/crates/${entry.name}/${entry.version}/download`,
            authors: entry.authors,
        });
    }
    const fontsDirectory = join(root, "public/fonts");
    const fontTexts = licenseFiles(fontsDirectory).map((file) => ({
        label: relative(root, file).replaceAll("\\", "/"),
        sourceUrl: "https://github.com/subframe7536/maple-font/releases/tag/v7.9",
        kind: "bundled-font-file",
        bytes: readFileSync(file),
    }));
    if (existsSync(fontsDirectory) && !fontTexts.length)
        throw new Error("Bundled public/fonts have no license text");
    if (fontTexts.length)
        packages.push({
            ecosystem: "font",
            name: "Bundled public/fonts",
            version: "",
            license: "OFL-1.1",
            texts: fontTexts,
        });

    const lines = [
        "Mora — Third-Party Notices",
        `Distribution target: ${target}`,
        "Coverage: npm production-lock candidates and this target's normal Rust dependency closure.",
        "The inventory conservatively includes type definitions and normal proc-macro host dependencies.",
        "It is not a binary inclusion audit or a legal compliance determination.",
        "Mora's MIT license does not replace any third-party component or font license.",
        "MPL-2.0 source packages are available at the exact-version Source archive URLs listed below.",
        "Standard-license supplements are identified separately from upstream license files.",
        `package-lock.json SHA-256: ${hash(readFileSync(lockFile))}`,
        `Cargo.lock SHA-256: ${hash(readFileSync(cargoLockFile))}`,
        `Supplement index SHA-256: ${hash(readFileSync(indexFile))}`,
        "",
    ];
    const fullTexts = new Map();
    packages.sort((left, right) =>
        `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
            `${right.ecosystem}:${right.name}@${right.version}`,
            "en",
        ),
    );
    for (const entry of packages) {
        lines.push(
            `${entry.ecosystem}: ${entry.name}${entry.version ? `@${entry.version}` : ""}`,
            `Declared license: ${entry.license}`,
        );
        if (entry.selectedLicense)
            lines.push(`Selected standard-license option: ${entry.selectedLicense}`);
        if (entry.sourceUrl) lines.push(`Package source: ${entry.sourceUrl}`);
        if (entry.sourceArchive) lines.push(`Source archive: ${entry.sourceArchive}`);
        if (entry.authors?.length)
            lines.push(`Package authors (metadata): ${entry.authors.join("; ")}`);
        for (const text of entry.texts) {
            const digest = hash(text.bytes);
            fullTexts.set(digest, text.bytes.toString("utf8"));
            lines.push(
                `  ${text.kind}: ${text.label}`,
                `  Source: ${text.sourceUrl}`,
                `  Full text: SHA-256 ${digest}`,
            );
        }
        lines.push("");
    }
    lines.push("Complete license, notice, and original declaration texts", "");
    for (const [digest, text] of [...fullTexts].sort(([left], [right]) =>
        left.localeCompare(right),
    )) {
        lines.push(`========== SHA-256 ${digest} ==========`, text, "");
    }
    return lines.join("\n");
}

export function writeNotices(options) {
    const output = join(options.root ?? ROOT, "THIRD_PARTY_NOTICES.txt");
    const expected = generateNotices(options);
    const unchanged = existsSync(output) && readFileSync(output, "utf8") === expected;
    if (options.check) {
        if (!unchanged) {
            throw new Error(
                "THIRD_PARTY_NOTICES.txt is out of date; regenerate it for this target",
            );
        }
    } else if (!unchanged) {
        writeFileSync(output, expected);
    }
    return output;
}

function main(args) {
    let target = process.env.TAURI_ENV_TARGET_TRIPLE;
    let check = false;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--check") check = true;
        else if (args[index] === "--target" && args[index + 1]) target = args[++index];
        else throw new Error(`Unknown or incomplete option: ${args[index]}`);
    }
    const commandOptions = {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
    };
    if (!target)
        target = execFileSync("rustc", ["-vV"], commandOptions).match(
            /^host: (.+)$/m,
        )?.[1];
    if (!target || !/^[a-zA-Z0-9_.-]+$/.test(target))
        throw new Error("Cannot determine a valid Rust target triple");
    const metadata = JSON.parse(
        execFileSync(
            "cargo",
            [
                "metadata",
                "--manifest-path",
                "src-tauri/Cargo.toml",
                "--format-version",
                "1",
                "--locked",
                "--offline",
                "--filter-platform",
                target,
            ],
            commandOptions,
        ),
    );
    const file = writeNotices({ root: ROOT, metadata, target, check });
    console.log(`${check ? "Verified" : "Generated"} ${file} for ${target}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
