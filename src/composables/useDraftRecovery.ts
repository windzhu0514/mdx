import type { MdxMetadata, ResourceSaveData } from "../types/mdx";

export type DraftSnapshot = {
    path: string | null;
    title: string;
    content: string;
    meta: MdxMetadata | null;
    newResources: ResourceSaveData[];
    updatedAt: string;
};

export type DraftStore = {
    write: (key: string, draft: DraftSnapshot) => Promise<void>;
    read: (key: string) => Promise<DraftSnapshot | null>;
    remove: (key: string) => Promise<void>;
};

function stableHash(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function draftKey(path: string | null, noteId: string) {
    return `${path ? "file" : "note"}-${stableHash(path ?? noteId)}`;
}

export function shouldOfferDraftRestore(
    draftUpdatedAt: string,
    savedUpdatedAt: string | null | undefined,
) {
    const draftTime = Date.parse(draftUpdatedAt);
    const savedTime = savedUpdatedAt ? Date.parse(savedUpdatedAt) : 0;
    return Number.isFinite(draftTime) && draftTime > savedTime;
}

export function createDraftRecovery(
    store: DraftStore,
    keyProvider: () => string,
    snapshotProvider: () => DraftSnapshot,
    delayMs = 1500,
) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    let inFlight: Promise<void> | null = null;
    const noWriteError = Symbol("no-write-error");
    let writeError: unknown | typeof noWriteError = noWriteError;

    function rememberWriteError(error: unknown) {
        if (writeError === noWriteError) writeError = error;
    }

    function throwRememberedWriteError() {
        if (writeError === noWriteError) return;
        const error = writeError;
        writeError = noWriteError;
        throw error;
    }

    function startWrite() {
        const key = keyProvider();
        const snapshot = snapshotProvider();
        const write = Promise.resolve().then(() => store.write(key, snapshot));
        const tracked = write
            .catch((error: unknown) => {
                rememberWriteError(error);
                throw error;
            })
            .finally(() => {
                if (inFlight !== tracked) return;
                inFlight = null;
                if (pending && timer === null) {
                    pending = false;
                    startWrite();
                }
            });
        inFlight = tracked;
        void tracked.catch(() => undefined);
    }

    function schedule() {
        pending = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            if (!pending || inFlight) return;
            pending = false;
            startWrite();
        }, delayMs);
    }

    async function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        while (pending || inFlight) {
            if (!inFlight && pending) {
                pending = false;
                startWrite();
            }
            const currentWrite = inFlight;
            if (currentWrite) await currentWrite.catch(() => undefined);
        }
        throwRememberedWriteError();
    }

    async function remove(key = keyProvider()) {
        pending = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (inFlight) await inFlight.catch(() => undefined);
        let removeError: unknown | typeof noWriteError = noWriteError;
        try {
            await store.remove(key);
        } catch (error) {
            removeError = error;
        }
        if (writeError !== noWriteError) throwRememberedWriteError();
        if (removeError !== noWriteError) throw removeError;
    }

    async function dispose() {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = false;
        if (inFlight) await inFlight.catch(() => undefined);
        throwRememberedWriteError();
    }

    return {
        schedule,
        flush,
        read: (key: string) => store.read(key),
        remove,
        dispose,
    };
}
