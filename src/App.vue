<script setup lang="ts">
import { listen } from "@tauri-apps/api/event";
import { consumeOpenRequests } from "./utils/openRequests";
import { useAutoSave, type AutoSaveDocument } from "./composables/useAutoSave";
import { appName, t } from "./i18n";

import {
    computed,
    customRef,
    nextTick,
    onBeforeUnmount,
    onMounted,
    reactive,
    ref,
    watch,
} from "vue";
import { setTheme } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import "./experience.css";
import "./highPriority.css";
import AttachmentPanel from "./components/AttachmentPanel.vue";
import CommandPalette, {
    type CommandPaletteCommand,
} from "./components/CommandPalette.vue";
import FindReplacePanel from "./components/FindReplacePanel.vue";
import ExternalConflictDialog from "./components/ExternalConflictDialog.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import LeaveConfirmDialog from "./components/LeaveConfirmDialog.vue";
import LibraryPanel from "./components/LibraryPanel.vue";
import MarkdownResourcesDialog from "./components/MarkdownResourcesDialog.vue";
import RecentFilesDialog from "./components/RecentFilesDialog.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import TableOfContents from "./components/TableOfContents.vue";
import ThemePicker from "./components/ThemePicker.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import WindowControls from "./components/WindowControls.vue";
import WorkspaceOperations from "./components/WorkspaceOperations.vue";
import WorkspaceSidebar from "./components/WorkspaceSidebar.vue";
import MoraEditor from "./components/editor/MoraEditor.vue";
import MermaidViewer from "./components/editor/MermaidViewer.vue";
import { svgToPngBase64 } from "./components/editor/mermaidExport";
import {
    prepareDocumentExportRequest,
    type DocumentExportFormat,
} from "./documentExport";
import type {
    MermaidDiagramSnapshot,
    MermaidViewerRequest,
} from "./components/editor/mermaidPreview";
import { createOpenAICompatibleProvider } from "./ai/openAICompatible";
import type {
    EditorCommand,
    EditorMode,
    MoraEditorHandle,
} from "./components/editor/editorTypes";
import {
    useDocumentSession,
    type OpenDocument,
    type SessionDocument,
} from "./composables/useDocumentSession";
import { useAppUpdater } from "./composables/useAppUpdater";
import { useAgentBridge } from "./composables/useAgentBridge";
import { useExternalFileSync } from "./composables/useExternalFileSync";
import { isDarkTheme, usePreferences, type ThemeId } from "./composables/usePreferences";
import type { HistoryListItem, HistorySnapshot } from "./types/history";
import type { NoteListItem, NoteSearchResult } from "./types/library";
import type {
    AttachmentListItem,
    AttachmentReadRequest,
    ResourceMeta,
    ResourceSaveData,
    DocumentFormat,
    MarkdownSaveResult,
} from "./types/mdx";
import type {
    MarkdownResourcePlan,
    RecentFileEntry,
    WorkspaceIndexRefresh,
} from "./types/workspace";
import type { LeaveDecision } from "./utils/leaveGuard";
import { base64ToBlob } from "./utils/base64";
import { createEmptyMetadata } from "./utils/note";
import {
    referencedResourcePaths,
    referencedLocalResourcePaths,
    rebaseMarkdownReferences,
} from "./utils/resourcePaths";
import { isTextInputTarget } from "./utils/shortcuts";
import {
    countNonWhitespaceCharacters,
    documentNameFromPath,
    extractMarkdownHeadings,
    UNNAMED_DOCUMENT_NAME,
} from "./utils/text";

type MarkdownCommand = {
    id: string;
    label: string;
    action: () => void | Promise<void>;
    disabled?: boolean;
    shortcut?: string;
};

type WorkspaceSidebarHandle = {
    focusDocument: (id: string) => Promise<void>;
    focusFirstAvailable: () => Promise<void>;
};

const APP_NAME = appName;
const APP_TAGLINE = computed(() =>
    t("所思所想，落笔成笺。", "Turn your thoughts into notes."),
);
const tauriRuntime = isTauri();
const updatesEnabled =
    tauriRuntime && (import.meta.env.PROD || import.meta.env.MODE === "test");
const appUpdater = useAppUpdater(updatesEnabled);
const session = useDocumentSession(tauriRuntime);
const documents = session.documents;
const folders = session.folders;
const activeDocument = session.activeDocument;
const activeDocumentId = session.activeDocumentId;
const expandedPaths = session.expandedPaths;
const sidebarCollapsed = session.collapsed;
const sidebarWidth = session.width;

const currentPath = computed(() => {
    void documents.value;
    return activeDocument.value?.path ?? null;
});
function documentFormat(document: OpenDocument): DocumentFormat {
    return document.sourceKind === "markdown" || document.sourceKind === "markdown-import"
        ? "markdown"
        : "mdx";
}
const activeDocumentFormat = computed(() => {
    void documents.value;
    return activeDocument.value ? documentFormat(activeDocument.value) : "mdx";
});

const title = computed(() => {
    void documents.value;
    const active = activeDocument.value;
    if (!active) return t("未打开文档", "No document open");
    return active.path ? documentNameFromPath(active.path) : active.displayName;
});
const content = computed({
    get: () => {
        void documents.value;
        return activeDocument.value?.content ?? "";
    },
    set: (markdown: string) => {
        const active = activeDocument.value;
        if (active) session.updateContent(active.id, markdown);
    },
});
function resourcePathKey(path: string) {
    const destination = path.split(/[?#]/u)[0].replace(/^\.\//u, "");
    try {
        return decodeURIComponent(destination);
    } catch {
        return destination;
    }
}
const attachmentItems = computed<AttachmentListItem[]>(() => {
    void documents.value;
    const active = activeDocument.value;
    if (!active?.meta) return [];
    const referencedPaths = new Set(
        [...referencedLocalResourcePaths(active.content)].map(resourcePathKey),
    );
    return active.meta.attachments.map((attachment) => ({
        ...attachment,
        referenced: referencedPaths.has(resourcePathKey(attachment.path)),
    }));
});
const dirty = computed(() => {
    void documents.value;
    return activeDocument.value?.dirty ?? false;
});
const loading = ref(false);
let disposeStatusMessage = () => {};
const statusMessage = customRef<string>((track, trigger) => {
    let message = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    disposeStatusMessage = () => {
        disposed = true;
        clearTimeout(timer);
    };
    return {
        get() {
            track();
            return message;
        },
        set(value) {
            if (disposed) return;
            clearTimeout(timer);
            message = value;
            trigger();
            if (value) {
                timer = setTimeout(() => {
                    message = "";
                    timer = undefined;
                    trigger();
                }, 3000);
            }
        },
    };
});
const errorMessage = ref("");
watch(session.warnings, (warnings, previous) => {
    if (warnings.length > previous.length) {
        errorMessage.value = warnings.slice(previous.length).join("\n");
    }
});
const statusBarRef = ref<InstanceType<typeof StatusBar> | null>(null);
const editorRef = ref<MoraEditorHandle | null>(null);
const workspaceSidebarRef = ref<WorkspaceSidebarHandle | null>(null);
const lastSearchQuery = ref("");
const findPanel = ref<InstanceType<typeof FindReplacePanel> | null>(null);

const editorMode = ref<EditorMode>("wysiwyg");
const sourcePreview = ref(true);
const printing = ref(false);
const documentExportsInProgress = ref(0);
const showToc = ref(true);
const compactLayout = ref(false);
const compactPanel = ref<"workspace" | "outline" | null>(null);
let compactMedia: MediaQueryList | null = null;
const recentFiles = ref<RecentFileEntry[]>([]);
const recentMenuItems = computed(() => recentFiles.value.slice(0, 10));
const showRecentFiles = ref(false);
const showCommandPalette = ref(false);
const restorePaletteFocus = ref(true);
const showFindPanel = ref(false);
const showReplacePanel = ref(false);
const findQuery = ref("");
const replaceQuery = ref("");
const showLibrary = ref(false);
const libraryQuery = ref("");
const libraryNotes = ref<NoteListItem[]>([]);
const libraryResults = ref<NoteSearchResult[]>([]);
const currentLibraryResults = computed(() =>
    libraryResults.value.map((item) => {
        const opened = documents.value.find(
            (doc) =>
                doc.path && workspacePathKey(doc.path) === workspacePathKey(item.path),
        );
        return opened ? { ...item, content: opened.content } : item;
    }),
);

const libraryLoading = ref(false);
const showHistory = ref(false);
const workspaceOperation = ref<{ path: string; root: string; directory: boolean } | null>(
    null,
);
const workspaceOperationBusy = ref(false);
const historyPreview = ref<HistorySnapshot | null>(null);
const historySelected = ref("");
const historyItems = ref<HistoryListItem[]>([]);
const historyLoading = ref(false);
let historyRequestId = 0;
const showAttachments = ref(false);
const attachmentBusyPath = ref<string | null>(null);
const showSettings = ref(false);
const showThemePicker = ref(false);
const showUpdateDialog = ref(false);
const mermaidViewerRequest = ref<MermaidViewerRequest | null>(null);
const mermaidExporting = ref(false);
const mermaidExportError = ref("");
const aiKeyConfigured = ref(false);
const aiKeySaving = ref(false);
const installedFontFamilies = ref<string[] | null>(null);
let aiKeyStatusRequestId = 0;

const {
    preferences,
    resolvedTheme,
    update: updatePreferences,
    dispose: disposePreferences,
} = usePreferences();
watch(
    resolvedTheme,
    (theme) => {
        if (!tauriRuntime) return;
        void setTheme(isDarkTheme(theme) ? "dark" : "light").catch((error: unknown) => {
            console.warn(
                t("同步原生窗口主题失败", "Failed to sync native window theme"),
                error,
            );
        });
    },
    { immediate: true },
);
const aiProvider = createOpenAICompatibleProvider(
    () => ({
        baseUrl: preferences.value.aiBaseUrl,
        model: preferences.value.aiModel,
    }),
    (markdown) => activeDocument.value?.resources.persistedMarkdown(markdown) ?? markdown,
);
const showLeavePrompt = ref(false);
const leavePromptDocumentName = ref("");
let leavePromptResolver: ((decision: LeaveDecision) => void) | null = null;
type ConflictDecision = "overwrite" | "reload" | "save-as" | "cancel";
const showConflictPrompt = ref(false);
const conflictPromptDocumentName = ref("");
let conflictPromptResolver: ((decision: ConflictDecision) => void) | null = null;
type MarkdownResourceDecision = "continue" | "cancel";
const showMarkdownResourcesPrompt = ref(false);
const markdownResourcesDocumentName = ref("");
const markdownResourcesPlan = ref<MarkdownResourcePlan>({
    rewrittenContent: "",
    resources: [],
    items: [],
});
let markdownResourcesResolver: ((decision: MarkdownResourceDecision) => void) | null =
    null;
const commandPaletteBlocked = computed(
    () =>
        showRecentFiles.value ||
        showLibrary.value ||
        showHistory.value ||
        showAttachments.value ||
        showSettings.value ||
        showLeavePrompt.value ||
        showConflictPrompt.value ||
        showMarkdownResourcesPrompt.value ||
        showUpdateDialog.value ||
        mermaidViewerRequest.value !== null,
);
const savingDocumentIds = reactive(new Set<string>());
const progressMessage = computed(() => {
    if (savingDocumentIds.size > 0) return t("正在保存…", "Saving…");
    if (documentExportsInProgress.value > 0)
        return t("正在导出文档…", "Exporting document…");
    if (printing.value) return t("正在准备打印…", "Preparing to print…");
    if (appUpdater.busy.value) {
        if (appUpdater.phase.value === "downloading")
            return t("正在下载更新…", "Downloading update…");
        if (appUpdater.phase.value === "installing")
            return t("正在安装更新…", "Installing update…");
        return t("正在检查更新…", "Checking for updates…");
    }
    return loading.value ||
        libraryLoading.value ||
        historyLoading.value ||
        aiKeySaving.value ||
        mermaidExporting.value
        ? t("正在处理…", "Processing…")
        : "";
});
watch(
    progressMessage,
    (message) => {
        if (message) statusMessage.value = "";
    },
    { flush: "sync" },
);
const agentBridge = useAgentBridge({
    desktop: tauriRuntime,
    enabled: computed(
        () => preferences.value.agentAccessEnabled && !workspaceOperationBusy.value,
    ),
    session,
    saveDocument: saveDocumentForAgent,
    onMutation() {
        errorMessage.value = "";
        statusMessage.value = t("Agent 已修改文档", "Agent modified document");
    },
});
const agentStatus = agentBridge.status;
const externalFileSync = useExternalFileSync({
    desktop: tauriRuntime,
    session,
    onReloaded(documentIds) {
        for (const id of documentIds) editorRef.value?.releaseDocument(id);
    },
    async onActiveConflict(documentId) {
        if (!showConflictPrompt.value) await resolveDocumentConflict(documentId);
    },
});
const watcherStatusMessage = ref("");
watch(externalFileSync.status, (current) => {
    if (current.state === "active") {
        watcherStatusMessage.value = "";
        return;
    }
    watcherStatusMessage.value =
        current.message ??
        (current.state === "degraded"
            ? t("外部文件同步已降级", "External file sync degraded")
            : t("外部文件同步不可用", "External file sync unavailable"));
});
function dismissStatusMessage() {
    errorMessage.value = "";
    watcherStatusMessage.value = "";
    statusMessage.value = "";
}
watch(agentStatus, (currentStatus) => {
    if (
        preferences.value.agentAccessEnabled &&
        !currentStatus.enabled &&
        currentStatus.lastError
    ) {
        updatePreferences({ agentAccessEnabled: false });
        errorMessage.value = t(
            `Agent 接入启动失败：${currentStatus.lastError}`,
            `Failed to start Agent access: ${currentStatus.lastError}`,
        );
        statusMessage.value = t("Agent 接入未开启", "Agent access is disabled");
    }
});
let unlistenSystemOpen: (() => void) | null = null;
let systemOpenChain = Promise.resolve();
let desktopRestored = false;
function drainSystemOpen() {
    if (!desktopRestored || workspaceOperationBusy.value) return;
    systemOpenChain = systemOpenChain
        .then(async () => {
            if (workspaceOperationBusy.value) return;
            const errors = await consumeOpenRequests(
                async () => {},
                () => invoke<string[]>("take_open_requests"),
                (path) => openPath(path, true),
            );
            if (errors.length) errorMessage.value = errors.join("\n");
        })
        .catch((error) => {
            errorMessage.value = stringifyError(error);
        });
    return systemOpenChain;
}
let unlistenClose: (() => void) | null = null;
let unlistenDragDrop: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let allowWindowClose = false;
let windowCloseInProgress = false;
const autoSaveClosing = ref(false);
const autoSaveReady = ref(false);
const autoSaveBlocked = computed(
    () =>
        !autoSaveReady.value ||
        autoSaveClosing.value ||
        workspaceOperationBusy.value ||
        loading.value ||
        showLeavePrompt.value ||
        showConflictPrompt.value ||
        showMarkdownResourcesPrompt.value ||
        appUpdater.busy.value,
);
const disposeAutoSave = useAutoSave(
    () => ({
        enabled: tauriRuntime && preferences.value.autoSave,
        paused: autoSaveBlocked.value || savingDocumentIds.size > 0,
        documents: documents.value.map((document) => ({
            id: document.id,
            path: document.path,
            revision: document.liveRevision,
            dirty: document.dirty,
            conflict: document.conflict,
            unavailable: document.unavailable,
        })),
    }),
    saveDocumentAutomatically,
    (document, error) => {
        errorMessage.value = t(
            `自动保存已暂停（${document.path}）：${stringifyError(error)}`,
            `Auto-save paused (${document.path}): ${stringifyError(error)}`,
        );
        statusMessage.value = t(
            "请手动保存，或重新开启自动保存",
            "Save manually or turn auto-save off and on again",
        );
    },
);
async function saveDocumentAutomatically(document: AutoSaveDocument) {
    if (autoSaveBlocked.value || !preferences.value.autoSave) return;
    const current = documents.value.find((item) => item.id === document.id);
    if (
        !current ||
        current.path !== document.path ||
        current.liveRevision !== document.revision ||
        !current.dirty ||
        current.conflict ||
        current.unavailable ||
        savingDocumentIds.has(current.id)
    )
        return;
    savingDocumentIds.add(current.id);
    try {
        await session.save(current.id, { expectedLiveRevision: document.revision });
        statusMessage.value = t("已自动保存", "Auto-saved");
    } catch (error) {
        // 检查磁盘版本期间的新编辑应重新计时，不视为保存失败。
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "REVISION_CONFLICT"
        )
            return;
        throw error;
    } finally {
        savingDocumentIds.delete(current.id);
    }
}
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function imageExtension(mimeType: string): string {
    const extensions: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
    };
    return extensions[mimeType] ?? "png";
}

function openMermaidViewer(request: MermaidViewerRequest): void {
    mermaidExportError.value = "";
    mermaidViewerRequest.value = request;
}

function closeMermaidViewer(): void {
    mermaidViewerRequest.value = null;
    mermaidExportError.value = "";
}

watch(
    [activeDocumentId, editorMode],
    () => {
        if (mermaidViewerRequest.value) closeMermaidViewer();
    },
    { flush: "sync" },
);

async function exportMermaidDiagram(diagram: MermaidDiagramSnapshot): Promise<void> {
    if (mermaidExporting.value) return;
    mermaidExporting.value = true;
    mermaidExportError.value = "";
    try {
        const path = await save({
            defaultPath: `${sanitizeFileName(title.value)}-${sanitizeFileName(diagram.label)}.png`,
            filters: [
                {
                    get name() {
                        return t("PNG 图像", "PNG images");
                    },
                    extensions: ["png"],
                },
            ],
        });
        if (!path) return;
        const base64 = await svgToPngBase64(diagram.svg, resolvedTheme.value);
        await invoke("export_diagram_png", { path, base64 });
        statusMessage.value = t("Mermaid 图表已导出", "Mermaid diagram exported");
    } catch (error) {
        mermaidExportError.value = stringifyError(error);
        statusMessage.value = t(
            "Mermaid 图表导出失败",
            "Failed to export Mermaid diagram",
        );
    } finally {
        mermaidExporting.value = false;
    }
}

async function registerPastedImage(file: File): Promise<string> {
    const active = activeDocument.value;
    if (!active)
        throw new Error(t("请先打开或新建文档", "Open or create a document first"));
    const extension = imageExtension(file.type);
    const filename = `assets/image-${crypto.randomUUID()}.${extension}`;
    const base64 = await blobToBase64(file);
    const objectUrl = URL.createObjectURL(file);
    active.resources.registerNew({
        path: filename,
        originalName: file.name || t(`图片.${extension}`, `image.${extension}`),
        mimeType: file.type || `image/${extension}`,
        size: file.size,
        base64,
        objectUrl,
        kind: "asset",
        isNew: true,
    });
    return objectUrl;
}

const wordCount = computed(() => countNonWhitespaceCharacters(content.value));
const displayContent = computed(
    () => activeDocument.value?.resources.displayMarkdown(content.value) ?? "",
);
const findMatchCount = computed(() => countOccurrences(content.value, findQuery.value));
const windowTitle = computed(() =>
    activeDocument.value
        ? `${dirty.value ? "* " : ""}${title.value} - ${APP_NAME.value}`
        : APP_NAME.value,
);

const toc = computed(() => {
    return extractMarkdownHeadings(content.value);
});
const outlineAvailable = computed(() =>
    Boolean(activeDocument.value && toc.value.length),
);
const workspaceVisible = computed(() =>
    compactLayout.value ? compactPanel.value === "workspace" : !sidebarCollapsed.value,
);
const outlineVisible = computed(() =>
    compactLayout.value
        ? compactPanel.value === "outline" && outlineAvailable.value
        : showToc.value && outlineAvailable.value,
);

function scrollToHeading(text: string) {
    editorRef.value?.scrollToHeading(text);
    if (compactLayout.value) compactPanel.value = null;
}

function setTocVisibility(visible: boolean) {
    showToc.value = visible;
    updatePreferences({ showToc: visible });
    statusMessage.value = visible
        ? t("已显示目录", "Outline shown")
        : t("已隐藏目录", "Outline hidden");
}

function syncCompactLayout(event: MediaQueryListEvent | MediaQueryList) {
    compactLayout.value = event.matches;
    compactPanel.value = null;
}

function toggleWorkspacePanel() {
    if (compactLayout.value) {
        compactPanel.value = compactPanel.value === "workspace" ? null : "workspace";
        return;
    }
    updateSidebarCollapsed(!sidebarCollapsed.value);
}

function toggleOutlinePanel() {
    if (!outlineAvailable.value) return;
    if (compactLayout.value) {
        compactPanel.value = compactPanel.value === "outline" ? null : "outline";
        return;
    }
    setTocVisibility(!showToc.value);
}

function persistWorkspaceLayout() {
    void session.persist().catch((error: unknown) => {
        console.warn(t("保存工作区布局失败", "Failed to save workspace layout"), error);
    });
}

function toggleWorkspacePath(path: string) {
    expandedPaths.value = expandedPaths.value.includes(path)
        ? expandedPaths.value.filter((item) => item !== path)
        : [...expandedPaths.value, path];
    persistWorkspaceLayout();
}

function updateSidebarCollapsed(collapsed: boolean) {
    sidebarCollapsed.value = collapsed;
    persistWorkspaceLayout();
}

function updateSidebarWidth(width: number) {
    sidebarWidth.value = width;
    persistWorkspaceLayout();
}

function countOccurrences(source: string, query: string) {
    if (!query) return 0;

    let startIndex = 0;
    let count = 0;

    while (startIndex <= source.length) {
        const matchIndex = source.indexOf(query, startIndex);
        if (matchIndex === -1) break;

        count += 1;
        startIndex = matchIndex + Math.max(query.length, 1);
    }

    return count;
}

const fileMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "file.new",
        get label() {
            return t("新建 MDX", "New MDX");
        },
        shortcut: "Ctrl+N",
        action: () => createNewNote(),
    },
    {
        id: "file.new-markdown",
        get label() {
            return t("新建 Markdown", "New Markdown");
        },
        action: () => createNewNote("markdown"),
    },
    {
        id: "file.open",
        get label() {
            return t("打开文件", "Open file");
        },
        shortcut: "Ctrl+O",
        action: openFiles,
    },
    {
        id: "file.open-folder",
        get label() {
            return t("打开文件夹", "Open folder");
        },
        shortcut: "Ctrl+Shift+O",
        action: openFolder,
    },
    {
        id: "file.close",
        get label() {
            return t("关闭当前文档", "Close current document");
        },
        shortcut: "Ctrl+W",
        action: closeActiveDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "file.save",
        get label() {
            return t("保存", "Save");
        },
        shortcut: "Ctrl+S",
        action: saveNote,
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.save-as",
        get label() {
            return t("另存为", "Save as");
        },
        shortcut: "Ctrl+Shift+S",
        action: () => saveNoteAs(),
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.save-as-markdown",
        get label() {
            return t("另存为 Markdown", "Save as Markdown");
        },
        action: () => saveNoteAs("markdown"),
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.save-as-mdx",
        get label() {
            return t("另存为 MDX", "Save as MDX");
        },
        action: () => saveNoteAs("mdx"),
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.history",
        get label() {
            return t("历史版本", "Version history");
        },
        action: openHistoryPanel,
        disabled: !activeDocument.value || activeDocumentFormat.value !== "mdx",
    },
    {
        id: "file.export-markdown",
        get label() {
            return t("导出 Markdown", "Export Markdown");
        },
        action: exportMarkdown,
        disabled: !activeDocument.value,
    },
    {
        id: "file.export-word",
        get label() {
            return t("导出 Word", "Export Word");
        },
        action: () => exportDocument("docx"),
        disabled: !activeDocument.value,
    },
    {
        id: "file.export-pdf",
        get label() {
            return t("导出 PDF", "Export PDF");
        },
        action: () => exportDocument("pdf"),
        disabled: !activeDocument.value,
    },
    {
        id: "file.print",
        get label() {
            return t("打印", "Print");
        },
        action: printDocument,
        disabled: !activeDocument.value,
    },
]);

const editMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "edit.undo",
        get label() {
            return t("撤销", "Undo");
        },
        shortcut: "Ctrl+Z",
        action: undoEdit,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.redo",
        get label() {
            return t("重做", "Redo");
        },
        shortcut: "Ctrl+Y",
        action: redoEdit,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.cut",
        get label() {
            return t("剪切", "Cut");
        },
        shortcut: "Ctrl+X",
        action: cutSelection,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.copy",
        get label() {
            return t("复制", "Copy");
        },
        shortcut: "Ctrl+C",
        action: copySelection,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.paste",
        get label() {
            return t("粘贴", "Paste");
        },
        shortcut: "Ctrl+V",
        action: pasteClipboard,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.select-all",
        get label() {
            return t("全选", "Select all");
        },
        shortcut: "Ctrl+A",
        action: selectAllContent,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.find",
        get label() {
            return t("查找", "Find");
        },
        shortcut: "Ctrl+F",
        action: findInDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.workspace-search",
        get label() {
            return t("工作区查找", "Find in workspace");
        },
        shortcut: "Ctrl+Shift+F",
        action: openLibrary,
    },
    {
        id: "edit.replace",
        get label() {
            return t("替换", "Replace");
        },
        shortcut: "Ctrl+H",
        action: replaceInDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.settings",
        get label() {
            return t("偏好设置", "Preferences");
        },
        shortcut: "Ctrl+,",
        action: openSettingsPanel,
    },
]);

const formatMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "format.paragraph",
        get label() {
            return t("段落", "Paragraph");
        },
        shortcut: "Ctrl+0",
        action: () => runEditorCommand("heading", { level: 0 }),
    },
    {
        id: "format.heading-1",
        get label() {
            return t("一级标题", "Heading 1");
        },
        shortcut: "Ctrl+1",
        action: () => runEditorCommand("heading", { level: 1 }),
    },
    {
        id: "format.heading-2",
        get label() {
            return t("二级标题", "Heading 2");
        },
        shortcut: "Ctrl+2",
        action: () => runEditorCommand("heading", { level: 2 }),
    },
    {
        id: "format.heading-3",
        get label() {
            return t("三级标题", "Heading 3");
        },
        shortcut: "Ctrl+3",
        action: () => runEditorCommand("heading", { level: 3 }),
    },
    {
        id: "format.heading-4",
        get label() {
            return t("四级标题", "Heading 4");
        },
        shortcut: "Ctrl+4",
        action: () => runEditorCommand("heading", { level: 4 }),
    },
    {
        id: "format.heading-5",
        get label() {
            return t("五级标题", "Heading 5");
        },
        shortcut: "Ctrl+5",
        action: () => runEditorCommand("heading", { level: 5 }),
    },
    {
        id: "format.heading-6",
        get label() {
            return t("六级标题", "Heading 6");
        },
        shortcut: "Ctrl+6",
        action: () => runEditorCommand("heading", { level: 6 }),
    },
    {
        id: "format.bold",
        get label() {
            return t("加粗", "Bold");
        },
        shortcut: "Ctrl+B",
        action: () => runEditorCommand("bold"),
    },
    {
        id: "format.italic",
        get label() {
            return t("斜体", "Italic");
        },
        shortcut: "Ctrl+I",
        action: () => runEditorCommand("italic"),
    },
    {
        id: "format.strike",
        get label() {
            return t("删除线", "Strikethrough");
        },
        shortcut: "Ctrl+Shift+X",
        action: () => runEditorCommand("strike"),
    },
    {
        id: "format.code",
        get label() {
            return t("行内代码", "Inline code");
        },
        shortcut: "Ctrl+`",
        action: () => runEditorCommand("code"),
    },
]);

const insertMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "insert.block-quote",
        get label() {
            return t("引用块", "Blockquote");
        },
        action: () => runEditorCommand("blockQuote"),
    },
    {
        id: "insert.bullet-list",
        get label() {
            return t("无序列表", "Bullet list");
        },
        shortcut: "Ctrl+L",
        action: () => runEditorCommand("bulletList"),
    },
    {
        id: "insert.ordered-list",
        get label() {
            return t("有序列表", "Ordered list");
        },
        shortcut: "Ctrl+Alt+L",
        action: () => runEditorCommand("orderedList"),
    },
    {
        id: "insert.task-list",
        get label() {
            return t("任务列表", "Task list");
        },
        shortcut: "Ctrl+T",
        action: () => runEditorCommand("taskList"),
    },
    {
        id: "insert.indent",
        get label() {
            return t("增加缩进", "Increase indent");
        },
        shortcut: "Tab",
        action: () => runEditorCommand("indent"),
    },
    {
        id: "insert.outdent",
        get label() {
            return t("减少缩进", "Decrease indent");
        },
        shortcut: "Shift+Tab",
        action: () => runEditorCommand("outdent"),
    },
    {
        id: "insert.hr",
        get label() {
            return t("分割线", "Divider");
        },
        action: () => runEditorCommand("hr"),
    },
    {
        id: "insert.code-block",
        get label() {
            return t("代码块", "Code block");
        },
        action: () => runEditorCommand("codeBlock"),
    },
    {
        id: "insert.link",
        get label() {
            return t("链接", "Link");
        },
        shortcut: "Ctrl+K",
        action: insertLink,
    },
    {
        id: "insert.image-reference",
        get label() {
            return t("图片引用", "Image reference");
        },
        shortcut: "Ctrl+Shift+I",
        action: insertImageReference,
    },
    {
        id: "insert.resource",
        get label() {
            return t("导入图片或附件", "Import image or attachment");
        },
        action: chooseResources,
    },
    {
        id: "insert.attachments",
        get label() {
            return t("附件管理", "Attachments");
        },
        action: () => {
            showAttachments.value = true;
        },
        disabled: !activeDocument.value,
    },
    {
        id: "insert.table",
        get label() {
            return t("表格", "Table");
        },
        action: insertTable,
    },
]);

const viewMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "view.wysiwyg",
        get label() {
            return t("所见即所得", "Visual editor");
        },
        shortcut: "Alt+1",
        action: () => setEditorMode("wysiwyg"),
        disabled: !activeDocument.value,
    },
    {
        id: "view.source",
        get label() {
            return t("仅源码", "Source only");
        },
        shortcut: "Alt+2",
        action: () => setSourcePreview(false),
        disabled: !activeDocument.value,
    },
    {
        id: "view.split",
        get label() {
            return t("垂直双栏", "Source and preview");
        },
        shortcut: "Alt+3",
        action: () => setSourcePreview(true),
        disabled: !activeDocument.value,
    },
    {
        id: "view.toggle-workspace",
        get label() {
            return t("工作区", "Workspace");
        },
        shortcut: "Ctrl+Shift+B",
        action: toggleWorkspacePanel,
    },
    {
        id: "view.toggle-outline",
        get label() {
            return t("目录", "Outline");
        },
        shortcut: "Ctrl+Shift+J",
        action: toggleOutlinePanel,
        disabled: !outlineAvailable.value,
    },
    {
        id: "view.theme",
        get label() {
            return t("主题", "Theme");
        },
        shortcut: "Ctrl+Shift+T",
        action: () => {
            showThemePicker.value = true;
        },
    },
]);

const aboutMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "about.check-updates",
        get label() {
            return t("检查更新", "Check for updates");
        },
        action: checkForAppUpdate,
        disabled: !updatesEnabled || appUpdater.busy.value,
    },
]);

type MenuGroupId = "file" | "edit" | "format" | "insert" | "view" | "about";
type PaletteEntry = CommandPaletteCommand & { action: MarkdownCommand["action"] };
type RecentOpenPaletteEntry = PaletteEntry & { path: string };

function isMenuCommandDisabled(groupId: MenuGroupId, command: MarkdownCommand): boolean {
    return (
        workspaceOperationBusy.value ||
        Boolean(command.disabled) ||
        ((groupId === "format" || groupId === "insert") && !activeDocument.value)
    );
}

const paletteEntries = computed<PaletteEntry[]>(() =>
    (
        [
            ["file", t("文件", "File"), fileMenu.value],
            ["edit", t("编辑", "Edit"), editMenu.value],
            ["format", t("格式", "Format"), formatMenu.value],
            ["insert", t("插入", "Insert"), insertMenu.value],
            ["view", t("视图", "View"), viewMenu.value],
            ["about", t("关于", "About"), aboutMenu.value],
        ] as const
    ).flatMap(([groupId, category, commands]) =>
        commands.map((command) => ({
            id: command.id,
            category,
            label: command.label,
            shortcut: command.shortcut,
            disabled: isMenuCommandDisabled(groupId, command),
            action: command.action,
        })),
    ),
);

const recentOpenPaletteEntries = computed<RecentOpenPaletteEntry[]>(() =>
    recentMenuItems.value.map((item) => ({
        id: `recent.open.${item.path}`,
        category: t("最近打开", "Recent files"),
        label: formatRecentFileLabel(item),
        shortcut: formatRecentFilePath(item.path),
        disabled: false,
        path: item.path,
        action: () => openRecentFile(item.path),
    })),
);

const recentUtilityPaletteEntries = computed<PaletteEntry[]>(() => [
    {
        id: "recent.show-all",
        category: t("最近打开", "Recent files"),
        get label() {
            return t("查看全部……", "View all…");
        },
        disabled: recentFiles.value.length === 0,
        action: showAllRecentFiles,
    },
    {
        id: "recent.clear",
        category: t("最近打开", "Recent files"),
        get label() {
            return t("清空最近打开", "Clear recent files");
        },
        disabled: recentFiles.value.length === 0,
        action: clearRecentFiles,
    },
]);

const recentPaletteEntries = computed<PaletteEntry[]>(() => [
    ...recentOpenPaletteEntries.value,
    ...recentUtilityPaletteEntries.value,
]);

const paletteCommands = computed<CommandPaletteCommand[]>(() =>
    [...paletteEntries.value, ...recentPaletteEntries.value].map(
        ({ action: _action, ...command }) => command,
    ),
);

function runPaletteCommand(id: string): void {
    const command = [...paletteEntries.value, ...recentPaletteEntries.value].find(
        (item) => item.id === id,
    );
    if (!command || command.disabled) return;
    restorePaletteFocus.value = true;
    showCommandPalette.value = false;
    const action = command.action();
    restorePaletteFocus.value = !commandPaletteBlocked.value;
    void action;
}

function openCommandPalette(): void {
    if (commandPaletteBlocked.value) return;
    restorePaletteFocus.value = true;
    showCommandPalette.value = true;
}

function closeCommandPalette(): void {
    restorePaletteFocus.value = true;
    showCommandPalette.value = false;
}

function showAllRecentFiles(): void {
    showRecentFiles.value = true;
}

function requestLeaveDecision(documentName: string) {
    leavePromptDocumentName.value = documentName;
    showLeavePrompt.value = true;
    return new Promise<LeaveDecision>((resolve) => {
        leavePromptResolver = resolve;
    });
}

function resolveLeaveDecision(decision: LeaveDecision) {
    const resolve = leavePromptResolver;
    leavePromptResolver = null;
    showLeavePrompt.value = false;
    leavePromptDocumentName.value = "";
    resolve?.(decision);
}

function requestConflictDecision(documentId: string) {
    const target = session.document(documentId);
    conflictPromptDocumentName.value = target.displayName;
    showConflictPrompt.value = true;
    return new Promise<ConflictDecision>((resolve) => {
        conflictPromptResolver = resolve;
    });
}

function resolveConflictDecision(decision: ConflictDecision) {
    const resolve = conflictPromptResolver;
    conflictPromptResolver = null;
    showConflictPrompt.value = false;
    conflictPromptDocumentName.value = "";
    resolve?.(decision);
}

function requestMarkdownResourceDecision(
    documentName: string,
    plan: MarkdownResourcePlan,
) {
    markdownResourcesDocumentName.value = documentName;
    markdownResourcesPlan.value = plan;
    showMarkdownResourcesPrompt.value = true;
    return new Promise<MarkdownResourceDecision>((resolve) => {
        markdownResourcesResolver = resolve;
    });
}

function resolveMarkdownResourceDecision(decision: MarkdownResourceDecision) {
    const resolve = markdownResourcesResolver;
    markdownResourcesResolver = null;
    showMarkdownResourcesPrompt.value = false;
    markdownResourcesDocumentName.value = "";
    resolve?.(decision);
}

watch(
    () => preferences.value.showToc,
    (visible) => {
        showToc.value = visible;
    },
    { immediate: true },
);

watch(outlineAvailable, (available) => {
    if (!available && compactPanel.value === "outline") compactPanel.value = null;
});

watch([activeDocumentId, currentPath], ([current, path], [previous, previousPath]) => {
    if (current === previous && path === previousPath) return;
    historyRequestId += 1;
    showHistory.value = false;
    historyPreview.value = null;
    historySelected.value = "";
    historyItems.value = [];
    historyLoading.value = false;
    showAttachments.value = false;
    attachmentBusyPath.value = null;
});

watch(
    windowTitle,
    (value) => {
        document.title = value;
        if (tauriRuntime)
            void getCurrentWindow()
                .setTitle?.(value)
                .catch((error: unknown) => console.error(error));
    },
    { immediate: true },
);

async function refreshAiKeyConfigured() {
    const requestId = ++aiKeyStatusRequestId;
    if (!tauriRuntime) {
        aiKeyConfigured.value = false;
        return;
    }

    try {
        const configured = await invoke<boolean>("has_ai_api_key");
        if (requestId !== aiKeyStatusRequestId) return;
        aiKeyConfigured.value = configured;
    } catch (error) {
        if (requestId !== aiKeyStatusRequestId) return;
        aiKeyConfigured.value = false;
        console.warn(
            t("读取 AI API Key 状态失败", "Failed to read AI API key status"),
            error,
        );
    }
}

async function refreshInstalledFontFamilies() {
    if (!tauriRuntime || installedFontFamilies.value !== null) return;

    try {
        const families = await invoke<unknown>("list_system_font_families");
        if (
            Array.isArray(families) &&
            families.every((family): family is string => typeof family === "string")
        ) {
            installedFontFamilies.value = families;
        }
    } catch (error) {
        console.warn(t("读取系统字体列表失败", "Failed to list system fonts"), error);
    }
}

async function openSettingsPanel() {
    showSettings.value = true;
    await Promise.all([refreshAiKeyConfigured(), refreshInstalledFontFamilies()]);
}

function closeSettingsPanel() {
    showSettings.value = false;
    void nextTick(() => editorRef.value?.focus());
}

function selectTheme(theme: ThemeId) {
    updatePreferences({ theme });
}

async function saveAiApiKey(apiKey: string) {
    if (!tauriRuntime || aiKeySaving.value) return;

    aiKeySaving.value = true;
    try {
        await invoke("save_ai_api_key", { key: apiKey });
        await refreshAiKeyConfigured();
        statusMessage.value = t("AI API Key 已保存", "AI API key saved");
    } catch (error) {
        errorMessage.value = t(
            `AI API Key 保存失败：${stringifyError(error)}`,
            `Failed to save AI API key: ${stringifyError(error)}`,
        );
        statusMessage.value = t("AI API Key 保存失败", "Failed to save AI API key");
    } finally {
        aiKeySaving.value = false;
    }
}

async function deleteAiApiKey() {
    if (!tauriRuntime || aiKeySaving.value) return;

    aiKeySaving.value = true;
    try {
        await invoke("delete_ai_api_key");
        await refreshAiKeyConfigured();
        statusMessage.value = t("AI API Key 已删除", "AI API key deleted");
    } catch (error) {
        errorMessage.value = t(
            `AI API Key 删除失败：${stringifyError(error)}`,
            `Failed to delete AI API key: ${stringifyError(error)}`,
        );
        statusMessage.value = t("AI API Key 删除失败", "Failed to delete AI API key");
    } finally {
        aiKeySaving.value = false;
    }
}

async function copyAgentConfig() {
    const cliPath = agentStatus.value.cliPath;
    if (!cliPath) {
        errorMessage.value = t(
            "当前安装未提供 mora-agent CLI，无法生成 MCP 配置。",
            "This installation does not include the mora-agent CLI, so MCP configuration is unavailable.",
        );
        statusMessage.value = t("MCP 配置复制失败", "Failed to copy MCP configuration");
        return;
    }
    const config = JSON.stringify(
        {
            mcpServers: {
                mora: { command: cliPath, args: ["mcp"] },
            },
        },
        null,
        2,
    );
    try {
        await navigator.clipboard.writeText(config);
        errorMessage.value = "";
        statusMessage.value = t("MCP 配置已复制", "MCP configuration copied");
    } catch (error) {
        errorMessage.value = t(
            `MCP 配置复制失败：${stringifyError(error)}`,
            `Failed to copy MCP configuration: ${stringifyError(error)}`,
        );
        statusMessage.value = t("MCP 配置复制失败", "Failed to copy MCP configuration");
    }
}

onMounted(async () => {
    window.addEventListener("pointerdown", handleWindowPointerDown, true);
    window.addEventListener("keydown", handleWindowKeyDown);
    if (typeof window.matchMedia === "function") {
        compactMedia = window.matchMedia("(max-width: 980px)");
        syncCompactLayout(compactMedia);
        compactMedia.addEventListener("change", syncCompactLayout);
    }

    if (!tauriRuntime) return;

    unlistenSystemOpen = await listen("open-files-ready", () => {
        void drainSystemOpen();
    });
    try {
        await session.restore();
        const restored = activeDocument.value;
        if (restored) await hydrateDocumentResources(restored);
        if (session.warnings.value.length > 0) {
            errorMessage.value = session.warnings.value.join("\n");
            statusMessage.value = t("工作区已部分恢复", "Workspace partially restored");
        }
    } catch (error) {
        errorMessage.value = t(
            `恢复工作区失败：${stringifyError(error)}`,
            `Failed to restore workspace: ${stringifyError(error)}`,
        );
        statusMessage.value = t("工作区恢复失败", "Failed to restore workspace");
    }

    desktopRestored = true;
    autoSaveReady.value = true;
    await drainSystemOpen();
    await refreshAiKeyConfigured();

    const appWindow = getCurrentWindow();
    unlistenFocus = await appWindow.onFocusChanged(async (event) => {
        if (!event.payload || workspaceOperationBusy.value) return;
        const reports = await session.refreshFolders();
        if (reports.some((report) => report.failed.length > 0)) {
            statusMessage.value = formatIndexRefresh(reports);
        }
        const reloadedIds = await session.refreshDiskState();
        for (const id of reloadedIds) editorRef.value?.releaseDocument(id);
        const activeId = activeDocumentId.value;
        if (
            activeId &&
            session.document(activeId).conflict &&
            !showConflictPrompt.value
        ) {
            await resolveDocumentConflict(activeId);
        }
    });
    unlistenDragDrop = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        await importResourcePaths(event.payload.paths);
    });
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
        if (savingDocumentIds.size > 0 || workspaceOperationBusy.value) {
            event.preventDefault();
            statusMessage.value = t(
                "请先完成当前保存操作",
                "Complete the current save operation first",
            );
            return;
        }
        if (allowWindowClose || !documents.value.some((document) => document.dirty)) {
            return;
        }
        event.preventDefault();
        if (windowCloseInProgress) return;
        windowCloseInProgress = true;
        autoSaveClosing.value = true;
        try {
            if (await session.prepareWindowClose(closeActions)) {
                allowWindowClose = true;
                await appWindow.close();
            }
        } catch (error) {
            errorMessage.value = t(
                `关闭前处理失败：${stringifyError(error)}`,
                `Close preparation failed: ${stringifyError(error)}`,
            );
            statusMessage.value = t("窗口关闭已取消", "Window close cancelled");
        } finally {
            windowCloseInProgress = false;
            autoSaveClosing.value = false;
        }
    });

    await loadRecentFiles();
    void appUpdater.checkForUpdate({ silent: true }).then((result) => {
        if (result === "available") showUpdateDialog.value = true;
    });
});

onBeforeUnmount(() => {
    disposeAutoSave();
    disposeStatusMessage();
    window.removeEventListener("pointerdown", handleWindowPointerDown, true);
    window.removeEventListener("keydown", handleWindowKeyDown);
    compactMedia?.removeEventListener("change", syncCompactLayout);
    unlistenSystemOpen?.();
    unlistenClose?.();
    unlistenDragDrop?.();
    unlistenFocus?.();
    externalFileSync.dispose();
    agentBridge.dispose();
    disposePreferences();
    void session.dispose().catch((error: unknown) => {
        console.warn(t("释放文档会话失败", "Failed to release document session"), error);
    });
});

function handleEditorUpdate(markdown: string) {
    if (printing.value) return;
    const active = activeDocument.value;
    if (!active) return;
    const persistedContent = active.resources.persistedMarkdown(markdown);
    if (persistedContent === content.value) return;

    session.updateContent(active.id, persistedContent);
}

function handleAiError(message: string) {
    const needsSettings = /Base URL|模型|model|API Key/i.test(message);
    const detail = needsSettings
        ? t(
              `${message}，请在偏好设置中完成 AI 配置`,
              `${message}. Complete AI configuration in Preferences`,
          )
        : message;
    errorMessage.value = t(`AI 生成失败：${detail}`, `AI generation failed: ${detail}`);
    statusMessage.value = t("AI 生成失败", "AI generation failed");
}

async function hydrateDocumentResources(runtime: SessionDocument) {
    const persistedContent = runtime.content;
    const sourcePath = runtime.path;
    const sourceRevision = runtime.diskRevision;
    const resourceGeneration = runtime.resources.generation();
    if (!sourcePath || !runtime.meta) return;
    const isMarkdown = documentFormat(runtime) === "markdown";
    const paths = isMarkdown
        ? new Set([
              ...referencedLocalResourcePaths(persistedContent),
              ...runtime.meta.assets.map((item) => item.path),
              ...runtime.meta.attachments.map((item) => item.path),
          ])
        : referencedResourcePaths(persistedContent);
    for (const assetPath of paths) {
        try {
            if (
                runtime.resources.resource(assetPath) ||
                runtime.resources.removedResources().includes(assetPath)
            )
                continue;
            const resourceMeta = [
                ...runtime.meta.assets,
                ...runtime.meta.attachments,
            ].find(
                (resource) =>
                    resourcePathKey(resource.path) === resourcePathKey(assetPath),
            );
            const loaded = isMarkdown
                ? await invoke<ResourceSaveData>("read_markdown_resource", {
                      sourcePath,
                      reference: assetPath,
                      ...(assetPath.includes("&") ? { markdown: persistedContent } : {}),
                  })
                : null;
            const base64 =
                loaded?.base64 ??
                (await invoke<string>("read_asset", {
                    path: sourcePath,
                    assetName: assetPath,
                    ...(assetPath.includes("&") ? { markdown: persistedContent } : {}),
                }));
            if (
                !documents.value.includes(runtime) ||
                runtime.path !== sourcePath ||
                runtime.diskRevision !== sourceRevision ||
                runtime.resources.generation() !== resourceGeneration
            )
                return;
            if (
                runtime.resources.resource(assetPath) ||
                runtime.resources.removedResources().includes(assetPath)
            )
                continue;
            const mimeType =
                loaded?.mimeType ?? resourceMeta?.type ?? "application/octet-stream";
            const blob = base64ToBlob(base64, mimeType);
            runtime.resources.registerLoaded({
                path: assetPath,
                originalName:
                    loaded?.originalName ??
                    resourceMeta?.originalName ??
                    assetPath.split("/").pop() ??
                    t("资源", "Resources"),
                mimeType,
                size: loaded?.size ?? resourceMeta?.size ?? blob.size,
                base64,
                objectUrl: URL.createObjectURL(blob),
                kind:
                    loaded?.kind ??
                    (assetPath.startsWith("assets/") ? "asset" : "attachment"),
                isNew: false,
            });
        } catch (error) {
            console.warn(t("加载资源失败", "Failed to load resources"), assetPath, error);
        }
    }
}

async function runAction(action: () => Promise<void>) {
    if (loading.value) return;

    loading.value = true;
    errorMessage.value = "";

    try {
        await action();
    } catch (error) {
        errorMessage.value = stringifyError(error);
        statusMessage.value = t("操作失败", "Operation failed");
    } finally {
        loading.value = false;
    }
}

function createNewNote(format: DocumentFormat = "mdx") {
    editorRef.value?.cancelAi();
    session.newDocument(format);
    errorMessage.value = "";
    statusMessage.value = t("已新建文档", "Document created");
}

async function loadRecentFiles() {
    try {
        recentFiles.value = await invoke<RecentFileEntry[]>("get_recent_files");
    } catch (error) {
        console.warn(t("读取最近打开列表失败", "Failed to load recent files"), error);
    }
}

async function pushRecentFile(path: string, noteTitle: string) {
    recentFiles.value = await invoke<RecentFileEntry[]>("push_recent_file", {
        path,
        title: noteTitle,
    });
}

async function removeRecentFile(path: string) {
    recentFiles.value = await invoke<RecentFileEntry[]>("remove_recent_file", {
        path,
    });
}

async function clearRecentFiles() {
    await invoke("clear_recent_files");
    recentFiles.value = [];
    statusMessage.value = t("已清空最近打开列表", "Recent files cleared");
}

function formatRecentFileLabel(entry: RecentFileEntry) {
    return (
        entry.title.trim() ||
        entry.path.split(/[\\/]/).pop() ||
        t("未命名笔记", "Untitled note")
    );
}

function formatRecentFilePath(path: string) {
    return path
        .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
        .replace(/^\\\\\?\\(?=[a-z]:\\)/iu, "");
}

async function openRecentFile(path: string) {
    await runAction(async () => {
        try {
            await openPath(path, true);
            showRecentFiles.value = false;
        } catch (error) {
            recentFiles.value = recentFiles.value.map((entry) =>
                entry.path === path ? { ...entry, available: false } : entry,
            );
            throw error;
        }
    });
}

function focusFindField(selectText = true) {
    findPanel.value?.focusFind(selectText);
}

function focusReplaceField() {
    findPanel.value?.focusReplace();
}
function openFindPanel() {
    showFindPanel.value = true;
    showReplacePanel.value = false;

    const selectedText = editorRef.value?.getSelectedText().trim() ?? "";
    if (selectedText) {
        findQuery.value = selectedText;
        lastSearchQuery.value = selectedText;
    } else if (lastSearchQuery.value && !findQuery.value) {
        findQuery.value = lastSearchQuery.value;
    }

    focusFindField();
    statusMessage.value = t("已打开查找面板", "Find panel opened");
}

function openReplacePanel() {
    showFindPanel.value = true;
    showReplacePanel.value = true;

    const selectedText = editorRef.value?.getSelectedText().trim() ?? "";
    if (selectedText) {
        findQuery.value = selectedText;
        lastSearchQuery.value = selectedText;
    } else if (lastSearchQuery.value && !findQuery.value) {
        findQuery.value = lastSearchQuery.value;
    }

    if (findQuery.value) {
        focusReplaceField();
    } else {
        focusFindField();
    }

    statusMessage.value = t("已打开替换面板", "Replace panel opened");
}

function closeFindPanel() {
    showFindPanel.value = false;
    showReplacePanel.value = false;
    focusEditor();
}

function ensureFindQuery() {
    const query = findQuery.value.trim();
    if (!query) {
        statusMessage.value = t("请输入要查找的内容", "Enter text to find");
        focusFindField(false);
        return "";
    }

    findQuery.value = query;
    lastSearchQuery.value = query;
    return query;
}

function runBrowserFind(query: string, backward = false) {
    const browserFind = (
        window as Window & {
            find?: (
                searchString: string,
                caseSensitive?: boolean,
                backwards?: boolean,
                wrapAround?: boolean,
                wholeWord?: boolean,
                searchInFrames?: boolean,
                showDialog?: boolean,
            ) => boolean;
        }
    ).find;

    if (typeof browserFind !== "function") {
        statusMessage.value = t(
            "当前环境不支持查找定位",
            "Find navigation is unavailable in this environment",
        );
        return false;
    }

    focusEditor();
    return browserFind(query, true, backward, true, false, false, false);
}

function navigateFindResult(backward = false) {
    const query = ensureFindQuery();
    if (!query) return;

    const found = runBrowserFind(query, backward);
    statusMessage.value = found
        ? t(`已定位到“${query}”`, `Found “${query}”`)
        : t(`未找到“${query}”`, `No matches for “${query}”`);
}

function expandReplacePanel() {
    showReplacePanel.value = true;
    focusReplaceField();
}

function replaceCurrentMatch() {
    const query = ensureFindQuery();
    if (!query || !editorRef.value) return;

    if (editorRef.value.getSelectedText() !== query) {
        const found = runBrowserFind(query, false);
        if (!found || editorRef.value.getSelectedText() !== query) {
            statusMessage.value = t(`未定位到“${query}”`, `Could not locate “${query}”`);
            return;
        }
    }

    editorRef.value.replaceSelection(replaceQuery.value);
    statusMessage.value = t(`已替换当前“${query}”`, `Replaced current “${query}”`);
    navigateFindResult(false);
}

function replaceAllMatches() {
    const query = ensureFindQuery();
    if (!query) return;

    const matchCount = countOccurrences(content.value, query);
    if (matchCount === 0) {
        statusMessage.value = t(`未找到“${query}”`, `No matches for “${query}”`);
        return;
    }

    content.value = content.value.split(query).join(replaceQuery.value);
    statusMessage.value = t(
        `已替换 ${matchCount} 处“${query}”`,
        `Replaced ${matchCount} matches of “${query}”`,
    );
}

async function openPath(path: string, recordRecent: boolean) {
    editorRef.value?.cancelAi();
    const runtime = /\.mdx$/iu.test(path)
        ? await session.openMdx(path)
        : await session.openMarkdown(path);
    if (runtime.path) runtime.displayName = documentNameFromPath(runtime.path);
    await hydrateDocumentResources(runtime);
    const recentPath = runtime.path ?? runtime.importSourcePath;
    if (recordRecent && recentPath) {
        await pushRecentFile(recentPath, runtime.displayName);
    }
    errorMessage.value = "";
    statusMessage.value = t("已打开文档", "Document opened");
    return runtime;
}

async function openFiles() {
    const selected = await open({
        multiple: true,
        filters: [
            {
                get name() {
                    return t("墨笺 与 Markdown 文档", "Mora and Markdown documents");
                },
                extensions: ["mdx", "md", "markdown"],
            },
        ],
    });
    if (!selected) {
        statusMessage.value = "";
        return;
    }

    await runAction(async () => {
        const failures: string[] = [];
        let openedCount = 0;
        for (const path of Array.isArray(selected) ? selected : [selected]) {
            try {
                await openPath(path, true);
                openedCount += 1;
            } catch (error) {
                failures.push(`${path}：${stringifyError(error)}`);
            }
        }
        if (failures.length > 0) {
            errorMessage.value = failures.join("\n");
            statusMessage.value =
                openedCount > 0
                    ? t("部分文件打开失败", "Some files could not be opened")
                    : t("打开文件失败", "Failed to open file");
        }
    });
}

async function openWorkspacePath(path: string) {
    await runAction(() => openPath(path, false).then(() => undefined));
    if (compactLayout.value) compactPanel.value = null;
}

async function openFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) {
        statusMessage.value = "";
        return;
    }
    await runAction(async () => {
        const folder = await session.openFolder(selected);
        if (compactLayout.value) compactPanel.value = "workspace";
        else updateSidebarCollapsed(false);
        statusMessage.value = t(
            `已打开文件夹；${formatIndexRefresh([folder.index])}`,
            `Folder opened; ${formatIndexRefresh([folder.index])}`,
        );
    });
}

function workspacePathKey(path: string) {
    return path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}
async function executeWorkspaceOperation(action: string, name: string) {
    const operation = workspaceOperation.value;
    if (!operation || workspaceOperationBusy.value) return;
    const join = (parent: string, child: string) =>
        parent.replace(/[\\/]+$/u, "") + "/" + child;
    const basename = (path: string) => path.split(/[\\/]/u).pop() ?? "";
    const parent = (path: string) => path.slice(0, path.length - basename(path).length);
    const creating = action.startsWith("create-");
    if (
        (creating || action === "rename") &&
        (!name.trim() || /[\\/:*?"<>|]/u.test(name) || [".", ".."].includes(name))
    ) {
        errorMessage.value = t("请输入有效的单个名称", "Enter a valid single name");
        return;
    }
    let target = action === "rename" ? join(parent(operation.path), name) : undefined;
    if (action === "move") {
        const selected = await open({
            directory: true,
            multiple: false,
            defaultPath: operation.root,
        });
        if (!selected || Array.isArray(selected)) return;
        target = join(selected, basename(operation.path));
    }
    if (
        action === "trash" &&
        !(await confirm(
            t(
                "将所选文件或文件夹移入系统回收站？",
                "Move the selected file or folder to system trash?",
            ),
            { title: t("移入回收站", "Move to trash"), kind: "warning" },
        ))
    )
        return;
    workspaceOperationBusy.value = true;
    editorRef.value?.cancelAi();
    try {
        const key = workspacePathKey(operation.path);
        const affected = documents.value.filter(
            (doc) =>
                doc.path &&
                (workspacePathKey(doc.path) === key ||
                    workspacePathKey(doc.path).startsWith(key + "/")),
        );
        if (!creating && action !== "reveal") {
            for (const doc of affected) {
                if (savingDocumentIds.has(doc.id))
                    throw new Error(t("请等待保存完成", "Wait for saving to finish"));
                if (doc.conflict)
                    throw new Error(
                        t(
                            "请先解决受影响文档的外部冲突",
                            "Resolve external conflicts in affected documents first",
                        ),
                    );
                if (doc.dirty) {
                    const decision = await requestLeaveDecision(doc.displayName);
                    if (decision === "cancel") return;
                    if (decision === "save" && !(await saveDocument(doc.id))) return;
                }
            }
            await session.refreshDiskState();
            if (affected.some((doc) => session.document(doc.id).conflict))
                throw new Error(
                    t(
                        "文件已发生外部更改，请先处理冲突",
                        "Files changed externally; resolve conflicts first",
                    ),
                );
        }
        const result = await invoke<string | null>("workspace_operation", {
            request: {
                ...operation,
                path: creating ? join(operation.path, name) : operation.path,
                target,
                action,
            },
        });
        if (action === "trash") {
            for (const doc of affected) {
                await session.closeDocument(doc.id, {
                    decide: async () => "discard",
                    save: saveDocument,
                });
                editorRef.value?.releaseDocument(doc.id);
            }
            for (const folder of [...session.folders.value]) {
                const folderKey = workspacePathKey(folder.path);
                if (folderKey === key || folderKey.startsWith(key + "/"))
                    await session.closeFolder(folder.path, closeActions);
            }
        } else if ((action === "move" || action === "rename") && result) {
            await session.relocatePaths(operation.path, result);
            for (const doc of affected) {
                editorRef.value?.releaseDocument(doc.id);
                await hydrateDocumentResources(session.document(doc.id));
            }
        }
        if (action === "move" || action === "rename" || action === "trash") {
            for (const recent of [...recentFiles.value]) {
                const recentKey = workspacePathKey(recent.path);
                if (recentKey !== key && !recentKey.startsWith(key + "/")) continue;
                await removeRecentFile(recent.path);
                if (result && action !== "trash")
                    await pushRecentFile(
                        result + recent.path.slice(operation.path.length),
                        recent.title,
                    );
            }
        }
        await session.refreshFolders();
        await session.persist();
        if (action === "create-file" && result) await openPath(result, true);
        workspaceOperation.value = null;
        statusMessage.value = t("文件操作完成", "File operation completed");
    } catch (error) {
        errorMessage.value = stringifyError(error);
    } finally {
        workspaceOperationBusy.value = false;
        void drainSystemOpen();
    }
}

async function refreshWorkspaceFolder(path: string) {
    await runAction(async () => {
        const report = await session.refreshFolder(path);
        statusMessage.value = report
            ? formatIndexRefresh([report])
            : t("工作区刷新失败", "Failed to refresh workspace");
    });
}

function activateWorkspaceDocument(id: string) {
    if (compactLayout.value) compactPanel.value = null;
    return activateDocument(id);
}

async function activateDocument(id: string) {
    if (id === activeDocumentId.value) return;
    searchNavigationRequest++;
    editorRef.value?.cancelAi();
    session.activate(id);

    const targetDocument = session.document(id);
    await hydrateDocumentResources(targetDocument);

    if (activeDocumentId.value === id && targetDocument.conflict) {
        await resolveDocumentConflict(id);
    }
}

async function ensureSavedForExport(id: string): Promise<SessionDocument | null> {
    let target = documents.value.find((document) => document.id === id) ?? null;
    if (!target) return null;
    if (!target.path || target.dirty) {
        if (!(await saveDocument(id))) return null;
        target = documents.value.find((document) => document.id === id) ?? null;
    }
    return target?.path && !target.dirty ? target : null;
}

async function exportMarkdown() {
    const targetId = activeDocumentId.value;
    if (!targetId) return;
    const target = await ensureSavedForExport(targetId);
    if (!target?.path) return;
    const sourcePath = target.path;
    const exportTitle = documentNameFromPath(sourcePath).replace(
        /\.(?:md|markdown)$/iu,
        "",
    );
    const destination = await save({
        defaultPath: `${sanitizeFileName(exportTitle)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destination) return;
    await runAction(async () => {
        if (documentFormat(target) === "markdown") {
            const result = await invoke<MarkdownSaveResult>("save_markdown", {
                request: {
                    path: sourcePath,
                    title: exportTitle,
                    content: target.content,
                    meta: target.meta,
                    newAssets: [],
                    removedResources: [],
                    sourceFormat: "markdown",
                    overwrite: true,
                },
                path: destination,
            });
            statusMessage.value =
                result.warning ?? t("Markdown 导出成功", "Markdown exported");
        } else {
            await invoke("export_markdown", { sourcePath, destinationPath: destination });
            statusMessage.value = t("Markdown 导出成功", "Markdown exported");
        }
    });
}

async function exportDocument(format: DocumentExportFormat) {
    const target = activeDocument.value;
    const editor = editorRef.value;
    if (!target) return;

    const resourceSnapshot = target.resources.exportSnapshot();
    const snapshot = {
        documentId: target.id,
        title: target.path
            ? documentNameFromPath(target.path).replace(/\.(?:md|markdown)$/iu, "")
            : target.displayName,
        markdown: target.content,
        resources: resourceSnapshot.resources,
        resourceRevision: resourceSnapshot.revision,
    };
    const label = format === "docx" ? "Word" : "PDF";
    const extension = format === "docx" ? "docx" : "pdf";
    const filterName =
        format === "docx"
            ? t("Word 文档", "Word documents")
            : t("PDF 文档", "PDF documents");
    const snapshotIsCurrent = () => {
        const current = documents.value.find(
            (document) => document.id === snapshot.documentId,
        );
        return (
            activeDocumentId.value === snapshot.documentId &&
            current?.content === snapshot.markdown &&
            current.resources.resourceRevision() === snapshot.resourceRevision
        );
    };
    const cancelIfSnapshotChanged = () => {
        if (snapshotIsCurrent()) return false;
        statusMessage.value =
            activeDocumentId.value === snapshot.documentId
                ? t(
                      `${label} 导出已取消：文档内容已变更`,
                      `${label} export cancelled: document content changed`,
                  )
                : t(
                      `${label} 导出已取消：活动文档已切换`,
                      `${label} export cancelled: active document changed`,
                  );
        return true;
    };

    documentExportsInProgress.value += 1;
    errorMessage.value = "";
    try {
        const mermaidSources = await (editor?.captureMermaidSources() ??
            Promise.resolve([]));
        if (cancelIfSnapshotChanged()) return;
        const diagrams = await (editor?.getMermaidDiagrams(mermaidSources) ??
            Promise.resolve([]));
        if (cancelIfSnapshotChanged()) return;
        const destination = await save({
            defaultPath: `${sanitizeFileName(snapshot.title)}.${extension}`,
            filters: [{ name: filterName, extensions: [extension] }],
        });
        if (!destination) return;
        if (cancelIfSnapshotChanged()) return;

        const request = await prepareDocumentExportRequest({
            destinationPath: destination,
            title: snapshot.title,
            markdown: snapshot.markdown,
            resources: snapshot.resources,
            diagrams,
            format,
        });
        if (cancelIfSnapshotChanged()) return;
        await invoke("export_document", { request });
        statusMessage.value = t(`${label} 导出成功`, `${label} exported`);
    } catch (error) {
        errorMessage.value = stringifyError(error);
        statusMessage.value = t(`${label} 导出失败`, `Failed to export ${label}`);
    } finally {
        documentExportsInProgress.value -= 1;
    }
}

async function printDocument() {
    if (printing.value) return;
    const targetId = activeDocumentId.value;
    if (!targetId) return;

    printing.value = true;
    errorMessage.value = "";
    let printTitleApplied = false;
    const previousMode = editorMode.value;
    const previousSourcePreview = sourcePreview.value;
    try {
        const target = await ensureSavedForExport(targetId);
        if (!target) return;
        if (activeDocumentId.value !== targetId) {
            statusMessage.value = t(
                "PDF 导出已取消：活动文档已切换",
                "PDF export cancelled: active document changed",
            );
            return;
        }
        const printTitle = target.path
            ? documentNameFromPath(target.path)
            : target.displayName;
        editorMode.value = "wysiwyg";
        await nextTick();
        await (editorRef.value?.whenReady() ?? Promise.resolve());
        await (editorRef.value?.whenSettled() ?? Promise.resolve());
        if (activeDocumentId.value !== targetId) {
            statusMessage.value = t(
                "PDF 导出已取消：活动文档已切换",
                "PDF export cancelled: active document changed",
            );
            return;
        }
        statusMessage.value = t(
            "已打开系统打印对话框，可选择另存为 PDF",
            "Print dialog opened; choose Save as PDF",
        );
        document.title = printTitle;
        printTitleApplied = true;
        window.print();
    } catch (error) {
        errorMessage.value = stringifyError(error);
        statusMessage.value = t("PDF 导出失败", "Failed to export PDF");
    } finally {
        if (printTitleApplied) document.title = windowTitle.value;
        editorMode.value = previousMode;
        sourcePreview.value = previousSourcePreview;
        await nextTick();
        printing.value = false;
    }
}

async function saveNote() {
    const active = activeDocument.value;
    if (active) await saveDocument(active.id);
}

async function saveNoteAs(format?: DocumentFormat) {
    const active = activeDocument.value;
    if (active) await saveDocumentAs(active.id, format);
}

async function resolveDocumentConflict(id: string): Promise<boolean> {
    const target = documents.value.find((document) => document.id === id);
    if (!target?.conflict) return true;
    const decision = await requestConflictDecision(id);
    if (decision === "cancel") return false;
    if (decision === "overwrite") return saveDocument(id, true);
    if (decision === "save-as") return saveDocumentAs(id);

    let reloaded = false;
    await runAction(async () => {
        const runtime = await session.reloadFromDisk(id);
        await hydrateDocumentResources(runtime);
        reloaded = true;
        statusMessage.value = t("已重新加载磁盘版本", "Disk version reloaded");
    });
    if (reloaded) editorRef.value?.releaseDocument(id);
    return reloaded;
}

async function saveDocument(id: string, overwrite = false): Promise<boolean> {
    const runtime = session.document(id);
    if (!runtime.path) {
        return saveDocumentAs(id);
    }
    if (runtime.conflict && !overwrite) return resolveDocumentConflict(id);
    if (savingDocumentIds.has(id)) return false;
    let saved = false;
    savingDocumentIds.add(id);
    try {
        await runAction(async () => {
            const note = await session.save(id, { overwrite });
            if (note.path) await pushRecentFile(note.path, note.displayName);
            saved = !note.dirty;
            statusMessage.value = saved
                ? t("保存成功", "Saved")
                : t("保存期间文档已再次修改", "Document changed again while saving");
        });
    } finally {
        savingDocumentIds.delete(id);
    }
    if (!saved && !overwrite && session.document(id).conflict) {
        return resolveDocumentConflict(id);
    }
    return saved;
}

async function saveDocumentForAgent(id: string, baseLiveRevision: string) {
    if (workspaceOperationBusy.value) throw { code: "DOCUMENT_BUSY", documentId: id };
    const runtime = session.assertLiveRevision(id, baseLiveRevision);
    if (!runtime.path) {
        throw { code: "SAVE_AS_REQUIRED", documentId: id };
    }
    if (savingDocumentIds.has(id)) {
        throw { code: "DOCUMENT_BUSY", documentId: id };
    }
    savingDocumentIds.add(id);
    try {
        return await session.save(id, { expectedLiveRevision: baseLiveRevision });
    } finally {
        savingDocumentIds.delete(id);
    }
}

async function saveDocumentAs(id: string, format?: DocumentFormat) {
    if (savingDocumentIds.has(id)) return false;
    savingDocumentIds.add(id);
    try {
        const runtime = session.document(id);
        const currentFormat = documentFormat(runtime);
        const preferredFormat = format ?? currentFormat;
        const sourcePath = runtime.path ?? runtime.importSourcePath;
        const extension = preferredFormat === "markdown" ? ".md" : ".mdx";
        const defaultPath = sourcePath
            ? sourcePath.replace(/\.(?:mdx|md|markdown)$/iu, extension)
            : sanitizeFileName(runtime.displayName || UNNAMED_DOCUMENT_NAME) + extension;
        const formats = format
            ? [format]
            : [currentFormat, currentFormat === "mdx" ? "markdown" : "mdx"];
        const selected = await save({
            defaultPath,
            filters: formats.map((value) =>
                value === "markdown"
                    ? {
                          get name() {
                              return t("Markdown 文档", "Markdown documents");
                          },
                          extensions: ["md", "markdown"],
                      }
                    : {
                          get name() {
                              return t("墨笺 笔记", "Mora notes");
                          },
                          extensions: ["mdx"],
                      },
            ),
        });
        if (!selected) {
            statusMessage.value = "";
            return false;
        }
        const targetFormat =
            format ??
            (/\.(?:md|markdown)$/iu.test(selected)
                ? "markdown"
                : /\.mdx$/iu.test(selected)
                  ? "mdx"
                  : preferredFormat);
        let saved = false;
        await runAction(async () => {
            const note =
                targetFormat === "mdx" && currentFormat === "markdown" && sourcePath
                    ? await saveMarkdownImportAs(id, selected, sourcePath)
                    : await session.saveAs(id, selected, targetFormat);
            if (!note) return;
            if (note.path) await pushRecentFile(note.path, note.displayName);
            await hydrateDocumentResources(note);
            saved = !note.dirty;
            statusMessage.value = saved
                ? t("另存为成功", "Saved as")
                : t("另存为期间文档已再次修改", "Document changed again while saving as");
        });
        return saved;
    } finally {
        savingDocumentIds.delete(id);
    }
}

async function saveMarkdownImportAs(id: string, selected: string, sourcePath: string) {
    const runtime = session.document(id);
    const sourceContent = runtime.resources.persistedMarkdown(runtime.content);
    const resourceRevision = runtime.resources.resourceRevision();
    const pending = runtime.resources.newResources();
    const plan = await invoke<MarkdownResourcePlan>("prepare_markdown_resources", {
        sourcePath,
        markdown: sourceContent,
        newAssets: pending,
    });
    const stillCurrent = () =>
        documents.value.includes(runtime) &&
        runtime.resources.persistedMarkdown(runtime.content) === sourceContent &&
        runtime.resources.resourceRevision() === resourceRevision;
    if (!stillCurrent()) {
        statusMessage.value = t(
            "源文档已更改或关闭，请重新保存",
            "Source document changed or closed; save again",
        );
        return null;
    }
    if (plan.items.length > 0) {
        const decision = await requestMarkdownResourceDecision(runtime.displayName, plan);
        if (decision === "cancel") return null;
        if (!stillCurrent()) {
            statusMessage.value = t(
                "源文档已更改或关闭，请重新保存",
                "Source document changed or closed; save again",
            );
            return null;
        }
    }
    const resourceRewrites =
        plan.resourceRewrites ??
        Object.fromEntries(
            plan.items
                .filter(
                    (item): item is typeof item & { targetPath: string } =>
                        item.targetPath !== null,
                )
                .map((item) => [item.originalReference, item.targetPath]),
        );
    const resources = new Map(
        plan.resources.map((resource) => [resource.name, resource]),
    );
    for (const resource of pending) {
        const target = resourcePathKey(resourceRewrites[resource.name] ?? resource.name);
        if (!resources.has(target) && /^(?:assets|attachments)\/[^/]+$/u.test(target)) {
            resources.set(target, { ...resource, name: target });
        }
    }
    const packedNames = new Set([
        ...resources.keys(),
        ...Object.values(resourceRewrites),
        ...[...referencedLocalResourcePaths(plan.rewrittenContent)].filter((reference) =>
            resources.has(resourcePathKey(reference)),
        ),
    ]);
    const convertedContent = rebaseMarkdownReferences(
        plan.rewrittenContent,
        sourcePath,
        packedNames,
    );
    return session.saveAs(id, selected, "mdx", {
        content: convertedContent,
        resources: [...resources.values()],
        resourceRewrites,
        baseContent: sourceContent,
        resourceRevision,
    });
}

const closeActions = {
    decide: async (document: OpenDocument) => requestLeaveDecision(document.displayName),
    save: saveDocument,
};

async function checkForAppUpdate() {
    if (!updatesEnabled || appUpdater.busy.value) return;
    errorMessage.value = "";
    statusMessage.value = t("正在检查更新…", "Checking for updates…");
    const result = await appUpdater.checkForUpdate({ silent: false });
    if (result === "available") {
        showUpdateDialog.value = true;
        statusMessage.value = t(
            `发现新版本 ${appUpdater.version.value}`,
            `New version ${appUpdater.version.value} available`,
        );
    } else if (result === "current") {
        statusMessage.value = t("已是最新版", "You are up to date");
    } else if (result === "failed") {
        showUpdateDialog.value = true;
        errorMessage.value =
            appUpdater.error.value || t("检查更新失败", "Failed to check for updates");
    }
}

async function downloadAppUpdate() {
    errorMessage.value = "";
    const downloaded = await appUpdater.downloadUpdate();
    if (downloaded) statusMessage.value = t("更新下载完成", "Update downloaded");
    else
        errorMessage.value =
            appUpdater.error.value || t("更新下载失败", "Failed to download update");
}

let updateInstallInProgress = false;
async function installDownloadedUpdate() {
    if (updateInstallInProgress || appUpdater.phase.value !== "downloaded") return;
    updateInstallInProgress = true;
    try {
        const canRestart = await session.prepareWindowClose(closeActions);
        if (!canRestart) {
            statusMessage.value = "";
            return;
        }
        const installed = await appUpdater.installUpdate();
        if (!installed)
            errorMessage.value =
                appUpdater.error.value || t("更新安装失败", "Failed to install update");
    } catch (error) {
        errorMessage.value = t(
            `安装更新前处理失败：${stringifyError(error)}`,
            `Update preparation failed: ${stringifyError(error)}`,
        );
        statusMessage.value = t("更新安装已取消", "Update installation cancelled");
    } finally {
        updateInstallInProgress = false;
    }
}

async function retryAppUpdate() {
    appUpdater.clearError();
    if (appUpdater.phase.value === "available") {
        await downloadAppUpdate();
    } else if (appUpdater.phase.value === "downloaded") {
        await installDownloadedUpdate();
    } else {
        await checkForAppUpdate();
    }
}

function closeUpdateDialog() {
    if (!appUpdater.busy.value) showUpdateDialog.value = false;
}

async function focusWorkspaceTarget(id: string | null) {
    if (compactLayout.value) compactPanel.value = "workspace";
    else if (sidebarCollapsed.value) updateSidebarCollapsed(false);
    await nextTick();
    if (id) await workspaceSidebarRef.value?.focusDocument(id);
    else await workspaceSidebarRef.value?.focusFirstAvailable();
}

async function closeDocument(id: string) {
    if (savingDocumentIds.has(id)) {
        statusMessage.value = t(
            "请先完成当前保存操作",
            "Complete the current save operation first",
        );
        await focusWorkspaceTarget(id);
        return false;
    }
    editorRef.value?.cancelAi();
    const closed = await session.closeDocument(id, closeActions);
    if (closed) editorRef.value?.releaseDocument(id);
    const focusId = closed ? activeDocumentId.value : id;
    await focusWorkspaceTarget(focusId);
    return closed;
}

async function closeActiveDocument() {
    const id = activeDocumentId.value;
    if (id) await closeDocument(id);
}

async function closeFolder(path: string) {
    const savingDocumentInFolder = Array.from(savingDocumentIds).some((id) =>
        session.folderContainsDocument(path, id),
    );
    if (savingDocumentInFolder) {
        statusMessage.value = t(
            "请先完成当前保存操作",
            "Complete the current save operation first",
        );
        return;
    }

    await runAction(async () => {
        editorRef.value?.cancelAi();
        const before = new Set(documents.value.map((document) => document.id));
        const closed = await session.closeFolder(path, closeActions);
        if (!closed) return;
        const remaining = new Set(documents.value.map((document) => document.id));
        for (const id of before) {
            if (!remaining.has(id)) editorRef.value?.releaseDocument(id);
        }
        statusMessage.value = t("已关闭文件夹", "Folder closed");
    });
}

async function setEditorMode(mode: EditorMode) {
    editorMode.value = mode;
    if (mode === "source") sourcePreview.value = false;
    statusMessage.value =
        mode === "wysiwyg"
            ? t("已切换到所见即所得", "Switched to visual editor")
            : t("已切换到仅源码", "Switched to source only");
    await nextTick();
    editorRef.value?.focus();
}

async function setSourcePreview(visible: boolean) {
    editorMode.value = "source";
    sourcePreview.value = visible;
    statusMessage.value = visible
        ? t("已切换到垂直双栏", "Switched to source and preview")
        : t("已切换到仅源码", "Switched to source only");
    await nextTick();
    editorRef.value?.focus();
}
function focusEditor() {
    editorRef.value?.focus();
}

async function writeClipboardText(text: string) {
    if (!text || !navigator.clipboard?.writeText) {
        return false;
    }

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

async function copySelection() {
    const selectedText = editorRef.value?.getSelectedText() ?? "";
    if (await writeClipboardText(selectedText)) {
        statusMessage.value = t("已复制所选内容", "Selection copied");
    } else {
        statusMessage.value = t(
            "没有可复制的内容或剪贴板不可用",
            "Nothing to copy or clipboard unavailable",
        );
    }
}

async function cutSelection() {
    const selectedText = editorRef.value?.getSelectedText() ?? "";
    if (!selectedText) return;

    const copied = await writeClipboardText(selectedText);
    if (!copied || !editorRef.value) return;

    editorRef.value.replaceSelection("");
    focusEditor();
    statusMessage.value = t("已剪切所选内容", "Selection cut");
}

async function pasteClipboard() {
    if (!editorRef.value || !navigator.clipboard?.readText) return;

    try {
        const text = await navigator.clipboard.readText();
        if (!text) return;

        editorRef.value.replaceSelection(text);
        focusEditor();
        statusMessage.value = t("已粘贴剪贴板内容", "Clipboard content pasted");
    } catch {
        statusMessage.value = t(
            "当前环境不允许直接读取剪贴板",
            "Clipboard reading is unavailable in this environment",
        );
    }
}

function undoEdit() {
    runEditorCommand("undo");
}

function redoEdit() {
    runEditorCommand("redo");
}

function selectAllContent() {
    runEditorCommand("selectAll");
}

function findInDocument() {
    openFindPanel();
}

function replaceInDocument() {
    openReplacePanel();
}

function isHeadingLevel(value: unknown): value is 0 | 1 | 2 | 3 | 4 | 5 | 6 {
    return typeof value === "number" && [0, 1, 2, 3, 4, 5, 6].includes(value);
}

function toEditorCommand(
    name: string,
    payload?: Record<string, unknown>,
): EditorCommand | null {
    if (name === "heading") {
        const level = payload?.level;
        return isHeadingLevel(level) ? { name, level } : null;
    }

    switch (name) {
        case "undo":
        case "redo":
        case "selectAll":
        case "bold":
        case "italic":
        case "strike":
        case "code":
        case "blockQuote":
        case "bulletList":
        case "orderedList":
        case "taskList":
        case "indent":
        case "outdent":
        case "hr":
        case "codeBlock":
        case "table":
            return { name };
        default:
            return null;
    }
}

function runEditorCommand(name: string, payload?: Record<string, unknown>) {
    const command = toEditorCommand(name, payload);
    if (!command) return;

    editorRef.value?.execute(command);
    editorRef.value?.focus();
}

async function runMenuAction(action: () => void | Promise<void>) {
    closeMenus();
    await action();
}

function closeMenus(except?: HTMLDetailsElement) {
    document.querySelectorAll<HTMLDetailsElement>(".menu-group[open]").forEach((menu) => {
        if (menu !== except) {
            menu.open = false;
        }
    });
}

function handleMenuToggle(event: Event) {
    const currentMenu = event.currentTarget as HTMLDetailsElement;
    if (currentMenu.open) {
        closeMenus(currentMenu);
    }
}

function handleWindowPointerDown(event: PointerEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (!target.closest(".menu-group")) {
        closeMenus();
    }
    if (showThemePicker.value && !target.closest(".theme-picker")) {
        showThemePicker.value = false;
    }
}

function handleWindowKeyDown(event: KeyboardEvent) {
    if (
        workspaceOperationBusy.value &&
        (event.ctrlKey || event.metaKey || event.altKey)
    ) {
        event.preventDefault();
        return;
    }
    if (statusBarRef.value?.isDetailsOpen()) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "p") {
        event.preventDefault();
        openCommandPalette();
        return;
    }

    if (event.isComposing) return;

    if (event.key === "F3") {
        event.preventDefault();
        if (!showFindPanel.value) {
            openFindPanel();
            return;
        }

        navigateFindResult(event.shiftKey);
        return;
    }

    if (event.key === "Escape") {
        if (showThemePicker.value) {
            showThemePicker.value = false;
            return;
        }
        if (showFindPanel.value) {
            closeFindPanel();
            return;
        }

        closeMenus();
        return;
    }

    if (event.ctrlKey || event.metaKey) {
        const isEditorShortcut =
            event.target instanceof Element &&
            event.target.closest(".markdown-editor") !== null &&
            ((key === "l" && !event.shiftKey) ||
                (key === "t" && !event.shiftKey && !event.altKey));
        const isApplicationShortcut =
            key === "s" ||
            key === "n" ||
            key === "o" ||
            key === "w" ||
            key === "f" ||
            key === "," ||
            (event.shiftKey && (key === "b" || key === "j" || key === "t")) ||
            (key === "h" && !event.shiftKey);

        if (
            isTextInputTarget(event.target) &&
            !isApplicationShortcut &&
            !isEditorShortcut
        ) {
            return;
        }

        // File commands
        if (key === "o" && event.shiftKey) {
            event.preventDefault();
            void openFolder();
        } else if (key === "b" && event.shiftKey) {
            event.preventDefault();
            toggleWorkspacePanel();
        } else if (key === "j" && event.shiftKey) {
            event.preventDefault();
            toggleOutlinePanel();
        } else if (key === "t" && event.shiftKey) {
            event.preventDefault();
            showThemePicker.value = true;
        } else if (key === "," && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            void openSettingsPanel();
        } else if (key === "s") {
            event.preventDefault();
            if (event.shiftKey) saveNoteAs();
            else saveNote();
        } else if (key === "n") {
            event.preventDefault();
            createNewNote();
        } else if (key === "o" && !event.shiftKey) {
            event.preventDefault();
            openFiles();
        } else if (key === "w" && !event.shiftKey) {
            event.preventDefault();
            closeActiveDocument();
        } else if (key === "z" && !event.shiftKey) {
            event.preventDefault();
            undoEdit();
        } else if ((key === "y" && !event.shiftKey) || (key === "z" && event.shiftKey)) {
            event.preventDefault();
            redoEdit();
        } else if (key === "x" && !event.shiftKey) {
            event.preventDefault();
            void cutSelection();
        } else if (key === "c" && !event.shiftKey) {
            event.preventDefault();
            void copySelection();
        } else if (key === "v") {
            event.preventDefault();
            void pasteClipboard();
        } else if (key === "a") {
            event.preventDefault();
            selectAllContent();
        } else if (key === "f") {
            event.preventDefault();
            if (event.shiftKey) void openLibrary();
            else findInDocument();
        } else if (key === "h" && !event.shiftKey) {
            event.preventDefault();
            replaceInDocument();
        }

        // Format & Insert commands
        else if (key === "0") {
            event.preventDefault();
            runEditorCommand("heading", { level: 0 });
        } else if (key === "1") {
            event.preventDefault();
            runEditorCommand("heading", { level: 1 });
        } else if (key === "2") {
            event.preventDefault();
            runEditorCommand("heading", { level: 2 });
        } else if (key === "3") {
            event.preventDefault();
            runEditorCommand("heading", { level: 3 });
        } else if (key === "4") {
            event.preventDefault();
            runEditorCommand("heading", { level: 4 });
        } else if (key === "5") {
            event.preventDefault();
            runEditorCommand("heading", { level: 5 });
        } else if (key === "6") {
            event.preventDefault();
            runEditorCommand("heading", { level: 6 });
        } else if (key === "b" && !event.shiftKey) {
            event.preventDefault();
            runEditorCommand("bold");
        } else if (key === "i" && !event.shiftKey) {
            event.preventDefault();
            runEditorCommand("italic");
        } else if (key === "x" && event.shiftKey) {
            event.preventDefault();
            runEditorCommand("strike");
        } else if (key === "`") {
            event.preventDefault();
            runEditorCommand("code");
        } else if (key === "l" && event.altKey && !event.shiftKey) {
            event.preventDefault();
            runEditorCommand("orderedList");
        } else if (key === "l" && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            runEditorCommand("bulletList");
        } else if (key === "t" && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            runEditorCommand("taskList");
        } else if (key === "k") {
            event.preventDefault();
            insertLink();
        } else if (key === "i" && event.shiftKey) {
            event.preventDefault();
            insertImageReference();
        } else if (event.key === "Home") {
            event.preventDefault();
            editorRef.value?.moveCursor("start");
        } else if (event.key === "End") {
            event.preventDefault();
            editorRef.value?.moveCursor("end");
        }
    } else if (event.altKey) {
        const key = event.key;
        if (key === "1") {
            event.preventDefault();
            setEditorMode("wysiwyg");
        } else if (key === "2") {
            event.preventDefault();
            setSourcePreview(false);
        } else if (key === "3") {
            event.preventDefault();
            setSourcePreview(true);
        }
    }
}

function formatIndexRefresh(reports: WorkspaceIndexRefresh[]) {
    const totals = reports.reduce(
        (result, report) => ({
            indexed: result.indexed + report.indexed,
            removed: result.removed + report.removed,
            unchanged: result.unchanged + report.unchanged,
            failed: result.failed + report.failed.length,
        }),
        { indexed: 0, removed: 0, unchanged: 0, failed: 0 },
    );
    return t(
        `索引已刷新：更新 ${totals.indexed}，移除 ${totals.removed}，跳过 ${totals.unchanged}，失败 ${totals.failed}`,
        `Index refreshed: ${totals.indexed} updated, ${totals.removed} removed, ${totals.unchanged} skipped, ${totals.failed} failed`,
    );
}

async function loadLibraryEntries() {
    libraryNotes.value = await invoke<NoteListItem[]>("list_notes");
    const query = libraryQuery.value.trim();
    libraryResults.value = query
        ? await invoke<NoteSearchResult[]>("search_notes", { query })
        : [];
}

async function refreshLibrary() {
    libraryLoading.value = true;
    try {
        const reports = await session.refreshFolders();
        await loadLibraryEntries();
        statusMessage.value = formatIndexRefresh(reports);
    } finally {
        libraryLoading.value = false;
    }
}

async function runLibrarySearch() {
    const query = libraryQuery.value.trim();
    if (!query) {
        libraryResults.value = [];
        return;
    }
    libraryLoading.value = true;
    try {
        libraryResults.value = await invoke<NoteSearchResult[]>("search_notes", {
            query,
        });
    } finally {
        libraryLoading.value = false;
    }
}

async function openLibrary() {
    showLibrary.value = true;
    libraryLoading.value = true;
    try {
        await loadLibraryEntries();
    } finally {
        libraryLoading.value = false;
    }
}

let searchNavigationRequest = 0;
async function openLibraryNote(path: string, occurrence = 0) {
    const request = ++searchNavigationRequest;
    const query = libraryQuery.value.trim();
    showLibrary.value = false;
    let opened: SessionDocument;
    try {
        opened = await openPath(path, false);
    } catch (error) {
        errorMessage.value = stringifyError(error);
        return;
    }
    const id = opened.id;
    await nextTick();
    await editorRef.value?.whenReady();
    await editorRef.value?.whenSettled();
    if (
        request !== searchNavigationRequest ||
        activeDocumentId.value !== id ||
        workspacePathKey(activeDocument.value?.path ?? "") !== workspacePathKey(path)
    )
        return;
    if (query && !editorRef.value?.findText(query, occurrence))
        statusMessage.value = t(
            "当前正文中未找到匹配；索引可能已过期或命中标题/标签",
            "No match in current content; index may be stale or title/tags matched",
        );
}

async function refreshHistory() {
    const active = activeDocument.value;
    if (!active?.path || documentFormat(active) !== "mdx") {
        historyPreview.value = null;
        historySelected.value = "";
        historyItems.value = [];
        return;
    }
    const targetId = active.id;
    const targetPath = active.path;
    const requestId = ++historyRequestId;
    historyLoading.value = true;
    try {
        const items = await invoke<HistoryListItem[]>("list_history", {
            path: targetPath,
        });
        if (
            requestId === historyRequestId &&
            activeDocumentId.value === targetId &&
            session.document(targetId).path === targetPath
        ) {
            historyItems.value = items;
        }
    } finally {
        if (requestId === historyRequestId) historyLoading.value = false;
    }
}

async function openHistoryPanel() {
    if (activeDocumentFormat.value !== "mdx") return;
    if (!currentPath.value) {
        statusMessage.value = t(
            "请先保存笔记，再查看历史版本",
            "Save the note before viewing version history",
        );
        return;
    }
    showHistory.value = true;
    await refreshHistory();
}

async function previewHistory(name: string) {
    historyPreview.value = null;
    historySelected.value = name;
    const active = activeDocument.value;
    if (!active?.path) return;
    const id = active.id,
        path = active.path,
        request = ++historyRequestId;
    try {
        const snapshot = await invoke<HistorySnapshot>("read_history", { path, name });
        if (
            request === historyRequestId &&
            activeDocumentId.value === id &&
            activeDocument.value?.path === path &&
            showHistory.value
        )
            historyPreview.value = snapshot;
    } catch (error) {
        if (request === historyRequestId) errorMessage.value = stringifyError(error);
    }
}

async function restoreHistory(name: string) {
    if (!historyPreview.value || historySelected.value !== name) return;
    const active = activeDocument.value;
    if (!active?.path || documentFormat(active) !== "mdx") return;
    const targetId = active.id;
    const targetPath = active.path;
    const requestId = ++historyRequestId;
    await runAction(async () => {
        const snapshot = await invoke<HistorySnapshot>("read_history", {
            path: targetPath,
            name,
        });
        if (
            requestId !== historyRequestId ||
            activeDocumentId.value !== targetId ||
            session.document(targetId).path !== targetPath
        ) {
            return;
        }
        session
            .document(targetId)
            .resources.restoreReferences(
                new Set([
                    ...referencedResourcePaths(snapshot.content),
                    ...snapshot.meta.assets.map((item) => item.path),
                    ...snapshot.meta.attachments.map((item) => item.path),
                ]),
            );
        session.updateMetadata(targetId, snapshot.meta);
        session.updateContent(targetId, snapshot.content);
        await hydrateDocumentResources(session.document(targetId));
        showHistory.value = false;
        statusMessage.value = t(
            "已恢复历史版本，保存后生效",
            "Version restored; save to apply",
        );
    });
}

function registerResourceInSession(documentId: string, resource: ResourceSaveData) {
    const target = session.document(documentId);
    const blob = base64ToBlob(resource.base64, resource.mimeType);
    const objectUrl = URL.createObjectURL(blob);
    target.resources.registerNew({
        path: resource.name,
        originalName: resource.originalName,
        mimeType: resource.mimeType,
        size: resource.size,
        base64: resource.base64,
        objectUrl,
        kind: resource.kind,
        isNew: true,
    });
    return objectUrl;
}

function importedResourceToSession(documentId: string, resource: ResourceSaveData) {
    const objectUrl = registerResourceInSession(documentId, resource);
    insertMarkdownSnippet(
        resource.kind === "asset"
            ? `![${resource.originalName}](${objectUrl})`
            : `[${resource.originalName}](${objectUrl})`,
    );
}

function attachmentMetadata(resource: ResourceSaveData): ResourceMeta {
    return {
        id: crypto.randomUUID(),
        originalName: resource.originalName,
        storedName: resource.name.split("/").pop() ?? resource.name,
        path: resource.name,
        type: resource.mimeType,
        size: resource.size,
        createdAt: new Date().toISOString(),
    };
}

async function addAttachmentPaths(paths: string[], targetId: string | null) {
    if (!paths.length || !targetId) return;
    if (activeDocumentId.value !== targetId) {
        statusMessage.value = t(
            "附件添加已取消：活动文档已切换",
            "Attachment import cancelled: active document changed",
        );
        return;
    }
    await runAction(async () => {
        let addedCount = 0;
        let skippedImageCount = 0;
        for (const path of paths) {
            const resource = await invoke<ResourceSaveData>("import_resource", { path });
            if (activeDocumentId.value !== targetId) {
                statusMessage.value = t(
                    "附件添加已取消：活动文档已切换",
                    "Attachment import cancelled: active document changed",
                );
                return;
            }
            if (resource.kind !== "attachment") {
                skippedImageCount += 1;
                continue;
            }

            registerResourceInSession(targetId, resource);
            const target = session.document(targetId);
            const metadata = target.meta ?? createEmptyMetadata(target.displayName);
            session.updateMetadata(targetId, {
                ...metadata,
                attachments: [...metadata.attachments, attachmentMetadata(resource)],
            });
            if (documentFormat(target) === "markdown") {
                insertMarkdownSnippet(`[${resource.originalName}](${resource.name})`);
            }
            addedCount += 1;
        }
        statusMessage.value = `${t("已添加", "Added")} ${addedCount} ${t("个附件", "attachments")}${
            skippedImageCount
                ? t(
                      `，已跳过 ${skippedImageCount} 个图片`,
                      `, skipped ${skippedImageCount} images`,
                  )
                : ""
        }`;
    });
}

async function chooseAttachments() {
    const targetId = activeDocumentId.value;
    if (!targetId) return;
    const selected = await open({
        multiple: true,
        title: t("选择要添加的附件", "Choose attachments to add"),
    });
    if (!selected) return;
    await addAttachmentPaths(Array.isArray(selected) ? selected : [selected], targetId);
}

function insertAttachmentReference(path: string) {
    const attachment = activeDocument.value?.meta?.attachments.find(
        (item) => item.path === path,
    );
    if (!attachment) return;
    insertMarkdownSnippet(`[${attachment.originalName}](${attachment.path})`);
}

function renameAttachment(path: string, originalName: string) {
    const target = activeDocument.value;
    if (target && documentFormat(target) === "markdown") {
        statusMessage.value = t(
            "Markdown 外置资源请在文件夹中管理",
            "Manage external Markdown resources in their folder",
        );
        return;
    }
    if (!target?.meta || !target.meta.attachments.some((item) => item.path === path)) {
        return;
    }
    target.resources.rename(path, originalName);
    session.updateMetadata(target.id, {
        ...target.meta,
        attachments: target.meta.attachments.map((attachment) =>
            attachment.path === path ? { ...attachment, originalName } : attachment,
        ),
    });
    statusMessage.value = t(
        "已重命名附件，保存后生效",
        "Attachment renamed; save to apply",
    );
}

function removeAttachment(path: string) {
    const target = activeDocument.value;
    if (target && documentFormat(target) === "markdown") {
        statusMessage.value = t(
            "Markdown 外置资源请在文件夹中管理",
            "Manage external Markdown resources in their folder",
        );
        return;
    }
    if (!target?.meta || !target.meta.attachments.some((item) => item.path === path)) {
        return;
    }
    if (
        [...referencedLocalResourcePaths(target.content)].some(
            (reference) => resourcePathKey(reference) === resourcePathKey(path),
        )
    ) {
        statusMessage.value = t(
            "请先移除正文引用，再删除附件",
            "Remove references from the document before deleting this attachment",
        );
        return;
    }
    target.resources.remove(path);
    session.updateMetadata(target.id, {
        ...target.meta,
        attachments: target.meta.attachments.filter(
            (attachment) => attachment.path !== path,
        ),
    });
    statusMessage.value = t(
        "已删除附件，保存后生效",
        "Attachment removed; save to apply",
    );
}

async function attachmentReadRequest(
    documentId: string,
    resourcePath: string,
): Promise<AttachmentReadRequest | null> {
    const target = session.document(documentId);
    const attachment = target.meta?.attachments.find(
        (item) => item.path === resourcePath,
    );
    if (!attachment) return null;
    let pending = target.resources.resource(resourcePath);
    if (!pending && target.path && documentFormat(target) === "markdown") {
        const resource = await invoke<ResourceSaveData>("read_markdown_resource", {
            sourcePath: target.path,
            reference: resourcePath,
            ...(resourcePath.includes("&") ? { markdown: target.content } : {}),
        });
        const blob = base64ToBlob(resource.base64, resource.mimeType);
        target.resources.registerLoaded({
            path: resourcePath,
            originalName: resource.originalName,
            mimeType: resource.mimeType,
            size: resource.size,
            base64: resource.base64,
            kind: resource.kind,
            objectUrl: URL.createObjectURL(blob),
            isNew: false,
        });
        pending = resource;
    }
    return {
        documentId: target.meta?.id ?? target.id,
        sourcePath: pending ? null : target.path,
        resourcePath,
        originalName: attachment.originalName,
        base64: pending?.base64 ?? null,
    };
}

async function openAttachment(path: string) {
    const targetId = activeDocumentId.value;
    if (!targetId) return;
    attachmentBusyPath.value = path;
    try {
        await runAction(async () => {
            const request = await attachmentReadRequest(targetId, path);
            if (!request) return;
            await invoke("open_attachment", { request });
            if (activeDocumentId.value === targetId) {
                statusMessage.value = t(
                    `已打开附件：${request.originalName}`,
                    `Attachment opened: ${request.originalName}`,
                );
            }
        });
    } finally {
        if (attachmentBusyPath.value === path) attachmentBusyPath.value = null;
    }
}

async function exportAttachment(path: string) {
    const targetId = activeDocumentId.value;
    if (!targetId) return;
    attachmentBusyPath.value = path;
    try {
        await runAction(async () => {
            const request = await attachmentReadRequest(targetId, path);
            if (!request) return;
            const destinationPath = await save({
                title: t("附件另存为", "Save attachment as"),
                defaultPath: request.originalName,
            });
            if (!destinationPath) return;
            if (activeDocumentId.value !== targetId) {
                statusMessage.value = t(
                    "附件另存已取消：活动文档已切换",
                    "Attachment save cancelled: active document changed",
                );
                return;
            }
            await invoke("export_attachment", { request, destinationPath });
            if (activeDocumentId.value === targetId) {
                statusMessage.value = t(
                    `附件已另存为：${destinationPath}`,
                    `Attachment saved as: ${destinationPath}`,
                );
            }
        });
    } finally {
        if (attachmentBusyPath.value === path) attachmentBusyPath.value = null;
    }
}

async function importResourcePaths(paths: string[]) {
    const targetId = activeDocumentId.value;
    if (!paths.length || !targetId) return;
    await runAction(async () => {
        let importedCount = 0;
        for (const path of paths) {
            const resource = await invoke<ResourceSaveData>("import_resource", {
                path,
            });
            if (activeDocumentId.value !== targetId) {
                statusMessage.value = t(
                    "资源导入已取消：活动文档已切换",
                    "Resource import cancelled: active document changed",
                );
                return;
            }
            importedResourceToSession(targetId, resource);
            importedCount += 1;
        }
        statusMessage.value = t(
            `已导入 ${importedCount} 个资源`,
            `Imported ${importedCount} resources`,
        );
    });
}

async function chooseResources() {
    const selected = await open({
        multiple: true,
        title: t("选择要导入的图片或附件", "Choose images or attachments to import"),
    });
    if (!selected) return;
    await importResourcePaths(Array.isArray(selected) ? selected : [selected]);
}

function insertLink() {
    const selected = editorRef.value?.getSelectedText() || t("链接文字", "Link text");
    const text = prompt(t("链接文字", "Link text"), selected) || selected;
    const url = prompt(t("链接地址", "Link address"), "https://") || "";
    if (!url) return;

    insertMarkdownSnippet(`[${text}](${url})`);
}

function insertImageReference() {
    const alt =
        prompt(t("图片描述", "Image description"), t("图片", "Image")) ||
        t("图片", "Image");
    const path = prompt(t("图片路径", "Image path"), "assets/image.png") || "";
    if (!path) return;

    insertMarkdownSnippet(`![${alt}](${path})`);
}

function insertTable() {
    runEditorCommand("table");
}

function insertMarkdownSnippet(markdown: string) {
    if (!editorRef.value) return;

    editorRef.value.replaceSelection(markdown);
    editorRef.value.focus();
}

function sanitizeFileName(fileName: string) {
    const cleaned = fileName.trim().replace(/[\\/:*?"<>|]/g, "_");
    return cleaned || UNNAMED_DOCUMENT_NAME;
}

function stringifyError(error: unknown) {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
}
</script>

<template>
    <main class="app-shell">
        <nav
            class="menu-bar custom-titlebar"
            :aria-label="t('应用菜单', 'Application menu')"
        >
            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("文件", "File") }}</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in fileMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('file', item)"
                        @click="runMenuAction(item.action)"
                    >
                        <span>{{ item.label }}</span>
                        <span v-if="item.shortcut" class="shortcut">{{
                            item.shortcut
                        }}</span>
                    </button>

                    <div class="menu-divider" />
                    <div
                        class="menu-submenu"
                        :class="{ disabled: recentFiles.length === 0 }"
                    >
                        <button
                            type="button"
                            class="menu-submenu-trigger"
                            :disabled="recentFiles.length === 0"
                        >
                            <span>{{ t("最近打开", "Recent files") }}</span>
                            <span class="shortcut">&gt;</span>
                        </button>

                        <div
                            v-if="recentFiles.length > 0"
                            class="menu-popup menu-popup-submenu"
                        >
                            <button
                                v-for="item in recentOpenPaletteEntries"
                                :key="item.id"
                                type="button"
                                :data-recent-menu-path="item.path"
                                :title="item.shortcut"
                                :disabled="item.disabled"
                                @click="runMenuAction(item.action)"
                            >
                                <span>{{ item.label }}</span>
                                <span class="shortcut">{{ item.shortcut }}</span>
                            </button>
                            <div class="menu-divider" />
                            <button
                                v-for="item in recentUtilityPaletteEntries"
                                :key="item.id"
                                type="button"
                                :disabled="item.disabled"
                                @click="runMenuAction(item.action)"
                            >
                                <span>{{ item.label }}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </details>

            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("编辑", "Edit") }}</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in editMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('edit', item)"
                        @click="runMenuAction(item.action)"
                    >
                        <span>{{ item.label }}</span>
                        <span v-if="item.shortcut" class="shortcut">{{
                            item.shortcut
                        }}</span>
                    </button>
                </div>
            </details>

            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("格式", "Format") }}</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in formatMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('format', item)"
                        @click="runMenuAction(item.action)"
                    >
                        <span>{{ item.label }}</span>
                        <span v-if="item.shortcut" class="shortcut">{{
                            item.shortcut
                        }}</span>
                    </button>
                </div>
            </details>

            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("插入", "Insert") }}</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in insertMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('insert', item)"
                        @click="runMenuAction(item.action)"
                    >
                        <span>{{ item.label }}</span>
                        <span v-if="item.shortcut" class="shortcut">{{
                            item.shortcut
                        }}</span>
                    </button>
                </div>
            </details>

            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("视图", "View") }}</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in viewMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('view', item)"
                        @click="runMenuAction(item.action)"
                    >
                        <span>{{ item.label }}</span>
                        <span v-if="item.shortcut" class="shortcut">{{
                            item.shortcut
                        }}</span>
                    </button>
                </div>
            </details>

            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>{{ t("关于", "About") }}</summary>
                <div class="menu-popup about-popup">
                    <div class="about-card">
                        <strong>{{ APP_NAME }}</strong>
                        <p>{{ APP_TAGLINE }}</p>
                        <p>
                            {{
                                t(
                                    "本地优先的 Markdown 笔记编辑器，像 Word 一样单文件分享，像 Markdown 一样简洁书写。",
                                    "A local-first Markdown notebook. Share a single file like Word and write with the simplicity of Markdown.",
                                )
                            }}
                        </p>
                    </div>
                    <button
                        v-for="item in aboutMenu"
                        :key="item.id"
                        type="button"
                        :disabled="isMenuCommandDisabled('about', item)"
                        @click="runMenuAction(item.action)"
                    >
                        {{ item.label }}
                    </button>
                </div>
            </details>

            <div class="menu-document-name" :title="title" data-tauri-drag-region>
                {{ title }}
            </div>

            <span
                v-if="activeDocument"
                class="menu-document-format"
                :title="t('当前文档保存格式', 'Document save format')"
            >
                {{ activeDocumentFormat === "markdown" ? "Markdown" : "MDX" }}
            </span>

            <div
                v-if="!showSettings"
                class="mode-switch compact"
                :aria-label="t('编辑模式', 'Editor mode')"
            >
                <button
                    type="button"
                    :disabled="!activeDocument"
                    :class="{ active: editorMode === 'wysiwyg' }"
                    :aria-label="t('所见即所得', 'Visual editor')"
                    :title="t('所见即所得', 'Visual editor')"
                    @click="setEditorMode('wysiwyg')"
                >
                    <svg class="mode-switch-icon" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m10.7 2.3 3 3-7.9 7.9-3.5.5.5-3.5z" />
                        <path d="m9.6 3.4 3 3M2.8 10.2l3 3" />
                    </svg>
                </button>
                <button
                    type="button"
                    :disabled="!activeDocument"
                    :class="{
                        active: editorMode === 'source' && !sourcePreview,
                    }"
                    :aria-label="t('仅源码', 'Source only')"
                    :title="t('仅源码', 'Source only')"
                    @click="setSourcePreview(false)"
                >
                    <svg class="mode-switch-icon" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m5.5 3.5-4 4.5 4 4.5M10.5 3.5l4 4.5-4 4.5M9 2.5l-2 11" />
                    </svg>
                </button>
                <button
                    type="button"
                    :disabled="!activeDocument"
                    :class="{
                        active: editorMode === 'source' && sourcePreview,
                    }"
                    :aria-label="t('垂直双栏', 'Source and preview')"
                    :title="t('垂直双栏', 'Source and preview')"
                    @click="setSourcePreview(true)"
                >
                    <svg class="mode-switch-icon" viewBox="0 0 16 16" aria-hidden="true">
                        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
                        <path d="M8 2.5v11" />
                    </svg>
                </button>
            </div>
            <WindowControls v-if="tauriRuntime" />
        </nav>

        <div class="main-body">
            <div v-show="!showSettings" class="editor-workspace">
                <WorkspaceSidebar
                    ref="workspaceSidebarRef"
                    :documents="documents"
                    :folders="folders"
                    :active-document-id="activeDocumentId"
                    :expanded-paths="expandedPaths"
                    :visible="workspaceVisible"
                    :compact="compactLayout"
                    :width="sidebarWidth"
                    @manage="
                        (path, root, directory) =>
                            (workspaceOperation = { path, root, directory })
                    "
                    @activate="activateWorkspaceDocument"
                    @open-path="openWorkspacePath"
                    @open-file="openFiles"
                    @open-folder="openFolder"
                    @close-document="closeDocument"
                    @close-folder="closeFolder"
                    @refresh-folder="refreshWorkspaceFolder"
                    @toggle-expanded="toggleWorkspacePath"
                    @update:width="updateSidebarWidth"
                />

                <div class="workspace-center">
                    <section
                        v-if="activeDocument"
                        id="document-editor-panel"
                        class="note-panel"
                        role="region"
                        :aria-label="t('文档编辑区', 'Document editor')"
                        :aria-busy="loading"
                    >
                        <div class="editor-card">
                            <FindReplacePanel
                                ref="findPanel"
                                v-model:query="findQuery"
                                v-model:replacement="replaceQuery"
                                :open="showFindPanel"
                                :replace-open="showReplacePanel"
                                :match-count="findMatchCount"
                                @previous="navigateFindResult(true)"
                                @next="navigateFindResult(false)"
                                @expand="expandReplacePanel"
                                @close="closeFindPanel"
                                @replace-current="replaceCurrentMatch"
                                @replace-all="replaceAllMatches"
                            />
                            <div class="markdown-editor">
                                <MoraEditor
                                    ref="editorRef"
                                    :document-id="activeDocument.id"
                                    :model-value="content"
                                    :display-value="displayContent"
                                    :readonly="workspaceOperationBusy"
                                    :mode="editorMode"
                                    :source-preview="sourcePreview"
                                    :upload-image="registerPastedImage"
                                    :ai-provider="tauriRuntime ? aiProvider : undefined"
                                    @update:model-value="handleEditorUpdate"
                                    @ai-error="handleAiError"
                                    @open-mermaid="openMermaidViewer"
                                />
                            </div>
                        </div>
                    </section>
                    <section
                        v-else
                        class="workspace-welcome"
                        :aria-label="t('开始使用 墨笺', 'Welcome to Mora')"
                    >
                        <div class="workspace-welcome-card">
                            <p class="workspace-welcome-eyebrow">{{ APP_NAME }}</p>
                            <h1>{{ t("开始写作", "Start writing") }}</h1>
                            <p>
                                {{
                                    t(
                                        "新建一篇文档，或打开已有文件和工作区文件夹。",
                                        "Create a document, or open a file or workspace folder.",
                                    )
                                }}
                            </p>
                            <div class="workspace-welcome-actions">
                                <button
                                    type="button"
                                    class="primary"
                                    @click="createNewNote()"
                                >
                                    {{ t("新建文档", "New document") }}
                                </button>
                                <button type="button" @click="openFiles">
                                    {{ t("打开文件", "Open file") }}
                                </button>
                                <button type="button" @click="openFolder">
                                    {{ t("打开文件夹", "Open folder") }}
                                </button>
                            </div>
                        </div>
                    </section>
                </div>

                <TableOfContents
                    v-if="activeDocument"
                    :items="toc"
                    :visible="outlineVisible"
                    :compact="compactLayout"
                    @select="scrollToHeading"
                />
            </div>

            <SettingsPanel
                :open="showSettings"
                :preferences="preferences"
                :ai-key-configured="aiKeyConfigured"
                :ai-key-saving="aiKeySaving"
                :agent-status="agentStatus"
                :installed-font-families="installedFontFamilies"
                @close="closeSettingsPanel"
                @update="updatePreferences"
                @save-ai-key="saveAiApiKey"
                @delete-ai-key="deleteAiApiKey"
                @copy-agent-config="copyAgentConfig"
            />
        </div>
        <CommandPalette
            :open="showCommandPalette"
            :commands="paletteCommands"
            :restore-focus-on-close="restorePaletteFocus"
            @close="closeCommandPalette"
            @run="runPaletteCommand"
        />
        <WorkspaceOperations
            v-if="workspaceOperation"
            v-bind="workspaceOperation"
            :busy="workspaceOperationBusy"
            @close="workspaceOperation = null"
            @execute="executeWorkspaceOperation"
        />
        <HistoryPanel
            :open="showHistory"
            :snapshot="historyPreview"
            :selected="historySelected"
            :current-content="content"
            @preview="previewHistory"
            :items="historyItems"
            :loading="historyLoading"
            @close="showHistory = false"
            @refresh="refreshHistory"
            @restore="restoreHistory"
        />
        <AttachmentPanel
            :open="showAttachments"
            :document-name="title"
            :format="activeDocumentFormat"
            :items="attachmentItems"
            :busy-path="attachmentBusyPath"
            @close="showAttachments = false"
            @add="chooseAttachments"
            @insert-attachment="insertAttachmentReference"
            @open-attachment="openAttachment"
            @save-attachment="exportAttachment"
            @rename="renameAttachment"
            @remove="removeAttachment"
        />
        <LibraryPanel
            v-model:query="libraryQuery"
            :open="showLibrary"
            :notes="libraryNotes"
            :results="currentLibraryResults"
            :loading="libraryLoading"
            @close="showLibrary = false"
            @refresh="refreshLibrary"
            @search="runLibrarySearch"
            @open-note="openLibraryNote"
        />
        <RecentFilesDialog
            :open="showRecentFiles"
            :entries="recentFiles"
            @open-file="openRecentFile"
            @remove-file="removeRecentFile"
            @clear="clearRecentFiles"
            @close="showRecentFiles = false"
        />
        <MarkdownResourcesDialog
            :open="showMarkdownResourcesPrompt"
            :document-name="markdownResourcesDocumentName"
            :plan="markdownResourcesPlan"
            @decide="resolveMarkdownResourceDecision"
        />
        <LeaveConfirmDialog
            :open="showLeavePrompt"
            :document-name="leavePromptDocumentName"
            @decide="resolveLeaveDecision"
        />
        <ExternalConflictDialog
            :open="showConflictPrompt"
            :document-name="conflictPromptDocumentName"
            @decide="resolveConflictDecision"
        />
        <UpdateDialog
            :open="showUpdateDialog"
            :phase="appUpdater.phase.value"
            :version="appUpdater.version.value"
            :date="appUpdater.date.value"
            :notes="appUpdater.notes.value"
            :downloaded-bytes="appUpdater.downloadedBytes.value"
            :total-bytes="appUpdater.totalBytes.value"
            :error="appUpdater.error.value"
            @close="closeUpdateDialog"
            @download="downloadAppUpdate"
            @install="installDownloadedUpdate"
            @retry="retryAppUpdate"
        />
        <MermaidViewer
            :request="mermaidViewerRequest"
            :document-name="title"
            :exporting="mermaidExporting"
            :export-error="mermaidExportError"
            @close="closeMermaidViewer"
            @export="exportMermaidDiagram"
        />
        <ThemePicker
            v-if="showThemePicker"
            :theme="resolvedTheme"
            @select="selectTheme"
        />
        <StatusBar
            ref="statusBarRef"
            :error-message="errorMessage"
            :persistent-message="watcherStatusMessage"
            :status-message="statusMessage"
            :progress-message="progressMessage"
            :word-count="wordCount"
            :workspace-visible="workspaceVisible"
            :outline-visible="outlineVisible"
            :outline-available="outlineAvailable"
            @toggle-workspace="toggleWorkspacePanel"
            @toggle-outline="toggleOutlinePanel"
            @dismiss-message="dismissStatusMessage"
        />
    </main>
</template>

<style>
.leave-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(15, 23, 42, 0.38);
    backdrop-filter: blur(8px);
}

.leave-dialog {
    width: min(440px, 100%);
    padding: 24px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-bg-surface);
    box-shadow: var(--shadow-lg);
}

.leave-dialog h2 {
    margin: 0 0 8px;
    font-size: 20px;
}

.leave-dialog p {
    margin: 0;
    color: var(--color-text-muted);
    line-height: 1.6;
}

.leave-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 24px;
}

.leave-dialog-actions button {
    padding: 8px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-surface);
    color: var(--color-text-main);
    cursor: pointer;
}

.leave-dialog-actions .primary {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: white;
}

.leave-dialog-actions .danger {
    color: var(--color-danger);
}
</style>

<style>
@media print {
    .menu-bar,
    .workspace-sidebar,
    .toc-sidebar,
    .status-bar,
    .find-panel {
        display: none !important;
    }

    .app-shell,
    .main-body,
    .note-panel,
    .editor-card {
        display: block;
        height: auto;
        min-height: 0;
        overflow: visible;
        background: white;
    }

    .markdown-editor {
        position: static;
        height: auto;
    }

    .markdown-editor .mora-editor,
    .markdown-editor .milkdown-editor,
    .markdown-editor .milkdown,
    .markdown-editor .ProseMirror {
        height: auto !important;
        overflow: visible !important;
        border: 0 !important;
    }
}
</style>
