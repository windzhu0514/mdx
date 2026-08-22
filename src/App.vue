<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { setTheme } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./experience.css";
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
    sameResources,
    useDocumentSession,
    type OpenDocument,
    type SessionDocument,
} from "./composables/useDocumentSession";
import { useAppUpdater } from "./composables/useAppUpdater";
import { isDarkTheme, usePreferences, type ThemeId } from "./composables/usePreferences";
import type { HistoryListItem, HistorySnapshot } from "./types/history";
import type { NoteListItem, NoteSearchResult } from "./types/library";
import type { ResourceSaveData } from "./types/mdx";
import type { MarkdownResourcePlan, RecentFileEntry } from "./types/workspace";
import type { LeaveDecision } from "./utils/leaveGuard";
import { base64ToBlob } from "./utils/base64";
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

const APP_NAME = "Mora";
const APP_CN_NAME = "墨笺";
const APP_TAGLINE = "Mora 墨笺，一款所见即所得的 MDX 扩展笔记编辑器";
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
const title = computed(() => {
    void documents.value;
    const active = activeDocument.value;
    if (!active) return "未打开文档";
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
const dirty = computed(() => {
    void documents.value;
    return activeDocument.value?.dirty ?? false;
});
const loading = ref(false);
const statusMessage = ref("准备就绪");
const errorMessage = ref("");
const editorRef = ref<MoraEditorHandle | null>(null);
const workspaceSidebarRef = ref<WorkspaceSidebarHandle | null>(null);
const lastSearchQuery = ref("");
const findPanel = ref<InstanceType<typeof FindReplacePanel> | null>(null);

const editorMode = ref<EditorMode>("wysiwyg");
const sourcePreview = ref(true);
let printing = false;
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
const libraryLoading = ref(false);
const showHistory = ref(false);
const historyItems = ref<HistoryListItem[]>([]);
const historyLoading = ref(false);
let historyRequestId = 0;
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
            console.warn("同步原生窗口主题失败", error);
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
        showSettings.value ||
        showLeavePrompt.value ||
        showConflictPrompt.value ||
        showMarkdownResourcesPrompt.value ||
        showUpdateDialog.value ||
        mermaidViewerRequest.value !== null,
);
const savingDocumentIds = new Set<string>();
let unlistenClose: (() => void) | null = null;
let unlistenDragDrop: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let allowWindowClose = false;
let windowCloseInProgress = false;
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
            filters: [{ name: "PNG 图像", extensions: ["png"] }],
        });
        if (!path) return;
        const base64 = await svgToPngBase64(diagram.svg, resolvedTheme.value);
        await invoke("export_diagram_png", { path, base64 });
        statusMessage.value = "Mermaid 图表已导出";
    } catch (error) {
        mermaidExportError.value = stringifyError(error);
        statusMessage.value = "Mermaid 图表导出失败";
    } finally {
        mermaidExporting.value = false;
    }
}

async function registerPastedImage(file: File): Promise<string> {
    const active = activeDocument.value;
    if (!active) throw new Error("请先打开或新建文档");
    const extension = imageExtension(file.type);
    const filename = `assets/image-${crypto.randomUUID()}.${extension}`;
    const base64 = await blobToBase64(file);
    const objectUrl = URL.createObjectURL(file);
    active.resources.registerNew({
        path: filename,
        originalName: file.name || `图片.${extension}`,
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
        ? `${dirty.value ? "* " : ""}${title.value} - ${APP_NAME}`
        : `${APP_NAME} ${APP_CN_NAME}`,
);
const displayPath = computed(() =>
    activeDocument.value ? currentPath.value || "尚未保存" : "未打开文档",
);
const modeLabel = computed(() => {
    if (editorMode.value === "wysiwyg") return "所见即所得";
    return sourcePreview.value ? "垂直双栏" : "仅源码";
});

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
    statusMessage.value = visible ? "已显示目录" : "已隐藏目录";
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
        console.warn("保存工作区布局失败", error);
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
    { id: "file.new", label: "新建", shortcut: "Ctrl+N", action: createNewNote },
    { id: "file.open", label: "打开文件", shortcut: "Ctrl+O", action: openFiles },
    {
        id: "file.open-folder",
        label: "打开文件夹",
        shortcut: "Ctrl+Shift+O",
        action: openFolder,
    },
    {
        id: "file.close",
        label: "关闭当前文档",
        shortcut: "Ctrl+W",
        action: closeActiveDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "file.save",
        label: "保存",
        shortcut: "Ctrl+S",
        action: saveNote,
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.save-as",
        label: "另存为",
        shortcut: "Ctrl+Shift+S",
        action: saveNoteAs,
        disabled: loading.value || !activeDocument.value,
    },
    {
        id: "file.history",
        label: "历史版本",
        action: openHistoryPanel,
        disabled: !activeDocument.value,
    },
    {
        id: "file.export-markdown",
        label: "导出 Markdown",
        action: exportMarkdown,
        disabled: !activeDocument.value,
    },
    {
        id: "file.export-word",
        label: "导出 Word",
        action: () => exportDocument("docx"),
        disabled: !activeDocument.value,
    },
    {
        id: "file.export-pdf",
        label: "导出 PDF",
        action: () => exportDocument("pdf"),
        disabled: !activeDocument.value,
    },
    {
        id: "file.print",
        label: "打印",
        action: printDocument,
        disabled: !activeDocument.value,
    },
]);

const editMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "edit.undo",
        label: "撤销",
        shortcut: "Ctrl+Z",
        action: undoEdit,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.redo",
        label: "重做",
        shortcut: "Ctrl+Y",
        action: redoEdit,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.cut",
        label: "剪切",
        shortcut: "Ctrl+X",
        action: cutSelection,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.copy",
        label: "复制",
        shortcut: "Ctrl+C",
        action: copySelection,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.paste",
        label: "粘贴",
        shortcut: "Ctrl+V",
        action: pasteClipboard,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.select-all",
        label: "全选",
        shortcut: "Ctrl+A",
        action: selectAllContent,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.find",
        label: "查找",
        shortcut: "Ctrl+F",
        action: findInDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.workspace-search",
        label: "工作区查找",
        shortcut: "Ctrl+Shift+F",
        action: openLibrary,
    },
    {
        id: "edit.replace",
        label: "替换",
        shortcut: "Ctrl+H",
        action: replaceInDocument,
        disabled: !activeDocument.value,
    },
    {
        id: "edit.settings",
        label: "偏好设置",
        shortcut: "Ctrl+,",
        action: openSettingsPanel,
    },
]);

const formatMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "format.paragraph",
        label: "段落",
        shortcut: "Ctrl+0",
        action: () => runEditorCommand("heading", { level: 0 }),
    },
    {
        id: "format.heading-1",
        label: "一级标题",
        shortcut: "Ctrl+1",
        action: () => runEditorCommand("heading", { level: 1 }),
    },
    {
        id: "format.heading-2",
        label: "二级标题",
        shortcut: "Ctrl+2",
        action: () => runEditorCommand("heading", { level: 2 }),
    },
    {
        id: "format.heading-3",
        label: "三级标题",
        shortcut: "Ctrl+3",
        action: () => runEditorCommand("heading", { level: 3 }),
    },
    {
        id: "format.heading-4",
        label: "四级标题",
        shortcut: "Ctrl+4",
        action: () => runEditorCommand("heading", { level: 4 }),
    },
    {
        id: "format.heading-5",
        label: "五级标题",
        shortcut: "Ctrl+5",
        action: () => runEditorCommand("heading", { level: 5 }),
    },
    {
        id: "format.heading-6",
        label: "六级标题",
        shortcut: "Ctrl+6",
        action: () => runEditorCommand("heading", { level: 6 }),
    },
    {
        id: "format.bold",
        label: "加粗",
        shortcut: "Ctrl+B",
        action: () => runEditorCommand("bold"),
    },
    {
        id: "format.italic",
        label: "斜体",
        shortcut: "Ctrl+I",
        action: () => runEditorCommand("italic"),
    },
    {
        id: "format.strike",
        label: "删除线",
        shortcut: "Ctrl+Shift+X",
        action: () => runEditorCommand("strike"),
    },
    {
        id: "format.code",
        label: "行内代码",
        shortcut: "Ctrl+`",
        action: () => runEditorCommand("code"),
    },
]);

const insertMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "insert.block-quote",
        label: "引用块",
        action: () => runEditorCommand("blockQuote"),
    },
    {
        id: "insert.bullet-list",
        label: "无序列表",
        shortcut: "Ctrl+L",
        action: () => runEditorCommand("bulletList"),
    },
    {
        id: "insert.ordered-list",
        label: "有序列表",
        shortcut: "Ctrl+Alt+L",
        action: () => runEditorCommand("orderedList"),
    },
    {
        id: "insert.task-list",
        label: "任务列表",
        shortcut: "Ctrl+T",
        action: () => runEditorCommand("taskList"),
    },
    {
        id: "insert.indent",
        label: "增加缩进",
        shortcut: "Tab",
        action: () => runEditorCommand("indent"),
    },
    {
        id: "insert.outdent",
        label: "减少缩进",
        shortcut: "Shift+Tab",
        action: () => runEditorCommand("outdent"),
    },
    {
        id: "insert.hr",
        label: "分割线",
        action: () => runEditorCommand("hr"),
    },
    {
        id: "insert.code-block",
        label: "代码块",
        action: () => runEditorCommand("codeBlock"),
    },
    { id: "insert.link", label: "链接", shortcut: "Ctrl+K", action: insertLink },
    {
        id: "insert.image-reference",
        label: "图片引用",
        shortcut: "Ctrl+Shift+I",
        action: insertImageReference,
    },
    { id: "insert.resource", label: "导入图片或附件", action: chooseResources },
    { id: "insert.table", label: "表格", action: insertTable },
]);

const viewMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "view.wysiwyg",
        label: "所见即所得",
        shortcut: "Alt+1",
        action: () => setEditorMode("wysiwyg"),
        disabled: !activeDocument.value,
    },
    {
        id: "view.source",
        label: "仅源码",
        shortcut: "Alt+2",
        action: () => setSourcePreview(false),
        disabled: !activeDocument.value,
    },
    {
        id: "view.split",
        label: "垂直双栏",
        shortcut: "Alt+3",
        action: () => setSourcePreview(true),
        disabled: !activeDocument.value,
    },
    {
        id: "view.toggle-workspace",
        label: "工作区",
        shortcut: "Ctrl+Shift+B",
        action: toggleWorkspacePanel,
    },
    {
        id: "view.toggle-outline",
        label: "目录",
        shortcut: "Ctrl+Shift+J",
        action: toggleOutlinePanel,
        disabled: !outlineAvailable.value,
    },
    {
        id: "view.theme",
        label: "主题",
        shortcut: "Ctrl+Shift+T",
        action: () => {
            showThemePicker.value = true;
        },
    },
]);

const aboutMenu = computed<MarkdownCommand[]>(() => [
    {
        id: "about.check-updates",
        label: "检查更新",
        action: checkForAppUpdate,
        disabled: !updatesEnabled || appUpdater.busy.value,
    },
    { id: "about.app", label: `关于 ${APP_NAME} ${APP_CN_NAME}`, action: showAbout },
]);

type MenuGroupId = "file" | "edit" | "format" | "insert" | "view" | "about";
type PaletteEntry = CommandPaletteCommand & { action: MarkdownCommand["action"] };
type RecentOpenPaletteEntry = PaletteEntry & { path: string };

function isMenuCommandDisabled(groupId: MenuGroupId, command: MarkdownCommand): boolean {
    return (
        Boolean(command.disabled) ||
        ((groupId === "format" || groupId === "insert") && !activeDocument.value)
    );
}

const paletteEntries = computed<PaletteEntry[]>(() =>
    (
        [
            ["file", "文件", fileMenu.value],
            ["edit", "编辑", editMenu.value],
            ["format", "格式", formatMenu.value],
            ["insert", "插入", insertMenu.value],
            ["view", "视图", viewMenu.value],
            ["about", "关于", aboutMenu.value],
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
        category: "最近打开",
        label: formatRecentFileLabel(item),
        shortcut: item.path,
        disabled: false,
        path: item.path,
        action: () => openRecentFile(item.path),
    })),
);

const recentUtilityPaletteEntries = computed<PaletteEntry[]>(() => [
    {
        id: "recent.show-all",
        category: "最近打开",
        label: "查看全部……",
        disabled: recentFiles.value.length === 0,
        action: showAllRecentFiles,
    },
    {
        id: "recent.clear",
        category: "最近打开",
        label: "清空最近打开",
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

watch(activeDocumentId, (current, previous) => {
    if (current === previous) return;
    historyRequestId += 1;
    showHistory.value = false;
    historyItems.value = [];
    historyLoading.value = false;
});

watch(
    windowTitle,
    (value) => {
        document.title = value;
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
        console.warn("读取 AI API Key 状态失败", error);
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
        console.warn("读取系统字体列表失败", error);
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
        statusMessage.value = "AI API Key 已保存";
    } catch (error) {
        errorMessage.value = `AI API Key 保存失败：${stringifyError(error)}`;
        statusMessage.value = "AI API Key 保存失败";
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
        statusMessage.value = "AI API Key 已删除";
    } catch (error) {
        errorMessage.value = `AI API Key 删除失败：${stringifyError(error)}`;
        statusMessage.value = "AI API Key 删除失败";
    } finally {
        aiKeySaving.value = false;
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

    try {
        await session.restore();
        const restored = activeDocument.value;
        if (restored) await hydrateDocumentResources(restored);
        if (session.warnings.value.length > 0) {
            errorMessage.value = session.warnings.value.join("\n");
            statusMessage.value = "工作区已部分恢复";
        }
    } catch (error) {
        errorMessage.value = `恢复工作区失败：${stringifyError(error)}`;
        statusMessage.value = "工作区恢复失败";
    }

    await refreshAiKeyConfigured();

    const appWindow = getCurrentWindow();
    unlistenFocus = await appWindow.onFocusChanged(async (event) => {
        if (!event.payload) return;
        await session.refreshFolders();
        const reloadedIds = await session.refreshDiskState();
        for (const id of reloadedIds) editorRef.value?.releaseDocument(id);
        const activeId = activeDocumentId.value;
        if (activeId && session.document(activeId).conflict) {
            await resolveDocumentConflict(activeId);
        }
    });
    unlistenDragDrop = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        await importResourcePaths(event.payload.paths);
    });
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
        if (savingDocumentIds.size > 0) {
            event.preventDefault();
            statusMessage.value = "请先完成当前保存操作";
            return;
        }
        if (allowWindowClose || !documents.value.some((document) => document.dirty)) {
            return;
        }
        event.preventDefault();
        if (windowCloseInProgress) return;
        windowCloseInProgress = true;
        try {
            if (await session.prepareWindowClose(closeActions)) {
                allowWindowClose = true;
                await appWindow.close();
            }
        } catch (error) {
            errorMessage.value = `关闭前处理失败：${stringifyError(error)}`;
            statusMessage.value = "窗口关闭已取消";
        } finally {
            windowCloseInProgress = false;
        }
    });

    await loadRecentFiles();
    void appUpdater.checkForUpdate({ silent: true }).then((result) => {
        if (result === "available") showUpdateDialog.value = true;
    });
});

onBeforeUnmount(() => {
    window.removeEventListener("pointerdown", handleWindowPointerDown, true);
    window.removeEventListener("keydown", handleWindowKeyDown);
    compactMedia?.removeEventListener("change", syncCompactLayout);
    unlistenClose?.();
    unlistenDragDrop?.();
    unlistenFocus?.();
    disposePreferences();
    void session.dispose().catch((error: unknown) => {
        console.warn("释放文档会话失败", error);
    });
});

function handleEditorUpdate(markdown: string) {
    if (printing) return;
    const active = activeDocument.value;
    if (!active) return;
    const persistedContent = active.resources.persistedMarkdown(markdown);
    if (persistedContent === content.value) return;

    session.updateContent(active.id, persistedContent);
}

function handleAiError(message: string) {
    const needsSettings = /Base URL|模型|API Key/i.test(message);
    const detail = needsSettings ? `${message}，请在偏好设置中完成 AI 配置` : message;
    errorMessage.value = `AI 生成失败：${detail}`;
    statusMessage.value = "AI 生成失败";
}

async function hydrateDocumentResources(runtime: SessionDocument) {
    const persistedContent = runtime.content;
    if (runtime.path && runtime.meta) {
        const assetRegex =
            /\]\(((?:assets|attachments)\/[^)]+)\)|(?:src|href)=["']((?:assets|attachments)\/[^"']+)["']/g;
        const assetPaths = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = assetRegex.exec(persistedContent)) !== null) {
            assetPaths.add(match[1] || match[2]);
        }

        for (const assetPath of assetPaths) {
            try {
                if (runtime.resources.objectUrls().has(assetPath)) continue;
                const base64 = await invoke<string>("read_asset", {
                    path: runtime.path,
                    assetName: assetPath,
                });
                const resourceMeta = [
                    ...runtime.meta.assets,
                    ...runtime.meta.attachments,
                ].find((resource) => resource.path === assetPath);
                const mimeType = resourceMeta?.type || "application/octet-stream";
                const blob = base64ToBlob(base64, mimeType);
                const objectUrl = URL.createObjectURL(blob);
                runtime.resources.registerLoaded({
                    path: assetPath,
                    originalName:
                        resourceMeta?.originalName ||
                        assetPath.split("/").pop() ||
                        "图片",
                    mimeType,
                    size: resourceMeta?.size || blob.size,
                    base64,
                    objectUrl,
                    kind: assetPath.startsWith("assets/") ? "asset" : "attachment",
                    isNew: false,
                });
            } catch (error) {
                console.warn("加载资源失败", assetPath, error);
            }
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
        statusMessage.value = "操作失败";
    } finally {
        loading.value = false;
    }
}

function createNewNote() {
    editorRef.value?.cancelAi();
    session.newDocument();
    errorMessage.value = "";
    statusMessage.value = "已新建文档";
}

async function loadRecentFiles() {
    try {
        recentFiles.value = await invoke<RecentFileEntry[]>("get_recent_files");
    } catch (error) {
        console.warn("读取最近打开列表失败", error);
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
    statusMessage.value = "已清空最近打开列表";
}

function formatRecentFileLabel(entry: RecentFileEntry) {
    return entry.title.trim() || entry.path.split(/[\\/]/).pop() || "未命名笔记";
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
    statusMessage.value = "已打开查找面板";
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

    statusMessage.value = "已打开替换面板";
}

function closeFindPanel() {
    showFindPanel.value = false;
    showReplacePanel.value = false;
    focusEditor();
}

function ensureFindQuery() {
    const query = findQuery.value.trim();
    if (!query) {
        statusMessage.value = "请输入要查找的内容";
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
        statusMessage.value = "当前环境不支持查找定位";
        return false;
    }

    focusEditor();
    return browserFind(query, true, backward, true, false, false, false);
}

function navigateFindResult(backward = false) {
    const query = ensureFindQuery();
    if (!query) return;

    const found = runBrowserFind(query, backward);
    statusMessage.value = found ? `已定位到“${query}”` : `未找到“${query}”`;
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
            statusMessage.value = `未定位到“${query}”`;
            return;
        }
    }

    editorRef.value.replaceSelection(replaceQuery.value);
    statusMessage.value = `已替换当前“${query}”`;
    navigateFindResult(false);
}

function replaceAllMatches() {
    const query = ensureFindQuery();
    if (!query) return;

    const matchCount = countOccurrences(content.value, query);
    if (matchCount === 0) {
        statusMessage.value = `未找到“${query}”`;
        return;
    }

    content.value = content.value.split(query).join(replaceQuery.value);
    statusMessage.value = `已替换 ${matchCount} 处“${query}”`;
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
    statusMessage.value = "已打开文档";
    return runtime;
}

async function openFiles() {
    const selected = await open({
        multiple: true,
        filters: [
            {
                name: "Mora 与 Markdown 文档",
                extensions: ["mdx", "md", "markdown"],
            },
        ],
    });
    if (!selected) {
        statusMessage.value = "已取消打开";
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
            statusMessage.value = openedCount > 0 ? "部分文件打开失败" : "打开文件失败";
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
        statusMessage.value = "已取消打开文件夹";
        return;
    }
    await runAction(async () => {
        await session.openFolder(selected);
        if (compactLayout.value) compactPanel.value = "workspace";
        else updateSidebarCollapsed(false);
        statusMessage.value = "已打开文件夹";
    });
}

function activateWorkspaceDocument(id: string) {
    if (compactLayout.value) compactPanel.value = null;
    return activateDocument(id);
}

async function activateDocument(id: string) {
    if (id === activeDocumentId.value) return;
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
    const exportTitle = documentNameFromPath(sourcePath);
    const destination = await save({
        defaultPath: `${sanitizeFileName(exportTitle)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destination) return;
    await runAction(async () => {
        await invoke("export_markdown", {
            sourcePath,
            destinationPath: destination,
        });
        statusMessage.value = "Markdown 导出成功";
    });
}

async function exportDocument(format: DocumentExportFormat) {
    const target = activeDocument.value;
    const editor = editorRef.value;
    if (!target) return;

    const resourceSnapshot = target.resources.exportSnapshot();
    const snapshot = {
        documentId: target.id,
        title: target.path ? documentNameFromPath(target.path) : target.displayName,
        markdown: target.content,
        resources: resourceSnapshot.resources,
        resourceRevision: resourceSnapshot.revision,
    };
    const label = format === "docx" ? "Word" : "PDF";
    const extension = format === "docx" ? "docx" : "pdf";
    const filterName = format === "docx" ? "Word 文档" : "PDF 文档";
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
                ? `${label} 导出已取消：文档内容已变更`
                : `${label} 导出已取消：活动文档已切换`;
        return true;
    };

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
        statusMessage.value = `${label} 导出成功`;
    } catch (error) {
        errorMessage.value = stringifyError(error);
        statusMessage.value = `${label} 导出失败`;
    }
}

async function printDocument() {
    if (printing) return;
    const targetId = activeDocumentId.value;
    if (!targetId) return;

    printing = true;
    let printTitleApplied = false;
    const previousMode = editorMode.value;
    const previousSourcePreview = sourcePreview.value;
    try {
        const target = await ensureSavedForExport(targetId);
        if (!target) return;
        if (activeDocumentId.value !== targetId) {
            statusMessage.value = "PDF 导出已取消：活动文档已切换";
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
            statusMessage.value = "PDF 导出已取消：活动文档已切换";
            return;
        }
        statusMessage.value = "已打开系统打印对话框，可选择另存为 PDF";
        document.title = printTitle;
        printTitleApplied = true;
        window.print();
    } catch (error) {
        errorMessage.value = stringifyError(error);
        statusMessage.value = "PDF 导出失败";
    } finally {
        if (printTitleApplied) document.title = windowTitle.value;
        editorMode.value = previousMode;
        sourcePreview.value = previousSourcePreview;
        await nextTick();
        printing = false;
    }
}

async function saveNote() {
    const active = activeDocument.value;
    if (active) await saveDocument(active.id);
}

async function saveNoteAs() {
    const active = activeDocument.value;
    if (active) await saveDocumentAs(active.id);
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
        statusMessage.value = "已重新加载磁盘版本";
    });
    if (reloaded) editorRef.value?.releaseDocument(id);
    return reloaded;
}

async function saveDocument(id: string, overwrite = false): Promise<boolean> {
    const runtime = session.document(id);
    if (runtime.sourceKind === "markdown-import" || !runtime.path) {
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
            statusMessage.value = saved ? "保存成功" : "保存期间文档已再次修改";
        });
    } finally {
        savingDocumentIds.delete(id);
    }
    if (!saved && !overwrite && session.document(id).conflict) {
        return resolveDocumentConflict(id);
    }
    return saved;
}

async function saveDocumentAs(id: string) {
    if (savingDocumentIds.has(id)) return false;
    savingDocumentIds.add(id);
    try {
        const runtime = session.document(id);
        const defaultPath = runtime.importSourcePath
            ? runtime.importSourcePath.replace(/\.(?:md|markdown)$/iu, ".mdx")
            : `${sanitizeFileName(runtime.displayName || UNNAMED_DOCUMENT_NAME)}.mdx`;
        const selected = await save({
            defaultPath,
            filters: [{ name: "Mora 墨笺笔记", extensions: ["mdx"] }],
        });
        if (!selected) {
            statusMessage.value = "已取消保存";
            return false;
        }

        let saved = false;
        await runAction(async () => {
            const note =
                runtime.sourceKind === "markdown-import" && runtime.importSourcePath
                    ? await saveMarkdownImportAs(id, selected, runtime.importSourcePath)
                    : await session.saveAs(id, selected);
            if (!note) {
                return;
            }
            if (note.path) await pushRecentFile(note.path, note.displayName);
            saved = !note.dirty;
            statusMessage.value = saved ? "另存为成功" : "另存为期间文档已再次修改";
        });
        return saved;
    } finally {
        savingDocumentIds.delete(id);
    }
}

async function saveMarkdownImportAs(id: string, selected: string, sourcePath: string) {
    const runtime = session.document(id);
    const sourceContent = runtime.content;
    const plan = await invoke<MarkdownResourcePlan>("prepare_markdown_resources", {
        sourcePath,
        markdown: sourceContent,
    });
    if (!documents.value.includes(runtime)) {
        statusMessage.value = "源文档已关闭，已取消保存";
        return null;
    }
    if (runtime.content !== sourceContent) {
        statusMessage.value = "源文档已更改，请重新保存";
        return null;
    }
    if (plan.items.length > 0) {
        const decision = await requestMarkdownResourceDecision(runtime.displayName, plan);
        if (decision === "cancel") {
            statusMessage.value = "已取消 Markdown 资源导入";
            return null;
        }
        if (!documents.value.includes(runtime)) {
            statusMessage.value = "源文档已关闭，已取消保存";
            return null;
        }
        if (runtime.content !== sourceContent) {
            statusMessage.value = "源文档已更改，请重新保存";
            return null;
        }
    }

    const originalContent = runtime.content;
    const originalResources = runtime.resources.snapshot();
    let convertedContent: string | null = null;
    let convertedResources: ReturnType<typeof runtime.resources.snapshot> | null = null;
    try {
        runtime.content = plan.rewrittenContent;
        for (const resource of plan.resources) {
            registerResourceInSession(id, resource);
        }
        convertedContent = runtime.content;
        convertedResources = runtime.resources.snapshot();
        return await session.saveAs(id, selected);
    } catch (error) {
        const conversionIsUnchanged =
            convertedContent === null ||
            convertedResources === null ||
            (runtime.content === convertedContent &&
                sameResources(
                    runtime.resources.newResources(),
                    convertedResources.newResources,
                ));
        if (conversionIsUnchanged) {
            runtime.content = originalContent;
            runtime.resources.clear();
            runtime.resources.restore(originalResources);
        }
        throw error;
    }
}

const closeActions = {
    decide: async (document: OpenDocument) => requestLeaveDecision(document.displayName),
    save: saveDocument,
};

async function checkForAppUpdate() {
    if (!updatesEnabled || appUpdater.busy.value) return;
    errorMessage.value = "";
    statusMessage.value = "正在检查更新…";
    const result = await appUpdater.checkForUpdate({ silent: false });
    if (result === "available") {
        showUpdateDialog.value = true;
        statusMessage.value = `发现新版本 ${appUpdater.version.value}`;
    } else if (result === "current") {
        statusMessage.value = "已是最新版";
    } else if (result === "failed") {
        showUpdateDialog.value = true;
        statusMessage.value = "检查更新失败";
    }
}

async function downloadAppUpdate() {
    const downloaded = await appUpdater.downloadUpdate();
    statusMessage.value = downloaded ? "更新下载完成" : "更新下载失败";
}

let updateInstallInProgress = false;
async function installDownloadedUpdate() {
    if (updateInstallInProgress || appUpdater.phase.value !== "downloaded") return;
    updateInstallInProgress = true;
    try {
        const canRestart = await session.prepareWindowClose(closeActions);
        if (!canRestart) {
            statusMessage.value = "更新安装已取消";
            return;
        }
        const installed = await appUpdater.installUpdate();
        if (!installed) statusMessage.value = "更新安装失败";
    } catch (error) {
        errorMessage.value = `安装更新前处理失败：${stringifyError(error)}`;
        statusMessage.value = "更新安装已取消";
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
        statusMessage.value = "请先完成当前保存操作";
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
        statusMessage.value = "请先完成当前保存操作";
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
        statusMessage.value = "已关闭文件夹";
    });
}

async function setEditorMode(mode: EditorMode) {
    editorMode.value = mode;
    if (mode === "source") sourcePreview.value = false;
    statusMessage.value = mode === "wysiwyg" ? "已切换到所见即所得" : "已切换到仅源码";
    await nextTick();
    editorRef.value?.focus();
}

async function setSourcePreview(visible: boolean) {
    editorMode.value = "source";
    sourcePreview.value = visible;
    statusMessage.value = visible ? "已切换到垂直双栏" : "已切换到仅源码";
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
        statusMessage.value = "已复制所选内容";
    } else {
        statusMessage.value = "没有可复制的内容或剪贴板不可用";
    }
}

async function cutSelection() {
    const selectedText = editorRef.value?.getSelectedText() ?? "";
    if (!selectedText) return;

    const copied = await writeClipboardText(selectedText);
    if (!copied || !editorRef.value) return;

    editorRef.value.replaceSelection("");
    focusEditor();
    statusMessage.value = "已剪切所选内容";
}

async function pasteClipboard() {
    if (!editorRef.value || !navigator.clipboard?.readText) return;

    try {
        const text = await navigator.clipboard.readText();
        if (!text) return;

        editorRef.value.replaceSelection(text);
        focusEditor();
        statusMessage.value = "已粘贴剪贴板内容";
    } catch {
        statusMessage.value = "当前环境不允许直接读取剪贴板";
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
}

function handleWindowKeyDown(event: KeyboardEvent) {
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

async function refreshLibrary() {
    libraryLoading.value = true;
    try {
        libraryNotes.value = await invoke<NoteListItem[]>("list_notes");
        if (libraryQuery.value.trim()) await runLibrarySearch();
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
    await refreshLibrary();
}

async function openLibraryNote(path: string) {
    showLibrary.value = false;
    await openWorkspacePath(path);
}

async function refreshHistory() {
    const active = activeDocument.value;
    if (!active?.path) {
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
    if (!currentPath.value) {
        statusMessage.value = "请先保存笔记，再查看历史版本";
        return;
    }
    showHistory.value = true;
    await refreshHistory();
}

async function restoreHistory(name: string) {
    const active = activeDocument.value;
    if (!active?.path) return;
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
        session.updateMetadata(targetId, snapshot.meta);
        session.updateContent(targetId, snapshot.content);
        await hydrateDocumentResources(session.document(targetId));
        showHistory.value = false;
        statusMessage.value = "已恢复历史版本，保存后生效";
    });
}

function showAbout() {
    alert(
        `${APP_NAME} ${APP_CN_NAME}\n\n${APP_TAGLINE}\n\n文件格式：MDXNote .mdx\n特点：所见即所得编辑、Markdown 源码查看、本地 ZIP 包式笔记文件。`,
    );
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
                statusMessage.value = "资源导入已取消：活动文档已切换";
                return;
            }
            importedResourceToSession(targetId, resource);
            importedCount += 1;
        }
        statusMessage.value = `已导入 ${importedCount} 个资源`;
    });
}

async function chooseResources() {
    const selected = await open({
        multiple: true,
        title: "选择要导入的图片或附件",
    });
    if (!selected) return;
    await importResourcePaths(Array.isArray(selected) ? selected : [selected]);
}

function insertLink() {
    const selected = editorRef.value?.getSelectedText() || "链接文字";
    const text = prompt("链接文字", selected) || selected;
    const url = prompt("链接地址", "https://") || "";
    if (!url) return;

    insertMarkdownSnippet(`[${text}](${url})`);
}

function insertImageReference() {
    const alt = prompt("图片描述", "图片") || "图片";
    const path = prompt("图片路径", "assets/image.png") || "";
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
        <nav class="menu-bar custom-titlebar" aria-label="应用菜单">
            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>文件</summary>
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
                            <span>最近打开</span>
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
                <summary>编辑</summary>
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
                <summary>格式</summary>
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
                <summary>插入</summary>
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
                <summary>视图</summary>
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
                <summary>关于</summary>
                <div class="menu-popup about-popup">
                    <div class="about-card">
                        <strong>Mora 墨笺</strong>
                        <p>{{ APP_TAGLINE }}</p>
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

            <div v-if="!showSettings" class="mode-switch compact" aria-label="编辑模式">
                <button
                    type="button"
                    :disabled="!activeDocument"
                    :class="{ active: editorMode === 'wysiwyg' }"
                    aria-label="所见即所得"
                    title="所见即所得"
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
                    aria-label="仅源码"
                    title="仅源码"
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
                    aria-label="垂直双栏"
                    title="垂直双栏"
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
                    @activate="activateWorkspaceDocument"
                    @open-path="openWorkspacePath"
                    @open-folder="openFolder"
                    @close-document="closeDocument"
                    @close-folder="closeFolder"
                    @toggle-expanded="toggleWorkspacePath"
                    @update:width="updateSidebarWidth"
                />

                <div class="workspace-center">
                    <section
                        v-if="activeDocument"
                        id="document-editor-panel"
                        class="note-panel"
                        role="region"
                        aria-label="文档编辑区"
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
                    <section v-else class="workspace-welcome" aria-label="开始使用 Mora">
                        <div class="workspace-welcome-card">
                            <p class="workspace-welcome-eyebrow">Mora 墨笺</p>
                            <h1>开始写作</h1>
                            <p>新建一篇文档，或打开已有文件和工作区文件夹。</p>
                            <div class="workspace-welcome-actions">
                                <button
                                    type="button"
                                    class="primary"
                                    @click="createNewNote"
                                >
                                    新建文档
                                </button>
                                <button type="button" @click="openFiles">打开文件</button>
                                <button type="button" @click="openFolder">
                                    打开文件夹
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
                :installed-font-families="installedFontFamilies"
                @close="closeSettingsPanel"
                @update="updatePreferences"
                @save-ai-key="saveAiApiKey"
                @delete-ai-key="deleteAiApiKey"
            />
        </div>
        <CommandPalette
            :open="showCommandPalette"
            :commands="paletteCommands"
            :restore-focus-on-close="restorePaletteFocus"
            @close="closeCommandPalette"
            @run="runPaletteCommand"
        />
        <HistoryPanel
            :open="showHistory"
            :items="historyItems"
            :loading="historyLoading"
            @close="showHistory = false"
            @refresh="refreshHistory"
            @restore="restoreHistory"
        />
        <LibraryPanel
            v-model:query="libraryQuery"
            :open="showLibrary"
            :notes="libraryNotes"
            :results="libraryResults"
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
            @close="showThemePicker = false"
        />
        <StatusBar
            :error-message="errorMessage"
            :status-message="statusMessage"
            :path="displayPath"
            :dirty="dirty"
            :mode-label="modeLabel"
            :word-count="wordCount"
            :workspace-visible="workspaceVisible"
            :outline-visible="outlineVisible"
            :outline-available="outlineAvailable"
            @toggle-workspace="toggleWorkspacePanel"
            @toggle-outline="toggleOutlinePanel"
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
