import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENT_NAME = "mora-agent";

export function sidecarFileName(target) {
    return `${AGENT_NAME}-${target}${executableSuffix(target)}`;
}

export function cargoBuildArgs(target, debug) {
    const args = [
        "build",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        AGENT_NAME,
    ];
    if (!debug) {
        args.push("--release");
    }
    args.push("--target", target);
    return args;
}

export async function prepareAgentSidecar({
    rootDir = repositoryRoot(),
    env = process.env,
    args = process.argv.slice(2),
    runCommand = runProcess,
} = {}) {
    const options = parseArgs(args);
    const hostTarget = await readHostTarget(rootDir, env, runCommand);
    const target = options.target ?? env.TAURI_ENV_TARGET_TRIPLE?.trim() ?? hostTarget;
    const debug = env.TAURI_ENV_DEBUG === "true";
    const profile = debug ? "debug" : "release";
    const targetDir = resolveTargetDir(rootDir, env.CARGO_TARGET_DIR);
    const executableName = `${AGENT_NAME}${executableSuffix(target)}`;
    const compiledPath = join(targetDir, target, profile, executableName);
    const sidecarPath = join(rootDir, "src-tauri", "binaries", sidecarFileName(target));
    const nativePath =
        target === hostTarget ? join(targetDir, profile, executableName) : undefined;

    if (options.check) {
        await verifyPreparedArtifacts({
            compiledPath,
            sidecarPath,
            native: target === hostTarget,
            rootDir,
            env,
            runCommand,
        });
        return { target, profile, compiledPath, sidecarPath, nativePath };
    }

    const generatedPaths = [compiledPath, sidecarPath];
    if (nativePath) {
        generatedPaths.push(nativePath);
    }
    await Promise.all(generatedPaths.map((path) => rm(path, { force: true })));

    try {
        const build = await runCommand("cargo", cargoBuildArgs(target, debug), {
            cwd: rootDir,
            env: agentBuildEnvironment(env),
            stdio: "inherit",
        });
        assertCommandSucceeded("cargo build", build);
        await assertExecutable(compiledPath, "Compiled mora-agent");

        if (target === hostTarget) {
            await verifyHelp(compiledPath, rootDir, env, runCommand);
        }

        await copyExecutable(compiledPath, sidecarPath);
        if (nativePath) {
            await copyExecutable(compiledPath, nativePath);
        }
        await verifyPreparedArtifacts({
            compiledPath,
            sidecarPath,
            native: false,
            rootDir,
            env,
            runCommand,
        });
    } catch (error) {
        await Promise.all(generatedPaths.map((path) => rm(path, { force: true })));
        throw error;
    }

    return { target, profile, compiledPath, sidecarPath, nativePath };
}

async function readHostTarget(rootDir, env, runCommand) {
    const result = await runCommand("rustc", ["--print", "host-tuple"], {
        cwd: rootDir,
        env,
        stdio: "pipe",
    });
    assertCommandSucceeded("rustc --print host-tuple", result);
    const target = result.stdout?.trim();
    if (!target) {
        throw new Error("rustc --print host-tuple returned an empty target triple");
    }
    return target;
}

async function verifyPreparedArtifacts({
    compiledPath,
    sidecarPath,
    native,
    rootDir,
    env,
    runCommand,
}) {
    await assertExecutable(compiledPath, "Compiled mora-agent");
    await assertExecutable(sidecarPath, "Tauri mora-agent sidecar");
    const [compiled, sidecar] = await Promise.all([
        readFile(compiledPath),
        readFile(sidecarPath),
    ]);
    if (!compiled.equals(sidecar)) {
        throw new Error(
            `Tauri sidecar does not match the compiled mora-agent: ${sidecarPath}`,
        );
    }
    if (native) {
        await verifyHelp(compiledPath, rootDir, env, runCommand);
    }
}

async function verifyHelp(executable, rootDir, env, runCommand) {
    const result = await runCommand(executable, ["--help"], {
        cwd: rootDir,
        env,
        stdio: "pipe",
    });
    assertCommandSucceeded(`${executable} --help`, result);
}

async function copyExecutable(source, destination) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const sourceStat = await stat(source);
    await chmod(destination, sourceStat.mode);
    await assertExecutable(destination, "Copied mora-agent");
}

async function assertExecutable(path, label) {
    let fileStat;
    try {
        fileStat = await stat(path);
        await access(path, constants.X_OK);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`${label} is missing: ${path}`);
        }
        throw new Error(`${label} is not executable: ${path}`, { cause: error });
    }
    if (!fileStat.isFile()) {
        throw new Error(`${label} is not a file: ${path}`);
    }
}

function assertCommandSucceeded(label, result) {
    if (result?.error) {
        throw new Error(`${label} failed: ${result.error.message}`, {
            cause: result.error,
        });
    }
    if (result?.status !== 0) {
        throw new Error(`${label} failed with exit code ${result?.status ?? "unknown"}`);
    }
}

function parseArgs(args) {
    const options = { check: false, target: undefined };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--check") {
            options.check = true;
            continue;
        }
        if (argument === "--target") {
            options.target = args[index + 1];
            if (!options.target) {
                throw new Error("--target requires a target triple");
            }
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function resolveTargetDir(rootDir, configuredTargetDir) {
    if (!configuredTargetDir) {
        return join(rootDir, "src-tauri", "target");
    }
    return isAbsolute(configuredTargetDir)
        ? configuredTargetDir
        : resolve(rootDir, configuredTargetDir);
}

function agentBuildEnvironment(env) {
    const tauriConfig = env.TAURI_CONFIG?.trim() ? JSON.parse(env.TAURI_CONFIG) : {};
    const bundle =
        tauriConfig.bundle && typeof tauriConfig.bundle === "object"
            ? tauriConfig.bundle
            : {};
    return {
        ...env,
        TAURI_CONFIG: JSON.stringify({
            ...tauriConfig,
            bundle: { ...bundle, externalBin: [] },
        }),
    };
}

function executableSuffix(target) {
    return target.includes("-windows-") ? ".exe" : "";
}

function runProcess(command, args, options) {
    return spawnSync(command, args, {
        ...options,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
    });
}

function repositoryRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function main() {
    const result = await prepareAgentSidecar();
    console.log(
        `Prepared mora-agent sidecar for ${result.target}: ${result.sidecarPath}`,
    );
}

const entryPoint = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (entryPoint === import.meta.url) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
