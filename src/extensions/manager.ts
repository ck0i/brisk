import type { JsonValue } from "../core/messages.ts";
import { redactSecrets } from "../providers/secret-redaction.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/registry.ts";
import { discoverExtensions } from "./discovery.ts";
import type {
  BriskExtensionContext,
  ExtensionDiagnostic,
  ExtensionDisposable,
  ExtensionIdentity,
  ExtensionInvocationResult,
  ExtensionLifecycleEvent,
  ExtensionLoadSummary,
  ExtensionManagerOptions,
  ExtensionRecord,
  KeybindingDefinition,
  LifecycleHook,
  LifecycleInvocationResult,
  ProjectExtensionApproval,
  RegisteredKeybinding,
  RegisteredSlashCommand,
  RegisteredToolContribution,
  RegisteredUiContribution,
  SlashCommandDefinition,
  UiSlotContribution,
} from "./types.ts";
import {
  isJsonRecord,
  validateActivationResult,
  validateActivator,
  validateKeybinding,
  validateLifecycleEvent,
  validateLifecycleHook,
  validateSlashCommand,
  validateToolDefinition,
  validateToolResult,
  validateUiContribution,
  type ValidatedToolDefinition,
} from "./validation.ts";

interface ExtensionOwner {
  readonly identity: ExtensionIdentity;
  readonly controller: AbortController;
  readonly registrations: InternalRegistration[];
  active: boolean;
  cleanup?: () => void | Promise<void>;
}

interface InternalRegistration {
  readonly disposable: ExtensionDisposable;
  isActive(): boolean;
  dispose(): void;
}

interface StoredCommand {
  readonly owner: ExtensionOwner;
  readonly definition: SlashCommandDefinition;
}

interface StoredKeybinding {
  readonly owner: ExtensionOwner;
  readonly definition: KeybindingDefinition;
}

interface StoredHook {
  readonly owner: ExtensionOwner;
  readonly hook: LifecycleHook;
  readonly registration: InternalRegistration;
}

const noopDisposable: ExtensionDisposable = Object.freeze({ dispose() {} });
let moduleImportSequence = 0;

export class ExtensionManager {
  private readonly globalDirectories: readonly string[];
  private readonly projectDirectories: readonly string[];
  private readonly approveProjectExtension: ProjectExtensionApproval | undefined;
  private readonly approvalDecisions = new Map<string, boolean>();
  private readonly toolMap = new Map<string, RegisteredToolContribution>();
  private readonly commandMap = new Map<string, StoredCommand>();
  private readonly keybindingMap = new Map<string, StoredKeybinding>();
  private readonly uiMap = new Map<string, RegisteredUiContribution>();
  private readonly hookMap = new Map<ExtensionLifecycleEvent, StoredHook[]>();
  private readonly owners: ExtensionOwner[] = [];
  private diagnosticLog: ExtensionDiagnostic[] = [];
  private extensionRecords: ExtensionRecord[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private loaded = false;

  constructor(options: ExtensionManagerOptions = {}) {
    this.globalDirectories = validateDirectories(options.globalDirectories, "globalDirectories");
    this.projectDirectories = validateDirectories(options.projectDirectories, "projectDirectories");
    this.approveProjectExtension = options.approveProjectExtension;
  }

  get diagnostics(): readonly ExtensionDiagnostic[] {
    return [...this.diagnosticLog];
  }

  get extensions(): readonly ExtensionRecord[] {
    return [...this.extensionRecords];
  }

  get tools(): readonly RegisteredToolContribution[] {
    return [...this.toolMap.values()];
  }

  get slashCommands(): readonly RegisteredSlashCommand[] {
    return [...this.commandMap.values()].map(({ owner, definition }) => ({
      extension: owner.identity,
      name: definition.name,
      description: definition.description,
    }));
  }

  get keybindings(): readonly RegisteredKeybinding[] {
    return [...this.keybindingMap.values()].map(({ owner, definition }) => ({
      extension: owner.identity,
      key: definition.key,
      description: definition.description,
    }));
  }

  get uiContributions(): readonly RegisteredUiContribution[] {
    return [...this.uiMap.values()].sort((left, right) => {
      const priority = (right.priority ?? 0) - (left.priority ?? 0);
      return priority === 0
        ? compare(`${left.slot}:${left.id}`, `${right.slot}:${right.id}`)
        : priority;
    });
  }

  load(signal: AbortSignal = new AbortController().signal): Promise<ExtensionLoadSummary> {
    return this.runExclusive(async () => {
      if (this.loaded) return this.summary();
      this.diagnosticLog = [];
      this.extensionRecords = [];
      return await this.performLoad(signal);
    });
  }

  reload(signal: AbortSignal = new AbortController().signal): Promise<ExtensionLoadSummary> {
    return this.runExclusive(async () => {
      this.diagnosticLog = [];
      await this.performUnload(false);
      this.extensionRecords = [];
      return await this.performLoad(signal);
    });
  }

  dispose(): Promise<void> {
    return this.runExclusive(async () => {
      await this.performUnload(true);
    });
  }

  async invokeSlashCommand(
    name: string,
    arguments_: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExtensionInvocationResult> {
    const normalizedName = name.startsWith("/") ? name.slice(1) : name;
    const stored = this.commandMap.get(normalizedName);
    if (!stored || !stored.owner.active) return { found: false, ok: false };

    try {
      const output = await stored.definition.execute({
        arguments: arguments_,
        signal: combineSignals(signal, stored.owner.controller.signal),
      });
      if (output !== undefined && typeof output !== "string") {
        throw new TypeError("slash command returned a non-string value");
      }
      return {
        found: true,
        ok: true,
        ...(output === undefined ? {} : { output }),
      };
    } catch (error) {
      this.addExtensionError(
        stored.owner.identity,
        "command",
        "command-invocation-failed",
        `Slash command /${normalizedName} failed: ${errorMessage(error)}`,
      );
      return { found: true, ok: false };
    }
  }

  async invokeKeybinding(
    key: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExtensionInvocationResult> {
    const stored = this.keybindingMap.get(key);
    if (!stored || !stored.owner.active) return { found: false, ok: false };

    try {
      const output = await stored.definition.execute({
        signal: combineSignals(signal, stored.owner.controller.signal),
      });
      if (output !== undefined && typeof output !== "string") {
        throw new TypeError("keybinding returned a non-string value");
      }
      return {
        found: true,
        ok: true,
        ...(output === undefined ? {} : { output }),
      };
    } catch (error) {
      this.addExtensionError(
        stored.owner.identity,
        "keybinding",
        "keybinding-invocation-failed",
        `Keybinding ${key} failed: ${errorMessage(error)}`,
      );
      return { found: true, ok: false };
    }
  }

  async emitLifecycle(
    event: ExtensionLifecycleEvent,
    data: Readonly<Record<string, JsonValue>> = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<LifecycleInvocationResult> {
    if (!validateLifecycleEvent(event) || !isJsonRecord(data)) {
      this.diagnosticLog.push({
        severity: "error",
        code: "invalid-lifecycle-invocation",
        phase: "lifecycle",
        message: "Lifecycle event or data is invalid",
      });
      return { invoked: 0, failed: 0 };
    }
    return await this.invokeLifecycle(event, data, signal);
  }

  private async performLoad(signal: AbortSignal): Promise<ExtensionLoadSummary> {
    this.generation += 1;
    const discovery = await discoverExtensions({
      globalDirectories: this.globalDirectories,
      projectDirectories: this.projectDirectories,
    });
    for (const issue of discovery.issues) {
      this.diagnosticLog.push({
        severity: "error",
        code: "extension-discovery-failed",
        phase: "discovery",
        message: issue.message,
        path: issue.path,
        source: issue.source,
      });
    }

    for (const [index, identity] of discovery.extensions.entries()) {
      if (signal.aborted) {
        this.extensionRecords.push({ extension: identity, state: "failed" });
        this.addExtensionError(
          identity,
          "activation",
          "extension-load-aborted",
          "Extension loading was aborted before activation",
        );
        continue;
      }
      if (identity.source === "project" && !(await this.approveProject(identity, signal))) {
        this.extensionRecords.push({ extension: identity, state: "denied" });
        continue;
      }
      await this.loadOne(identity, index);
    }

    this.loaded = true;
    await this.invokeLifecycle("extensions-loaded", {}, signal);
    return this.summary();
  }

  private async approveProject(identity: ExtensionIdentity, signal: AbortSignal): Promise<boolean> {
    const cached = this.approvalDecisions.get(identity.path);
    if (cached !== undefined) {
      if (!cached) {
        this.diagnosticLog.push({
          severity: "warning",
          code: "project-extension-denied",
          phase: "approval",
          message: "Project extension remains denied by its cached first-use decision",
          extension: identity,
        });
      }
      return cached;
    }
    if (!this.approveProjectExtension) {
      this.approvalDecisions.set(identity.path, false);
      this.diagnosticLog.push({
        severity: "warning",
        code: "project-extension-denied",
        phase: "approval",
        message: "Project extension denied because no approval callback was provided",
        extension: identity,
      });
      return false;
    }

    try {
      const decision: unknown = await this.approveProjectExtension(identity, signal);
      if (typeof decision !== "boolean") {
        this.addExtensionError(
          identity,
          "approval",
          "invalid-approval-decision",
          "Project extension approval callback returned a non-boolean value",
        );
        return false;
      }
      this.approvalDecisions.set(identity.path, decision);
      if (!decision) {
        this.diagnosticLog.push({
          severity: "warning",
          code: "project-extension-denied",
          phase: "approval",
          message: "Project extension was denied",
          extension: identity,
        });
      }
      return decision;
    } catch (error) {
      this.addExtensionError(
        identity,
        "approval",
        "project-extension-approval-failed",
        `Project extension approval failed: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private async loadOne(identity: ExtensionIdentity, index: number): Promise<void> {
    let moduleValue: unknown;
    try {
      // Bun keys path imports by the query string, giving reload a fresh module graph entry.
      moduleImportSequence += 1;
      const specifier = `${identity.path}?brisk-extension=${this.generation}-${index}-${moduleImportSequence}`;
      // This assignment is the only untyped dynamic-module boundary. Validation follows immediately.
      moduleValue = (await import(specifier)) as unknown;
    } catch (error) {
      this.extensionRecords.push({ extension: identity, state: "failed" });
      this.addExtensionError(
        identity,
        "import",
        "extension-import-failed",
        `Extension import failed: ${errorMessage(error)}`,
      );
      return;
    }

    let activator: ReturnType<typeof validateActivator>;
    try {
      activator = validateActivator(moduleValue);
    } catch (error) {
      this.extensionRecords.push({ extension: identity, state: "failed" });
      this.addExtensionError(
        identity,
        "activation",
        "invalid-extension-module",
        `Extension module validation failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (!activator.ok) {
      this.extensionRecords.push({ extension: identity, state: "failed" });
      this.addExtensionError(identity, "activation", "invalid-extension-module", activator.error);
      return;
    }

    const owner: ExtensionOwner = {
      identity,
      controller: new AbortController(),
      registrations: [],
      active: true,
    };
    const context = this.createContext(owner);
    try {
      const activationResult: unknown = await activator.value(context);
      const cleanup = validateActivationResult(activationResult);
      if (!cleanup.ok) throw new TypeError(cleanup.error);
      if (cleanup.value) owner.cleanup = cleanup.value;
      this.owners.push(owner);
      this.extensionRecords.push({ extension: identity, state: "loaded" });
    } catch (error) {
      await this.disposeOwner(owner);
      this.extensionRecords.push({ extension: identity, state: "failed" });
      this.addExtensionError(
        identity,
        "activation",
        "extension-activation-failed",
        `Extension activation failed: ${errorMessage(error)}`,
      );
    }
  }

  private createContext(owner: ExtensionOwner): BriskExtensionContext {
    return Object.freeze({
      extension: owner.identity,
      signal: owner.controller.signal,
      registerTool: <TArguments>(definition: ToolDefinition<TArguments>) =>
        this.registerTool(owner, definition),
      registerSlashCommand: (definition: SlashCommandDefinition) =>
        this.registerSlashCommand(owner, definition),
      registerKeybinding: (definition: KeybindingDefinition) =>
        this.registerKeybinding(owner, definition),
      contributeUi: (contribution: UiSlotContribution) =>
        this.registerUiContribution(owner, contribution),
      onLifecycle: (event: ExtensionLifecycleEvent, hook: LifecycleHook) =>
        this.registerLifecycleHook(owner, event, hook),
    });
  }

  private registerTool<TArguments>(
    owner: ExtensionOwner,
    definition: ToolDefinition<TArguments>,
  ): ExtensionDisposable {
    if (!this.ensureActive(owner, "tool")) return noopDisposable;
    const validated = validateToolDefinition(definition);
    if (!validated.ok) {
      this.registrationError(owner.identity, "invalid-tool-registration", validated.error);
      return noopDisposable;
    }
    if (this.toolMap.has(validated.value.name)) {
      this.duplicateError(owner.identity, "tool", validated.value.name);
      return noopDisposable;
    }

    const contribution: RegisteredToolContribution = Object.freeze({
      extension: owner.identity,
      definition: this.safeTool(owner, validated.value),
    });
    this.toolMap.set(validated.value.name, contribution);
    return this.createRegistration(owner, () => {
      if (this.toolMap.get(validated.value.name) === contribution) {
        this.toolMap.delete(validated.value.name);
      }
    }).disposable;
  }

  private safeTool(
    owner: ExtensionOwner,
    definition: ValidatedToolDefinition,
  ): ToolDefinition<JsonValue> {
    return Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(definition.readOnly === undefined ? {} : { readOnly: definition.readOnly }),
      ...(definition.parallelSafe === undefined ? {} : { parallelSafe: definition.parallelSafe }),
      ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      execute: async (input: JsonValue, context: ToolContext): Promise<ToolResult> => {
        if (!owner.active) {
          return {
            content: `Extension tool ${definition.name} is no longer active`,
            isError: true,
          };
        }
        try {
          const parsed = definition.parse ? definition.parse(input) : input;
          const result: unknown = await definition.execute(parsed, {
            signal: combineSignals(context.signal, owner.controller.signal),
            callId: context.callId,
            toolName: context.toolName,
            emitOutput: context.emitOutput,
          });
          const validatedResult = validateToolResult(result);
          if (!validatedResult.ok) throw new TypeError(validatedResult.error);
          return validatedResult.value;
        } catch (error) {
          this.addExtensionError(
            owner.identity,
            "tool",
            "extension-tool-failed",
            `Tool ${definition.name} failed: ${errorMessage(error)}`,
          );
          return {
            content: `Extension tool ${definition.name} failed: ${errorMessage(error)}`,
            isError: true,
          };
        }
      },
    });
  }

  private registerSlashCommand(
    owner: ExtensionOwner,
    definition: SlashCommandDefinition,
  ): ExtensionDisposable {
    if (!this.ensureActive(owner, "slash command")) return noopDisposable;
    const validated = validateSlashCommand(definition);
    if (!validated.ok) {
      this.registrationError(owner.identity, "invalid-command-registration", validated.error);
      return noopDisposable;
    }
    if (this.commandMap.has(validated.value.name)) {
      this.duplicateError(owner.identity, "slash command", validated.value.name);
      return noopDisposable;
    }

    const stored: StoredCommand = { owner, definition: validated.value };
    this.commandMap.set(validated.value.name, stored);
    return this.createRegistration(owner, () => {
      if (this.commandMap.get(validated.value.name) === stored) {
        this.commandMap.delete(validated.value.name);
      }
    }).disposable;
  }

  private registerKeybinding(
    owner: ExtensionOwner,
    definition: KeybindingDefinition,
  ): ExtensionDisposable {
    if (!this.ensureActive(owner, "keybinding")) return noopDisposable;
    const validated = validateKeybinding(definition);
    if (!validated.ok) {
      this.registrationError(owner.identity, "invalid-keybinding-registration", validated.error);
      return noopDisposable;
    }
    if (this.keybindingMap.has(validated.value.key)) {
      this.duplicateError(owner.identity, "keybinding", validated.value.key);
      return noopDisposable;
    }

    const stored: StoredKeybinding = { owner, definition: validated.value };
    this.keybindingMap.set(validated.value.key, stored);
    return this.createRegistration(owner, () => {
      if (this.keybindingMap.get(validated.value.key) === stored) {
        this.keybindingMap.delete(validated.value.key);
      }
    }).disposable;
  }

  private registerUiContribution(
    owner: ExtensionOwner,
    contribution: UiSlotContribution,
  ): ExtensionDisposable {
    if (!this.ensureActive(owner, "UI contribution")) return noopDisposable;
    const validated = validateUiContribution(contribution);
    if (!validated.ok) {
      this.registrationError(owner.identity, "invalid-ui-registration", validated.error);
      return noopDisposable;
    }
    const key = `${validated.value.slot}:${validated.value.id}`;
    if (this.uiMap.has(key)) {
      this.duplicateError(owner.identity, "UI contribution", key);
      return noopDisposable;
    }

    const stored: RegisteredUiContribution = Object.freeze({
      extension: owner.identity,
      id: validated.value.id,
      slot: validated.value.slot,
      text: validated.value.text,
      ...(validated.value.priority === undefined ? {} : { priority: validated.value.priority }),
    });
    this.uiMap.set(key, stored);
    return this.createRegistration(owner, () => {
      if (this.uiMap.get(key) === stored) this.uiMap.delete(key);
    }).disposable;
  }

  private registerLifecycleHook(
    owner: ExtensionOwner,
    event: ExtensionLifecycleEvent,
    hook: LifecycleHook,
  ): ExtensionDisposable {
    if (!this.ensureActive(owner, "lifecycle hook")) return noopDisposable;
    if (!validateLifecycleEvent(event) || !validateLifecycleHook(hook)) {
      this.registrationError(
        owner.identity,
        "invalid-lifecycle-registration",
        "Lifecycle event or hook is invalid",
      );
      return noopDisposable;
    }

    let registration: InternalRegistration;
    const stored = { owner, hook } as Omit<StoredHook, "registration">;
    registration = this.createRegistration(owner, () => {
      const hooks = this.hookMap.get(event);
      if (!hooks) return;
      const index = hooks.findIndex((candidate) => candidate.registration === registration);
      if (index >= 0) hooks.splice(index, 1);
      if (hooks.length === 0) this.hookMap.delete(event);
    });
    const hooks = this.hookMap.get(event) ?? [];
    hooks.push({ ...stored, registration });
    this.hookMap.set(event, hooks);
    return registration.disposable;
  }

  private async invokeLifecycle(
    event: ExtensionLifecycleEvent,
    data: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<LifecycleInvocationResult> {
    const hooks = [...(this.hookMap.get(event) ?? [])];
    let invoked = 0;
    let failed = 0;
    for (const stored of hooks) {
      if (!stored.owner.active || !stored.registration.isActive()) continue;
      invoked += 1;
      try {
        await stored.hook({
          event,
          data: Object.freeze({ ...data }),
          signal: combineSignals(signal, stored.owner.controller.signal),
        });
      } catch (error) {
        failed += 1;
        this.addExtensionError(
          stored.owner.identity,
          "lifecycle",
          "lifecycle-hook-failed",
          `Lifecycle hook ${event} failed: ${errorMessage(error)}`,
        );
      }
    }
    return { invoked, failed };
  }

  private createRegistration(owner: ExtensionOwner, remove: () => void): InternalRegistration {
    let active = true;
    const dispose = (): void => {
      if (!active) return;
      active = false;
      remove();
    };
    const registration: InternalRegistration = {
      disposable: Object.freeze({ dispose }),
      isActive: () => active,
      dispose,
    };
    owner.registrations.push(registration);
    return registration;
  }

  private ensureActive(owner: ExtensionOwner, kind: string): boolean {
    if (owner.active) return true;
    this.registrationError(
      owner.identity,
      "inactive-extension-registration",
      `Cannot register ${kind} after extension disposal`,
    );
    return false;
  }

  private duplicateError(identity: ExtensionIdentity, kind: string, name: string): void {
    this.diagnosticLog.push({
      severity: "warning",
      code: "duplicate-extension-registration",
      phase: "registration",
      message: `Duplicate ${kind} registration rejected: ${name}`,
      extension: identity,
    });
  }

  private registrationError(identity: ExtensionIdentity, code: string, message: string): void {
    this.addExtensionError(identity, "registration", code, message);
  }

  private addExtensionError(
    identity: ExtensionIdentity,
    phase: ExtensionDiagnostic["phase"],
    code: string,
    message: string,
  ): void {
    this.diagnosticLog.push({
      severity: "error",
      code,
      phase,
      message,
      extension: identity,
    });
  }

  private async performUnload(markDisposed: boolean): Promise<void> {
    this.loaded = false;
    for (const owner of [...this.owners].reverse()) await this.disposeOwner(owner);
    this.owners.length = 0;
    this.toolMap.clear();
    this.commandMap.clear();
    this.keybindingMap.clear();
    this.uiMap.clear();
    this.hookMap.clear();
    if (markDisposed) {
      this.extensionRecords = this.extensionRecords.map((record) =>
        record.state === "loaded" ? { extension: record.extension, state: "disposed" } : record,
      );
    }
  }

  private async disposeOwner(owner: ExtensionOwner): Promise<void> {
    if (!owner.active) return;
    owner.active = false;
    owner.controller.abort(new DOMException("Extension disposed", "AbortError"));
    if (owner.cleanup) {
      try {
        await owner.cleanup();
      } catch (error) {
        this.addExtensionError(
          owner.identity,
          "disposal",
          "extension-disposal-failed",
          `Extension disposal failed: ${errorMessage(error)}`,
        );
      }
    }
    for (const registration of [...owner.registrations].reverse()) {
      try {
        await registration.dispose();
      } catch (error) {
        this.addExtensionError(
          owner.identity,
          "disposal",
          "registration-disposal-failed",
          `Extension registration disposal failed: ${errorMessage(error)}`,
        );
      }
    }
    owner.registrations.length = 0;
  }

  private summary(): ExtensionLoadSummary {
    return {
      discovered: this.extensionRecords.length,
      loaded: this.extensionRecords.filter((record) => record.state === "loaded").length,
      denied: this.extensionRecords.filter((record) => record.state === "denied").length,
      failed: this.extensionRecords.filter((record) => record.state === "failed").length,
    };
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function validateDirectories(
  value: readonly string[] | undefined,
  name: string,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((directory) => typeof directory === "string")) {
    throw new TypeError(`${name} must be an array of paths`);
  }
  return [...value];
}

function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  return AbortSignal.any([left, right]);
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorMessage(error: unknown): string {
  try {
    return redactSecrets(error instanceof Error ? error.message : String(error));
  } catch {
    return "unknown error";
  }
}
