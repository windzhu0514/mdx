// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { isTextInputTarget } from "./shortcuts";

describe("shortcut target guard", () => {
    it("preserves native shortcuts in inputs", () => {
        expect(isTextInputTarget(document.createElement("input"))).toBe(true);
    });

    it("preserves native shortcuts in textareas and selects", () => {
        expect(isTextInputTarget(document.createElement("textarea"))).toBe(true);
        expect(isTextInputTarget(document.createElement("select"))).toBe(true);
    });

    it("preserves native shortcuts in contenteditable descendants", () => {
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "true");
        const child = document.createElement("span");
        editor.append(child);
        document.body.append(editor);

        expect(isTextInputTarget(child)).toBe(true);
    });

    it("allows application shortcuts outside editable controls", () => {
        expect(isTextInputTarget(document.createElement("div"))).toBe(false);
        expect(isTextInputTarget(null)).toBe(false);
    });
});
