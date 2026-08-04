import type { JsonSchema } from "../providers/types.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import {
  parseCompleteTaskInput,
  parseTaskInput,
  serializeTaskResult,
  withChildSessionId,
} from "./result.ts";
import type { SubagentManager } from "./manager.ts";
import type { CompleteTaskInput, SubagentRunOptions, TaskInput, TaskResult } from "./types.ts";

export const SUBAGENT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export interface TaskToolOptions extends SubagentRunOptions {}

export interface CompletionCapture {
  readonly result: TaskResult | undefined;
}

export interface CompleteTaskTool {
  readonly definition: ToolDefinition<CompleteTaskInput>;
  readonly capture: CompletionCapture;
}

export const taskInputSchema: JsonSchema = {
  type: "object",
  properties: {
    description: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["research", "patch"] },
    model: {
      type: "string",
      minLength: 1,
      description:
        "Optional per-task provider/model override. Omit to use the configured default subtask model.",
    },
    maxOutputTokens: { type: "integer", minimum: 1 },
  },
  required: ["description"],
  additionalProperties: false,
};

const completionProperties = {
  status: { type: "string" as const, enum: ["completed", "blocked", "failed"] },
  summary: { type: "string" as const, minLength: 1 },
  patch: {
    type: "string" as const,
    description:
      "Unified diff produced by patch-mode work only. Never place prose, analysis, or a research report here; put that in summary.",
  },
  filesConsidered: { type: "array" as const, items: { type: "string" as const } },
  testsSuggested: { type: "array" as const, items: { type: "string" as const } },
  blockers: { type: "array" as const, items: { type: "string" as const } },
};

export const completeTaskInputSchema: JsonSchema = {
  type: "object",
  properties: completionProperties,
  required: ["status", "summary"],
  additionalProperties: false,
};

/** Parent-facing tool. Its content is exactly one compact structured result. */
export function createTaskTool(
  manager: SubagentManager,
  options: TaskToolOptions = {},
): ToolDefinition<TaskInput> {
  return {
    name: "task",
    description:
      "Run a focused task in a private context-branched child session. Address description directly to the child with the underlying work; do not ask it to spawn itself.",
    inputSchema: taskInputSchema,
    readOnly: true,
    parallelSafe: true,
    timeoutMs: SUBAGENT_TASK_TIMEOUT_MS,
    parse: parseTaskInput,
    async execute(input, context) {
      const result = await manager.run(input, {
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        signal: context.signal,
        ...(options.createCheckpoint === undefined
          ? {}
          : { createCheckpoint: options.createCheckpoint }),
      });
      return { content: serializeTaskResult(result) };
    },
  };
}

/** Child-only terminal tool. The first valid call wins and asks AgentLoop to stop. */
export function createCompleteTaskTool(childSessionId: string): CompleteTaskTool {
  let result: TaskResult | undefined;
  const capture: CompletionCapture = {
    get result() {
      return result;
    },
  };
  return {
    capture,
    definition: {
      name: "complete_task",
      description: "Finish the child task with its concise structured result.",
      inputSchema: completeTaskInputSchema,
      parse: parseCompleteTaskInput,
      execute(input) {
        if (!result) result = withChildSessionId(input, childSessionId);
        return { content: serializeTaskResult(result) };
      },
    },
  };
}
