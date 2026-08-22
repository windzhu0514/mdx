import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppUpdater } from "./useAppUpdater";

const { check, relaunch } = vi.hoisted(() => ({
    check: vi.fn(),
    relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function fakeUpdate() {
    return {
        version: "0.2.0",
        date: "2026-08-22T00:00:00Z",
        body: "修复保存并改进编辑体验",
        download: vi.fn(),
        install: vi.fn(),
    };
}

describe("app updater check", () => {
    beforeEach(() => {
        check.mockReset();
        relaunch.mockReset();
    });

    it("returns current and restores idle when no update exists", async () => {
        check.mockResolvedValue(null);
        const updater = useAppUpdater(true);

        await expect(updater.checkForUpdate({ silent: false })).resolves.toBe("current");
        expect(updater.phase.value).toBe("idle");
        expect(updater.error.value).toBe("");
    });

    it("retains available update metadata", async () => {
        check.mockResolvedValue(fakeUpdate());
        const updater = useAppUpdater(true);

        await expect(updater.checkForUpdate({ silent: false })).resolves.toBe(
            "available",
        );
        expect(updater.phase.value).toBe("available");
        expect(updater.version.value).toBe("0.2.0");
        expect(updater.date.value).toBe("2026-08-22T00:00:00Z");
        expect(updater.notes.value).toBe("修复保存并改进编辑体验");
    });

    it("skips disabled and concurrent checks", async () => {
        const disabled = useAppUpdater(false);
        await expect(disabled.checkForUpdate({ silent: false })).resolves.toBe("skipped");
        expect(check).not.toHaveBeenCalled();

        const pending = deferred<ReturnType<typeof fakeUpdate> | null>();
        check.mockReturnValue(pending.promise);
        const updater = useAppUpdater(true);
        const firstCheck = updater.checkForUpdate({ silent: false });
        expect(updater.phase.value).toBe("checking");
        await expect(updater.checkForUpdate({ silent: false })).resolves.toBe("skipped");
        pending.resolve(null);
        await expect(firstCheck).resolves.toBe("current");
        expect(check).toHaveBeenCalledTimes(1);
    });

    it("hides background errors but exposes manual errors", async () => {
        check.mockRejectedValueOnce(new Error("network unavailable"));
        const updater = useAppUpdater(true);

        await expect(updater.checkForUpdate({ silent: true })).resolves.toBe("failed");
        expect(updater.phase.value).toBe("idle");
        expect(updater.error.value).toBe("");

        check.mockRejectedValueOnce(new Error("network unavailable"));
        await expect(updater.checkForUpdate({ silent: false })).resolves.toBe("failed");
        expect(updater.phase.value).toBe("error");
        expect(updater.error.value).toContain("network unavailable");
    });
});

describe("app updater download and install", () => {
    beforeEach(() => {
        check.mockReset();
        relaunch.mockReset();
        relaunch.mockResolvedValue(undefined);
    });

    async function prepareAvailable(update = fakeUpdate()) {
        check.mockResolvedValue(update);
        const updater = useAppUpdater(true);
        await updater.checkForUpdate({ silent: false });
        return { updater, update };
    }

    async function prepareDownloaded(update = fakeUpdate()) {
        update.download.mockImplementation(async (onEvent) => {
            onEvent?.({ event: "Finished" });
        });
        const prepared = await prepareAvailable(update);
        await prepared.updater.downloadUpdate();
        return prepared;
    }

    it("tracks exact byte progress and finishes the download", async () => {
        const update = fakeUpdate();
        update.download.mockImplementation(async (onEvent) => {
            onEvent?.({ event: "Started", data: { contentLength: 12 } });
            onEvent?.({ event: "Progress", data: { chunkLength: 5 } });
            onEvent?.({ event: "Progress", data: { chunkLength: 7 } });
            onEvent?.({ event: "Finished" });
        });
        const { updater } = await prepareAvailable(update);

        await expect(updater.downloadUpdate()).resolves.toBe(true);
        expect(updater.phase.value).toBe("downloaded");
        expect(updater.downloadedBytes.value).toBe(12);
        expect(updater.totalBytes.value).toBe(12);
    });

    it("retains metadata and reports download failures", async () => {
        const update = fakeUpdate();
        update.download.mockRejectedValue(new Error("download failed"));
        const { updater } = await prepareAvailable(update);

        await expect(updater.downloadUpdate()).resolves.toBe(false);
        expect(updater.phase.value).toBe("error");
        expect(updater.version.value).toBe("0.2.0");
        expect(updater.error.value).toContain("download failed");
    });

    it("skips a second download while the first is active", async () => {
        const pending = deferred<void>();
        const update = fakeUpdate();
        update.download.mockReturnValue(pending.promise);
        const { updater } = await prepareAvailable(update);

        const firstDownload = updater.downloadUpdate();
        expect(updater.phase.value).toBe("downloading");
        await expect(updater.downloadUpdate()).resolves.toBe(false);
        pending.resolve();
        await expect(firstDownload).resolves.toBe(true);
        expect(update.download).toHaveBeenCalledTimes(1);
    });

    it("does not relaunch after an install failure", async () => {
        const update = fakeUpdate();
        update.install.mockRejectedValue(new Error("install failed"));
        const { updater } = await prepareDownloaded(update);

        await expect(updater.installUpdate()).resolves.toBe(false);
        expect(updater.phase.value).toBe("error");
        expect(updater.error.value).toContain("install failed");
        expect(relaunch).not.toHaveBeenCalled();
    });

    it("relaunches exactly once after a successful install", async () => {
        const { updater, update } = await prepareDownloaded();

        await expect(updater.installUpdate()).resolves.toBe(true);
        expect(update.install).toHaveBeenCalledTimes(1);
        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it("reports when installation succeeds but relaunch fails", async () => {
        relaunch.mockRejectedValue(new Error("restart failed"));
        const { updater } = await prepareDownloaded();

        await expect(updater.installUpdate()).resolves.toBe(false);
        expect(updater.phase.value).toBe("error");
        expect(updater.error.value).toBe("更新已安装，请手动重启 Mora");
    });

    it("skips a second install while the first is active", async () => {
        const pending = deferred<void>();
        const update = fakeUpdate();
        update.install.mockReturnValue(pending.promise);
        const { updater } = await prepareDownloaded(update);

        const firstInstall = updater.installUpdate();
        expect(updater.phase.value).toBe("installing");
        await expect(updater.installUpdate()).resolves.toBe(false);
        pending.resolve();
        await expect(firstInstall).resolves.toBe(true);
        expect(update.install).toHaveBeenCalledTimes(1);
    });
});
