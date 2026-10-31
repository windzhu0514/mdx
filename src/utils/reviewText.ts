export function textMatches(text: string, query: string) {
    const matches: {
        from: number;
        to: number;
        before: string;
        match: string;
        after: string;
    }[] = [];
    if (!query.trim()) return matches;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
        const from = match.index;
        const to = from + match[0].length;
        matches.push({
            from,
            to,
            before: text.slice(Math.max(0, from - 60), from),
            match: match[0],
            after: text.slice(to, to + 90),
        });
    }
    return matches;
}

// 线性前后缀比较；中间区块整体展示，避免大文档的二次方差异矩阵。
export function lineDifference(before: string, after: string) {
    const a = before.split("\n"),
        b = after.split("\n");
    let start = 0,
        end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (
        end < a.length - start &&
        end < b.length - start &&
        a[a.length - 1 - end] === b[b.length - 1 - end]
    )
        end++;
    return [
        ...a.slice(0, start).map((text) => ({ kind: "same", text })),
        ...a.slice(start, a.length - end).map((text) => ({ kind: "removed", text })),
        ...b.slice(start, b.length - end).map((text) => ({ kind: "added", text })),
        ...a.slice(a.length - end).map((text) => ({ kind: "same", text })),
    ];
}
type SearchSyntaxNode = {
    type: string;
    value?: string;
    children?: SearchSyntaxNode[];
    position?: { start: { offset?: number }; end: { offset?: number } };
};
// 通过公开语法树排除链接目标和标记；不将源码偏移用作 ProseMirror 位置。
export function visibleSearchOccurrence(
    source: string,
    query: string,
    occurrence: number,
    tree: SearchSyntaxNode,
): number | null {
    const selected = textMatches(source, query)[occurrence];
    if (!selected) return null;
    let total = 0;
    let result: number | null = null;
    function visit(node: SearchSyntaxNode) {
        if (["paragraph", "heading", "code", "tableCell"].includes(node.type)) {
            let plain = "";
            let selectedVisible: number | null = null;
            function collect(leaf: SearchSyntaxNode) {
                if (
                    ["text", "inlineCode", "code"].includes(leaf.type) &&
                    leaf.value !== undefined
                ) {
                    const value = leaf.value;
                    const start = leaf.position?.start.offset;
                    const end = leaf.position?.end.offset;
                    if (start !== undefined && end !== undefined) {
                        const fenced =
                            leaf.type === "code" &&
                            /^ {0,3}(?:`{3,}|~{3,})/u.test(source.slice(start, end));
                        const valueStart = source.indexOf(
                            value,
                            fenced ? source.indexOf("\n", start) + 1 : start,
                        );
                        if (
                            valueStart >= start &&
                            valueStart + value.length <= end &&
                            selected.from >= valueStart &&
                            selected.to <= valueStart + value.length
                        )
                            selectedVisible = plain.length + selected.from - valueStart;
                    }
                    plain += value;
                } else if (leaf.type === "break" || leaf.type === "image") plain += "\n";
                else for (const child of leaf.children ?? []) collect(child);
            }
            collect(node);
            const matches = textMatches(plain, query);
            const index = matches.findIndex((hit) => hit.from === selectedVisible);
            if (index >= 0) result = total + index;
            total += matches.length;
            return;
        }
        for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
    return result;
}
