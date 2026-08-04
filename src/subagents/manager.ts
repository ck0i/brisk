import { randomUUID } from "node:crypto";

import { AgentLoop, type AgentContextLifecycle } from "../core/agent-loop.ts";
import type { JsonValue, Message } from "../core/messages.ts";
import type { Provider } from "../providers/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { CheckpointStore, withoutPendingToolTurn, type Checkpoint } from "./checkpoint.ts";
import { buildChildRolePrompt } from "./child-prompt.ts";
import { ChildSession } from "./child-session.ts";
import { parseTaskInput } from "./result.ts";
import { createCompleteTaskTool, createTaskTool } from "./task-tool.ts";
import type {
  CheckpointFactory,
  ChildProviderContext,
  ChildSessionInfo,
  NormalizedTaskInput,
  SubagentManagerOptions,
  SubagentRunOptions,
  TaskInput,
  TaskResult,
} from "./types.ts";

export type SubagentManagerListener = (info: ChildSessionInfo) => void;

/** Runs private child continuations over shared immutable context checkpoints. */
export class SubagentManager {
  private readonly checkpointStore: CheckpointStore;
  private readonly createCheckpointCallback: CheckpointFactory;
  private readonly providerFactory: SubagentManagerOptions["providerFactory"];
  private readonly contextLifecycleFactory: SubagentManagerOptions["contextLifecycleFactory"];
  private defaultModel: string;
  private readonly maxDepth: number;
  private readonly additionalSystemPrompt: readonly string[];
  private readonly childSessionFactory: SubagentManagerOptions["childSessionFactory"];
  private readonly childToolsFactory: SubagentManagerOptions["childToolsFactory"];
  private readonly onChildFinished: SubagentManagerOptions["onChildFinished"];
  private readonly createChildSessionId: () => string;
  private readonly semaphore: Semaphore;
  private readonly sessions = new Map<string, ChildSession>();
  private readonly backgroundRuns = new Map<string, Promise<TaskResult>>();
  private readonly pendingCheckpoints = new Map<CheckpointFactory, Promise<Checkpoint>>();
  private readonly listeners = new Set<SubagentManagerListener>();

  constructor(options: SubagentManagerOptions) {
    this.checkpointStore = options.checkpointStore;
    this.createCheckpointCallback = options.createCheckpoint;
    this.providerFactory = options.providerFactory;
    this.contextLifecycleFactory = options.contextLifecycleFactory;
    this.defaultModel = options.defaultModel;
    this.maxDepth = options.maxDepth ?? 1;
    this.additionalSystemPrompt = [...(options.additionalSystemPrompt ?? [])];
    this.childSessionFactory = options.childSessionFactory;
    this.childToolsFactory = options.childToolsFactory;
    this.onChildFinished = options.onChildFinished;
    this.createChildSessionId = options.createChildSessionId ?? randomUUID;
    this.semaphore = new Semaphore(options.maxConcurrency ?? 3);

    if (this.defaultModel.trim().length === 0) throw new TypeError("defaultModel cannot be empty");
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth <= 0) {
      throw new RangeError("maxDepth must be a positive integer");
    }
  }

  get concurrency(): number {
    return this.semaphore.limit;
  }

  get depthLimit(): number {
    return this.maxDepth;
  }

  setDefaultModel(model: string): void {
    if (model.trim().length === 0) throw new TypeError("Default child model cannot be empty");
    this.defaultModel = model;
  }

  subscribe(listener: SubagentManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run(input: TaskInput, options: SubagentRunOptions = {}): Promise<TaskResult> {
    return this.runMany([input], options).then((results) => {
      const result = results[0];
      if (!result) throw new Error("Subagent result invariant failed");
      return result;
    });
  }

  async start(input: TaskInput, options: SubagentRunOptions = {}): Promise<ChildSessionInfo> {
    const parsed = parseTaskInput(input as unknown as JsonValue);
    const parentDepth = options.depth ?? 0;
    if (!Number.isSafeInteger(parentDepth) || parentDepth < 0) {
      throw new RangeError("depth must be a non-negative integer");
    }
    const source = options.createCheckpoint ?? this.createCheckpointCallback;
    const checkpoint = await this.resolveCheckpoint(source, options.signal);
    const session = this.createSession(parsed, checkpoint, parentDepth + 1);
    const unlink = linkAbortSignal(options.signal, session.controller);
    const execution = (async (): Promise<TaskResult> => {
      try {
        if (parentDepth >= this.maxDepth) {
          const result: TaskResult = {
            status: "blocked",
            summary: "Maximum subagent depth reached.",
            blockers: [`Maximum depth is ${this.maxDepth}.`],
            childSessionId: session.childSessionId,
          };
          session.finish(result);
          this.publish(session);
          await this.onChildFinished?.(session.inspect());
          return result;
        }
        return await this.runChild(session);
      } finally {
        unlink();
        this.checkpointStore.release(checkpoint.id);
      }
    })();
    this.backgroundRuns.set(session.childSessionId, execution);
    void execution.catch(() => undefined);
    return session.inspect();
  }

  async wait(childSessionId: string, signal?: AbortSignal): Promise<TaskResult> {
    const session = this.sessions.get(childSessionId);
    if (!session) throw new Error(`Unknown child session: ${childSessionId}`);
    const execution = this.backgroundRuns.get(childSessionId);
    if (execution) await waitWithSignal(execution, signal);
    const result = session.result;
    if (!result) throw new Error(`Child session ${childSessionId} has not completed`);
    return result;
  }

  async runMany(
    inputs: readonly TaskInput[],
    options: SubagentRunOptions = {},
  ): Promise<readonly TaskResult[]> {
    if (inputs.length === 0) return [];
    const parsedInputs = inputs.map((input) => parseTaskInput(input as unknown as JsonValue));
    const parentDepth = options.depth ?? 0;
    if (!Number.isSafeInteger(parentDepth) || parentDepth < 0) {
      throw new RangeError("depth must be a non-negative integer");
    }

    const source = options.createCheckpoint ?? this.createCheckpointCallback;
    const checkpoint = await this.resolveCheckpoint(source, options.signal);

    const childDepth = parentDepth + 1;
    const sessions = parsedInputs.map((input) => this.createSession(input, checkpoint, childDepth));
    const unlinkChildren = sessions.map((session) =>
      linkAbortSignal(options.signal, session.controller),
    );

    try {
      if (parentDepth >= this.maxDepth) {
        return sessions.map((session) => {
          const result: TaskResult = {
            status: "blocked",
            summary: "Maximum subagent depth reached.",
            blockers: [`Maximum depth is ${this.maxDepth}.`],
            childSessionId: session.childSessionId,
          };
          session.finish(result);
          this.publish(session);
          return result;
        });
      }
      return await Promise.all(sessions.map((session) => this.runChild(session)));
    } finally {
      for (const unlink of unlinkChildren) unlink();
      this.checkpointStore.release(checkpoint.id);
    }
  }

  cancel(childSessionId: string): boolean {
    const session = this.sessions.get(childSessionId);
    if (!session) return false;
    if (!isPending(session.status)) return false;
    session.cancel();
    this.publish(session);
    return true;
  }

  list(): readonly ChildSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.inspect());
  }

  get(childSessionId: string): ChildSessionInfo | undefined {
    return this.sessions.get(childSessionId)?.inspect();
  }

  getTranscript(childSessionId: string): readonly Message[] | undefined {
    return this.sessions.get(childSessionId)?.transcript;
  }

  getCheckpoint(childSessionId: string): Checkpoint | undefined {
    return this.sessions.get(childSessionId)?.checkpoint;
  }

  private async resolveCheckpoint(
    source: CheckpointFactory,
    signal: AbortSignal | undefined,
  ): Promise<Checkpoint> {
    let pending = this.pendingCheckpoints.get(source);
    if (!pending) {
      const sourceController = new AbortController();
      const unlink = linkAbortSignal(signal, sourceController);
      pending = Promise.resolve(source({ signal: sourceController.signal }))
        .then((messages) => {
          throwIfAborted(sourceController.signal);
          return this.checkpointStore.capture(withoutPendingToolTurn(messages));
        })
        .finally(unlink);
      this.pendingCheckpoints.set(source, pending);
      const clear = (): void => {
        if (this.pendingCheckpoints.get(source) === pending) {
          this.pendingCheckpoints.delete(source);
        }
        void pending?.then(
          (checkpoint) => this.checkpointStore.release(checkpoint.id),
          () => undefined,
        );
      };
      pending.then(
        () => queueMicrotask(clear),
        () => queueMicrotask(clear),
      );
    }
    const checkpoint = await pending;
    if (signal) throwIfAborted(signal);
    return this.checkpointStore.retain(checkpoint.id);
  }

  private createSession(
    input: NormalizedTaskInput,
    checkpoint: Checkpoint,
    depth: number,
  ): ChildSession {
    const childSessionId = this.createUniqueSessionId();
    const session = new ChildSession({
      childSessionId,
      checkpoint,
      input,
      model: input.model ?? this.defaultModel,
      depth,
    });
    this.sessions.set(childSessionId, session);
    this.publish(session);
    return session;
  }

  private createUniqueSessionId(): string {
    const childSessionId = this.createChildSessionId();
    if (childSessionId.trim().length === 0) {
      throw new TypeError("Child session factory returned an empty id");
    }
    if (this.sessions.has(childSessionId)) {
      throw new Error(`Duplicate child session id: ${childSessionId}`);
    }
    return childSessionId;
  }

  private async runChild(session: ChildSession): Promise<TaskResult> {
    let release: (() => void) | undefined;
    let provider: Provider | undefined;
    let result: TaskResult | undefined;
    let cancelled = false;
    try {
      release = await this.semaphore.acquire(session.controller.signal);
      throwIfAborted(session.controller.signal);
      session.markRunning();
      this.publish(session);

      const providerContext = providerContextFor(session);
      if (this.childSessionFactory) {
        const adapter = await this.childSessionFactory({
          ...providerContext,
          checkpointId: session.checkpoint.id,
        });
        throwIfAborted(session.controller.signal);
        session.setAdapter(adapter);
      }
      provider = await this.providerFactory(providerContext);
      const childContextLifecycle = await this.contextLifecycleFactory?.(providerContext);
      throwIfAborted(session.controller.signal);

      let loop: AgentLoop | undefined;
      const tools = this.childToolsFactory
        ? await this.childToolsFactory({
            ...providerContext,
            checkpointId: session.checkpoint.id,
          })
        : new ToolRegistry();
      if (session.depth < this.maxDepth) {
        tools.register(
          createTaskTool(this, {
            depth: session.depth,
            createCheckpoint: async () => {
              const continuation = loop?.messages ?? session.transcript;
              return composeContext(session.checkpoint.messages, continuation);
            },
          }),
        );
      }
      const completion = createCompleteTaskTool(session.childSessionId);
      tools.register(completion.definition);

      loop = new AgentLoop({
        provider,
        model: session.model,
        tools,
        contextLifecycle: checkpointLifecycle(session.checkpoint, childContextLifecycle),
        additionalSystemPrompt: this.additionalSystemPrompt,
        sessionRolePrompt: buildChildRolePrompt({
          depth: session.depth,
          maxDepth: this.maxDepth,
          mode: session.input.mode,
        }),
        ...(session.input.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: session.input.maxOutputTokens }),
        stopWhen: () => completion.capture.result !== undefined,
      });
      session.attach(loop, () => this.publish(session));
      await loop.submit(session.input.description);

      if (session.controller.signal.aborted) {
        cancelled = true;
        result = cancelledResult(session.childSessionId);
      } else if (completion.capture.result) {
        result = completion.capture.result;
      } else {
        result = fallbackResult(loop.messages, session.childSessionId);
      }
    } catch (error) {
      if (session.controller.signal.aborted || isAbort(error)) {
        cancelled = true;
        result = cancelledResult(session.childSessionId);
      } else {
        result = {
          status: "failed",
          summary: errorMessage(error),
          childSessionId: session.childSessionId,
        };
      }
    } finally {
      provider?.close?.();
      release?.();
    }

    try {
      await session.close();
    } catch (error) {
      if (!cancelled) {
        result = {
          status: "failed",
          summary: errorMessage(error),
          childSessionId: session.childSessionId,
        };
      }
    }
    if (session.controller.signal.aborted) {
      cancelled = true;
      result = cancelledResult(session.childSessionId);
    }
    const finalResult = result ?? {
      status: "failed",
      summary: "Child session ended without a result.",
      childSessionId: session.childSessionId,
    };
    session.finish(finalResult, cancelled);
    this.publish(session);
    await this.onChildFinished?.(session.inspect());
    return finalResult;
  }

  private publish(session: ChildSession): void {
    const info = session.inspect();
    for (const listener of this.listeners) listener(info);
  }
}

function providerContextFor(session: ChildSession): ChildProviderContext {
  return {
    childSessionId: session.childSessionId,
    model: session.model,
    mode: session.input.mode,
    depth: session.depth,
    ...(session.input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: session.input.maxOutputTokens }),
  };
}

function checkpointLifecycle(
  checkpoint: Checkpoint,
  child?: AgentContextLifecycle,
): AgentContextLifecycle {
  return {
    prepare(messages, model, signal, fixedInputTokens) {
      const combined = composeContext(checkpoint.messages, messages);
      return child
        ? child.prepare(combined, model, signal, fixedInputTokens)
        : Promise.resolve(combined);
    },
    forceCompact(messages, model, signal) {
      const combined = composeContext(checkpoint.messages, messages);
      return child ? child.forceCompact(combined, model, signal) : Promise.resolve(combined);
    },
    ...(child?.observeUsage === undefined
      ? {}
      : { observeUsage: (usage) => child.observeUsage?.(usage) }),
    ...(child?.currentTokens === undefined
      ? {}
      : { currentTokens: () => child.currentTokens?.() ?? 0 }),
    ...(child?.modelChanged === undefined
      ? {}
      : { modelChanged: (model) => child.modelChanged?.(model) }),
  };
}

function composeContext(
  prefix: readonly Message[],
  continuation: readonly Message[],
): readonly Message[] {
  return prefix.concat(continuation);
}

function fallbackResult(messages: readonly Message[], childSessionId: string): TaskResult {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const summary = message.content.trim();
    if (summary.length > 0) return { status: "completed", summary, childSessionId };
  }
  return {
    status: "blocked",
    summary: "No result was provided.",
    blockers: ["The child stopped without a completion result or assistant text."],
    childSessionId,
  };
}

function cancelledResult(childSessionId: string): TaskResult {
  return {
    status: "blocked",
    summary: "Cancelled.",
    blockers: ["The child session was cancelled."],
    childSessionId,
  };
}

function isPending(status: ChildSession["status"]): boolean {
  return status === "queued" || status === "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}

interface SemaphoreWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class Semaphore {
  readonly limit: number;
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    this.limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
      };
      const waiter: SemaphoreWaiter = { resolve, reject, signal, onAbort };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}
