import {
  NormalizedProviderError,
  isAbortError,
  normalizeProviderError,
  type AgentEvent,
  type ProviderEvent,
} from "./events.ts";
import type {
  AssistantMessage,
  Message,
  ProviderReplay,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./messages.ts";
import type { Provider } from "../providers/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export interface AgentContextLifecycle {
  /** Return the provider-ready view without changing the supplied full transcript. */
  prepare(
    messages: readonly Message[],
    model: string,
    signal: AbortSignal,
  ): Promise<readonly Message[]>;
  /** Force one compaction after a provider overflow before response deltas. */
  forceCompact(
    messages: readonly Message[],
    model: string,
    signal: AbortSignal,
  ): Promise<readonly Message[]>;
  modelChanged?(model: string): void;
}

export interface AgentLoopOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly tools?: ToolRegistry;
  /** number of retries after the initial request */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly initialMessages?: readonly Message[];
  readonly initialUsage?: Usage;
  readonly contextLifecycle?: AgentContextLifecycle;
  readonly maxOutputTokens?: number;
  /** Additional user-delegated system blocks, ordered from lower to higher precedence. */
  readonly additionalSystemPrompt?: readonly string[];
  /** Brisk-owned instructions resolved immediately before each provider request. */
  readonly dynamicSystemPrompt?: () => readonly string[];
  /** Filter Brisk-owned control messages before context preparation. */
  readonly contextFilter?: (messages: readonly Message[]) => readonly Message[];
  /** Identifies whether this loop is the root session or a delegated child. */
  readonly sessionRolePrompt?: string;
  /** Stop after appending the current tool results when the callback returns true. */
  readonly stopWhen?: () => boolean;
}

export type AgentEventListener = (event: AgentEvent) => void;

interface PendingTurn {
  readonly text: string;
  readonly internal?: UserMessage["internal"];
  readonly resolve: () => void;
  readonly reject: (error: NormalizedProviderError) => void;
}

interface ToolCallBuilder {
  readonly id: string;
  readonly name: string;
  arguments: string;
  ended: boolean;
  resolved: boolean;
}

interface CollectedResponse {
  readonly assistant: AssistantMessage;
  readonly providerToolResults: readonly ToolResultMessage[];
  readonly resolvedToolCallIds: ReadonlySet<string>;
}

export class AgentLoop {
  private readonly provider: Provider;
  private model: string;
  private readonly tools: ToolRegistry;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly contextLifecycle: AgentContextLifecycle | undefined;
  private readonly maxOutputTokens: number | undefined;
  private readonly additionalSystemPrompt: readonly string[];
  private readonly dynamicSystemPrompt: (() => readonly string[]) | undefined;
  private readonly contextFilter:
    ((messages: readonly Message[]) => readonly Message[]) | undefined;
  private readonly sessionRolePrompt: string | undefined;
  private readonly stopWhen: (() => boolean) | undefined;
  private readonly history: Message[];
  private readonly listeners = new Set<AgentEventListener>();
  private readonly pending: PendingTurn[] = [];
  private activeController: AbortController | undefined;
  private draining = false;
  private accumulatedUsage: Usage;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.tools = options.tools ?? new ToolRegistry();
    this.history = [...(options.initialMessages ?? [])];
    this.accumulatedUsage = options.initialUsage ?? { inputTokens: 0, outputTokens: 0 };
    this.contextLifecycle = options.contextLifecycle;
    this.maxOutputTokens = options.maxOutputTokens;
    this.additionalSystemPrompt = [...(options.additionalSystemPrompt ?? [])];
    this.dynamicSystemPrompt = options.dynamicSystemPrompt;
    this.contextFilter = options.contextFilter;
    this.sessionRolePrompt = options.sessionRolePrompt;
    this.stopWhen = options.stopWhen;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative finite number");
    }
    if (
      this.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens <= 0)
    ) {
      throw new RangeError("maxOutputTokens must be a positive integer");
    }
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  get usage(): Usage {
    return this.accumulatedUsage;
  }

  get active(): boolean {
    return this.activeController !== undefined;
  }

  get modelId(): string {
    return this.model;
  }

  setModel(model: string): void {
    if (model.length === 0) throw new TypeError("Model cannot be empty");
    this.model = model;
    this.contextLifecycle?.modelChanged?.(model);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(text: string): Promise<void> {
    return this.enqueue(text);
  }

  /** Queue a persisted Brisk control turn without exposing it as a user-authored UI message. */
  submitInternal(text: string, internal: NonNullable<UserMessage["internal"]>): Promise<void> {
    return this.enqueue(text, internal);
  }

  steer(text: string): Promise<void> {
    const active = this.activeController;
    const completion = this.enqueue(text);
    active?.abort(new DOMException("Steered", "AbortError"));
    return completion;
  }

  cancel(): void {
    this.activeController?.abort(new DOMException("Cancelled", "AbortError"));
  }

  private enqueue(text: string, internal?: UserMessage["internal"]): Promise<void> {
    if (text.length === 0) return Promise.reject(new TypeError("Message cannot be empty"));

    const completion = new Promise<void>((resolve, reject: (error: unknown) => void) => {
      this.pending.push({
        text,
        ...(internal === undefined ? {} : { internal }),
        resolve,
        reject: (error) => reject(error),
      });
    });
    if (!this.draining) void this.drainQueue();
    return completion;
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.pending.length > 0) {
        const pending = this.pending.shift();
        if (!pending) continue;

        const userMessage: UserMessage = {
          role: "user",
          content: pending.text,
          ...(pending.internal === undefined ? {} : { internal: pending.internal }),
        };
        this.history.push(userMessage);
        this.publish({ type: "user_message", message: userMessage });

        const controller = new AbortController();
        this.activeController = controller;
        try {
          await this.runTurn(controller.signal);
          pending.resolve();
        } catch (error) {
          const normalized = normalizeProviderError(error);
          if (controller.signal.aborted || normalized.kind === "aborted" || isAbortError(error)) {
            this.publish({ type: "cancelled" });
            pending.resolve();
          } else {
            this.publish({ type: "error", error: normalized });
            pending.reject(normalized);
          }
        } finally {
          if (this.activeController === controller) this.activeController = undefined;
        }
      }
    } finally {
      this.draining = false;
      this.publish({ type: "idle" });
      if (this.pending.length > 0) void this.drainQueue();
    }
  }

  private async runTurn(signal: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const { assistant, providerToolResults, resolvedToolCallIds } =
        await this.collectResponse(signal);
      throwIfAborted(signal);
      this.accumulatedUsage = addUsage(this.accumulatedUsage, assistant.usage);

      const historyStart = this.history.length;
      this.history.push(assistant);
      this.publish({ type: "assistant_message", message: assistant });
      if (assistant.toolCalls.length === 0) return;

      try {
        const providerResults = new Map(
          providerToolResults.map((result) => [result.toolCallId, result]),
        );
        for (const id of resolvedToolCallIds) {
          if (!providerResults.has(id)) {
            throw invalidResponse(`Provider-resolved tool call ${id} had no result`);
          }
        }
        const pendingCalls = assistant.toolCalls.filter(
          (call) => !resolvedToolCallIds.has(call.id),
        );
        const localResults = await this.executeToolCalls(pendingCalls, signal);
        const results = new Map(providerResults);
        for (const result of localResults) results.set(result.toolCallId, result);
        throwIfAborted(signal);
        for (const call of assistant.toolCalls) {
          const result = results.get(call.id);
          if (!result) throw invalidResponse(`Tool call ${call.id} had no result`);
          this.history.push(result);
          this.publish({ type: "tool_result", message: result });
        }
        if (this.stopWhen?.() === true) return;
      } catch (error) {
        this.history.splice(historyStart);
        throw error;
      }
    }
  }

  private async collectResponse(signal: AbortSignal): Promise<CollectedResponse> {
    let retryAttempt = 0;
    let overflowCompacted = false;
    while (true) {
      let sawDelta = false;
      try {
        return await this.collectResponseAttempt(signal, () => {
          sawDelta = true;
        });
      } catch (error) {
        const normalized = normalizeProviderError(error);
        if (signal.aborted || normalized.kind === "aborted") throw normalized;
        if (
          normalized.kind === "context_overflow" &&
          !sawDelta &&
          !overflowCompacted &&
          this.contextLifecycle
        ) {
          await this.contextLifecycle.forceCompact(this.history, this.model, signal);
          throwIfAborted(signal);
          overflowCompacted = true;
          continue;
        }
        if (!normalized.retryable || sawDelta || retryAttempt >= this.maxRetries) throw normalized;
        const delay = normalized.retryAfter ?? this.retryDelayMs * 2 ** retryAttempt;
        retryAttempt += 1;
        await abortableDelay(delay, signal);
      }
    }
  }

  private async collectResponseAttempt(
    signal: AbortSignal,
    markDelta: () => void,
  ): Promise<CollectedResponse> {
    let content = "";
    let thinking = "";
    let usage: Usage | undefined;
    let providerReplay: ProviderReplay | undefined;
    const providerToolResults = new Map<string, ToolResultMessage>();
    let started = false;
    let sawResponseDelta = false;
    let ended = false;
    let upstreamIdentity:
      | {
          readonly provider?: string;
          readonly api?: string;
          readonly model?: string;
          readonly timestamp?: number;
        }
      | undefined;
    const calls = new Map<number, ToolCallBuilder>();

    const sourceMessages = this.contextFilter?.(this.history) ?? this.history;
    const activeMessages = this.contextLifecycle
      ? await this.contextLifecycle.prepare(sourceMessages, this.model, signal)
      : sourceMessages;
    throwIfAborted(signal);
    const toolSchemas = this.tools.schemas;
    const events = this.provider.stream({
      systemPrompt: buildSystemPrompt(
        toolSchemas,
        [...this.additionalSystemPrompt, ...(this.dynamicSystemPrompt?.() ?? [])],
        this.sessionRolePrompt,
      ),
      messages: [...activeMessages],
      tools: toolSchemas,
      signal,
      model: this.model,
      ...(this.maxOutputTokens === undefined ? {} : { maxOutputTokens: this.maxOutputTokens }),
      executeTool: async (call, dispatchName) =>
        await this.executeProviderTool(call, dispatchName, signal),
    });

    for await (const event of events) {
      throwIfAborted(signal);
      if (ended) {
        throw new NormalizedProviderError("Provider emitted an event after response_end", {
          kind: "invalid_response",
        });
      }

      switch (event.type) {
        case "response_start":
          // Some provider retry wrappers leak a second synthetic start before the
          // first semantic event. Treat that lifecycle marker as idempotent; a
          // restart after content is still a malformed response.
          if (started) {
            if (sawResponseDelta) {
              throw invalidResponse("Provider emitted response_start after response content");
            }
          } else {
            started = true;
            this.publish(event);
          }
          upstreamIdentity = {
            ...(event.provider === undefined ? {} : { provider: event.provider }),
            ...(event.api === undefined ? {} : { api: event.api }),
            ...(event.model === undefined ? {} : { model: event.model }),
            ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
          };
          break;
        case "text_delta":
          markDelta();
          sawResponseDelta = true;
          content += event.delta;
          this.publish(event);
          break;
        case "thinking_delta":
          markDelta();
          sawResponseDelta = true;
          thinking += event.delta;
          this.publish(event);
          break;
        case "tool_call_start":
          markDelta();
          sawResponseDelta = true;
          if (calls.has(event.index)) {
            throw invalidResponse(`Duplicate tool call index ${event.index}`);
          }
          calls.set(event.index, {
            id: event.id,
            name: event.name,
            arguments: event.arguments ?? "",
            ended: false,
            resolved: event.resolved ?? false,
          });
          this.publish(event);
          break;
        case "tool_call_delta": {
          markDelta();
          sawResponseDelta = true;
          const call = calls.get(event.index);
          if (!call) throw invalidResponse(`Tool call delta has unknown index ${event.index}`);
          if (call.ended)
            throw invalidResponse(`Tool call delta followed end for index ${event.index}`);
          call.arguments += event.delta;
          this.publish(event);
          break;
        }
        case "tool_call_end": {
          markDelta();
          sawResponseDelta = true;
          const call = calls.get(event.index);
          if (!call) throw invalidResponse(`Tool call end has unknown index ${event.index}`);
          if (call.ended) throw invalidResponse(`Duplicate tool call end for index ${event.index}`);
          if (event.arguments !== undefined) call.arguments = event.arguments;
          if (event.resolved === true) call.resolved = true;
          call.ended = true;
          this.publish(event);
          break;
        }
        case "provider_tool_result":
          providerToolResults.set(event.message.toolCallId, event.message);
          break;
        case "usage":
          usage = addUsage(usage, event.usage);
          this.publish(event);
          break;
        case "response_end":
          ended = true;
          providerReplay = event.providerReplay;
          this.publish(event);
          break;
        case "error":
          throw event.error;
      }
    }

    throwIfAborted(signal);
    if (!started) throw invalidResponse("Provider response did not start");
    if (!ended) throw invalidResponse("Provider response did not end");

    const toolCalls: ToolCall[] = [];
    const resolvedToolCallIds = new Set<string>();
    const orderedCalls = [...calls.entries()].sort(([left], [right]) => left - right);
    for (const [, call] of orderedCalls) {
      if (!call.ended) throw invalidResponse(`Tool call ${call.id} did not end`);
      toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
      if (call.resolved || providerToolResults.has(call.id)) resolvedToolCallIds.add(call.id);
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content,
      toolCalls,
      ...(thinking.length === 0 ? {} : { thinking }),
      ...(usage === undefined ? {} : { usage }),
      ...(providerReplay === undefined ? {} : { providerReplay }),
      ...upstreamIdentity,
    };
    return {
      assistant,
      providerToolResults: [...providerToolResults.values()],
      resolvedToolCallIds,
    };
  }

  private async executeToolCalls(
    calls: readonly ToolCall[],
    signal: AbortSignal,
    displayCall?: ToolCall,
  ): Promise<ToolResultMessage[]> {
    if (calls.length === 0) return [];
    return await this.tools.execute(calls, signal, {
      onStart: (call) => {
        const display = displayCall ?? call;
        this.publish({ type: "tool_execution_start", id: display.id, name: display.name });
      },
      onOutput: (call, stream, delta) => {
        const display = displayCall ?? call;
        this.publish({
          type: "tool_execution_output",
          id: display.id,
          name: display.name,
          stream,
          delta,
        });
      },
      onPreview: (call, preview) => {
        const display = displayCall ?? call;
        this.publish({
          type: "tool_execution_preview",
          id: display.id,
          name: display.name,
          preview,
        });
      },
      onEnd: (call, result) => {
        const display = displayCall ?? call;
        this.publish({
          type: "tool_execution_end",
          id: display.id,
          name: display.name,
          isError: result.isError ?? false,
        });
      },
    });
  }

  private async executeProviderTool(
    call: ToolCall,
    dispatchName: string | undefined,
    signal: AbortSignal,
  ): Promise<ToolResultMessage> {
    const dispatched = dispatchName ? { ...call, name: dispatchName } : call;
    const [result] = await this.executeToolCalls([dispatched], signal, call);
    if (!result) throw new Error(`Provider tool ${call.id} produced no result`);
    return { ...result, toolCallId: call.id, name: call.name };
  }

  private publish(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function invalidResponse(message: string): NormalizedProviderError {
  return new NormalizedProviderError(message, { kind: "invalid_response" });
}

function addUsage(current: Usage | undefined, addition: Usage | undefined): Usage {
  if (!current && !addition) return { inputTokens: 0, outputTokens: 0 };
  if (!addition) return current ?? { inputTokens: 0, outputTokens: 0 };
  if (!current) return addition;

  return {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
    ...sumOptionalUsage("cacheReadTokens", current, addition),
    ...sumOptionalUsage("cacheWriteTokens", current, addition),
    ...sumOptionalUsage("totalTokens", current, addition),
    ...sumOptionalUsage("cost", current, addition),
  };
}

function sumOptionalUsage(
  key: "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "cost",
  left: Usage,
  right: Usage,
): Partial<Usage> {
  const leftValue = left[key];
  const rightValue = right[key];
  return leftValue === undefined && rightValue === undefined
    ? {}
    : { [key]: (leftValue ?? 0) + (rightValue ?? 0) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NormalizedProviderError("Operation aborted", {
      kind: "aborted",
      cause: signal.reason,
    });
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(
        new NormalizedProviderError("Operation aborted", {
          kind: "aborted",
          cause: signal.reason,
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type { ProviderEvent, ToolResultMessage };
