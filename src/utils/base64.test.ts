import { describe, expect, it } from "vitest";

import { base64ToBlob } from "./base64";

describe("base64ToBlob", () => {
    it("在本地把 Base64 解码为指定 MIME 类型的 Blob", async () => {
        const blob = base64ToBlob("SGVsbG8=", "text/plain");

        expect(blob.type).toBe("text/plain");
        expect(blob.size).toBe(5);
        expect(await blob.text()).toBe("Hello");
    });
});
