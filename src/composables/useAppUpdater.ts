import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { computed, readonly, ref, shallowRef } from "vue";

export type AppUpdatePhase =
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error";

export type UpdateCheckResult = "available" | "current" | "failed" | "skipped";

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function useAppUpdater(enabled: boolean) {
    const phase = ref<AppUpdatePhase>("idle");
    const version = ref("");
    const date = ref("");
    const notes = ref("");
    const downloadedBytes = ref(0);
    const totalBytes = ref<number | null>(null);
    const error = ref("");
    const availableUpdate = shallowRef<Update | null>(null);
    const recoveryPhase = ref<"idle" | "available" | "downloaded">("idle");

    const busy = computed(() =>
        ["checking", "downloading", "installing"].includes(phase.value),
    );

    function clearMetadata() {
        availableUpdate.value = null;
        version.value = "";
        date.value = "";
        notes.value = "";
        downloadedBytes.value = 0;
        totalBytes.value = null;
    }

    async function checkForUpdate({
        silent,
    }: {
        silent: boolean;
    }): Promise<UpdateCheckResult> {
        if (!enabled || busy.value) {
            return "skipped";
        }

        phase.value = "checking";
        error.value = "";
        clearMetadata();
        try {
            const update = await check();
            if (!update) {
                phase.value = "idle";
                return "current";
            }

            availableUpdate.value = update;
            version.value = update.version;
            date.value = update.date ?? "";
            notes.value = update.body ?? "";
            phase.value = "available";
            return "available";
        } catch (cause) {
            recoveryPhase.value = "idle";
            if (silent) {
                phase.value = "idle";
                error.value = "";
            } else {
                phase.value = "error";
                error.value = errorMessage(cause);
            }
            return "failed";
        }
    }

    async function downloadUpdate() {
        const update = availableUpdate.value;
        if (!update || phase.value !== "available") {
            return false;
        }

        phase.value = "downloading";
        error.value = "";
        downloadedBytes.value = 0;
        totalBytes.value = null;
        try {
            await update.download((event: DownloadEvent) => {
                if (event.event === "Started") {
                    totalBytes.value = event.data.contentLength ?? null;
                } else if (event.event === "Progress") {
                    downloadedBytes.value += event.data.chunkLength;
                }
            });
            phase.value = "downloaded";
            return true;
        } catch (cause) {
            recoveryPhase.value = "available";
            phase.value = "error";
            error.value = errorMessage(cause);
            return false;
        }
    }

    async function installUpdate() {
        const update = availableUpdate.value;
        if (!update || phase.value !== "downloaded") {
            return false;
        }

        phase.value = "installing";
        error.value = "";
        try {
            await update.install();
        } catch (cause) {
            recoveryPhase.value = "downloaded";
            phase.value = "error";
            error.value = errorMessage(cause);
            return false;
        }

        try {
            await relaunch();
            return true;
        } catch {
            recoveryPhase.value = "idle";
            phase.value = "error";
            error.value = "更新已安装，请手动重启 Mora";
            return false;
        }
    }

    function clearError() {
        error.value = "";
        if (phase.value === "error") {
            phase.value = recoveryPhase.value;
        }
    }

    return {
        phase: readonly(phase),
        version: readonly(version),
        date: readonly(date),
        notes: readonly(notes),
        downloadedBytes: readonly(downloadedBytes),
        totalBytes: readonly(totalBytes),
        error: readonly(error),
        busy: readonly(busy),
        checkForUpdate,
        downloadUpdate,
        installUpdate,
        clearError,
    };
}
