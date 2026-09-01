/** @vitest-environment jsdom */

import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MdxMetadata, MdxNote } from "../types/mdx";
import type { DiskRevisionResult, PathIdentity } from "../types/workspace";
import { useDocumentSession } from "./useDocumentSession";
import { useExternalFileSync } from "./useExternalFileSync";

type PayloadEvent<T> = { payload: T };
type EventListener = (event: PayloadEvent<{ paths: string[] }>) => Promise<void>;

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
    listener: null as EventListener | null,
    unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (_name: string, listener: EventListener) => {
        tauri.listener = listener;
        return tauri.unlisten;
    }),
}));

function metadata(title: string): MdxMetadata {
    return {
        id: title,
        title,
        summary: "",
        author: "",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
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

function note(path: string, content: string): MdxNote {
    const parts = path.split(/[\\/]/u);
    const title = parts[parts.length - 1]?.replace(/\.mdx$/iu, "") ?? path;
    return {
        path,
        title,
        content,
        manifest: {
            format: "MDXNote",
            formatVersion: "1.0.0",
            packageType: "single-note",
            contentFile: "content.md",
            metadataFile: "meta.json",
            assetsDir: "assets/",
            attachmentsDir: "attachments/",
            thumbnailsDir: "thumbnails/",
            encoding: "utf-8",
            encrypted: false,
            compression: "zip",
        },
        meta: metadata(title),
    };
}

describe("useExternalFileSync", () => {
    const contents = new Map<string, string>();
    const revisions = new Map<string, number>();

    beforeEach(() => {
        contents.clear();
        revisions.clear();
        tauri.listener = null;
        tauri.unlisten.mockReset();
        tauri.invoke.mockReset();
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            const payload = (args ?? {}) as Record<string, unknown>;
            if (command === "resolve_path") {
                const path = String(payload.path);
                return {
                    path,
                    identity: path.toLocaleLowerCase("en-US"),
                    available: true,
                } satisfies PathIdentity;
            }
            if (command === "open_mdx") {
                const path = String(payload.path);
                return note(path, contents.get(path) ?? path);
            }
            if (command === "get_disk_revisions") {
                return (payload.paths as string[]).map((path): DiskRevisionResult => ({
                    path,
                    available: true,
                    revision: {
                        path: path.toLocaleLowerCase("en-US"),
                        modifiedAtMs: revisions.get(path) ?? 1,
                        size: 1,
                    },
                    error: null,
                }));
            }
            if (
                command === "set_watched_document_paths" ||
                command === "write_workspace_session" ||
                command === "write_draft" ||
                command === "delete_draft"
            ) {
                return undefined;
            }
            throw new Error(`Unexpected command: ${command}`);
        });
    });

    it("reloads clean documents and preserves dirty documents on an external event", async () => {
        const session = useDocumentSession(true);
        const clean = await session.openMdx("C:\\Notes\\clean.mdx");
        const dirty = await session.openMdx("C:\\Notes\\dirty.mdx");
        session.updateContent(dirty.id, "local dirty");
        contents.set(clean.path!, "disk changed");
        contents.set(dirty.path!, "disk dirty changed");
        revisions.set(clean.path!, 2);
        revisions.set(dirty.path!, 2);
        const onReloaded = vi.fn();
        const onActiveConflict = vi.fn();
        const externalSync = useExternalFileSync({
            desktop: true,
            session,
            onReloaded,
            onActiveConflict,
        });
        await vi.waitFor(() => expect(tauri.listener).toBeTypeOf("function"));
        await nextTick();

        await tauri.listener?.({ payload: { paths: [clean.path!, dirty.path!] } });

        expect(session.document(clean.id).content).toBe("disk changed");
        expect(session.document(clean.id).changeSource).toBe("disk");
        expect(session.document(dirty.id).content).toBe("local dirty");
        expect(session.document(dirty.id).conflict).toBe(true);
        expect(onReloaded).toHaveBeenCalledWith([clean.id]);
        expect(onActiveConflict).toHaveBeenCalledWith(dirty.id);
        expect(tauri.invoke).toHaveBeenCalledWith("set_watched_document_paths", {
            paths: [clean.path, dirty.path],
        });

        externalSync.dispose();
        await externalSync.settled();
        expect(tauri.unlisten).toHaveBeenCalledTimes(1);
        expect(tauri.invoke).toHaveBeenLastCalledWith("set_watched_document_paths", {
            paths: [],
        });
        await session.dispose();
    });

    it("does not register a listener or invoke Tauri outside the desktop runtime", async () => {
        const session = useDocumentSession(false);
        const externalSync = useExternalFileSync({
            desktop: false,
            session,
            onReloaded: vi.fn(),
            onActiveConflict: vi.fn(),
        });

        externalSync.dispose();
        await externalSync.settled();

        expect(tauri.listener).toBeNull();
        expect(tauri.invoke).not.toHaveBeenCalled();
    });
});
