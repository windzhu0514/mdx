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
