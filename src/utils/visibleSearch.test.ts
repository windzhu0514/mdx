import { describe, it, expect } from "vitest";
import { visibleSearchOccurrence } from "./reviewText";
const source = "[墨笺](墨笺) 墨笺";
const tree = {
    type: "root",
    children: [
        {
            type: "paragraph",
            children: [
                {
                    type: "link",
                    children: [
                        {
                            type: "text",
                            value: "墨笺",
                            position: { start: { offset: 1 }, end: { offset: 3 } },
                        },
                    ],
                },
                {
                    type: "text",
                    value: " 墨笺",
                    position: { start: { offset: 8 }, end: { offset: 11 } },
                },
            ],
        },
    ],
};
describe("源码命中到可见文本映射", () => {
    it("链接目标不映射为正文", () =>
        expect(visibleSearchOccurrence(source, "墨笺", 1, tree)).toBeNull());
    it("跳过链接目标后定位正文第二处", () =>
        expect(visibleSearchOccurrence(source, "墨笺", 2, tree)).toBe(1));
});
