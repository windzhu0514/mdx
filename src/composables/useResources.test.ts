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
