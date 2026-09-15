// Preserve the exact BOM and complete YAML prefix outside Markdown consumers.
export function splitMarkdownPrefix(markdown: string): { prefix: string; body: string } {
    const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
    const withoutBom = markdown.slice(bom.length);
    const frontmatter =
        withoutBom.match(
            /^---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
        )?.[0] ?? "";
    return {
        prefix: bom + frontmatter,
        body: withoutBom.slice(frontmatter.length),
    };
}
