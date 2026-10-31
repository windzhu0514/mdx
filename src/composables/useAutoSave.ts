import { watch } from "vue";

export type AutoSaveDocument = {
    id: string;
    path: string | null;
    revision: string;
    dirty: boolean;
    conflict: boolean;
    unavailable: boolean;
};

export function useAutoSave(
    source: () => { enabled: boolean; paused: boolean; documents: AutoSaveDocument[] },
    save: (document: AutoSaveDocument) => Promise<void>,
    onError: (document: AutoSaveDocument, error: unknown) => void,
) {
    const timers = new Map<
        string,
        { key: string; timer: ReturnType<typeof setTimeout> }
    >();
    const completed = new Map<string, string>();
    const failed = new Set<string>();
    const inFlight = new Set<string>();
    let disposed = false;
    const key = (document: AutoSaveDocument) =>
        JSON.stringify([document.path, document.revision]);
    function cancel(id: string) {
        const pending = timers.get(id);
        if (pending) clearTimeout(pending.timer);
        timers.delete(id);
    }
    function sync() {
        if (disposed) return;
        const state = source();
        const ids = new Set(state.documents.map((document) => document.id));
        for (const id of new Set([...timers.keys(), ...completed.keys(), ...failed])) {
            if (!state.enabled || !ids.has(id)) {
                cancel(id);
                completed.delete(id);
                failed.delete(id);
            }
        }
        for (const document of state.documents) {
            if (!document.dirty) {
                failed.delete(document.id);
                completed.delete(document.id);
            }
            if (
                !state.enabled ||
                state.paused ||
                !document.path ||
                !document.dirty ||
                document.conflict ||
                document.unavailable ||
                failed.has(document.id)
            ) {
                cancel(document.id);
                continue;
            }
            const revision = key(document);
            if (inFlight.has(document.id) || completed.get(document.id) === revision)
                continue;
            if (timers.get(document.id)?.key === revision) continue;
            cancel(document.id);
            timers.set(document.id, {
                key: revision,
                timer: setTimeout(() => {
                    timers.delete(document.id);
                    const latest = source();
                    const current = latest.documents.find(
                        (item) => item.id === document.id,
                    );
                    if (
                        disposed ||
                        !latest.enabled ||
                        latest.paused ||
                        !current?.path ||
                        !current.dirty ||
                        current.conflict ||
                        current.unavailable ||
                        key(current) !== revision
                    ) {
                        sync();
                        return;
                    }
                    const snapshot = { ...current };
                    completed.set(document.id, revision);
                    inFlight.add(document.id);
                    void save(snapshot)
                        .catch((error) => {
                            failed.add(document.id);
                            if (!disposed) onError(snapshot, error);
                        })
                        .finally(() => {
                            inFlight.delete(document.id);
                            sync();
                        });
                }, 5000),
            });
        }
    }
    const stop = watch(source, sync, { deep: true, immediate: true });
    return () => {
        disposed = true;
        stop();
        for (const id of timers.keys()) cancel(id);
    };
}
