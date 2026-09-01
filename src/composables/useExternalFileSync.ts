import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watch } from "vue";

import { useDocumentSession } from "./useDocumentSession";

type ExternalFilesChangedPayload = {
    paths: string[];
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
    let unlisten: UnlistenFn | null = null;
    let syncTail = Promise.resolve();
    let eventTail = Promise.resolve();

    function enqueueWatchedPaths(paths: string[]) {
        syncTail = syncTail
            .catch(() => undefined)
            .then(() => {
                if (disposed && paths.length > 0) return;
                return invoke<void>("set_watched_document_paths", { paths });
            })
            .catch(() => undefined);
    }

    const stopPathWatch = options.desktop
        ? watch(
              () => watchedPaths(options),
              (paths) => enqueueWatchedPaths(paths),
              { immediate: true },
          )
        : () => undefined;

    async function handleExternalChange(payload: ExternalFilesChangedPayload) {
        if (disposed || !Array.isArray(payload.paths)) return;
        const paths = Array.from(
            new Set(
                payload.paths.filter((path): path is string => typeof path === "string"),
            ),
        );
        if (paths.length === 0) return;
        const reloadedIds = await options.session.refreshDiskState(paths);
        if (disposed) return;
        await options.onReloaded(reloadedIds);
        const activeId = options.session.activeDocumentId.value;
        const active = options.session.documents.value.find(
            (document) => document.id === activeId,
        );
        if (active?.conflict) await options.onActiveConflict(active.id);
    }

    const listenerReady: Promise<void> = options.desktop
        ? listen<ExternalFilesChangedPayload>(
              "mora://external-files-changed",
              (event) => {
                  const operation = eventTail
                      .catch(() => undefined)
                      .then(() => handleExternalChange(event.payload))
                      .catch(() => undefined);
                  eventTail = operation;
                  return operation;
              },
          )
              .then((registered) => {
                  if (disposed) registered();
                  else unlisten = registered;
              })
              .catch(() => undefined)
        : Promise.resolve();

    function dispose() {
        if (disposed) return;
        disposed = true;
        stopPathWatch();
        unlisten?.();
        unlisten = null;
        if (options.desktop) enqueueWatchedPaths([]);
    }

    async function settled() {
        await listenerReady;
        await Promise.all([syncTail, eventTail]);
    }

    return { dispose, settled };
}
