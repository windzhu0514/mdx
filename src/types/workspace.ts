export type PathIdentity = {
    path: string;
    identity: string;
    available: boolean;
};

export type RecentFileEntry = {
    path: string;
    title: string;
    lastOpenedAt: string;
    available: boolean;
};

export type DiskRevision = {
    path: string;
    modifiedAtMs: number;
    size: number;
};

export type DiskRevisionResult = {
    path: string;
    available: boolean;
    revision: DiskRevision | null;
    error: string | null;
};

export type WorkspaceTreeEntry = {
    path: string;
    name: string;
    kind: "directory" | "md" | "mdx";
    children: WorkspaceTreeEntry[];
};

export type FolderScan = {
    path: string;
    entries: WorkspaceTreeEntry[];
    entryCount: number;
    truncated: boolean;
};

export type WorkspaceFolder = FolderScan & {
    name: string;
    unavailable: boolean;
    error: string | null;
};

export type WorkspaceSessionDocument = {
    id: string;
    path: string | null;
    sourceKind: "mdx" | "markdown-import" | "untitled";
    importSourcePath: string | null;
    draftKey: string;
};

export type WorkspaceSessionSnapshot = {
    version: 1;
    documents: WorkspaceSessionDocument[];
    folderPaths: string[];
    expandedPaths: string[];
    activeDocumentId: string | null;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
};

export type WorkspaceSessionRead = {
    session: WorkspaceSessionSnapshot | null;
    warning: string | null;
};

export type ResourceSaveData = {
    name: string;
    originalName: string;
    mimeType: string;
    size: number;
    kind: "asset" | "attachment";
    base64: string;
};

export type MarkdownResourceItem = {
    originalReference: string;
    resolvedPath: string | null;
    status: "ready" | "missing" | "unreadable" | "oversized";
    targetPath: string | null;
    message: string | null;
};

export type MarkdownResourcePlan = {
    rewrittenContent: string;
    resources: ResourceSaveData[];
    items: MarkdownResourceItem[];
};
