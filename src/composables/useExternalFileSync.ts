import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ref, watch } from "vue";

import { useDocumentSession } from "./useDocumentSession";

type ExternalFilesChangedPayload = {
    paths: string[];
};

export type ExternalFileSyncStatus = {
    state: "active" | "degraded" | "disabled" | "error";
    message: string | null;
};

export type ExternalFileSyncOptions = {
    desktop: boolean;
    session: ReturnType<typeof useDocumentSession>;
    onReloaded(documentIds: string[]): void | Promise<void>;
    onActiveConflict(documentId: string): void | Promise<void>;
};

function watchedPaths(options: ExternalFileSyncOptions): string[] {
    return Array.from(
        new Set(
            options.session.documents.value
                .map((document) => document.path)
                .filter((path): path is string => path !== null),
        ),
    ).sort((left, right) => left.localeCompare(right));
}

export function useExternalFileSync(options: ExternalFileSyncOptions) {
    let disposed = false;
    let unlistenChanges: UnlistenFn | null = null;
    let unlistenStatus: UnlistenFn | null = null;
    let listenerFailure = false;
    let eventFailure = false;
    let syncTail = Promise.resolve();
    let eventTail = Promise.resolve();
    let backendStatus: ExternalFileSyncStatus = { state: "active", message: null };
    const status = ref<ExternalFileSyncStatus>({ ...backendStatus });

    function reportListenerFailure() {
        listenerFailure = true;
        status.value = {
            state: "error",
            message: "外部文件同步监听失败；请重新打开窗口后重试。",
        };
    }

    function enqueueWatchedPaths(paths: string[]) {
        syncTail = syncTail
            .catch(() => undefined)
            .then(async () => {
                await listenerReady;
                if (disposed && paths.length > 0) return;
                return invoke<void>("set_watched_document_paths", { paths });
            })
            .catch(() => {
                if (!disposed) {
                    status.value = {
                        state: "error",
                        message: "外部文件监视配置失败；切换或重新打开文档可重试。",
                    };
                }
            });
    }

    async function handleExternalChange(paths?: readonly string[]) {
        if (disposed) return;
        const reloadedIds = await options.session.refreshDiskState(paths);
        if (disposed) return;
        await options.onReloaded(reloadedIds);
        const activeId = options.session.activeDocumentId.value;
        const active = options.session.documents.value.find(
            (document) => document.id === activeId,
        );
        if (active?.conflict) await options.onActiveConflict(active.id);
    }

    async function processExternalChange(payload: ExternalFilesChangedPayload) {
        if (disposed || !Array.isArray(payload.paths)) return;
        const paths = Array.from(
            new Set(
                payload.paths.filter((path): path is string => typeof path === "string"),
            ),
        );
        if (paths.length === 0) return;
        try {
            await handleExternalChange(paths);
            if (eventFailure && !listenerFailure && !disposed) {
                eventFailure = false;
                status.value = { ...backendStatus };
            }
        } catch {
            if (disposed) return;
            eventFailure = true;
            status.value = {
                state: "degraded",
                message: "外部文件变更同步失败；正在执行一次有界全量复查。",
            };
            try {
                await handleExternalChange();
            } catch {
                if (!disposed) {
                    status.value = {
                        state: "error",
                        message:
                            "外部文件变更同步和全量复查均失败；后续事件仍会继续处理。",
                    };
                }
            }
        }
    }

    const listenerReady: Promise<void> = options.desktop
        ? Promise.all([
              listen<ExternalFilesChangedPayload>(
                  "mora://external-files-changed",
                  (event) => {
                      const operation = eventTail
                          .catch(() => undefined)
                          .then(() => processExternalChange(event.payload));
                      eventTail = operation;
                      return operation;
                  },
              )
                  .then((registered) => {
                      if (disposed) registered();
                      else unlistenChanges = registered;
                  })
                  .catch(reportListenerFailure),
              listen<ExternalFileSyncStatus>("mora://file-watch-status", (event) => {
                  backendStatus = event.payload;
                  if (!listenerFailure && !eventFailure && !disposed) {
                      status.value = event.payload;
                  }
              })
                  .then((registered) => {
                      if (disposed) registered();
                      else unlistenStatus = registered;
                  })
                  .catch(reportListenerFailure),
          ]).then(() => undefined)
        : Promise.resolve();

    const stopPathWatch = options.desktop
        ? watch(
              () => watchedPaths(options),
              (paths) => enqueueWatchedPaths(paths),
              { immediate: true },
          )
        : () => undefined;

    function dispose() {
        if (disposed) return;
        disposed = true;
        stopPathWatch();
        unlistenChanges?.();
        unlistenChanges = null;
        unlistenStatus?.();
        unlistenStatus = null;
        if (options.desktop) enqueueWatchedPaths([]);
    }

    async function settled() {
        await listenerReady;
        await Promise.all([syncTail, eventTail]);
    }

    return { status, dispose, settled };
}
