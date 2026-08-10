// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";

import type { PendingResource } from "../types/mdx";
import { createResourceSession } from "./useResources";

const newImage: PendingResource = {
    path: "assets/a.png",
    originalName: "a.png",
    mimeType: "image/png",
    size: 1,
    base64: "YQ==",
    objectUrl: "blob:a",
    kind: "asset",
    isNew: true,
};

describe("resource session", () => {
    beforeEach(() => {
        Object.defineProperty(URL, "revokeObjectURL", {
            configurable: true,
            value: vi.fn(),
        });
        Object.defineProperty(URL, "createObjectURL", {
            configurable: true,
            value: vi.fn(() => "blob:restored"),
        });
    });

    it("clears and revokes every object URL", () => {
        const session = createResourceSession();
        session.registerLoaded({ ...newImage, isNew: false });

        session.clear();

        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
        expect(session.objectUrls().size).toBe(0);
    });

    it("does not resend a resource after save", () => {
        const session = createResourceSession();
        session.registerNew(newImage);

        expect(session.newResources()).toHaveLength(1);
        session.markSaved();
        expect(session.newResources()).toHaveLength(0);
    });

    it("exports loaded and new resources without exposing mutable session state", () => {
        const session = createResourceSession();
        session.registerLoaded({ ...newImage, isNew: false });
        const exported = (
            session as typeof session & {
                exportResources(): Array<{ base64: string }>;
            }
        ).exportResources();

        expect(exported).toEqual([
            {
                name: "assets/a.png",
                originalName: "a.png",
                mimeType: "image/png",
                size: 1,
                kind: "asset",
                base64: "YQ==",
            },
        ]);
        exported[0]!.base64 = "changed";
        expect(
            (
                session as typeof session & {
                    exportResources(): Array<{ base64: string }>;
                }
            ).exportResources()[0]!.base64,
        ).toBe("YQ==");
    });

    it("captures export resources and revision atomically without changing revision on markSaved", () => {
        const session = createResourceSession();
        session.registerNew(newImage);

        const first = session.exportSnapshot();
        const firstRevision = session.resourceRevision();
        session.markSaved();
        const afterSave = session.exportSnapshot();
        const afterSaveRevision = session.resourceRevision();
        session.registerLoaded({
            ...newImage,
            path: "assets/b.png",
            objectUrl: "blob:b",
        });
        const afterRegister = session.exportSnapshot();
        const afterRegisterRevision = session.resourceRevision();
        session.clear();
        const afterClear = session.exportSnapshot();
        const afterClearRevision = session.resourceRevision();

        expect(first.resources).toEqual([
            expect.objectContaining({ name: "assets/a.png", base64: "YQ==" }),
        ]);
        expect(afterSave.revision).toBe(first.revision);
        expect(afterRegister.revision).toBeGreaterThan(first.revision);
        expect(afterClear.revision).toBeGreaterThan(afterRegister.revision);
        expect(firstRevision).toBe(first.revision);
        expect(afterSaveRevision).toBe(firstRevision);
        expect(afterRegisterRevision).toBe(afterRegister.revision);
        expect(afterClearRevision).toBe(afterClear.revision);
    });

    it("keeps the persisted path while showing an object URL", () => {
        const session = createResourceSession();
        session.registerLoaded({ ...newImage, isNew: false });

        expect(session.displayMarkdown("![图](assets/a.png)")).toBe("![图](blob:a)");
        expect(session.persistedMarkdown("![图](blob:a)")).toBe("![图](assets/a.png)");
    });

    it("replaces an existing path without leaking its old URL", () => {
        const session = createResourceSession();
        session.registerLoaded({ ...newImage, isNew: false });
        session.registerNew({ ...newImage, objectUrl: "blob:b" });

        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
        expect(session.objectUrls().get("assets/a.png")).toBe("blob:b");
    });

    it("invalidates a computed display projection when only the URL mapping changes", () => {
        const session = createResourceSession();
        const display = computed(() => session.displayMarkdown("![图](assets/a.png)"));
        session.registerLoaded({ ...newImage, isNew: false });
        expect(display.value).toBe("![图](blob:a)");

        session.registerLoaded({ ...newImage, objectUrl: "blob:b", isNew: false });

        expect(display.value).toBe("![图](blob:b)");
    });

    it("snapshots and restores pending resources without clearing blob URLs", () => {
        const source = createResourceSession();
        source.registerNew(newImage);
        const snapshot = source.snapshot();
        const restored = createResourceSession();

        restored.restore(snapshot);

        expect(snapshot.newResources).toEqual([
            {
                name: "assets/a.png",
                originalName: "a.png",
                mimeType: "image/png",
                size: 1,
                kind: "asset",
                base64: "YQ==",
            },
        ]);
        expect(restored.objectUrls().get("assets/a.png")).toBe("blob:restored");
        expect(restored.persistedMarkdown("![图](blob:restored)")).toBe(
            "![图](assets/a.png)",
        );
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();

        restored.clear();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:restored");
    });
});
