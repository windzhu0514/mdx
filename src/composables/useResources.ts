import type { PendingResource, ResourceSaveData } from "../types/mdx";
import { toDisplayMarkdown, toPersistedMarkdown } from "../utils/resourcePaths";

export type ResourceSession = ReturnType<typeof createResourceSession>;

export function createResourceSession() {
    const resources = new Map<string, PendingResource>();

    function register(resource: PendingResource) {
        const previous = resources.get(resource.path);
        if (previous && previous.objectUrl !== resource.objectUrl) {
            URL.revokeObjectURL(previous.objectUrl);
        }
        resources.set(resource.path, { ...resource });
    }

    function registerLoaded(resource: PendingResource) {
        register({ ...resource, isNew: false });
    }

    function registerNew(resource: PendingResource) {
        register({ ...resource, isNew: true });
    }

    function objectUrls() {
        return new Map(
            Array.from(resources, ([path, resource]) => [path, resource.objectUrl]),
        );
    }

    function displayMarkdown(markdown: string) {
        return toDisplayMarkdown(markdown, objectUrls());
    }

    function persistedMarkdown(markdown: string) {
        return toPersistedMarkdown(markdown, objectUrls());
    }

    function newResources(): ResourceSaveData[] {
        return Array.from(resources.values())
            .filter((resource) => resource.isNew)
            .map((resource) => ({
                name: resource.path,
                originalName: resource.originalName,
                mimeType: resource.mimeType,
                size: resource.size,
                kind: resource.kind,
                base64: resource.base64,
            }));
    }

    function markSaved() {
        for (const resource of resources.values()) {
            resource.isNew = false;
        }
    }

    function clear() {
        for (const resource of resources.values()) {
            URL.revokeObjectURL(resource.objectUrl);
        }
        resources.clear();
    }

    return {
        registerLoaded,
        registerNew,
        objectUrls,
        displayMarkdown,
        persistedMarkdown,
        newResources,
        markSaved,
        clear,
    };
}
