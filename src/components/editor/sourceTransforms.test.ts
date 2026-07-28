import { describe, expect, it } from "vitest";
import { transformSourceSelection } from "./sourceTransforms";

describe("source markdown commands", () => {
    it("wraps a selection with strong markers", () => {
        expect(transformSourceSelection("hello", 0, 5, { name: "bold" })).toEqual({
            from: 0,
            to: 5,
            insert: "**hello**",
            anchor: 9,
        });
    });

    it("replaces an existing heading prefix", () => {
        expect(
            transformSourceSelection("## Title", 0, 8, {
                name: "heading",
                level: 3,
            }),
        ).toEqual({ from: 0, to: 8, insert: "### Title", anchor: 9 });
    });

    it("prefixes every selected line as a task list", () => {
        expect(transformSourceSelection("one\ntwo", 0, 7, { name: "taskList" })).toEqual({
            from: 0,
            to: 7,
            insert: "- [ ] one\n- [ ] two",
            anchor: 19,
        });
    });

    it("wraps selections with the remaining inline markers", () => {
        expect(transformSourceSelection("word", 0, 4, { name: "italic" })).toEqual({
            from: 0,
            to: 4,
            insert: "*word*",
            anchor: 6,
        });
        expect(transformSourceSelection("word", 0, 4, { name: "strike" })).toEqual({
            from: 0,
            to: 4,
            insert: "~~word~~",
            anchor: 8,
        });
        expect(transformSourceSelection("word", 0, 4, { name: "code" })).toEqual({
            from: 0,
            to: 4,
            insert: "`word`",
            anchor: 6,
        });
        expect(transformSourceSelection("word", 0, 4, { name: "codeBlock" })).toEqual({
            from: 0,
            to: 4,
            insert: "```\nword\n```",
            anchor: 12,
        });
    });

    it("turns a selected heading into a paragraph at level zero", () => {
        expect(
            transformSourceSelection("# Title", 0, 7, { name: "heading", level: 0 }),
        ).toEqual({ from: 0, to: 7, insert: "Title", anchor: 5 });
    });

    it("applies line commands to complete selected lines", () => {
        expect(
            transformSourceSelection("before\n## Title\nafter", 8, 11, {
                name: "heading",
                level: 3,
            }),
        ).toEqual({ from: 7, to: 15, insert: "### Title", anchor: 16 });
    });

    it("prefixes every selected line for block and list commands", () => {
        const document = "one\ntwo";
        expect(transformSourceSelection(document, 0, 7, { name: "blockQuote" })).toEqual({
            from: 0,
            to: 7,
            insert: "> one\n> two",
            anchor: 11,
        });
        expect(transformSourceSelection(document, 0, 7, { name: "bulletList" })).toEqual({
            from: 0,
            to: 7,
            insert: "- one\n- two",
            anchor: 11,
        });
        expect(transformSourceSelection(document, 0, 7, { name: "orderedList" })).toEqual(
            {
                from: 0,
                to: 7,
                insert: "1. one\n2. two",
                anchor: 13,
            },
        );
    });

    it("indents and outdents every selected line", () => {
        expect(transformSourceSelection("one\ntwo", 0, 7, { name: "indent" })).toEqual({
            from: 0,
            to: 7,
            insert: "    one\n    two",
            anchor: 15,
        });
        expect(
            transformSourceSelection("    one\n\ttwo\n  three", 0, 20, {
                name: "outdent",
            }),
        ).toEqual({ from: 0, to: 20, insert: "one\ntwo\nthree", anchor: 13 });
    });

    it("inserts a horizontal rule without replacing the selection", () => {
        expect(transformSourceSelection("hello", 1, 4, { name: "hr" })).toEqual({
            from: 1,
            to: 1,
            insert: "\n---\n",
            anchor: 6,
        });
    });

    it("leaves CodeMirror commands to CodeMirror", () => {
        expect(transformSourceSelection("hello", 0, 5, { name: "undo" })).toBeNull();
        expect(transformSourceSelection("hello", 0, 5, { name: "redo" })).toBeNull();
        expect(transformSourceSelection("hello", 0, 5, { name: "selectAll" })).toBeNull();
    });
});
