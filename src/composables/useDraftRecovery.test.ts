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
            readLatest: vi.fn().mockResolvedValue(null),
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
});
