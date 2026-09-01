import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
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

test("fails when Cargo reports success without producing the selected binary", async () => {
    const rootDir = await createRepository("mora-agent-missing-");

    await assert.rejects(
        prepareAgentSidecar({
            rootDir,
            env: { TAURI_ENV_TARGET_TRIPLE: WINDOWS_TARGET },
            args: [],
            runCommand: async (command) =>
                command === "rustc" ? success(WINDOWS_TARGET) : success(),
        }),
        /Compiled mora-agent is missing/,
    );
});

test("check mode rejects artifacts from a different target", async () => {
    const rootDir = await createRepository("mora-agent-wrong-target-");
    await writeExecutable(compiledPath(rootDir, LINUX_TARGET), "linux-agent");
    await writeExecutable(sidecarPath(rootDir, LINUX_TARGET), "linux-agent");

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
});

test("check mode rejects a stale sidecar without building or copying", async () => {
    const rootDir = await createRepository("mora-agent-stale-");
    await writeExecutable(compiledPath(rootDir, WINDOWS_TARGET), "fresh-agent");
    await writeExecutable(sidecarPath(rootDir, WINDOWS_TARGET), "stale-agent");

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
});

test("check mode accepts matching artifacts without mutating them", async () => {
    const rootDir = await createRepository("mora-agent-check-");
    const source = compiledPath(rootDir, LINUX_TARGET);
    const sidecar = sidecarPath(rootDir, LINUX_TARGET);
    await writeExecutable(source, "linux-agent");
    await writeExecutable(sidecar, "linux-agent");
    const before = await stat(sidecar);

    await prepareAgentSidecar({
        rootDir,
        env: {},
        args: ["--check", "--target", LINUX_TARGET],
        runCommand: async (command) => {
            assert.equal(command, "rustc");
            return success(WINDOWS_TARGET);
        },
    });

    assert.equal((await stat(sidecar)).mtimeMs, before.mtimeMs);
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

async function createDirectoryLink(target, path) {
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function success(stdout = "") {
    return { status: 0, stdout, stderr: "" };
}

function failure(status) {
    return { status, stdout: "", stderr: "build failed" };
}
