import type { AIPromptContext } from "@milkdown/crepe/feature/ai";
import { Channel, invoke } from "@tauri-apps/api/core";

export type AiStreamEvent =
    | { type: "delta"; text: string }
    | { type: "done" }
    | { type: "error"; code: string; message: string };

export type AiConfig = {
    baseUrl: string;
    model: string;
};

export type MoraAIProvider = (
    context: AIPromptContext,
    signal: AbortSignal,
) => AsyncIterable<string>;

type AiRequest = AiConfig & AIPromptContext;

function commandErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "AI 命令执行失败";
}

function createEventQueue() {
    const events: AiStreamEvent[] = [];
    let waiting: ((event: AiStreamEvent) => void) | undefined;
    let closed = false;

    function deliver(event: AiStreamEvent) {
        if (waiting) {
            const resolve = waiting;
            waiting = undefined;
            resolve(event);
            return;
        }
        events.push(event);
    }

    return {
        push(event: AiStreamEvent) {
            if (closed) return;
            if (event.type !== "delta") closed = true;
            deliver(event);
        },
        stop() {
            if (closed) return;
            closed = true;
            events.length = 0;
            deliver({ type: "done" });
        },
        next(): Promise<AiStreamEvent> {
            const event = events.shift();
            if (event) return Promise.resolve(event);
            return new Promise((resolve) => {
                waiting = resolve;
            });
        },
    };
}

export function createOpenAICompatibleProvider(
    getConfig: () => AiConfig,
    canonicalizeMarkdown: (markdown: string) => string,
): MoraAIProvider {
    return async function* (context, signal) {
        const configured = getConfig();
        const baseUrl = configured.baseUrl.trim();
        const model = configured.model.trim();
        if (!baseUrl) throw new Error("请先配置 AI Base URL");
        if (!model) throw new Error("请先配置 AI 模型");

        if (signal.aborted) {
            await invoke<void>("cancel_ai").catch(() => undefined);
            return;
        }

        const request: AiRequest = {
            baseUrl,
            model,
            document: canonicalizeMarkdown(context.document),
            selection: canonicalizeMarkdown(context.selection),
            instruction: context.instruction,
        };
        const queue = createEventQueue();
        const channel = new Channel<AiStreamEvent>();
        channel.onmessage = (event) => queue.push(event);

        let cancelRequested = false;
        const handleAbort = () => {
            if (cancelRequested) return;
            cancelRequested = true;
            queue.stop();
            void invoke<void>("cancel_ai").catch(() => undefined);
        };
        signal.addEventListener("abort", handleAbort, { once: true });

        const handledInvoke = invoke<void>("stream_ai", {
            request,
            onEvent: channel,
        }).catch((error: unknown) => {
            queue.push({
                type: "error",
                code: "AI_COMMAND",
                message: commandErrorMessage(error),
            });
        });

        try {
            while (true) {
                const event = await queue.next();
                if (event.type === "delta") {
                    yield event.text;
                    continue;
                }
                if (event.type === "done") return;
                throw new Error(event.message);
            }
        } finally {
            signal.removeEventListener("abort", handleAbort);
            await handledInvoke;
        }
    };
}
