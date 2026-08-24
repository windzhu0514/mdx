const MARKDOWN_DESTINATION_SOURCE = String.raw`(!?\[[^\]]*\]\()([^\s)]+)(\))`;
const HTML_ATTRIBUTE_SOURCE = String.raw`\b(src|href)=(['"])([^'"]+)\2`;

function markdownDestinationPattern() {
    return new RegExp(MARKDOWN_DESTINATION_SOURCE, "gu");
}

function htmlAttributePattern() {
    return new RegExp(HTML_ATTRIBUTE_SOURCE, "gu");
}

function* resourceDestinations(markdown: string) {
    for (const match of markdown.matchAll(markdownDestinationPattern())) {
        const destination = match[2];
        if (destination) yield destination;
    }
    for (const match of markdown.matchAll(htmlAttributePattern())) {
        const destination = match[3];
        if (destination) yield destination;
    }
}

function replaceMarkdownDestinations(
    markdown: string,
    replacements: ReadonlyMap<string, string>,
) {
    return markdown.replace(
        markdownDestinationPattern(),
        (match, prefix: string, destination: string, suffix: string) => {
            const replacement = replacements.get(destination);
            return replacement ? `${prefix}${replacement}${suffix}` : match;
        },
    );
}

function replaceHtmlAttributes(
    markdown: string,
    replacements: ReadonlyMap<string, string>,
) {
    return markdown.replace(
        htmlAttributePattern(),
        (match, attribute: string, quote: string, value: string) => {
            const replacement = replacements.get(value);
            return replacement ? `${attribute}=${quote}${replacement}${quote}` : match;
        },
    );
}

export function referencedResourcePaths(markdown: string) {
    const paths = new Set<string>();
    for (const destination of resourceDestinations(markdown)) {
        if (/^(?:assets|attachments)\/[^/\\]+$/u.test(destination)) {
            paths.add(destination);
        }
    }
    return paths;
}

function replaceResourceReferences(
    markdown: string,
    replacements: ReadonlyMap<string, string>,
) {
    return replaceHtmlAttributes(
        replaceMarkdownDestinations(markdown, replacements),
        replacements,
    );
}

export function toDisplayMarkdown(
    markdown: string,
    objectUrls: ReadonlyMap<string, string>,
) {
    return replaceResourceReferences(markdown, objectUrls);
}

export function toPersistedMarkdown(
    markdown: string,
    objectUrls: ReadonlyMap<string, string>,
) {
    const packagePaths = new Map<string, string>();
    for (const [packagePath, objectUrl] of objectUrls) {
        packagePaths.set(objectUrl, packagePath);
    }
    return replaceResourceReferences(markdown, packagePaths);
}
