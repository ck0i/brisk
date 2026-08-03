import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { Message } from "../../src/core/messages.ts";
import { FakeProvider, type FakeProviderTurn } from "../../src/providers/fake-provider.ts";
import type { Provider, ProviderRequest } from "../../src/providers/types.ts";
import { CheckpointStore } from "../../src/subagents/checkpoint.ts";
import { SubagentManager } from "../../src/subagents/manager.ts";
import { parseTaskResult } from "../../src/subagents/result.ts";
import { createTaskTool } from "../../src/subagents/task-tool.ts";
import type {
  ChildProviderContext,
  ChildSessionAdapter,
  TaskResultStatus,
} from "../../src/subagents/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const prefix: readonly Message[] = [
  { role: "user", content: "parent question" },
  { role: "assistant", content: "parent answer", toolCalls: [] },
];

describe("SubagentManager execution", () => {
  test("runs three children concurrently over one checkpoint and returns ordered results", async () => {
    let checkpointCalls = 0;
    let active = 0;
    let maximumActive = 0;
    const providers = new Map<string, FakeProvider>();
    const delays = new Map([
      ["child-1", 35],
      ["child-2", 20],
      ["child-3", 5],
    ]);
    let nextId = 0;
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint() {
        checkpointCalls += 1;
        return prefix;
      },
      defaultModel: "default-model",
      maxConcurrency: 3,
      createChildSessionId: () => `child-${++nextId}`,
      providerFactory(context) {
        const fake = new FakeProvider([
          completeTurn(context.childSessionId, delays.get(context.childSessionId) ?? 0, {
            inputTokens: 10,
            outputTokens: 2,
          }),
        ]);
        providers.set(context.childSessionId, fake);
        return trackingProvider(fake, {
          start() {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          },
          end() {
            active -= 1;
          },
        });
      },
    });

    const results = await manager.runMany([
      { description: "first", mode: "research" },
      { description: "second", mode: "patch", model: "patch-model" },
      { description: "third", mode: "research", maxOutputTokens: 77 },
    ]);

    expect(checkpointCalls).toBe(1);
    expect(maximumActive).toBe(3);
    expect(results.map((result) => result.summary)).toEqual(["child-1", "child-2", "child-3"]);
    const sessions = manager.list();
    expect(sessions.map((session) => session.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(sessions[1]?.model).toBe("patch-model");
    expect(sessions[2]?.maxOutputTokens).toBe(77);
    expect(providers.get("child-1")?.requests[0]?.maxOutputTokens).toBeUndefined();
    expect(providers.get("child-3")?.requests[0]?.maxOutputTokens).toBe(77);
    expect(sessions[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });

    const sharedCheckpoint = manager.getCheckpoint("child-1");
    expect(manager.getCheckpoint("child-2")).toBe(sharedCheckpoint);
    expect(manager.getCheckpoint("child-3")).toBe(sharedCheckpoint);
    for (const childSessionId of ["child-1", "child-2", "child-3"]) {
      const provider = providers.get(childSessionId);
      expect(provider?.requests[0]?.messages.slice(0, prefix.length)).toEqual([...prefix]);
      expect(provider?.requests[0]?.messages[prefix.length]).toEqual({
        role: "user",
        content:
          childSessionId === "child-1"
            ? "first"
            : childSessionId === "child-2"
              ? "second"
              : "third",
      });
      expect(manager.getTranscript(childSessionId)?.[0]).toEqual(
        provider?.requests[0]?.messages[prefix.length],
      );
      expect(manager.getTranscript(childSessionId)).not.toContain(prefix[0]);
      expect(manager.get(childSessionId)?.checkpointId).toBe(sharedCheckpoint?.id);
    }
  });

  test("uses complete_task exactly, falls back to final text, and reports blocked and failed", async () => {
    let nextId = 0;
    const scripts: readonly (readonly FakeProviderTurn[])[] = [
      [
        {
          text: "narration that must not replace the result",
          toolCalls: [
            {
              id: "done",
              name: "complete_task",
              arguments: {
                status: "blocked",
                summary: "need symbols",
                filesConsidered: ["binary.exe"],
                blockers: ["symbols unavailable"],
              },
            },
          ],
        },
      ],
      [{ text: "fallback summary" }],
      [{ error: { kind: "auth", message: "credentials rejected" } }],
    ];
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint: () => prefix,
      defaultModel: "fake",
      createChildSessionId: () => `case-${++nextId}`,
      providerFactory: (context) =>
        new FakeProvider(scripts[Number(context.childSessionId.at(-1)) - 1] ?? []),
    });

    const blocked = await manager.run({ description: "blocked", mode: "research" });
    const fallback = await manager.run({ description: "fallback", mode: "research" });
    const failed = await manager.run({ description: "failed", mode: "research" });

    expect(blocked).toEqual({
      status: "blocked",
      summary: "need symbols",
      filesConsidered: ["binary.exe"],
      blockers: ["symbols unavailable"],
      childSessionId: "case-1",
    });
    expect(fallback).toEqual({
      status: "completed",
      summary: "fallback summary",
      childSessionId: "case-2",
    });
    expect(failed).toEqual({
      status: "failed",
      summary: "credentials rejected",
      childSessionId: "case-3",
    });
    expect(manager.get("case-1")?.status).toBe("blocked");
    expect(manager.get("case-2")?.status).toBe("completed");
    expect(manager.get("case-3")?.status).toBe("failed");
    expect(manager.getTranscript("case-1")?.at(-1)).toMatchObject({
      role: "tool",
      name: "complete_task",
    });
  });

  test("persists only the child continuation and passes model token metadata", async () => {
    const persisted: Message[] = [];
    let providerContext: ChildProviderContext | undefined;
    const adapter: ChildSessionAdapter = {
      append(message) {
        persisted.push(message);
      },
    };
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint: () => prefix,
      defaultModel: "default",
      childSessionFactory: () => adapter,
      providerFactory(context) {
        providerContext = context;
        return new FakeProvider([completeTurn("persisted", 0)]);
      },
      createChildSessionId: () => "private-child",
    });

    await manager.run({
      description: "private task",
      mode: "patch",
      model: "selected",
      maxOutputTokens: 321,
    });

    expect(providerContext).toEqual({
      childSessionId: "private-child",
      model: "selected",
      mode: "patch",
      depth: 1,
      maxOutputTokens: 321,
    });
    expect(persisted).toEqual([...(manager.getTranscript("private-child") ?? [])]);
    expect(persisted[0]).toEqual({ role: "user", content: "private task" });
    expect(persisted).not.toContain(prefix[0]);
  });
});

describe("SubagentManager orchestration controls", () => {
  test("shares concurrency one between run calls and cancels queued and running children", async () => {
    let nextId = 0;
    let active = 0;
    let maximumActive = 0;
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint: () => prefix,
      defaultModel: "fake",
      maxConcurrency: 1,
      createChildSessionId: () => `cancel-${++nextId}`,
      providerFactory: () => {
        const fake = new FakeProvider([{ delayMs: 200, text: "late" }]);
        return trackingProvider(fake, {
          start() {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          },
          end() {
            active -= 1;
          },
        });
      },
    });

    const first = manager.run({ description: "running", mode: "research" });
    const second = manager.run({ description: "queued", mode: "research" });
    await waitUntil(
      () => manager.list().length === 2 && manager.list().some((item) => item.status === "running"),
    );
    const queued = manager.list().find((item) => item.status === "queued");
    const running = manager.list().find((item) => item.status === "running");
    expect(queued).toBeDefined();
    expect(running).toBeDefined();
    expect(manager.cancel(queued?.childSessionId ?? "")).toBe(true);
    expect(manager.cancel(running?.childSessionId ?? "")).toBe(true);

    const [firstResult, secondResult] = await withTimeout(Promise.all([first, second]), 100);
    expect([firstResult.status, secondResult.status]).toEqual(["blocked", "blocked"]);
    expect(manager.list().map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
  });

  test("enforces depth and omits recursive task exposure at the limit", async () => {
    let nextId = 0;
    let providerCalls = 0;
    const providers: FakeProvider[] = [];
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint: () => prefix,
      defaultModel: "fake",
      maxDepth: 2,
      createChildSessionId: () => `depth-${++nextId}`,
      providerFactory: () => {
        providerCalls += 1;
        const provider = new FakeProvider([completeTurn("depth", 0)]);
        providers.push(provider);
        return provider;
      },
    });

    await manager.run({ description: "level one", mode: "research" });
    await manager.run({ description: "level two", mode: "research" }, { depth: 1 });
    const blocked = await manager.run({ description: "too deep", mode: "research" }, { depth: 2 });

    expect(providers[0]?.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "task",
      "complete_task",
    ]);
    expect(providers[1]?.requests[0]?.tools.map((tool) => tool.name)).toEqual(["complete_task"]);
    expect(blocked.status).toBe("blocked");
    expect(providerCalls).toBe(2);
    expect(manager.get("depth-3")?.transcript).toEqual([]);
  });

  test("task tool calls overlap and expose only compact child results to the parent", async () => {
    let nextId = 0;
    let checkpointCalls = 0;
    let active = 0;
    let maximumActive = 0;
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore(),
      createCheckpoint: () => {
        checkpointCalls += 1;
        return prefix;
      },
      defaultModel: "child-model",
      maxConcurrency: 3,
      createChildSessionId: () => `tool-child-${++nextId}`,
      providerFactory: (context) =>
        trackingProvider(new FakeProvider([completeTurn(context.childSessionId, 20)]), {
          start() {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
          },
          end() {
            active -= 1;
          },
        }),
    });
    const tools = new ToolRegistry().register(createTaskTool(manager));
    const parent = new AgentLoop({
      model: "parent-model",
      tools,
      provider: new FakeProvider([
        {
          toolCalls: [
            { id: "one", name: "task", arguments: { description: "one" } },
            { id: "two", name: "task", arguments: { description: "two" } },
          ],
        },
        { text: "parent done" },
      ]),
    });

    await parent.submit("delegate");

    expect(maximumActive).toBe(2);
    expect(checkpointCalls).toBe(1);
    const parentResults = parent.messages.filter((message) => message.role === "tool");
    expect(parentResults.map((message) => message.toolCallId)).toEqual(["one", "two"]);
    expect(parentResults.map((message) => parseTaskResult(JSON.parse(message.content)))).toEqual([
      { status: "completed", summary: "tool-child-1", childSessionId: "tool-child-1" },
      { status: "completed", summary: "tool-child-2", childSessionId: "tool-child-2" },
    ]);
    expect(parent.messages.some((message) => message.content === "one")).toBe(false);
    expect(parent.messages.some((message) => message.content === "two")).toBe(false);
  });
});

function completeTurn(
  summary: string,
  delayMs: number,
  usage?: { readonly inputTokens: number; readonly outputTokens: number },
  status: TaskResultStatus = "completed",
): FakeProviderTurn {
  return {
    delayMs,
    toolCalls: [
      {
        id: `complete-${summary}`,
        name: "complete_task",
        arguments: { status, summary },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function trackingProvider(
  provider: FakeProvider,
  observer: { readonly start: () => void; readonly end: () => void },
): Provider {
  return {
    async *stream(request: ProviderRequest) {
      observer.start();
      try {
        yield* provider.stream(request);
      } finally {
        observer.end();
      }
    },
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
