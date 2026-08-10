import type { PendingResource, ResourceSaveData } from "../types/mdx";
import { toDisplayMarkdown, toPersistedMarkdown } from "../utils/resourcePaths";
import { base64ToBlob } from "../utils/base64";
import { ref } from "vue";

export type ResourceSession = ReturnType<typeof createResourceSession>;
export type ResourceSessionSnapshot = {
    newResources: ResourceSaveData[];
};
export type ResourceExportSnapshot = {
    revision: number;
    resources: ResourceSaveData[];
};

export function createResourceSession() {
    const resources = new Map<string, PendingResource>();
    const revision = ref(0);

    function register(resource: PendingResource) {
        const previous = resources.get(resource.path);
        if (previous && previous.objectUrl !== resource.objectUrl) {
            URL.revokeObjectURL(previous.objectUrl);
        }
        resources.set(resource.path, { ...resource });
        revision.value += 1;
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
        void revision.value;
        return toDisplayMarkdown(markdown, objectUrls());
    }

    function persistedMarkdown(markdown: string) {
        return toPersistedMarkdown(markdown, objectUrls());
    }

    function newResources(): ResourceSaveData[] {
        return Array.from(resources.values())
            .filter((resource) => resource.isNew)
            .map(toResourceSaveData);
    }

    function exportResources(): ResourceSaveData[] {
        return Array.from(resources.values(), toResourceSaveData);
    }

    function exportSnapshot(): ResourceExportSnapshot {
        return { revision: revision.value, resources: exportResources() };
    }

    function resourceRevision(): number {
        return revision.value;
    }

    function markSaved() {
        for (const resource of resources.values()) {
            resource.isNew = false;
        }
    }

    function snapshot(): ResourceSessionSnapshot {
        return { newResources: newResources() };
    }

    function restore(state: ResourceSessionSnapshot) {
        for (const resource of state.newResources) {
            registerNew({
                path: resource.name,
                originalName: resource.originalName,
                mimeType: resource.mimeType,
                size: resource.size,
                base64: resource.base64,
                objectUrl: URL.createObjectURL(
                    base64ToBlob(resource.base64, resource.mimeType),
                ),
                kind: resource.kind,
                isNew: true,
            });
        }
    }

    function clear() {
        for (const resource of resources.values()) {
            URL.revokeObjectURL(resource.objectUrl);
        }
        resources.clear();
        revision.value += 1;
    }

    return {
        registerLoaded,
        registerNew,
        objectUrls,
        displayMarkdown,
        persistedMarkdown,
        newResources,
        exportResources,
        exportSnapshot,
        resourceRevision,
        markSaved,
        snapshot,
        restore,
        clear,
    };
}

function toResourceSaveData(resource: PendingResource): ResourceSaveData {
    return {
        name: resource.path,
        originalName: resource.originalName,
        mimeType: resource.mimeType,
        size: resource.size,
        kind: resource.kind,
        base64: resource.base64,
    };
}
