import type { MdxMetadata } from "./mdx";

export type HistoryListItem = {
    name: string;
    title: string;
    createdAt: string;
};

export type HistorySnapshot = {
    title: string;
    content: string;
    meta: MdxMetadata;
    createdAt: string;
};
