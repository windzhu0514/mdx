import { describe, expect, it } from "vitest";

import appSource from "./App.vue?raw";

describe("App 编辑器视图", () => {
    it("只提供所见即所得、仅源码和垂直双栏", () => {
        expect(appSource).toContain("所见即所得");
        expect(appSource).toContain("仅源码");
        expect(appSource).toContain("垂直双栏");
        expect(appSource).not.toContain("仅预览");
        expect(appSource).not.toContain("@toast-ui/editor");
        expect(appSource).toContain("<MoraEditor");
    });
});
