import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
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
          usage: { inputTokens: 7, outputTokens: 5, cost: 0.125 },
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
    expect(store.snapshot.cost).toBe(0.125);
    expect(store.snapshot.busy).toBe(false);
    expect(store.snapshot.status).toBe("ready");
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
