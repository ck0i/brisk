import type { AgentLoop } from "../core/agent-loop.ts";
import type { AgentEvent } from "../core/events.ts";
import { SessionRepository } from "./repository.ts";
import type { SessionEntryInput } from "./types.ts";

export interface AgentSessionRecorderOptions {
  readonly repository: SessionRepository;
  readonly sessionId: string;
  readonly frameMs?: number;
  readonly onError?: (error: Error) => void;
}

/** Persists normalized agent events in bounded append batches without blocking streaming. */
export class AgentSessionRecorder {
  private readonly repository: SessionRepository;
  private readonly sessionId: string;
  private readonly frameMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly pending: SessionEntryInput[] = [];
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private failureValue: Error | undefined;
  private disposed = false;

  constructor(options: AgentSessionRecorderOptions) {
    this.repository = options.repository;
    this.sessionId = options.sessionId;
    this.frameMs = options.frameMs ?? 12;
    this.onError = options.onError;
    if (!Number.isFinite(this.frameMs) || this.frameMs < 0) {
      throw new RangeError("Session recorder frameMs must be non-negative");
    }
  }

  get failure(): Error | undefined {
    return this.failureValue;
  }

  attach(loop: AgentLoop): void {
    if (this.unsubscribe) throw new Error("Session recorder is already attached");
    if (this.disposed) throw new Error("Session recorder is disposed");
    this.unsubscribe = loop.subscribe((event) => this.record(event));
  }

  record(event: AgentEvent): void {
    if (this.disposed || this.failureValue) return;
    const input = sessionInputForEvent(event);
    if (input) this.pending.push(input);
    if (event.type === "idle") {
      this.scheduleFlush(true);
    } else if (input) {
      this.scheduleFlush(false);
    }
  }

  append(input: SessionEntryInput): void {
    if (this.disposed) throw new Error("Session recorder is disposed");
    if (this.failureValue) throw this.failureValue;
    this.pending.push(input);
    this.scheduleFlush(false);
  }

  async flush(): Promise<void> {
    this.scheduleFlush(true);
    await this.writeQueue;
    if (this.failureValue) throw this.failureValue;
    await this.repository.flush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      await this.flush();
    } finally {
      this.disposed = true;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleFlush(immediate: boolean): void {
    if (this.timer !== undefined) {
      if (!immediate) return;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    if (!immediate && this.frameMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.enqueuePending();
      }, this.frameMs);
      return;
    }
    this.enqueuePending();
  }

  private enqueuePending(): void {
    if (this.pending.length === 0 || this.failureValue) return;
    const batch = this.pending.splice(0);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.repository.appendBatch(this.sessionId, batch);
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failureValue = failure;
        this.onError?.(failure);
      });
  }
}

export function sessionInputForEvent(event: AgentEvent): SessionEntryInput | undefined {
  switch (event.type) {
    case "user_message":
      return { type: "user_message", message: event.message };
    case "response_start":
      return {
        type: "assistant_start",
        ...(event.id === undefined ? {} : { responseId: event.id }),
        ...(event.provider === undefined ? {} : { provider: event.provider }),
        ...(event.api === undefined ? {} : { api: event.api }),
        ...(event.model === undefined ? {} : { model: event.model }),
      };
    case "text_delta":
      return { type: "assistant_text", delta: event.delta };
    case "thinking_delta":
      return { type: "assistant_thinking", delta: event.delta };
    case "tool_call_start":
      return {
        type: "assistant_tool_call_start",
        index: event.index,
        id: event.id,
        name: event.name,
      };
    case "tool_call_delta":
      return { type: "assistant_tool_call_delta", index: event.index, delta: event.delta };
    case "tool_call_end":
      return { type: "assistant_tool_call_end", index: event.index };
    case "usage":
      return { type: "usage", usage: event.usage };
    case "assistant_message":
      return { type: "assistant_message", message: event.message };
    case "tool_result":
      return { type: "tool_result", message: event.message };
    case "cancelled":
      return { type: "cancellation", reason: "cancelled by user" };
    case "error":
      return {
        type: "error",
        message: event.error.message,
        errorKind: event.error.kind,
        retryable: event.error.retryable,
      };
    case "response_end":
    case "tool_execution_start":
    case "tool_execution_output":
    case "tool_execution_end":
    case "idle":
      return undefined;
  }
}
