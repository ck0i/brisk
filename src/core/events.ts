import type {
  AssistantMessage,
  ProviderReplay,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./messages.ts";
import type { ToolPreview } from "../tools/registry.ts";

export type NormalizedProviderErrorKind =
  | "network"
  | "rate_limit"
  | "auth"
  | "context_overflow"
  | "invalid_response"
  | "aborted"
  | "unknown";

export interface NormalizedProviderErrorOptions {
  readonly kind?: NormalizedProviderErrorKind;
  readonly retryable?: boolean;
  readonly status?: number;
  /** retry delay requested by the provider, in milliseconds */
  readonly retryAfter?: number;
  readonly cause?: unknown;
}

export class NormalizedProviderError extends Error {
  readonly kind: NormalizedProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfter?: number;

  constructor(message: string, options: NormalizedProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NormalizedProviderError";
    this.kind = options.kind ?? "unknown";
    this.retryable = options.retryable ?? defaultRetryable(this.kind);
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;
  if (isAbortError(error)) {
    return new NormalizedProviderError("Operation aborted", {
      kind: "aborted",
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new NormalizedProviderError(error.message, { cause: error });
  }
  return new NormalizedProviderError(typeof error === "string" ? error : "Unknown provider error", {
    cause: error,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof NormalizedProviderError && error.kind === "aborted")
  );
}

function defaultRetryable(kind: NormalizedProviderErrorKind): boolean {
  return kind === "network" || kind === "rate_limit";
}

export type ProviderEvent =
  | {
      readonly type: "response_start";
      readonly id?: string;
      readonly provider?: string;
      readonly api?: string;
      readonly model?: string;
      readonly timestamp?: number;
    }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | {
      readonly type: "tool_call_start";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      readonly arguments?: string;
      readonly resolved?: boolean;
    }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly delta: string }
  | {
      readonly type: "tool_call_end";
      readonly index: number;
      readonly arguments?: string;
      readonly resolved?: boolean;
    }
  | { readonly type: "provider_tool_result"; readonly message: ToolResultMessage }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "response_end";
      readonly stopReason?: "stop" | "tool_call" | "length" | "unknown";
      readonly providerReplay?: ProviderReplay;
    }
  | { readonly type: "error"; readonly error: NormalizedProviderError };

export type AgentEvent =
  | ProviderEvent
  | { readonly type: "user_message"; readonly message: UserMessage }
  | { readonly type: "assistant_message"; readonly message: AssistantMessage }
  | {
      readonly type: "tool_execution_start";
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_execution_output";
      readonly id: string;
      readonly name: string;
      readonly stream: "stdout" | "stderr" | "progress";
      readonly delta: string;
    }
  | {
      readonly type: "tool_execution_preview";
      readonly id: string;
      readonly name: string;
      readonly preview: ToolPreview;
    }
  | {
      readonly type: "tool_execution_end";
      readonly id: string;
      readonly name: string;
      readonly isError: boolean;
    }
  | { readonly type: "tool_result"; readonly message: ToolResultMessage }
  | { readonly type: "cancelled" }
  | { readonly type: "idle" };
