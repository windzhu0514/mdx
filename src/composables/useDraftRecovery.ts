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

    function schedule() {
        pending = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void flush();
        }, delayMs);
    }

    async function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!pending) return;
        pending = false;
        await store.write(keyProvider(), snapshotProvider());
    }

    async function remove(key = keyProvider()) {
        pending = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        await store.remove(key);
    }

    function dispose() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    return {
        schedule,
        flush,
        read: (key: string) => store.read(key),
        remove,
        dispose,
    };
}
