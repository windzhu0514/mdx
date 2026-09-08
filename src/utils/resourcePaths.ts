import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

const resourceParser = markdown({ base: markdownLanguage }).language.parser;

interface ResourceDestination {
    from: number;
    to: number;
    value: string;
}

function resourceDestinations(source: string) {
    const destinations: ResourceDestination[] = [];
    const add = (from: number, to: number) => {
        destinations.push({ from, to, value: source.slice(from, to) });
    };

    resourceParser.parse(source).iterate({
        enter(node) {
            if (node.name === "URL") {
                const wrapped = source[node.from] === "<";
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
                        const attribute = source.slice(name.from, name.to).toLowerCase();
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
