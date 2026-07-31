import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createDraftRecovery,
    draftKey,
    shouldOfferDraftRestore,
    type DraftSnapshot,
    type DraftStore,
} from "./useDraftRecovery";

const snapshot: DraftSnapshot = {
    path: null,
    title: "草稿",
    content: "正文",
    meta: null,
    newResources: [],
    updatedAt: "2026-07-20T10:00:00.000Z",
};

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("draft recovery", () => {
    afterEach(() => vi.useRealTimers());

    it("creates stable and distinct draft keys", () => {
        expect(draftKey(null, "note-1")).toBe(draftKey(null, "note-1"));
        expect(draftKey("C:/notes/a.mdx", "note-1")).not.toBe(
            draftKey("C:/notes/b.mdx", "note-1"),
        );
        expect(draftKey(null, "note-1")).not.toBe(draftKey(null, "note-2"));
    });

    it("offers only drafts newer than the saved note", () => {
        expect(
            shouldOfferDraftRestore("2026-07-20T10:00:00Z", "2026-07-20T09:00:00Z"),
        ).toBe(true);
        expect(
            shouldOfferDraftRestore("2026-07-20T08:00:00Z", "2026-07-20T09:00:00Z"),
        ).toBe(false);
    });

    it("debounces draft writes and flushes the latest snapshot", async () => {
        vi.useFakeTimers();
        const store: DraftStore = {
            write: vi.fn().mockResolvedValue(undefined),
            read: vi.fn().mockResolvedValue(snapshot),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        const recovery = createDraftRecovery(
            store,
            () => "draft-key",
            () => snapshot,
            1500,
        );

        recovery.schedule();
        recovery.schedule();
        await vi.advanceTimersByTimeAsync(1499);
        expect(store.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(store.write).toHaveBeenCalledTimes(1);
        expect(store.write).toHaveBeenCalledWith("draft-key", snapshot);
    });
    it("reads the draft for the supplied key", async () => {
        const store = {
            write: vi.fn().mockResolvedValue(undefined),
            readLatest: vi.fn().mockResolvedValue(null),
            read: vi.fn().mockResolvedValue(snapshot),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        const recovery = createDraftRecovery(
            store,
            () => "draft-key",
            () => snapshot,
        );

        await expect(recovery.read("note-a")).resolves.toEqual(snapshot);
        expect(store.read).toHaveBeenCalledWith("note-a");
    });

    it("flush waits for a draft write already started by the debounce timer", async () => {
        vi.useFakeTimers();
        const write = deferred<void>();
        const store: DraftStore = {
            write: vi.fn(() => write.promise),
            read: vi.fn().mockResolvedValue(null),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        const recovery = createDraftRecovery(
            store,
            () => "draft-key",
            () => snapshot,
            1500,
        );
        recovery.schedule();
        await vi.advanceTimersByTimeAsync(1500);
        let settled = false;

        const flushing = recovery.flush().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        write.resolve();
        await flushing;
        expect(settled).toBe(true);
    });

    it("dispose waits for a draft write already started by the debounce timer", async () => {
        vi.useFakeTimers();
        const write = deferred<void>();
        const store: DraftStore = {
            write: vi.fn(() => write.promise),
            read: vi.fn().mockResolvedValue(null),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        const recovery = createDraftRecovery(
            store,
            () => "draft-key",
            () => snapshot,
            1500,
        );
        recovery.schedule();
        await vi.advanceTimersByTimeAsync(1500);
        let settled = false;

        const disposing = Promise.resolve(recovery.dispose()).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        write.resolve();
        await disposing;
        expect(settled).toBe(true);
    });

    it("starts the pending debounced write after an earlier write settles", async () => {
        vi.useFakeTimers();
        const firstWrite = deferred<void>();
        const store: DraftStore = {
            write: vi
                .fn()
                .mockImplementationOnce(() => firstWrite.promise)
                .mockResolvedValue(undefined),
            read: vi.fn().mockResolvedValue(null),
            remove: vi.fn().mockResolvedValue(undefined),
        };
        const recovery = createDraftRecovery(
            store,
            () => "draft-key",
            () => snapshot,
            1500,
        );

        recovery.schedule();
        await vi.advanceTimersByTimeAsync(1500);
        recovery.schedule();
        await vi.advanceTimersByTimeAsync(1500);
        expect(store.write).toHaveBeenCalledTimes(1);

        firstWrite.resolve();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
        expect(store.write).toHaveBeenCalledTimes(2);
        await recovery.flush();
    });
});
