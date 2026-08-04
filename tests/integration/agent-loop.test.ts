import { describe, expect, test } from "bun:test";

import { ContextManager } from "../../src/context/context-manager.ts";
import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { AgentEvent, NormalizedProviderError } from "../../src/core/events.ts";
import type { JsonValue } from "../../src/core/messages.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const valueSchema = {
  type: "object" as const,
  properties: { value: { type: "string" as const } },
  required: ["value"],
  additionalProperties: false,
};

describe("AgentLoop streaming and tools", () => {
  test("hydrates prior messages and usage and supports model changes between turns", async () => {
    const provider = new FakeProvider([
      { text: "continued", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const loop = new AgentLoop({
      provider,
      model: "fake/old",
      initialMessages: [
        { role: "user", content: "prior question" },
        { role: "assistant", content: "prior answer", toolCalls: [] },
      ],
      initialUsage: { inputTokens: 10, outputTokens: 5, cost: 0.1 },
    });

    loop.setModel("fake/new");
    await loop.submit("continue");

    expect(loop.modelId).toBe("fake/new");
    expect(provider.requests[0]?.model).toBe("fake/new");
    expect(provider.requests[0]?.messages.slice(0, 2)).toEqual([
      { role: "user", content: "prior question" },
      { role: "assistant", content: "prior answer", toolCalls: [] },
    ]);
    expect(loop.usage).toEqual({ inputTokens: 13, outputTokens: 7, cost: 0.1 });
  });

  test("supplies the built-in prompt and refreshes its exact tool catalog", async () => {
    const provider = new FakeProvider([{ text: "first" }, { text: "second" }]);
    const tools = new ToolRegistry().register<ValueArguments>({
      name: "first_tool",
      description: "the first tool",
      inputSchema: valueSchema,
      parse: parseValueArguments,
      execute: (input) => ({ content: input.value }),
    });
    const loop = new AgentLoop({
      provider,
      tools,
      model: "fake",
      additionalSystemPrompt: ["user AGENTS", "repository AGENTS"],
    });

    await loop.submit("one");
    tools.register<ValueArguments>({
      name: "second_tool",
      description: "the second tool",
      inputSchema: valueSchema,
      parse: parseValueArguments,
      execute: (input) => ({ content: input.value }),
    });
    await loop.submit("two");

    expect(provider.requests[0]?.systemPrompt[0]).toContain("The user is your sole principal");
    expect(provider.requests[0]?.systemPrompt.slice(1, 3)).toEqual([
      "user AGENTS",
      "repository AGENTS",
    ]);
    expect(provider.requests[0]?.systemPrompt[3]).toContain("Session role: root agent");
    expect(provider.requests[0]?.systemPrompt[4]).toContain('"name":"first_tool"');
    expect(provider.requests[0]?.systemPrompt[4]).not.toContain('"name":"second_tool"');
    expect(provider.requests[1]?.systemPrompt[4]).toContain('"name":"second_tool"');
  });

  test("assembles partial arguments and streams thinking, text, tools, and usage", async () => {
    const provider = new FakeProvider([
      {
        thinking: ["plan", " carefully"],
        text: ["checking", " now"],
        toolCalls: [
          {
            id: "call-1",
            name: "echo",
            argumentChunks: ['{"value":', '"assembled"}'],
          },
        ],
        usage: { inputTokens: 2, outputTokens: 3, cost: 0.01 },
      },
      {
        text: ["tool said ", "assembled"],
        usage: { inputTokens: 4, outputTokens: 5, cost: 0.02 },
      },
    ]);
    const tools = new ToolRegistry().register<ValueArguments>({
      name: "echo",
      description: "echo a value",
      inputSchema: valueSchema,
      readOnly: true,
      parallelSafe: true,
      parse: parseValueArguments,
      execute(arguments_) {
        return { content: arguments_.value };
      },
    });
    const loop = new AgentLoop({ provider, tools, model: "fake" });
    const events: AgentEvent[] = [];
    const unsubscribe = loop.subscribe((event) => events.push(event));

    await loop.submit("inspect");
    unsubscribe();

    expect(loop.messages).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "checking now",
        thinking: "plan carefully",
        toolCalls: [{ id: "call-1", name: "echo", arguments: '{"value":"assembled"}' }],
        usage: { inputTokens: 2, outputTokens: 3, cost: 0.01 },
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "echo",
        content: "assembled",
      },
      {
        role: "assistant",
        content: "tool said assembled",
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 5, cost: 0.02 },
      },
    ]);
    expect(loop.usage).toEqual({ inputTokens: 6, outputTokens: 8, cost: 0.03 });
    expect(
      events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ).toEqual(["plan", " carefully"]);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ).toEqual(["checking", " now", "tool said ", "assembled"]);
    expect(provider.requests[1]?.messages).toHaveLength(3);
  });

  test("turns malformed call JSON into an ordered tool error and continues", async () => {
    let executed = false;
    const tools = new ToolRegistry().register<ValueArguments>({
      name: "echo",
      description: "echo",
      inputSchema: valueSchema,
      parse: parseValueArguments,
      execute(arguments_) {
        executed = true;
        return { content: arguments_.value };
      },
    });
    const provider = new FakeProvider([
      {
        toolCalls: [
          { id: "broken", name: "echo", argumentChunks: ['{"value":', '"unterminated"'] },
        ],
      },
      { text: "recovered" },
    ]);
    const loop = new AgentLoop({ provider, tools, model: "fake" });

    await loop.submit("go");

    expect(executed).toBe(false);
    expect(loop.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "broken",
      isError: true,
    });
    const result = loop.messages[2];
    expect(result?.role === "tool" ? result.content : "").toContain("Invalid arguments for echo");
    expect(loop.messages.at(-1)).toMatchObject({ role: "assistant", content: "recovered" });
  });

  test("overlaps two parallel reads but appends results in provider call order", async () => {
    let active = 0;
    let maximumActive = 0;
    const tools = new ToolRegistry().register<DelayArguments>({
      name: "delayed_read",
      description: "read after a delay",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
          delayMs: { type: "number" },
        },
        required: ["value", "delayMs"],
      },
      readOnly: true,
      parallelSafe: true,
      parse: parseDelayArguments,
      async execute(arguments_) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(arguments_.delayMs);
        active -= 1;
        return { content: arguments_.value };
      },
    });
    const provider = new FakeProvider([
      {
        toolCalls: [
          {
            id: "first",
            name: "delayed_read",
            arguments: { value: "one", delayMs: 20 },
          },
          {
            id: "second",
            name: "delayed_read",
            arguments: { value: "two", delayMs: 2 },
          },
        ],
      },
      { text: "done" },
    ]);
    const loop = new AgentLoop({ provider, tools, model: "fake" });

    await loop.submit("read both");

    expect(maximumActive).toBe(2);
    const results = loop.messages.filter((message) => message.role === "tool");
    expect(results.map((result) => result.toolCallId)).toEqual(["first", "second"]);
    expect(results.map((result) => result.content)).toEqual(["one", "two"]);
  });

  test("keeps a valid empty assistant response", async () => {
    const loop = new AgentLoop({ provider: new FakeProvider([{}]), model: "fake" });
    await loop.submit("empty is valid");
    expect(loop.messages.at(-1)).toEqual({ role: "assistant", content: "", toolCalls: [] });
  });
});

describe("AgentLoop failures and retries", () => {
  test("retries bounded retryable failures before deltas", async () => {
    const provider = new FakeProvider([
      { error: { kind: "network", message: "one", retryAfter: 1 } },
      { error: { kind: "rate_limit", message: "two", retryAfter: 1 } },
      { text: "success" },
    ]);
    const loop = new AgentLoop({
      provider,
      model: "fake",
      maxRetries: 2,
      retryDelayMs: 1,
    });

    await loop.submit("retry");

    expect(provider.requestCount).toBe(3);
    expect(loop.messages.at(-1)).toMatchObject({ role: "assistant", content: "success" });
  });

  test("stops after the retry bound and never retries after a content delta", async () => {
    const boundedProvider = new FakeProvider([
      { error: { kind: "network", message: "one" } },
      { error: { kind: "network", message: "two" } },
      { error: { kind: "network", message: "three" } },
    ]);
    const boundedLoop = new AgentLoop({
      provider: boundedProvider,
      model: "fake",
      maxRetries: 2,
      retryDelayMs: 1,
    });
    await expect(boundedLoop.submit("bounded")).rejects.toMatchObject({
      kind: "network",
      message: "three",
    });
    expect(boundedProvider.requestCount).toBe(3);

    const partialProvider = new FakeProvider([
      { text: "partial", error: { kind: "network", message: "after content" } },
      { text: "must not run" },
    ]);
    const partialLoop = new AgentLoop({
      provider: partialProvider,
      model: "fake",
      maxRetries: 3,
      retryDelayMs: 1,
    });
    await expect(partialLoop.submit("no retry")).rejects.toMatchObject({
      kind: "network",
      message: "after content",
    });
    expect(partialProvider.requestCount).toBe(1);
    expect(partialLoop.messages).toEqual([{ role: "user", content: "no retry" }]);
  });

  test("surfaces auth and context overflow errors without retrying", async () => {
    for (const fixture of [
      { kind: "auth" as const, status: 401 },
      { kind: "context_overflow" as const, status: 400 },
    ]) {
      const provider = new FakeProvider([
        { error: { kind: fixture.kind, message: fixture.kind, status: fixture.status } },
      ]);
      const loop = new AgentLoop({ provider, model: "fake", maxRetries: 3 });
      let reported: NormalizedProviderError | undefined;
      loop.subscribe((event) => {
        if (event.type === "error") reported = event.error;
      });

      await expect(loop.submit(fixture.kind)).rejects.toMatchObject({
        kind: fixture.kind,
        status: fixture.status,
        retryable: false,
      });
      expect(reported).toMatchObject({ kind: fixture.kind, status: fixture.status });
      expect(provider.requestCount).toBe(1);
    }
  });

  test("force-compacts once on pre-delta context overflow and resumes transparently", async () => {
    const provider = new FakeProvider([
      { error: { kind: "context_overflow", message: "too large", status: 400 } },
      { text: "resumed" },
    ]);
    const initialMessages = [
      { role: "user" as const, content: "old request" },
      { role: "assistant" as const, content: "old decision", toolCalls: [] },
    ];
    const contextLifecycle = new ContextManager({
      model: {
        provider: "openai",
        api: "openai-completions",
        model: "fake",
        contextWindow: 100_000,
        supportsImages: false,
      },
      initialMessages,
      recentTargetTokens: 10,
      maxFrames: 1,
    });
    const loop = new AgentLoop({
      provider,
      model: "fake",
      initialMessages,
      contextLifecycle,
      maxRetries: 0,
    });

    await loop.submit("outstanding tail");

    expect(provider.requestCount).toBe(2);
    expect(provider.requests[0]?.messages).toEqual(
      initialMessages.concat({
        role: "user",
        content: "outstanding tail",
      }),
    );
    expect(provider.requests[1]?.messages[0]?.content).toContain("TEXT-ONLY FALLBACK");
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "outstanding tail",
    });
    expect(loop.messages).toEqual([
      ...initialMessages,
      { role: "user", content: "outstanding tail" },
      { role: "assistant", content: "resumed", toolCalls: [] },
    ]);
    expect(contextLifecycle.inspect().compactionCount).toBe(1);
  });
});

describe("AgentLoop cancellation and queueing", () => {
  test("cancels a delayed stream promptly", async () => {
    const provider = new FakeProvider([{ delayMs: 100, text: "late" }]);
    const loop = new AgentLoop({ provider, model: "fake" });
    const types: string[] = [];
    loop.subscribe((event) => types.push(event.type));

    const submission = loop.submit("cancel stream");
    await waitUntil(() => provider.requestCount === 1);
    loop.cancel();
    await withTimeout(submission, 40);

    expect(loop.messages).toEqual([{ role: "user", content: "cancel stream" }]);
    expect(types).toContain("cancelled");
  });

  test("drops an assistant call and ignores a late tool completion after cancellation", async () => {
    let toolStarted = false;
    let toolCompleted = false;
    const tools = new ToolRegistry(500).register<ValueArguments>({
      name: "ignores_abort",
      description: "a deliberately uncooperative tool",
      inputSchema: valueSchema,
      parse: parseValueArguments,
      execute(arguments_) {
        toolStarted = true;
        return new Promise((resolve) => {
          setTimeout(() => {
            toolCompleted = true;
            resolve({ content: arguments_.value });
          }, 50);
        });
      },
    });
    const provider = new FakeProvider([
      { toolCalls: [{ id: "late", name: "ignores_abort", arguments: { value: "late" } }] },
    ]);
    const loop = new AgentLoop({ provider, tools, model: "fake" });

    const submission = loop.submit("cancel tool");
    await waitUntil(() => toolStarted);
    loop.cancel();
    await withTimeout(submission, 40);
    expect(loop.messages).toEqual([{ role: "user", content: "cancel tool" }]);

    await Bun.sleep(60);
    expect(toolCompleted).toBe(true);
    expect(loop.messages).toEqual([{ role: "user", content: "cancel tool" }]);
  });

  test("queues a normal follow-up without interrupting the active turn", async () => {
    const provider = new FakeProvider([
      { delayMs: 20, text: "first answer" },
      { text: "second answer" },
    ]);
    const loop = new AgentLoop({ provider, model: "fake" });

    const first = loop.submit("first");
    const second = loop.submit("second");
    await Promise.all([first, second]);

    expect(loop.messages.map(messageSummary)).toEqual([
      "user:first",
      "assistant:first answer",
      "user:second",
      "assistant:second answer",
    ]);
  });

  test("steering queues a follow-up, cancels only active work, and then processes it", async () => {
    const provider = new FakeProvider([
      { delayMs: 100, text: "obsolete" },
      { text: "steered answer" },
    ]);
    const loop = new AgentLoop({ provider, model: "fake" });
    const types: string[] = [];
    loop.subscribe((event) => types.push(event.type));

    const original = loop.submit("original");
    await waitUntil(() => provider.requestCount === 1);
    const steering = loop.steer("correction");
    await Promise.all([original, steering]);

    expect(loop.messages.map(messageSummary)).toEqual([
      "user:original",
      "user:correction",
      "assistant:steered answer",
    ]);
    expect(provider.requestCount).toBe(2);
    expect(types.filter((type) => type === "cancelled")).toHaveLength(1);
  });

  test("steer on an idle loop behaves as a normal submission", async () => {
    const loop = new AgentLoop({ provider: new FakeProvider([{ text: "answer" }]), model: "fake" });
    await loop.steer("question");
    expect(loop.messages.map(messageSummary)).toEqual(["user:question", "assistant:answer"]);
  });
});

interface ValueArguments {
  readonly value: string;
}

interface DelayArguments extends ValueArguments {
  readonly delayMs: number;
}

function parseValueArguments(value: JsonValue): ValueArguments {
  const object = requireObject(value);
  if (typeof object.value !== "string") throw new TypeError("value must be a string");
  return { value: object.value };
}

function parseDelayArguments(value: JsonValue): DelayArguments {
  const object = requireObject(value);
  if (typeof object.value !== "string" || typeof object.delayMs !== "number") {
    throw new TypeError("value and delayMs are required");
  }
  return { value: object.value, delayMs: object.delayMs };
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (!isJsonObject(value)) throw new TypeError("arguments must be an object");
  return value;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageSummary(message: AgentLoop["messages"][number]): string {
  return `${message.role}:${message.content}`;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not met");
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(milliseconds).then(() => {
      throw new Error("timed out");
    }),
  ]);
}
