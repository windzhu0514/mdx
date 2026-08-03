<script lang="ts">
function normalizePath(path: string) {
    return path.replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase();
}

function isPathInside(path: string, normalizedRoot: string) {
    const normalizedPath = normalizePath(path);
    return (
        normalizedPath === normalizedRoot ||
        normalizedPath.startsWith(`${normalizedRoot}\\`)
    );
}

export function owningRoot(path: string, roots: string[]) {
    const rootsByIdentity = new Map<string, string>();
    for (const root of roots) {
        const identity = normalizePath(root);
        if (!rootsByIdentity.has(identity)) rootsByIdentity.set(identity, root);
    }
    return [...rootsByIdentity]
        .filter(([identity]) => isPathInside(path, identity))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1] ?? null;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from "vue";

import type { OpenDocument } from "../composables/useDocumentSession";
import type { WorkspaceFolder, WorkspaceTreeEntry } from "../types/workspace";

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

type TreeRow = {
    key: string;
    label: string;
    path: string;
    depth: number;
    kind: "folder" | "directory" | "file";
    expanded: boolean | null;
    active: boolean;
    statuses: string[];
    documentId: string | null;
    folderPath: string | null;
};

const props = defineProps<{
    documents: OpenDocument[];
    folders: WorkspaceFolder[];
    activeDocumentId: string | null;
    expandedPaths: string[];
    collapsed: boolean;
    width: number;
}>();

const emit = defineEmits<{
    activate: [id: string];
    "open-path": [path: string];
    "open-folder": [];
    "close-folder": [path: string];
    "refresh-folder": [path: string];
    "toggle-expanded": [path: string];
    "update:collapsed": [collapsed: boolean];
    "update:width": [width: number];
}>();

const rovingKey = ref<string | null>(null);
const drag = ref<{ pointerId: number; startX: number; startWidth: number } | null>(null);
const treeItems = new Map<string, HTMLElement>();
const compact = ref(false);
const compactOpen = ref(false);
let compactMedia: MediaQueryList | null = null;

function clampWidth(value: number) {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

function documentStatuses(document: OpenDocument) {
    const statuses: string[] = [];
    if (document.dirty) statuses.push("未保存");
    if (document.conflict) statuses.push("外部更改");
    if (document.unavailable) statuses.push("不可用");
    return statuses;
}

function folderStatuses(folder: WorkspaceFolder) {
    const statuses: string[] = [];
    if (folder.truncated) statuses.push("扫描已截断");
    if (folder.unavailable) statuses.push("不可用");
    if (folder.error) statuses.push(folder.error);
    return statuses;
}

function isExpanded(path: string) {
    const target = normalizePath(path);
    return props.expandedPaths.some((item) => normalizePath(item) === target);
}

const visibleFolders = computed(() => {
    const foldersByIdentity = new Map<string, WorkspaceFolder>();
    for (const folder of props.folders) {
        const identity = normalizePath(folder.path);
        if (!foldersByIdentity.has(identity)) foldersByIdentity.set(identity, folder);
    }
    return [...foldersByIdentity.values()];
});

const roots = computed(() => visibleFolders.value.map((folder) => folder.path));

const documentsByPath = computed(() => {
    const result = new Map<string, OpenDocument>();
    for (const document of props.documents) {
        if (document.path) result.set(normalizePath(document.path), document);
    }
    return result;
});

function entryRows(entries: WorkspaceTreeEntry[], depth: number, root: string): TreeRow[] {
    const rows: TreeRow[] = [];
    for (const entry of entries) {
        const owner = owningRoot(entry.path, roots.value);
        if (!owner || normalizePath(owner) !== normalizePath(root)) continue;
        const document = documentsByPath.value.get(normalizePath(entry.path)) ?? null;
        const directory = entry.kind === "directory";
        const expanded = directory ? isExpanded(entry.path) : null;
        rows.push({
            key: `${directory ? "directory" : "file"}:${normalizePath(entry.path)}`,
            label: entry.name,
            path: entry.path,
            depth,
            kind: directory ? "directory" : "file",
            expanded,
            active: document?.id === props.activeDocumentId,
            statuses: document ? documentStatuses(document) : [],
            documentId: document?.id ?? null,
            folderPath: null,
        });
        if (directory && expanded) rows.push(...entryRows(entry.children, depth + 1, root));
    }
    return rows;
}

const folderRows = computed<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    for (const folder of visibleFolders.value) {
        const expanded = isExpanded(folder.path);
        rows.push({
            key: `folder:${normalizePath(folder.path)}`,
            label: folder.name,
            path: folder.path,
            depth: 1,
            kind: "folder",
            expanded,
            active: false,
            statuses: folderStatuses(folder),
            documentId: null,
            folderPath: folder.path,
        });
        if (expanded) rows.push(...entryRows(folder.entries, 2, folder.path));
    }
    return rows;
});

const rows = computed(() => folderRows.value);
const activeRovingKey = computed(
    () =>
        rows.value.some((row) => row.key === rovingKey.value)
            ? rovingKey.value
            : rows.value[0]?.key ?? null,
);
const currentActionRow = computed(
    () => rows.value.find((row) => row.key === activeRovingKey.value) ?? null,
);

function rowTabindex(row: TreeRow) {
    return row.key === activeRovingKey.value ? 0 : -1;
}

function activateRow(row: TreeRow) {
    if (row.documentId) {
        emit("activate", row.documentId);
        return;
    }
    if (row.kind === "folder" || row.kind === "directory") {
        emit("toggle-expanded", row.path);
        return;
    }
    emit("open-path", row.path);
}

function selectRow(row: TreeRow) {
    rovingKey.value = row.key;
    activateRow(row);
}

function focusRow(index: number) {
    const row = rows.value[index];
    if (!row) return;
    rovingKey.value = row.key;
    treeItems.get(row.key)?.focus();
}

function setTreeItem(key: string, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement) {
        treeItems.set(key, element);
    } else {
        treeItems.delete(key);
    }
}

function rowIndex(event: KeyboardEvent) {
    const source = event.target;
    const tree = event.currentTarget;
    if (!(source instanceof Element) || !(tree instanceof HTMLElement)) return -1;
    if (source === tree) {
        return rows.value.findIndex((row) => row.key === activeRovingKey.value);
    }
    const item = source.closest<HTMLElement>("[role=treeitem]");
    if (!item || !tree.contains(item)) return -1;
    return rows.value.findIndex((row) => row.key === item.dataset.treeKey);
}

function onTreeKeydown(event: KeyboardEvent) {
    const index = rowIndex(event);
    const row = rows.value[index];
    if (!row) return;

    if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRow(Math.min(index + 1, rows.value.length - 1));
    } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRow(Math.max(index - 1, 0));
    } else if (event.key === "ArrowRight" && row.expanded !== null) {
        event.preventDefault();
        if (!row.expanded) {
            emit("toggle-expanded", row.path);
        } else {
            const child = rows.value[index + 1];
            if (child?.depth === row.depth + 1) focusRow(index + 1);
        }
    } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (row.expanded) {
            emit("toggle-expanded", row.path);
        } else if (row.depth === 1) {
            return;
        } else {
            for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
                if (rows.value[parentIndex].depth < row.depth) {
                    focusRow(parentIndex);
                    break;
                }
            }
        }
    } else if (event.key === "Home") {
        event.preventDefault();
        focusRow(0);
    } else if (event.key === "End") {
        event.preventDefault();
        focusRow(rows.value.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateRow(row);
    }
}

function syncCompact(event: MediaQueryListEvent | MediaQueryList) {
    compact.value = event.matches;
    if (!event.matches) compactOpen.value = false;
}

onMounted(() => {
    if (typeof window.matchMedia !== "function") return;
    compactMedia = window.matchMedia("(max-width: 980px)");
    syncCompact(compactMedia);
    compactMedia.addEventListener("change", syncCompact);
});

onBeforeUnmount(() => {
    compactMedia?.removeEventListener("change", syncCompact);
});

const sidebarVisible = computed(
    () => !props.collapsed && (!compact.value || compactOpen.value),
);
const toggleVisible = computed(() => props.collapsed || compact.value);

function collapseSidebar() {
    if (compact.value) {
        compactOpen.value = false;
    } else {
        emit("update:collapsed", true);
    }
}

function expandSidebar() {
    if (compact.value) compactOpen.value = true;
    if (props.collapsed) emit("update:collapsed", false);
}

function onPointerDown(event: PointerEvent) {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    drag.value = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: clampWidth(props.width),
    };
    handle.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
    const current = drag.value;
    if (!current || current.pointerId !== event.pointerId) return;
    emit("update:width", clampWidth(current.startWidth + event.clientX - current.startX));
}

function onPointerUp(event: PointerEvent) {
    const current = drag.value;
    if (!current || current.pointerId !== event.pointerId) return;
    const handle = event.currentTarget;
    if (handle instanceof HTMLElement && handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
    }
    drag.value = null;
}
</script>

<template>
    <aside
        v-if="sidebarVisible"
        class="workspace-sidebar"
        :class="{ 'is-compact': compact }"
        :style="{ width: `${clampWidth(props.width)}px` }"
        aria-label="工作区侧栏"
    >
        <header class="workspace-sidebar-header">
            <span>工作区</span>
            <button
                type="button"
                class="icon-button small"
                aria-label="收起工作区侧栏"
                title="收起工作区侧栏"
                @click="collapseSidebar"
            >
                ‹
            </button>
        </header>
        <div v-if="!folderRows.length" class="workspace-empty">
            <p>尚未打开文件夹</p>
            <button type="button" aria-label="打开文件夹" @click="emit('open-folder')">
                打开文件夹
            </button>
        </div>
        <div v-else class="workspace-tree" role="tree" aria-label="工作区文件" @keydown="onTreeKeydown">
            <div v-for="row in folderRows" :key="row.key" class="workspace-tree-row" role="none">
                <div
                    :ref="(element) => setTreeItem(row.key, element)"
                    class="workspace-tree-item"
                    :class="{ active: row.active }"
                    role="treeitem"
                    :data-tree-key="row.key"
                    :aria-level="row.depth"
                    :aria-expanded="row.expanded === null ? undefined : row.expanded"
                    :aria-current="row.active ? 'page' : undefined"
                    :tabindex="rowTabindex(row)"
                    :style="{ paddingInlineStart: `${8 + (row.depth - 1) * 14}px` }"
                    @click="selectRow(row)"
                    @focus="rovingKey = row.key"
                >
                    <span v-if="row.expanded !== null" class="workspace-disclosure">
                        {{ row.expanded ? '⌄' : '›' }}
                    </span>
                    <span class="workspace-name">{{ row.label }}</span>
                    <span v-for="status in row.statuses" :key="status" class="workspace-status">
                        {{ status }}
                    </span>
                </div>
            </div>
        </div>
        <div
            v-if="currentActionRow?.kind === 'folder'"
            class="workspace-action-toolbar"
            role="group"
            :aria-label="`${currentActionRow?.label ?? '当前项'} 操作`"
        >
            <span class="workspace-action-label">{{ currentActionRow?.label }}</span>
            <template v-if="currentActionRow?.kind === 'folder'">
                <button
                    type="button"
                    class="workspace-row-action"
                    :aria-label="`刷新 ${currentActionRow.label}`"
                    title="刷新文件夹"
                    @click="currentActionRow.folderPath && emit('refresh-folder', currentActionRow.folderPath)"
                >
                    ↻
                </button>
                <button
                    type="button"
                    class="workspace-row-action"
                    :aria-label="`关闭文件夹 ${currentActionRow.label}`"
                    title="关闭文件夹"
                    @click="currentActionRow.folderPath && emit('close-folder', currentActionRow.folderPath)"
                >
                    ×
                </button>
            </template>
        </div>
        <div
            class="workspace-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整工作区侧栏宽度"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
        />
    </aside>

    <button
        type="button"
        class="workspace-sidebar-toggle"
        :class="{ 'is-visible': toggleVisible }"
        :aria-label="sidebarVisible ? '收起工作区侧栏' : '展开工作区侧栏'"
        :aria-expanded="sidebarVisible"
        :title="sidebarVisible ? '收起工作区侧栏' : '展开工作区侧栏'"
        @click="sidebarVisible ? collapseSidebar() : expandSidebar()"
    >
        {{ sidebarVisible ? '‹' : '›' }}
    </button>
</template>
