const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 30;

export function normalizeTags(tags: readonly string[]) {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const rawTag of tags) {
        const tag = rawTag.trim().slice(0, MAX_TAG_LENGTH);
        const key = tag.toLocaleLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        result.push(tag);
        if (result.length === MAX_TAGS) break;
    }
    return result;
}
