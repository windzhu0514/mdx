import { invoke } from "@tauri-apps/api/core";
import { computed, ref, shallowRef, triggerRef } from "vue";

import type {
    ImportedMarkdown,
    MdxMetadata,
    MdxNote,
    ResourceSaveData,
} from "../types/mdx";
import type {
    DiskRevision,
    DiskRevisionResult,
    FolderScan,
    PathIdentity,
    WorkspaceFolder,
    WorkspaceSessionRead,
    WorkspaceSessionSnapshot,
} from "../types/workspace";
import {
    createDraftRecovery,
    draftKey,
    type DraftSnapshot,
    type DraftStore,
} from "./useDraftRecovery";
import { createResourceSession, type ResourceSession } from "./useResources";
import { documentNameFromPath } from "../utils/text";

export type OpenDocument = {
    id: string;
    path: string | null;
    pathIdentity: string | null;
    sourceKind: "mdx" | "markdown-import" | "untitled";
    importSourcePath: string | null;
    displayName: string;
    content: string;
    meta: MdxMetadata | null;
    dirty: boolean;
    diskRevision: DiskRevision | null;
    conflict: boolean;
    unavailable: boolean;
};

export type SessionDocument = OpenDocument & {
    resources: ResourceSession;
    draft: ReturnType<typeof createDraftRecovery>;
};

export type CloseActions = {
    decide(document: OpenDocument): Promise<"save" | "discard" | "cancel">;
    save(documentId: string): Promise<boolean>;
};

function baseName(path: string) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function mdxTargetPath(path: string) {
    return /\.mdx$/iu.test(path) ? path : `${path}.mdx`;
}

function workspacePathKey(path: string) {
    return path.replace(/\//gu, "\\").replace(/\\+$/u, "").toLocaleLowerCase("en-US");
}

export function sameResources(left: ResourceSaveData[], right: ResourceSaveData[]) {
    return (
        left.length === right.length &&
        left.every((resource, index) => {
            const other = right[index];
            return (
                other !== undefined &&
                resource.name === other.name &&
                resource.originalName === other.originalName &&
                resource.mimeType === other.mimeType &&
                resource.size === other.size &&
                resource.kind === other.kind &&
                resource.base64 === other.base64
            );
        })
    );
}

function isInside(identity: string, rootIdentity: string) {
    const root = rootIdentity.replace(/[\\/]+$/, "");
    return (
        identity === root ||
        identity.startsWith(`${root}\\`) ||
        identity.startsWith(`${root}/`)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
    return typeof value === "string" || value === null;
}

function isWorkspaceSessionSnapshot(value: unknown): value is WorkspaceSessionSnapshot {
    if (!isRecord(value) || value.version !== 1) return false;
    if (
        !Array.isArray(value.documents) ||
        !Array.isArray(value.folderPaths) ||
        !value.folderPaths.every((path) => typeof path === "string") ||
        !Array.isArray(value.expandedPaths) ||
        !value.expandedPaths.every((path) => typeof path === "string") ||
        !isNullableString(value.activeDocumentId) ||
        typeof value.sidebarCollapsed !== "boolean" ||
        typeof value.sidebarWidth !== "number" ||
        !Number.isFinite(value.sidebarWidth)
    ) {
        return false;
    }

    const documentIds = new Set<string>();
    for (const document of value.documents) {
        if (
            !isRecord(document) ||
            typeof document.id !== "string" ||
            documentIds.has(document.id) ||
            !isNullableString(document.path) ||
            (document.sourceKind !== "mdx" &&
                document.sourceKind !== "markdown-import" &&
                document.sourceKind !== "untitled") ||
            !isNullableString(document.importSourcePath) ||
            typeof document.draftKey !== "string"
        ) {
            return false;
        }
        documentIds.add(document.id);
    }
    return true;
}

function isWorkspaceSessionRead(value: unknown): value is WorkspaceSessionRead {
    return (
        isRecord(value) &&
        isNullableString(value.warning) &&
        (value.session === null || isWorkspaceSessionSnapshot(value.session))
    );
}

export function useDocumentSession(desktop: boolean) {
    const documents = shallowRef<SessionDocument[]>([]);
    const activeDocumentId = ref<string | null>(null);
    const folders = shallowRef<WorkspaceFolder[]>([]);
    const expandedPaths = ref<string[]>([]);
    const collapsed = ref(false);
    const width = ref(260);
    const warnings = ref<string[]>([]);
    const folderIdentities = new Map<string, string>();
    const draftKeys = new Map<string, string>();
    const discardedForWindowClose = new Set<string>();
    let nextDocumentId = 1;
    let nextUntitledNumber = 1;
    let sessionWriteTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionWriteTail: Promise<void> = Promise.resolve();
    const noSessionWriteError = Symbol("no-session-write-error");
    let sessionWriteError: unknown | typeof noSessionWriteError = noSessionWriteError;

    const draftStore: DraftStore = desktop
        ? {
              write: (key, draft) => invoke("write_draft", { key, draft }),
              read: (key) => invoke<DraftSnapshot | null>("read_draft", { key }),
              remove: (key) => invoke("delete_draft", { key }),
          }
        : {
              write: async () => undefined,
              read: async () => null,
              remove: async () => undefined,
          };

    const activeDocument = computed(
        () =>
            documents.value.find((document) => document.id === activeDocumentId.value) ??
            null,
    );

    function document(id: string) {
        const found = documents.value.find((item) => item.id === id);
        if (!found) throw new Error(`Unknown document: ${id}`);
        return found;
    }

    function sessionDocument(
        state: OpenDocument,
        resources = createResourceSession(),
        restoredDraftKey?: string,
    ): SessionDocument {
        draftKeys.set(
            state.id,
            restoredDraftKey ?? draftKey(state.path ?? state.importSourcePath, state.id),
        );
        const recovery = createDraftRecovery(
            draftStore,
            () => draftKeys.get(runtime.id) ?? draftKey(null, runtime.id),
            (): DraftSnapshot => ({
                path: runtime.path,
                title: runtime.displayName,
                content: runtime.content,
                meta: runtime.meta,
                newResources: runtime.resources.snapshot().newResources,
                updatedAt: new Date().toISOString(),
            }),
        );
        const runtime: SessionDocument = { ...state, resources, draft: recovery };
        return runtime;
    }

    function addDocument(runtime: SessionDocument, scheduleWrite = true) {
        documents.value = [...documents.value, runtime];
        activeDocumentId.value = runtime.id;
        if (scheduleWrite) scheduleSessionWrite();
        return runtime;
    }

    function requireDesktop() {
        if (desktop) return;
        throw { code: "DESKTOP_REQUIRED" };
    }

    async function resolve(path: string) {
        requireDesktop();
        return invoke<PathIdentity>("resolve_path", { path });
    }

    async function readRevision(path: string) {
        requireDesktop();
        const [result] = await invoke<DiskRevisionResult[]>("get_disk_revisions", {
            paths: [path],
        });
        return result?.revision ?? null;
    }

    function existingByIdentity(identity: string) {
        return documents.value.find((item) => item.pathIdentity === identity);
    }

    function enqueueSessionWrite(session: WorkspaceSessionSnapshot) {
        const write = sessionWriteTail.then(() =>
            invoke<void>("write_workspace_session", { session }),
        );
        sessionWriteTail = write.catch((error: unknown) => {
            if (sessionWriteError === noSessionWriteError) {
                sessionWriteError = error;
            }
        });
        return write;
    }

    function takeSessionWriteError() {
        if (sessionWriteError === noSessionWriteError) return noSessionWriteError;
        const error = sessionWriteError;
        sessionWriteError = noSessionWriteError;
        return error;
    }

    async function persist() {
        if (!desktop) return;
        if (sessionWriteTimer) {
            clearTimeout(sessionWriteTimer);
            sessionWriteTimer = null;
        }
        const session: WorkspaceSessionSnapshot = {
            version: 1,
            documents: documents.value.map((runtime) => ({
                id: runtime.id,
                path: runtime.path,
                sourceKind: runtime.sourceKind,
                importSourcePath: runtime.importSourcePath,
                draftKey:
                    draftKeys.get(runtime.id) ??
                    draftKey(runtime.path ?? runtime.importSourcePath, runtime.id),
            })),
            folderPaths: folders.value.map((folder) => folder.path),
            expandedPaths: [...expandedPaths.value],
            activeDocumentId: activeDocumentId.value,
            sidebarCollapsed: collapsed.value,
            sidebarWidth: width.value,
        };
        await enqueueSessionWrite(session);
    }

    function scheduleSessionWrite() {
        if (!desktop) return;
        if (sessionWriteTimer) clearTimeout(sessionWriteTimer);
        sessionWriteTimer = setTimeout(() => {
            sessionWriteTimer = null;
            void persist().catch((error: unknown) => {
                warnings.value = [...warnings.value, String(error)];
            });
        }, 150);
    }

    function activate(id: string) {
        if (!documents.value.some((item) => item.id === id)) return false;
        activeDocumentId.value = id;
        scheduleSessionWrite();
        return true;
    }

    function newDocument() {
        const number = nextUntitledNumber++;
        const id = `document-${nextDocumentId++}`;
        return addDocument(
            sessionDocument({
                id,
                path: null,
                pathIdentity: null,
                sourceKind: "untitled",
                importSourcePath: null,
                displayName: `未命名文档 ${number}`,
                content: "",
                meta: null,
                dirty: false,
                diskRevision: null,
                conflict: false,
                unavailable: false,
            }),
        );
    }

    async function openMdx(path: string) {
        const resolved = await resolve(path);
        const existing = existingByIdentity(resolved.identity);
        if (existing) {
            activate(existing.id);
            return existing;
        }

        const note = await invoke<MdxNote>("open_mdx", { path: resolved.path });
        return addDocument(
            sessionDocument({
                id: `document-${nextDocumentId++}`,
                path: note.path ?? resolved.path,
                pathIdentity: resolved.identity,
                sourceKind: "mdx",
                importSourcePath: null,
                displayName: note.title || baseName(resolved.path),
                content: note.content,
                meta: note.meta,
                dirty: false,
                diskRevision: await readRevision(resolved.path),
                conflict: false,
                unavailable: !resolved.available,
            }),
        );
    }

    async function openMarkdown(path: string) {
        const resolved = await resolve(path);
        const existing = existingByIdentity(resolved.identity);
        if (existing) {
            activate(existing.id);
            return existing;
        }

        const imported = await invoke<ImportedMarkdown>("import_markdown", {
            path: resolved.path,
        });
        const runtime = sessionDocument({
            id: `document-${nextDocumentId++}`,
            path: null,
            pathIdentity: resolved.identity,
            sourceKind: "markdown-import",
            importSourcePath: resolved.path,
            displayName: baseName(resolved.path),
            content: imported.content,
            meta: null,
            dirty: true,
            diskRevision: null,
            conflict: false,
            unavailable: !resolved.available,
        });
        if (imported.frontMatter) {
            const created = await invoke<MdxNote>("create_mdx");
            runtime.meta = {
                ...created.meta,
                title: imported.title,
                author: imported.frontMatter.author,
                summary: imported.frontMatter.summary,
                tags: imported.frontMatter.tags,
                category: imported.frontMatter.categories[0] ?? "",
            };
        }
        return addDocument(runtime);
    }

    async function openFolder(path: string) {
        const resolved = await resolve(path);
        const existing = folders.value.find(
            (folder) => folderIdentities.get(folder.path) === resolved.identity,
        );
        if (existing) {
            const expanded = expandedPaths.value.some(
                (item) => workspacePathKey(item) === workspacePathKey(existing.path),
            );
            if (!expanded) {
                expandedPaths.value = [...expandedPaths.value, existing.path];
                scheduleSessionWrite();
            }
            return existing;
        }

        const scan = await invoke<FolderScan>("scan_workspace_folder", {
            path: resolved.path,
        });
        const folder: WorkspaceFolder = {
            ...scan,
            name: baseName(scan.path),
            unavailable: !resolved.available,
            error: null,
        };
        folderIdentities.set(folder.path, resolved.identity);
        folders.value = [...folders.value, folder];
        expandedPaths.value = [...expandedPaths.value, folder.path];
        scheduleSessionWrite();
        return folder;
    }

    function updateContent(id: string, markdown: string) {
        const runtime = document(id);
        const canonical = runtime.resources.persistedMarkdown(markdown);
        if (canonical === runtime.content) return;
        runtime.content = canonical;
        runtime.dirty = true;
        runtime.draft.schedule();
        triggerRef(documents);
    }

    function updateMetadata(id: string, meta: MdxMetadata) {
        const runtime = document(id);
        runtime.meta = meta;
        runtime.dirty = true;
        runtime.draft.schedule();
        triggerRef(documents);
    }

    async function releaseDocument(runtime: SessionDocument) {
        try {
            await runtime.draft.dispose();
        } finally {
            runtime.resources.clear();
        }
    }

    async function save(id: string, options: { overwrite?: boolean } = {}) {
        requireDesktop();
        const runtime = document(id);
        if (!runtime.path) throw { code: "SAVE_AS_REQUIRED", documentId: id };
        if (!options.overwrite) {
            const currentRevision = await readRevision(runtime.path);
            if (!revisionsEqual(runtime.diskRevision, currentRevision)) {
                runtime.conflict = true;
                documents.value = [...documents.value];
                throw { code: "EXTERNAL_CONFLICT", documentId: id };
            }
        }
        const storageKey =
            draftKeys.get(runtime.id) ?? draftKey(runtime.path, runtime.id);
        const title = documentNameFromPath(runtime.path);
        const requestedContent = runtime.resources.persistedMarkdown(runtime.content);
        const requestedResources = runtime.resources.newResources();
        const requestedMetadata = JSON.stringify(runtime.meta);
        const saved = await invoke<MdxNote>("save_mdx", {
            request: {
                path: runtime.path,
                title,
                content: requestedContent,
                meta: runtime.meta ? { ...runtime.meta, title } : null,
                newAssets: requestedResources,
            },
        });

        runtime.path = saved.path ?? runtime.path;
        runtime.displayName = saved.title;
        runtime.diskRevision = await readRevision(runtime.path);
        runtime.conflict = false;
        runtime.unavailable = false;
        draftKeys.set(runtime.id, draftKey(runtime.path, runtime.id));
        const metadataChanged = JSON.stringify(runtime.meta) !== requestedMetadata;
        const changedWhileSaving =
            runtime.resources.persistedMarkdown(runtime.content) !== requestedContent ||
            !sameResources(runtime.resources.newResources(), requestedResources) ||
            metadataChanged;
        if (!metadataChanged) runtime.meta = saved.meta;
        if (changedWhileSaving) {
            runtime.dirty = true;
            runtime.draft.schedule();
        } else {
            runtime.content = runtime.resources.persistedMarkdown(saved.content);
            runtime.dirty = false;
            runtime.resources.markSaved();
            await runtime.draft.remove(storageKey);
        }
        triggerRef(documents);
        return runtime;
    }

    async function saveAs(id: string, path: string) {
        requireDesktop();
        const runtime = document(id);
        const resolved = await resolve(mdxTargetPath(path));
        const owner = documents.value.find(
            (item) => item.id !== id && item.pathIdentity === resolved.identity,
        );
        if (owner) {
            throw {
                code: "TARGET_ALREADY_OPEN",
                documentId: owner.id,
            };
        }

        const previousDraftKey =
            draftKeys.get(runtime.id) ??
            draftKey(runtime.path ?? runtime.importSourcePath, runtime.id);
        const title = documentNameFromPath(resolved.path);
        const requestedContent = runtime.resources.persistedMarkdown(runtime.content);
        const requestedResources = runtime.resources.newResources();
        const requestedMetadata = JSON.stringify(runtime.meta);
        const saved = await invoke<MdxNote>("save_mdx_as", {
            request: {
                path: resolved.path,
                title,
                content: requestedContent,
                meta: runtime.meta ? { ...runtime.meta, title } : null,
                newAssets: requestedResources,
            },
            path: resolved.path,
        });

        const savedIdentity = await resolve(saved.path ?? resolved.path);

        runtime.path = savedIdentity.path;
        runtime.pathIdentity = savedIdentity.identity;
        runtime.sourceKind = "mdx";
        runtime.importSourcePath = null;
        runtime.displayName = saved.title;
        runtime.diskRevision = await readRevision(runtime.path);
        runtime.conflict = false;
        runtime.unavailable = false;
        draftKeys.set(runtime.id, draftKey(runtime.path, runtime.id));
        const metadataChanged = JSON.stringify(runtime.meta) !== requestedMetadata;
        const changedWhileSaving =
            runtime.resources.persistedMarkdown(runtime.content) !== requestedContent ||
            !sameResources(runtime.resources.newResources(), requestedResources) ||
            metadataChanged;
        if (!metadataChanged) runtime.meta = saved.meta;
        if (changedWhileSaving) {
            runtime.dirty = true;
            runtime.draft.schedule();
        } else {
            runtime.content = runtime.resources.persistedMarkdown(saved.content);
            runtime.dirty = false;
            runtime.resources.markSaved();
            await runtime.draft.remove(previousDraftKey);
        }
        triggerRef(documents);
        scheduleSessionWrite();
        return runtime;
    }

    async function closeDocument(id: string, actions: CloseActions) {
        const runtime = document(id);
        if (runtime.dirty) {
            const decision = await actions.decide(runtime);
            if (decision === "cancel") return false;
            if (decision === "save" && !(await actions.save(id))) return false;
            if (decision === "discard") await runtime.draft.remove();
        }

        await releaseDocument(runtime);
        documents.value = documents.value.filter((item) => item.id !== id);
        draftKeys.delete(id);
        chooseNextActiveDocument(new Set([id]));
        await persist();
        return true;
    }

    function chooseNextActiveDocument(removedIds: Set<string>) {
        if (activeDocumentId.value !== null && !removedIds.has(activeDocumentId.value)) {
            return;
        }
        activeDocumentId.value = documents.value[documents.value.length - 1]?.id ?? null;
    }

    async function closeFolder(path: string, actions: CloseActions) {
        const folder = folders.value.find(
            (item) => workspacePathKey(item.path) === workspacePathKey(path),
        );
        if (!folder) return false;
        const rootIdentity = folderIdentities.get(folder.path);
        if (!rootIdentity) return false;
        const targets = documents.value.filter(
            (item) =>
                item.pathIdentity !== null && isInside(item.pathIdentity, rootIdentity),
        );
        const discarded: SessionDocument[] = [];

        for (const runtime of targets) {
            if (!runtime.dirty) continue;
            const decision = await actions.decide(runtime);
            if (decision === "cancel") return false;
            if (decision === "save" && !(await actions.save(runtime.id))) return false;
            if (decision === "discard") discarded.push(runtime);
        }

        for (const runtime of discarded) await runtime.draft.remove();
        for (const runtime of targets) await releaseDocument(runtime);
        const removedIds = new Set(targets.map((item) => item.id));
        documents.value = documents.value.filter((item) => !removedIds.has(item.id));
        for (const id of removedIds) draftKeys.delete(id);
        chooseNextActiveDocument(removedIds);
        folders.value = folders.value.filter(
            (item) => workspacePathKey(item.path) !== workspacePathKey(folder.path),
        );
        folderIdentities.delete(folder.path);
        await persist();
        return true;
    }

    function folderContainsDocument(path: string, documentId: string) {
        const rootIdentity = folderIdentities.get(path);
        const runtime = documents.value.find((item) => item.id === documentId);
        return Boolean(
            rootIdentity &&
            runtime?.pathIdentity &&
            isInside(runtime.pathIdentity, rootIdentity),
        );
    }

    async function prepareWindowClose(actions: CloseActions) {
        const discarded: SessionDocument[] = [];
        for (const runtime of documents.value) {
            if (!runtime.dirty) continue;
            const decision = await actions.decide(runtime);
            if (decision === "cancel") return false;
            if (decision === "save" && !(await actions.save(runtime.id))) return false;
            if (decision === "discard") discarded.push(runtime);
        }

        const removed: SessionDocument[] = [];
        try {
            for (const runtime of discarded) {
                await runtime.draft.remove();
                removed.push(runtime);
                discardedForWindowClose.add(runtime.id);
            }
        } catch (error) {
            for (const runtime of removed) {
                discardedForWindowClose.delete(runtime.id);
                runtime.draft.schedule();
                await runtime.draft.flush();
            }
            throw error;
        }
        return true;
    }

    async function restore() {
        if (!desktop) return;
        const readValue = await invoke<unknown>("read_workspace_session");
        if (!isWorkspaceSessionRead(readValue)) {
            warnings.value = [...warnings.value, "工作区会话数据无效，已保留当前会话。"];
            return;
        }

        if (sessionWriteTimer) {
            clearTimeout(sessionWriteTimer);
            sessionWriteTimer = null;
        }
        for (const runtime of documents.value) await releaseDocument(runtime);
        documents.value = [];
        activeDocumentId.value = null;
        folders.value = [];
        folderIdentities.clear();
        draftKeys.clear();
        warnings.value = [];

        const read = readValue;
        if (read.warning) warnings.value = [read.warning];
        if (!read.session) return;

        const restoredDocuments: SessionDocument[] = [];
        const restoredDocumentOwners = new Map<string, string>();
        const restoredIdAliases = new Map<string, string>();
        for (const saved of read.session.documents) {
            let path = saved.path;
            let pathIdentity: string | null = null;
            let displayName = saved.path
                ? baseName(saved.path)
                : saved.importSourcePath
                  ? baseName(saved.importSourcePath)
                  : `未命名文档 ${nextUntitledNumber++}`;
            let content = "";
            let meta: MdxMetadata | null = null;
            let unavailable = false;

            try {
                const sourcePath = saved.path ?? saved.importSourcePath;
                if (sourcePath) {
                    const resolved = await resolve(sourcePath);
                    pathIdentity = resolved.identity;
                    const ownerId = restoredDocumentOwners.get(resolved.identity);
                    if (ownerId) {
                        restoredIdAliases.set(saved.id, ownerId);
                        continue;
                    }
                    restoredDocumentOwners.set(resolved.identity, saved.id);
                    unavailable = !resolved.available;
                    if (saved.path) path = resolved.path;
                    if (resolved.available && saved.sourceKind === "mdx") {
                        const note = await invoke<MdxNote>("open_mdx", {
                            path: resolved.path,
                        });
                        path = note.path ?? resolved.path;
                        displayName = note.title;
                        content = note.content;
                        meta = note.meta;
                    } else if (
                        resolved.available &&
                        saved.sourceKind === "markdown-import"
                    ) {
                        const imported = await invoke<ImportedMarkdown>(
                            "import_markdown",
                            { path: resolved.path },
                        );
                        displayName = baseName(resolved.path);
                        content = imported.content;
                    }
                } else {
                    const untitledIdentity = `untitled:${saved.id}`;
                    const ownerId = restoredDocumentOwners.get(untitledIdentity);
                    if (ownerId) {
                        restoredIdAliases.set(saved.id, ownerId);
                        continue;
                    }
                    restoredDocumentOwners.set(untitledIdentity, saved.id);
                }
            } catch (error) {
                unavailable = true;
                warnings.value = [...warnings.value, String(error)];
            }

            const runtime = sessionDocument(
                {
                    id: saved.id,
                    path,
                    pathIdentity,
                    sourceKind: saved.sourceKind,
                    importSourcePath: saved.importSourcePath,
                    displayName,
                    content,
                    meta,
                    dirty: saved.sourceKind !== "mdx",
                    diskRevision: path && !unavailable ? await readRevision(path) : null,
                    conflict: false,
                    unavailable,
                },
                createResourceSession(),
                saved.draftKey,
            );
            try {
                const draft = await runtime.draft.read(saved.draftKey);
                if (draft) {
                    runtime.resources.restore({
                        newResources: draft.newResources,
                    });
                    runtime.path = draft.path ?? runtime.path;
                    runtime.displayName = draft.title;
                    runtime.content = runtime.resources.persistedMarkdown(draft.content);
                    runtime.meta = draft.meta;
                    runtime.dirty = true;
                }
            } catch (error) {
                warnings.value = [...warnings.value, String(error)];
            }
            restoredDocuments.push(runtime);
            restoredIdAliases.set(saved.id, saved.id);
            const match = /^document-(\d+)$/.exec(saved.id);
            if (match) nextDocumentId = Math.max(nextDocumentId, Number(match[1]) + 1);
        }
        documents.value = restoredDocuments;

        const restoredFolderIdentities = new Set<string>();
        for (const folderPath of read.session.folderPaths) {
            let resolved: PathIdentity | null = null;
            try {
                resolved = await resolve(folderPath);
                if (restoredFolderIdentities.has(resolved.identity)) continue;
                restoredFolderIdentities.add(resolved.identity);
                if (!resolved.available) throw new Error("文件夹暂时不可用");
                const scan = await invoke<FolderScan>("scan_workspace_folder", {
                    path: resolved.path,
                });
                const folder: WorkspaceFolder = {
                    ...scan,
                    name: baseName(scan.path),
                    unavailable: false,
                    error: null,
                };
                folderIdentities.set(folder.path, resolved.identity);
                folders.value = [...folders.value, folder];
            } catch (error) {
                const normalizedPath = resolved?.path ?? folderPath;
                const identity = resolved?.identity ?? normalizedPath;
                const folder: WorkspaceFolder = {
                    path: normalizedPath,
                    name: baseName(normalizedPath),
                    entries: [],
                    entryCount: 0,
                    truncated: false,
                    unavailable: true,
                    error: String(error),
                };
                folderIdentities.set(folder.path, identity);
                folders.value = [...folders.value, folder];
                warnings.value = [...warnings.value, String(error)];
            }
        }

        expandedPaths.value = [...read.session.expandedPaths];
        collapsed.value = read.session.sidebarCollapsed;
        width.value = read.session.sidebarWidth;
        const restoredActiveId = read.session.activeDocumentId
            ? (restoredIdAliases.get(read.session.activeDocumentId) ??
              read.session.activeDocumentId)
            : null;
        activeDocumentId.value = documents.value.some(
            (runtime) => runtime.id === restoredActiveId,
        )
            ? restoredActiveId
            : (documents.value[0]?.id ?? null);
    }

    function revisionsEqual(left: DiskRevision | null, right: DiskRevision | null) {
        return left?.modifiedAtMs === right?.modifiedAtMs && left?.size === right?.size;
    }

    async function reloadFromDisk(id: string) {
        requireDesktop();
        const runtime = document(id);
        if (!runtime.path) throw { code: "RELOAD_REQUIRES_PATH", documentId: id };
        const storageKey =
            draftKeys.get(runtime.id) ?? draftKey(runtime.path, runtime.id);
        const note = await invoke<MdxNote>("open_mdx", { path: runtime.path });
        const revision = await readRevision(runtime.path);

        await runtime.draft.remove(storageKey);
        runtime.resources.clear();
        runtime.path = note.path ?? runtime.path;
        runtime.displayName = note.title;
        runtime.content = note.content;
        runtime.meta = note.meta;
        runtime.dirty = false;
        runtime.diskRevision = revision;
        runtime.conflict = false;
        runtime.unavailable = false;
        documents.value = [...documents.value];
        return runtime;
    }

    async function refreshDiskState() {
        if (!desktop) return [];
        const saved = documents.value.filter(
            (runtime): runtime is SessionDocument & { path: string } =>
                runtime.path !== null,
        );
        if (saved.length === 0) return [];
        const results = await invoke<DiskRevisionResult[]>("get_disk_revisions", {
            paths: saved.map((runtime) => runtime.path),
        });
        const reloadedIds: string[] = [];

        for (let index = 0; index < saved.length; index += 1) {
            const runtime = saved[index];
            const result = results[index];
            if (!result?.available || !result.revision) {
                runtime.unavailable = true;
                continue;
            }
            runtime.unavailable = false;
            if (revisionsEqual(runtime.diskRevision, result.revision)) continue;
            if (runtime.diskRevision === null) {
                runtime.diskRevision = result.revision;
                continue;
            }
            if (runtime.dirty) {
                runtime.conflict = true;
                continue;
            }

            try {
                const revisionBeforeReload = runtime.diskRevision;
                const note = await invoke<MdxNote>("open_mdx", {
                    path: runtime.path,
                });
                if (runtime.dirty) {
                    runtime.conflict = true;
                    continue;
                }
                if (!revisionsEqual(runtime.diskRevision, revisionBeforeReload)) {
                    if (revisionsEqual(runtime.diskRevision, result.revision)) continue;
                    runtime.conflict = true;
                    continue;
                }
                runtime.resources.clear();
                runtime.path = note.path ?? runtime.path;
                runtime.displayName = note.title;
                runtime.content = note.content;
                runtime.meta = note.meta;
                runtime.diskRevision = result.revision;
                runtime.conflict = false;
                reloadedIds.push(runtime.id);
            } catch (error) {
                runtime.unavailable = true;
                warnings.value = [...warnings.value, String(error)];
            }
        }
        documents.value = [...documents.value];
        return reloadedIds;
    }

    async function refreshFolders() {
        if (!desktop || folders.value.length === 0) return;
        const refreshed: WorkspaceFolder[] = [];
        for (const current of folders.value) {
            try {
                const resolved = await resolve(current.path);
                if (!resolved.available) throw new Error("文件夹暂时不可用");
                const scan = await invoke<FolderScan>("scan_workspace_folder", {
                    path: resolved.path,
                });
                const folder: WorkspaceFolder = {
                    ...scan,
                    name: baseName(scan.path),
                    unavailable: false,
                    error: null,
                };
                folderIdentities.set(folder.path, resolved.identity);
                refreshed.push(folder);
            } catch (error) {
                refreshed.push({
                    ...current,
                    entries: [],
                    entryCount: 0,
                    truncated: false,
                    unavailable: true,
                    error: String(error),
                });
                warnings.value = [...warnings.value, String(error)];
            }
        }
        folders.value = refreshed;
    }

    async function dispose() {
        if (sessionWriteTimer) {
            clearTimeout(sessionWriteTimer);
            sessionWriteTimer = null;
        }
        const noError = Symbol("no-dispose-error");
        let firstError: unknown | typeof noError = noError;
        async function attempt(operation: () => Promise<void>) {
            try {
                await operation();
            } catch (error) {
                if (firstError === noError) firstError = error;
            }
        }

        for (const runtime of documents.value) {
            if (discardedForWindowClose.has(runtime.id)) continue;
            await attempt(() => runtime.draft.flush());
        }
        await attempt(persist);
        for (const runtime of documents.value) {
            await attempt(() => releaseDocument(runtime));
        }
        documents.value = [];
        activeDocumentId.value = null;
        folders.value = [];
        folderIdentities.clear();
        draftKeys.clear();
        discardedForWindowClose.clear();
        const sessionError = takeSessionWriteError();
        if (firstError === noError && sessionError !== noSessionWriteError) {
            firstError = sessionError;
        }
        if (firstError !== noError) throw firstError;
    }

    return {
        documents,
        activeDocumentId,
        activeDocument,
        folders,
        expandedPaths,
        collapsed,
        width,
        warnings,
        document,
        newDocument,
        openMdx,
        openMarkdown,
        openFolder,
        activate,
        updateContent,
        updateMetadata,
        save,
        saveAs,
        closeDocument,
        closeFolder,
        folderContainsDocument,
        prepareWindowClose,
        restore,
        persist,
        reloadFromDisk,
        refreshFolders,
        refreshDiskState,
        dispose,
    };
}
