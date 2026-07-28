import type { EditorCommand } from "./editorTypes";

export type SourceChange = {
    from: number;
    to: number;
    insert: string;
    anchor: number;
};

const inlineMarkers = {
    bold: "**",
    italic: "*",
    strike: "~~",
    code: "`",
} as const;

function createChange(from: number, to: number, insert: string): SourceChange {
    return { from, to, insert, anchor: from + insert.length };
}

function transformLines(
    selection: string,
    transform: (line: string, index: number) => string,
): string {
    return selection
        .split("\n")
        .map((line, index) => transform(line, index))
        .join("\n");
}

function transformSelectedLines(
    document: string,
    from: number,
    to: number,
    transform: (line: string, index: number) => string,
): SourceChange {
    const lineFrom = document.lastIndexOf("\n", from - 1) + 1;
    const endPosition = to === from ? to : to - 1;
    const nextLineBreak = document.indexOf("\n", endPosition);
    const lineTo = nextLineBreak === -1 ? document.length : nextLineBreak;
    return createChange(
        lineFrom,
        lineTo,
        transformLines(document.slice(lineFrom, lineTo), transform),
    );
}

export function transformSourceSelection(
    document: string,
    from: number,
    to: number,
    command: EditorCommand,
): SourceChange | null {
    const selection = document.slice(from, to);

    if (command.name in inlineMarkers) {
        const marker = inlineMarkers[command.name as keyof typeof inlineMarkers];
        return createChange(from, to, `${marker}${selection}${marker}`);
    }

    switch (command.name) {
        case "heading": {
            return transformSelectedLines(document, from, to, (line) => {
                const content = line.replace(/^#{1,6}\s?/, "");
                return command.level === 0
                    ? content
                    : `${"#".repeat(command.level)} ${content}`;
            });
        }
        case "blockQuote":
            return transformSelectedLines(document, from, to, (line) => `> ${line}`);
        case "bulletList":
            return transformSelectedLines(document, from, to, (line) => `- ${line}`);
        case "orderedList":
            return transformSelectedLines(
                document,
                from,
                to,
                (line, index) => `${index + 1}. ${line}`,
            );
        case "taskList":
            return transformSelectedLines(document, from, to, (line) => `- [ ] ${line}`);
        case "indent":
            return transformSelectedLines(document, from, to, (line) => `    ${line}`);
        case "outdent":
            return transformSelectedLines(document, from, to, (line) =>
                line.replace(/^( {1,4}|\t)/, ""),
            );
        case "hr":
            return createChange(from, from, "\n---\n");
        case "codeBlock":
            return createChange(from, to, `\`\`\`\n${selection}\n\`\`\``);
        case "undo":
        case "redo":
        case "selectAll":
            return null;
        default:
            return null;
    }
}
