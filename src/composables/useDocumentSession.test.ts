// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MdxMetadata, MdxNote, PendingResource } from "../types/mdx";
import type {
    DiskRevisionResult,
    FolderScan,
    PathIdentity,
    WorkspaceSessionRead,
    WorkspaceSessionSnapshot,
} from "../types/workspace";
import type { DraftSnapshot } from "./useDraftRecovery";
import { useDocumentSession } from "./useDocumentSession";

const invoke = vi.hoisted(() => vi.fn());
let workspaceRead: WorkspaceSessionRead;
const drafts = new Map<string, DraftSnapshot>();
const diskContents = new Map<string, string>();
const diskRevisions = new Map<string, number>();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function metadata(title: string, id = title): MdxMetadata {
    return {
        id,
        title,
        summary: "",
        author: "",
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
        tags: [],
        category: "",
        favorite: false,
        archived: false,
        cover: "",
        wordCount: 0,
        assets: [],
        attachments: [],
    };
}

function note(path: string | null, title: string, content = title): MdxNote {
    return {
        path,
        title,
        content,
        manifest: {
            format: "MDXNote",
            formatVersion: "1.0",
            packageType: "note",
            contentFile: "content.md",
            metadataFile: "meta.json",
            assetsDir: "assets",
            attachmentsDir: "attachments",
            thumbnailsDir: "thumbnails",
            encoding: "utf-8",
            encrypted: false,
            compression: "deflate",
        },
        meta: metadata(title),
    };
}

function fileName(path: string) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function normalizedPath(path: string) {
    return path.replace(/\//g, "\\");
}

function pathKey(path: string) {
    return normalizedPath(path).toLocaleLowerCase("en-US");
}

const pendingImage: PendingResource = {
    path: "assets/a.png",
    originalName: "a.png",
    mimeType: "image/png",
    size: 1,
    base64: "YQ==",
    objectUrl: "blob:a",
    kind: "asset",
    isNew: true,
};

describe("document session", () => {
    beforeEach(() => {
        workspaceRead = { session: null, warning: null };
        drafts.clear();
        diskContents.clear();
        diskRevisions.clear();
        Object.defineProperty(URL, "revokeObjectURL", {
            configurable: true,
            value: vi.fn(),
        });
        Object.defineProperty(URL, "createObjectURL", {
            configurable: true,
            value: vi.fn(() => "blob:restored"),
        });
        invoke.mockReset();
        invoke.mockImplementation(async (command: string, args?: unknown) => {
            const payload = (args ?? {}) as Record<string, unknown>;
            if (command === "resolve_path") {
                const path = normalizedPath(String(payload.path));
                return {
                    path,
                    identity: path.toLocaleLowerCase("en-US"),
                    available: !/missing|offline/i.test(path),
                } satisfies PathIdentity;
            }
            if (command === "open_mdx") {
                const path = normalizedPath(String(payload.path));
                if (/missing/i.test(path)) throw new Error("unavailable");
                return note(
                    path,
                    fileName(path).replace(/\.mdx$/i, ""),
                    diskContents.get(pathKey(path)) ??
                        fileName(path).replace(/\.mdx$/i, ""),
                );
            }
            if (command === "import_markdown") {
                const path = normalizedPath(String(payload.path));
                return {
                    title: fileName(path).replace(/\.md$/i, ""),
                    content: `imported ${fileName(path)}`,
                    frontMatter: null,
                };
            }
            if (command === "create_mdx") return note(null, "无标题笔记", "");
            if (command === "save_mdx" || command === "save_mdx_as") {
                const request = payload.request as {
                    path: string | null;
                    title: string;
                    content: string;
                    meta: MdxMetadata | null;
                };
                const path =
                    command === "save_mdx_as"
                        ? normalizedPath(String(payload.path))
                        : normalizedPath(String(request.path));
                return {
                    ...note(path, request.title, request.content),
                    meta: request.meta ?? metadata(request.title),
                };
            }
            if (command === "scan_workspace_folder") {
                const path = normalizedPath(String(payload.path));
                if (/offline/i.test(path)) throw new Error("unavailable");
                return {
                    path,
                    entries: [],
                    entryCount: 0,
                    truncated: false,
                } satisfies FolderScan;
            }
            if (command === "get_disk_revisions") {
                return (payload.paths as string[]).map((path): DiskRevisionResult => ({
                    path,
                    available: true,
                    revision: {
                        path,
                        modifiedAtMs: diskRevisions.get(pathKey(path)) ?? 1,
                        size: 1,
                    },
                    error: null,
                }));
            }
            if (command === "read_workspace_session") {
                return workspaceRead;
            }
            if (command === "read_draft") {
                return drafts.get(String(payload.key)) ?? null;
            }
            if (command === "write_draft") {
                drafts.set(String(payload.key), payload.draft as DraftSnapshot);
                return undefined;
            }
            if (command === "delete_draft") {
                drafts.delete(String(payload.key));
                return undefined;
            }
            if (command === "write_workspace_session") {
                return undefined;
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    afterEach(() => vi.useRealTimers());

    it("deduplicates saved and imported paths but permits multiple untitled documents", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\A.mdx");
        expect(await session.openMdx("c:\\notes\\a.mdx")).toBe(first);

        const imported = await session.openMarkdown("C:\\Notes\\source.md");
        expect(await session.openMarkdown("c:\\notes\\SOURCE.md")).toBe(imported);
        expect(session.newDocument().displayName).toBe("未命名文档 1");
        expect(session.newDocument().displayName).toBe("未命名文档 2");
    });

    it("keeps dirty content isolated and leaves the folder untouched on cancel", async () => {
        const decisions: Array<"discard" | "cancel"> = ["discard", "cancel"];
        const session = useDocumentSession(true);
        await session.openFolder("C:\\Root");
        const a = await session.openMdx("C:\\Root\\a.mdx");
        const b = await session.openMdx("C:\\Root\\b.mdx");

        session.updateContent(a.id, "changed a");
        session.updateContent(b.id, "changed b");

        expect(
            await session.closeFolder("C:\\Root", {
                decide: async () => decisions.shift() ?? "cancel",
                save: async () => true,
            }),
        ).toBe(false);
        expect(session.documents.value.map((document) => document.id)).toEqual([
            a.id,
            b.id,
        ]);
        expect(session.document(a.id).content).toBe("changed a");
        expect(session.document(b.id).content).toBe("changed b");
        expect(session.document(a.id).dirty).toBe(true);
        expect(session.folders.value).toHaveLength(1);
        expect(invoke).not.toHaveBeenCalledWith("delete_draft", expect.anything());
    });

    it("rejects save-as before writing when another document owns the target", async () => {
        const session = useDocumentSession(true);
        const existing = await session.openMdx("C:\\Notes\\taken.mdx");
        const untitled = session.newDocument();

        await expect(
            session.saveAs(untitled.id, "c:\\notes\\TAKEN.mdx"),
        ).rejects.toMatchObject({
            code: "TARGET_ALREADY_OPEN",
            documentId: existing.id,
        });
        expect(invoke).not.toHaveBeenCalledWith("save_mdx_as", expect.anything());
    });

    it("keeps a dirty document and its draft when close-time save fails", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\dirty.mdx");
        session.updateContent(runtime.id, "local changes");

        await expect(
            session.closeDocument(runtime.id, {
                decide: async () => "save",
                save: async () => false,
            }),
        ).resolves.toBe(false);
        expect(session.document(runtime.id).content).toBe("local changes");
        expect(session.document(runtime.id).dirty).toBe(true);
        expect(invoke).not.toHaveBeenCalledWith("delete_draft", expect.anything());
    });

    it("saves canonical content and clears only that document dirty state", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\first.mdx");
        const second = await session.openMdx("C:\\Notes\\second.mdx");
        first.resources.registerLoaded({ ...pendingImage, isNew: false });
        session.updateContent(first.id, "![图](blob:a)");
        session.updateContent(second.id, "second local");

        await session.save(first.id);

        expect(session.document(first.id).content).toBe("![图](assets/a.png)");
        expect(session.document(first.id).dirty).toBe(false);
        expect(session.document(second.id).dirty).toBe(true);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({
                    content: "![图](assets/a.png)",
                }),
            }),
        );
    });

    it("activates without saving or releasing resources and schedules session persistence", async () => {
        vi.useFakeTimers();
        const session = useDocumentSession(true);
        const first = session.newDocument();
        const second = session.newDocument();
        first.resources.registerNew(pendingImage);
        invoke.mockClear();

        expect(session.activate(first.id)).toBe(true);
        expect(session.activeDocumentId.value).toBe(first.id);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalledWith("save_mdx", expect.anything());

        await vi.runAllTimersAsync();
        expect(invoke).toHaveBeenCalledWith(
            "write_workspace_session",
            expect.objectContaining({
                session: expect.objectContaining({
                    activeDocumentId: first.id,
                    documents: expect.arrayContaining([
                        expect.objectContaining({ id: second.id }),
                    ]),
                }),
            }),
        );
    });

    it("restores documents independently and reads drafts by their exact session keys", async () => {
        const snapshot: WorkspaceSessionSnapshot = {
            version: 1,
            documents: [
                {
                    id: "saved-id",
                    path: "C:\\Notes\\ok.mdx",
                    sourceKind: "mdx",
                    importSourcePath: null,
                    draftKey: "exact-ok-key",
                },
                {
                    id: "missing-id",
                    path: "D:\\missing.mdx",
                    sourceKind: "mdx",
                    importSourcePath: null,
                    draftKey: "exact-missing-key",
                },
            ],
            folderPaths: ["D:\\offline"],
            expandedPaths: ["C:\\Notes"],
            activeDocumentId: "saved-id",
            sidebarCollapsed: true,
            sidebarWidth: 312,
        };
        workspaceRead = { session: snapshot, warning: null };
        drafts.set("exact-ok-key", {
            path: "C:\\Notes\\ok.mdx",
            title: "ok draft",
            content: "unsaved",
            meta: metadata("ok draft"),
            newResources: [],
            updatedAt: "2026-07-31T01:00:00.000Z",
        });
        const session = useDocumentSession(true);

        await session.restore();

        expect(session.document("saved-id").content).toBe("unsaved");
        expect(session.document("saved-id").dirty).toBe(true);
        expect(session.document("missing-id").unavailable).toBe(true);
        expect(session.activeDocumentId.value).toBe("saved-id");
        expect(session.folders.value[0]).toMatchObject({ unavailable: true });
        expect(invoke).toHaveBeenCalledWith("read_draft", {
            key: "exact-ok-key",
        });
        expect(invoke).toHaveBeenCalledWith("read_draft", {
            key: "exact-missing-key",
        });
    });

    it("reloads changed clean documents and marks changed dirty documents conflicted", async () => {
        const session = useDocumentSession(true);
        const clean = await session.openMdx("C:\\Notes\\clean.mdx");
        const dirty = await session.openMdx("C:\\Notes\\dirty.mdx");
        session.updateContent(dirty.id, "local");
        diskContents.set(pathKey(clean.path!), "disk clean changed");
        diskContents.set(pathKey(dirty.path!), "disk dirty changed");
        diskRevisions.set(pathKey(clean.path!), 2);
        diskRevisions.set(pathKey(dirty.path!), 2);

        await expect(session.refreshDiskState()).resolves.toEqual([clean.id]);
        expect(session.document(clean.id).content).toBe("disk clean changed");
        expect(session.document(clean.id).conflict).toBe(false);
        expect(session.document(dirty.id).content).toBe("local");
        expect(session.document(dirty.id).conflict).toBe(true);
    });

    it("flushes resource snapshots before disposal clears object URLs", async () => {
        const session = useDocumentSession(true);
        const runtime = session.newDocument();
        runtime.resources.registerNew(pendingImage);
        session.updateContent(runtime.id, "![图](blob:a)");

        await session.dispose();

        const written = Array.from(drafts.values())[0];
        expect(written.content).toBe("![图](assets/a.png)");
        expect(written.newResources).toEqual([
            expect.objectContaining({ name: "assets/a.png", base64: "YQ==" }),
        ]);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
    });

    it("does not invoke Tauri for web-only session lifecycle", async () => {
        const session = useDocumentSession(false);
        session.newDocument();
        await session.persist();
        await session.restore();
        await session.refreshDiskState();
        await session.dispose();

        expect(invoke).not.toHaveBeenCalled();
        await expect(session.openMdx("C:\\Notes\\a.mdx")).rejects.toMatchObject({
            code: "DESKTOP_REQUIRED",
        });
        expect(invoke).not.toHaveBeenCalled();
    });
});
