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
