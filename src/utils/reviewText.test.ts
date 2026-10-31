import { describe, it, expect } from "vitest";
import { textMatches, lineDifference } from "./reviewText";
describe("历史与搜索文本", () => {
    it("按 UTF-16 定位重复中文与 emoji，并提供上下文", () => {
        expect(textMatches("😀墨笺，墨笺", "墨笺").map((x) => [x.from, x.to])).toEqual([
            [2, 4],
            [5, 7],
        ]);
        expect(textMatches("abc", "")).toEqual([]);
    });
    it("在线性空间中保留差异前后文", () => {
        expect(lineDifference("a\n旧\nz", "a\n新\nz")).toEqual([
            { kind: "same", text: "a" },
            { kind: "removed", text: "旧" },
            { kind: "added", text: "新" },
            { kind: "same", text: "z" },
        ]);
    });
});
