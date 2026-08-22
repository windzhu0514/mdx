/** @vitest-environment jsdom */

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UpdateDialog from "./UpdateDialog.vue";
import type { AppUpdatePhase } from "../composables/useAppUpdater";

let app: App | null = null;

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
    });
});

afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
});

function mountDialog(phase: AppUpdatePhase, overrides: Record<string, unknown> = {}) {
    const events: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
        render: () =>
            h(UpdateDialog, {
                open: true,
                phase,
                version: "0.2.0",
                date: "2026-08-22T00:00:00Z",
                notes: "修复保存问题\n<strong>保持纯文本</strong>",
                downloadedBytes: 5,
                totalBytes: 10,
                error: "网络不可用",
                onClose: () => events.push("close"),
                onDownload: () => events.push("download"),
                onInstall: () => events.push("install"),
                onRetry: () => events.push("retry"),
                ...overrides,
            }),
    });
    app.mount(host);
    return { host, events };
}

function clickButton(host: HTMLElement, label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`未找到按钮：${label}`);
    }
    button.click();
}

describe("UpdateDialog", () => {
    it("renders update metadata as plain text and emits available actions", async () => {
        const mounted = mountDialog("available");
        await nextTick();

        const dialog = mounted.host.querySelector('[role="dialog"]');
        expect(dialog?.getAttribute("aria-labelledby")).toBe("update-dialog-title");
        expect(dialog?.textContent).toContain("发现新版本");
        expect(dialog?.textContent).toContain("0.2.0");
        expect(dialog?.textContent).toContain("2026-08-22");
        expect(dialog?.textContent).toContain("<strong>保持纯文本</strong>");
        expect(dialog?.querySelector(".update-notes strong")).toBeNull();

        clickButton(mounted.host, "稍后");
        clickButton(mounted.host, "下载更新");
        expect(mounted.events).toEqual(["close", "download"]);
    });

    it("exposes exact progress values while downloading", async () => {
        const mounted = mountDialog("downloading");
        await nextTick();

        const progress = mounted.host.querySelector('[role="progressbar"]');
        expect(progress?.getAttribute("aria-valuemin")).toBe("0");
        expect(progress?.getAttribute("aria-valuenow")).toBe("5");
        expect(progress?.getAttribute("aria-valuemax")).toBe("10");
        expect(mounted.host.textContent).toContain("5 B / 10 B");
    });

    it("emits install and retry actions for their phases", async () => {
        const downloaded = mountDialog("downloaded");
        await nextTick();
        clickButton(downloaded.host, "安装并重启");
        expect(downloaded.events).toEqual(["install"]);

        app?.unmount();
        app = null;
        document.body.innerHTML = "";
        const failed = mountDialog("error");
        await nextTick();
        clickButton(failed.host, "重试检查");
        expect(failed.events).toEqual(["retry"]);
        expect(failed.host.textContent).toContain("网络不可用");
    });

    it("blocks close while installing", async () => {
        const mounted = mountDialog("installing");
        await nextTick();
        const close = mounted.host.querySelector<HTMLButtonElement>(
            '[aria-label="关闭更新窗口"]',
        );
        expect(close?.disabled).toBe(true);
        close?.click();
        mounted.host
            .querySelector("dialog")
            ?.dispatchEvent(new Event("cancel", { cancelable: true }));
        expect(mounted.events).toEqual([]);
        expect(mounted.host.textContent).toContain("正在安装更新…");
    });
});
