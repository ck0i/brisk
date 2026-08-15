import type { Api, Model } from "@oh-my-pi/pi-catalog";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import { NormalizedProviderError, type ProviderEvent } from "../core/events.ts";
import type {
  ImageContent,
  JsonValue,
  Message,
  ToolCall,
  Usage,
  UserMessage,
} from "../core/messages.ts";
import { redactedErrorMessage } from "./secret-redaction.ts";
import type { CredentialResolver } from "./pi-ai-provider.ts";
import type { ModelTransport } from "./transport.ts";
import type { JsonSchema, ProviderRequest, ProviderToolSchema } from "./types.ts";

export interface CursorSdkImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface CursorSdkUserMessage {
  readonly text: string;
  readonly images?: readonly CursorSdkImage[];
}

export interface CursorSdkCustomToolContext {
  readonly toolCallId?: string;
}

export interface CursorSdkCustomTool {
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, JsonValue>>;
  execute(
    args: Readonly<Record<string, JsonValue>>,
    context: CursorSdkCustomToolContext,
  ): Promise<{
    readonly content: readonly [{ readonly type: "text"; readonly text: string }];
    readonly isError: boolean;
  }>;
}

export interface CursorSdkDeltaUpdate {
  readonly type: string;
  readonly text?: string;
}

export interface CursorSdkSendOptions {
  readonly model?: { readonly id: string };
  readonly onDelta?: (args: { readonly update: CursorSdkDeltaUpdate }) => void | Promise<void>;
  readonly local?: {
    readonly force?: boolean;
    readonly customTools?: Readonly<Record<string, CursorSdkCustomTool>>;
  };
}

export interface CursorSdkRunResult {
  readonly status: "finished" | "error" | "cancelled";
  readonly result?: string;
  readonly error?: { readonly message: string; readonly code?: string };
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
  };
}

export interface CursorSdkRun {
  readonly id: string;
  wait(): Promise<CursorSdkRunResult>;
  cancel(): Promise<void>;
  supports(operation: "cancel"): boolean;
}

export interface CursorSdkAgent {
  readonly agentId: string;
  send(
    message: string | CursorSdkUserMessage,
    options?: CursorSdkSendOptions,
  ): Promise<CursorSdkRun>;
  close(): void;
}

export interface CursorSdkCreateOptions {
  readonly apiKey: string;
  readonly model: { readonly id: string };
  readonly name?: string;
  readonly agentId?: string;
  readonly tools?: readonly string[];
  readonly local: {
    readonly cwd: string;
    readonly settingSources: readonly string[];
    readonly enableAgentRetries: boolean;
    readonly storeDirectory?: string;
  };
}

export interface CursorSdkRuntime {
  create(options: CursorSdkCreateOptions): Promise<CursorSdkAgent>;
}

export interface CursorSdkProviderOptions {
  readonly model: Model<Api>;
  readonly auth: CredentialResolver;
  readonly workspace: string;
  readonly storeDirectory: string;
  readonly sessionId?: string;
  readonly reasoning?: Effort | "off";
  readonly runtime?: CursorSdkRuntime;
  readonly firstEventTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

type ProviderToolExecutor = NonNullable<ProviderRequest["executeTool"]>;

/** Local Cursor Agent SDK transport. Brisk tools run as host custom tools. */
export class CursorSdkProvider implements ModelTransport {
  private currentModel: Model<Api>;
  private readonly auth: CredentialResolver;
  private readonly workspace: string;
  private readonly storeDirectory: string;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly injectedRuntime: CursorSdkRuntime | undefined;
  private readonly firstEventTimeoutMs: number | undefined;
  private sessionId: string | undefined;
  private generation = 0;
  private agent: CursorSdkAgent | undefined;
  private loadedRuntime: CursorSdkRuntime | undefined;
  private firstPromptSent = false;
  private forceNext = false;

  constructor(options: CursorSdkProviderOptions) {
    this.currentModel = options.model;
    this.auth = options.auth;
    this.workspace = options.workspace;
    this.storeDirectory = options.storeDirectory;
    this.environment = options.environment ?? process.env;
    this.injectedRuntime = options.runtime;
    this.firstEventTimeoutMs = options.firstEventTimeoutMs;
    this.sessionId = options.sessionId;
  }

  get model(): Model<Api> {
    return this.currentModel;
  }

  setModel(model: Model<Api>): void {
    if (model === this.currentModel) return;
    this.disposeAgent();
    this.currentModel = model;
  }

  setReasoning(_reasoning: Effort | "off" | undefined): void {
    // Cursor selects effort through model params. Brisk keeps the catalog picker.
  }

  setSessionId(sessionId: string | undefined): void {
    if (sessionId === this.sessionId) return;
    this.disposeAgent();
    this.sessionId = sessionId;
  }

  close(): void {
    this.disposeAgent();
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const pump = new EventPump();
    const work = this.run(request, pump);
    void work.then(
      () => pump.finish(),
      () => pump.finish(),
    );
    yield* pump.iterate();
    await work.catch(() => undefined);
  }

  private async run(request: ProviderRequest, pump: EventPump): Promise<void> {
    const model = this.currentModel;
    let apiKey: string | undefined;
    let run: CursorSdkRun | undefined;
    const abortRun = (): void => {
      if (run?.supports("cancel") === true) void run.cancel();
    };
    request.signal.addEventListener("abort", abortRun, { once: true });
    try {
      throwIfAborted(request.signal);
      apiKey = await resolveCursorApiKey(this.auth, this.environment, this.sessionId, model);
      throwIfAborted(request.signal);
      if (apiKey === undefined || apiKey.length === 0) {
        throw new NormalizedProviderError("Cursor API key is missing", {
          kind: "auth",
          retryable: false,
        });
      }
      const user = latestUserMessage(request.messages);
      if (!user) {
        throw new NormalizedProviderError("Cursor SDK request has no user message", {
          kind: "invalid_response",
          retryable: false,
        });
      }
      const runtime = await this.runtime();
      const agent = await this.ensureAgent(runtime, apiKey);
      const timeout = this.armFirstEventTimeout(pump, abortRun);
      const customTools =
        request.executeTool === undefined
          ? {}
          : toCustomTools(request.tools, request.executeTool, pump, () => timeout.clear());
      pump.push({
        type: "response_start",
        provider: model.provider,
        api: model.api,
        model: model.id,
        timestamp: Date.now(),
      });
      const prompt = composePrompt(request.systemPrompt, user.content, !this.firstPromptSent);
      const message = toSdkMessage(prompt, user.images);
      run = await agent.send(message, {
        model: { id: model.id },
        onDelta: async ({ update }) => {
          timeout.clear();
          if (update.type === "text-delta" && update.text) {
            pump.push({ type: "text_delta", delta: update.text });
          } else if (update.type === "thinking-delta" && update.text) {
            pump.push({ type: "thinking_delta", delta: update.text });
          }
        },
        local: {
          customTools,
          ...(this.forceNext ? { force: true } : {}),
        },
      });
      this.forceNext = false;
      this.firstPromptSent = true;
      const result = await run.wait();
      timeout.clear();
      throwIfAborted(request.signal);
      if (result.status === "cancelled") {
        throw new NormalizedProviderError("Operation aborted", { kind: "aborted" });
      }
      if (result.status === "error") {
        throw new NormalizedProviderError(result.error?.message ?? "Cursor SDK run failed", {
          kind: "unknown",
          retryable: true,
        });
      }
      if (result.usage) pump.push({ type: "usage", usage: toUsage(result.usage) });
      pump.push({ type: "response_end", stopReason: "stop" });
    } catch (error) {
      this.resetAfterFailure();
      pump.push({
        type: "error",
        error: mapCursorFailure(error, {
          reason: request.signal.aborted ? "aborted" : "error",
          secrets: apiKey === undefined ? [] : [apiKey],
        }),
      });
    } finally {
      request.signal.removeEventListener("abort", abortRun);
    }
  }

  private async runtime(): Promise<CursorSdkRuntime> {
    if (this.injectedRuntime) return this.injectedRuntime;
    this.loadedRuntime ??= await loadBundledCursorSdk(this.storeDirectory);
    return this.loadedRuntime;
  }

  private async ensureAgent(runtime: CursorSdkRuntime, apiKey: string): Promise<CursorSdkAgent> {
    if (this.agent) return this.agent;
    const sessionKey = this.sessionId ?? "anonymous";
    this.agent = await runtime.create({
      apiKey,
      model: { id: this.currentModel.id },
      name: `brisk-${sessionKey}`,
      agentId: `brisk-${sessionKey}-${this.generation}`,
      tools: ["mcp"],
      local: {
        cwd: this.workspace,
        settingSources: [],
        enableAgentRetries: false,
        storeDirectory: this.storeDirectory,
      },
    });
    this.firstPromptSent = false;
    return this.agent;
  }

  private armFirstEventTimeout(pump: EventPump, abortRun: () => void): { clear(): void } {
    if (this.firstEventTimeoutMs === undefined) {
      return {
        clear() {
          // No child stall timer is armed for the root Cursor transport.
        },
      };
    }
    const timer = setTimeout(() => {
      abortRun();
      pump.push({
        type: "error",
        error: new NormalizedProviderError("Cursor SDK stream stalled", {
          kind: "network",
          retryable: true,
        }),
      });
    }, this.firstEventTimeoutMs);
    return {
      clear() {
        clearTimeout(timer);
      },
    };
  }

  private resetAfterFailure(): void {
    this.disposeAgent();
    this.generation += 1;
    this.forceNext = true;
  }

  private disposeAgent(): void {
    const agent = this.agent;
    this.agent = undefined;
    this.firstPromptSent = false;
    try {
      agent?.close();
    } catch {
      // Agent disposal must not prevent session switching or shutdown.
    }
  }
}

class EventPump {
  private readonly events: ProviderEvent[] = [];
  private waiting: (() => void) | undefined;
  private done = false;

  push(event: ProviderEvent): void {
    this.events.push(event);
    this.waiting?.();
    this.waiting = undefined;
  }

  finish(): void {
    this.done = true;
    this.waiting?.();
    this.waiting = undefined;
  }

  async *iterate(): AsyncIterable<ProviderEvent> {
    while (true) {
      const event = this.events.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

function toCustomTools(
  tools: readonly ProviderToolSchema[],
  execute: ProviderToolExecutor,
  pump: EventPump,
  onActivity: () => void,
): Record<string, CursorSdkCustomTool> {
  const custom: Record<string, CursorSdkCustomTool> = {};
  let index = 0;
  for (const tool of tools) {
    custom[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchemaObject(tool.inputSchema),
      async execute(args, context) {
        onActivity();
        const id = context.toolCallId ?? `cursor-tool-${index}`;
        const callIndex = index;
        index += 1;
        const argumentsJson = JSON.stringify(args);
        const call: ToolCall = { id, name: tool.name, arguments: argumentsJson };
        pump.push({
          type: "tool_call_start",
          index: callIndex,
          id,
          name: tool.name,
          arguments: argumentsJson,
          resolved: true,
        });
        await Promise.resolve();
        const result = await execute(call);
        pump.push({ type: "provider_tool_result", message: result });
        pump.push({
          type: "tool_call_end",
          index: callIndex,
          arguments: argumentsJson,
          resolved: true,
        });
        return {
          content: [{ type: "text", text: result.content }],
          isError: result.isError === true,
        };
      },
    };
  }
  return custom;
}

export async function resolveCursorApiKey(
  auth: CredentialResolver,
  environment: Readonly<Record<string, string | undefined>>,
  sessionId: string | undefined,
  model: Model<Api>,
): Promise<string | undefined> {
  const stored = await auth.getApiKey(model.provider, sessionId, {
    baseUrl: model.baseUrl,
    modelId: model.id,
  });
  if (stored && stored.length > 0) return stored;
  const apiKey = environment.CURSOR_API_KEY?.trim();
  if (apiKey) return apiKey;
  const accessToken = environment.CURSOR_ACCESS_TOKEN?.trim();
  return accessToken && accessToken.length > 0 ? accessToken : undefined;
}

function latestUserMessage(messages: readonly Message[]): UserMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}

function composePrompt(
  systemPrompt: readonly string[],
  userContent: string,
  includeSystem: boolean,
): string {
  if (!includeSystem) return userContent;
  const instructions = systemPrompt.filter((block) => block.trim().length > 0).join("\n\n");
  if (instructions.length === 0) return userContent;
  const request = userContent.length > 0 ? userContent : "(see attached images)";
  return `${instructions}\n\n# Current user request\n\n${request}`;
}

function toSdkMessage(
  text: string,
  images: readonly ImageContent[] | undefined,
): string | CursorSdkUserMessage {
  const attached = (images ?? [])
    .filter((image) => image.data.length > 0 && image.mimeType.startsWith("image/"))
    .map((image) => ({ data: image.data, mimeType: image.mimeType }));
  if (attached.length === 0) return text.length > 0 ? text : " ";
  return { text: text.length > 0 ? text : " ", images: attached };
}

function jsonSchemaObject(schema: JsonSchema): Record<string, JsonValue> {
  const cloned: unknown = JSON.parse(JSON.stringify(schema));
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) return {};
  return cloned as Record<string, JsonValue>;
}

function toUsage(usage: NonNullable<CursorSdkRunResult["usage"]>): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
  };
}

function mapCursorFailure(
  error: unknown,
  options: { readonly reason: "error" | "aborted"; readonly secrets: readonly string[] },
): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) {
    return new NormalizedProviderError(
      redactedErrorMessage(error, options.secrets, error.message),
      {
        kind: options.reason === "aborted" ? "aborted" : error.kind,
        retryable: options.reason === "aborted" ? false : error.retryable,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
      },
    );
  }
  if (options.reason === "aborted" || isAbortError(error)) {
    return new NormalizedProviderError("Operation aborted", { kind: "aborted", retryable: false });
  }
  const status = errorStatus(error);
  const retryable = errorRetryable(error);
  const kind =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate_limit"
        : retryable
          ? "network"
          : "unknown";
  return new NormalizedProviderError(
    redactedErrorMessage(error, options.secrets, "Cursor SDK request failed"),
    {
      kind,
      retryable: kind === "network" || kind === "rate_limit",
      ...(status === undefined ? {} : { status }),
    },
  );
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function errorRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "isRetryable" in error &&
    error.isRetryable === true
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NormalizedProviderError("Operation aborted", {
      kind: "aborted",
      cause: signal.reason,
    });
  }
}

async function loadBundledCursorSdk(storeDirectory: string): Promise<CursorSdkRuntime> {
  const sdk = await import("@cursor/sdk/bundled");
  const store = new sdk.JsonlLocalAgentStore(storeDirectory);
  return {
    async create(options) {
      const agent = await sdk.Agent.create({
        apiKey: options.apiKey,
        model: options.model,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        tools: ["mcp"],
        local: {
          cwd: options.local.cwd,
          enableAgentRetries: options.local.enableAgentRetries,
          store,
        },
      });
      return {
        agentId: agent.agentId,
        async send(message, sendOptions) {
          const payload = typeof message === "string" ? message : toMutableUserMessage(message);
          const run = await agent.send(payload, sendOptions as never);
          return {
            id: run.id,
            wait: async () => await run.wait(),
            cancel: async () => await run.cancel(),
            supports: (operation) => run.supports(operation),
          };
        },
        close() {
          agent.close();
        },
      };
    },
  };
}

function toMutableUserMessage(message: CursorSdkUserMessage): {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
} {
  if (message.images === undefined) return { text: message.text };
  return { text: message.text, images: [...message.images] };
}
