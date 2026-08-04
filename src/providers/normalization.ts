import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Usage as PiUsage,
} from "@oh-my-pi/pi-ai";
import * as PiError from "@oh-my-pi/pi-ai/error";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";

import {
  NormalizedProviderError,
  type NormalizedProviderErrorKind,
  type ProviderEvent,
} from "../core/events.ts";
import type { JsonValue, ProviderReplay, Usage } from "../core/messages.ts";
import { redactSecrets, redactedErrorMessage } from "./secret-redaction.ts";

export interface ProviderErrorNormalizationOptions {
  readonly reason?: "error" | "aborted";
  readonly api?: Api;
  readonly secrets?: readonly string[];
}

/** Convert one pi-ai stream event into zero or more Brisk stream events. */
export function normalizeAssistantMessageEvent(
  event: AssistantMessageEvent,
  secrets: readonly string[] = [],
): readonly ProviderEvent[] {
  switch (event.type) {
    case "start":
      return [
        {
          type: "response_start",
          ...(event.partial.responseId === undefined ? {} : { id: event.partial.responseId }),
          provider: event.partial.provider,
          api: event.partial.api,
          model: event.partial.model,
          timestamp: event.partial.timestamp,
        },
      ];
    case "text_delta":
      return [{ type: "text_delta", delta: event.delta }];
    case "thinking_delta":
      return [{ type: "thinking_delta", delta: event.delta }];
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      if (block?.type !== "toolCall") {
        throw invalidEvent(`pi-ai toolcall_start had no tool call at index ${event.contentIndex}`);
      }
      return [
        {
          type: "tool_call_start",
          index: event.contentIndex,
          id: block.id,
          name: block.name,
        },
      ];
    }
    case "toolcall_delta":
      return [{ type: "tool_call_delta", index: event.contentIndex, delta: event.delta }];
    case "toolcall_end":
      return [{ type: "tool_call_end", index: event.contentIndex }];
    case "done":
      return [
        { type: "usage", usage: normalizeUsage(event.message.usage) },
        {
          type: "response_end",
          stopReason: normalizeStopReason(event.reason),
          ...providerReplay(event.message),
        },
      ];
    case "error":
      return [
        { type: "usage", usage: normalizeUsage(event.error.usage) },
        {
          type: "error",
          error: normalizeProviderFailure(event.error, {
            reason: event.reason,
            api: event.error.api,
            secrets,
          }),
        },
      ];
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
      // Brisk deltas do not expose upstream content-block lifecycle wrappers.
      return [];
    case "image_end":
      throw invalidEvent("pi-ai emitted an image output, which Brisk does not support yet");
  }
}

function providerReplay(message: AssistantMessage): { providerReplay?: ProviderReplay } {
  const content = jsonClone(message.content);
  if (!Array.isArray(content)) return {};
  const providerPayload = jsonClone(message.providerPayload);
  return {
    providerReplay: {
      content,
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      ...(providerPayload === undefined ? {} : { providerPayload }),
      stopReason: message.stopReason,
    },
  };
}

function jsonClone(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
  } catch {
    return undefined;
  }
}

export function normalizeUsage(usage: PiUsage): Usage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
}

export function normalizeProviderFailure(
  error: unknown,
  options: ProviderErrorNormalizationOptions = {},
): NormalizedProviderError {
  const secrets = options.secrets ?? [];
  if (error instanceof NormalizedProviderError) {
    return new NormalizedProviderError(redactSecrets(error.message, secrets), {
      kind: error.kind,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    });
  }

  const assistant = isAssistantError(error) ? error : undefined;
  const status = assistant?.errorStatus ?? PiError.status(error);
  const message = redactSecrets(
    assistant?.errorMessage ?? redactedErrorMessage(error, secrets, "Provider request failed"),
    secrets,
  );
  const classification =
    (assistant?.errorId ?? 0) | PiError.classify(error, options.api ?? assistant?.api);
  const aborted =
    options.reason === "aborted" ||
    PiError.is(classification, PiError.Flag.Abort) ||
    PiError.is(classification, PiError.Flag.UserInterrupt) ||
    (error instanceof Error && error.name === "AbortError");
  const kind = classifyKind(error, status, classification, aborted);
  const retryAfter = extractRetryAfter(error, message);

  return new NormalizedProviderError(aborted ? "Operation aborted" : message, {
    kind,
    retryable: kind === "network" || kind === "rate_limit",
    ...(status === undefined ? {} : { status }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

function classifyKind(
  error: unknown,
  status: number | undefined,
  classification: number,
  aborted: boolean,
): NormalizedProviderErrorKind {
  if (aborted) return "aborted";
  if (PiError.is(classification, PiError.Flag.ContextOverflow)) return "context_overflow";
  if (status === 401 || status === 403 || PiError.is(classification, PiError.Flag.AuthFailed)) {
    return "auth";
  }
  if (status === 429) return "rate_limit";
  if (
    status === 408 ||
    (status !== undefined && status >= 500) ||
    PiError.retriable(classification) ||
    PiError.isProviderRetryableError(error)
  ) {
    return "network";
  }
  if (status !== undefined && status >= 400 && status < 500) return "invalid_response";
  return "unknown";
}

function extractRetryAfter(error: unknown, message: string): number | undefined {
  const fromHeaders = getRetryAfterMsFromHeaders(getHeadersFromError(error));
  if (fromHeaders !== undefined) return fromHeaders;
  const match = /\bretry-after-ms=(\d+)\b/i.exec(message);
  if (!match?.[1]) return undefined;
  const milliseconds = Number(match[1]);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function isAssistantError(error: unknown): error is AssistantMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "role" in error &&
    error.role === "assistant" &&
    "stopReason" in error &&
    (error.stopReason === "error" || error.stopReason === "aborted") &&
    "usage" in error
  );
}

function normalizeStopReason(
  reason: "stop" | "length" | "toolUse",
): "stop" | "length" | "tool_call" {
  return reason === "toolUse" ? "tool_call" : reason;
}

function invalidEvent(message: string): NormalizedProviderError {
  return new NormalizedProviderError(message, { kind: "invalid_response", retryable: false });
}
