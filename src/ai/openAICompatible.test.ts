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
        let streamArgs: unknown;
        mocks.invoke.mockImplementation((command: string, args: unknown) => {
            if (command === "stream_ai") streamArgs = args;
            return Promise.resolve();
        });
        const controller = new AbortController();
        const provider = createOpenAICompatibleProvider(config, (value) => value);
        const iterator = provider(context, controller.signal)[Symbol.asyncIterator]();
        const first = iterator.next();
        await vi.waitFor(() => expect(streamArgs).toBeDefined());

        controller.abort();
        controller.abort();
        emit(streamArgs, { type: "done" });
        await first;

        expect(
            mocks.invoke.mock.calls.filter(([name]) => name === "cancel_ai"),
        ).toHaveLength(1);
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
});
