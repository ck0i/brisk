import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { ProviderEvent } from "../../src/core/events.ts";
import type { JsonValue } from "../../src/core/messages.ts";
import {
  CursorSdkProvider,
  type CursorSdkAgent,
  type CursorSdkCreateOptions,
  type CursorSdkRun,
  type CursorSdkRunResult,
  type CursorSdkRuntime,
  type CursorSdkSendOptions,
  type CursorSdkUserMessage,
} from "../../src/providers/cursor-sdk-provider.ts";
import type { ProviderRequest } from "../../src/providers/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CursorSdkProvider", () => {
  test("streams SDK deltas and runs Brisk tools as custom tools", async () => {
    const store = await storeDirectory();
    const created: CursorSdkCreateOptions[] = [];
    const sent: Array<{
      readonly message: string | CursorSdkUserMessage;
      readonly options?: CursorSdkSendOptions;
    }> = [];
    const executed: JsonValue[] = [];
    const runtime = fakeRuntime(created, sent, {
      deltas: [
        { type: "thinking-delta", text: "inspect " },
        { type: "text-delta", text: "done" },
      ],
      result: {
        status: "finished",
        result: "done",
        usage: {
          inputTokens: 11,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          totalTokens: 18,
        },
      },
      invoke: ["read"],
    });
    const provider = new CursorSdkProvider({
      model: makeCursorModel(),
      auth: {
        async getApiKey() {
          return "BRISK_TEST_CURSOR_SDK_KEY";
        },
      },
      workspace: store,
      storeDirectory: store,
      sessionId: "session-one",
      runtime,
    });
    const tools = new ToolRegistry().register({
      name: "read",
      description: "read a file",
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
    const loop = new AgentLoop({ provider, tools, model: "cursor/composer-2.5" });

    await loop.submit("inspect fixture");

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      apiKey: "BRISK_TEST_CURSOR_SDK_KEY",
      model: { id: "composer-2.5" },
      tools: ["mcp"],
      local: { cwd: store, enableAgentRetries: false },
    });
    expect(sent).toHaveLength(1);
    const firstMessage = sent[0]?.message;
    expect(typeof firstMessage === "string" ? firstMessage : firstMessage?.text).toContain(
      "The user is your sole principal",
    );
    expect(typeof firstMessage === "string" ? firstMessage : firstMessage?.text).toContain(
      "inspect fixture",
    );
    expect(executed).toEqual([{ path: "AGENTS.md" }]);
    expect(loop.messages).toHaveLength(3);
    expect(loop.messages[1]).toMatchObject({
      role: "assistant",
      content: "done",
      thinking: "inspect ",
      toolCalls: [{ id: "cursor-read", name: "read", arguments: '{"path":"AGENTS.md"}' }],
    });
    expect(loop.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "cursor-read",
      content: "fixture contents",
    });
    provider.close();
  });

  test("reuses one agent for follow-up prompts and cancels an in-flight run", async () => {
    const store = await storeDirectory();
    const created: CursorSdkCreateOptions[] = [];
    const sent: Array<{
      readonly message: string | CursorSdkUserMessage;
      readonly options?: CursorSdkSendOptions;
    }> = [];
    let cancelCount = 0;
    const runtime = fakeRuntime(created, sent, {
      deltas: [{ type: "text-delta", text: "first" }],
      result: { status: "finished", result: "first" },
      hangOnSecondSend: true,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    const provider = new CursorSdkProvider({
      model: makeCursorModel(),
      auth: {
        async getApiKey() {
          return "BRISK_TEST_CURSOR_SDK_KEY";
        },
      },
      workspace: store,
      storeDirectory: store,
      sessionId: "session-two",
      runtime,
    });

    const first = await collect(
      provider,
      request({
        messages: [{ role: "user", content: "one" }],
      }),
    );
    expect(first.some((event) => event.type === "text_delta" && event.delta === "first")).toBe(
      true,
    );

    const controller = new AbortController();
    const second = collect(
      provider,
      request({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "first", toolCalls: [] },
          { role: "user", content: "two" },
        ],
        signal: controller.signal,
      }),
    );
    await waitFor(() => sent.length >= 2);
    controller.abort();
    const secondEvents = await second;
    expect(secondEvents.at(-1)).toMatchObject({ type: "error" });
    expect(cancelCount).toBe(1);
    expect(created).toHaveLength(1);
    expect(sent[1]?.message).toBe("two");
    provider.close();
  });

  test("reads CURSOR_API_KEY when stored cursor auth is empty", async () => {
    const store = await storeDirectory();
    const created: CursorSdkCreateOptions[] = [];
    const runtime = fakeRuntime(created, [], {
      deltas: [{ type: "text-delta", text: "ok" }],
      result: { status: "finished", result: "ok" },
    });
    const provider = new CursorSdkProvider({
      model: makeCursorModel(),
      auth: {
        async getApiKey() {
          return undefined;
        },
      },
      workspace: store,
      storeDirectory: store,
      runtime,
      environment: { CURSOR_API_KEY: " env-cursor-key " },
    });

    await collect(provider, request({}));
    expect(created[0]?.apiKey).toBe("env-cursor-key");
    provider.close();
  });
});

async function storeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-cursor-sdk-"));
  temporaryDirectories.push(path);
  return path;
}

function fakeRuntime(
  created: CursorSdkCreateOptions[],
  sent: Array<{
    readonly message: string | CursorSdkUserMessage;
    readonly options?: CursorSdkSendOptions;
  }>,
  script: {
    readonly deltas: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly result: CursorSdkRunResult;
    readonly invoke?: readonly string[];
    readonly hangOnSecondSend?: boolean;
    readonly onCancel?: () => void;
  },
): CursorSdkRuntime {
  return {
    async create(options) {
      created.push(options);
      let sends = 0;
      const agent: CursorSdkAgent = {
        agentId: options.agentId ?? "agent-test",
        async send(message, sendOptions) {
          sent.push({ message, ...(sendOptions === undefined ? {} : { options: sendOptions }) });
          sends += 1;
          if (script.hangOnSecondSend === true && sends > 1) {
            return hangingRun(script.onCancel);
          }
          for (const update of script.deltas) {
            await sendOptions?.onDelta?.({ update });
          }
          for (const name of script.invoke ?? []) {
            const tool = sendOptions?.local?.customTools?.[name];
            if (!tool) throw new Error(`missing custom tool ${name}`);
            await tool.execute({ path: "AGENTS.md" }, { toolCallId: "cursor-read" });
          }
          return immediateRun(script.result, script.onCancel);
        },
        close() {
          // Test double has no native handles.
        },
      };
      return agent;
    },
  };
}

function immediateRun(result: CursorSdkRunResult, onCancel?: () => void): CursorSdkRun {
  return {
    id: "run-test",
    async wait() {
      return result;
    },
    async cancel() {
      onCancel?.();
    },
    supports(operation) {
      return operation === "cancel";
    },
  };
}

function hangingRun(onCancel?: () => void): CursorSdkRun {
  let settle: ((result: CursorSdkRunResult) => void) | undefined;
  return {
    id: "run-hang",
    wait() {
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    async cancel() {
      onCancel?.();
      settle?.({ status: "cancelled" });
    },
    supports(operation) {
      return operation === "cancel";
    },
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

function request(overrides: Partial<ProviderRequest>): ProviderRequest {
  return {
    systemPrompt: ["You are Brisk."],
    messages: overrides.messages ?? [{ role: "user", content: "hello" }],
    tools: overrides.tools ?? [],
    signal: overrides.signal ?? new AbortController().signal,
    model: "composer-2.5",
  };
}

async function collect(
  provider: CursorSdkProvider,
  requestValue: ProviderRequest,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(requestValue)) events.push(event);
  return events;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Cursor SDK test state");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}
