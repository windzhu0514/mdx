// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MdxMetadata, MdxNote, PendingResource } from "../types/mdx";
import type {
    DiskRevisionResult,
    FolderScan,
    PathIdentity,
    WorkspaceIndexRefresh,
    WorkspaceRefreshResult,
    WorkspaceSessionRead,
    WorkspaceSessionSnapshot,
} from "../types/workspace";
import { draftKey, type DraftSnapshot } from "./useDraftRecovery";
import { useDocumentSession } from "./useDocumentSession";

const invoke = vi.hoisted(() => vi.fn());
let workspaceRead: WorkspaceSessionRead;
const drafts = new Map<string, DraftSnapshot>();
const diskContents = new Map<string, string>();
const diskRevisions = new Map<string, number>();
const draftWriteAttempts: string[] = [];
let failNextDraftWrite = false;
const workspaceWriteSnapshots: WorkspaceSessionSnapshot[] = [];
const workspaceIndexReports = new Map<string, WorkspaceIndexRefresh>();
const workspaceRefreshFailures = new Set<string>();
let workspaceWriteHandler:
    ((snapshot: WorkspaceSessionSnapshot) => Promise<void>) | null = null;
let openMdxHandler: ((path: string) => Promise<MdxNote>) | null = null;
let saveHandler:
    | ((
          command: "save_mdx" | "save_mdx_as",
          request: {
              path: string | null;
              title: string;
              content: string;
              meta: MdxMetadata | null;
              newAssets: Array<{ name: string }>;
              removedResources?: string[];
          },
      ) => Promise<MdxNote>)
    | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

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

function indexRefresh(
    overrides: Partial<WorkspaceIndexRefresh> = {},
): WorkspaceIndexRefresh {
    return {
        discovered: 2,
        indexed: 2,
        unchanged: 0,
        removed: 0,
        failed: [],
        truncated: false,
        ...overrides,
    };
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
        vi.useFakeTimers();
        workspaceRead = { session: null, warning: null };
        drafts.clear();
        diskContents.clear();
        diskRevisions.clear();
        draftWriteAttempts.length = 0;
        failNextDraftWrite = false;
        workspaceWriteSnapshots.length = 0;
        workspaceIndexReports.clear();
        workspaceRefreshFailures.clear();
        workspaceWriteHandler = null;
        openMdxHandler = null;
        saveHandler = null;
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
                if (openMdxHandler) return openMdxHandler(path);
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
                    newAssets: Array<{ name: string }>;
                    removedResources?: string[];
                };
                if (saveHandler) return saveHandler(command, request);
                const path =
                    command === "save_mdx_as"
                        ? (() => {
                              const selected = normalizedPath(String(payload.path));
                              return /\.mdx$/i.test(selected)
                                  ? selected
                                  : `${selected}.mdx`;
                          })()
                        : normalizedPath(String(request.path));
                return {
                    ...note(path, request.title, request.content),
                    meta: request.meta ?? metadata(request.title),
                };
            }
            if (command === "refresh_workspace_folder") {
                const path = normalizedPath(String(payload.path));
                if (
                    /offline/i.test(path) ||
                    workspaceRefreshFailures.has(pathKey(path))
                ) {
                    throw new Error("unavailable");
                }
                return {
                    folder: {
                        path,
                        entries: [],
                        entryCount: 0,
                        truncated: false,
                    } satisfies FolderScan,
                    index: workspaceIndexReports.get(pathKey(path)) ?? indexRefresh(),
                } satisfies WorkspaceRefreshResult;
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
                const key = String(payload.key);
                draftWriteAttempts.push(key);
                if (failNextDraftWrite) {
                    failNextDraftWrite = false;
                    throw new Error("draft write failed");
                }
                drafts.set(key, payload.draft as DraftSnapshot);
                return undefined;
            }
            if (command === "delete_draft") {
                drafts.delete(String(payload.key));
                return undefined;
            }
            if (command === "write_workspace_session") {
                const snapshot = payload.session as WorkspaceSessionSnapshot;
                workspaceWriteSnapshots.push(snapshot);
                if (workspaceWriteHandler) await workspaceWriteHandler(snapshot);
                return undefined;
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    it("guards agent replacement with the current live revision", () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const base = runtime.liveRevision;

        session.replaceContent(runtime.id, "agent text", base);

        expect(runtime.content).toBe("agent text");
        expect(runtime.dirty).toBe(true);
        expect(runtime.liveRevision).not.toBe(base);
        expect(runtime.changeSource).toBe("agent");
        expect(() => session.replaceContent(runtime.id, "stale", base)).toThrowError(
            expect.objectContaining({ code: "REVISION_CONFLICT" }),
        );
    });

    it("does not advance the revision for a canonical no-op", () => {
        const session = useDocumentSession(false);
        const runtime = session.newDocument();
        const base = runtime.liveRevision;

        session.updateContent(runtime.id, runtime.content);

        expect(runtime.liveRevision).toBe(base);
    });

    it("advances the revision and marks the source after a disk reload", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\reload-revision.mdx");
        const base = runtime.liveRevision;
        diskContents.set(pathKey(runtime.path!), "reloaded from disk");
        diskRevisions.set(pathKey(runtime.path!), 2);

        await expect(session.refreshDiskState([runtime.path!])).resolves.toEqual([runtime.id]);

        expect(runtime.content).toBe("reloaded from disk");
        expect(runtime.liveRevision).not.toBe(base);
        expect(runtime.changeSource).toBe("disk");
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

    it("expands a workspace root whenever the folder is opened", async () => {
        const session = useDocumentSession(true);
        const folder = await session.openFolder("C:\\Root");

        expect(session.expandedPaths.value).toEqual([folder.path]);
        expect(folder.index).toEqual(indexRefresh());

        session.expandedPaths.value = [];
        await session.openFolder("c:\\root");

        expect(session.expandedPaths.value).toEqual([folder.path]);
        expect(invoke).toHaveBeenCalledTimes(3);
    });

    it("refreshes only the requested workspace root and returns its index report", async () => {
        const session = useDocumentSession(true);
        await session.openFolder("C:\\Root");
        await session.openFolder("D:\\Other");
        workspaceIndexReports.set(
            pathKey("C:\\Root"),
            indexRefresh({ indexed: 1, unchanged: 4, removed: 2 }),
        );
        invoke.mockClear();

        const report = await session.refreshFolder("c:/root/");

        expect(report).toEqual(indexRefresh({ indexed: 1, unchanged: 4, removed: 2 }));
        expect(session.folders.value[0].index).toEqual(report);
        expect(session.folders.value[1].index).toEqual(indexRefresh());
        expect(
            invoke.mock.calls.filter(
                ([command]) => command === "refresh_workspace_folder",
            ),
        ).toEqual([["refresh_workspace_folder", { path: "C:\\Root" }]]);
    });

    it("refreshes available roots while isolating a failed workspace root", async () => {
        const session = useDocumentSession(true);
        await session.openFolder("C:\\Root");
        await session.openFolder("D:\\Other");
        workspaceIndexReports.set(
            pathKey("D:\\Other"),
            indexRefresh({ indexed: 0, unchanged: 2 }),
        );
        workspaceRefreshFailures.add(pathKey("C:\\Root"));

        const reports = await session.refreshFolders();

        expect(reports).toEqual([indexRefresh({ indexed: 0, unchanged: 2 })]);
        expect(session.folders.value[0]).toMatchObject({
            path: "C:\\Root",
            unavailable: true,
            entries: [],
            index: indexRefresh({ discovered: 0, indexed: 0 }),
        });
        expect(session.folders.value[1]).toMatchObject({
            path: "D:\\Other",
            unavailable: false,
            index: indexRefresh({ indexed: 0, unchanged: 2 }),
        });
        expect(session.warnings.value.join(" ")).toContain("unavailable");
    });

    it("closes an open folder from its recorded identity without resolving its path again", async () => {
        const session = useDocumentSession(true);
        await session.openFolder("C:\\Root");
        const document = await session.openMdx("C:\\Root\\note.mdx");
        invoke.mockClear();

        await expect(
            session.closeFolder("c:/root/", {
                decide: async () => "discard",
                save: async () => true,
            }),
        ).resolves.toBe(true);

        expect(session.folders.value).toEqual([]);
        expect(session.documents.value).not.toContain(document);
        expect(invoke).not.toHaveBeenCalledWith("resolve_path", expect.anything());
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

    it("preflights all dirty documents in opening order and defers discard deletion on cancel", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\first.mdx");
        const second = await session.openMdx("C:\\Notes\\second.mdx");
        session.updateContent(first.id, "dirty first");
        session.updateContent(second.id, "dirty second");
        await first.draft.flush();
        await second.draft.flush();
        const prompted: string[] = [];

        const allowed = await session.prepareWindowClose({
            decide: async (document) => {
                prompted.push(document.id);
                if (document.id === second.id) {
                    expect(drafts.size).toBe(2);
                    return "cancel";
                }
                return "discard";
            },
            save: async () => true,
        });

        expect(allowed).toBe(false);
        expect(prompted).toEqual([first.id, second.id]);
        expect(session.documents.value.map((document) => document.id)).toEqual([
            first.id,
            second.id,
        ]);
        expect(drafts.size).toBe(2);
    });

    it("keeps every document and draft when a later window-close save fails", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\first.mdx");
        const second = await session.openMdx("C:\\Notes\\second.mdx");
        session.updateContent(first.id, "dirty first");
        session.updateContent(second.id, "dirty second");
        await first.draft.flush();
        await second.draft.flush();

        const allowed = await session.prepareWindowClose({
            decide: async (document) => (document.id === first.id ? "discard" : "save"),
            save: async () => false,
        });

        expect(allowed).toBe(false);
        expect(session.documents.value.map((document) => document.id)).toEqual([
            first.id,
            second.id,
        ]);
        expect(drafts.size).toBe(2);
    });

    it("deletes deferred discard drafts only after every close decision succeeds", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\first.mdx");
        const second = await session.openMdx("C:\\Notes\\second.mdx");
        session.updateContent(first.id, "dirty first");
        session.updateContent(second.id, "dirty second");
        await first.draft.flush();
        await second.draft.flush();

        await expect(
            session.prepareWindowClose({
                decide: async () => "discard",
                save: async () => true,
            }),
        ).resolves.toBe(true);

        expect(session.documents.value.map((document) => document.id)).toEqual([
            first.id,
            second.id,
        ]);
        expect(drafts.size).toBe(0);
        await session.dispose();
        expect(drafts.size).toBe(0);
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

    it("sends pending archive deletions with a normal save", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\attachment.mdx");
        runtime.resources.remove("attachments/old.pdf");

        await session.save(runtime.id);

        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({
                    path: "C:\\Notes\\attachment.mdx",
                    removedResources: ["attachments/old.pdf"],
                }),
            }),
        );
        expect(runtime.resources.removedResources()).toEqual([]);
    });

    it("uses the original document as the resource source during save-as", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\source.mdx");

        await session.saveAs(runtime.id, "C:\\Notes\\copy.mdx");

        expect(invoke).toHaveBeenCalledWith("save_mdx_as", {
            request: expect.objectContaining({
                path: "C:\\Notes\\source.mdx",
                removedResources: [],
            }),
            path: "C:\\Notes\\copy.mdx",
        });
    });

    it("keeps edits and new resources dirty when save resolves with an older snapshot", async () => {
        const pendingSave = deferred<MdxNote>();
        saveHandler = async () => pendingSave.promise;
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\race.mdx");
        session.updateContent(runtime.id, "sent content");
        runtime.resources.registerNew(pendingImage);

        const saving = session.save(runtime.id);
        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith(
                "save_mdx",
                expect.objectContaining({
                    request: expect.objectContaining({ content: "sent content" }),
                }),
            ),
        );
        session.updateContent(runtime.id, "newer content");
        runtime.resources.registerNew({
            ...pendingImage,
            path: "assets/b.png",
            originalName: "b.png",
            objectUrl: "blob:b",
        });
        pendingSave.resolve(note(runtime.path, runtime.displayName, "sent content"));

        await saving;

        expect(runtime.content).toBe("newer content");
        expect(runtime.dirty).toBe(true);
        expect(runtime.resources.newResources().map((resource) => resource.name)).toEqual(
            ["assets/a.png", "assets/b.png"],
        );
        expect(invoke).not.toHaveBeenCalledWith("delete_draft", expect.anything());
        await runtime.draft.flush();
        const savedDrafts = Array.from(drafts.values());
        expect(savedDrafts[savedDrafts.length - 1]).toMatchObject({
            content: "newer content",
            newResources: [
                expect.objectContaining({ name: "assets/a.png" }),
                expect.objectContaining({ name: "assets/b.png" }),
            ],
        });

        saveHandler = null;
        invoke.mockClear();
        await session.save(runtime.id);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({ content: "newer content" }),
            }),
        );
    });

    it("keeps edits dirty under the new identity when save-as resolves with an older snapshot", async () => {
        const pendingSave = deferred<MdxNote>();
        saveHandler = async () => pendingSave.promise;
        const session = useDocumentSession(true);
        const runtime = session.newDocument();
        session.updateContent(runtime.id, "sent content");

        const saving = session.saveAs(runtime.id, "C:\\Notes\\renamed.mdx");
        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith(
                "save_mdx_as",
                expect.objectContaining({
                    request: expect.objectContaining({ content: "sent content" }),
                }),
            ),
        );
        session.updateContent(runtime.id, "newer content");
        pendingSave.resolve(note("C:\\Notes\\renamed.mdx", "renamed", "sent content"));

        await saving;

        expect(runtime.path).toBe("C:\\Notes\\renamed.mdx");
        expect(runtime.pathIdentity).toBe("c:\\notes\\renamed.mdx");
        expect(runtime.content).toBe("newer content");
        expect(runtime.dirty).toBe(true);
        expect(invoke).not.toHaveBeenCalledWith("delete_draft", expect.anything());
        await runtime.draft.flush();
        expect(drafts.get(draftKey("C:\\Notes\\renamed.mdx", runtime.id))).toMatchObject({
            path: "C:\\Notes\\renamed.mdx",
            content: "newer content",
        });

        saveHandler = null;
        invoke.mockClear();
        await session.save(runtime.id);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({ content: "newer content" }),
            }),
        );
    });

    it("keeps metadata edits dirty when save resolves with older metadata", async () => {
        const pendingSave = deferred<MdxNote>();
        saveHandler = async () => pendingSave.promise;
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\meta-race.mdx");
        const newerMeta = metadata("meta-race", "newer-meta-id");
        newerMeta.tags = ["保存期间更新"];

        const saving = session.save(runtime.id);
        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith("save_mdx", expect.anything()),
        );
        session.updateMetadata(runtime.id, newerMeta);
        pendingSave.resolve(note(runtime.path, runtime.displayName, runtime.content));

        await saving;

        expect(runtime.meta).toEqual(newerMeta);
        expect(runtime.dirty).toBe(true);
        saveHandler = null;
        invoke.mockClear();
        await session.save(runtime.id);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({
                    meta: expect.objectContaining({
                        id: "newer-meta-id",
                        tags: ["保存期间更新"],
                    }),
                }),
            }),
        );
    });

    it("keeps metadata edits dirty when save-as resolves with older metadata", async () => {
        const pendingSave = deferred<MdxNote>();
        saveHandler = async () => pendingSave.promise;
        const session = useDocumentSession(true);
        const runtime = session.newDocument();
        const initialMeta = metadata("renamed", "initial-meta-id");
        session.updateMetadata(runtime.id, initialMeta);
        const newerMeta = metadata("renamed", "newer-save-as-meta-id");
        newerMeta.tags = ["另存期间更新"];

        const saving = session.saveAs(runtime.id, "C:\\Notes\\meta-save-as.mdx");
        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith("save_mdx_as", expect.anything()),
        );
        session.updateMetadata(runtime.id, newerMeta);
        pendingSave.resolve(
            note("C:\\Notes\\meta-save-as.mdx", "meta-save-as", runtime.content),
        );

        await saving;

        expect(runtime.meta).toEqual(newerMeta);
        expect(runtime.dirty).toBe(true);
        saveHandler = null;
        invoke.mockClear();
        await session.save(runtime.id);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({
                    meta: expect.objectContaining({
                        id: "newer-save-as-meta-id",
                        tags: ["另存期间更新"],
                    }),
                }),
            }),
        );
    });

    it("marks metadata-only history restoration dirty and saves the new metadata", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\meta.mdx");
        const restoredMeta = metadata("meta", "restored-meta-id");
        restoredMeta.tags = ["历史标签"];

        session.updateMetadata(runtime.id, restoredMeta);

        expect(runtime.content).toBe("meta");
        expect(runtime.dirty).toBe(true);
        await runtime.draft.flush();
        const savedDrafts = Array.from(drafts.values());
        expect(savedDrafts[savedDrafts.length - 1]?.meta).toEqual(restoredMeta);

        invoke.mockClear();
        await session.save(runtime.id);
        expect(invoke).toHaveBeenCalledWith(
            "save_mdx",
            expect.objectContaining({
                request: expect.objectContaining({
                    content: "meta",
                    meta: expect.objectContaining({
                        id: "restored-meta-id",
                        tags: ["历史标签"],
                    }),
                }),
            }),
        );
    });

    it("checks the actual mdx target identity when save-as omits the extension", async () => {
        const session = useDocumentSession(true);
        const existing = await session.openMdx("C:\\Notes\\taken.mdx");
        const untitled = session.newDocument();

        await expect(
            session.saveAs(untitled.id, "c:\\notes\\TAKEN"),
        ).rejects.toMatchObject({
            code: "TARGET_ALREADY_OPEN",
            documentId: existing.id,
        });
        expect(invoke).not.toHaveBeenCalledWith("save_mdx_as", expect.anything());
    });

    it("deletes the exact restored draft key before switching save-as identity", async () => {
        workspaceRead = {
            warning: null,
            session: {
                version: 1,
                documents: [
                    {
                        id: "restored-id",
                        path: "C:\\Notes\\source.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "exact-restored-key",
                    },
                ],
                folderPaths: [],
                expandedPaths: [],
                activeDocumentId: "restored-id",
                sidebarCollapsed: false,
                sidebarWidth: 260,
            },
        };
        drafts.set("exact-restored-key", {
            path: "C:\\Notes\\source.mdx",
            title: "restored",
            content: "local",
            meta: metadata("restored"),
            newResources: [],
            updatedAt: "2026-07-31T01:00:00.000Z",
        });
        const session = useDocumentSession(true);
        await session.restore();

        const saved = await session.saveAs("restored-id", "C:\\Notes\\renamed.MDX");

        expect(invoke).toHaveBeenCalledWith("delete_draft", {
            key: "exact-restored-key",
        });
        expect(drafts.has("exact-restored-key")).toBe(false);
        expect(saved.path).toBe("C:\\Notes\\renamed.MDX");
        expect(saved.pathIdentity).toBe("c:\\notes\\renamed.mdx");
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

    it("serializes an in-flight scheduled session write before the final dispose snapshot", async () => {
        vi.useFakeTimers();
        const firstWrite = deferred<void>();
        const finalWrite = deferred<void>();
        let writeNumber = 0;
        workspaceWriteHandler = async () => {
            writeNumber += 1;
            return writeNumber === 1 ? firstWrite.promise : finalWrite.promise;
        };
        const session = useDocumentSession(true);
        const first = session.newDocument();
        await vi.advanceTimersByTimeAsync(150);
        const second = session.newDocument();
        let disposed = false;

        const disposing = session.dispose().then(() => {
            disposed = true;
        });
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
        expect(workspaceWriteSnapshots).toHaveLength(1);
        expect(workspaceWriteSnapshots[0].documents.map((item) => item.id)).toEqual([
            first.id,
        ]);

        firstWrite.resolve();
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
        expect(workspaceWriteSnapshots).toHaveLength(2);
        expect(workspaceWriteSnapshots[1].documents.map((item) => item.id)).toEqual([
            first.id,
            second.id,
        ]);
        expect(disposed).toBe(false);

        finalWrite.resolve();
        await disposing;
        await vi.runAllTimersAsync();
        expect(disposed).toBe(true);
        expect(workspaceWriteSnapshots).toHaveLength(2);
    });

    it("cleans up and rethrows a scheduled session write failure after the final write", async () => {
        vi.useFakeTimers();
        const firstWrite = deferred<void>();
        let writeNumber = 0;
        workspaceWriteHandler = async () => {
            writeNumber += 1;
            if (writeNumber === 1) return firstWrite.promise;
        };
        const session = useDocumentSession(true);
        const first = session.newDocument();
        first.resources.registerNew(pendingImage);
        await vi.advanceTimersByTimeAsync(150);
        session.newDocument();

        const disposing = session.dispose();
        firstWrite.reject(new Error("session write failed"));

        await expect(disposing).rejects.toThrow("session write failed");
        expect(workspaceWriteSnapshots).toHaveLength(2);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
        expect(session.documents.value).toEqual([]);
        expect(session.activeDocumentId.value).toBeNull();
        await vi.runAllTimersAsync();
        expect(workspaceWriteSnapshots).toHaveLength(2);
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

    it("restores pending deletions and treats legacy drafts as having none", async () => {
        workspaceRead = {
            warning: null,
            session: {
                version: 1,
                documents: [
                    {
                        id: "removed-id",
                        path: "C:\\Notes\\removed.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "removed-key",
                    },
                    {
                        id: "legacy-id",
                        path: "C:\\Notes\\legacy.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "legacy-key",
                    },
                ],
                folderPaths: [],
                expandedPaths: [],
                activeDocumentId: "removed-id",
                sidebarCollapsed: false,
                sidebarWidth: 260,
            },
        };
        drafts.set("removed-key", {
            path: "C:\\Notes\\removed.mdx",
            title: "removed",
            content: "removed",
            meta: metadata("removed"),
            newResources: [],
            removedResources: ["attachments/old.pdf"],
            updatedAt: "2026-07-31T01:00:00.000Z",
        });
        drafts.set("legacy-key", {
            path: "C:\\Notes\\legacy.mdx",
            title: "legacy",
            content: "legacy",
            meta: metadata("legacy"),
            newResources: [],
            updatedAt: "2026-07-31T01:00:00.000Z",
        });
        const session = useDocumentSession(true);

        await session.restore();

        expect(session.document("removed-id").resources.removedResources()).toEqual([
            "attachments/old.pdf",
        ]);
        expect(session.document("legacy-id").resources.removedResources()).toEqual([]);
    });

    it("rejects an invalid version-one session shape before clearing current state", async () => {
        const session = useDocumentSession(true);
        const current = session.newDocument();
        workspaceRead = {
            warning: null,
            session: {
                version: 1,
                documents: "not-an-array",
                folderPaths: [],
                expandedPaths: [],
                activeDocumentId: null,
                sidebarCollapsed: false,
                sidebarWidth: 260,
            } as unknown as WorkspaceSessionSnapshot,
        };

        await expect(session.restore()).resolves.toBeUndefined();

        expect(session.documents.value.map((document) => document.id)).toEqual([
            current.id,
        ]);
        expect(session.activeDocumentId.value).toBe(current.id);
        expect(session.warnings.value.join(" ")).toContain("工作区会话");
    });

    it("rejects duplicate restored document ids before clearing current state", async () => {
        const session = useDocumentSession(true);
        const current = session.newDocument();
        workspaceRead = {
            warning: null,
            session: {
                version: 1,
                documents: [
                    {
                        id: "duplicate-id",
                        path: "C:\\Notes\\a.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "a-key",
                    },
                    {
                        id: "duplicate-id",
                        path: "C:\\Notes\\b.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "b-key",
                    },
                ],
                folderPaths: [],
                expandedPaths: [],
                activeDocumentId: "duplicate-id",
                sidebarCollapsed: false,
                sidebarWidth: 260,
            },
        };

        await expect(session.restore()).resolves.toBeUndefined();

        expect(session.documents.value.map((document) => document.id)).toEqual([
            current.id,
        ]);
        expect(session.activeDocumentId.value).toBe(current.id);
        expect(session.warnings.value.join(" ")).toContain("工作区会话");
        expect(invoke).not.toHaveBeenCalledWith("open_mdx", expect.anything());
    });

    it("deduplicates restored document and folder identities while mapping active duplicate", async () => {
        workspaceRead = {
            warning: null,
            session: {
                version: 1,
                documents: [
                    {
                        id: "first-a",
                        path: "C:\\Notes\\A.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "first-a-key",
                    },
                    {
                        id: "duplicate-a",
                        path: "c:\\notes\\a.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "duplicate-a-key",
                    },
                    {
                        id: "b",
                        path: "C:\\Notes\\b.mdx",
                        sourceKind: "mdx",
                        importSourcePath: null,
                        draftKey: "b-key",
                    },
                ],
                folderPaths: ["C:\\Root", "c:\\root", "D:\\Other"],
                expandedPaths: [],
                activeDocumentId: "duplicate-a",
                sidebarCollapsed: false,
                sidebarWidth: 260,
            },
        };
        const session = useDocumentSession(true);

        await session.restore();

        expect(session.documents.value.map((document) => document.id)).toEqual([
            "first-a",
            "b",
        ]);
        expect(session.activeDocumentId.value).toBe("first-a");
        expect(session.folders.value.map((folder) => folder.path)).toEqual([
            "C:\\Root",
            "D:\\Other",
        ]);
        expect(invoke).not.toHaveBeenCalledWith("read_draft", {
            key: "duplicate-a-key",
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

    it("preserves edits made while a clean disk reload is in flight", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\late-reload.mdx");
        const pendingOpen = deferred<MdxNote>();
        openMdxHandler = () => pendingOpen.promise;
        diskRevisions.set(pathKey(runtime.path!), 2);

        const refreshing = session.refreshDiskState();
        await vi.waitFor(() =>
            expect(
                invoke.mock.calls.filter(([command]) => command === "open_mdx"),
            ).toHaveLength(2),
        );
        session.updateContent(runtime.id, "local edit during reload");
        pendingOpen.resolve(note(runtime.path, runtime.displayName, "late disk content"));

        await expect(refreshing).resolves.toEqual([]);
        expect(runtime.content).toBe("local edit during reload");
        expect(runtime.dirty).toBe(true);
        expect(runtime.conflict).toBe(true);
    });

    it("ignores a late concurrent reload after the same revision was already applied", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\concurrent-reload.mdx");
        const firstOpen = deferred<MdxNote>();
        const secondOpen = deferred<MdxNote>();
        let reloadIndex = 0;
        openMdxHandler = () => [firstOpen.promise, secondOpen.promise][reloadIndex++]!;
        diskRevisions.set(pathKey(runtime.path!), 2);

        const firstRefresh = session.refreshDiskState();
        const secondRefresh = session.refreshDiskState();
        await vi.waitFor(() =>
            expect(
                invoke.mock.calls.filter(([command]) => command === "open_mdx"),
            ).toHaveLength(3),
        );
        secondOpen.resolve(
            note(runtime.path, runtime.displayName, "applied disk content"),
        );
        await expect(secondRefresh).resolves.toEqual([runtime.id]);
        firstOpen.resolve(
            note(runtime.path, runtime.displayName, "late duplicate response"),
        );

        await expect(firstRefresh).resolves.toEqual([]);
        expect(runtime.content).toBe("applied disk content");
        expect(runtime.diskRevision?.modifiedAtMs).toBe(2);
        expect(runtime.conflict).toBe(false);
    });

    it("checks the target revision immediately before save and keeps the conflict dirty", async () => {
        const session = useDocumentSession(true);
        const runtime = await session.openMdx("C:\\Notes\\changed-before-save.mdx");
        session.updateContent(runtime.id, "local edit");
        await runtime.draft.flush();
        diskRevisions.set(pathKey(runtime.path!), 2);

        await expect(session.save(runtime.id)).rejects.toMatchObject({
            code: "EXTERNAL_CONFLICT",
            documentId: runtime.id,
        });

        expect(runtime.content).toBe("local edit");
        expect(runtime.dirty).toBe(true);
        expect(runtime.conflict).toBe(true);
        expect(Array.from(drafts.values())[0]?.content).toBe("local edit");
        expect(invoke).not.toHaveBeenCalledWith("save_mdx", expect.anything());
    });

    it("reloads only the requested conflicted document and removes only its draft", async () => {
        const session = useDocumentSession(true);
        const first = await session.openMdx("C:\\Notes\\first.mdx");
        const second = await session.openMdx("C:\\Notes\\second.mdx");
        session.updateContent(first.id, "local first");
        session.updateContent(second.id, "local second");
        await first.draft.flush();
        await second.draft.flush();
        diskContents.set(pathKey(first.path!), "disk first");
        diskContents.set(pathKey(second.path!), "disk second");
        diskRevisions.set(pathKey(first.path!), 2);
        diskRevisions.set(pathKey(second.path!), 2);
        await session.refreshDiskState();

        await session.reloadFromDisk(first.id);

        expect(first.content).toBe("disk first");
        expect(first.dirty).toBe(false);
        expect(first.conflict).toBe(false);
        expect(second.content).toBe("local second");
        expect(second.dirty).toBe(true);
        expect(second.conflict).toBe(true);
        expect(drafts.size).toBe(1);
        expect(Array.from(drafts.values())[0]?.content).toBe("local second");
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

    it("continues disposal after one draft flush fails and rethrows after cleanup", async () => {
        const session = useDocumentSession(true);
        const first = session.newDocument();
        const second = session.newDocument();
        first.resources.registerNew(pendingImage);
        second.resources.registerNew({
            ...pendingImage,
            path: "assets/b.png",
            originalName: "b.png",
            objectUrl: "blob:b",
        });
        session.updateContent(first.id, "![a](blob:a)");
        session.updateContent(second.id, "![b](blob:b)");
        failNextDraftWrite = true;

        await expect(session.dispose()).rejects.toThrow("draft write failed");

        expect(draftWriteAttempts).toHaveLength(2);
        expect(invoke).toHaveBeenCalledWith("write_workspace_session", expect.anything());
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:b");
        expect(session.documents.value).toEqual([]);
        expect(session.activeDocumentId.value).toBeNull();
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
