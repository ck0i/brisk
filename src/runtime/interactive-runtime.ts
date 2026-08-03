import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommand } from "../cli/args.ts";
import { TerminalAuthPrompter } from "../cli/auth-prompter.ts";
import { ConfigManager } from "../config/manager.ts";
import { ensureConfigDirectories, resolveConfigPaths, type ConfigPaths } from "../config/paths.ts";
import type { ConfigOverrides } from "../config/schema.ts";
import { ContextManager, type ContextInspection, type ContextModel } from "../context/index.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import type { Message, ToolResultMessage } from "../core/messages.ts";
import { FakeProvider } from "../providers/fake-provider.ts";
import { redactedErrorMessage } from "../providers/secret-redaction.ts";
import {
  BUILT_IN_BRISK_OAUTH_PROVIDERS,
  type ProviderAuthStatus,
} from "../providers/auth-service.ts";
import {
  ProviderService,
  splitModelSpecifier,
  type ModelSelection,
} from "../providers/provider-service.ts";
import { registerCodingTools, type CodingToolServices } from "../tools/coding-tools.ts";
import { cleanupToolProcesses } from "../tools/process-registry.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { TuiRuntime } from "../app.tsx";
import { RuntimeExtensions } from "./extension-runtime.ts";
import { SessionRuntime } from "./session-runtime.ts";
import { RuntimeSubagents } from "./subagent-runtime.ts";
import { AgentUiController } from "../ui/agent-controller.ts";
import { UiApprovalController } from "../ui/approval-controller.ts";
import { UiPickerController } from "../ui/picker-controller.ts";
import { UiStore, type UiMessage, type UiToolCard } from "../ui/state.ts";

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
  private tools = new ToolRegistry();
  private codingServices: CodingToolServices | undefined;
  private subagents: RuntimeSubagents | undefined;
  private extensions: RuntimeExtensions | undefined;
  private readonly approvalController: UiApprovalController;
  private readonly pickerController: UiPickerController;
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
    this.pickerController = new UiPickerController(store);
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
      await runtime.initializeSession();
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
    const sessionId = this.sessionRuntime?.sessionId ?? "unknown";
    await this.extensions?.emitLifecycle("turn-start", { sessionId });
    try {
      if (this.store.snapshot.busy) await this.controller.steer(value);
      else await this.controller.submit(value);
    } catch {
      // Provider failures are normalized and already visible through AgentUiController.
    } finally {
      await this.extensions?.emitLifecycle("turn-end", { sessionId });
    }
    return true;
  }

  abort(): void {
    this.compactionController?.abort(new DOMException("Cancelled", "AbortError"));
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

  async invokeKeybinding(key: string): Promise<void> {
    const result = await this.extensions?.invokeKeybinding(key);
    if (!result?.found) return;
    if (result.output) this.addSystem(result.output);
    else if (!result.ok) this.addSystem(`Extension keybinding \`${key}\` failed.`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.compactionController?.abort(new DOMException("Closing", "AbortError"));
    this.controller?.cancel();
    this.controller?.dispose();
    this.subagents?.dispose();
    await this.extensions?.emitLifecycle("session-end", {
      sessionId: this.sessionRuntime?.sessionId ?? "unknown",
    });
    await this.extensions?.emitLifecycle("shutdown");
    await this.extensions?.dispose();
    this.approvalController.dispose();
    this.pickerController.dispose();
    await this.sessionRuntime?.close();
    this.providerService?.close();
    await cleanupToolProcesses();
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

  private async initializeCodingTools(): Promise<void> {
    const session = this.requireSessionRuntime();
    this.codingServices = await registerCodingTools(this.tools, {
      workspace: this.options.workspace,
      artifactsDirectory: session.artifactDirectory,
      permissionMode: this.configManager.current.permissionMode,
      approvalHandler: this.approvalController,
    });
  }

  private async initializeExtensions(): Promise<void> {
    const runtime = new RuntimeExtensions({
      workspace: this.options.workspace,
      globalDirectory: this.paths.extensionsDir,
      errorsPath: join(this.paths.extensionsDir, "errors.json"),
      approvalHandler: this.approvalController,
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
    });
    this.installAgentLoop(loop);
    if (session.selectedModelSpecifier !== "fake/brisk-demo") {
      await session.recordModelChange("fake", "brisk-demo");
    }
    this.store.update({ providerModel: "fake/brisk-demo", status: "ready" });
    await this.initializeSubagents("fake/brisk-demo");
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
        }),
      );
    } else {
      this.agentLoop.setModel(selectedName);
    }
    if (session.selectedModelSpecifier !== selectedName) {
      await session.recordModelChange(selection.record.provider, selection.record.id);
    }
    this.store.update({
      providerModel: selectedName,
      contextWindow: selection.record.contextWindow ?? undefined,
      status: "ready",
    });
    await this.initializeSubagents(selectedName);
    this.subagents?.setDefaultModel(selectedName);
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
      maxConcurrency: this.configManager.current.maxSubagents,
      maxDepth: this.configManager.current.maxSubagentDepth,
      permissionMode: this.configManager.current.permissionMode,
      approvalHandler: this.approvalController,
      permissions: codingServices.permissions,
      ...(this.providerService === undefined ? {} : { providerService: this.providerService }),
      fakeProvider: this.options.command.fakeProvider,
      parentLoop,
      contextManager,
      session,
      store: this.store,
    });
    this.subagents = runtime;
    this.tools.register(runtime.taskTool);
  }

  private installAgentLoop(loop: AgentLoop): void {
    const session = this.requireSessionRuntime();
    this.agentLoop = loop;
    this.controller = new AgentUiController(loop, this.store);
    session.attach(loop, (error) => {
      this.store.update({ status: "session write failed", notice: error.message });
      this.addSystem(`Session persistence failed: ${error.message}`);
    });
  }

  private hydrateSessionUi(): void {
    const session = this.requireSessionRuntime();
    const usage = session.usage;
    this.store.update({
      messages: uiMessagesFromHistory(session.messages),
      contextTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
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
    if (this.store.snapshot.busy) {
      this.addSystem("Abort active work before creating a new session.");
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
    if (this.store.snapshot.busy) {
      this.addSystem("Abort active work before switching sessions.");
      return;
    }
    await this.extensions?.emitLifecycle("session-end", { sessionId: session.sessionId });
    await this.teardownAgent();
    await session.open(id);
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
    if (this.store.snapshot.busy) {
      this.addSystem("Abort active work before reloading configuration and extensions.");
      return;
    }
    await this.configManager.reload();
    this.applyConfigToUi();
    this.showConfigWarnings();
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

  private requireSessionRuntime(): SessionRuntime {
    if (!this.sessionRuntime) throw new Error("Session runtime is not initialized");
    return this.sessionRuntime;
  }

  private async executeCommand(commandLine: string, tui: TuiRuntime): Promise<boolean> {
    const [parsedName, ...parts] = commandLine.trim().split(/\s+/);
    const name = parsedName ?? "";
    const argument = parts.join(" ");
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
        await this.login(argument, tui);
        return true;
      case "/logout":
        await this.logout(argument, tui);
        return true;
      case "/reload":
        await this.reloadConfigurationAndExtensions();
        return true;
      case "/cost":
        this.addSystem(`Current recorded cost: **$${this.store.snapshot.cost.toFixed(4)}**`);
        return true;
      case "/settings":
        this.addSystem(`Global configuration: \`${this.paths.globalConfigPath}\``);
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

  private async compactContext(): Promise<void> {
    const manager = this.contextManager;
    const loop = this.agentLoop;
    if (!manager || !loop) {
      this.addSystem("Context management is unavailable until a model is selected.");
      return;
    }
    if (this.store.snapshot.busy) {
      this.addSystem("Abort active work before compacting context manually.");
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
    await this.activateSelection(selection);
    this.addSystem(`Selected \`${modelName(selection)}\`.`);
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

  private async login(providerArgument: string, tui: TuiRuntime): Promise<void> {
    const providers = this.requireProviderService("login");
    const provider = await tui.runSuspended(async () => {
      const prompter = new TerminalAuthPrompter();
      try {
        const selected =
          providerArgument ||
          (await chooseOAuthProvider(providers.auth.listProviderStatus(), prompter));
        await providers.auth.login(selected, prompter);
        return selected;
      } finally {
        prompter.close();
      }
    });
    await providers.refreshModels();
    const selection = providers.selected ?? (await providers.selectInitial());
    if (selection) await this.activateSelection(selection);
    this.addSystem(`Logged in to \`${provider}\`.`);
  }

  private async logout(providerArgument: string, tui: TuiRuntime): Promise<void> {
    const providers = this.requireProviderService("logout");
    const provider = await tui.runSuspended(async () => {
      const prompter = new TerminalAuthPrompter();
      try {
        const selected =
          providerArgument ||
          (await chooseLogoutProvider(providers.auth.listProviderStatus(), prompter));
        await providers.auth.logout(selected);
        return selected;
      } finally {
        prompter.close();
      }
    });
    await providers.refreshModels();
    this.addSystem(`Logged out of \`${provider}\` locally.`);
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

function uiMessagesFromHistory(messages: readonly Message[]): UiMessage[] {
  const visible: UiMessage[] = [];
  const toolOwners = new Map<
    string,
    { readonly messageIndex: number; readonly cardIndex: number }
  >();

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      visible.push({ id: `history-user-${index}`, role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const tools: UiToolCard[] = message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        status: "pending",
      }));
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
  tools[owner.cardIndex] = {
    ...card,
    status: result.isError ? "failed" : "completed",
    output: result.content,
    summary: summarizeHistoryTool(result.content),
  };
  messages[owner.messageIndex] = { ...message, tools };
}

function summarizeHistoryTool(content: string): string {
  const firstLine = content.split("\n", 1)[0]?.replaceAll(/\s+/g, " ").trim() ?? "";
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}...`;
}

async function chooseOAuthProvider(
  statuses: readonly ProviderAuthStatus[],
  prompter: TerminalAuthPrompter,
): Promise<string> {
  const available = new Set(
    statuses.filter((status) => status.oauthAvailable).map((status) => status.provider),
  );
  const candidates = BUILT_IN_BRISK_OAUTH_PROVIDERS.filter((provider) => available.has(provider));
  return await chooseFrom(candidates, "Provider to login", prompter);
}

async function chooseLogoutProvider(
  statuses: readonly ProviderAuthStatus[],
  prompter: TerminalAuthPrompter,
): Promise<string> {
  return await chooseFrom(
    statuses.filter((status) => status.configured).map((status) => status.provider),
    "Provider to logout",
    prompter,
  );
}

async function chooseFrom(
  candidates: readonly string[],
  message: string,
  prompter: TerminalAuthPrompter,
): Promise<string> {
  const fallback = candidates[0];
  if (!fallback) throw new Error("No matching configured provider is available");
  prompter.progress(`Available providers: ${candidates.join(", ")}`);
  const answer = await prompter.ask(message, { placeholder: fallback, allowEmpty: true });
  const selected = answer || fallback;
  if (!candidates.includes(selected))
    throw new Error(`Unsupported provider selection: ${selected}`);
  return selected;
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
  return `**Keys**\n\n- Enter: submit\n- Shift+Enter or Ctrl+J: newline\n- Esc: abort active work\n- Ctrl+C: abort, then exit when idle\n- Ctrl+P: list models\n- Ctrl+O: list sessions\n- Tab: expand or collapse the latest thinking/tool result\n- PageUp: reveal older windowed conversation messages\n\n**Commands**\n\n\`/help\`, \`/model [provider/model]\`, \`/login [provider]\`, \`/logout [provider]\`, \`/new\`, \`/sessions\`, \`/resume\`, \`/compact\`, \`/context\`, \`/agents\`, \`/cost\`, \`/settings\`, \`/reload\`, \`/clear\`, \`/quit\``;
}
