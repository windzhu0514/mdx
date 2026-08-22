/** @vitest-environment jsdom */

import { createApp, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    maximized: false,
    resizeHandler: undefined as (() => Promise<void> | void) | undefined,
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => mocks.maximized),
    close: vi.fn(async () => undefined),
    unlistenResize: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        minimize: mocks.minimize,
        toggleMaximize: mocks.toggleMaximize,
        isMaximized: mocks.isMaximized,
        close: mocks.close,
        onResized: vi.fn(async (handler: () => Promise<void> | void) => {
            mocks.resizeHandler = handler;
            return mocks.unlistenResize;
        }),
    }),
}));

import WindowControls from "./WindowControls.vue";

let cleanup: (() => void) | undefined;

beforeEach(() => {
    mocks.maximized = false;
    mocks.resizeHandler = undefined;
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
});

async function mountControls() {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(WindowControls);
    app.mount(host);
    cleanup = () => app.unmount();
    await nextTick();
    await Promise.resolve();
    await nextTick();
    return host;
}

describe("WindowControls", () => {
    it("runs the three native window commands", async () => {
        const host = await mountControls();
        const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button"));

        expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
            "最小化窗口",
            "最大化窗口",
            "关闭窗口",
        ]);

        buttons[0]?.click();
        buttons[1]?.click();
        buttons[2]?.click();
        await Promise.resolve();

        expect(mocks.minimize).toHaveBeenCalledOnce();
        expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
        expect(mocks.close).toHaveBeenCalledOnce();
    });

    it("updates the maximize control after native resize events", async () => {
        const host = await mountControls();
        const maximizeButton = host.querySelector<HTMLButtonElement>(
            ".window-control-maximize",
        );
        expect(maximizeButton?.getAttribute("aria-label")).toBe("最大化窗口");

        mocks.maximized = true;
        await mocks.resizeHandler?.();
        await nextTick();

        expect(maximizeButton?.getAttribute("aria-label")).toBe("还原窗口");
        expect(maximizeButton?.getAttribute("title")).toBe("还原窗口");
    });

    it("contains maximize-state failures raised by native resize events", async () => {
        await mountControls();
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        mocks.isMaximized.mockRejectedValueOnce(new Error("state unavailable"));

        await expect(mocks.resizeHandler?.()).resolves.toBeUndefined();

        expect(consoleError).toHaveBeenCalledWith("窗口命令执行失败", expect.any(Error));
        consoleError.mockRestore();
    });
});
