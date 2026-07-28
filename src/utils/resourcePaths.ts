function replaceMarkdownDestinations(
    markdown: string,
    replacements: ReadonlyMap<string, string>,
) {
    return markdown.replace(
        /(!?\[[^\]]*\]\()([^\s)]+)(\))/g,
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
        /\b(src|href)=(['"])([^'"]+)\2/g,
        (match, attribute: string, quote: string, value: string) => {
            const replacement = replacements.get(value);
            return replacement ? `${attribute}=${quote}${replacement}${quote}` : match;
        },
    );
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
