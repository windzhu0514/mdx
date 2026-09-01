import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    access,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    stat,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
    cargoBuildArgs,
    prepareAgentSidecar,
    sidecarFileName,
} from "./prepare-agent-sidecar.mjs";

const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const LINUX_TARGET = "x86_64-unknown-linux-gnu";

test("derives platform-specific sidecar names and explicit Cargo arguments", () => {
    assert.equal(
        sidecarFileName(WINDOWS_TARGET),
        "mora-agent-x86_64-pc-windows-msvc.exe",
    );
    assert.equal(
        sidecarFileName("aarch64-apple-darwin"),
        "mora-agent-aarch64-apple-darwin",
    );
    assert.deepEqual(cargoBuildArgs(LINUX_TARGET, false), [
        "build",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        "mora-agent",
        "--features",
        "agent-bin",
        "--release",
        "--target",
        LINUX_TARGET,
    ]);
    assert.deepEqual(cargoBuildArgs(WINDOWS_TARGET, true), [
        "build",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        "mora-agent",
        "--features",
        "agent-bin",
        "--target",
        WINDOWS_TARGET,
    ]);
});

test("rejects target paths and malformed triples before running commands", async () => {
    const invalidTargets = [
        ".",
        "..",
        "../x86_64-pc-windows-msvc",
        "/tmp/custom-target.json",
        "C:\\temp\\custom-target.json",
        "C:/temp/custom-target.json",
        "x86_64\\pc\\windows\\msvc",
        "x86_64-pc-windows-msvc.json",
        "x86_64--windows-msvc",
        "x86_64-windows",
        "x86_64-pc-windows-msvc\0outside",
        "x86_64:pc:windows:msvc",
    ];

    for (const target of invalidTargets) {
        assert.throws(() => sidecarFileName(target), /Invalid Rust target triple/);
        assert.throws(() => cargoBuildArgs(target, false), /Invalid Rust target triple/);
    }

    const rootDir = await createRepository("mora-agent-invalid-env-");
    const sentinel = join(rootDir, "outside-sentinel.txt");
    await writeFile(sentinel, "do-not-touch");
    let commandRan = false;
    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: "../outside" },
            runCommand: async () => {
                commandRan = true;
                return success(WINDOWS_TARGET);
            },
        }),
        /Invalid Rust target triple/,
    );
    assert.equal(commandRan, false);
    assert.equal(await readFile(sentinel, "utf8"), "do-not-touch");
});

test("supports an external Cargo target root containing spaces", async () => {
    const rootDir = await createRepository("mora-agent-external-root-");
    const targetDir = await mkdtemp(join(tmpdir(), "mora cargo target "));
    const result = await prepareAgentSidecar({
        rootDir,
        env: {
            CARGO_TARGET_DIR: targetDir,
            TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET,
        },
        runCommand: async (command) => {
            if (command === "rustc") {
                return success(WINDOWS_TARGET);
            }
            if (command === "cargo") {
                await writeExecutable(
                    join(targetDir, WINDOWS_TARGET, "release", "mora-agent.exe"),
                    "external-target-agent",
                );
            }
            return success();
        },
    });

    assert.equal(
        result.compiledPath,
        join(targetDir, WINDOWS_TARGET, "release", "mora-agent.exe"),
    );
    assert.equal(await readFile(result.nativePath, "utf8"), "external-target-agent");
});

test("rejects a binaries directory symlink without touching its external sentinel", async () => {
    const rootDir = await createRepository("mora-agent-binaries-link-", false);
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-external-bin-"));
    const externalSidecar = join(externalDir, "mora-agent-x86_64-pc-windows-msvc.exe");
    await writeExecutable(externalSidecar, "external-sidecar");
    await createDirectoryLink(externalDir, join(rootDir, "src-tauri", "binaries"));

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /symbolic link/,
    );
    assert.equal(await readFile(externalSidecar, "utf8"), "external-sidecar");
});

test("rejects a target triple directory symlink without deleting outside the target root", async () => {
    const rootDir = await createRepository("mora-agent-target-link-");
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-external-target-"));
    const externalAgent = join(externalDir, "release", "mora-agent.exe");
    await writeExecutable(externalAgent, "external-agent");
    const tripleDir = join(rootDir, "src-tauri", "target", WINDOWS_TARGET);
    await mkdir(dirname(tripleDir), { recursive: true });
    await createDirectoryLink(externalDir, tripleDir);
    const staleSidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    await writeExecutable(staleSidecar, "stale-sidecar");

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /symbolic link/,
    );
    assert.equal(await readFile(externalAgent, "utf8"), "external-agent");
    await assert.rejects(stat(staleSidecar), /ENOENT/);
});

test("builds the selected native target and prepares both documented outputs", async () => {
    const rootDir = await createRepository("mora agent packaging ");
    const calls = [];
    const runCommand = async (command, args, options) => {
        calls.push([command, args, options]);
        if (command === "rustc") {
            return success(WINDOWS_TARGET);
        }
        if (command === "cargo") {
            const compiled = join(
                rootDir,
                "src-tauri",
                "target",
                WINDOWS_TARGET,
                "release",
                "mora-agent.exe",
            );
            await writeExecutable(compiled, "fresh-agent");
            return success();
        }
        return success("mora-agent help");
    };

    const result = await prepareAgentSidecar({
        rootDir,
        env: {
            TAURI_CONFIG: JSON.stringify({
                build: { features: ["existing-feature"] },
                bundle: { targets: ["nsis"] },
            }),
        },
        args: [],
        runCommand,
    });

    assert.deepEqual(calls[1].slice(0, 2), [
        "cargo",
        cargoBuildArgs(WINDOWS_TARGET, false),
    ]);
    assert.deepEqual(JSON.parse(calls[1][2].env.TAURI_CONFIG), {
        build: { features: ["existing-feature"] },
        bundle: { targets: ["nsis"], externalBin: [] },
    });
    assert.deepEqual(calls.at(-1)?.[1], ["--help"]);
    assert.equal(await readFile(result.sidecarPath, "utf8"), "fresh-agent");
    assert.equal(await readFile(result.nativePath, "utf8"), "fresh-agent");
});

test("removes stale outputs and propagates a Cargo build failure", async () => {
    const rootDir = await createRepository("mora-agent-failure-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "stale-source"),
        writeExecutable(sidecar, "stale-sidecar"),
        writeExecutable(native, "stale-native"),
    ]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            args: [],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : failure(7),
        }),
        /cargo build failed with exit code 7/,
    );

    await assert.rejects(stat(source), /ENOENT/);
    await assert.rejects(stat(sidecar), /ENOENT/);
    await assert.rejects(stat(native), /ENOENT/);
});

test("cleans exact stale artifacts when rustc cannot start", async () => {
    const rootDir = await createRepository("mora-agent-rustc-spawn-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "stale-source"),
        writeExecutable(sidecar, "stale-sidecar"),
        writeExecutable(native, "stale-native"),
    ]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            args: ["--target", WINDOWS_TARGET],
            env: {},
            runCommand: async () => ({
                status: null,
                stdout: "",
                stderr: "",
                error: Object.assign(new Error("spawn rustc ENOENT"), {
                    code: "ENOENT",
                }),
            }),
        }),
        /rustc --print host-tuple failed/,
    );

    await Promise.all([
        assertMissing(source),
        assertMissing(sidecar),
        assertMissing(native),
    ]);
});

for (const [name, rustcResult, expectedError] of [
    ["nonzero", failure(9), /exit code 9/],
    ["empty", success("  \r\n"), /empty target triple/],
]) {
    test(`narrowly scans Agent artifacts after ${name} rustc host detection failure`, async () => {
        const rootDir = await createRepository(`mora-agent-rustc-${name}-`);
        const targetRoot = join(rootDir, "src-tauri", "target");
        const windowsAgent = compiledPath(rootDir, WINDOWS_TARGET);
        const linuxAgent = compiledPath(rootDir, LINUX_TARGET);
        const nativeAgent = join(targetRoot, "release", "mora-agent.exe");
        const unrelatedCargoBinary = join(
            targetRoot,
            WINDOWS_TARGET,
            "release",
            "keep-me.exe",
        );
        const unrelatedBinaryAsset = join(
            rootDir,
            "src-tauri",
            "binaries",
            "source-asset.dat",
        );
        await Promise.all([
            writeExecutable(windowsAgent, "windows-agent"),
            writeExecutable(linuxAgent, "linux-agent"),
            writeExecutable(nativeAgent, "native-agent"),
            writeExecutable(sidecarPath(rootDir, WINDOWS_TARGET), "windows-sidecar"),
            writeExecutable(sidecarPath(rootDir, LINUX_TARGET), "linux-sidecar"),
            writeExecutable(unrelatedCargoBinary, "keep-cargo"),
            writeExecutable(unrelatedBinaryAsset, "keep-asset"),
        ]);

        await assert.rejects(
            prepareAgentSidecar({
                rootDir,
                env: {},
                runCommand: async () => rustcResult,
            }),
            expectedError,
        );

        await Promise.all([
            assertMissing(windowsAgent),
            assertMissing(linuxAgent),
            assertMissing(nativeAgent),
            assertMissing(sidecarPath(rootDir, WINDOWS_TARGET)),
            assertMissing(sidecarPath(rootDir, LINUX_TARGET)),
        ]);
        assert.equal(await readFile(unrelatedCargoBinary, "utf8"), "keep-cargo");
        assert.equal(await readFile(unrelatedBinaryAsset, "utf8"), "keep-asset");
    });
}

test("continues best-effort cleanup after the first unlink failure", async () => {
    const rootDir = await createRepository("mora-agent-cleanup-once-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "stale-source"),
        writeExecutable(sidecar, "stale-sidecar"),
        writeExecutable(native, "stale-native"),
    ]);
    let unlinkCalls = 0;
    let cargoRan = false;

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            fileSystem: {
                unlink: async (path) => {
                    unlinkCalls += 1;
                    if (unlinkCalls === 1) {
                        throw Object.assign(new Error("injected first unlink failure"), {
                            code: "EPERM",
                        });
                    }
                    return unlink(path);
                },
            },
            runCommand: async (command) => {
                if (command === "rustc") {
                    return success(WINDOWS_TARGET);
                }
                cargoRan = true;
                return success();
            },
        }),
        /injected first unlink failure/,
    );

    assert.equal(cargoRan, false);
    await Promise.all([
        assertMissing(source),
        assertMissing(sidecar),
        assertMissing(native),
    ]);
});

test("reports persistent cleanup errors after removing every packagable stale artifact", async () => {
    const rootDir = await createRepository("mora-agent-cleanup-persistent-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "stale-source"),
        writeExecutable(sidecar, "stale-sidecar"),
        writeExecutable(native, "stale-native"),
    ]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            fileSystem: {
                unlink: async (path) => {
                    if (path === source) {
                        throw Object.assign(
                            new Error("persistent source cleanup failure"),
                            {
                                code: "EPERM",
                            },
                        );
                    }
                    return unlink(path);
                },
            },
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /persistent source cleanup failure/,
    );

    assert.equal(await readFile(source, "utf8"), "stale-source");
    await Promise.all([assertMissing(sidecar), assertMissing(native)]);
});

test("fails with the missing-file cause when Cargo omits the selected binary", async () => {
    const rootDir = await createRepository("mora-agent-missing-");

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            args: [],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        (error) => {
            assert.match(error.message, /Compiled mora-agent is missing/);
            assert.equal(error.cause?.code, "ENOENT");
            return true;
        },
    );
});

test("check mode keeps every Agent artifact unchanged when rustc host detection fails", async () => {
    const rootDir = await createRepository("mora-agent-check-rustc-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "source-before-rustc-failure"),
        writeExecutable(sidecar, "sidecar-before-rustc-failure"),
        writeExecutable(native, "native-before-rustc-failure"),
    ]);
    const before = await snapshotFiles([source, sidecar, native]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            runCommand: async () => failure(8),
        }),
        /rustc --print host-tuple failed with exit code 8/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps files unchanged when a controlled path is a junction", async () => {
    const rootDir = await createRepository("mora-agent-check-path-", false);
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    await writeExecutable(source, "source-before-path-failure");
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-check-external-"));
    const externalSidecar = join(externalDir, "mora-agent-x86_64-pc-windows-msvc.exe");
    await writeExecutable(externalSidecar, "external-sidecar-before-check");
    await createDirectoryLink(externalDir, join(rootDir, "src-tauri", "binaries"));
    const before = await snapshotFiles([source, externalSidecar]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            runCommand: async () => success(WINDOWS_TARGET),
        }),
        /symbolic link/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps unrelated and selected artifacts unchanged when one is missing", async () => {
    const rootDir = await createRepository("mora-agent-wrong-target-");
    const missingSource = compiledPath(rootDir, WINDOWS_TARGET);
    const selectedSidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    const linuxSource = compiledPath(rootDir, LINUX_TARGET);
    const linuxSidecar = sidecarPath(rootDir, LINUX_TARGET);
    await Promise.all([
        writeExecutable(selectedSidecar, "selected-sidecar-before-missing-check"),
        writeExecutable(native, "native-before-missing-check"),
        writeExecutable(linuxSource, "linux-agent"),
        writeExecutable(linuxSidecar, "linux-agent"),
    ]);
    const before = await snapshotFiles([
        missingSource,
        selectedSidecar,
        native,
        linuxSource,
        linuxSidecar,
    ]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /Compiled mora-agent is missing/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps stale mismatched artifacts byte-for-byte unchanged", async () => {
    const rootDir = await createRepository("mora-agent-stale-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "fresh-agent"),
        writeExecutable(sidecar, "stale-agent"),
        writeExecutable(native, "native-agent"),
    ]);
    const before = await snapshotFiles([source, sidecar, native]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /does not match the compiled mora-agent/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps artifacts unchanged when executable permission validation fails", async () => {
    const rootDir = await createRepository("mora-agent-check-permission-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    await Promise.all([
        writeExecutable(source, "same-agent"),
        writeExecutable(sidecar, "same-agent"),
    ]);
    const before = await snapshotFiles([source, sidecar]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            fileSystem: {
                access: async (path, mode) => {
                    if (path === source) {
                        throw Object.assign(new Error("injected access denied"), {
                            code: "EACCES",
                        });
                    }
                    return access(path, mode);
                },
            },
            runCommand: async () => success(WINDOWS_TARGET),
        }),
        /not executable/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps native artifacts unchanged when --help fails", async () => {
    const rootDir = await createRepository("mora-agent-check-help-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const native = join(rootDir, "src-tauri", "target", "release", "mora-agent.exe");
    await Promise.all([
        writeExecutable(source, "same-agent"),
        writeExecutable(sidecar, "same-agent"),
        writeExecutable(native, "native-agent"),
    ]);
    const before = await snapshotFiles([source, sidecar, native]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : failure(12),
        }),
        /--help failed with exit code 12/,
    );

    await assertFilesUnchanged(before);
});

test("check mode keeps artifacts unchanged after an injected top-level read failure", async () => {
    const rootDir = await createRepository("mora-agent-check-read-");
    const source = compiledPath(rootDir, WINDOWS_TARGET);
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    await Promise.all([
        writeExecutable(source, "same-agent"),
        writeExecutable(sidecar, "same-agent"),
    ]);
    const before = await snapshotFiles([source, sidecar]);

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: {},
            args: ["--check", "--target", WINDOWS_TARGET],
            fileSystem: {
                readFile: async () => {
                    throw new Error("injected top-level read failure");
                },
            },
            runCommand: async () => success(WINDOWS_TARGET),
        }),
        /injected top-level read failure/,
    );

    await assertFilesUnchanged(before);
});

test("check mode accepts matching artifacts without mutating them", async () => {
    const rootDir = await createRepository("mora-agent-check-");
    const source = compiledPath(rootDir, LINUX_TARGET);
    const sidecar = sidecarPath(rootDir, LINUX_TARGET);
    await writeExecutable(source, "linux-agent");
    await writeExecutable(sidecar, "linux-agent");
    const before = await snapshotFiles([source, sidecar]);

    await prepareAgentSidecar({
        rootDir,
        env: {},
        args: ["--check", "--target", LINUX_TARGET],
        runCommand: async (command) => {
            assert.equal(command, "rustc");
            return success(WINDOWS_TARGET);
        },
    });

    await assertFilesUnchanged(before);
});

test("atomic copy replaces a raced target link without overwriting its external sentinel", async () => {
    const rootDir = await createRepository("mora-agent-copy-target-link-");
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-link-sentinel-"));
    const sentinel = join(externalDir, "sentinel.exe");
    await writeExecutable(sentinel, "external-sentinel");
    let cargoBuilt = false;
    let raceInjected = false;

    await prepareAgentSidecar({
        rootDir,
        env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
        fileSystem: {
            lstat: async (path) => {
                try {
                    return await lstat(path);
                } catch (error) {
                    if (
                        error?.code === "ENOENT" &&
                        cargoBuilt &&
                        path === sidecar &&
                        !raceInjected
                    ) {
                        await link(sentinel, sidecar);
                        raceInjected = true;
                    }
                    throw error;
                }
            },
        },
        runCommand: async (command) => {
            if (command === "rustc") {
                return success(WINDOWS_TARGET);
            }
            if (command === "cargo") {
                await writeExecutable(
                    compiledPath(rootDir, WINDOWS_TARGET),
                    "fresh-agent",
                );
                cargoBuilt = true;
            }
            return success();
        },
    });

    assert.equal(raceInjected, true);
    assert.equal(await readFile(sentinel, "utf8"), "external-sentinel");
    assert.equal(await readFile(sidecar, "utf8"), "fresh-agent");
});

test("copy fails closed when its destination parent becomes a junction", async () => {
    const rootDir = await createRepository("mora-agent-copy-parent-race-");
    const binariesRoot = join(rootDir, "src-tauri", "binaries");
    const backupRoot = join(rootDir, "src-tauri", "binaries-before-race");
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-copy-external-"));
    const externalSentinel = join(externalDir, "sentinel.txt");
    const externalSidecar = join(externalDir, sidecarFileName(WINDOWS_TARGET));
    await writeExecutable(externalSentinel, "external-sentinel");
    let cargoBuilt = false;
    let parentReplaced = false;

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            fileSystem: {
                lstat: async (path) => {
                    try {
                        return await lstat(path);
                    } catch (error) {
                        if (
                            error?.code === "ENOENT" &&
                            cargoBuilt &&
                            path === sidecar &&
                            !parentReplaced
                        ) {
                            await rename(binariesRoot, backupRoot);
                            await createDirectoryLink(externalDir, binariesRoot);
                            parentReplaced = true;
                        }
                        throw error;
                    }
                },
            },
            runCommand: async (command) => {
                if (command === "rustc") {
                    return success(WINDOWS_TARGET);
                }
                if (command === "cargo") {
                    await writeExecutable(
                        compiledPath(rootDir, WINDOWS_TARGET),
                        "fresh-agent",
                    );
                    cargoBuilt = true;
                }
                return success();
            },
        }),
        /symbolic link|parent changed/,
    );

    assert.equal(parentReplaced, true);
    assert.equal(await readFile(externalSentinel, "utf8"), "external-sentinel");
    await assertMissing(externalSidecar);
});

test("cleanup revalidates a replaced parent immediately before unlink", async () => {
    const rootDir = await createRepository("mora-agent-delete-parent-race-");
    const binariesRoot = join(rootDir, "src-tauri", "binaries");
    const backupRoot = join(rootDir, "src-tauri", "binaries-before-delete-race");
    const sidecar = sidecarPath(rootDir, WINDOWS_TARGET);
    await writeExecutable(sidecar, "controlled-stale-sidecar");
    const externalDir = await mkdtemp(join(tmpdir(), "mora-agent-delete-external-"));
    const externalSidecar = join(externalDir, sidecarFileName(WINDOWS_TARGET));
    await writeExecutable(externalSidecar, "external-sentinel-sidecar");
    let parentReplaced = false;

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            fileSystem: {
                lstat: async (path) => {
                    const result = await lstat(path);
                    if (path === sidecar && !parentReplaced) {
                        await rename(binariesRoot, backupRoot);
                        await createDirectoryLink(externalDir, binariesRoot);
                        parentReplaced = true;
                    }
                    return result;
                },
            },
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : failure(7),
        }),
        /symbolic link|cleanup/,
    );

    assert.equal(parentReplaced, true);
    assert.equal(await readFile(externalSidecar, "utf8"), "external-sentinel-sidecar");
});

test("atomic copy removes its exclusive temporary file when rename fails", async () => {
    const rootDir = await createRepository("mora-agent-copy-temp-cleanup-");
    const binariesRoot = join(rootDir, "src-tauri", "binaries");

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            fileSystem: {
                rename: async () => {
                    throw Object.assign(new Error("injected atomic rename failure"), {
                        code: "EPERM",
                    });
                },
            },
            runCommand: async (command) => {
                if (command === "rustc") {
                    return success(WINDOWS_TARGET);
                }
                if (command === "cargo") {
                    await writeExecutable(
                        compiledPath(rootDir, WINDOWS_TARGET),
                        "fresh-agent",
                    );
                }
                return success();
            },
        }),
        /injected atomic rename failure/,
    );

    assert.deepEqual(await readdir(binariesRoot), []);
});

async function createRepository(prefix, createBinaries = true) {
    const rootDir = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(rootDir, "src-tauri"), { recursive: true });
    if (createBinaries) {
        await mkdir(join(rootDir, "src-tauri", "binaries"), { recursive: true });
    }
    return rootDir;
}

function compiledPath(rootDir, target) {
    return join(
        rootDir,
        "src-tauri",
        "target",
        target,
        "release",
        target.includes("-windows-") ? "mora-agent.exe" : "mora-agent",
    );
}

function sidecarPath(rootDir, target) {
    return join(rootDir, "src-tauri", "binaries", sidecarFileName(target));
}

async function writeExecutable(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o755 });
}

async function assertMissing(path) {
    await assert.rejects(stat(path), /ENOENT/);
}

async function snapshotFiles(paths) {
    return Promise.all(
        paths.map(async (path) => {
            try {
                const [fileStat, content] = await Promise.all([
                    stat(path),
                    readFile(path),
                ]);
                return {
                    path,
                    exists: true,
                    hash: createHash("sha256").update(content).digest("hex"),
                    mtimeMs: fileStat.mtimeMs,
                    size: fileStat.size,
                };
            } catch (error) {
                if (error?.code === "ENOENT") {
                    return { path, exists: false };
                }
                throw error;
            }
        }),
    );
}

async function assertFilesUnchanged(snapshots) {
    for (const before of snapshots) {
        const [after] = await snapshotFiles([before.path]);
        assert.deepEqual(after, before);
    }
}

async function createDirectoryLink(target, path) {
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function success(stdout = "") {
    return { status: 0, stdout, stderr: "" };
}

function failure(status) {
    return { status, stdout: "", stderr: "build failed" };
}
