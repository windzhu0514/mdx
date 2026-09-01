import { constants } from "node:fs";
import {
    access,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    unlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    parse,
    relative,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENT_NAME = "mora-agent";
const TARGET_TRIPLE_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){2,}$/;
const DEFAULT_FILE_SYSTEM = {
    access,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    unlink,
};

export function sidecarFileName(target) {
    const validatedTarget = validateTargetTriple(target);
    return `${AGENT_NAME}-${validatedTarget}${executableSuffix(validatedTarget)}`;
}

export function cargoBuildArgs(target, debug) {
    const validatedTarget = validateTargetTriple(target);
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
    args.push("--target", validatedTarget);
    return args;
}

export async function prepareAgentSidecar({
    rootDir = repositoryRoot(),
    env = process.env,
    args = process.argv.slice(2),
    runCommand = runProcess,
    fileSystem = {},
} = {}) {
    const options = parseArgs(args);
    const suppliedTarget = options.target ?? env.TAURI_ENV_TARGET_TRIPLE?.trim();
    const explicitTarget = suppliedTarget
        ? validateTargetTriple(suppliedTarget)
        : undefined;
    const debug = env.TAURI_ENV_DEBUG === "true";
    const profile = debug ? "debug" : "release";
    const targetDir = resolveTargetDir(rootDir, env.CARGO_TARGET_DIR);
    const binariesRoot = resolve(rootDir, "src-tauri", "binaries");
    const fs = { ...DEFAULT_FILE_SYSTEM, ...fileSystem };
    let hostTarget;
    let target = explicitTarget;

    try {
        hostTarget = await readHostTarget(rootDir, env, runCommand);
        target ??= hostTarget;
        const paths = buildPaths({
            targetDir,
            binariesRoot,
            target,
            hostTarget,
            profile,
        });

        if (options.check) {
            await verifyPreparedArtifacts({
                ...paths,
                targetDir,
                binariesRoot,
                native: target === hostTarget,
                rootDir,
                env,
                runCommand,
                fs,
            });
            return { target, profile, ...paths };
        }

        const initialCleanupErrors = await cleanupGeneratedArtifacts({
            target,
            hostTarget,
            profile,
            targetDir,
            binariesRoot,
            fs,
        });
        if (initialCleanupErrors.length > 0) {
            throw cleanupError("Initial mora-agent cleanup failed", initialCleanupErrors);
        }

        const build = await runCommand("cargo", cargoBuildArgs(target, debug), {
            cwd: rootDir,
            env: agentBuildEnvironment(env),
            stdio: "inherit",
        });
        assertCommandSucceeded("cargo build", build);
        await assertExecutable(paths.compiledPath, "Compiled mora-agent", targetDir, fs);

        if (target === hostTarget) {
            await verifyHelp(paths.compiledPath, rootDir, env, runCommand);
        }

        await copyExecutable(
            paths.compiledPath,
            targetDir,
            paths.sidecarPath,
            binariesRoot,
            fs,
        );
        if (paths.nativePath) {
            await copyExecutable(
                paths.compiledPath,
                targetDir,
                paths.nativePath,
                targetDir,
                fs,
            );
        }
        await verifyPreparedArtifacts({
            ...paths,
            targetDir,
            binariesRoot,
            native: false,
            rootDir,
            env,
            runCommand,
            fs,
        });

        return { target, profile, ...paths };
    } catch (error) {
        if (options.check) {
            throw error;
        }
        const cleanupErrors = await cleanupGeneratedArtifacts({
            target,
            hostTarget,
            profile,
            targetDir,
            binariesRoot,
            fs,
        });
        if (cleanupErrors.length > 0) {
            throw cleanupError(`${errorMessage(error)}; mora-agent cleanup also failed`, [
                error,
                ...cleanupErrors,
            ]);
        }
        throw error;
    }
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
    return validateTargetTriple(target);
}

function buildPaths({ targetDir, binariesRoot, target, hostTarget, profile }) {
    const executableName = `${AGENT_NAME}${executableSuffix(target)}`;
    return {
        compiledPath: join(targetDir, target, profile, executableName),
        sidecarPath: join(binariesRoot, sidecarFileName(target)),
        nativePath:
            target === hostTarget ? join(targetDir, profile, executableName) : undefined,
    };
}

async function verifyPreparedArtifacts({
    compiledPath,
    sidecarPath,
    targetDir,
    binariesRoot,
    native,
    rootDir,
    env,
    runCommand,
    fs,
}) {
    await assertExecutable(compiledPath, "Compiled mora-agent", targetDir, fs);
    await assertExecutable(sidecarPath, "Tauri mora-agent sidecar", binariesRoot, fs);
    const [compiled, sidecar] = await Promise.all([
        fs.readFile(compiledPath),
        fs.readFile(sidecarPath),
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

async function copyExecutable(source, sourceRoot, destination, destinationRoot, fs) {
    await assertExecutable(source, "Compiled mora-agent", sourceRoot, fs);
    const [sourceStat, sourceContent] = await Promise.all([
        fs.lstat(source),
        fs.readFile(source),
    ]);
    const safeDestination = assertContained(destinationRoot, destination);
    await assertNoSymlinkComponents(resolve(destinationRoot), fs);
    await assertNoSymlinkComponents(dirname(safeDestination), fs);
    await fs.mkdir(dirname(safeDestination), { recursive: true });
    const parentSnapshot = await snapshotSafeParent(
        destinationRoot,
        dirname(safeDestination),
        fs,
    );
    await assertReplaceableFile(safeDestination, fs);
    await assertParentUnchanged(parentSnapshot, fs);

    const temporaryPath = assertContained(
        destinationRoot,
        join(
            dirname(safeDestination),
            `.${basename(safeDestination)}.${process.pid}.${randomUUID()}.tmp`,
        ),
    );
    let temporaryCreated = false;
    try {
        const temporary = await fs.open(temporaryPath, "wx", sourceStat.mode);
        temporaryCreated = true;
        try {
            await temporary.writeFile(sourceContent);
            await temporary.chmod(sourceStat.mode);
            await temporary.sync();
        } finally {
            await temporary.close();
        }

        await fs.beforeRename?.({
            temporaryPath,
            destination: safeDestination,
        });
        await assertParentUnchanged(parentSnapshot, fs);
        await assertReplaceableFile(safeDestination, fs);
        await assertParentUnchanged(parentSnapshot, fs);
        await fs.rename(temporaryPath, safeDestination);
        temporaryCreated = false;
        await assertExecutable(safeDestination, "Copied mora-agent", destinationRoot, fs);
    } catch (error) {
        if (temporaryCreated) {
            try {
                await safeUnlink(destinationRoot, temporaryPath, fs);
            } catch (cleanupFailure) {
                throw cleanupError(
                    `${errorMessage(error)}; temporary mora-agent cleanup failed`,
                    [error, cleanupFailure],
                );
            }
        }
        throw error;
    }
}

async function assertReplaceableFile(path, fs) {
    try {
        const fileStat = await fs.lstat(path);
        if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
            throw new Error(`Refusing to replace non-file mora-agent path: ${path}`);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

async function assertExecutable(path, label, root, fs) {
    const safePath = assertContained(root, path);
    await assertNoSymlinkComponents(resolve(root), fs);
    await assertNoSymlinkComponents(dirname(safePath), fs);
    let fileStat;
    try {
        fileStat = await fs.lstat(safePath);
        if (fileStat.isSymbolicLink()) {
            throw new Error(`Unsafe symbolic link: ${safePath}`);
        }
        await fs.access(safePath, constants.X_OK);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`${label} is missing: ${safePath}`);
        }
        throw new Error(`${label} is not executable: ${safePath}`, { cause: error });
    }
    if (!fileStat.isFile()) {
        throw new Error(`${label} is not a file: ${safePath}`);
    }
}

async function cleanupGeneratedArtifacts({
    target,
    hostTarget,
    profile,
    targetDir,
    binariesRoot,
    fs,
}) {
    const errors = [];
    const candidates = [];

    if (target) {
        candidates.push({
            root: binariesRoot,
            path: join(binariesRoot, sidecarFileName(target)),
        });
        if (target === hostTarget) {
            candidates.push({
                root: targetDir,
                path: join(
                    targetDir,
                    profile,
                    `${AGENT_NAME}${executableSuffix(target)}`,
                ),
            });
        } else if (!hostTarget) {
            candidates.push(
                { root: targetDir, path: join(targetDir, profile, AGENT_NAME) },
                {
                    root: targetDir,
                    path: join(targetDir, profile, `${AGENT_NAME}.exe`),
                },
            );
        }
        candidates.push({
            root: targetDir,
            path: join(
                targetDir,
                target,
                profile,
                `${AGENT_NAME}${executableSuffix(target)}`,
            ),
        });
    } else {
        candidates.push(
            { root: targetDir, path: join(targetDir, profile, AGENT_NAME) },
            {
                root: targetDir,
                path: join(targetDir, profile, `${AGENT_NAME}.exe`),
            },
        );
        await collectSidecarCandidates(binariesRoot, fs, candidates, errors);
        await collectTargetCandidates(targetDir, profile, fs, candidates, errors);
    }

    for (const candidate of candidates) {
        try {
            await safeUnlink(candidate.root, candidate.path, fs);
        } catch (error) {
            errors.push(error);
        }
    }
    return errors;
}

async function collectSidecarCandidates(root, fs, candidates, errors) {
    let entries;
    try {
        entries = await safeReadDirectory(root, fs);
    } catch (error) {
        errors.push(error);
        return;
    }
    for (const entry of entries) {
        if (isGeneratedSidecarName(entry.name)) {
            candidates.push({ root, path: join(root, entry.name) });
        }
    }
}

async function collectTargetCandidates(root, profile, fs, candidates, errors) {
    let entries;
    try {
        entries = await safeReadDirectory(root, fs);
    } catch (error) {
        errors.push(error);
        return;
    }
    for (const entry of entries) {
        if (!TARGET_TRIPLE_PATTERN.test(entry.name)) {
            continue;
        }
        if (entry.isSymbolicLink()) {
            errors.push(
                new Error(`Unsafe symbolic link component: ${join(root, entry.name)}`),
            );
            continue;
        }
        if (!entry.isDirectory()) {
            continue;
        }
        const target = validateTargetTriple(entry.name);
        candidates.push({
            root,
            path: join(root, target, profile, `${AGENT_NAME}${executableSuffix(target)}`),
        });
    }
}

async function safeReadDirectory(root, fs) {
    const safeRoot = resolve(root);
    await assertNoSymlinkComponents(safeRoot, fs);
    try {
        return await fs.readdir(safeRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function safeUnlink(root, candidate, fs) {
    const safePath = assertContained(root, candidate);
    let parentSnapshot;
    try {
        parentSnapshot = await snapshotSafeParent(root, dirname(safePath), fs);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return;
        }
        throw error;
    }
    let fileStat;
    try {
        fileStat = await fs.lstat(safePath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
        throw new Error(`Refusing to remove non-file mora-agent path: ${safePath}`);
    }
    await fs.beforeUnlink?.({ path: safePath });
    await assertParentUnchanged(parentSnapshot, fs);
    await fs.unlink(safePath);
}

async function snapshotSafeParent(root, parent, fs) {
    const resolvedRoot = resolve(root);
    const safeParent = assertContainedOrEqual(resolvedRoot, parent);
    await assertNoSymlinkComponents(resolvedRoot, fs);
    await assertNoSymlinkComponents(safeParent, fs);
    const [rootRealPath, parentRealPath, parentStat] = await Promise.all([
        fs.realpath(resolvedRoot),
        fs.realpath(safeParent),
        fs.lstat(safeParent),
    ]);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`Unsafe mora-agent parent directory: ${safeParent}`);
    }
    assertContainedOrEqual(rootRealPath, parentRealPath);
    return {
        root: resolvedRoot,
        path: safeParent,
        realPath: parentRealPath,
        dev: parentStat.dev,
        ino: parentStat.ino,
    };
}

async function assertParentUnchanged(snapshot, fs) {
    const current = await snapshotSafeParent(snapshot.root, snapshot.path, fs);
    if (
        !samePath(current.realPath, snapshot.realPath) ||
        current.dev !== snapshot.dev ||
        current.ino !== snapshot.ino
    ) {
        throw new Error(`Unsafe mora-agent parent changed: ${snapshot.path}`);
    }
}

function assertContained(root, candidate) {
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    if (!isContained(resolvedRoot, resolvedCandidate)) {
        throw new Error(
            `Unsafe mora-agent path escapes controlled root ${resolvedRoot}: ${resolvedCandidate}`,
        );
    }
    return resolvedCandidate;
}

function assertContainedOrEqual(root, candidate) {
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    if (
        !samePath(resolvedRoot, resolvedCandidate) &&
        !isContained(resolvedRoot, resolvedCandidate)
    ) {
        throw new Error(
            `Unsafe mora-agent path escapes controlled root ${resolvedRoot}: ${resolvedCandidate}`,
        );
    }
    return resolvedCandidate;
}

function isContained(root, candidate) {
    const pathFromRoot = relative(resolve(root), resolve(candidate));
    return (
        pathFromRoot !== "" &&
        pathFromRoot !== ".." &&
        !pathFromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromRoot)
    );
}

function samePath(left, right) {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === "win32"
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}

async function assertNoSymlinkComponents(path, fs) {
    const absolutePath = resolve(path);
    const parsedPath = parse(absolutePath);
    const components = relative(parsedPath.root, absolutePath).split(sep).filter(Boolean);
    let currentPath = parsedPath.root;
    for (const component of components) {
        currentPath = join(currentPath, component);
        let componentStat;
        try {
            componentStat = await fs.lstat(currentPath);
        } catch (error) {
            if (error?.code === "ENOENT") {
                return;
            }
            throw error;
        }
        if (componentStat.isSymbolicLink()) {
            throw new Error(`Unsafe symbolic link component: ${currentPath}`);
        }
    }
}

function validateTargetTriple(target) {
    if (typeof target !== "string" || !TARGET_TRIPLE_PATTERN.test(target)) {
        throw new Error(`Invalid Rust target triple: ${JSON.stringify(target)}`);
    }
    return target;
}

function isGeneratedSidecarName(name) {
    if (!name.startsWith(`${AGENT_NAME}-`)) {
        return false;
    }
    const hasExecutableSuffix = name.endsWith(".exe");
    const target = name.slice(
        `${AGENT_NAME}-`.length,
        hasExecutableSuffix ? -".exe".length : undefined,
    );
    if (!TARGET_TRIPLE_PATTERN.test(target)) {
        return false;
    }
    return (hasExecutableSuffix ? ".exe" : "") === executableSuffix(target);
}

function cleanupError(message, errors) {
    return new AggregateError(
        errors,
        `${message}: ${errors.map(errorMessage).join("; ")}`,
    );
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
        return resolve(rootDir, "src-tauri", "target");
    }
    return isAbsolute(configuredTargetDir)
        ? resolve(configuredTargetDir)
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
