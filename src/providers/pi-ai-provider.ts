import {
  streamSimple,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type Usage as PiUsage,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import { NormalizedProviderError, type ProviderEvent } from "../core/events.ts";
import type { AssistantMessage, Message, Usage } from "../core/messages.ts";
import { normalizeAssistantMessageEvent, normalizeProviderFailure } from "./normalization.ts";
import type { Provider, ProviderRequest, ProviderToolSchema } from "./types.ts";

export interface ApiKeyResolutionOptions {
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly signal?: AbortSignal;
}

export interface CredentialResolver {
  getApiKey(
    provider: string,
    sessionId?: string,
    options?: ApiKeyResolutionOptions,
  ): Promise<string | undefined>;
}

export type PiStreamFunction = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiAiProviderOptions {
  readonly model: Model<Api>;
  readonly auth: CredentialResolver;
  readonly reasoning?: Effort;
  readonly sessionId?: string;
  readonly stream?: PiStreamFunction;
  readonly preconnect?: (url: string) => void;
}

/** Brisk Provider adapter for the standalone pi-ai runtime. */
export class PiAiProvider implements Provider {
  private currentModel: Model<Api>;
  private readonly auth: CredentialResolver;
  private readonly reasoning: Effort | undefined;
  private sessionId: string | undefined;
  private readonly streamUpstream: PiStreamFunction;
  private readonly preconnect: (url: string) => void;

  constructor(options: PiAiProviderOptions) {
    this.currentModel = options.model;
    this.auth = options.auth;
    this.reasoning = options.reasoning;
    this.sessionId = options.sessionId;
    this.streamUpstream =
      options.stream ??
      ((model, context, streamOptions) => streamSimple(model, context, streamOptions));
    this.preconnect = options.preconnect ?? ((url) => fetch.preconnect(url));
    this.preconnectBestEffort(this.currentModel);
  }

  get model(): Model<Api> {
    return this.currentModel;
  }

  setModel(model: Model<Api>): void {
    this.currentModel = model;
    this.preconnectBestEffort(model);
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const model = this.currentModel;
    const sessionId = request.sessionId ?? this.sessionId;
    let apiKey: string | undefined;

    try {
      throwIfAborted(request.signal);
      apiKey = await this.auth.getApiKey(model.provider, sessionId, {
        baseUrl: model.baseUrl,
        modelId: model.id,
        signal: request.signal,
      });
      throwIfAborted(request.signal);
      const context = translateContext(request.messages, request.tools, model);
      const options: SimpleStreamOptions = {
        signal: request.signal,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      const upstream = this.streamUpstream(model, context, options);
      for await (const event of upstream) {
        for (const normalized of normalizeAssistantMessageEvent(
          event,
          apiKey === undefined ? [] : [apiKey],
        )) {
          yield normalized;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        error: normalizeProviderFailure(error, {
          api: model.api,
          reason: request.signal.aborted ? "aborted" : "error",
          secrets: apiKey === undefined ? [] : [apiKey],
        }),
      };
    }
  }

  private preconnectBestEffort(model: Model<Api>): void {
    if (model.baseUrl.length === 0) return;
    queueMicrotask(() => {
      try {
        this.preconnect(model.baseUrl);
      } catch {
        // Connection warming is optional and must never delay or fail a caller.
      }
    });
  }
}

export function translateContext(
  messages: readonly Message[],
  tools: readonly ProviderToolSchema[],
  model: Model<Api>,
  now = Date.now(),
): Context {
  const timestampBase = now - messages.length;
  return {
    messages: messages.map((message, index) =>
      translateMessage(message, model, timestampBase + index),
    ),
    ...(tools.length === 0 ? {} : { tools: tools.map(translateTool) }),
  };
}

export function translateMessage(
  message: Message,
  model: Model<Api>,
  timestamp: number,
): PiMessage {
  switch (message.role) {
    case "user":
      // Brisk currently stores text only. Vision-capable models keep the exact same
      // text shape until Brisk gains an explicit image content block.
      return { role: "user", content: message.content, timestamp };
    case "assistant":
      return translateAssistantMessage(message, model, timestamp);
    case "tool":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: "text", text: message.content }],
        isError: message.isError ?? false,
        timestamp,
      };
  }
}

export function translateTool(tool: ProviderToolSchema): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.inputSchema) as unknown as Record<string, unknown>,
  };
}

function translateAssistantMessage(
  message: AssistantMessage,
  currentModel: Model<Api>,
  fallbackTimestamp: number,
): PiAssistantMessage {
  const content: PiAssistantMessage["content"] = [];
  if (message.thinking !== undefined)
    content.push({ type: "thinking", thinking: message.thinking });
  if (message.content.length > 0) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: parseToolArguments(call.arguments, call.name),
    });
  }

  return {
    role: "assistant",
    content,
    api: message.api ?? currentModel.api,
    provider: message.provider ?? currentModel.provider,
    model: message.model ?? currentModel.id,
    usage: toPiUsage(message.usage),
    stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: message.timestamp ?? fallbackTimestamp,
  };
}

function parseToolArguments(value: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new NormalizedProviderError(`Stored arguments for tool ${toolName} are not valid JSON`, {
      kind: "invalid_response",
      retryable: false,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NormalizedProviderError(`Stored arguments for tool ${toolName} are not an object`, {
      kind: "invalid_response",
      retryable: false,
    });
  }
  return parsed as Record<string, unknown>;
}

function toPiUsage(usage: Usage | undefined): PiUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage?.cost ?? 0,
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}
