import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { AgentUiController } from "../../src/ui/agent-controller.ts";
import { UiStore } from "../../src/ui/state.ts";

async function settleFrames(): Promise<void> {
  await Bun.sleep(20);
}

describe("AgentUiController", () => {
  test("batches streaming deltas into the visible conversation and usage bar", async () => {
    const store = new UiStore("fixture");
    const loop = new AgentLoop({
      provider: new FakeProvider([
        {
          id: "response",
          thinking: ["one", " two"],
          text: ["hello", " world"],
          usage: {
            inputTokens: 7,
            outputTokens: 5,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            cost: 0.125,
          },
        },
      ]),
      model: "fake",
    });
    const controller = new AgentUiController(loop, store, 4);

    await controller.submit("question");
    await settleFrames();
    controller.dispose();

    expect(store.snapshot.messages).toHaveLength(2);
    expect(store.snapshot.messages[0]).toMatchObject({ role: "user", content: "question" });
    expect(store.snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: "hello world",
      thinking: "one two",
      streaming: false,
    });
    expect(store.snapshot.contextTokens).toBe(12);
    expect(store.snapshot.cacheReadTokens).toBe(3);
    expect(store.snapshot.cacheWriteTokens).toBe(2);
    expect(store.snapshot.cost).toBe(0.125);
    expect(store.snapshot.busy).toBe(false);
    expect(store.snapshot.status).toBe("ready");
  });

  test("extracts unified diffs into expandable tool cards", async () => {
    const store = new UiStore("fixture");
    const tools = new ToolRegistry().register({
      name: "edit",
      description: "fixture edit",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      parse: () => ({}),
      execute: (_arguments, context) => {
        context.emitPreview({
          summary: "value.ts",
          diff: "--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-before\n+after\n",
          targetPaths: ["value.ts"],
        });
        return { content: "Edit committed atomically" };
      },
    });
    const loop = new AgentLoop({
      provider: new FakeProvider([
        { toolCalls: [{ id: "edit-1", name: "edit", arguments: {} }] },
        { text: "done" },
      ]),
      model: "fake",
      tools,
    });
    const controller = new AgentUiController(loop, store, 1);

    await controller.submit("change it");
    await settleFrames();
    controller.dispose();

    expect(store.snapshot.messages[1]?.tools?.[0]).toMatchObject({
      name: "edit",
      status: "completed",
      summary: "value.ts",
      diff: "--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-before\n+after\n",
      expanded: true,
    });
  });

  test("does not render a research report mistakenly placed in task.patch as a diff", async () => {
    const store = new UiStore("fixture");
    const tools = new ToolRegistry().register({
      name: "task",
      description: "fixture task",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      parse: () => ({}),
      execute: () => ({
        content: JSON.stringify({
          status: "completed",
          summary: "Repository inspection complete",
          patch: "Technical overview:\n\nNo files were modified.",
          childSessionId: "child-1",
        }),
      }),
    });
    const loop = new AgentLoop({
      provider: new FakeProvider([
        { toolCalls: [{ id: "task-1", name: "task", arguments: {} }] },
        { text: "done" },
      ]),
      model: "fake",
      tools,
    });
    const controller = new AgentUiController(loop, store, 1);

    await controller.submit("inspect");
    await settleFrames();
    controller.dispose();

    expect(store.snapshot.messages[1]?.tools?.[0]).toMatchObject({
      name: "task",
      status: "completed",
      summary: "Repository inspection complete",
    });
    expect(store.snapshot.messages[1]?.tools?.[0]?.diff).toBeUndefined();
    expect(store.snapshot.messages[1]?.tools?.[0]?.expanded).toBeUndefined();
  });

  test("keeps a cancelled partial response visible and stops the busy state", async () => {
    const store = new UiStore("fixture");
    const loop = new AgentLoop({
      provider: new FakeProvider([{ text: ["partial", { value: " late", delayMs: 100 }] }]),
      model: "fake",
    });
    const controller = new AgentUiController(loop, store, 2);

    const submission = controller.submit("question");
    await Bun.sleep(10);
    controller.cancel();
    await submission;
    await settleFrames();
    controller.dispose();

    expect(store.snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      streaming: false,
      error: "Cancelled",
    });
    expect(store.snapshot.busy).toBe(false);
    expect(store.snapshot.status).toBe("cancelled");
  });
});
