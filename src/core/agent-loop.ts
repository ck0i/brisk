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
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./messages.ts";
import type { Provider } from "../providers/types.ts";
import { ToolRegistry } from "../tools/registry.ts";

export interface AgentLoopOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly tools?: ToolRegistry;
  /** number of retries after the initial request */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly initialMessages?: readonly Message[];
  readonly initialUsage?: Usage;
}

export type AgentEventListener = (event: AgentEvent) => void;

interface PendingTurn {
  readonly text: string;
  readonly resolve: () => void;
  readonly reject: (error: NormalizedProviderError) => void;
}

interface ToolCallBuilder {
  readonly id: string;
  readonly name: string;
  arguments: string;
  ended: boolean;
}

interface CollectedResponse {
  readonly assistant: AssistantMessage;
}

export class AgentLoop {
  private readonly provider: Provider;
  private model: string;
  private readonly tools: ToolRegistry;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
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
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative finite number");
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
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(text: string): Promise<void> {
    return this.enqueue(text);
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

  private enqueue(text: string): Promise<void> {
    if (text.length === 0) return Promise.reject(new TypeError("Message cannot be empty"));

    const completion = new Promise<void>((resolve, reject: (error: unknown) => void) => {
      this.pending.push({
        text,
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

        const userMessage: UserMessage = { role: "user", content: pending.text };
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
      const { assistant } = await this.collectResponse(signal);
      throwIfAborted(signal);
      this.accumulatedUsage = addUsage(this.accumulatedUsage, assistant.usage);

      const historyStart = this.history.length;
      this.history.push(assistant);
      this.publish({ type: "assistant_message", message: assistant });
      if (assistant.toolCalls.length === 0) return;

      try {
        const results = await this.tools.execute(assistant.toolCalls, signal, {
          onStart: (call) => {
            this.publish({ type: "tool_execution_start", id: call.id, name: call.name });
          },
          onOutput: (call, stream, delta) => {
            this.publish({
              type: "tool_execution_output",
              id: call.id,
              name: call.name,
              stream,
              delta,
            });
          },
          onEnd: (call, result) => {
            this.publish({
              type: "tool_execution_end",
              id: call.id,
              name: call.name,
              isError: result.isError ?? false,
            });
          },
        });
        throwIfAborted(signal);
        for (const result of results) {
          throwIfAborted(signal);
          this.history.push(result);
          this.publish({ type: "tool_result", message: result });
        }
      } catch (error) {
        this.history.splice(historyStart);
        throw error;
      }
    }
  }

  private async collectResponse(signal: AbortSignal): Promise<CollectedResponse> {
    for (let attempt = 0; ; attempt += 1) {
      let sawDelta = false;
      try {
        return await this.collectResponseAttempt(signal, () => {
          sawDelta = true;
        });
      } catch (error) {
        const normalized = normalizeProviderError(error);
        if (signal.aborted || normalized.kind === "aborted") throw normalized;
        if (!normalized.retryable || sawDelta || attempt >= this.maxRetries) throw normalized;
        const delay = normalized.retryAfter ?? this.retryDelayMs * 2 ** attempt;
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
    let started = false;
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

    const events = this.provider.stream({
      messages: [...this.history],
      tools: this.tools.schemas,
      signal,
      model: this.model,
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
          if (started) throw invalidResponse("Provider emitted response_start more than once");
          started = true;
          upstreamIdentity = {
            ...(event.provider === undefined ? {} : { provider: event.provider }),
            ...(event.api === undefined ? {} : { api: event.api }),
            ...(event.model === undefined ? {} : { model: event.model }),
            ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
          };
          this.publish(event);
          break;
        case "text_delta":
          markDelta();
          content += event.delta;
          this.publish(event);
          break;
        case "thinking_delta":
          markDelta();
          thinking += event.delta;
          this.publish(event);
          break;
        case "tool_call_start":
          markDelta();
          if (calls.has(event.index)) {
            throw invalidResponse(`Duplicate tool call index ${event.index}`);
          }
          calls.set(event.index, {
            id: event.id,
            name: event.name,
            arguments: "",
            ended: false,
          });
          this.publish(event);
          break;
        case "tool_call_delta": {
          markDelta();
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
          const call = calls.get(event.index);
          if (!call) throw invalidResponse(`Tool call end has unknown index ${event.index}`);
          if (call.ended) throw invalidResponse(`Duplicate tool call end for index ${event.index}`);
          call.ended = true;
          this.publish(event);
          break;
        }
        case "usage":
          usage = addUsage(usage, event.usage);
          this.publish(event);
          break;
        case "response_end":
          ended = true;
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
    const orderedCalls = [...calls.entries()].sort(([left], [right]) => left - right);
    for (const [, call] of orderedCalls) {
      if (!call.ended) throw invalidResponse(`Tool call ${call.id} did not end`);
      toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content,
      toolCalls,
      ...(thinking.length === 0 ? {} : { thinking }),
      ...(usage === undefined ? {} : { usage }),
      ...upstreamIdentity,
    };
    return { assistant };
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
