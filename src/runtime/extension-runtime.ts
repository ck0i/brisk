import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ExtensionManager } from "../extensions/manager.ts";
import type {
  ExtensionInvocationResult,
  ExtensionLifecycleEvent,
  ExtensionLoadSummary,
} from "../extensions/types.ts";
import { redactSecrets } from "../providers/secret-redaction.ts";
import type { ApprovalHandler, PermissionMode } from "../tools/approval.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { UiStore } from "../ui/state.ts";
import type { JsonValue } from "../core/messages.ts";

export interface RuntimeExtensionOptions {
  readonly workspace: string;
  readonly globalDirectory: string;
  readonly errorsPath: string;
  readonly approvalHandler: ApprovalHandler;
  readonly permissionMode: PermissionMode;
  readonly store: UiStore;
}

export interface ExtensionToolInstallResult {
  readonly installed: number;
  readonly skipped: readonly string[];
}

/** Bridges the isolated extension registry to Brisk runtime services. */
export class RuntimeExtensions {
  readonly manager: ExtensionManager;
  private readonly errorsPath: string;
  private readonly store: UiStore;

  constructor(private readonly options: RuntimeExtensionOptions) {
    this.errorsPath = options.errorsPath;
    this.store = options.store;
    this.manager = new ExtensionManager({
      globalDirectories: [options.globalDirectory],
      projectDirectories: [join(options.workspace, ".brisk", "extensions")],
      approveProjectExtension: async (extension, signal) => {
        if (options.permissionMode === "yolo") return true;
        const decision = await options.approvalHandler.requestApproval(
          {
            toolName: "extension",
            summary: `Load project extension ${extension.path}`,
            targetPaths: [extension.path],
            riskDescription:
              "Project extensions execute local TypeScript with this Brisk process's permissions.",
            equivalenceKey: `extension:${extension.path}`,
          },
          signal,
        );
        return decision !== "deny";
      },
    });
  }

  async load(signal?: AbortSignal): Promise<ExtensionLoadSummary> {
    const summary = await this.manager.load(signal);
    await this.synchronize();
    return summary;
  }

  async reload(signal?: AbortSignal): Promise<ExtensionLoadSummary> {
    const summary = await this.manager.reload(signal);
    await this.synchronize();
    return summary;
  }

  installTools(registry: ToolRegistry): ExtensionToolInstallResult {
    const existing = new Set(registry.schemas.map((schema) => schema.name));
    const skipped: string[] = [];
    let installed = 0;
    for (const contribution of this.manager.tools) {
      if (existing.has(contribution.definition.name)) {
        skipped.push(contribution.definition.name);
        continue;
      }
      registry.register(contribution.definition);
      existing.add(contribution.definition.name);
      installed += 1;
    }
    return { installed, skipped };
  }

  async invokeSlashCommand(
    name: string,
    arguments_: string,
    signal?: AbortSignal,
  ): Promise<ExtensionInvocationResult> {
    const result = await this.manager.invokeSlashCommand(name, arguments_, signal);
    await this.synchronize();
    return result;
  }

  async invokeKeybinding(key: string, signal?: AbortSignal): Promise<ExtensionInvocationResult> {
    const result = await this.manager.invokeKeybinding(key, signal);
    await this.synchronize();
    return result;
  }

  async emitLifecycle(
    event: ExtensionLifecycleEvent,
    data: Readonly<Record<string, JsonValue>> = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await this.manager.emitLifecycle(event, data, signal);
    await this.persistDiagnostics();
  }

  async dispose(): Promise<void> {
    await this.manager.dispose();
    this.store.setExtensionUi([]);
    this.store.setExtensionKeybindings([]);
    await this.persistDiagnostics();
  }

  private async synchronize(): Promise<void> {
    this.store.setExtensionUi(
      this.manager.uiContributions.map((contribution) => ({
        id: `${contribution.extension.id}:${contribution.slot}:${contribution.id}`,
        slot: contribution.slot,
        text: contribution.text,
        ...(contribution.priority === undefined ? {} : { priority: contribution.priority }),
      })),
    );
    this.store.setExtensionKeybindings(this.manager.keybindings.map((binding) => binding.key));
    await this.persistDiagnostics();
  }

  private async persistDiagnostics(): Promise<void> {
    const errors = this.manager.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => ({
        code: diagnostic.code,
        phase: diagnostic.phase,
        message: redactSecrets(diagnostic.message),
        ...(diagnostic.extension === undefined ? {} : { extension: diagnostic.extension.id }),
      }));
    const document = `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), errors })}\n`;
    const directory = dirname(this.errorsPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.errorsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, document, { mode: 0o600 });
      await rename(temporary, this.errorsPath);
      if (process.platform !== "win32") await chmod(this.errorsPath, 0o600);
    } catch (error) {
      await Bun.file(temporary)
        .delete()
        .catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.store.update({
        status: "extension diagnostics unavailable",
        notice: redactSecrets(message),
      });
    }
  }
}
