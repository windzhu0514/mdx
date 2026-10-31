import { describe, it, expect } from "vitest";
import { consumeOpenRequests } from "./openRequests";
describe("系统打开队列", () => {
    it("恢复完成后顺序打开、单个失败不阻止后续文件", async () => {
        const opened: string[] = [];
        let restored = false;
        const result = await consumeOpenRequests(
            async () => {
                restored = true;
            },
            async () => ["甲.md", "坏.md", "乙.mdx"],
            async (path) => {
                expect(restored).toBe(true);
                if (path === "坏.md") throw Error("bad");
                opened.push(path);
            },
        );
        expect(opened).toEqual(["甲.md", "乙.mdx"]);
        expect(result).toHaveLength(1);
    });
});
