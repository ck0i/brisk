import { describe, expect, test } from "bun:test";

import { ContextManager } from "../../src/context/context-manager.ts";
import type { ContextModel } from "../../src/context/types.ts";
import type { Message } from "../../src/core/messages.ts";
import type { CompactionMetadata } from "../../src/sessions/types.ts";

const textModel: ContextModel = {
  provider: "openai",
  api: "openai-completions",
  model: "text-model",
  contextWindow: 100_000,
  supportsImages: false,
};

const visionModel: ContextModel = {
  provider: "openai",
  api: "openai-completions",
  model: "vision-model",
  contextWindow: 100_000,
  supportsImages: true,
};

describe("ContextManager lifecycle", () => {
  test("does not compact below threshold", async () => {
    let persisted = 0;
    const history: Message[] = [{ role: "user", content: "small request" }];
    const manager = new ContextManager({
      model: textModel,
      recentTargetTokens: 100,
      persist: () => {
        persisted += 1;
      },
    });

    const active = await manager.prepare(history, textModel.model, neverAbort());

    expect(active).toEqual(history);
    expect(manager.inspect()).toMatchObject({
      compactionCount: 0,
      fallbackMode: "none",
      thresholdTokens: 83_616,
      recentRetainedMessages: 1,
    });
    expect(persisted).toBe(0);
  });

  test("compacts automatically and explicitly without mutating full history", async () => {
    const persisted: CompactionMetadata[] = [];
    const history: Message[] = [
      { role: "user", content: `old-request ${"x".repeat(9000)}` },
      { role: "assistant", content: `old-decision ${"y".repeat(9000)}`, toolCalls: [] },
      { role: "user", content: "outstanding tail" },
    ];
    const original = structuredClone(history);
    const automatic = new ContextManager({
      model: { ...textModel, contextWindow: 20_000 },
      recentTargetTokens: 100,
      maxFrames: 1,
      persist: (entry) => {
        persisted.push(entry.compaction);
      },
    });

    const active = await automatic.prepare(history, textModel.model, neverAbort());

    expect(history).toEqual(original);
    expect(active).not.toBe(history);
    expect(active[0]?.role).toBe("user");
    expect(active[0]?.content).toContain("TEXT-ONLY FALLBACK");
    expect(active.at(-1)).toEqual({ role: "user", content: "outstanding tail" });
    expect(automatic.inspect()).toMatchObject({
      compactionCount: 1,
      fallbackMode: "structured-text",
      recentRetainedMessages: 1,
    });
    expect(persisted[0]).toMatchObject({
      compactedMessageCount: 2,
      retainedMessageCount: 1,
      firstKeptIdentity: expect.stringContaining("brisk-2-"),
    });

    const explicit = new ContextManager({
      model: textModel,
      recentTargetTokens: 100,
      maxFrames: 1,
    });
    expect(explicit.inspect().compactionCount).toBe(0);
    const inspection = await explicit.compactNow(history);
    expect(inspection.compactionCount).toBe(1);
    expect(inspection.fallbackMode).toBe("structured-text");
  });

  test("produces deterministic bounded non-vision fallback", async () => {
    const history: Message[] = [
      { role: "user", content: `REQUEST-A ${"a".repeat(6000)}` },
      {
        role: "assistant",
        content: "DECISION-A",
        toolCalls: [{ id: "call", name: "bash", arguments: '{"command":"bun test"}' }],
      },
      {
        role: "tool",
        toolCallId: "call",
        name: "bash",
        content: "FAILURE-A: exit 1",
        isError: true,
      },
      { role: "user", content: "OUTSTANDING-A" },
    ];
    const make = (): ContextManager =>
      new ContextManager({
        model: textModel,
        recentTargetTokens: 50,
        maxFrames: 1,
        rawSourceMaxChars: 4000,
      });
    const first = make();
    const second = make();

    await first.compactNow(history);
    await second.compactNow(history);
    const firstFallback = first.messages[0];
    const secondFallback = second.messages[0];

    expect(firstFallback).toEqual(secondFallback);
    expect(firstFallback?.content).toContain("TEXT-ONLY FALLBACK");
    expect(firstFallback?.content).toContain("REQUEST-A");
    expect(firstFallback?.content).toContain("bun test");
    expect(firstFallback?.content).toContain("tool error");
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "OUTSTANDING-A" });
    expect(firstFallback?.content.length).toBeLessThan(6000);
  });

  test("renders a real snapcompact archive, persists preserve data, and switches vision modes", async () => {
    const persisted: CompactionMetadata[] = [];
    const history = renderFixture("RENDER_SOURCE");
    const manager = new ContextManager({
      model: visionModel,
      recentTargetTokens: 100,
      maxFrames: 1,
      persist: (entry) => {
        persisted.push(entry.compaction);
      },
    });
    const started = performance.now();

    await manager.compactNow(history);
    const elapsed = performance.now() - started;
    const first = persisted[0];

    expect(first?.summary).toContain("archived");
    expect(first?.preserveData).toBeDefined();
    expect(first?.rawSource).toContain("RENDER_SOURCE");
    expect(first?.imageCount).toBe(1);
    expect(first?.compactedImageTokenEstimate).toBe(5024);
    expect(
      manager.messages.some(
        (message) => message.role === "user" && (message.images?.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(manager.inspect()).toMatchObject({
      fallbackMode: "snapcompact-images",
      provider: "openai",
      model: "vision-model",
      compactedImageEstimateTokens: 5024,
    });
    expect(elapsed).toBeLessThan(5000);

    const switchedHistory: Message[] = [
      ...history,
      { role: "user", content: "new tail during model switch" },
    ];
    manager.setModel({ ...textModel, model: "switched-text" });
    const textContext = await manager.prepare(switchedHistory, "switched-text", neverAbort());
    expect(manager.inspect().fallbackMode).toBe("structured-text");
    expect(
      textContext.every(
        (message) => message.role !== "user" || (message.images?.length ?? 0) === 0,
      ),
    ).toBe(true);
    expect(textContext.at(-1)).toEqual({
      role: "user",
      content: "new tail during model switch",
    });

    manager.setModel({ ...visionModel, model: "switched-vision" });
    const visionContext = await manager.prepare(switchedHistory, "switched-vision", neverAbort());
    expect(manager.inspect()).toMatchObject({
      fallbackMode: "snapcompact-images",
      model: "switched-vision",
      compactionCount: 2,
    });
    expect(
      visionContext.some((message) => message.role === "user" && (message.images?.length ?? 0) > 0),
    ).toBe(true);
  }, 10_000);

  test("reuses prior raw source without rasterizing old frame base64", async () => {
    const persisted: CompactionMetadata[] = [];
    const firstHistory = renderFixture("FIRST_SOURCE");
    const manager = new ContextManager({
      model: visionModel,
      recentTargetTokens: 100,
      maxFrames: 1,
      persist: (entry) => {
        persisted.push(entry.compaction);
      },
    });
    await manager.compactNow(firstHistory);

    const repeated: Message[] = [
      ...firstHistory,
      { role: "user", content: `${"b".repeat(36_000)} SECOND_SOURCE` },
      { role: "user", content: "second outstanding tail" },
    ];
    await manager.compactNow(repeated);
    const second = persisted[1];

    expect(second?.rawSource).toContain("FIRST_SOURCE");
    expect(second?.rawSource).toContain("SECOND_SOURCE");
    expect(second?.rawSource).not.toContain("iVBOR");
    expect(second?.compactedMessageCount).toBe(3);
    expect(manager.messages.at(-1)).toEqual({
      role: "user",
      content: "second outstanding tail",
    });
  }, 10_000);

  test("discards a completed native result when cancellation wins before persistence", async () => {
    let releasePersistence: (() => void) | undefined;
    let persistenceStarted = false;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const history: Message[] = [
      { role: "user", content: "old request" },
      { role: "user", content: "tail" },
    ];
    const manager = new ContextManager({
      model: textModel,
      recentTargetTokens: 10,
      maxFrames: 1,
      persist: async () => {
        persistenceStarted = true;
        await persistenceGate;
      },
    });
    const controller = new AbortController();

    const compacting = manager.compactNow(history, controller.signal);
    await waitUntil(() => persistenceStarted);
    controller.abort(new DOMException("cancelled", "AbortError"));
    releasePersistence?.();

    await expect(compacting).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.inspect()).toMatchObject({ compactionCount: 0, fallbackMode: "none" });
    expect(manager.messages).toEqual(history);
  });
});

function renderFixture(marker: string): Message[] {
  return [
    { role: "user", content: `${marker} ${"archive words ".repeat(3500)}` },
    { role: "user", content: "uncompacted recent tail" },
  ];
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition was not met");
}
