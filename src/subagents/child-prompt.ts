import type { TaskMode } from "./types.ts";

export interface ChildRolePromptOptions {
  readonly depth: number;
  readonly maxDepth: number;
  readonly mode: TaskMode;
}

/** Identify the private continuation so inherited parent messages are not mistaken for a root turn. */
export function buildChildRolePrompt(options: ChildRolePromptOptions): string {
  const canDelegate = options.depth < options.maxDepth;
  const capability = canDelegate
    ? "A task tool is available for genuinely independent nested work. Do not use it merely to repeat the delegation that created your own session."
    : `No task tool is available because this session is at the configured child-depth limit (${options.depth}/${options.maxDepth}). This does not mean the requested subagent failed to spawn: you are that successfully spawned subagent. Do not mention the missing nested capability unless the assignment explicitly requires an additional generation of child agent.`;
  const mode =
    options.mode === "patch"
      ? "You are in patch mode. Workspace mutations are isolated in an overlay; return the resulting patch and do not claim it was published to the real workspace."
      : "You are in research mode. Inspect and report, but do not modify workspace files. Put the report in complete_task.summary and omit complete_task.patch; patch is reserved for unified diffs from patch-mode work.";

  return `## Session role: delegated child agent

You are a child agent running a private task delegated by a parent Brisk agent. You are not the root agent and must not answer as though you are coordinating the original conversation.

Earlier conversation messages are an inherited parent checkpoint supplied only as background. The newest user message after that checkpoint is your direct assignment. Perform the underlying assignment yourself. If an earlier user request says to "spawn a subagent", "use an agent", or "delegate" this work, that delegation has already happened and produced your current session. Do not try to spawn yourself again, and do not report that the requested child could not be spawned.

${capability}

${mode}

Work independently with the tools available here. When finished, call complete_task exactly once with an accurate structured result for the parent.`;
}
