export function countNonWhitespaceCharacters(value: string) {
    let count = 0;

    for (const character of value) {
        if (!/\s/u.test(character)) count += 1;
    }

    return count;
}

export function normalizeMarkdownHeadingText(value: string): string {
    return value
        .trim()
        .replace(/\s+#+\s*$/u, "")
        .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
        .replace(/`([^`]+)`/gu, "$1")
        .replace(/~~(.*?)~~/gu, "$1")
        .replace(/(\*\*|__)(.*?)\1/gu, "$2")
        .replace(/(\*|_)(.*?)\1/gu, "$2")
        .trim();
}

export type MarkdownHeading = {
    level: number;
    text: string;
    id: number;
};

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = [];
    let fence: { character: "`" | "~"; length: number } | undefined;
    let offset = 0;

    for (const rawLine of markdown.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);

        if (fence) {
            const closingFence = new RegExp(
                `^[ \\t]{0,3}${fence.character}{${fence.length},}[ \\t]*$`,
            );
            if (closingFence.test(line)) fence = undefined;
            offset += rawLine.length + 1;
            continue;
        }

        if (fenceMatch) {
            fence = {
                character: fenceMatch[1][0] as "`" | "~",
                length: fenceMatch[1].length,
            };
            offset += rawLine.length + 1;
            continue;
        }

        const headingMatch = /^(#{1,6})[ \t]+(.+)$/.exec(line);
        if (headingMatch) {
            const text = normalizeMarkdownHeadingText(headingMatch[2]);
            if (text) {
                headings.push({
                    level: headingMatch[1].length,
                    text,
                    id: offset,
                });
            }
        }
        offset += rawLine.length + 1;
    }

    return headings;
}
