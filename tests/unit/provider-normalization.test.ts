import { describe, expect, test } from "bun:test";

import type { AssistantMessage, AssistantMessageEvent, Usage } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";

import {
  normalizeAssistantMessageEvent,
  normalizeProviderFailure,
} from "../../src/providers/normalization.ts";

const usage: Usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
};

function assistant(
  content: AssistantMessage["content"] = [],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 123,
    ...overrides,
  };
}

describe("pi-ai event normalization", () => {
  test("maps lifecycle, deltas, tool calls, stop reason, usage, and cost", () => {
    const started = assistant([], { responseId: "response-test" });
    const toolPartial = assistant([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call-test", name: "lookup", arguments: {} },
    ]);
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: started },
      { type: "thinking_start", contentIndex: 0, partial: toolPartial },
      { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: toolPartial },
      { type: "thinking_end", contentIndex: 0, content: "plan", partial: toolPartial },
      { type: "text_start", contentIndex: 1, partial: toolPartial },
      { type: "text_delta", contentIndex: 1, delta: "answer", partial: toolPartial },
      { type: "text_end", contentIndex: 1, content: "answer", partial: toolPartial },
      { type: "toolcall_start", contentIndex: 2, partial: toolPartial },
      { type: "toolcall_delta", contentIndex: 2, delta: '{"path":', partial: toolPartial },
      {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "call-test", name: "lookup", arguments: { path: "x" } },
        partial: toolPartial,
      },
      { type: "done", reason: "toolUse", message: assistant(toolPartial.content) },
    ];

    const normalized = events.flatMap((event) => normalizeAssistantMessageEvent(event));

    expect(normalized.map((event) => event.type)).toEqual([
      "response_start",
      "thinking_delta",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "usage",
      "response_end",
    ]);
    expect(normalized[0]).toEqual({
      type: "response_start",
      id: "response-test",
      provider: "test-provider",
      api: "openai-completions",
      model: "test-model",
      timestamp: 123,
    });
    expect(normalized[3]).toEqual({
      type: "tool_call_start",
      index: 2,
      id: "call-test",
      name: "lookup",
    });
    expect(normalized[6]).toEqual({
      type: "usage",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
        cost: 0.35,
      },
    });
    expect(normalized[7]).toEqual({ type: "response_end", stopReason: "tool_call" });
  });

  test("normalizes terminal errors and redacts explicit credentials", () => {
    const secret = "BRISK_TEST_SECRET_VALUE";
    const upstream = assistant([], {
      stopReason: "error",
      errorStatus: 403,
      errorMessage: `forbidden api_key=${secret}`,
    });
    const normalized = normalizeAssistantMessageEvent(
      { type: "error", reason: "error", error: upstream },
      [secret],
    );

    expect(normalized[0]?.type).toBe("usage");
    const terminal = normalized[1];
    expect(terminal?.type).toBe("error");
    if (terminal?.type !== "error") throw new Error("expected normalized error");
    expect(terminal.error.kind).toBe("auth");
    expect(terminal.error.status).toBe(403);
    expect(terminal.error.message).toContain("[REDACTED]");
    expect(terminal.error.message).not.toContain(secret);
  });
});

describe("provider error classification", () => {
  test("classifies abort, auth, rate limit retry-after, overflow, and retryable transport errors", () => {
    expect(normalizeProviderFailure(new DOMException("cancel", "AbortError")).kind).toBe("aborted");
    expect(normalizeProviderFailure(new ProviderHttpError("denied", 401)).kind).toBe("auth");

    const rateLimit = normalizeProviderFailure(
      new ProviderHttpError("too many requests", 429, {
        headers: new Headers({ "retry-after": "2" }),
      }),
    );
    expect(rateLimit).toMatchObject({ kind: "rate_limit", retryable: true, retryAfter: 2000 });

    expect(normalizeProviderFailure(new Error("maximum context length is 100 tokens")).kind).toBe(
      "context_overflow",
    );
    expect(
      normalizeProviderFailure(new ProviderHttpError("upstream unavailable", 503)),
    ).toMatchObject({
      kind: "network",
      retryable: true,
      status: 503,
    });
    expect(normalizeProviderFailure(new TypeError("fetch failed")).kind).toBe("network");
  });

  test("redacts bearer and explicit sentinel values without retaining the cause", () => {
    const secret = "BRISK_TEST_ONLY_CREDENTIAL";
    const normalized = normalizeProviderFailure(
      new ProviderHttpError(`Authorization: Bearer ${secret}`, 500),
    );

    expect(normalized.message).not.toContain(secret);
    expect(normalized.message).toContain("[REDACTED]");
    expect(normalized.cause).toBeUndefined();
  });
});
