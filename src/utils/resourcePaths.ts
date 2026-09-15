import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { splitMarkdownPrefix } from "./markdownFrontMatter";

const resourceParser = markdown({ base: markdownLanguage }).language.parser;

interface ResourceDestination {
    from: number;
    to: number;
    value: string;
}

function resourceDestinations(source: string) {
    const { prefix, body } = splitMarkdownPrefix(source);
    // The parser expects LF; only the analysis copy changes its line endings.
    const removedCarriageReturns: number[] = [];
    const parseSource = body.replace(/\r\n/gu, (_newline, offset: number) => {
        removedCarriageReturns.push(offset - removedCarriageReturns.length);
        return "\n";
    });
    const canonicalOffset = (offset: number) => {
        let low = 0;
        let high = removedCarriageReturns.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (removedCarriageReturns[middle] < offset) low = middle + 1;
            else high = middle;
        }
        return prefix.length + offset + low;
    };
    const destinations: ResourceDestination[] = [];
    const add = (from: number, to: number) => {
        destinations.push({
            from: canonicalOffset(from),
            to: canonicalOffset(to),
            value: source.slice(canonicalOffset(from), canonicalOffset(to)),
        });
    };

    resourceParser.parse(parseSource).iterate({
        enter(node) {
            if (node.name === "URL") {
                const wrapped = parseSource[node.from] === "<";
                add(node.from + Number(wrapped), node.to - Number(wrapped));
            } else if (node.name === "HTMLTag" || node.name === "HTMLBlock") {
                // HTML is a mounted language tree; enter it through Lezer's public API.
                node.node
                    .enter(node.from, 1)
                    ?.cursor()
                    .iterate((htmlNode) => {
                        if (htmlNode.name !== "Attribute") return;
                        const name = htmlNode.node.getChild("AttributeName");
                        const value =
                            htmlNode.node.getChild("AttributeValue") ??
                            htmlNode.node.getChild("UnquotedAttributeValue");
                        if (!name || !value) return;
                        const attribute = parseSource
                            .slice(name.from, name.to)
                            .toLowerCase();
                        if (attribute !== "src" && attribute !== "href") return;
                        const quoted = value.name === "AttributeValue";
                        add(value.from + Number(quoted), value.to - Number(quoted));
                    });
                return false;
            }
        },
    });

    return destinations;
}

export function referencedResourcePaths(markdown: string) {
    const paths = new Set<string>();
    for (const { value } of resourceDestinations(markdown)) {
        if (/^(?:assets|attachments)\/[^/\\]+$/u.test(value)) {
            paths.add(value);
        }
    }
    return paths;
}

function replaceResourceReferences(
    markdown: string,
    replacements: ReadonlyMap<string, string>,
) {
    if (replacements.size === 0) return markdown;
    const chunks: string[] = [];
    let offset = 0;
    for (const { from, to, value } of resourceDestinations(markdown)) {
        const replacement = replacements.get(value);
        if (replacement === undefined) continue;
        chunks.push(markdown.slice(offset, from), replacement);
        offset = to;
    }
    chunks.push(markdown.slice(offset));
    return chunks.join("");
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

export function referencedLocalResourcePaths(markdown: string) {
    return new Set(
        resourceDestinations(markdown)
            .map(({ value }) => value)
            .filter(
                (value) =>
                    value.length > 0 &&
                    !value.startsWith("#") &&
                    (!/^[a-z][a-z\d+.-]*:/iu.test(value) ||
                        /^file:/iu.test(value) ||
                        /^[a-z]:[\\/]/iu.test(value)) &&
                    !value.startsWith("//"),
            ),
    );
}

export function rebaseMarkdownReferences(
    markdown: string,
    sourcePath: string,
    excludedPaths: ReadonlySet<string> = new Set(),
) {
    const normalized = sourcePath
        .replace(/\\/gu, "/")
        .replace(/^\/\/\?\/UNC\//iu, "//")
        .replace(/^\/\/\?\/(?=[a-z]:\/)/iu, "");
    const encodedPath = normalized
        .split("/")
        .map((part, index) =>
            index === 0 && /^[a-z]:$/iu.test(part) ? part : encodeURIComponent(part),
        )
        .join("/");
    const base = normalized.startsWith("//")
        ? "file:" + encodedPath
        : "file://" + (normalized.startsWith("/") ? "" : "/") + encodedPath;
    const replacements = new Map<string, string>();
    for (const value of referencedLocalResourcePaths(markdown)) {
        if (
            excludedPaths.has(value) ||
            /^[a-z][a-z\d+.-]*:/iu.test(value) ||
            /^[\\/]/u.test(value)
        )
            continue;
        replacements.set(value, new URL(value.replace(/\\/gu, "/"), base).href);
    }
    return replaceResourceReferences(markdown, replacements);
}
