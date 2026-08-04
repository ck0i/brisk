import {
  streamSimple,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent,
  type CacheRetention,
  type Context,
  type CursorExecHandlers,
  type CursorMcpCall,
  type Message as PiMessage,
  type Model,
  type ProviderPayload,
  type ProviderSessionState,
  type SimpleStreamOptions,
  type Tool,
  type ToolResultMessage as PiToolResultMessage,
  type Usage as PiUsage,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import { NormalizedProviderError, type ProviderEvent } from "../core/events.ts";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "../core/messages.ts";
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
  readonly reasoning?: Effort | "off";
  readonly sessionId?: string;
  readonly cacheRetention?: CacheRetention;
  readonly stream?: PiStreamFunction;
  readonly preconnect?: (url: string) => void;
}

/** Brisk Provider adapter for the standalone pi-ai runtime. */
export class PiAiProvider implements Provider {
  private currentModel: Model<Api>;
  private readonly auth: CredentialResolver;
  private reasoning: Effort | "off" | undefined;
  private sessionId: string | undefined;
  private readonly cacheRetention: CacheRetention | undefined;
  private readonly providerSessionState = new Map<string, ProviderSessionState>();
  private readonly streamUpstream: PiStreamFunction;
  private readonly preconnect: (url: string) => void;

  constructor(options: PiAiProviderOptions) {
    this.currentModel = options.model;
    this.auth = options.auth;
    this.reasoning = options.reasoning;
    this.sessionId = options.sessionId;
    this.cacheRetention = options.cacheRetention;
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

  setReasoning(reasoning: Effort | "off" | undefined): void {
    this.reasoning = reasoning;
  }

  setSessionId(sessionId: string | undefined): void {
    if (sessionId === this.sessionId) return;
    this.closeProviderSessionState();
    this.sessionId = sessionId;
  }

  close(): void {
    this.closeProviderSessionState();
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
      const context = translateContext(
        request.messages,
        request.tools,
        model,
        Date.now(),
        request.systemPrompt,
      );
      const providerToolResults = new Map<string, ToolResultMessage>();
      const cursorBridge =
        model.api === "cursor-agent" && request.executeTool
          ? createCursorExecHandlers(request.executeTool)
          : undefined;
      const options: SimpleStreamOptions = {
        signal: request.signal,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(this.reasoning === "off"
          ? { disableReasoning: true }
          : this.reasoning === undefined
            ? {}
            : { reasoning: this.reasoning }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(this.cacheRetention === undefined ? {} : { cacheRetention: this.cacheRetention }),
        // Pi's coding-agent path is stateless and relies on prompt-cache affinity, not stored responses.
        statefulResponses: false,
        providerSessionState: this.providerSessionState,
        ...(cursorBridge === undefined ? {} : { cursorExecHandlers: cursorBridge }),
        ...(model.api !== "cursor-agent"
          ? {}
          : {
              cursorOnToolResult: (result: PiToolResultMessage) => {
                providerToolResults.set(result.toolCallId, fromPiToolResult(result));
                return result;
              },
            }),
        ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
      };
      const upstream = this.streamUpstream(model, context, options);
      for await (const event of upstream) {
        for (const normalized of normalizeAssistantMessageEvent(
          event,
          apiKey === undefined ? [] : [apiKey],
        )) {
          if (normalized.type === "response_end") {
            for (const result of providerToolResults.values()) {
              yield { type: "provider_tool_result", message: result };
            }
            providerToolResults.clear();
          }
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

  private closeProviderSessionState(): void {
    for (const state of this.providerSessionState.values()) {
      try {
        state.close();
      } catch {
        // Provider state cleanup must not prevent session switching or shutdown.
      }
    }
    this.providerSessionState.clear();
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

type ProviderToolExecutor = NonNullable<ProviderRequest["executeTool"]>;

function createCursorExecHandlers(execute: ProviderToolExecutor): CursorExecHandlers {
  const invoke = async (
    id: string,
    name: string,
    dispatchName: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<ToolResultMessage> => {
    // let the consumer publish Cursor's queued tool-call start before execution events
    await Promise.resolve();
    const call: ToolCall = {
      id,
      name,
      arguments: JSON.stringify(arguments_),
    };
    return await execute(call, dispatchName);
  };
  const run = async (
    id: string,
    name: string,
    dispatchName: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<PiToolResultMessage> =>
    toPiToolResult(await invoke(id, name, dispatchName, arguments_));
  const write = async (
    id: string,
    name: string,
    path: string,
    content: string,
  ): Promise<PiToolResultMessage> => {
    const replace = await invoke(id, name, "write", { path, content, mode: "replace" });
    if (!replace.isError || !replace.content.includes('use mode "create"')) {
      return toPiToolResult(replace);
    }
    return toPiToolResult(await invoke(id, name, "write", { path, content, mode: "create" }));
  };
  const readArguments = (
    path: string,
    offset: number | undefined,
    limit: number | undefined,
  ): Readonly<Record<string, unknown>> => {
    if (offset === undefined && limit === undefined) return { path };
    const start = Math.max(1, Math.floor(offset ?? 1));
    const count = limit === undefined ? undefined : Math.max(1, Math.floor(limit));
    return {
      path,
      ranges: [{ start, ...(count === undefined ? {} : { end: start + count - 1 }) }],
    };
  };
  const searchArguments = (args: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
  }): Readonly<Record<string, unknown>> => ({
    pattern: args.pattern,
    path: args.path || ".",
    ...(args.glob ? { globs: [args.glob] } : {}),
    ...(args.ignoreCase === undefined ? {} : { caseSensitive: !args.ignoreCase }),
    ...(args.literal === undefined ? {} : { regex: !args.literal }),
    ...(args.context === undefined ? {} : { context: Math.max(0, Math.floor(args.context)) }),
    ...(args.limit === undefined ? {} : { limit: Math.max(1, Math.floor(args.limit)) }),
  });
  const timeoutMs = (seconds: number | undefined): number | undefined =>
    seconds === undefined || seconds <= 0
      ? undefined
      : Math.min(600_000, Math.max(1, Math.round(seconds * 1_000)));

  return {
    read: async (args) =>
      await run(args.toolCallId, "read", "read", readArguments(args.path, args.offset, args.limit)),
    ls: async (args) =>
      await run(args.toolCallId, "read", "list", { path: args.path || ".", depth: 2 }),
    grep: async (args) =>
      await run(
        args.toolCallId,
        "grep",
        "search",
        searchArguments({
          pattern: args.pattern,
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.glob === undefined ? {} : { glob: args.glob }),
          ...(args.caseInsensitive === undefined ? {} : { ignoreCase: args.caseInsensitive }),
          ...(args.context === undefined ? {} : { context: args.context }),
          ...(args.headLimit === undefined ? {} : { limit: args.headLimit }),
        }),
      ),
    write: async (args) =>
      await write(
        args.toolCallId,
        "write",
        args.path,
        args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array()),
      ),
    shell: async (args) =>
      await run(args.toolCallId, "bash", "bash", {
        command: args.command,
        ...(args.workingDirectory ? { cwd: args.workingDirectory } : {}),
        ...(timeoutMs(args.timeout) === undefined ? {} : { timeoutMs: timeoutMs(args.timeout) }),
      }),
    mcp: async (call: CursorMcpCall) =>
      await run(call.toolCallId, call.toolName || call.name, call.toolName || call.name, call.args),
    piRead: async (call) =>
      await run(
        call.toolCallId,
        "read",
        "read",
        readArguments(call.args.path, call.args.offset, call.args.limit),
      ),
    piBash: async (call) =>
      await run(call.toolCallId, "bash", "bash", {
        command: call.args.command,
        ...(timeoutMs(call.args.timeout) === undefined
          ? {}
          : { timeoutMs: timeoutMs(call.args.timeout) }),
      }),
    piEdit: async (call) => {
      const read = await invoke(call.toolCallId, "edit", "read", { path: call.args.path });
      if (read.isError) return toPiToolResult(read);
      let content: string;
      try {
        content = parseHashlineContent(read.content);
        for (const edit of call.args.edits) {
          const first = content.indexOf(edit.oldText);
          if (first < 0 || content.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
            throw new Error("Edit old text must match exactly once");
          }
          content = `${content.slice(0, first)}${edit.newText}${content.slice(first + edit.oldText.length)}`;
        }
      } catch (error) {
        return toPiToolResult({
          role: "tool",
          toolCallId: call.toolCallId,
          name: "edit",
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
      return await write(call.toolCallId, "edit", call.args.path, content);
    },
    piWrite: async (call) =>
      await write(call.toolCallId, "write", call.args.path, call.args.content),
    piGrep: async (call) =>
      await run(
        call.toolCallId,
        "grep",
        "search",
        searchArguments({
          pattern: call.args.pattern,
          ...(call.args.path === undefined ? {} : { path: call.args.path }),
          ...(call.args.glob === undefined ? {} : { glob: call.args.glob }),
          ...(call.args.ignoreCase === undefined ? {} : { ignoreCase: call.args.ignoreCase }),
          ...(call.args.literal === undefined ? {} : { literal: call.args.literal }),
          ...(call.args.context === undefined ? {} : { context: call.args.context }),
          ...(call.args.limit === undefined ? {} : { limit: call.args.limit }),
        }),
      ),
    piFind: async (call) =>
      await run(call.toolCallId, "glob", "find", {
        patterns: call.args.pattern,
        ...(call.args.path === undefined ? {} : { path: call.args.path }),
        ...(call.args.limit === undefined ? {} : { limit: Math.max(1, call.args.limit) }),
      }),
    piLs: async (call) =>
      await run(call.toolCallId, "read", "list", {
        path: call.args.path || ".",
        depth: 2,
        ...(call.args.limit === undefined ? {} : { limit: Math.max(1, call.args.limit) }),
      }),
  };
}

function parseHashlineContent(output: string): string {
  const lines = output.split("\n");
  if (!/^\[[^\]]+#[0-9A-F]+\]$/.test(lines.shift() ?? "")) {
    throw new Error("Read did not return a Hashline snapshot");
  }
  const content: string[] = [];
  for (const line of lines) {
    const match = /^(\d+):(.*)$/.exec(line);
    if (!match) throw new Error("Read snapshot was truncated");
    content.push(match[2] ?? "");
  }
  return content.join("\n");
}

function toPiToolResult(result: ToolResultMessage): PiToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: result.toolCallId,
    toolName: result.name,
    content: [{ type: "text", text: result.content }],
    isError: result.isError ?? false,
    timestamp: Date.now(),
  };
}

function fromPiToolResult(result: PiToolResultMessage): ToolResultMessage {
  const content = result.content
    .map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`))
    .join("\n");
  return {
    role: "tool",
    toolCallId: result.toolCallId,
    name: result.toolName,
    content,
    isError: result.isError,
  };
}

export function translateContext(
  messages: readonly Message[],
  tools: readonly ProviderToolSchema[],
  model: Model<Api>,
  now = Date.now(),
  systemPrompt: readonly string[] = [],
): Context {
  const timestampBase = now - messages.length;
  return {
    ...(systemPrompt.length === 0 ? {} : { systemPrompt: [...systemPrompt] }),
    messages: messages.map((message, index) =>
      translateMessage(message, model, message.timestamp ?? timestampBase + index),
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
    case "user": {
      const images = (message.images ?? []).filter(validImage);
      if (images.length === 0 || !model.input.includes("image")) {
        return {
          role: "user",
          content:
            message.content.length > 0
              ? message.content
              : images.length > 0
                ? "[image omitted: selected model does not accept image input]"
                : "",
          timestamp,
        };
      }
      return {
        role: "user",
        content: [
          ...(message.content.length === 0
            ? []
            : [{ type: "text" as const, text: message.content }]),
          ...images.map((image) => ({ ...image })),
        ],
        timestamp,
      };
    }
    case "assistant":
      return translateAssistantMessage(message, model, timestamp);
    case "tool":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: "text", text: message.content }],
        isError: message.isError ?? false,
        timestamp: message.timestamp ?? timestamp,
      };
  }
}

function validImage(image: ImageContent): boolean {
  return image.data.length > 0 && image.mimeType.startsWith("image/");
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
  const replay = message.providerReplay;
  const content: PiAssistantMessage["content"] = replay
    ? (structuredClone([...replay.content]) as unknown as PiAssistantMessage["content"])
    : [];
  if (!replay) {
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
  }

  return {
    role: "assistant",
    content,
    api: message.api ?? currentModel.api,
    provider: message.provider ?? currentModel.provider,
    model: message.model ?? currentModel.id,
    usage: toPiUsage(message.usage),
    stopReason: replay?.stopReason ?? (message.toolCalls.length > 0 ? "toolUse" : "stop"),
    ...(replay?.responseId === undefined ? {} : { responseId: replay.responseId }),
    ...(replay?.providerPayload === undefined
      ? {}
      : {
          providerPayload: structuredClone(replay.providerPayload) as unknown as ProviderPayload,
        }),
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
