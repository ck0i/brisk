import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommand } from "../cli/args.ts";
import { ConfigManager } from "../config/manager.ts";
import { ensureConfigDirectories, resolveConfigPaths, type ConfigPaths } from "../config/paths.ts";
import type { BriskConfig, ConfigOverrides, EffortSetting } from "../config/schema.ts";
import { writeConfigValue } from "../config/write.ts";
import { ContextManager, type ContextInspection, type ContextModel } from "../context/index.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import { discoverAgentsInstructions } from "../core/agents-instructions.ts";
import { buildWorkspacePrompt } from "../core/system-prompt.ts";
import type { JsonValue, Message, ToolResultMessage } from "../core/messages.ts";
import { FakeProvider } from "../providers/fake-provider.ts";
import { redactedErrorMessage } from "../providers/secret-redaction.ts";
import { openFileInEditor } from "./file-opener.ts";
import { BUILT_IN_BRISK_OAUTH_PROVIDERS } from "../providers/auth-service.ts";
import {
  ProviderService,
  resolveEffortSetting,
  splitModelSpecifier,
  supportedEffortSettings,
  type ModelSelection,
} from "../providers/provider-service.ts";
import { registerCodingTools, type CodingToolServices } from "../tools/coding-tools.ts";
import { cleanupToolProcesses } from "../tools/process-registry.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { TuiRuntime } from "../app.tsx";
import { RuntimeExtensions } from "./extension-runtime.ts";
import { BtwRuntime } from "./btw-runtime.ts";
import { GoalRuntime } from "./goal-runtime.ts";
import { LoopRuntime } from "./loop-runtime.ts";
import { SessionRuntime } from "./session-runtime.ts";
import { RuntimeSubagents } from "./subagent-runtime.ts";
import { AgentUiController } from "../ui/agent-controller.ts";
import { UiApprovalController } from "../ui/approval-controller.ts";
import { UiAuthController } from "../ui/auth-controller.ts";
import { UiPickerController } from "../ui/picker-controller.ts";
import { BUILT_IN_SLASH_COMMANDS } from "../ui/slash-commands.ts";
import { UiStore, type UiMessage, type UiSnapshot, type UiToolCard } from "../ui/state.ts";
import { UiTextInputController } from "../ui/text-input-controller.ts";
import {
  extractToolDiff,
  summarizeToolCall,
  summarizeToolResult,
} from "../ui/tool-presentation.ts";

export type TuiCommand = Extract<CliCommand, { readonly name: "tui" }>;

export interface InteractiveRuntimeOptions {
  readonly workspace: string;
  readonly command: TuiCommand;
}

/** Coordinates post-first-draw configuration, provider selection, and local commands. */
export class InteractiveRuntime {
  readonly paths: ConfigPaths;
  readonly configManager: ConfigManager;
  private providerService: ProviderService | undefined;
  private sessionRuntime: SessionRuntime | undefined;
  private controller: AgentUiController | undefined;
  private agentLoop: AgentLoop | undefined;
  private contextManager: ContextManager | undefined;
  private compactionController: AbortController | undefined;
  private agentInstructionPrompts: readonly string[] = [];
  private tools = new ToolRegistry();
  private codingServices: CodingToolServices | undefined;
  private subagents: RuntimeSubagents | undefined;
  private extensions: RuntimeExtensions | undefined;
  private btw: BtwRuntime | undefined;
  private goalMode: GoalRuntime | undefined;
  private loopMode: LoopRuntime | undefined;
  private readonly approvalController: UiApprovalController;
  private readonly authController: UiAuthController;
  private readonly pickerController: UiPickerController;
  private readonly textInputController: UiTextInputController;
  private readonly deferredOperations: Array<{
    readonly description: string;
    readonly run: () => Promise<void>;
  }> = [];
  private deferredIdleUnsubscribe: (() => void) | undefined;
  private drainingDeferredOperations = false;
  private closed = false;

  private constructor(
    private readonly options: InteractiveRuntimeOptions,
    private readonly store: UiStore,
    paths: ConfigPaths,
    configManager: ConfigManager,
  ) {
    this.paths = paths;
    this.configManager = configManager;
    this.approvalController = new UiApprovalController(store);
    this.authController = new UiAuthController(store);
    this.pickerController = new UiPickerController(store);
    this.textInputController = new UiTextInputController(store);
  }

  static async initialize(
    options: InteractiveRuntimeOptions,
    store: UiStore,
  ): Promise<InteractiveRuntime> {
    const workspaceStat = await stat(options.workspace).catch(() => undefined);
    if (!workspaceStat?.isDirectory()) {
      throw new Error(`Workspace does not exist: ${options.workspace}`);
    }

    const paths = resolveConfigPaths();
    await ensureConfigDirectories(paths);
    const cliOverrides: ConfigOverrides = {
      ...(options.command.permissionMode === undefined
        ? {}
        : { permissionMode: options.command.permissionMode }),
      ...(options.command.model === undefined ? {} : { defaultModel: options.command.model }),
      ...(options.command.goalMaxTurns === undefined
        ? {}
        : { goalMaxTurns: options.command.goalMaxTurns }),
    };
    const configManager = await ConfigManager.create({
      paths,
      workspace: options.workspace,
      ...(Object.keys(cliOverrides).length === 0 ? {} : { cliOverrides }),
    });
    const runtime = new InteractiveRuntime(options, store, paths, configManager);
    runtime.applyConfigToUi();
    runtime.showConfigWarnings();

    try {
      await runtime.initializeAgentInstructions();
      await runtime.initializeSession();
      runtime.initializeBuiltInModes();
      await runtime.initializeCodingTools();
      if (options.command.fakeProvider) await runtime.initializeFakeProvider();
      else await runtime.initializeProviderService();
      await runtime.initializeExtensions();
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async submit(value: string, tui: TuiRuntime): Promise<boolean> {
    this.assertOpen();
    if (value.startsWith("/")) return await this.executeCommand(value, tui);
    if (!this.controller) {
      this.addSystem("No model is selected. Use `/login`, `/model`, or configure an API key.");
      return true;
    }
    this.loopMode?.capturePrompt(value);
    try {
      await this.runAgentPrompt(value, this.store.snapshot.busy ? "steer" : "submit");
    } catch {
      // Provider failures are normalized and already visible through AgentUiController.
    }
    return true;
  }

  abort(): void {
    this.compactionController?.abort(new DOMException("Cancelled", "AbortError"));
    this.authController.cancel();
    this.controller?.cancel();
    if (!this.controller) this.store.update({ busy: false, status: "cancelled" });
  }

  showModels(): void {
    const models = this.providerService?.models ?? [];
    if (models.length === 0) {
      this.addSystem("No model catalog is loaded yet. Use `/login` or check configuration.");
      return;
    }
    const available = models.filter((model) => model.available);
    const lines = available.slice(0, 80).map((model) => {
      const context =
        model.contextWindow === null ? "unknown" : model.contextWindow.toLocaleString();
      return `- \`${model.provider}/${model.id}\` · ${context} context`;
    });
    const omitted = available.length - lines.length;
    this.addSystem(
      `**Available models (${available.length})**\n\n${lines.join("\n") || "None"}${omitted > 0 ? `\n- … ${omitted} more; use \`brisk models\`` : ""}`,
    );
  }

  async openModelPicker(): Promise<void> {
    const selected = await this.pickModel();
    if (selected) await this.changeModel(selected);
  }

  async openSessionPicker(): Promise<void> {
    const selected = await this.pickSession();
    if (selected) await this.switchSession(selected);
  }

  async openPath(authoredPath: string, tui: TuiRuntime): Promise<void> {
    const paths = this.codingServices?.hashline.paths;
    if (!paths) {
      this.store.update({ status: "tools loading" });
      return;
    }
    try {
      const resolved = paths.resolveRead(authoredPath);
      this.store.update({ status: `opening ${resolved.displayPath}` });
      await tui.runSuspended(async () => await openFileInEditor(resolved.canonicalPath));
    } catch (error) {
      this.store.update({
        status: "editor failed",
        notice: redactedErrorMessage(error),
      });
      return;
    }
    this.store.update({ status: this.store.snapshot.busy ? "responding" : "ready" });
  }

  async invokeKeybinding(key: string): Promise<void> {
    const result = await this.extensions?.invokeKeybinding(key);
    if (!result?.found) return;
    if (result.output) this.addSystem(result.output);
    else if (!result.ok) this.addSystem(`Extension keybinding \`${key}\` failed.`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.deferredIdleUnsubscribe?.();
    this.deferredIdleUnsubscribe = undefined;
    this.deferredOperations.length = 0;
    this.compactionController?.abort(new DOMException("Closing", "AbortError"));
    await this.btw?.dispose();
    this.btw = undefined;
    this.loopMode?.detach();
    this.goalMode?.detachAgent();
    this.goalMode?.clearStatus();
    this.controller?.cancel();
    this.controller?.dispose();
    this.subagents?.dispose();
    await this.extensions?.emitLifecycle("session-end", {
      sessionId: this.sessionRuntime?.sessionId ?? "unknown",
    });
    await this.extensions?.emitLifecycle("shutdown");
    await this.extensions?.dispose();
    this.approvalController.dispose();
    this.authController.dispose();
    this.pickerController.dispose();
    this.textInputController.dispose();
    await this.sessionRuntime?.close();
    this.providerService?.close();
    await cleanupToolProcesses();
  }

  private async initializeAgentInstructions(): Promise<void> {
    const discovered = await discoverAgentsInstructions({
      workspace: this.options.workspace,
      userAgentsPath: this.paths.userAgentsPath,
    });
    this.agentInstructionPrompts = [buildWorkspacePrompt(this.options.workspace), ...discovered];
  }

  private async initializeSession(): Promise<void> {
    const preferred = this.options.command.model ?? this.configManager.current.defaultModel;
    const parsed = preferred ? splitModelSpecifier(preferred) : undefined;
    this.sessionRuntime = await SessionRuntime.initialize({
      sessionsDir: this.paths.sessionsDir,
      sessionIndexPath: this.paths.sessionIndexPath,
      artifactsDir: this.paths.artifactsDir,
      workspace: this.options.workspace,
      ...(this.options.command.sessionId === undefined
        ? {}
        : { sessionId: this.options.command.sessionId }),
      ...(this.options.command.continueLast ? { continueLast: true } : {}),
      ...(parsed === undefined
        ? {}
        : { selectedProvider: parsed.provider, selectedModel: parsed.id }),
    });
    this.hydrateSessionUi();
  }

  private initializeBuiltInModes(): void {
    const session = this.requireSessionRuntime();
    this.loopMode = new LoopRuntime({
      notify: (message) => this.addSystem(message),
      setStatus: (loopStatus) => this.store.update({ loopStatus }),
    });
    this.goalMode = new GoalRuntime({
      session,
      configuredMaxTurns: () =>
        this.configManager.current.goalMaxTurns ?? configuredGoalMaxTurns(process.env),
      notify: (message) => this.addSystem(message),
      setStatus: (goalStatus) => this.store.update({ goalStatus }),
    });
    this.goalMode.restore();
    this.btw = new BtwRuntime({
      store: this.store,
      createProvider: (threadId) => {
        const model = this.agentLoop?.modelId;
        if (!model) throw new Error("No main-agent model is selected");
        if (this.options.command.fakeProvider) {
          return {
            provider: new FakeProvider(
              Array.from({ length: 32 }, () => ({
                text: "The fake BTW side agent completed successfully.",
                usage: { inputTokens: 8, outputTokens: 7, cost: 0 },
              })),
            ),
            model,
            label: `${model} · ${this.store.snapshot.effort}`,
          };
        }
        const providers = this.providerService;
        if (!providers) throw new Error("Provider service is unavailable");
        const selection = providers.createIsolatedProvider(
          model,
          threadId,
          this.configManager.current.effort,
        );
        return {
          provider: selection.provider,
          model: selection.modelSpecifier,
          label: `${selection.modelSpecifier} · ${selection.effort}`,
        };
      },
      createTools: async (threadId) => {
        const tools = new ToolRegistry();
        await registerCodingTools(tools, {
          workspace: this.options.workspace,
          artifactsDirectory: `${this.requireSessionRuntime().artifactDirectory}/${threadId}`,
          permissionMode: this.configManager.current.permissionMode,
          approvalHandler: this.approvalController,
          enabledTools: ["read", "search", "find", "list"],
        });
        return tools;
      },
      createContext: async (signal) => {
        const loop = this.agentLoop;
        const manager = this.contextManager;
        if (!loop || !manager) throw new Error("Main-agent context is unavailable");
        const messages = this.goalMode?.filterContext(loop.messages) ?? loop.messages;
        return await manager.prepare(messages, loop.modelId, signal);
      },
      getMainMessages: () => this.agentLoop?.messages ?? [],
      getLiveStatus: () => btwLiveStatus(this.store.snapshot),
      additionalSystemPrompt: () => [
        ...this.agentInstructionPrompts,
        ...(this.goalMode?.dynamicSystemPrompt() ?? []),
      ],
      onCost: async (cost) => {
        this.store.update({ cost: this.store.snapshot.cost + cost });
        try {
          await this.requireSessionRuntime().recordSubagentCost(cost);
        } catch (error) {
          this.addSystem(`Unable to persist BTW cost: ${redactedErrorMessage(error)}`);
        }
      },
    });
  }

  private async runAgentPrompt(text: string, delivery: "submit" | "steer" | "goal"): Promise<void> {
    const controller = this.controller;
    if (!controller) throw new Error("No model is selected");
    const sessionId = this.sessionRuntime?.sessionId ?? "unknown";
    await this.extensions?.emitLifecycle("turn-start", { sessionId });
    try {
      if (controller !== this.controller) return;
      if (delivery === "steer") await controller.steer(text);
      else if (delivery === "goal") await controller.submitInternal(text, "goal-control");
      else await controller.submit(text);
    } finally {
      await this.extensions?.emitLifecycle("turn-end", { sessionId });
    }
  }

  private async initializeCodingTools(): Promise<void> {
    const session = this.requireSessionRuntime();
    this.codingServices = await registerCodingTools(this.tools, {
      workspace: this.options.workspace,
      artifactsDirectory: session.artifactDirectory,
      permissionMode: this.configManager.current.permissionMode,
      approvalHandler: this.approvalController,
    });
    this.tools.register(this.goalMode!.tool);
  }

  private async initializeExtensions(): Promise<void> {
    const runtime = new RuntimeExtensions({
      workspace: this.options.workspace,
      globalDirectory: this.paths.extensionsDir,
      errorsPath: join(this.paths.extensionsDir, "errors.json"),
      approvalHandler: this.approvalController,
      permissionMode: this.configManager.current.permissionMode,
      store: this.store,
    });
    this.extensions = runtime;
    try {
      const summary = await runtime.load();
      this.installExtensionTools();
      await runtime.emitLifecycle("session-start", {
        sessionId: this.requireSessionRuntime().sessionId,
        workspace: this.options.workspace,
      });
      if (summary.discovered > 0) {
        this.addSystem(
          `Extensions: ${summary.loaded} loaded, ${summary.denied} denied, ${summary.failed} failed.`,
        );
      }
    } catch (error) {
      this.addSystem(`Extension initialization failed: ${redactedErrorMessage(error)}`);
    }
  }

  private installExtensionTools(): void {
    const result = this.extensions?.installTools(this.tools);
    if (result && result.skipped.length > 0) {
      this.addSystem(
        `Extension tools skipped because names are already registered: ${result.skipped.join(", ")}.`,
      );
    }
  }

  private createContextManager(model: ContextModel): ContextManager {
    const session = this.requireSessionRuntime();
    const compaction = this.configManager.current.compaction;
    const manager = new ContextManager({
      model,
      recentTargetTokens: compaction.keepRecentTokens,
      automaticCompaction: compaction.enabled,
      thresholdPercent: compaction.thresholdPercent / 100,
      initialMessages: session.messages,
      initialCompactionCount: session.metadata.compactionCount,
      ...(session.previousCompaction === undefined
        ? {}
        : { previousCompaction: session.previousCompaction }),
      persist: async (entry) => {
        this.store.update({ status: "compacting context" });
        await session.recordCompaction(entry.compaction);
        this.store.update({ status: "context compacted" });
      },
      resolveModel: (specifier) => this.resolveContextModel(specifier),
    });
    this.contextManager = manager;
    return manager;
  }

  private resolveContextModel(specifier: string): ContextModel | undefined {
    const parsed = splitModelSpecifier(specifier);
    if (!parsed) return undefined;
    const record = this.providerService?.registry.select(parsed.provider, parsed.id);
    const upstream = this.providerService?.registry.resolveUpstreamModel(
      parsed.provider,
      parsed.id,
    );
    if (!record || !upstream) return undefined;
    return {
      provider: record.provider,
      api: upstream.api,
      model: specifier,
      contextWindow: record.contextWindow,
      supportsImages: record.input.includes("image"),
    };
  }

  private async initializeProviderService(): Promise<void> {
    const session = this.requireSessionRuntime();
    const preferredModel =
      this.options.command.model ??
      session.selectedModelSpecifier ??
      this.configManager.current.defaultModel;
    const providers = await ProviderService.initialize({
      paths: this.paths,
      config: this.configManager.current,
      ...(preferredModel === undefined ? {} : { preferredModel }),
      sessionId: session.sessionId,
    });
    this.providerService = providers;
    this.store.update({ status: `models cached · ${providers.models.length}` });
    const selection = await providers.selectInitial();
    const selectedName = selection ? modelName(selection) : undefined;
    if (this.options.command.model && selectedName !== this.options.command.model) {
      this.addSystem(
        `Requested model \`${this.options.command.model}\` is unavailable. ${selectedName ? `Using \`${selectedName}\`.` : "No fallback is available."}`,
      );
    }
    if (selection) await this.activateSelection(selection);
    else this.store.update({ status: "login or model required", providerModel: "no model" });
  }

  private async initializeFakeProvider(): Promise<void> {
    const provider = new FakeProvider([
      {
        id: "fake-1",
        thinking: ["Plan the response. ", { value: "Choose a tool.", delayMs: 8 }],
        text: [
          "I will exercise the streaming tool loop. ",
          { value: "Calling echo now.", delayMs: 8 },
        ],
        toolCalls: [
          {
            id: "fake-echo",
            name: "echo",
            argumentChunks: ['{"value":', '"Brisk tool result"}'],
          },
        ],
        usage: { inputTokens: 18, outputTokens: 12, cost: 0 },
      },
      {
        id: "fake-2",
        text: [
          "The fake provider completed successfully.\n\n",
          "Tool streaming, ordered results, usage, and the follow-up turn are active.",
        ],
        usage: { inputTokens: 30, outputTokens: 19, cost: 0 },
      },
    ]);
    this.tools.register<{ readonly value: string }>({
      name: "echo",
      description: "Return a string",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      readOnly: true,
      parallelSafe: true,
      parse(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new TypeError("arguments must be an object");
        }
        const record = value as Readonly<Record<string, import("../core/messages.ts").JsonValue>>;
        const item = record.value;
        if (typeof item !== "string") throw new TypeError("value must be a string");
        return { value: item };
      },
      execute(input) {
        return { content: input.value };
      },
    });
    const session = this.requireSessionRuntime();
    const contextManager = this.createContextManager({
      provider: "fake",
      api: "openai-completions",
      model: "fake/brisk-demo",
      contextWindow: 64_000,
      supportsImages: false,
    });
    const loop = new AgentLoop({
      provider,
      tools: this.tools,
      model: "fake/brisk-demo",
      initialMessages: session.messages,
      initialUsage: session.usage,
      contextLifecycle: contextManager,
      additionalSystemPrompt: this.agentInstructionPrompts,
      dynamicSystemPrompt: () => this.goalMode?.dynamicSystemPrompt() ?? [],
      contextFilter: (messages) => this.goalMode?.filterContext(messages) ?? messages,
      stopWhen: () => this.goalMode?.consumeStopRequested() ?? false,
    });
    this.installAgentLoop(loop);
    if (session.selectedModelSpecifier !== "fake/brisk-demo") {
      await session.recordModelChange("fake", "brisk-demo");
    }
    this.store.update({ providerModel: "fake/brisk-demo", effort: "off", status: "ready" });
    await this.initializeSubagents(this.resolveDefaultSubtaskModel("fake/brisk-demo"));
  }

  private async activateSelection(selection: ModelSelection): Promise<void> {
    const providers = this.providerService;
    const provider = providers?.provider;
    if (!providers || !provider) {
      throw new Error("Selected model did not initialize a provider transport");
    }
    const session = this.requireSessionRuntime();
    const selectedName = modelName(selection);
    providers.setSessionId(session.sessionId);
    const contextModel = contextModelForSelection(selection);
    const contextManager = this.contextManager ?? this.createContextManager(contextModel);
    contextManager.setModel(contextModel);
    if (!this.agentLoop) {
      this.installAgentLoop(
        new AgentLoop({
          provider,
          tools: this.tools,
          model: selectedName,
          initialMessages: session.messages,
          initialUsage: session.usage,
          contextLifecycle: contextManager,
          additionalSystemPrompt: this.agentInstructionPrompts,
          dynamicSystemPrompt: () => this.goalMode?.dynamicSystemPrompt() ?? [],
          contextFilter: (messages) => this.goalMode?.filterContext(messages) ?? messages,
          stopWhen: () => this.goalMode?.consumeStopRequested() ?? false,
        }),
      );
    } else {
      this.agentLoop.setModel(selectedName);
    }
    if (session.selectedModelSpecifier !== selectedName) {
      await session.recordModelChange(selection.record.provider, selection.record.id);
    }
    const effort = providers.setEffort(this.configManager.current.effort);
    this.store.update({
      providerModel: selectedName,
      effort,
      contextWindow: selection.record.contextWindow ?? undefined,
      status: this.agentLoop?.active === true ? "model updated · next request" : "ready",
    });
    const defaultSubtaskModel = this.resolveDefaultSubtaskModel(selectedName);
    await this.initializeSubagents(defaultSubtaskModel);
    this.subagents?.setDefaultModel(defaultSubtaskModel);
    this.subagents?.setDefaultEffort(this.configManager.current.subtaskEffort);
  }

  private resolveDefaultSubtaskModel(parentModel: string): string {
    const configured = this.configManager.current.defaultSubtaskModel;
    if (!configured || this.options.command.fakeProvider) return parentModel;
    const candidate = this.providerService?.models.find(
      (model) => `${model.provider}/${model.id}` === configured,
    );
    if (candidate?.available && candidate.supportsTools) return configured;
    this.addSystem(
      `Configured default subtask model \`${configured}\` is unavailable or lacks tool support; using parent model \`${parentModel}\`.`,
    );
    return parentModel;
  }

  private async initializeSubagents(defaultModel: string): Promise<void> {
    if (this.subagents) return;
    if (
      this.configManager.current.maxSubagents === 0 ||
      this.configManager.current.maxSubagentDepth === 0
    ) {
      return;
    }
    const parentLoop = this.agentLoop;
    const contextManager = this.contextManager;
    const codingServices = this.codingServices;
    const session = this.sessionRuntime;
    if (!parentLoop || !contextManager || !codingServices || !session) {
      throw new Error("Parent agent is not ready for subagents");
    }
    const runtime = RuntimeSubagents.create({
      workspace: this.options.workspace,
      checkpointDirectory: `${this.paths.dataRoot}/checkpoints`,
      artifactsDirectory: this.paths.artifactsDir,
      defaultModel,
      defaultEffort: this.configManager.current.subtaskEffort,
      maxConcurrency: this.configManager.current.maxSubagents,
      maxDepth: this.configManager.current.maxSubagentDepth,
      permissionMode: this.configManager.current.permissionMode,
      approvalHandler: this.approvalController,
      permissions: codingServices.permissions,
      ...(this.providerService === undefined ? {} : { providerService: this.providerService }),
      fakeProvider: this.options.command.fakeProvider,
      agentInstructionPrompts: this.agentInstructionPrompts,
      parentLoop,
      contextManager,
      session,
      store: this.store,
    });
    this.subagents = runtime;
    this.tools.register(runtime.taskTool).register(runtime.taskStatusTool);
  }

  private installAgentLoop(loop: AgentLoop): void {
    const session = this.requireSessionRuntime();
    this.agentLoop = loop;
    this.controller = new AgentUiController(loop, this.store);
    session.attach(loop, (error) => {
      this.store.update({ status: "session write failed", notice: error.message });
      this.addSystem(`Session persistence failed: ${error.message}`);
    });
    this.loopMode?.attach(loop, async (prompt) => await this.runAgentPrompt(prompt, "submit"));
    this.goalMode?.attach(loop, async (prompt) => await this.runAgentPrompt(prompt, "goal"));
  }

  private hydrateSessionUi(): void {
    const session = this.requireSessionRuntime();
    const usage = session.usage;
    this.store.update({
      messages: uiMessagesFromHistory(session.messages),
      contextTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      cost: usage.cost ?? 0,
    });
    if (session.interrupted) {
      this.addSystem(
        `Recovered an interrupted assistant response (${session.interrupted.reason}). The partial response remains in the transcript but was not added to provider context.`,
      );
    }
    for (const diagnostic of session.current.diagnostics) {
      this.addSystem(`Session recovery: ${diagnostic.message}`);
    }
  }

  private async createNewSession(): Promise<void> {
    if (this.deferUntilAgentIdle("New session", async () => await this.createNewSession())) {
      return;
    }
    const session = this.requireSessionRuntime();
    const selected = this.providerService?.selected;
    const provider = this.options.command.fakeProvider
      ? "fake"
      : (selected?.record.provider ?? "unselected");
    const model = this.options.command.fakeProvider
      ? "brisk-demo"
      : (selected?.record.id ?? "unselected");
    await this.extensions?.emitLifecycle("session-end", { sessionId: session.sessionId });
    await this.teardownAgent();
    await session.createNew(provider, model);
    this.goalMode?.restore();
    await this.resetSessionTools();
    this.hydrateSessionUi();
    await this.activateCurrentSessionModel();
    await this.extensions?.emitLifecycle("session-start", {
      sessionId: session.sessionId,
      workspace: this.options.workspace,
    });
  }

  private async pickSession(): Promise<string | undefined> {
    const session = this.requireSessionRuntime();
    const records = await session.listWorkspace();
    if (records.length === 0) {
      this.addSystem("No sessions exist for this workspace.");
      return undefined;
    }
    return await this.pickerController.choose({
      title: "Select session",
      selectedId: session.sessionId,
      options: records.map((record) => ({
        id: record.id,
        label: record.title,
        description: `${record.updatedAt.slice(0, 16).replace("T", " ")} · ${record.selectedProvider}/${record.selectedModel}`,
      })),
    });
  }

  private async switchSession(id: string): Promise<void> {
    const session = this.requireSessionRuntime();
    if (id === session.sessionId) return;
    if (
      this.deferUntilAgentIdle(`Switch to session ${id}`, async () => await this.switchSession(id))
    ) {
      return;
    }
    await this.extensions?.emitLifecycle("session-end", { sessionId: session.sessionId });
    await this.teardownAgent();
    await session.open(id);
    this.goalMode?.restore();
    this.providerService?.setSessionId(session.sessionId);
    await this.resetSessionTools();
    this.hydrateSessionUi();
    await this.activateCurrentSessionModel();
    await this.extensions?.emitLifecycle("session-start", {
      sessionId: session.sessionId,
      workspace: this.options.workspace,
    });
  }

  private async activateCurrentSessionModel(): Promise<void> {
    if (this.options.command.fakeProvider) {
      await this.initializeFakeProvider();
      return;
    }
    const providers = this.providerService;
    if (!providers) return;
    const session = this.requireSessionRuntime();
    let selection: ModelSelection | undefined;
    const desired = session.selectedModelSpecifier;
    if (desired) {
      const parsed = splitModelSpecifier(desired);
      if (parsed) {
        try {
          selection = providers.select(parsed.provider, parsed.id);
        } catch {
          this.addSystem(`Session model \`${desired}\` is unavailable; selecting a fallback.`);
        }
      }
    }
    selection ??= providers.selected ?? (await providers.selectInitial());
    if (selection) await this.activateSelection(selection);
    else this.store.update({ status: "login or model required", providerModel: "no model" });
  }

  private async teardownAgent(): Promise<void> {
    await this.btw?.close();
    this.loopMode?.detach();
    this.goalMode?.detachAgent();
    this.subagents?.dispose();
    this.subagents = undefined;
    this.controller?.cancel();
    this.controller?.dispose();
    this.controller = undefined;
    this.agentLoop = undefined;
    this.contextManager = undefined;
    await this.sessionRuntime?.detach();
    await cleanupToolProcesses();
  }

  private async resetSessionTools(): Promise<void> {
    this.tools = new ToolRegistry();
    await this.initializeCodingTools();
    this.installExtensionTools();
  }

  private async reloadConfigurationAndExtensions(): Promise<void> {
    if (
      this.deferUntilAgentIdle("Configuration reload", async () =>
        this.reloadConfigurationAndExtensions(),
      )
    ) {
      return;
    }
    await this.configManager.reload();
    this.applyConfigToUi();
    this.showConfigWarnings();
    await this.initializeAgentInstructions();
    await this.teardownAgent();
    this.providerService?.close();
    this.providerService = undefined;
    this.tools = new ToolRegistry();
    await this.initializeCodingTools();
    const summary = await this.extensions?.reload();
    if (this.options.command.fakeProvider) await this.initializeFakeProvider();
    else await this.initializeProviderService();
    this.installExtensionTools();
    await this.extensions?.emitLifecycle("session-start", {
      sessionId: this.requireSessionRuntime().sessionId,
      workspace: this.options.workspace,
    });
    this.addSystem(
      summary
        ? `Reloaded configuration and extensions: ${summary.loaded} loaded, ${summary.denied} denied, ${summary.failed} failed.`
        : "Configuration reloaded.",
    );
  }

  private deferUntilAgentIdle(description: string, run: () => Promise<void>): boolean {
    const loop = this.agentLoop;
    if (!loop?.active) return false;

    this.deferredOperations.push({ description, run });
    this.addSystem(`${description} queued for the end of the active agent run.`);
    if (!this.deferredIdleUnsubscribe) {
      this.deferredIdleUnsubscribe = loop.subscribe((event) => {
        if (event.type !== "idle") return;
        this.deferredIdleUnsubscribe?.();
        this.deferredIdleUnsubscribe = undefined;
        queueMicrotask(() => void this.drainDeferredOperations());
      });
    }
    return true;
  }

  private async drainDeferredOperations(): Promise<void> {
    if (this.drainingDeferredOperations || this.closed) return;
    this.drainingDeferredOperations = true;
    try {
      while (!this.closed) {
        const operation = this.deferredOperations.shift();
        if (!operation) break;
        try {
          await operation.run();
        } catch (error) {
          this.addSystem(`${operation.description} failed: ${redactedErrorMessage(error)}`);
        }
      }
    } finally {
      this.drainingDeferredOperations = false;
    }
  }

  private requireSessionRuntime(): SessionRuntime {
    if (!this.sessionRuntime) throw new Error("Session runtime is not initialized");
    return this.sessionRuntime;
  }

  private async executeCommand(commandLine: string, tui: TuiRuntime): Promise<boolean> {
    const trimmed = commandLine.trim();
    const separator = trimmed.search(/\s/);
    const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const argument = separator === -1 ? "" : trimmed.slice(separator).trim();
    switch (name) {
      case "/quit":
        tui.exit();
        return true;
      case "/clear":
        this.store.clearMessages();
        return true;
      case "/help":
        this.addSystem(helpText());
        return true;
      case "/model":
        await this.changeModel(argument);
        return true;
      case "/effort":
        await this.changeEffort(argument === "subagent" || argument === "child");
        return true;
      case "/loop":
        this.loopMode?.execute(argument, !this.store.snapshot.busy);
        return true;
      case "/goal":
        await this.goalMode?.execute(argument);
        return true;
      case "/btw":
        if (!argument) {
          this.addSystem("Usage: /btw <side question>");
        } else if (this.btw?.open) {
          this.addSystem("A BTW side thread is already open.");
        } else if (!(await this.btw?.start(argument))) {
          this.addSystem("Unable to start the BTW side thread.");
        }
        return true;
      case "/compact":
        await this.compactContext();
        return true;
      case "/context":
        this.showContext();
        return true;
      case "/agents":
        if (!this.subagents?.openPanel()) this.addSystem("No child agents are active yet.");
        return true;
      case "/new":
        await this.createNewSession();
        return true;
      case "/sessions":
      case "/resume":
        await this.openSessionPicker();
        return true;
      case "/login":
        await this.login(argument);
        return true;
      case "/logout":
        await this.logout(argument);
        return true;
      case "/reload":
        await this.reloadConfigurationAndExtensions();
        return true;
      case "/cost": {
        const snapshot = this.store.snapshot;
        this.addSystem(
          [
            `Current recorded cost: **$${snapshot.cost.toFixed(4)}**`,
            `Prompt cache: **${snapshot.cacheReadTokens.toLocaleString()} read** · **${snapshot.cacheWriteTokens.toLocaleString()} written**`,
          ].join("\n\n"),
        );
        return true;
      }
      case "/settings":
        await this.openSettings();
        return true;
      default: {
        const result = await this.extensions?.invokeSlashCommand(name, argument);
        if (result?.found) {
          if (result.output) this.addSystem(result.output);
          else if (!result.ok) this.addSystem(`Extension command \`${name}\` failed.`);
          return true;
        }
        this.addSystem(`Unknown command: \`${name}\`. Use \`/help\`.`);
        return true;
      }
    }
  }

  private async openSettings(): Promise<void> {
    let changed = false;
    let selectedId = "defaultModel";
    while (true) {
      const config = this.configManager.current;
      const choice = await this.pickerController.choose({
        title: "Settings · saved to global config",
        selectedId,
        options: settingsOptions(config),
      });
      if (choice === undefined || choice === "done") break;
      selectedId = choice;
      changed = (await this.changeSetting(choice)) || changed;
    }

    if (changed) await this.reloadConfigurationAndExtensions();
  }

  private async changeSetting(setting: string): Promise<boolean> {
    const config = this.configManager.current;
    switch (setting) {
      case "defaultModel":
        return await this.changeModelSetting("defaultModel", config.defaultModel, false);
      case "defaultSubtaskModel":
        return await this.changeModelSetting(
          "defaultSubtaskModel",
          config.defaultSubtaskModel,
          true,
        );
      case "effort":
        return await this.changeConfiguredEffort(false);
      case "subtaskEffort":
        return await this.changeConfiguredEffort(true);
      case "permissionMode":
        return await this.changeChoiceSetting(
          ["permissionMode"],
          "Permission mode",
          config.permissionMode,
          [
            { id: "safe", label: "Safe", description: "prompt before writes and shell commands" },
            { id: "write", label: "Write", description: "allow edits; prompt for shell commands" },
            { id: "yolo", label: "Yolo", description: "never prompt for tool permissions" },
          ],
        );
      case "maxSubagents":
        return await this.changeIntegerSetting(
          ["maxSubagents"],
          "Maximum concurrent subagents",
          config.maxSubagents,
          0,
        );
      case "maxSubagentDepth":
        return await this.changeIntegerSetting(
          ["maxSubagentDepth"],
          "Maximum subagent depth",
          config.maxSubagentDepth,
          0,
        );
      case "goalMaxTurns":
        return await this.changeIntegerSetting(
          ["goalMaxTurns"],
          "Maximum autonomous goal continuation turns",
          config.goalMaxTurns ?? 0,
          0,
        );
      case "compaction.enabled":
        return await this.changeBooleanSetting(
          ["compaction", "enabled"],
          "Automatic compaction",
          config.compaction.enabled,
        );
      case "compaction.thresholdPercent":
        return await this.changeIntegerSetting(
          ["compaction", "thresholdPercent"],
          "Compaction threshold percent",
          config.compaction.thresholdPercent,
          1,
          100,
        );
      case "compaction.keepRecentTokens":
        return await this.changeIntegerSetting(
          ["compaction", "keepRecentTokens"],
          "Recent tokens retained after compaction",
          config.compaction.keepRecentTokens,
          1,
        );
      case "ui.theme":
        return await this.changeChoiceSetting(["ui", "theme"], "Theme", config.ui.theme, [
          { id: "default", label: "Default" },
          { id: "high-contrast", label: "High contrast" },
        ]);
      case "ui.showThinking":
        return await this.changeBooleanSetting(
          ["ui", "showThinking"],
          "Show thinking by default",
          config.ui.showThinking,
        );
      case "providers":
        this.addSystem(
          `Custom provider definitions contain URLs, environment-variable names, and model schemas. Edit them in \`${this.paths.globalConfigPath}\`, then use \`/reload\`.`,
        );
        return false;
      default:
        return false;
    }
  }

  private async changeModelSetting(
    field: "defaultModel" | "defaultSubtaskModel",
    current: string | undefined,
    requireTools: boolean,
  ): Promise<boolean> {
    const models = (this.providerService?.models ?? []).filter(
      (model) => model.available && (!requireTools || model.supportsTools),
    );
    const inheritDescription =
      field === "defaultSubtaskModel"
        ? "use the active parent model"
        : "use the session or provider fallback";
    const selected = await this.pickerController.choose({
      title: field === "defaultSubtaskModel" ? "Default subtask model" : "Default model",
      selectedId: current ?? "inherit",
      options: [
        { id: "inherit", label: "Automatic / inherited", description: inheritDescription },
        ...models.map((model) => ({
          id: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.id}`,
          description:
            model.contextWindow === null
              ? model.api
              : `${model.contextWindow.toLocaleString()} context · ${model.api}`,
        })),
      ],
    });
    if (selected === undefined) return false;
    await this.saveGlobalSetting([field], selected === "inherit" ? undefined : selected);
    if (selected !== "inherit") {
      const model = this.upstreamModel(selected);
      if (model) {
        await this.chooseAndSaveEffort(
          model,
          field === "defaultSubtaskModel" ? "Subagent effort" : "Main agent effort",
          field === "defaultSubtaskModel" ? "subtaskEffort" : "effort",
        );
      }
    }
    return true;
  }

  private async changeConfiguredEffort(subtask: boolean): Promise<boolean> {
    const config = this.configManager.current;
    const modelSpecifier = subtask
      ? (config.defaultSubtaskModel ??
        (this.providerService?.selected && modelName(this.providerService.selected)))
      : (config.defaultModel ??
        (this.providerService?.selected && modelName(this.providerService.selected)));
    const model = modelSpecifier ? this.upstreamModel(modelSpecifier) : undefined;
    if (!model) {
      this.addSystem("Select an available model before configuring effort.");
      return false;
    }
    const changed = await this.chooseAndSaveEffort(
      model,
      subtask ? "Subagent effort" : "Main agent effort",
      subtask ? "subtaskEffort" : "effort",
    );
    if (!changed) return false;
    if (subtask) {
      this.subagents?.setDefaultEffort(this.configManager.current.subtaskEffort);
    } else if (this.providerService) {
      const effort = this.providerService.setEffort(this.configManager.current.effort);
      this.store.update({ effort });
    }
    return true;
  }

  private async changeChoiceSetting(
    path: readonly string[],
    title: string,
    current: string,
    options: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    }[],
  ): Promise<boolean> {
    const selected = await this.pickerController.choose({
      title,
      selectedId: current,
      options: [
        { id: "inherit", label: "Reset global override", description: "use project or default" },
        ...options,
      ],
    });
    if (selected === undefined) return false;
    await this.saveGlobalSetting(path, selected === "inherit" ? undefined : selected);
    return true;
  }

  private async changeBooleanSetting(
    path: readonly string[],
    title: string,
    current: boolean,
  ): Promise<boolean> {
    const selected = await this.pickerController.choose({
      title,
      selectedId: String(current),
      options: [
        { id: "inherit", label: "Reset global override", description: "use project or default" },
        { id: "true", label: "Enabled" },
        { id: "false", label: "Disabled" },
      ],
    });
    if (selected === undefined) return false;
    await this.saveGlobalSetting(path, selected === "inherit" ? undefined : selected === "true");
    return true;
  }

  private async changeIntegerSetting(
    path: readonly string[],
    title: string,
    current: number,
    minimum: number,
    maximum?: number,
  ): Promise<boolean> {
    const bounds = maximum === undefined ? `at least ${minimum}` : `${minimum} through ${maximum}`;
    const answer = await this.textInputController.prompt({
      title,
      message: `Enter an integer ${bounds}, or "default" to reset the global override.`,
      value: String(current),
      validate(value) {
        if (value.toLowerCase() === "default") return undefined;
        if (!/^\d+$/.test(value)) return "Enter a whole number or default.";
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < minimum) {
          return `Value must be an integer ${bounds}.`;
        }
        if (maximum !== undefined && parsed > maximum) {
          return `Value must be an integer ${bounds}.`;
        }
        return undefined;
      },
    });
    if (answer === undefined) return false;
    await this.saveGlobalSetting(
      path,
      answer.toLowerCase() === "default" ? undefined : Number(answer),
    );
    return true;
  }

  private async saveGlobalSetting(
    path: readonly string[],
    value: JsonValue | undefined,
  ): Promise<void> {
    await writeConfigValue(this.paths.globalConfigPath, path, value);
    await this.configManager.reload();
    this.applyConfigToUi();
  }

  private async compactContext(): Promise<void> {
    const manager = this.contextManager;
    const loop = this.agentLoop;
    if (!manager || !loop) {
      this.addSystem("Context management is unavailable until a model is selected.");
      return;
    }
    if (this.deferUntilAgentIdle("Context compaction", async () => await this.compactContext())) {
      return;
    }
    const controller = new AbortController();
    this.compactionController = controller;
    this.store.update({ busy: true, status: "compacting context" });
    try {
      const inspection = await manager.compactNow(loop.messages, controller.signal);
      this.store.update({ contextTokens: inspection.currentUseTokens });
      this.addSystem(formatContextInspection(inspection));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      this.addSystem("Context compaction cancelled.");
    } finally {
      if (this.compactionController === controller) this.compactionController = undefined;
      this.store.update({ busy: false, status: "ready" });
    }
  }

  private showContext(): void {
    const manager = this.contextManager;
    if (!manager) {
      this.addSystem("Context management is unavailable until a model is selected.");
      return;
    }
    const inspection = manager.inspect(this.agentLoop?.messages);
    this.store.update({ contextTokens: inspection.currentUseTokens });
    this.addSystem(formatContextInspection(inspection));
  }

  private upstreamModel(specifier: string) {
    const parsed = splitModelSpecifier(specifier);
    return parsed
      ? this.providerService?.registry.resolveUpstreamModel(parsed.provider, parsed.id)
      : undefined;
  }

  private async chooseAndSaveEffort(
    model: ModelSelection["upstream"],
    title: string,
    field: "effort" | "subtaskEffort",
  ): Promise<boolean> {
    const current = this.configManager.current[field];
    const supported = supportedEffortSettings(model);
    const selected = await this.pickerController.choose({
      title: `${title} · ${model.provider}/${model.id}`,
      selectedId: resolveEffortSetting(model, current),
      options: supported.map((effort) => ({
        id: effort,
        label: effortLabel(effort),
        description: effortDescription(model.reasoning, effort),
      })),
    });
    if (selected === undefined) return false;
    await this.saveGlobalSetting([field], selected);
    return true;
  }

  private async changeEffort(subtask: boolean): Promise<void> {
    const providers = this.providerService;
    const selected = providers?.selected;
    if (!providers || !selected) {
      this.addSystem("Effort selection is unavailable until a model is selected.");
      return;
    }
    const model = subtask
      ? this.upstreamModel(this.configManager.current.defaultSubtaskModel ?? modelName(selected))
      : selected.upstream;
    if (!model) {
      this.addSystem("The configured subagent model is unavailable.");
      return;
    }
    const changed = await this.chooseAndSaveEffort(
      model,
      subtask ? "Subagent effort" : "Main agent effort",
      subtask ? "subtaskEffort" : "effort",
    );
    if (!changed) return;
    if (subtask) {
      this.subagents?.setDefaultEffort(this.configManager.current.subtaskEffort);
      this.addSystem(`Subagent effort set to **${this.configManager.current.subtaskEffort}**.`);
    } else {
      const effort = providers.setEffort(this.configManager.current.effort);
      this.store.update({ effort });
      this.addSystem(`Main agent effort set to **${effort}**.`);
    }
  }

  private async changeModel(specifier: string): Promise<void> {
    const providers = this.providerService;
    if (!providers) {
      this.addSystem("Model selection is unavailable with the fake provider.");
      return;
    }
    if (!specifier) {
      const selected = await this.pickModel();
      if (!selected) return;
      specifier = selected;
    }
    const parsed = splitModelSpecifier(specifier);
    if (!parsed) throw new Error("Model must use provider/model format");
    const selection = providers.select(parsed.provider, parsed.id);
    await this.chooseAndSaveEffort(selection.upstream, "Main agent effort", "effort");
    await this.activateSelection(selection);
    this.addSystem(`Selected \`${modelName(selection)}\` with **${providers.effort}** effort.`);
  }

  private async pickModel(): Promise<string | undefined> {
    const providers = this.providerService;
    if (!providers) {
      this.addSystem("Model selection is unavailable with the fake provider.");
      return undefined;
    }
    const models = providers.models.filter((model) => model.available);
    if (models.length === 0) {
      this.addSystem("No available models. Use `/login` or configure an API key.");
      return undefined;
    }
    return await this.pickerController.choose({
      title: "Select provider/model",
      options: models.map((model) => ({
        id: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description:
          model.contextWindow === null
            ? model.api
            : `${model.contextWindow.toLocaleString()} context · ${model.api}`,
      })),
      ...(providers.selected === undefined ? {} : { selectedId: modelName(providers.selected) }),
    });
  }

  private async login(providerArgument: string): Promise<void> {
    const providers = this.requireProviderService("login");
    const provider = providerArgument || (await this.chooseOAuthProvider(providers));
    if (!provider) return;

    const controller = new AbortController();
    const prompter = this.authController.begin(provider, controller);
    try {
      await providers.auth.login(provider, prompter, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        this.addSystem("Login cancelled.");
        return;
      }
      throw error;
    } finally {
      this.authController.close();
    }

    await providers.refreshModels();
    const selection = providers.selected ?? (await providers.selectInitial());
    if (selection) await this.activateSelection(selection);
    this.addSystem(`Logged in to \`${provider}\`.`);
  }

  private async logout(providerArgument: string): Promise<void> {
    const providers = this.requireProviderService("logout");
    const provider = providerArgument || (await this.chooseLogoutProvider(providers));
    if (!provider) return;
    await providers.auth.logout(provider);
    await providers.refreshModels();
    this.addSystem(`Logged out of \`${provider}\` locally.`);
  }

  private async chooseOAuthProvider(providers: ProviderService): Promise<string | undefined> {
    const statuses = providers.auth.listProviderStatus();
    const byId = new Map(statuses.map((status) => [status.provider, status]));
    const candidates = BUILT_IN_BRISK_OAUTH_PROVIDERS.filter(
      (provider) => byId.get(provider)?.oauthAvailable,
    );
    if (candidates.length === 0) {
      this.addSystem("No supported OAuth provider is available.");
      return undefined;
    }
    return await this.pickerController.choose({
      title: "Provider to login",
      options: candidates.map((provider) => {
        const name = byId.get(provider)?.name;
        return {
          id: provider,
          label: provider,
          ...(name === undefined ? {} : { description: name }),
        };
      }),
    });
  }

  private async chooseLogoutProvider(providers: ProviderService): Promise<string | undefined> {
    const candidates = providers.auth
      .listProviderStatus()
      .filter((status) => status.configured)
      .map((status) => ({
        id: status.provider,
        label: status.provider,
        ...(status.name === undefined ? {} : { description: status.name }),
      }));
    if (candidates.length === 0) {
      this.addSystem("No configured provider is available to log out.");
      return undefined;
    }
    return await this.pickerController.choose({ title: "Provider to logout", options: candidates });
  }

  private requireProviderService(action: string): ProviderService {
    if (!this.providerService) throw new Error(`${action} is unavailable with the fake provider`);
    return this.providerService;
  }

  private applyConfigToUi(): void {
    this.store.update({
      mode: this.configManager.current.permissionMode,
      theme: this.configManager.current.ui.theme,
      showThinking: this.configManager.current.ui.showThinking,
    });
  }

  private showConfigWarnings(): void {
    const warnings = this.configManager.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    if (warnings.length === 0) return;
    this.addSystem(
      `**Configuration warnings**\n\n${warnings.map((warning) => `- ${warning.source} ${warning.path}: ${warning.message}`).join("\n")}`,
    );
  }

  private addSystem(content: string): void {
    this.store.addMessage({ id: crypto.randomUUID(), role: "system", content });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Interactive runtime is closed");
  }
}

function effortLabel(effort: EffortSetting): string {
  switch (effort) {
    case "auto":
      return "Auto";
    case "off":
      return "Off";
    case "xhigh":
      return "Extra high";
    default:
      return `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
  }
}

function effortDescription(reasoning: boolean, effort: EffortSetting): string {
  if (!reasoning) return "this model does not support reasoning";
  if (effort === "auto") return "use the model/provider default";
  if (effort === "off") return "disable reasoning";
  return "set reasoning intensity";
}

function settingsOptions(config: BriskConfig): readonly {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}[] {
  return [
    {
      id: "defaultModel",
      label: "Default model",
      description: config.defaultModel ?? "automatic",
    },
    {
      id: "defaultSubtaskModel",
      label: "Default subtask model",
      description: config.defaultSubtaskModel ?? "inherit active parent model",
    },
    { id: "effort", label: "Main agent effort", description: config.effort },
    {
      id: "subtaskEffort",
      label: "Subagent effort",
      description: config.subtaskEffort,
    },
    { id: "permissionMode", label: "Permission mode", description: config.permissionMode },
    {
      id: "maxSubagents",
      label: "Concurrent subagents",
      description: String(config.maxSubagents),
    },
    {
      id: "maxSubagentDepth",
      label: "Subagent depth",
      description: String(config.maxSubagentDepth),
    },
    {
      id: "goalMaxTurns",
      label: "Goal continuation limit",
      description: config.goalMaxTurns === undefined ? "unlimited" : String(config.goalMaxTurns),
    },
    {
      id: "compaction.enabled",
      label: "Automatic compaction",
      description: config.compaction.enabled ? "enabled" : "disabled",
    },
    {
      id: "compaction.thresholdPercent",
      label: "Compaction threshold",
      description: `${config.compaction.thresholdPercent}%`,
    },
    {
      id: "compaction.keepRecentTokens",
      label: "Recent tokens after compaction",
      description: config.compaction.keepRecentTokens.toLocaleString(),
    },
    { id: "ui.theme", label: "Theme", description: config.ui.theme },
    {
      id: "ui.showThinking",
      label: "Show thinking",
      description: config.ui.showThinking ? "enabled" : "disabled",
    },
    {
      id: "providers",
      label: "Custom providers",
      description: `${Object.keys(config.providers).length} configured · file editor required`,
    },
    { id: "done", label: "Done", description: "save and apply changes" },
  ];
}

function uiMessagesFromHistory(messages: readonly Message[]): UiMessage[] {
  const visible: UiMessage[] = [];
  const toolOwners = new Map<
    string,
    { readonly messageIndex: number; readonly cardIndex: number }
  >();

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      if (message.internal) continue;
      visible.push({ id: `history-user-${index}`, role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const tools: UiToolCard[] = message.toolCalls.map((call) => {
        const summary = summarizeToolCall(call);
        return {
          id: call.id,
          name: call.name,
          status: "pending",
          ...(summary === undefined ? {} : { summary }),
        };
      });
      const messageIndex = visible.length;
      visible.push({
        id: `history-assistant-${index}`,
        role: "assistant",
        content: message.content,
        ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
        ...(tools.length === 0 ? {} : { tools }),
      });
      tools.forEach((tool, cardIndex) => toolOwners.set(tool.id, { messageIndex, cardIndex }));
      continue;
    }
    applyHistoricalToolResult(visible, toolOwners, message);
  }
  return visible;
}

function applyHistoricalToolResult(
  messages: UiMessage[],
  owners: ReadonlyMap<string, { readonly messageIndex: number; readonly cardIndex: number }>,
  result: ToolResultMessage,
): void {
  const owner = owners.get(result.toolCallId);
  if (!owner) return;
  const message = messages[owner.messageIndex];
  const card = message?.tools?.[owner.cardIndex];
  if (!message || !card) return;
  const tools = [...(message.tools ?? [])];
  const diff = extractToolDiff(result.name, result.content);
  const resultSummary = summarizeToolResult(result.name, result.content);
  tools[owner.cardIndex] = {
    ...card,
    status: result.isError ? "failed" : "completed",
    output: result.content,
    summary: result.name === "task_status" ? resultSummary : (card.summary ?? resultSummary),
    ...(diff === undefined ? {} : { diff, expanded: true }),
  };
  messages[owner.messageIndex] = { ...message, tools };
}

function modelName(selection: ModelSelection): string {
  return `${selection.record.provider}/${selection.record.id}`;
}

function contextModelForSelection(selection: ModelSelection): ContextModel {
  return {
    provider: selection.record.provider,
    api: selection.upstream.api,
    model: modelName(selection),
    contextWindow: selection.record.contextWindow,
    supportsImages: selection.record.input.includes("image"),
  };
}

function formatContextInspection(inspection: ContextInspection): string {
  const window = inspection.contextWindow?.toLocaleString() ?? "unknown";
  const threshold = inspection.nextThresholdTokens?.toLocaleString() ?? "unknown";
  return [
    "**Context**",
    `- provider/model: \`${inspection.provider}/${inspection.model}\``,
    `- estimated use: ${inspection.currentUseTokens.toLocaleString()} / ${window} tokens`,
    `- text estimate: ${inspection.textEstimateTokens.toLocaleString()} tokens`,
    `- compacted images: ${inspection.compactedImageEstimateTokens.toLocaleString()} tokens`,
    `- recent messages retained: ${inspection.recentRetainedMessages}`,
    `- compactions: ${inspection.compactionCount}`,
    `- next threshold: ${threshold}`,
    `- mode: ${inspection.fallbackMode}`,
  ].join("\n");
}

function helpText(): string {
  const commands = BUILT_IN_SLASH_COMMANDS.map((command) => `\`${command.name}\``).join(", ");
  return `**Keys**\n\n- Enter: submit\n- Shift+Enter or Ctrl+J: newline\n- Esc: abort active work\n- Ctrl+C: clear composer input\n- Ctrl+D: exit\n- Ctrl+P: list models\n- Ctrl+O: list sessions\n- Tab: expand or collapse the latest thinking/tool result\n- PageUp: reveal older windowed conversation messages\n\n**Commands**\n\n${commands}`;
}

function configuredGoalMaxTurns(
  environment: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const value = environment.BRISK_GOAL_MAX_TURNS ?? environment.PI_GOAL_MAX_TURNS;
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function btwLiveStatus(snapshot: UiSnapshot): string {
  const lines = [`Main agent state: ${snapshot.busy ? "running" : "idle"}.`];
  const activeAssistant = [...snapshot.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.streaming);
  if (activeAssistant?.content.trim()) {
    const content = activeAssistant.content.trim();
    lines.push(
      `Current main-assistant response excerpt:\n${content.length <= 2_500 ? content : content.slice(-2_500)}`,
    );
  }
  const activeTools = snapshot.messages.flatMap((message) =>
    (message.tools ?? [])
      .filter((tool) => tool.status === "pending" || tool.status === "running")
      .map((tool) => (tool.summary ? `${tool.name} · ${tool.summary}` : tool.name)),
  );
  if (activeTools.length > 0) lines.push(`Main tools currently running: ${activeTools.join("; ")}`);
  if (snapshot.goalStatus) lines.push(`Main ${snapshot.goalStatus}.`);
  if (snapshot.loopStatus) lines.push(`Main ${snapshot.loopStatus}.`);
  return lines.join("\n\n");
}
