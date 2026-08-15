import { join } from "node:path";

import type { CacheRetention } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
  clampThinkingLevelForModel,
  getSupportedEfforts,
  minimumSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model, OpenAICompat } from "@oh-my-pi/pi-catalog";

import type { BriskConfig, CustomProviderConfig, EffortSetting } from "../config/schema.ts";
import type { ConfigPaths } from "../config/paths.ts";
import { AuthService, type AuthServiceDependencies } from "./auth-service.ts";
import { CursorSdkProvider, type CursorSdkRuntime } from "./cursor-sdk-provider.ts";
import {
  ModelRegistry,
  type CustomOpenAICompatibleModel,
  type RegisteredModel,
} from "./model-registry.ts";
import {
  PiAiProvider,
  type ApiKeyResolutionOptions,
  type CredentialResolver,
} from "./pi-ai-provider.ts";
import { resolvePromptCacheRetention } from "./prompt-cache.ts";
import { isCursorAgentModel, type ModelTransport } from "./transport.ts";

export interface ProviderServiceOptions {
  readonly paths: ConfigPaths;
  readonly config: BriskConfig;
  readonly workspace?: string;
  readonly sessionId?: string;
  readonly preferredModel?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly authDependencies?: AuthServiceDependencies;
  readonly cursorRuntime?: CursorSdkRuntime;
}

export interface ModelSelection {
  readonly record: RegisteredModel;
  readonly upstream: Model<Api>;
}

export interface IsolatedProviderSelection extends ModelSelection {
  readonly provider: ModelTransport;
  readonly modelSpecifier: string;
  readonly effort: EffortSetting;
}

export type ProviderServiceListener = (selection: ModelSelection | undefined) => void;

// Cursor's synthetic start event is not semantic progress. Fail a stalled child
// attempt promptly so AgentLoop can retry instead of waiting for Pi's five-minute default.
const CURSOR_CHILD_STREAM_TIMEOUT_MS = 90_000;

/** Combines upstream auth resolution with per-provider custom endpoint configuration. */
export class ConfigCredentialResolver implements CredentialResolver {
  private readonly customProviders: Readonly<Record<string, CustomProviderConfig>>;

  constructor(
    private readonly upstream: CredentialResolver & {
      hasAuth(provider: string): boolean | Promise<boolean>;
    },
    providers: Readonly<Record<string, CustomProviderConfig>>,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.customProviders = providers;
  }

  async hasAuth(provider: string): Promise<boolean> {
    const custom = this.customProviders[provider];
    if (!custom) {
      if (provider === "cursor" && Boolean(this.environment.CURSOR_API_KEY?.trim())) return true;
      return await this.upstream.hasAuth(provider);
    }
    if (custom.keyless === true) return true;
    if (custom.apiKeyEnv !== undefined) return Boolean(this.environment[custom.apiKeyEnv]);
    return await this.upstream.hasAuth(provider);
  }

  async getApiKey(
    provider: string,
    sessionId?: string,
    options?: ApiKeyResolutionOptions,
  ): Promise<string | undefined> {
    const custom = this.customProviders[provider];
    if (!custom) {
      const stored = await this.upstream.getApiKey(provider, sessionId, options);
      if (stored) return stored;
      if (provider === "cursor") return this.environment.CURSOR_API_KEY?.trim();
      return undefined;
    }
    if (custom.keyless === true) return undefined;
    if (custom.apiKeyEnv !== undefined) return this.environment[custom.apiKeyEnv];
    return await this.upstream.getApiKey(provider, sessionId, options);
  }
}

/** Owns one reusable auth store, model registry, and provider transport. */
export class ProviderService {
  readonly auth: AuthService;
  readonly registry: ModelRegistry;
  readonly credentials: ConfigCredentialResolver;
  private readonly listeners = new Set<ProviderServiceListener>();
  private readonly preferredModel: string | undefined;
  private readonly cacheRetention: CacheRetention;
  private readonly workspace: string;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly cursorRuntime: CursorSdkRuntime | undefined;
  private readonly paths: ConfigPaths;
  private requestedEffort: EffortSetting;
  private readonly subtaskEffort: EffortSetting;
  private sessionId: string | undefined;
  private selectedValue: ModelSelection | undefined;
  private transportValue: ModelTransport | undefined;
  private closed = false;

  private constructor(
    options: ProviderServiceOptions,
    auth: AuthService,
    registry: ModelRegistry,
    credentials: ConfigCredentialResolver,
  ) {
    this.auth = auth;
    this.registry = registry;
    this.credentials = credentials;
    this.paths = options.paths;
    this.preferredModel = options.preferredModel ?? options.config.defaultModel;
    this.cacheRetention = resolvePromptCacheRetention(options.environment);
    this.workspace = options.workspace ?? process.cwd();
    this.environment = options.environment ?? process.env;
    this.cursorRuntime = options.cursorRuntime;
    this.requestedEffort = options.config.effort;
    this.subtaskEffort = options.config.subtaskEffort;
    this.sessionId = options.sessionId;
  }

  static async initialize(options: ProviderServiceOptions): Promise<ProviderService> {
    const auth = await AuthService.initialize(options.paths.authPath, options.authDependencies);
    try {
      const credentials = new ConfigCredentialResolver(
        auth,
        options.config.providers,
        options.environment,
      );
      const registry = await ModelRegistry.create({
        cachePath: options.paths.modelCachePath,
        auth: credentials,
        customModels: customModelsFromConfig(options.config.providers),
      });
      return new ProviderService(options, auth, registry, credentials);
    } catch (error) {
      auth.close();
      throw error;
    }
  }

  get models(): readonly RegisteredModel[] {
    return this.registry.models;
  }

  get selected(): ModelSelection | undefined {
    return this.selectedValue;
  }

  get provider(): ModelTransport | undefined {
    return this.transportValue;
  }

  get effort(): EffortSetting {
    return resolveEffortSetting(this.selectedValue?.upstream, this.requestedEffort);
  }

  setEffort(effort: EffortSetting): EffortSetting {
    this.assertOpen();
    this.requestedEffort = effort;
    const resolved = this.effort;
    this.transportValue?.setReasoning(toProviderReasoning(resolved));
    return resolved;
  }

  setSessionId(sessionId: string): void {
    this.assertOpen();
    this.sessionId = sessionId;
    this.transportValue?.setSessionId(sessionId);
  }

  subscribe(listener: ProviderServiceListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait for local bundled/custom refresh, then select the configured or first available model. */
  async selectInitial(): Promise<ModelSelection | undefined> {
    this.assertOpen();
    await this.registry.refreshingBundledAndCustom;
    if (this.preferredModel !== undefined) {
      const requested = splitModelSpecifier(this.preferredModel);
      if (requested) {
        const record = this.registry.select(requested.provider, requested.id);
        if (record?.available) return this.select(record.provider, record.id);
      }
    }
    const fallback = this.registry.models.find((model) => model.available);
    return fallback ? this.select(fallback.provider, fallback.id) : undefined;
  }

  async refreshModels(): Promise<void> {
    this.assertOpen();
    await this.registry.refreshBundledAndCustom();
    const selected = this.selectedValue;
    if (selected) {
      const refreshed = this.registry.select(selected.record.provider, selected.record.id);
      const upstream = this.registry.resolveUpstreamModel(
        selected.record.provider,
        selected.record.id,
      );
      if (!refreshed?.available || !upstream) {
        this.selectedValue = undefined;
        this.transportValue?.close();
        this.transportValue = undefined;
        this.publish();
      } else {
        this.selectedValue = { record: refreshed, upstream };
        this.transportValue?.setModel(upstream);
        this.transportValue?.setReasoning(
          toProviderReasoning(resolveEffortSetting(upstream, this.requestedEffort)),
        );
        this.publish();
      }
    }
  }

  createIsolatedProvider(
    modelSpecifier: string | undefined,
    sessionId: string,
    effort: EffortSetting = this.subtaskEffort,
  ): IsolatedProviderSelection {
    this.assertOpen();
    const parsed = modelSpecifier === undefined ? undefined : splitModelSpecifier(modelSpecifier);
    // A malformed optional child override behaves as omitted and uses the selected default.
    const selected = parsed ? this.selectionFor(parsed.provider, parsed.id) : this.selectedValue;
    if (!selected) throw new Error("No provider model is selected for the child session");
    const resolvedSpecifier = `${selected.record.provider}/${selected.record.id}`;
    const resolvedEffort = resolveEffortSetting(selected.upstream, effort);
    return {
      ...selected,
      provider: this.createTransport(selected.upstream, sessionId, resolvedEffort, true),
      modelSpecifier: resolvedSpecifier,
      effort: resolvedEffort,
    };
  }

  select(provider: string, id: string): ModelSelection {
    this.assertOpen();
    const selection = this.selectionFor(provider, id);
    const { upstream } = selection;
    this.selectedValue = selection;
    if (this.transportValue && sameTransportKind(this.transportValue, upstream)) {
      const reasoning = toProviderReasoning(resolveEffortSetting(upstream, this.requestedEffort));
      this.transportValue.setModel(upstream);
      this.transportValue.setReasoning(reasoning);
    } else {
      this.transportValue?.close();
      this.transportValue = this.createTransport(
        upstream,
        this.sessionId,
        this.requestedEffort,
        false,
      );
    }
    this.publish();
    return this.selectedValue;
  }

  private selectionFor(provider: string, id: string): ModelSelection {
    const record = this.registry.select(provider, id);
    if (!record) throw new Error(`Unknown model: ${provider}/${id}`);
    if (!record.available) throw new Error(`Model is unavailable: ${provider}/${id}`);
    const upstream = this.registry.resolveUpstreamModel(provider, id);
    if (!upstream) throw new Error(`Model metadata is still loading: ${provider}/${id}`);
    return { record, upstream };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.transportValue?.close();
    this.transportValue = undefined;
    this.auth.close();
  }

  private createTransport(
    upstream: Model<Api>,
    sessionId: string | undefined,
    effort: EffortSetting,
    isolated: boolean,
  ): ModelTransport {
    const reasoning = toProviderReasoning(resolveEffortSetting(upstream, effort));
    if (isCursorAgentModel(upstream)) {
      return new CursorSdkProvider({
        model: upstream,
        auth: this.credentials,
        workspace: this.workspace,
        storeDirectory: join(this.paths.dataRoot, "cursor-sdk"),
        environment: this.environment,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(this.cursorRuntime === undefined ? {} : { runtime: this.cursorRuntime }),
        ...(isolated ? { firstEventTimeoutMs: CURSOR_CHILD_STREAM_TIMEOUT_MS } : {}),
      });
    }
    return new PiAiProvider({
      model: upstream,
      auth: this.credentials,
      cacheRetention: this.cacheRetention,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.selectedValue);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Provider service is closed");
  }
}

export function supportedEffortSettings(model: Model<Api>): readonly EffortSetting[] {
  if (!model.reasoning) return ["off"];
  const efforts = getSupportedEfforts(model) as readonly EffortSetting[];
  return [
    "auto",
    ...(model.thinking?.requiresEffort === true ? [] : (["off"] as const)),
    ...efforts,
  ];
}

export function resolveEffortSetting(
  model: Model<Api> | undefined,
  requested: EffortSetting,
): EffortSetting {
  if (!model) return requested;
  if (!model.reasoning) return "off";
  if (requested === "auto") return "auto";
  if (requested === "off") {
    if (model.thinking?.requiresEffort !== true) return "off";
    return (model.thinking.defaultLevel ??
      minimumSupportedEffort(model) ??
      "auto") as EffortSetting;
  }
  const effort = effortFromSetting(requested);
  const clamped = clampThinkingLevelForModel(model, effort);
  return (clamped ?? "auto") as EffortSetting;
}

function sameTransportKind(transport: ModelTransport, model: Model<Api>): boolean {
  return isCursorAgentModel(transport.model) === isCursorAgentModel(model);
}

function toProviderReasoning(effort: EffortSetting): Effort | "off" | undefined {
  if (effort === "auto") return undefined;
  if (effort === "off") return "off";
  return effortFromSetting(effort);
}

function effortFromSetting(effort: Exclude<EffortSetting, "auto" | "off">): Effort {
  return effort as Effort;
}

export function customModelsFromConfig(
  providers: Readonly<Record<string, CustomProviderConfig>>,
): CustomOpenAICompatibleModel[] {
  return Object.entries(providers).flatMap(([provider, definition]) =>
    definition.models.map((model) => ({
      provider,
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(definition.api === undefined ? {} : { api: definition.api }),
      baseUrl: definition.baseUrl,
      contextWindow: model.contextWindow,
      maxTokens: model.maxOutputTokens,
      input: model.input,
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      supportsTools: model.toolCalling,
      keyless: definition.keyless ?? false,
      ...(model.compat === undefined ? {} : { compat: model.compat as OpenAICompat }),
    })),
  );
}

export function splitModelSpecifier(
  specifier: string,
): { readonly provider: string; readonly id: string } | undefined {
  const separator = specifier.indexOf("/");
  if (separator <= 0 || separator === specifier.length - 1) return undefined;
  return { provider: specifier.slice(0, separator), id: specifier.slice(separator + 1) };
}
