import type { ProviderEvent } from "../core/events.ts";
import type { JsonValue, Message, ToolCall, ToolResultMessage } from "../core/messages.ts";

export interface JsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface ProviderToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ProviderRequest {
  readonly systemPrompt: readonly string[];
  readonly messages: readonly Message[];
  readonly tools: readonly ProviderToolSchema[];
  readonly signal: AbortSignal;
  readonly model: string;
  readonly sessionId?: string;
  readonly maxOutputTokens?: number;
  readonly executeTool?: (call: ToolCall, dispatchName?: string) => Promise<ToolResultMessage>;
}

export interface Provider {
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  close?(): void;
}
