export type NoteListItem = {
    path: string;
    title: string;
    tags: string[];
    summary: string;
    updatedAt: string;
    content: string;
};

export type NoteSearchResult = Omit<NoteListItem, "content"> & {
    snippet: string;
    score: number;
};
