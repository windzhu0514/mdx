/// <reference types="vite/client" />

declare module "@toast-ui/editor" {
    export type EditorType = "markdown" | "wysiwyg";
    export type PreviewStyle = "tab" | "vertical";

    export type ToastEditorOptions = {
        el: HTMLElement;
        height?: string;
        minHeight?: string;
        initialValue?: string;
        initialEditType?: EditorType;
        previewStyle?: PreviewStyle;
        usageStatistics?: boolean;
        hideModeSwitch?: boolean;
        autofocus?: boolean;
        placeholder?: string;
        toolbarItems?: unknown;
        events?: {
            change?: (editorType: EditorType) => void;
        };
        hooks?: {
            addImageBlobHook?: (
                blob: Blob | File,
                callback: (url: string, text?: string) => void,
            ) => void;
        };
    };

    export default class Editor {
        constructor(options: ToastEditorOptions);
        destroy(): void;
        exec(name: string, payload?: Record<string, unknown>): void;
        focus(): void;
        getMarkdown(): string;
        getSelectedText(): string;
        setMarkdown(markdown: string, cursorToEnd?: boolean): void;
        replaceSelection(markdown: string): void;
        changeMode(mode: EditorType, withoutFocus?: boolean): void;
        changePreviewStyle(style: PreviewStyle): void;
        moveCursorToStart(focus?: boolean): void;
        moveCursorToEnd(focus?: boolean): void;
    }
}

declare module "@toast-ui/editor/dist/toastui-editor.css";
