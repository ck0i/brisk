import type { CliCommand } from "./args.ts";
import { TerminalAuthPrompter } from "./auth-prompter.ts";
import { ensureConfigDirectories, type ConfigPaths } from "../config/paths.ts";
import type { BriskConfig } from "../config/schema.ts";
import {
  AuthService,
  BUILT_IN_BRISK_OAUTH_PROVIDERS,
  type ProviderAuthStatus,
} from "../providers/auth-service.ts";
import { ProviderService } from "../providers/provider-service.ts";
import type { RegisteredModel } from "../providers/model-registry.ts";

export interface CommandIo {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export async function runAuthCommand(
  command: Extract<CliCommand, { readonly name: "auth" }>,
  paths: ConfigPaths,
  io: CommandIo = {},
): Promise<void> {
  await ensureConfigDirectories(paths);
  const output = io.output ?? process.stdout;
  const auth = await AuthService.initialize(paths.authPath);
  try {
    if (command.action === "status") {
      const statuses = auth.listProviderStatus();
      writeAuthStatus(statuses, command.json, output);
      return;
    }

    const prompter = new TerminalAuthPrompter({
      input: io.input ?? process.stdin,
      output,
    });
    try {
      const provider =
        command.provider ??
        (await chooseProvider(command.action, auth.listProviderStatus(), prompter));
      if (command.action === "login") {
        await auth.login(provider, prompter);
        writeResult({ action: "login", provider, status: "ok" }, command.json, output);
      } else {
        await auth.logout(provider);
        writeResult({ action: "logout", provider, status: "ok" }, command.json, output);
      }
    } finally {
      prompter.close();
    }
  } finally {
    auth.close();
  }
}

export async function runModelsCommand(
  command: Extract<CliCommand, { readonly name: "models" }>,
  paths: ConfigPaths,
  config: BriskConfig,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  await ensureConfigDirectories(paths);
  const providers = await ProviderService.initialize({ paths, config });
  try {
    await providers.registry.refreshingBundledAndCustom;
    if (command.refresh) await providers.refreshModels();
    writeModels(providers.models, command.json, output);
  } finally {
    providers.close();
  }
}

function writeAuthStatus(
  statuses: readonly ProviderAuthStatus[],
  json: boolean,
  output: NodeJS.WritableStream,
): void {
  if (json) {
    output.write(`${JSON.stringify(statuses)}\n`);
    return;
  }
  output.write("Provider authentication\n");
  for (const status of statuses) {
    const source = status.configured ? (status.source ?? "configured") : "not configured";
    const environment = status.envVar ? ` (${status.envVar})` : "";
    output.write(`${status.configured ? "✓" : "·"} ${status.provider}: ${source}${environment}\n`);
  }
}

function writeModels(
  models: readonly RegisteredModel[],
  json: boolean,
  output: NodeJS.WritableStream,
): void {
  if (json) {
    output.write(`${JSON.stringify(models)}\n`);
    return;
  }
  if (models.length === 0) {
    output.write("No cached or bundled models are available.\n");
    return;
  }
  let provider = "";
  for (const model of models) {
    if (model.provider !== provider) {
      provider = model.provider;
      output.write(`\n${provider}\n`);
    }
    const context =
      model.contextWindow === null ? "unknown context" : formatTokens(model.contextWindow);
    output.write(`${model.available ? "✓" : "·"} ${model.id} · ${context} · ${model.api}\n`);
  }
}

async function chooseProvider(
  action: "login" | "logout",
  statuses: readonly ProviderAuthStatus[],
  prompter: TerminalAuthPrompter,
): Promise<string> {
  const byId = new Map(statuses.map((status) => [status.provider, status]));
  const candidates =
    action === "login"
      ? BUILT_IN_BRISK_OAUTH_PROVIDERS.filter((provider) => byId.get(provider)?.oauthAvailable)
      : statuses.filter((status) => status.configured).map((status) => status.provider);
  if (candidates.length === 0) {
    throw new Error(
      action === "login"
        ? "No supported OAuth provider is available"
        : "No configured provider is available to log out",
    );
  }
  const defaultProvider = candidates[0];
  if (!defaultProvider) throw new Error("Provider selection invariant failed");
  prompter.progress(`Available providers: ${candidates.join(", ")}`);
  const selected = await prompter.ask(`Provider to ${action}`, {
    placeholder: defaultProvider,
    allowEmpty: true,
  });
  const provider = selected || defaultProvider;
  if (!candidates.includes(provider as (typeof candidates)[number])) {
    throw new Error(`Unsupported provider selection: ${provider}`);
  }
  return provider;
}

function writeResult(
  result: { readonly action: string; readonly provider: string; readonly status: "ok" },
  json: boolean,
  output: NodeJS.WritableStream,
): void {
  if (json) output.write(`${JSON.stringify(result)}\n`);
  else
    output.write(
      `${result.action === "login" ? "Logged in to" : "Logged out of"} ${result.provider}.\n`,
    );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m context`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k context`;
  return `${value} context`;
}
