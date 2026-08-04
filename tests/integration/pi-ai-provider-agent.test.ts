import { expect, test } from "bun:test";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  ToolResultMessage as PiToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { JsonValue } from "../../src/core/messages.ts";
import { PiAiProvider } from "../../src/providers/pi-ai-provider.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

test("AgentLoop retains upstream identity when PiAiProvider changes models between turns", async () => {
  const first = makeModel("first-provider", "first-model");
  const second = makeModel("second-provider", "second-model");
  const contexts: Context[] = [];
  const provider = new PiAiProvider({
    model: first,
    auth: {
      async getApiKey() {
        return "BRISK_TEST_INTEGRATION_KEY";
      },
    },
    preconnect: () => undefined,
    stream: (model, context) => {
      contexts.push(context);
      return completion(model, model.id, model === first);
    },
  });
  const loop = new AgentLoop({
    provider,
    model: "first-provider/first-model",
    additionalSystemPrompt: ["user AGENTS", "repository AGENTS"],
  });

  await loop.submit("first turn");
  provider.setModel(second);
  await loop.submit("second turn");

  expect(contexts[0]?.systemPrompt?.[0]).toContain("The user is your sole principal");
  expect(contexts[0]?.systemPrompt?.slice(1, 3)).toEqual(["user AGENTS", "repository AGENTS"]);
  expect(contexts[0]?.systemPrompt?.[3]).toContain("Session role: root agent");
  expect(contexts[0]?.messages[0]).toMatchObject({ role: "user", content: "first turn" });
  expect(loop.messages[1]).toMatchObject({
    role: "assistant",
    content: "first-model",
    provider: "first-provider",
    api: "openai-completions",
    model: "first-model",
  });
  const replayed = contexts[1]?.messages[1];
  expect(replayed).toMatchObject({
    role: "assistant",
    provider: "first-provider",
    model: "first-model",
    content: [
      { type: "thinking", thinkingSignature: "first-signature" },
      { type: "text", text: "first-model" },
    ],
  });
});

test("Cursor exec calls run inside the stream with authoritative final arguments", async () => {
  const cursorModel = makeCursorModel();
  let turn = 0;
  const executed: JsonValue[] = [];
  const tools = new ToolRegistry().register({
    name: "read",
    description: "read fixture",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: true,
    parallelSafe: true,
    execute(arguments_: JsonValue) {
      executed.push(arguments_);
      return { content: "fixture contents" };
    },
  });
  const provider = new PiAiProvider({
    model: cursorModel,
    auth: {
      async getApiKey() {
        return "BRISK_TEST_CURSOR_KEY";
      },
    },
    preconnect: () => undefined,
    stream: (model, _context, options) => {
      turn += 1;
      return turn === 1
        ? cursorToolCompletion(model, options)
        : completion(model, "survey complete");
    },
  });
  const loop = new AgentLoop({ provider, tools, model: "cursor/composer-2.5" });

  await loop.submit("inspect fixture");

  expect(executed).toEqual([{ path: "AGENTS.md" }]);
  expect(loop.messages).toHaveLength(4);
  expect(loop.messages[1]).toMatchObject({
    role: "assistant",
    toolCalls: [{ id: "cursor-read", name: "read", arguments: '{"path":"AGENTS.md"}' }],
  });
  expect(loop.messages[2]).toEqual({
    role: "tool",
    toolCallId: "cursor-read",
    name: "read",
    content: "fixture contents",
    isError: false,
  });
  expect(loop.messages[3]).toMatchObject({ role: "assistant", content: "survey complete" });
});

function completion(
  model: Model,
  text: string,
  signed = false,
): AsyncIterable<AssistantMessageEvent> {
  const start = message(model, []);
  const done = message(model, [
    ...(signed
      ? [
          {
            type: "thinking" as const,
            thinking: "first reasoning",
            thinkingSignature: "first-signature",
          },
        ]
      : []),
    { type: "text", text },
  ]);
  return (async function* () {
    yield { type: "start", partial: start } satisfies AssistantMessageEvent;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: done,
    } satisfies AssistantMessageEvent;
    yield { type: "done", reason: "stop", message: done } satisfies AssistantMessageEvent;
  })();
}

function cursorToolCompletion(
  model: Model,
  options: SimpleStreamOptions,
): AsyncIterable<AssistantMessageEvent> {
  const block = {
    type: "toolCall" as const,
    id: "cursor-read",
    name: "read",
    arguments: {},
    [kCursorExecResolved]: true as const,
  };
  const start = message(model, []);
  const done = message(model, [block]);
  return (async function* () {
    yield { type: "start", partial: start } satisfies AssistantMessageEvent;
    yield {
      type: "toolcall_start",
      contentIndex: 0,
      partial: done,
    } satisfies AssistantMessageEvent;
    const result = await options.cursorExecHandlers?.mcp?.({
      name: "read",
      providerIdentifier: "pi-agent",
      toolName: "read",
      toolCallId: "cursor-read",
      args: { path: "AGENTS.md" },
      rawArgs: {},
    });
    if (!isPiToolResult(result)) throw new Error("expected Cursor tool result");
    await options.cursorOnToolResult?.(result);
    block.arguments = { path: "AGENTS.md" };
    yield {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: block,
      partial: done,
    } satisfies AssistantMessageEvent;
    yield { type: "done", reason: "toolUse", message: done } satisfies AssistantMessageEvent;
  })();
}

function isPiToolResult(value: unknown): value is PiToolResultMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly role?: unknown }).role === "toolResult"
  );
}

function message(model: Model, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeCursorModel(): Model<"cursor-agent"> {
  return buildModel({
    id: "composer-2.5",
    name: "Composer 2.5",
    api: "cursor-agent",
    provider: "cursor",
    baseUrl: "https://cursor.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  });
}

function makeModel(provider: string, id: string): Model<"openai-completions"> {
  return buildModel({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });
}
