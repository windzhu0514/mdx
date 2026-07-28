export type EditorMode = "wysiwyg" | "source";

export type EditorCommand =
    | { name: "undo" | "redo" | "selectAll" }
    | { name: "heading"; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
    | {
          name:
              | "bold"
              | "italic"
              | "strike"
              | "code"
              | "blockQuote"
              | "bulletList"
              | "orderedList"
              | "taskList"
              | "indent"
              | "outdent"
              | "hr"
              | "codeBlock";
      };

export type MoraEditorHandle = {
    focus(): void;
    getSelectedText(): string;
    replaceSelection(text: string): void;
    moveCursor(position: "start" | "end"): void;
    execute(command: EditorCommand): void;
};

export type ImageUploadHandler = (file: File) => Promise<string>;
