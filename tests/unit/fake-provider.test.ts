import { describe, expect, test } from "bun:test";

import type { ProviderEvent } from "../../src/core/events.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";

describe("FakeProvider", () => {
  test("emits deterministic chunks, partial calls, usage, and multiple calls", async () => {
    const provider = new FakeProvider([
      {
        id: "response-1",
        thinking: ["plan", " first"],
        text: ["hello", " world"],
        toolCalls: [
          { id: "a", name: "one", argumentChunks: ['{"x":', "1}"] },
          { id: "b", name: "two", arguments: { y: true } },
        ],
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    ]);

    const events = await collect(provider, new AbortController().signal);

    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "thinking_delta",
      "thinking_delta",
      "text_delta",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "usage",
      "response_end",
    ]);
    expect(provider.requestCount).toBe(1);
  });

  test("aborts a delayed chunk promptly", async () => {
    const provider = new FakeProvider([{ text: [{ value: "late", delayMs: 100 }] }]);
    const controller = new AbortController();
    const collecting = collect(provider, controller.signal);
    await Bun.sleep(4);
    controller.abort(new DOMException("cancel", "AbortError"));

    await expect(withTimeout(collecting, 40)).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function collect(provider: FakeProvider, signal: AbortSignal): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [], tools: [], signal, model: "fake" })) {
    events.push(event);
  }
  return events;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(milliseconds).then(() => {
      throw new Error("timed out");
    }),
  ]);
}
