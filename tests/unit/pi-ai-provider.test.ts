import { describe, expect, test } from "bun:test";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import type { ProviderEvent } from "../../src/core/events.ts";
import type { Message } from "../../src/core/messages.ts";
import {
  PiAiProvider,
  translateContext,
  type CredentialResolver,
} from "../../src/providers/pi-ai-provider.ts";
import { resolvePromptCacheRetention } from "../../src/providers/prompt-cache.ts";
import type { ProviderRequest } from "../../src/providers/types.ts";

const model = makeModel("provider-one", "model-one", "https://one.test/v1");

describe("prompt cache policy", () => {
  test("defaults to aggressive retention and honors Pi's environment override", () => {
    expect(resolvePromptCacheRetention({})).toBe("long");
    expect(resolvePromptCacheRetention({ PI_CACHE_RETENTION: "short" })).toBe("short");
    expect(resolvePromptCacheRetention({ PI_CACHE_RETENTION: "none" })).toBe("none");
    expect(resolvePromptCacheRetention({ PI_CACHE_RETENTION: "invalid" })).toBe("long");
  });
});

describe("pi-ai message and tool translation", () => {
  test("builds exact timestamped pi-ai history with ordered assistant blocks", () => {
    const messages: Message[] = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        thinking: "first think",
        content: "then answer",
        toolCalls: [{ id: "call-one", name: "read", arguments: '{"path":"a.ts"}' }],
        usage: {
          inputTokens: 4,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 12,
          cost: 0.25,
        },
        provider: "origin-provider",
        api: "anthropic-messages",
        model: "origin-model",
        timestamp: 50,
      },
      {
        role: "tool",
        toolCallId: "call-one",
        name: "read",
        content: "contents",
        isError: false,
      },
    ];

    const context = translateContext(
      messages,
      [
        {
          name: "read",
          description: "read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      model,
      100,
      ["brisk base", "tool catalog"],
    );

    expect(context.systemPrompt).toEqual(["brisk base", "tool catalog"]);
    expect(context.messages[0]).toEqual({ role: "user", content: "inspect", timestamp: 97 });
    const assistant = context.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant message");
    expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
    expect(assistant).toMatchObject({
      api: "anthropic-messages",
      provider: "origin-provider",
      model: "origin-model",
      timestamp: 50,
      stopReason: "toolUse",
      usage: {
        input: 4,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 12,
        cost: { total: 0.25 },
      },
    });
    expect(assistant.content[2]).toMatchObject({
      type: "toolCall",
      arguments: { path: "a.ts" },
    });
    expect(context.messages[2]).toEqual({
      role: "toolResult",
      toolCallId: "call-one",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 99,
    });
    expect(context.tools?.[0]).toMatchObject({
      name: "read",
      parameters: { type: "object", required: ["path"] },
    });
  });

  test("replays provider-native blocks and signatures without reshaping the cached prefix", () => {
    const context = translateContext(
      [
        {
          role: "assistant",
          content: "answer",
          thinking: "reasoning",
          toolCalls: [],
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-test",
          providerReplay: {
            content: [
              {
                type: "thinking",
                thinking: "reasoning",
                thinkingSignature: "signed-thinking",
              },
              { type: "text", text: "answer", textSignature: "signed-text" },
            ],
            responseId: "response-one",
            stopReason: "stop",
          },
        },
      ],
      [],
      model,
      100,
    );

    expect(context.messages[0]).toMatchObject({
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
      responseId: "response-one",
      content: [
        { type: "thinking", thinkingSignature: "signed-thinking" },
        { type: "text", textSignature: "signed-text" },
      ],
    });
  });

  test("keeps user text scalar for image-capable models instead of inventing image blocks", () => {
    const vision = makeModel("provider-one", "vision-model", "https://one.test/v1", [
      "text",
      "image",
    ]);
    const context = translateContext([{ role: "user", content: "plain text" }], [], vision, 10);
    expect(context.messages[0]).toEqual({ role: "user", content: "plain text", timestamp: 9 });
  });

  test("translates explicit images exactly for vision and never sends them to text-only models", () => {
    const imageMessage: Message = {
      role: "user",
      content: "inspect frame",
      images: [
        {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
          detail: "original",
        },
      ],
      timestamp: 42,
    };
    const vision = makeModel("provider-one", "vision-model", "https://one.test/v1", [
      "text",
      "image",
    ]);

    expect(translateContext([imageMessage], [], vision, 100).messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect frame" },
        { type: "image", data: "AQID", mimeType: "image/png", detail: "original" },
      ],
      timestamp: 42,
    });
    expect(translateContext([imageMessage], [], model, 100).messages[0]).toEqual({
      role: "user",
      content: "inspect frame",
      timestamp: 42,
    });
    expect(
      translateContext(
        [
          {
            role: "user",
            content: "",
            images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          },
        ],
        [],
        model,
        100,
      ).messages[0],
    ).toEqual({
      role: "user",
      content: "[image omitted: selected model does not accept image input]",
      timestamp: 99,
    });
  });
});

describe("PiAiProvider stream adapter", () => {
  test("resolves session auth, passes options, normalizes events, and supports model changes", async () => {
    const apiKey = "BRISK_TEST_STREAM_KEY";
    const authCalls: { provider: string; sessionId?: string; modelId?: string }[] = [];
    const auth: CredentialResolver = {
      async getApiKey(provider, sessionId, options) {
        authCalls.push({
          provider,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
        });
        return apiKey;
      },
    };
    const captures: { model: Model; context: Context; options: SimpleStreamOptions }[] = [];
    const warmed: string[] = [];
    const provider = new PiAiProvider({
      model,
      auth,
      sessionId: "session-test",
      cacheRetention: "long",
      reasoning: "high" as Effort,
      preconnect: (url) => warmed.push(url),
      stream: (selected, context, options) => {
        captures.push({ model: selected, context, options });
        return successfulStream(selected);
      },
    });

    const first = await collect(provider, {
      ...request("model-one"),
      maxOutputTokens: 42,
    });
    provider.setReasoning("off");
    const secondModel = makeModel("provider-two", "model-two", "https://two.test/v1");
    provider.setModel(secondModel);
    const second = await collect(provider, request("model-two"));
    await Promise.resolve();

    expect(first.map((event) => event.type)).toEqual([
      "response_start",
      "text_delta",
      "usage",
      "response_end",
    ]);
    expect(second.at(-1)).toMatchObject({ type: "response_end", stopReason: "stop" });
    expect(authCalls).toEqual([
      { provider: "provider-one", sessionId: "session-test", modelId: "model-one" },
      { provider: "provider-two", sessionId: "session-test", modelId: "model-two" },
    ]);
    expect(captures[0]?.options).toMatchObject({
      apiKey,
      sessionId: "session-test",
      cacheRetention: "long",
      reasoning: "high",
      statefulResponses: false,
      maxTokens: 42,
    });
    expect(captures[0]?.options.providerSessionState).toBeInstanceOf(Map);
    expect(captures[0]?.context.systemPrompt).toEqual(["test system prompt"]);
    expect(captures[1]?.options.providerSessionState).toBe(
      captures[0]?.options.providerSessionState,
    );
    expect(captures[1]?.options.disableReasoning).toBe(true);
    expect(captures[1]?.model.id).toBe("model-two");
    expect(provider.model).toBe(secondModel);
    expect(warmed).toEqual(["https://one.test/v1", "https://two.test/v1"]);
    expect(JSON.stringify(first)).not.toContain(apiKey);
  });

  test("closes provider-owned session state when the logical session changes", async () => {
    let state: Map<string, { close(): void }> | undefined;
    let closes = 0;
    const provider = new PiAiProvider({
      model,
      auth: {
        async getApiKey() {
          return "BRISK_TEST_STATE_KEY";
        },
      },
      sessionId: "session-one",
      preconnect: () => undefined,
      stream: (selected, _context, options) => {
        state = options.providerSessionState;
        state?.set("test", { close: () => (closes += 1) });
        return successfulStream(selected);
      },
    });

    await collect(provider, request("model-one"));
    provider.setSessionId("session-two");
    expect(closes).toBe(1);
    expect(state?.size).toBe(0);
    provider.close();
    expect(closes).toBe(1);
  });

  test("converts thrown upstream failures to redacted normalized error events", async () => {
    const apiKey = "BRISK_TEST_THROWN_KEY";
    const provider = new PiAiProvider({
      model,
      auth: {
        async getApiKey() {
          return apiKey;
        },
      },
      preconnect: () => undefined,
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<AssistantMessageEvent>> {
              return Promise.reject(new ProviderHttpError(`Authorization: Bearer ${apiKey}`, 503));
            },
          };
        },
      }),
    });

    const events = await collect(provider, request("model-one"));
    const error = events[0];
    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("expected error event");
    expect(error.error).toMatchObject({ kind: "network", retryable: true, status: 503 });
    expect(error.error.message).not.toContain(apiKey);
    expect(error.error.message).toContain("[REDACTED]");
  });

  test("short-circuits a pre-aborted request as a normalized abort", async () => {
    let authCalls = 0;
    const provider = new PiAiProvider({
      model,
      auth: {
        async getApiKey() {
          authCalls += 1;
          return undefined;
        },
      },
      preconnect: () => undefined,
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(provider, { ...request("model-one"), signal: controller.signal });

    expect(authCalls).toBe(0);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") expect(events[0].error.kind).toBe("aborted");
  });
});

function successfulStream(selected: Model): AsyncIterable<AssistantMessageEvent> {
  const partial = piAssistant(selected, []);
  const done = piAssistant(selected, [{ type: "text", text: "ok" }]);
  return (async function* () {
    yield { type: "start", partial } satisfies AssistantMessageEvent;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: "ok",
      partial: done,
    } satisfies AssistantMessageEvent;
    yield { type: "done", reason: "stop", message: done } satisfies AssistantMessageEvent;
  })();
}

function piAssistant(selected: Model, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function makeModel(
  provider: string,
  id: string,
  baseUrl: string,
  input: ("text" | "image")[] = ["text"],
): Model<"openai-completions"> {
  return buildModel({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });
}

function request(modelId: string): ProviderRequest {
  return {
    systemPrompt: ["test system prompt"],
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    signal: new AbortController().signal,
    model: modelId,
  };
}

async function collect(
  provider: PiAiProvider,
  providerRequest: ProviderRequest,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(providerRequest)) events.push(event);
  return events;
}
