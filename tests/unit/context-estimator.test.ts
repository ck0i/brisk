import { describe, expect, test } from "bun:test";

import type { Message } from "../../src/core/messages.ts";
import {
  APPROXIMATE_IMAGE_TOKENS,
  contextThreshold,
  estimateMessages,
} from "../../src/context/estimator.ts";
import {
  groupToolInteractions,
  hasOrphanedToolResult,
  selectRecentMessageStart,
} from "../../src/context/grouping.ts";

describe("context token estimation and thresholds", () => {
  test("accounts deterministically for message, text, tool, and image costs", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "hello",
        images: [{ type: "image", data: "AQID", mimeType: "image/png", detail: "original" }],
      },
      {
        role: "assistant",
        content: "done",
        thinking: "plan",
        toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a.ts"}' }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        name: "read",
        content: "file contents",
        isError: true,
      },
    ];

    const first = estimateMessages(messages);
    const second = estimateMessages(structuredClone(messages));

    expect(second).toEqual(first);
    expect(first.imageCount).toBe(1);
    expect(first.imageTokens).toBe(APPROXIMATE_IMAGE_TOKENS);
    expect(first.textTokens).toBeGreaterThan(0);
    expect(first.toolTokens).toBeGreaterThan(0);
    expect(first.messageTokens).toBe(12);
    expect(first.totalTokens).toBe(
      first.textTokens + first.toolTokens + first.imageTokens + first.messageTokens,
    );
    expect(first.metadata).toEqual({
      estimated: true,
      estimator: "brisk-approximate-v1",
      utf8BytesPerToken: 4,
      messageOverheadTokens: 4,
      imageTokens: 5024,
    });
  });

  test("uses the larger reserve and only lets thresholdPercent trigger earlier", () => {
    expect(contextThreshold(100_000)).toBe(83_616);
    expect(contextThreshold(200_000)).toBe(170_000);
    expect(contextThreshold(200_000, 0.8)).toBe(160_000);
    expect(contextThreshold(200_000, 0.95)).toBe(170_000);
    expect(contextThreshold(372_000, 0.85)).toBe(316_200);
    expect(contextThreshold(10_000)).toBe(-6384);
    expect(contextThreshold(null)).toBeUndefined();
    expect(contextThreshold(undefined)).toBeUndefined();
    expect(() => contextThreshold(100_000, 0)).toThrow(RangeError);
  });
});

describe("tool call grouping", () => {
  test("retains complete call/result groups without changing chronology", () => {
    const messages: Message[] = [
      { role: "user", content: "old".repeat(1000) },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "one", name: "read", arguments: "{}" },
          { id: "two", name: "read", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "one", name: "read", content: "1" },
      { role: "tool", toolCallId: "two", name: "read", content: "2" },
      { role: "assistant", content: "decision", toolCalls: [] },
    ];

    const groups = groupToolInteractions(messages);
    expect(groups.map((group) => [group.start, group.end])).toEqual([
      [0, 1],
      [1, 4],
      [4, 5],
    ]);
    const start = selectRecentMessageStart(messages, 100);
    const selected = messages.slice(start);
    expect(selected.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(hasOrphanedToolResult(selected)).toBe(false);
    expect(selected).toEqual(messages.slice(1));
  });
});
