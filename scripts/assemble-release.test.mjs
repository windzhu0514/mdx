import assert from "node:assert/strict";
import {
    copyFile,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleRelease, combineNotes, parseCliOptions } from "./assemble-release.mjs";

const VERSION = "1.2.3";
const RELEASE_TAG = `app-v${VERSION}`;
const REPOSITORY = "example/mora";
const PUB_DATE = "2026-09-06T01:02:03.000Z";
const EXPECTED_ASSETS = [
    `Mora_${VERSION}_x64-setup.exe`,
    `Mora_${VERSION}_x64-setup.exe.sig`,
    `Mora_${VERSION}_x64_zh-CN.msi`,
    `Mora_${VERSION}_x64_zh-CN.msi.sig`,
    `Mora_${VERSION}_aarch64.dmg`,
    `Mora_${VERSION}_aarch64.app.tar.gz`,
    `Mora_${VERSION}_aarch64.app.tar.gz.sig`,
    `Mora_${VERSION}_x64.dmg`,
    `Mora_${VERSION}_x64.app.tar.gz`,
    `Mora_${VERSION}_x64.app.tar.gz.sig`,
    `Mora_${VERSION}_amd64.AppImage`,
    `Mora_${VERSION}_amd64.AppImage.sig`,
    `Mora_${VERSION}_amd64.deb`,
    `Mora_${VERSION}_amd64.deb.sig`,
];

const temporaryRoots = [];

test.afterEach(async () => {
    await Promise.all(
        temporaryRoots
            .splice(0)
            .map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "mora-release-assembler-"));
    temporaryRoots.push(root);
    const artifactsDir = join(root, "input");
    const outputDir = join(root, "output");

    for (const [index, name] of EXPECTED_ASSETS.entries()) {
        const directory = join(artifactsDir, `platform-${index % 4}`);
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, name),
            name.endsWith(".sig") ? `  signature:${name}  \n` : `bundle:${name}`,
        );
    }

    return { artifactsDir, outputDir };
}

function fixtureAssetPath(artifactsDir, name) {
    const index = EXPECTED_ASSETS.indexOf(name);
    return join(artifactsDir, `platform-${index % 4}`, name);
}

function assembleFixture({ artifactsDir, outputDir, ...overrides }) {
    return assembleRelease({
        artifactsDir,
        outputDir,
        repository: REPOSITORY,
        releaseTag: RELEASE_TAG,
        version: VERSION,
        notes: "安装说明",
        pubDate: PUB_DATE,
        ...overrides,
    });
}

test("assembles a complete release and deterministic updater metadata", async () => {
    const { artifactsDir, outputDir } = await createFixture();

    const result = await assembleRelease({
        artifactsDir,
        outputDir,
        repository: REPOSITORY,
        releaseTag: RELEASE_TAG,
        version: VERSION,
        notes: "安装说明\n\n自动生成的变更记录",
        pubDate: PUB_DATE,
    });

    assert.deepEqual(
        (await readdir(join(outputDir, "assets"))).sort(),
        [...EXPECTED_ASSETS].sort(),
    );
    assert.deepEqual(
        result.assetPaths.map((path) => path.split(/[\\/]/).at(-1)).sort(),
        [...EXPECTED_ASSETS].sort(),
    );
    assert.equal(result.latestJsonPath, join(outputDir, "latest.json"));
    assert.equal(
        await readFile(join(outputDir, "release-notes.md"), "utf8"),
        "安装说明\n\n自动生成的变更记录\n",
    );

    const latest = JSON.parse(await readFile(result.latestJsonPath, "utf8"));
    assert.equal(latest.version, VERSION);
    assert.equal(latest.notes, "安装说明\n\n自动生成的变更记录");
    assert.equal(latest.pub_date, PUB_DATE);
    assert.deepEqual(Object.keys(latest.platforms), [
        "windows-x86_64",
        "windows-x86_64-nsis",
        "windows-x86_64-msi",
        "darwin-aarch64",
        "darwin-aarch64-app",
        "darwin-x86_64",
        "darwin-x86_64-app",
        "linux-x86_64",
        "linux-x86_64-appimage",
        "linux-x86_64-deb",
    ]);
    assert.deepEqual(latest.platforms["windows-x86_64"], {
        signature: `signature:Mora_${VERSION}_x64-setup.exe.sig`,
        url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/Mora_${VERSION}_x64-setup.exe`,
    });
    assert.deepEqual(
        latest.platforms["windows-x86_64"],
        latest.platforms["windows-x86_64-nsis"],
    );
    assert.deepEqual(latest.platforms["darwin-aarch64"], {
        signature: `signature:Mora_${VERSION}_aarch64.app.tar.gz.sig`,
        url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/Mora_${VERSION}_aarch64.app.tar.gz`,
    });
    assert.deepEqual(latest.platforms["linux-x86_64-deb"], {
        signature: `signature:Mora_${VERSION}_amd64.deb.sig`,
        url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/Mora_${VERSION}_amd64.deb`,
    });
});

test("rejects a release with a missing required asset", async () => {
    const { artifactsDir, outputDir } = await createFixture();
    const missing = `Mora_${VERSION}_x64.dmg`;
    await unlink(fixtureAssetPath(artifactsDir, missing));

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir }),
        new RegExp(`Missing required release asset: ${missing.replace(".", "\\.")}`),
    );
});

test("rejects duplicate required basenames", async () => {
    const { artifactsDir, outputDir } = await createFixture();
    const duplicated = `Mora_${VERSION}_amd64.deb`;
    const duplicateDirectory = join(artifactsDir, "duplicate");
    await mkdir(duplicateDirectory);
    await copyFile(
        fixtureAssetPath(artifactsDir, duplicated),
        join(duplicateDirectory, duplicated),
    );

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir }),
        new RegExp(`Duplicate release asset: ${duplicated.replace(".", "\\.")}`),
    );
});

test("rejects Mora assets from another version", async () => {
    const { artifactsDir, outputDir } = await createFixture();
    await writeFile(join(artifactsDir, "Mora_9.9.9_x64-setup.exe"), "old bundle");

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir }),
        /Unexpected Mora release asset: Mora_9\.9\.9_x64-setup\.exe/,
    );
});

test("rejects an empty updater signature", async () => {
    const { artifactsDir, outputDir } = await createFixture();
    const emptySignature = `Mora_${VERSION}_amd64.AppImage.sig`;
    await writeFile(fixtureAssetPath(artifactsDir, emptySignature), " \n");

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir }),
        new RegExp(`Empty updater signature: ${emptySignature.replace(".", "\\.")}`),
    );
});

test("rejects a tag that does not match the package version", async () => {
    const { artifactsDir, outputDir } = await createFixture();

    await assert.rejects(
        assembleFixture({
            artifactsDir,
            outputDir,
            releaseTag: "app-v1.2.4",
        }),
        /Release tag must be app-v1\.2\.3/,
    );
});

test("rejects an invalid GitHub repository name", async () => {
    const { artifactsDir, outputDir } = await createFixture();

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir, repository: "mora" }),
        /Repository must use owner\/repository format/,
    );
});

test("rejects a non-empty output directory", async () => {
    const { artifactsDir, outputDir } = await createFixture();
    await mkdir(outputDir);
    await writeFile(join(outputDir, "existing.txt"), "do not overwrite");

    await assert.rejects(
        assembleFixture({ artifactsDir, outputDir }),
        /Release output directory must be empty/,
    );
});

test("parses the release assembler CLI contract", () => {
    assert.deepEqual(
        parseCliOptions([
            "--artifacts-dir",
            "release-input",
            "--output-dir",
            "release-output",
            "--repository",
            REPOSITORY,
            "--tag",
            RELEASE_TAG,
            "--notes-file",
            ".github/release-preamble.md",
            "--generated-notes-file",
            "generated-release-notes.md",
        ]),
        {
            artifactsDir: "release-input",
            outputDir: "release-output",
            repository: REPOSITORY,
            releaseTag: RELEASE_TAG,
            notesFile: ".github/release-preamble.md",
            generatedNotesFile: "generated-release-notes.md",
        },
    );
});

test("rejects missing, repeated, and unknown CLI options", () => {
    assert.throws(() => parseCliOptions([]), /Missing required option: --artifacts-dir/);
    assert.throws(
        () => parseCliOptions(["--artifacts-dir", "one", "--artifacts-dir", "two"]),
        /Repeated option: --artifacts-dir/,
    );
    assert.throws(
        () => parseCliOptions(["--unknown", "value"]),
        /Unknown option: --unknown/,
    );
});

test("combines only non-empty release note sections", () => {
    assert.equal(combineNotes("安装说明\n", "\n变更记录\n"), "安装说明\n\n变更记录");
    assert.equal(combineNotes("安装说明", "  "), "安装说明");
});
