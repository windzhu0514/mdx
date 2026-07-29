import type { AIPromptContext } from "@milkdown/crepe/feature/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    type MockEvent = unknown;

    class MockChannel {
        onmessage: (event: MockEvent) => void = () => undefined;

        emit(event: MockEvent) {
            this.onmessage(event);
        }
    }

    return {
        Channel: MockChannel,
        invoke: vi.fn(),
    };
});

vi.mock("@tauri-apps/api/core", () => ({
    Channel: mocks.Channel,
    invoke: mocks.invoke,
}));

import { createOpenAICompatibleProvider, type AiStreamEvent } from "./openAICompatible";

const context: AIPromptContext = {
    document: "# 文档",
    selection: "选中内容",
    instruction: "润色",
};

function config() {
    return { baseUrl: "https://api.example.com/v1", model: "example-model" };
}

async function collect(iterable: AsyncIterable<string>) {
    const values: string[] = [];
    for await (const value of iterable) values.push(value);
    return values;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function emit(args: unknown, event: AiStreamEvent) {
    const channel = (args as { onEvent: InstanceType<typeof mocks.Channel> }).onEvent;
    channel.emit(event);
}

describe("OpenAI-compatible Provider", () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
    });

    it("按 Channel 到达顺序产出 delta 并在 done 时结束", async () => {
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") {
                emit(args, { type: "delta", text: "A" });
                emit(args, { type: "delta", text: "B" });
                emit(args, { type: "done" });
            }
            return Promise.resolve();
        });
        const provider = createOpenAICompatibleProvider(config, (value) => value);

        await expect(
            collect(provider(context, new AbortController().signal)),
        ).resolves.toEqual(["A", "B"]);
    });

    it("将流式 error 的中文消息作为异常抛出", async () => {
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") {
                emit(args, {
                    type: "error",
                    code: "AI_REMOTE",
                    message: "模型服务暂时不可用",
                });
            }
            return Promise.resolve();
        });
        const provider = createOpenAICompatibleProvider(config, (value) => value);

        await expect(
            collect(provider(context, new AbortController().signal)),
        ).rejects.toThrow("模型服务暂时不可用");
    });

    it("AbortSignal 只调用一次 cancel_ai", async () => {
        const streamCommand = deferred<void>();
        mocks.invoke.mockImplementation((command: string, _args: unknown) => {
            if (command === "stream_ai") return streamCommand.promise;
            return Promise.resolve();
        });
        const controller = new AbortController();
        const provider = createOpenAICompatibleProvider(config, (value) => value);
        const iterator = provider(context, controller.signal)[Symbol.asyncIterator]();
        const first = iterator.next();
        await vi.waitFor(() =>
            expect(mocks.invoke.mock.calls.some(([name]) => name === "stream_ai")).toBe(
                true,
            ),
        );

        controller.abort();
        controller.abort();
        streamCommand.resolve();
        await expect(first).resolves.toMatchObject({ done: true });

        expect(
            mocks.invoke.mock.calls.filter(([name]) => name === "cancel_ai"),
        ).toHaveLength(1);
    });

    it("预先中止时只取消一次且不启动 stream_ai 或残留 listener", async () => {
        const controller = new AbortController();
        controller.abort();
        const addEventListener = vi.spyOn(controller.signal, "addEventListener");
        const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
        mocks.invoke.mockResolvedValue(undefined);
        const provider = createOpenAICompatibleProvider(config, (value) => value);

        await expect(collect(provider(context, controller.signal))).resolves.toEqual([]);

        expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual(["cancel_ai"]);
        expect(addEventListener).not.toHaveBeenCalled();
        expect(removeEventListener).not.toHaveBeenCalled();
    });

    it("中止会主动唤醒事件队列并在命令结束后终止迭代", async () => {
        const streamCommand = deferred<void>();
        mocks.invoke.mockImplementation((command: string) => {
            if (command === "stream_ai") return streamCommand.promise;
            return Promise.resolve();
        });
        const controller = new AbortController();
        const provider = createOpenAICompatibleProvider(config, (value) => value);
        const result = collect(provider(context, controller.signal));
        let settled = false;
        void result.finally(() => {
            settled = true;
        });
        await vi.waitFor(() =>
            expect(mocks.invoke.mock.calls.some(([name]) => name === "stream_ai")).toBe(
                true,
            ),
        );

        controller.abort();
        await Promise.resolve();
        expect(settled).toBe(false);

        streamCommand.resolve();
        await expect(result).resolves.toEqual([]);
    });

    it.each([
        { baseUrl: "", model: "example-model" },
        { baseUrl: "https://api.example.com/v1", model: "" },
    ])("配置不完整时不会调用 stream_ai: $baseUrl / $model", async (aiConfig) => {
        const provider = createOpenAICompatibleProvider(
            () => aiConfig,
            (value) => value,
        );

        await expect(
            collect(provider(context, new AbortController().signal)),
        ).rejects.toThrow();
        expect(mocks.invoke.mock.calls.some(([name]) => name === "stream_ai")).toBe(
            false,
        );
    });

    it("在 IPC 前规范化 document 与 selection 中的 Blob URL", async () => {
        const blobUrl = "blob:http://localhost/resource-1";
        let requestPayload: unknown;
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") {
                requestPayload = (args as { request: unknown }).request;
                emit(args, { type: "done" });
            }
            return Promise.resolve();
        });
        const canonicalizeMarkdown = vi.fn((markdown: string) =>
            markdown.split(blobUrl).join("assets/image.png"),
        );
        const provider = createOpenAICompatibleProvider(config, canonicalizeMarkdown);
        const blobContext: AIPromptContext = {
            document: `![整篇](${blobUrl})`,
            selection: `![选区](${blobUrl})`,
            instruction: "描述图片",
        };

        await collect(provider(blobContext, new AbortController().signal));

        expect(canonicalizeMarkdown.mock.calls).toEqual([
            [blobContext.document],
            [blobContext.selection],
        ]);
        expect(requestPayload).toMatchObject({
            document: "![整篇](assets/image.png)",
            selection: "![选区](assets/image.png)",
        });
        expect(JSON.stringify(requestPayload)).not.toContain(blobUrl);
    });

    it("把 stream_ai 启动失败传给正在等待的迭代器", async () => {
        mocks.invoke.mockRejectedValue(new Error("未找到 API Key"));
        const provider = createOpenAICompatibleProvider(config, (value) => value);

        await expect(
            collect(provider(context, new AbortController().signal)),
        ).rejects.toThrow("未找到 API Key");
    });

    it("收到 done 后仍等待 stream_ai 命令完成", async () => {
        const streamCommand = deferred<void>();
        let streamArgs: unknown;
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") {
                streamArgs = args;
                return streamCommand.promise;
            }
            return Promise.resolve();
        });
        const provider = createOpenAICompatibleProvider(config, (value) => value);
        const result = collect(provider(context, new AbortController().signal));
        let settled = false;
        void result.then(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(streamArgs).toBeDefined());

        emit(streamArgs, { type: "done" });
        await Promise.resolve();
        expect(settled).toBe(false);

        streamCommand.resolve();
        await expect(result).resolves.toEqual([]);
    });

    it("协议 error 优先且等待后续 stream_ai rejection 被观察", async () => {
        const streamCommand = deferred<void>();
        let streamArgs: unknown;
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") {
                streamArgs = args;
                return streamCommand.promise;
            }
            return Promise.resolve();
        });
        const provider = createOpenAICompatibleProvider(config, (value) => value);
        const result = collect(provider(context, new AbortController().signal));
        let settled = false;
        void result.catch(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(streamArgs).toBeDefined());

        emit(streamArgs, {
            type: "error",
            code: "AI_REMOTE",
            message: "模型返回了协议错误",
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        streamCommand.reject(new Error("命令随后失败"));
        await expect(result).rejects.toThrow("模型返回了协议错误");
    });
});
