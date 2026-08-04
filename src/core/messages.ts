export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** JSON-safe provider-native data retained for exact history replay and prompt-cache stability. */
export interface ProviderReplay {
  readonly content: readonly JsonValue[];
  readonly responseId?: string;
  readonly providerPayload?: JsonValue;
  readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

export interface ImageContent {
  readonly type: "image";
  /** raw base64 without a data URL prefix */
  readonly data: string;
  readonly mimeType: string;
  readonly detail?: "auto" | "low" | "high" | "original";
}

export interface UserMessage {
  readonly role: "user";
  /** scalar text remains the canonical display and persistence representation */
  readonly content: string;
  /** ordered after scalar text when translated to provider content blocks */
  readonly images?: readonly ImageContent[];
  readonly timestamp?: number;
  /** Brisk-owned hidden control messages are persisted but not shown in the main transcript UI. */
  readonly internal?: "goal-control";
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: Usage;
  /** provider-native blocks/signatures retained for exact same-session history replay */
  readonly providerReplay?: ProviderReplay;
  /** upstream identity retained for correct cross-model history translation */
  readonly provider?: string;
  readonly api?: string;
  readonly model?: string;
  readonly timestamp?: number;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
  readonly timestamp?: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
