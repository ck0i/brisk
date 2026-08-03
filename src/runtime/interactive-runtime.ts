import { stat } from "node:fs/promises";

import type { CliCommand } from "../cli/args.ts";
import { TerminalAuthPrompter } from "../cli/auth-prompter.ts";
import { ConfigManager } from "../config/manager.ts";
import { ensureConfigDirectories, resolveConfigPaths, type ConfigPaths } from "../config/paths.ts";
import type { ConfigOverrides } from "../config/schema.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import { FakeProvider } from "../providers/fake-provider.ts";
import {
  BUILT_IN_BRISK_OAUTH_PROVIDERS,
  type ProviderAuthStatus,
} from "../providers/auth-service.ts";
import {
  ProviderService,
  splitModelSpecifier,
  type ModelSelection,
} from "../providers/provider-service.ts";
import { registerCodingTools } from "../tools/coding-tools.ts";
import { cleanupToolProcesses } from "../tools/process-registry.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { TuiRuntime } from "../app.tsx";
import { AgentUiController } from "../ui/agent-controller.ts";
import { UiApprovalController } from "../ui/approval-controller.ts";
import { UiStore } from "../ui/state.ts";

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
  private controller: AgentUiController | undefined;
  private readonly tools = new ToolRegistry();
  private readonly approvalController: UiApprovalController;
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
      await runtime.initializeCodingTools();
      if (options.command.fakeProvider) runtime.initializeFakeProvider();
      else await runtime.initializeProviderService();
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
    try {
      if (this.store.snapshot.busy) await this.controller.steer(value);
      else await this.controller.submit(value);
    } catch {
      // Provider failures are normalized and already visible through AgentUiController.
    }
    return true;
  }

  abort(): void {
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller?.cancel();
    this.controller?.dispose();
    this.approvalController.dispose();
    this.providerService?.close();
    await cleanupToolProcesses();
  }

  private async initializeCodingTools(): Promise<void> {
    await registerCodingTools(this.tools, {
      workspace: this.options.workspace,
      artifactsDirectory: `${this.paths.artifactsDir}/${crypto.randomUUID()}`,
      permissionMode: this.configManager.current.permissionMode,
      approvalHandler: this.approvalController,
    });
  }

  private async initializeProviderService(): Promise<void> {
    const providers = await ProviderService.initialize({
      paths: this.paths,
      config: this.configManager.current,
      ...(this.options.command.model === undefined
        ? {}
        : { preferredModel: this.options.command.model }),
      ...(this.options.command.sessionId === undefined
        ? {}
        : { sessionId: this.options.command.sessionId }),
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
    if (selection) this.activateSelection(selection);
    else this.store.update({ status: "login or model required", providerModel: "no model" });
  }

  private initializeFakeProvider(): void {
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
    this.controller = new AgentUiController(
      new AgentLoop({ provider, tools: this.tools, model: "fake/brisk-demo" }),
      this.store,
    );
    this.store.update({ providerModel: "fake/brisk-demo", status: "ready" });
  }

  private activateSelection(selection: ModelSelection): void {
    const provider = this.providerService?.provider;
    if (!provider) throw new Error("Selected model did not initialize a provider transport");
    if (!this.controller) {
      this.controller = new AgentUiController(
        new AgentLoop({ provider, tools: this.tools, model: modelName(selection) }),
        this.store,
      );
    }
    this.store.update({
      providerModel: modelName(selection),
      contextWindow: selection.record.contextWindow ?? undefined,
      status: "ready",
    });
  }

  private async executeCommand(commandLine: string, tui: TuiRuntime): Promise<boolean> {
    const [name, ...parts] = commandLine.trim().split(/\s+/);
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
      case "/login":
        await this.login(argument, tui);
        return true;
      case "/logout":
        await this.logout(argument, tui);
        return true;
      case "/reload": {
        await this.configManager.reload();
        this.applyConfigToUi();
        this.showConfigWarnings();
        this.addSystem(
          "Configuration reloaded. Provider definition changes apply on the next session.",
        );
        return true;
      }
      case "/cost":
        this.addSystem(`Current recorded cost: **$${this.store.snapshot.cost.toFixed(4)}**`);
        return true;
      case "/settings":
        this.addSystem(`Global configuration: \`${this.paths.globalConfigPath}\``);
        return true;
      default:
        this.addSystem(`Unknown command: \`${name}\`. Use \`/help\`.`);
        return true;
    }
  }

  private async changeModel(specifier: string): Promise<void> {
    const providers = this.providerService;
    if (!providers) {
      this.addSystem("Model selection is unavailable with the fake provider.");
      return;
    }
    if (!specifier) {
      this.showModels();
      return;
    }
    const parsed = splitModelSpecifier(specifier);
    if (!parsed) throw new Error("Model must use provider/model format");
    const selection = providers.select(parsed.provider, parsed.id);
    this.activateSelection(selection);
    this.addSystem(`Selected \`${modelName(selection)}\`.`);
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
    if (selection) this.activateSelection(selection);
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
    this.store.update({ mode: this.configManager.current.permissionMode });
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

function helpText(): string {
  return `**Keys**\n\n- Enter: submit\n- Shift+Enter or Ctrl+J: newline\n- Esc: abort active work\n- Ctrl+C: abort, then exit when idle\n- Ctrl+P: list models\n- Ctrl+O: list sessions\n\n**Commands**\n\n\`/help\`, \`/model [provider/model]\`, \`/login [provider]\`, \`/logout [provider]\`, \`/new\`, \`/sessions\`, \`/resume\`, \`/compact\`, \`/context\`, \`/agents\`, \`/cost\`, \`/settings\`, \`/reload\`, \`/clear\`, \`/quit\``;
}
