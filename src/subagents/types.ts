import type { JsonValue, Message, Usage } from "../core/messages.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export type TaskMode = "research" | "patch";
export type TaskResultStatus = "completed" | "blocked" | "failed";
export type ChildSessionStatus = "queued" | "running" | TaskResultStatus | "cancelled";

export interface TaskInput {
  readonly description: string;
  readonly mode?: TaskMode;
  readonly model?: string;
  readonly maxOutputTokens?: number;
}

export interface NormalizedTaskInput extends TaskInput {
  readonly mode: TaskMode;
}

export interface TaskResult {
  readonly status: TaskResultStatus;
  readonly summary: string;
  readonly patch?: string;
  readonly filesConsidered?: readonly string[];
  readonly testsSuggested?: readonly string[];
  readonly blockers?: readonly string[];
  readonly childSessionId: string;
}

export interface CompleteTaskInput {
  readonly status: TaskResultStatus;
  readonly summary: string;
  readonly patch?: string;
  readonly filesConsidered?: readonly string[];
  readonly testsSuggested?: readonly string[];
  readonly blockers?: readonly string[];
}

export interface ChildProviderContext {
  readonly childSessionId: string;
  readonly model: string;
  readonly mode: TaskMode;
  readonly depth: number;
  readonly maxOutputTokens?: number;
}

export interface ChildSessionAdapter {
  append(message: Message): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ChildSessionAdapterContext extends ChildProviderContext {
  readonly checkpointId: string;
}

export interface ChildToolContext extends ChildProviderContext {
  readonly checkpointId: string;
}

export interface ChildSessionInfo {
  readonly childSessionId: string;
  readonly checkpointId: string;
  readonly description: string;
  readonly model: string;
  readonly mode: TaskMode;
  readonly depth: number;
  readonly status: ChildSessionStatus;
  readonly usage: Usage;
  readonly transcript: readonly Message[];
  readonly maxOutputTokens?: number;
  readonly result?: TaskResult;
}

export interface CheckpointFactoryContext {
  readonly signal: AbortSignal;
}

export type CheckpointFactory = (
  context: CheckpointFactoryContext,
) => readonly Message[] | Promise<readonly Message[]>;

export interface SubagentManagerOptions {
  readonly checkpointStore: import("./checkpoint.ts").CheckpointStore;
  readonly createCheckpoint: CheckpointFactory;
  readonly providerFactory: (context: ChildProviderContext) => Provider | Promise<Provider>;
  readonly defaultModel: string;
  readonly maxConcurrency?: number;
  readonly maxDepth?: number;
  readonly additionalSystemPrompt?: readonly string[];
  readonly childSessionFactory?: (
    context: ChildSessionAdapterContext,
  ) => ChildSessionAdapter | Promise<ChildSessionAdapter>;
  readonly childToolsFactory?: (context: ChildToolContext) => ToolRegistry | Promise<ToolRegistry>;
  readonly createChildSessionId?: () => string;
}

export interface SubagentRunOptions {
  /** Depth of the session issuing the task. Root sessions use zero. */
  readonly depth?: number;
  readonly signal?: AbortSignal;
  readonly createCheckpoint?: CheckpointFactory;
}

export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
