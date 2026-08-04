import type { AgentLoop } from "../core/agent-loop.ts";
import type { AgentEvent } from "../core/events.ts";
import type { Message, Usage } from "../core/messages.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type {
  ChildSessionAdapter,
  ChildSessionInfo,
  ChildSessionStatus,
  NormalizedTaskInput,
  TaskResult,
} from "./types.ts";

const zeroUsage: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/** Runtime state and private transcript for one checkpoint continuation. */
export class ChildSession {
  readonly childSessionId: string;
  readonly checkpoint: Checkpoint;
  readonly input: NormalizedTaskInput;
  readonly model: string;
  readonly depth: number;
  readonly controller = new AbortController();

  private statusValue: ChildSessionStatus = "queued";
  private resultValue: TaskResult | undefined;
  private usageValue: Usage = zeroUsage;
  private readonly messages: Message[] = [];
  private adapter: ChildSessionAdapter | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private persistenceFailure: Error | undefined;
  private loop: AgentLoop | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(options: {
    readonly childSessionId: string;
    readonly checkpoint: Checkpoint;
    readonly input: NormalizedTaskInput;
    readonly model: string;
    readonly depth: number;
    readonly adapter?: ChildSessionAdapter;
  }) {
    this.childSessionId = options.childSessionId;
    this.checkpoint = options.checkpoint;
    this.input = options.input;
    this.model = options.model;
    this.depth = options.depth;
    this.adapter = options.adapter;
  }

  get status(): ChildSessionStatus {
    return this.statusValue;
  }

  get result(): TaskResult | undefined {
    return this.resultValue;
  }

  get usage(): Usage {
    return this.loop?.usage ?? this.usageValue;
  }

  get transcript(): readonly Message[] {
    return this.messages;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  setAdapter(adapter: ChildSessionAdapter): void {
    if (this.adapter) throw new Error("Child session already has a persistence adapter");
    if (this.messages.length > 0) throw new Error("Cannot attach persistence after messages exist");
    this.adapter = adapter;
  }

  attach(loop: AgentLoop, onProgress?: () => void): void {
    if (this.loop) throw new Error("Child session already has an agent loop");
    this.loop = loop;
    this.unsubscribe = loop.subscribe((event) => {
      this.record(event);
      if (onProgress && isProgressEvent(event)) onProgress();
    });
  }

  markRunning(): void {
    if (this.statusValue === "queued") this.statusValue = "running";
  }

  finish(result: TaskResult, cancelled = false): void {
    this.resultValue = result;
    this.statusValue = cancelled ? "cancelled" : result.status;
    if (this.loop) this.usageValue = this.loop.usage;
  }

  cancel(reason: unknown = new DOMException("Cancelled", "AbortError")): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
    this.loop?.cancel();
    if (this.statusValue === "queued" || this.statusValue === "running") {
      this.statusValue = "cancelled";
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.writeQueue;
    if (this.persistenceFailure) throw this.persistenceFailure;
    await this.adapter?.flush?.();
    await this.adapter?.close?.();
  }

  inspect(): ChildSessionInfo {
    return {
      childSessionId: this.childSessionId,
      checkpointId: this.checkpoint.id,
      description: this.input.description,
      model: this.model,
      mode: this.input.mode,
      depth: this.depth,
      status: this.statusValue,
      usage: this.usage,
      transcript: this.messages,
      ...(this.input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: this.input.maxOutputTokens }),
      ...(this.resultValue === undefined ? {} : { result: this.resultValue }),
    };
  }

  private record(event: AgentEvent): void {
    const message = messageForEvent(event);
    if (message) this.messages.push(message);
    if (!this.adapter || this.persistenceFailure) return;
    const persist =
      message !== undefined
        ? () => this.adapter?.append(message)
        : event.type === "usage" && this.adapter.appendUsage
          ? () => this.adapter?.appendUsage?.(event.usage)
          : undefined;
    if (!persist) return;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await persist();
      })
      .catch((error: unknown) => {
        this.persistenceFailure = error instanceof Error ? error : new Error(String(error));
      });
  }
}

function isProgressEvent(event: AgentEvent): boolean {
  return (
    event.type === "user_message" ||
    event.type === "assistant_message" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end" ||
    event.type === "tool_result" ||
    event.type === "usage"
  );
}

function messageForEvent(event: AgentEvent): Message | undefined {
  switch (event.type) {
    case "user_message":
    case "assistant_message":
      return event.message;
    case "tool_result":
      return event.message;
    default:
      return undefined;
  }
}
