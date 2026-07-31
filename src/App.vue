<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./experience.css";
import FindReplacePanel from "./components/FindReplacePanel.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import LeaveConfirmDialog from "./components/LeaveConfirmDialog.vue";
import LibraryPanel from "./components/LibraryPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import TableOfContents from "./components/TableOfContents.vue";
import MoraEditor from "./components/editor/MoraEditor.vue";
import { createOpenAICompatibleProvider } from "./ai/openAICompatible";
import type {
    EditorCommand,
    EditorMode,
    MoraEditorHandle,
} from "./components/editor/editorTypes";
import {
    createDraftRecovery,
    draftKey,
    shouldOfferDraftRestore,
    type DraftSnapshot,
    type DraftStore,
} from "./composables/useDraftRecovery";
import { usePreferences } from "./composables/usePreferences";
import { createResourceSession } from "./composables/useResources";
import type { HistoryListItem, HistorySnapshot } from "./types/history";
import type { NoteListItem, NoteSearchResult } from "./types/library";
import type {
    ImportedMarkdown,
    MdxMetadata,
    MdxNote,
    ResourceSaveData,
} from "./types/mdx";
import type { RecentFileEntry } from "./types/workspace";
import { runLeaveDecision, type LeaveDecision } from "./utils/leaveGuard";
import { base64ToBlob } from "./utils/base64";
import { createEmptyMetadata } from "./utils/note";
import { isTextInputTarget } from "./utils/shortcuts";
import {
    countNonWhitespaceCharacters,
    documentNameFromPath,
    extractMarkdownHeadings,
    UNNAMED_DOCUMENT_NAME,
} from "./utils/text";

type MdxSaveRequest = {
    path: string | null;
    title: string;
    content: string;
    meta: MdxMetadata | null;
    newAssets?: {
        name: string;
        originalName: string;
        mimeType: string;
        size: number;
        kind: "asset" | "attachment";
        base64: string;
    }[];
};

type MarkdownCommand = {
    label: string;
    action: () => void | Promise<void>;
    disabled?: boolean;
    shortcut?: string;
};

const APP_NAME = "Mora";
const APP_CN_NAME = "墨笺";
const APP_TAGLINE = "Mora 墨笺，一款所见即所得的 MDX 扩展笔记编辑器";

const currentPath = ref<string | null>(null);
const title = ref(UNNAMED_DOCUMENT_NAME);
const content = ref("");
const meta = ref<MdxMetadata | null>(null);
const dirty = ref(false);
const loading = ref(false);
const statusMessage = ref("准备就绪");
const errorMessage = ref("");
const editorRef = ref<MoraEditorHandle | null>(null);
const lastSearchQuery = ref("");
const findPanel = ref<InstanceType<typeof FindReplacePanel> | null>(null);

const editorMode = ref<EditorMode>("wysiwyg");
const sourcePreview = ref(true);
const editorDocumentId = computed(() => meta.value?.id ?? "untitled-current");
let printing = false;
const showToc = ref(true);
const recentFiles = ref<RecentFileEntry[]>([]);
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
const showSettings = ref(false);
const aiKeyConfigured = ref(false);
const aiKeySaving = ref(false);
let aiKeyStatusRequestId = 0;

const resourceSession = createResourceSession();
const {
    preferences,
    update: updatePreferences,
    dispose: disposePreferences,
} = usePreferences();
const aiProvider = createOpenAICompatibleProvider(
    () => ({
        baseUrl: preferences.value.aiBaseUrl,
        model: preferences.value.aiModel,
    }),
    resourceSession.persistedMarkdown,
);
const showLeavePrompt = ref(false);
let leavePromptResolver: ((decision: LeaveDecision) => void) | null = null;
let unlistenClose: (() => void) | null = null;
let unlistenDragDrop: (() => void) | null = null;
let allowWindowClose = false;
const tauriRuntime = isTauri();

const draftStore: DraftStore = tauriRuntime
    ? {
          write: (key, draft) => invoke("write_draft", { key, draft }),
          read: (key) => invoke<DraftSnapshot | null>("read_draft", { key }),
          remove: (key) => invoke("delete_draft", { key }),
      }
    : {
          write: async () => undefined,
          read: async () => null,
          remove: async () => undefined,
      };
const draftRecovery = createDraftRecovery(
    draftStore,
    currentDraftKey,
    buildDraftSnapshot,
);

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

async function registerPastedImage(file: File): Promise<string> {
    const extension = imageExtension(file.type);
    const filename = `assets/image-${crypto.randomUUID()}.${extension}`;
    const base64 = await blobToBase64(file);
    const objectUrl = URL.createObjectURL(file);
    resourceSession.registerNew({
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
const displayContent = computed(() => resourceSession.displayMarkdown(content.value));
const findMatchCount = computed(() => countOccurrences(content.value, findQuery.value));
const windowTitle = computed(
    () =>
        `${dirty.value ? "* " : ""}${title.value || UNNAMED_DOCUMENT_NAME} - ${APP_NAME}`,
);
const displayPath = computed(() => currentPath.value || "尚未保存");
const modeLabel = computed(() => {
    if (editorMode.value === "wysiwyg") return "所见即所得";
    return sourcePreview.value ? "垂直双栏" : "仅源码";
});

const toc = computed(() => {
    return extractMarkdownHeadings(content.value);
});

function scrollToHeading(text: string) {
    editorRef.value?.scrollToHeading(text);
}

function setTocVisibility(visible: boolean) {
    showToc.value = visible;
    updatePreferences({ showToc: visible });
    statusMessage.value = visible ? "已显示侧边栏" : "已隐藏侧边栏";
}

function toggleToc() {
    setTocVisibility(!showToc.value);
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
    { label: "新建", shortcut: "Ctrl+N", action: () => createNewNote() },
    { label: "打开...", shortcut: "Ctrl+O", action: openNote },
    { label: "导入 Markdown...", action: importMarkdown },
    {
        label: "笔记库与全文搜索...",
        shortcut: "Ctrl+Shift+F",
        action: openLibrary,
    },
    {
        label: "保存",
        shortcut: "Ctrl+S",
        action: saveNote,
        disabled: loading.value,
    },
    {
        label: "另存为...",
        shortcut: "Ctrl+Shift+S",
        action: saveNoteAs,
        disabled: loading.value,
    },
    { label: "导出 Markdown...", action: exportMarkdown },
    { label: "导出 PDF / 打印...", action: exportPdf },
]);

const editMenu = computed<MarkdownCommand[]>(() => [
    { label: "撤销", shortcut: "Ctrl+Z", action: undoEdit },
    { label: "重做", shortcut: "Ctrl+Y", action: redoEdit },
    { label: "剪切", shortcut: "Ctrl+X", action: cutSelection },
    { label: "复制", shortcut: "Ctrl+C", action: copySelection },
    { label: "粘贴", shortcut: "Ctrl+V", action: pasteClipboard },
    { label: "全选", shortcut: "Ctrl+A", action: selectAllContent },
    { label: "查找", shortcut: "Ctrl+F", action: findInDocument },
    { label: "替换", shortcut: "Ctrl+H", action: replaceInDocument },
]);

const formatMenu = computed<MarkdownCommand[]>(() => [
    {
        label: "段落",
        shortcut: "Ctrl+0",
        action: () => runEditorCommand("heading", { level: 0 }),
    },
    {
        label: "一级标题",
        shortcut: "Ctrl+1",
        action: () => runEditorCommand("heading", { level: 1 }),
    },
    {
        label: "二级标题",
        shortcut: "Ctrl+2",
        action: () => runEditorCommand("heading", { level: 2 }),
    },
    {
        label: "三级标题",
        shortcut: "Ctrl+3",
        action: () => runEditorCommand("heading", { level: 3 }),
    },
    {
        label: "四级标题",
        shortcut: "Ctrl+4",
        action: () => runEditorCommand("heading", { level: 4 }),
    },
    {
        label: "五级标题",
        shortcut: "Ctrl+5",
        action: () => runEditorCommand("heading", { level: 5 }),
    },
    {
        label: "六级标题",
        shortcut: "Ctrl+6",
        action: () => runEditorCommand("heading", { level: 6 }),
    },
    {
        label: "加粗",
        shortcut: "Ctrl+B",
        action: () => runEditorCommand("bold"),
    },
    {
        label: "斜体",
        shortcut: "Ctrl+I",
        action: () => runEditorCommand("italic"),
    },
    {
        label: "删除线",
        shortcut: "Ctrl+Shift+X",
        action: () => runEditorCommand("strike"),
    },
    {
        label: "行内代码",
        shortcut: "Ctrl+`",
        action: () => runEditorCommand("code"),
    },
]);

const insertMenu = computed<MarkdownCommand[]>(() => [
    {
        label: "引用块",
        action: () => runEditorCommand("blockQuote"),
    },
    {
        label: "无序列表",
        shortcut: "Ctrl+Shift+8",
        action: () => runEditorCommand("bulletList"),
    },
    {
        label: "有序列表",
        shortcut: "Ctrl+Shift+7",
        action: () => runEditorCommand("orderedList"),
    },
    {
        label: "任务列表",
        shortcut: "Ctrl+Shift+T",
        action: () => runEditorCommand("taskList"),
    },
    {
        label: "增加缩进",
        shortcut: "Tab",
        action: () => runEditorCommand("indent"),
    },
    {
        label: "减少缩进",
        shortcut: "Shift+Tab",
        action: () => runEditorCommand("outdent"),
    },
    {
        label: "分割线",
        action: () => runEditorCommand("hr"),
    },
    {
        label: "代码块",
        action: () => runEditorCommand("codeBlock"),
    },
    { label: "链接", shortcut: "Ctrl+K", action: insertLink },
    {
        label: "图片引用",
        shortcut: "Ctrl+Shift+I",
        action: insertImageReference,
    },
    { label: "导入图片或附件...", action: chooseResources },
    { label: "表格", action: insertTable },
]);

const viewMenu = computed<MarkdownCommand[]>(() => [
    {
        label: "所见即所得编辑",
        shortcut: "Alt+1",
        action: () => setEditorMode("wysiwyg"),
    },
    {
        label: "垂直双栏",
        shortcut: "Alt+2",
        action: () => setSourcePreview(true),
    },
    {
        label: "仅源码",
        shortcut: "Alt+3",
        action: () => setSourcePreview(false),
    },
    {
        label: showToc.value ? "隐藏侧边栏" : "显示侧边栏",
        action: toggleToc,
    },
    { label: "历史版本...", action: openHistoryPanel },
    { label: "偏好设置...", action: openSettingsPanel },
    {
        label: "光标移到文首",
        shortcut: "Ctrl+Home",
        action: () => editorRef.value?.moveCursor("start"),
    },
    {
        label: "光标移到文末",
        shortcut: "Ctrl+End",
        action: () => editorRef.value?.moveCursor("end"),
    },
]);

const aboutMenu = computed<MarkdownCommand[]>(() => [
    { label: `关于 ${APP_NAME} ${APP_CN_NAME}`, action: showAbout },
]);

function currentDraftKey() {
    return draftKey(currentPath.value, meta.value?.id || "unsaved");
}

function buildDraftSnapshot(): DraftSnapshot {
    return {
        path: currentPath.value,
        title: title.value,
        content: resourceSession.persistedMarkdown(content.value),
        meta: meta.value,
        newResources: resourceSession.newResources(),
        updatedAt: new Date().toISOString(),
    };
}

function requestLeaveDecision() {
    showLeavePrompt.value = true;
    return new Promise<LeaveDecision>((resolve) => {
        leavePromptResolver = resolve;
    });
}

function resolveLeaveDecision(decision: LeaveDecision) {
    showLeavePrompt.value = false;
    leavePromptResolver?.(decision);
    leavePromptResolver = null;
}

async function confirmLeave() {
    if (!dirty.value) return true;
    try {
        await draftRecovery.flush();
    } catch (error) {
        errorMessage.value = `草稿保存失败：${stringifyError(error)}`;
    }

    const decision = await requestLeaveDecision();
    if (decision === "discard") {
        await draftRecovery.remove();
    }
    return runLeaveDecision(decision, async () => {
        await saveNote();
        return !dirty.value;
    });
}

async function restoreDraft(snapshot: DraftSnapshot) {
    let baseNote: MdxNote;
    if (snapshot.path) {
        try {
            baseNote = await invoke<MdxNote>("open_mdx", { path: snapshot.path });
        } catch {
            baseNote = await invoke<MdxNote>("create_mdx");
        }
    } else {
        baseNote = await invoke<MdxNote>("create_mdx");
    }
    await applyNote(baseNote, false);
    currentPath.value = snapshot.path;
    title.value = documentNameFromPath(snapshot.path);
    meta.value = snapshot.meta ?? baseNote.meta;

    for (const resource of snapshot.newResources) {
        const blob = base64ToBlob(resource.base64, resource.mimeType);
        resourceSession.registerNew({
            path: resource.name,
            originalName: resource.originalName,
            mimeType: resource.mimeType,
            size: resource.size,
            base64: resource.base64,
            objectUrl: URL.createObjectURL(blob),
            kind: resource.kind,
            isNew: true,
        });
    }

    content.value = resourceSession.persistedMarkdown(snapshot.content);
    dirty.value = true;
    statusMessage.value = "已恢复未保存草稿";
}

async function restoreLatestDraft() {
    try {
        const latest = tauriRuntime
            ? await invoke<DraftSnapshot | null>("read_latest_draft")
            : null;
        if (!latest) return false;
        const key = draftKey(latest.path, latest.meta?.id || "unsaved");
        if (!shouldOfferDraftRestore(latest.updatedAt, latest.meta?.updatedAt)) {
            await draftStore.remove(key);
            return false;
        }
        if (!confirm(`检测到“${latest.title}”的未保存草稿，是否恢复？`)) {
            await draftStore.remove(key);
            return false;
        }
        await restoreDraft(latest);
        return true;
    } catch (error) {
        console.warn("读取恢复草稿失败", error);
        return false;
    }
}

watch(
    () => preferences.value.showToc,
    (visible) => {
        showToc.value = visible;
    },
    { immediate: true },
);

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

async function openSettingsPanel() {
    showSettings.value = true;
    await refreshAiKeyConfigured();
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

    if (!tauriRuntime) {
        meta.value = createEmptyMetadata(title.value);
        return;
    }

    await refreshAiKeyConfigured();

    const appWindow = getCurrentWindow();
    unlistenDragDrop = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        await importResourcePaths(event.payload.paths);
    });
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
        if (allowWindowClose || !dirty.value) return;
        event.preventDefault();
        if (await confirmLeave()) {
            allowWindowClose = true;
            await appWindow.close();
        }
    });

    await loadRecentFiles();
    if (!(await restoreLatestDraft())) {
        await createNewNote(false);
    }
});

onBeforeUnmount(() => {
    window.removeEventListener("pointerdown", handleWindowPointerDown, true);
    window.removeEventListener("keydown", handleWindowKeyDown);
    unlistenClose?.();
    unlistenDragDrop?.();
    draftRecovery.dispose();
    disposePreferences();
    resourceSession.clear();
});

function markDirty() {
    dirty.value = true;
    if (tauriRuntime) draftRecovery.schedule();
}

function handleEditorUpdate(markdown: string) {
    if (printing) return;
    const persistedContent = resourceSession.persistedMarkdown(markdown);
    if (persistedContent === content.value) return;

    content.value = persistedContent;
    markDirty();
}

function handleAiError(message: string) {
    const needsSettings = /Base URL|模型|API Key/i.test(message);
    const detail = needsSettings ? `${message}，请在偏好设置中完成 AI 配置` : message;
    errorMessage.value = `AI 生成失败：${detail}`;
    statusMessage.value = "AI 生成失败";
}

async function applyNote(note: MdxNote, saved: boolean) {
    resourceSession.clear();
    currentPath.value = note.path;
    title.value = documentNameFromPath(note.path);
    meta.value = note.meta;

    const persistedContent = note.content ?? "";
    if (currentPath.value) {
        const assetRegex =
            /\]\(((?:assets|attachments)\/[^)]+)\)|(?:src|href)=["']((?:assets|attachments)\/[^"']+)["']/g;
        const assetPaths = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = assetRegex.exec(persistedContent)) !== null) {
            assetPaths.add(match[1] || match[2]);
        }

        for (const assetPath of assetPaths) {
            try {
                const base64 = await invoke<string>("read_asset", {
                    path: currentPath.value,
                    assetName: assetPath,
                });
                const resourceMeta = [...note.meta.assets, ...note.meta.attachments].find(
                    (resource) => resource.path === assetPath,
                );
                const mimeType = resourceMeta?.type || "application/octet-stream";
                const blob = base64ToBlob(base64, mimeType);
                const objectUrl = URL.createObjectURL(blob);
                resourceSession.registerLoaded({
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

    content.value = persistedContent;
    dirty.value = !saved;
    errorMessage.value = "";
}
function buildRequest(pathOverride?: string | null): MdxSaveRequest {
    const finalContent = resourceSession.persistedMarkdown(content.value);
    const requestPath = pathOverride ?? currentPath.value;
    const requestTitle = documentNameFromPath(requestPath);
    const newAssets = resourceSession
        .newResources()
        .filter((resource) => finalContent.includes(resource.name));

    return {
        path: requestPath,
        title: requestTitle,
        content: finalContent,
        meta: meta.value ? { ...meta.value, title: requestTitle } : null,
        newAssets,
    };
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

async function createNewNote(askConfirm = true) {
    if (askConfirm && !(await confirmLeave())) return;

    await runAction(async () => {
        const note = await invoke<MdxNote>("create_mdx");
        await applyNote(note, true);
        statusMessage.value = "已新建笔记";
    });
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
    await openNote(path);
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
    markDirty();
    statusMessage.value = `已替换 ${matchCount} 处“${query}”`;
}

async function openNote(path?: string) {
    if (!(await confirmLeave())) return;

    await runAction(async () => {
        let selectedPath = path;

        if (!selectedPath) {
            const selected = await open({
                multiple: false,
                filters: [{ name: "Mora 墨笺笔记", extensions: ["mdx"] }],
            });

            if (!selected || Array.isArray(selected)) {
                statusMessage.value = "已取消打开";
                return;
            }

            selectedPath = selected;
        }

        try {
            const note = await invoke<MdxNote>("open_mdx", { path: selectedPath });
            await applyNote(note, true);

            if (note.path) {
                await pushRecentFile(note.path, title.value);
            }
        } catch (error) {
            if (selectedPath) {
                try {
                    await removeRecentFile(selectedPath);
                } catch (removeError) {
                    console.warn("移除无效最近文件失败", removeError);
                }
            }

            throw error;
        }

        statusMessage.value = "已打开笔记";
    });
}

async function importMarkdown() {
    if (!(await confirmLeave())) return;

    const selected = await open({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!selected || Array.isArray(selected)) {
        statusMessage.value = "已取消导入";
        return;
    }

    await runAction(async () => {
        const imported = await invoke<ImportedMarkdown>("import_markdown", {
            path: selected,
        });
        const note = await invoke<MdxNote>("create_mdx");
        note.title = imported.title;
        note.content = imported.content;
        note.meta.title = imported.title;

        if (imported.frontMatter) {
            note.meta.author = imported.frontMatter.author;
            note.meta.summary = imported.frontMatter.summary;
            note.meta.tags = imported.frontMatter.tags;
            note.meta.category = imported.frontMatter.categories[0] ?? "";
        }

        await applyNote(note, false);
        statusMessage.value = "已导入 Markdown 文件";
    });
}

async function ensureSavedForExport() {
    if (!currentPath.value || dirty.value) {
        await saveNote();
    }
    return Boolean(currentPath.value && !dirty.value);
}

async function exportMarkdown() {
    if (!(await ensureSavedForExport()) || !currentPath.value) return;
    const destination = await save({
        defaultPath: `${sanitizeFileName(title.value)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destination) return;
    await runAction(async () => {
        await invoke("export_markdown", {
            sourcePath: currentPath.value,
            destinationPath: destination,
        });
        statusMessage.value = "Markdown 导出成功";
    });
}

async function exportPdf() {
    if (printing) return;

    printing = true;
    let printTitleApplied = false;
    const previousMode = editorMode.value;
    const previousSourcePreview = sourcePreview.value;
    try {
        if (!(await ensureSavedForExport())) return;
        editorMode.value = "wysiwyg";
        await nextTick();
        await (editorRef.value?.whenReady() ?? Promise.resolve());
        statusMessage.value = "已打开系统打印对话框，可选择另存为 PDF";
        document.title = title.value;
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
    if (!currentPath.value) {
        await saveNoteAs();
        return;
    }

    const previousDraftKey = currentDraftKey();
    await runAction(async () => {
        const note = await invoke<MdxNote>("save_mdx", {
            request: buildRequest(),
        });
        await applyNote(note, true);
        await draftRecovery.remove(previousDraftKey);
        if (note.path) {
            await pushRecentFile(note.path, title.value);
        }
        statusMessage.value = "保存成功";
    });
}

async function saveNoteAs() {
    const previousDraftKey = currentDraftKey();
    await runAction(async () => {
        const selected = await save({
            defaultPath: `${sanitizeFileName(title.value || UNNAMED_DOCUMENT_NAME)}.mdx`,
            filters: [{ name: "Mora 墨笺笔记", extensions: ["mdx"] }],
        });

        if (!selected) {
            statusMessage.value = "已取消保存";
            return;
        }

        const note = await invoke<MdxNote>("save_mdx_as", {
            request: buildRequest(selected),
            path: selected,
        });
        await applyNote(note, true);
        await draftRecovery.remove(previousDraftKey);
        if (note.path) {
            await pushRecentFile(note.path, title.value);
        }
        statusMessage.value = "另存为成功";
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
        const key = event.key.toLowerCase();
        const isApplicationShortcut =
            key === "s" ||
            key === "n" ||
            key === "o" ||
            key === "f" ||
            (key === "h" && !event.shiftKey);

        if (isTextInputTarget(event.target) && !isApplicationShortcut) {
            return;
        }

        // File commands
        if (key === "s") {
            event.preventDefault();
            if (event.shiftKey) saveNoteAs();
            else saveNote();
        } else if (key === "n") {
            event.preventDefault();
            createNewNote();
        } else if (key === "o" && !event.shiftKey) {
            event.preventDefault();
            openNote();
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
        } else if (key === "b") {
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
        } else if (key === "8" && event.shiftKey) {
            event.preventDefault();
            runEditorCommand("bulletList");
        } else if (key === "7" && event.shiftKey) {
            event.preventDefault();
            runEditorCommand("orderedList");
        } else if (key === "t" && event.shiftKey) {
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
            setSourcePreview(true);
        } else if (key === "3") {
            event.preventDefault();
            setSourcePreview(false);
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
    await openNote(path);
}

async function refreshHistory() {
    if (!currentPath.value) {
        historyItems.value = [];
        return;
    }
    historyLoading.value = true;
    try {
        historyItems.value = await invoke<HistoryListItem[]>("list_history", {
            path: currentPath.value,
        });
    } finally {
        historyLoading.value = false;
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
    if (!currentPath.value) return;
    await runAction(async () => {
        const snapshot = await invoke<HistorySnapshot>("read_history", {
            path: currentPath.value,
            name,
        });
        const base = await invoke<MdxNote>("open_mdx", { path: currentPath.value });
        await applyNote(
            {
                ...base,
                title: snapshot.title,
                content: snapshot.content,
                meta: snapshot.meta,
            },
            false,
        );
        markDirty();
        showHistory.value = false;
        statusMessage.value = "已恢复历史版本，保存后生效";
    });
}

function showAbout() {
    alert(
        `${APP_NAME} ${APP_CN_NAME}\n\n${APP_TAGLINE}\n\n文件格式：MDXNote .mdx\n特点：所见即所得编辑、Markdown 源码查看、本地 ZIP 包式笔记文件。`,
    );
}

async function importedResourceToSession(resource: ResourceSaveData) {
    const blob = base64ToBlob(resource.base64, resource.mimeType);
    const objectUrl = URL.createObjectURL(blob);
    resourceSession.registerNew({
        path: resource.name,
        originalName: resource.originalName,
        mimeType: resource.mimeType,
        size: resource.size,
        base64: resource.base64,
        objectUrl,
        kind: resource.kind,
        isNew: true,
    });
    insertMarkdownSnippet(
        resource.kind === "asset"
            ? `![${resource.originalName}](${objectUrl})`
            : `[${resource.originalName}](${objectUrl})`,
    );
}

async function importResourcePaths(paths: string[]) {
    if (!paths.length) return;
    await runAction(async () => {
        for (const path of paths) {
            const resource = await invoke<ResourceSaveData>("import_resource", {
                path,
            });
            await importedResourceToSession(resource);
        }
        statusMessage.value = `已导入 ${paths.length} 个资源`;
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
    insertMarkdownSnippet(
        "\n\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n\n",
    );
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
        <nav class="menu-bar" aria-label="应用菜单">
            <details class="menu-group" @toggle="handleMenuToggle">
                <summary>文件</summary>
                <div class="menu-popup">
                    <button
                        v-for="item in fileMenu"
                        :key="item.label"
                        type="button"
                        :disabled="item.disabled"
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
                                v-for="item in recentFiles"
                                :key="item.path"
                                type="button"
                                @click="runMenuAction(() => openRecentFile(item.path))"
                            >
                                <span>{{ formatRecentFileLabel(item) }}</span>
                                <span class="shortcut">{{ item.path }}</span>
                            </button>
                            <div class="menu-divider" />
                            <button
                                type="button"
                                @click="runMenuAction(clearRecentFiles)"
                            >
                                <span>清空最近打开</span>
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
                        :key="item.label"
                        type="button"
                        :disabled="item.disabled"
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
                        :key="item.label"
                        type="button"
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
                        :key="item.label"
                        type="button"
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
                        :key="item.label"
                        type="button"
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
                        :key="item.label"
                        type="button"
                        @click="runMenuAction(item.action)"
                    >
                        {{ item.label }}
                    </button>
                </div>
            </details>

            <div class="menu-document-name" :title="title">
                {{ title }}
            </div>

            <div class="mode-switch compact" aria-label="编辑模式">
                <button
                    type="button"
                    :class="{ active: editorMode === 'wysiwyg' }"
                    @click="setEditorMode('wysiwyg')"
                >
                    所见即所得
                </button>
                <button
                    type="button"
                    :class="{
                        active: editorMode === 'source' && !sourcePreview,
                    }"
                    @click="setSourcePreview(false)"
                >
                    仅源码
                </button>
                <button
                    type="button"
                    :class="{
                        active: editorMode === 'source' && sourcePreview,
                    }"
                    @click="setSourcePreview(true)"
                >
                    垂直双栏
                </button>
            </div>
        </nav>

        <div class="main-body">
            <TableOfContents
                :items="toc"
                :visible="showToc"
                @select="scrollToHeading"
                @visibility="setTocVisibility"
            />

            <section class="note-panel" :aria-busy="loading">
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
                            :document-id="editorDocumentId"
                            :model-value="content"
                            :display-value="displayContent"
                            :mode="editorMode"
                            :source-preview="sourcePreview"
                            :upload-image="registerPastedImage"
                            :ai-provider="tauriRuntime ? aiProvider : undefined"
                            @update:model-value="handleEditorUpdate"
                            @ai-error="handleAiError"
                        />
                    </div>
                </div>
            </section>
        </div>

        <SettingsPanel
            :open="showSettings"
            :preferences="preferences"
            :ai-key-configured="aiKeyConfigured"
            :ai-key-saving="aiKeySaving"
            @close="showSettings = false"
            @update="updatePreferences"
            @save-ai-key="saveAiApiKey"
            @delete-ai-key="deleteAiApiKey"
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
        <LeaveConfirmDialog :open="showLeavePrompt" @decide="resolveLeaveDecision" />
        <StatusBar
            :error-message="errorMessage"
            :status-message="statusMessage"
            :path="displayPath"
            :dirty="dirty"
            :mode-label="modeLabel"
            :word-count="wordCount"
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
    .toc-sidebar,
    .toc-show-button,
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
