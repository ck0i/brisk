import type { ContextManager } from "../context/context-manager.ts";
import type { AgentLoop } from "../core/agent-loop.ts";
import type { JsonValue, Message } from "../core/messages.ts";
import { FakeProvider } from "../providers/fake-provider.ts";
import type { ProviderService } from "../providers/provider-service.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { ArtifactStore } from "../tools/artifact-store.ts";
import type { ApprovalHandler, PermissionManager } from "../tools/approval.ts";
import { registerCodingTools } from "../tools/coding-tools.ts";
import { createFindTool } from "../tools/find.ts";
import { createListTool } from "../tools/list.ts";
import { ToolRegistry, type ToolDefinition } from "../tools/registry.ts";
import { createSearchTool } from "../tools/search.ts";
import { CheckpointStore } from "../subagents/checkpoint.ts";
import { SubagentManager } from "../subagents/manager.ts";
import { PatchOverlayWorkspace, createPatchOverlayTools } from "../subagents/patch-overlay.ts";
import { parseTaskInput, serializeTaskResult } from "../subagents/result.ts";
import { taskInputSchema } from "../subagents/task-tool.ts";
import type {
  ChildSessionAdapter,
  ChildSessionAdapterContext,
  ChildSessionInfo,
  ChildToolContext,
  TaskInput,
  TaskResult,
} from "../subagents/types.ts";
import type { UiAgentIndicator, UiStore } from "../ui/state.ts";

export interface RuntimeSubagentsOptions {
  readonly workspace: string;
  readonly checkpointDirectory: string;
  readonly artifactsDirectory: string;
  readonly defaultModel: string;
  readonly maxConcurrency: number;
  readonly maxDepth: number;
  readonly permissionMode: "safe" | "write" | "yolo";
  readonly approvalHandler: ApprovalHandler;
  readonly permissions: PermissionManager;
  readonly providerService?: ProviderService;
  readonly fakeProvider: boolean;
  readonly parentLoop: AgentLoop;
  readonly contextManager: ContextManager;
  readonly session: SessionRuntime;
  readonly store: UiStore;
}

/** Runtime bridge from the parent task tool to isolated child sessions and UI state. */
export class RuntimeSubagents {
  readonly manager: SubagentManager;
  readonly taskTool: ToolDefinition<TaskInput>;
  private readonly overlays = new Map<string, PatchOverlayWorkspace>();
  private readonly removeStatusListener: () => void;
  private readonly removeDecisionHandler: () => void;
  private disposed = false;

  private constructor(
    private readonly options: RuntimeSubagentsOptions,
    manager: SubagentManager,
  ) {
    this.manager = manager;
    this.removeStatusListener = manager.subscribe((info) => this.publish(info));
    this.removeDecisionHandler = options.store.setAgentDecisionHandler((id, decision) => {
      if (decision === "cancel") manager.cancel(id);
    });
    this.taskTool = this.createTaskDefinition();
  }

  static create(options: RuntimeSubagentsOptions): RuntimeSubagents {
    let runtime: RuntimeSubagents | undefined;
    const manager = new SubagentManager({
      checkpointStore: new CheckpointStore({ directory: options.checkpointDirectory }),
      createCheckpoint: async ({ signal }) => {
        return await options.contextManager.prepare(
          options.parentLoop.messages,
          options.parentLoop.modelId,
          signal,
        );
      },
      providerFactory: (context) => {
        if (options.fakeProvider) {
          return new FakeProvider([
            {
              text: `Completed child task in ${context.mode} mode.`,
              usage: { inputTokens: 8, outputTokens: 6 },
            },
          ]);
        }
        if (!options.providerService) throw new Error("Provider service is unavailable");
        return options.providerService.createIsolatedProvider(context.model, context.childSessionId)
          .provider;
      },
      defaultModel: options.defaultModel,
      maxConcurrency: options.maxConcurrency,
      maxDepth: options.maxDepth,
      childSessionFactory: async (context) => await createChildAdapter(options, context),
      childToolsFactory: async (context) => {
        if (!runtime) throw new Error("Subagent runtime is not initialized");
        return await runtime.createChildTools(context);
      },
    });
    runtime = new RuntimeSubagents(options, manager);
    return runtime;
  }

  openPanel(): boolean {
    return this.options.store.openAgents();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const info of this.manager.list()) {
      if (info.status === "queued" || info.status === "running") {
        this.manager.cancel(info.childSessionId);
      }
    }
    this.removeStatusListener();
    this.removeDecisionHandler();
    for (const overlay of this.overlays.values()) overlay.discard();
    this.overlays.clear();
  }

  private createTaskDefinition(): ToolDefinition<TaskInput> {
    return {
      name: "task",
      description: "Run a focused research or isolated patch task in a context-branched child.",
      inputSchema: taskInputSchema,
      readOnly: true,
      parallelSafe: true,
      parse: parseTaskInput,
      execute: async (input, context) => {
        const allowed = await this.options.permissions.authorize(
          {
            toolName: "task",
            summary: input.description,
            taskPermission: input.mode ?? "research",
          },
          context.signal,
        );
        if (!allowed) {
          return { content: "Subagent task denied by user or policy.", isError: true };
        }
        let result = await this.manager.run(input, { signal: context.signal });
        if (input.mode === "patch") result = await this.finalizePatch(result);
        await this.options.session.recordChild({
          sessionId: result.childSessionId,
          title: input.description,
          createdAt: new Date().toISOString(),
        });
        return {
          content: serializeTaskResult(result),
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      },
    };
  }

  private async createChildTools(context: ChildToolContext): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    if (context.mode === "research") {
      await registerCodingTools(registry, {
        workspace: this.options.workspace,
        artifactsDirectory: `${this.options.artifactsDirectory}/${context.childSessionId}`,
        permissionMode: this.options.permissionMode,
        approvalHandler: this.options.approvalHandler,
        enabledTools: ["read", "search", "find", "list", "bash"],
      });
      return registry;
    }

    const artifacts = new ArtifactStore(
      `${this.options.artifactsDirectory}/${context.childSessionId}`,
    );
    await artifacts.initialize();
    const overlay = new PatchOverlayWorkspace({
      workspace: this.options.workspace,
      artifactOutput: async (artifact) =>
        (
          await artifacts.write(artifact.content, {
            name: artifact.name,
            mediaType: artifact.mediaType,
            encoding: "utf-8",
          })
        ).reference,
    });
    this.overlays.set(context.childSessionId, overlay);
    const tools = createPatchOverlayTools(overlay);
    registry.register(tools.read).register(tools.edit).register(tools.write);
    registry.register(createSearchTool(this.options.workspace));
    registry.register(createFindTool(this.options.workspace));
    registry.register(createListTool(this.options.workspace));
    return registry;
  }

  private async finalizePatch(result: TaskResult): Promise<TaskResult> {
    const overlay = this.overlays.get(result.childSessionId);
    if (!overlay) return result;
    const finalized = await overlay.finalize();
    if (finalized.status === "blocked") {
      return {
        status: "blocked",
        summary: result.summary,
        blockers: [...(result.blockers ?? []), finalized.blocker],
        childSessionId: result.childSessionId,
      };
    }
    const patch = finalized.diff || result.patch;
    const filesConsidered = finalized.files.length > 0 ? finalized.files : result.filesConsidered;
    return {
      ...result,
      ...(patch === undefined ? {} : { patch }),
      ...(filesConsidered === undefined ? {} : { filesConsidered }),
    };
  }

  private publish(info: ChildSessionInfo): void {
    this.options.store.upsertAgent(toUiAgent(info));
  }
}

async function createChildAdapter(
  options: RuntimeSubagentsOptions,
  context: ChildSessionAdapterContext,
): Promise<ChildSessionAdapter> {
  const parsed = splitSpecifier(context.model);
  await options.session.repository.create({
    id: context.childSessionId,
    title: `Child: ${context.mode}`,
    workspace: options.workspace,
    selectedProvider: parsed.provider,
    selectedModel: parsed.model,
  });
  return {
    async append(message: Message) {
      await options.session.repository.append(context.childSessionId, entryForMessage(message));
    },
    async flush() {
      await options.session.repository.flush();
    },
  };
}

function entryForMessage(message: Message) {
  if (message.role === "user") return { type: "user_message" as const, message };
  if (message.role === "assistant") return { type: "assistant_message" as const, message };
  return { type: "tool_result" as const, message };
}

function splitSpecifier(specifier: string): { provider: string; model: string } {
  const separator = specifier.indexOf("/");
  return separator > 0
    ? { provider: specifier.slice(0, separator), model: specifier.slice(separator + 1) }
    : { provider: "unknown", model: specifier };
}

function toUiAgent(info: ChildSessionInfo): UiAgentIndicator {
  const provider = splitSpecifier(info.model).provider;
  const summary = info.result?.summary;
  return {
    id: info.childSessionId,
    childSessionId: info.childSessionId,
    description: info.description,
    provider,
    model: info.model,
    mode: info.mode,
    status: info.status,
    inputTokens: info.usage.inputTokens,
    outputTokens: info.usage.outputTokens,
    transcript: info.transcript.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(summary === undefined ? {} : { summary }),
    ...(info.status === "failed" && summary ? { error: summary } : {}),
  };
}

export function parseRuntimeTaskInput(value: JsonValue): TaskInput {
  return parseTaskInput(value);
}
