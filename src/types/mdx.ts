export type ResourceKind = "asset" | "attachment";

export type ResourceMeta = {
    id: string;
    originalName: string;
    storedName: string;
    path: string;
    type: string;
    size: number;
    width?: number;
    height?: number;
    createdAt: string;
};

export type MdxManifest = {
    format: string;
    formatVersion: string;
    packageType: string;
    contentFile: string;
    metadataFile: string;
    assetsDir: string;
    attachmentsDir: string;
    thumbnailsDir: string;
    encoding: string;
    encrypted: boolean;
    compression: string;
};

export type MdxMetadata = {
    id: string;
    title: string;
    summary: string;
    author: string;
    createdAt: string;
    updatedAt: string;
    tags: string[];
    category: string;
    favorite: boolean;
    archived: boolean;
    cover: string;
    wordCount: number;
    assets: ResourceMeta[];
    attachments: ResourceMeta[];
};

export type MdxNote = {
    path: string | null;
    title: string;
    content: string;
    manifest: MdxManifest;
    meta: MdxMetadata;
};

export type FrontMatterData = {
    title: string;
    date: string;
    tags: string[];
    categories: string[];
    draft: boolean;
    author: string;
    summary: string;
    extra: Record<string, unknown>;
};

export type ImportedMarkdown = {
    title: string;
    content: string;
    frontMatter: FrontMatterData | null;
};

export type PendingResource = {
    path: string;
    originalName: string;
    mimeType: string;
    size: number;
    base64: string;
    objectUrl: string;
    kind: ResourceKind;
    isNew: boolean;
};

export type ResourceSaveData = {
    name: string;
    originalName: string;
    mimeType: string;
    size: number;
    kind: ResourceKind;
    base64: string;
};

export type AttachmentReadRequest = {
    documentId: string;
    sourcePath: string | null;
    resourcePath: string;
    originalName: string;
    base64: string | null;
};

export type MdxSaveRequest = {
    path: string | null;
    title: string;
    content: string;
    meta: MdxMetadata | null;
    newResources: ResourceSaveData[];
    removedResources: string[];
};
