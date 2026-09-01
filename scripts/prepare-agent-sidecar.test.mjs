import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";

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

async function createRepository(prefix) {
    const rootDir = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(rootDir, "src-tauri", "binaries"), { recursive: true });
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
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, { mode: 0o755 });
}

function success(stdout = "") {
    return { status: 0, stdout, stderr: "" };
}

function failure(status) {
    return { status, stdout: "", stderr: "build failed" };
}
