import type { JsonValue } from "../core/messages.ts";
import type { ToolDefinition } from "../tools/registry.ts";

export type ExtensionSource = "global" | "project";

export interface ExtensionIdentity {
  /** Stable for a source and canonical entry path. */
  readonly id: string;
  readonly path: string;
  readonly root: string;
  readonly source: ExtensionSource;
}

export interface ExtensionDisposable {
  dispose(): void | Promise<void>;
}

export interface SlashCommandInvocation {
  readonly arguments: string;
  readonly signal: AbortSignal;
}

export interface SlashCommandDefinition {
  readonly name: string;
  readonly description: string;
  execute(invocation: SlashCommandInvocation): string | void | Promise<string | void>;
}

export interface KeybindingInvocation {
  readonly signal: AbortSignal;
}

export interface KeybindingDefinition {
  readonly key: string;
  readonly description: string;
  execute(invocation: KeybindingInvocation): string | void | Promise<string | void>;
}

export type ExtensionUiSlot = "header" | "sidebar" | "status" | "composer";

export interface UiSlotContribution {
  readonly id: string;
  readonly slot: ExtensionUiSlot;
  readonly text: string;
  readonly priority?: number;
}

export type ExtensionLifecycleEvent =
  "extensions-loaded" | "session-start" | "session-end" | "turn-start" | "turn-end" | "shutdown";

export interface LifecycleHookInvocation {
  readonly event: ExtensionLifecycleEvent;
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}

export type LifecycleHook = (invocation: LifecycleHookInvocation) => void | Promise<void>;

export interface BriskExtensionContext {
  readonly extension: ExtensionIdentity;
  /** Aborted before the extension is disposed or reloaded. */
  readonly signal: AbortSignal;
  registerTool<TArguments>(definition: ToolDefinition<TArguments>): ExtensionDisposable;
  registerSlashCommand(definition: SlashCommandDefinition): ExtensionDisposable;
  registerKeybinding(definition: KeybindingDefinition): ExtensionDisposable;
  contributeUi(contribution: UiSlotContribution): ExtensionDisposable;
  onLifecycle(event: ExtensionLifecycleEvent, hook: LifecycleHook): ExtensionDisposable;
}

export type ExtensionActivationResult = void | (() => void | Promise<void>) | ExtensionDisposable;

export type BriskExtensionActivator = (
  context: BriskExtensionContext,
) => ExtensionActivationResult | Promise<ExtensionActivationResult>;

export interface BriskExtension {
  readonly activate: BriskExtensionActivator;
}

export function defineExtension(activate: BriskExtensionActivator): BriskExtensionActivator {
  return activate;
}

export type ExtensionState = "loaded" | "denied" | "failed" | "disposed";

export interface ExtensionRecord {
  readonly extension: ExtensionIdentity;
  readonly state: ExtensionState;
}

export type ExtensionDiagnosticPhase =
  | "discovery"
  | "approval"
  | "import"
  | "activation"
  | "registration"
  | "tool"
  | "command"
  | "keybinding"
  | "lifecycle"
  | "disposal";

export interface ExtensionDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly phase: ExtensionDiagnosticPhase;
  readonly message: string;
  readonly extension?: ExtensionIdentity;
  readonly path?: string;
  readonly source?: ExtensionSource;
}

export interface RegisteredToolContribution {
  readonly extension: ExtensionIdentity;
  readonly definition: ToolDefinition<JsonValue>;
}

export interface RegisteredSlashCommand {
  readonly extension: ExtensionIdentity;
  readonly name: string;
  readonly description: string;
}

export interface RegisteredKeybinding {
  readonly extension: ExtensionIdentity;
  readonly key: string;
  readonly description: string;
}

export interface RegisteredUiContribution extends UiSlotContribution {
  readonly extension: ExtensionIdentity;
}

export interface ExtensionInvocationResult {
  readonly found: boolean;
  readonly ok: boolean;
  readonly output?: string;
}

export interface LifecycleInvocationResult {
  readonly invoked: number;
  readonly failed: number;
}

export interface ExtensionLoadSummary {
  readonly discovered: number;
  readonly loaded: number;
  readonly denied: number;
  readonly failed: number;
}

export type ProjectExtensionApproval = (
  extension: ExtensionIdentity,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export interface ExtensionManagerOptions {
  readonly globalDirectories?: readonly string[];
  readonly projectDirectories?: readonly string[];
  /** Project extensions are denied by default. Decisions are cached for this manager instance. */
  readonly approveProjectExtension?: ProjectExtensionApproval;
}
