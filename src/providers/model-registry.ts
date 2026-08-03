import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Api, Model, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
  getBundledModels,
  getBundledProviders,
  type GeneratedProvider,
} from "@oh-my-pi/pi-catalog/models";

import { redactedErrorMessage } from "./secret-redaction.ts";

const CACHE_VERSION = 1;

export interface ModelAvailability {
  hasAuth(provider: string): boolean | Promise<boolean>;
}

export interface CustomOpenAICompatibleModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly api?: "openai-completions" | "openai-responses";
  readonly baseUrl: string;
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly input?: readonly ("text" | "image")[];
  readonly reasoning?: boolean;
  readonly supportsTools?: boolean;
  readonly keyless?: boolean;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  readonly compat?: OpenAICompat;
}

export interface RegisteredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly input: readonly ("text" | "image")[];
  readonly reasoning: boolean;
  readonly supportsTools: boolean;
  readonly available: boolean;
  readonly source: "bundled" | "custom";
}

export interface ModelRegistryOptions {
  readonly cachePath: string;
  readonly auth: ModelAvailability;
  readonly customModels?: readonly CustomOpenAICompatibleModel[];
}

interface CacheDocument {
  readonly version: typeof CACHE_VERSION;
  readonly models: readonly RegisteredModel[];
}

/**
 * Cache-first registry for bundled and caller-defined models only.
 * Refreshing does not perform provider network discovery.
 */
export class ModelRegistry {
  private records: RegisteredModel[] = [];
  private upstreamModels = new Map<string, Model<Api>>();
  private refreshPromise: Promise<void> = Promise.resolve();
  private refreshFailure: string | undefined;

  private constructor(private readonly options: ModelRegistryOptions) {}

  static async create(options: ModelRegistryOptions): Promise<ModelRegistry> {
    const registry = new ModelRegistry(options);
    registry.records = await readCache(options.cachePath);
    registry.startBundledAndCustomRefresh();
    return registry;
  }

  get models(): readonly RegisteredModel[] {
    return this.records;
  }

  get refreshingBundledAndCustom(): Promise<void> {
    return this.refreshPromise;
  }

  get lastRefreshError(): string | undefined {
    return this.refreshFailure;
  }

  select(provider: string, id: string): RegisteredModel | undefined {
    return this.records.find((model) => model.provider === provider && model.id === id);
  }

  /** Available after the bundled/custom refresh has constructed exact pi-ai model objects. */
  resolveUpstreamModel(provider: string, id: string): Model<Api> | undefined {
    return this.upstreamModels.get(modelKey(provider, id));
  }

  refreshBundledAndCustom(): Promise<void> {
    this.startBundledAndCustomRefresh();
    return this.refreshPromise;
  }

  private startBundledAndCustomRefresh(): void {
    this.refreshPromise = this.performBundledAndCustomRefresh().catch((error: unknown) => {
      this.refreshFailure = redactedErrorMessage(error, [], "Model registry refresh failed");
    });
  }

  private async performBundledAndCustomRefresh(): Promise<void> {
    const bundledProviders = getBundledProviders();
    const customModels = (this.options.customModels ?? []).map(buildCustomModel);
    const providers = [
      ...new Set([...bundledProviders, ...customModels.map(({ model }) => model.provider)]),
    ];
    const availability = new Map(
      await Promise.all(
        providers.map(async (provider) => {
          try {
            return [provider, await this.options.auth.hasAuth(provider)] as const;
          } catch {
            return [provider, false] as const;
          }
        }),
      ),
    );

    const nextRecords = new Map<string, RegisteredModel>();
    const nextUpstream = new Map<string, Model<Api>>();
    for (const provider of bundledProviders) {
      for (const model of getBundledModels(provider as GeneratedProvider)) {
        const key = modelKey(model.provider, model.id);
        nextUpstream.set(key, model);
        nextRecords.set(key, toRecord(model, availability.get(model.provider) ?? false, "bundled"));
      }
    }
    for (const custom of customModels) {
      const key = modelKey(custom.model.provider, custom.model.id);
      const available = custom.keyless || (availability.get(custom.model.provider) ?? false);
      nextUpstream.set(key, custom.model);
      nextRecords.set(key, toRecord(custom.model, available, "custom"));
    }

    this.records = [...nextRecords.values()].sort(compareModels);
    this.upstreamModels = nextUpstream;
    this.refreshFailure = undefined;
    await writeCacheAtomically(this.options.cachePath, this.records);
  }
}

function buildCustomModel(definition: CustomOpenAICompatibleModel): {
  readonly model: Model<Api>;
  readonly keyless: boolean;
} {
  validateCustomDefinition(definition);
  const api = definition.api ?? "openai-completions";
  const common = {
    id: definition.id,
    name: definition.name ?? definition.id,
    provider: definition.provider,
    baseUrl: definition.baseUrl,
    reasoning: definition.reasoning ?? false,
    input: [...(definition.input ?? ["text"])] as ("text" | "image")[],
    ...(definition.supportsTools === undefined ? {} : { supportsTools: definition.supportsTools }),
    cost: {
      input: definition.cost?.input ?? 0,
      output: definition.cost?.output ?? 0,
      cacheRead: definition.cost?.cacheRead ?? 0,
      cacheWrite: definition.cost?.cacheWrite ?? 0,
    },
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    ...(definition.compat === undefined ? {} : { compat: definition.compat }),
  };
  const model: Model<Api> =
    api === "openai-responses"
      ? buildModel({ ...common, api } satisfies ModelSpec<"openai-responses">)
      : buildModel({ ...common, api } satisfies ModelSpec<"openai-completions">);
  return { model, keyless: definition.keyless ?? false };
}

function validateCustomDefinition(definition: CustomOpenAICompatibleModel): void {
  if (!definition.provider.trim() || !definition.id.trim()) {
    throw new TypeError("Custom model provider and id are required");
  }
  if (!validTokenLimit(definition.contextWindow) || !validTokenLimit(definition.maxTokens)) {
    throw new TypeError("Custom model token limits must be positive integers or null");
  }
  let url: URL;
  try {
    url = new URL(definition.baseUrl);
  } catch {
    throw new TypeError("Custom model baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Custom model baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new TypeError("Custom model baseUrl must not contain credentials");
  }
}

function validTokenLimit(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function toRecord(
  model: Model<Api>,
  available: boolean,
  source: RegisteredModel["source"],
): RegisteredModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    reasoning: model.reasoning,
    supportsTools: model.supportsTools !== false,
    available,
    source,
  };
}

async function readCache(cachePath: string): Promise<RegisteredModel[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isCacheDocument(parsed)) return [];
    return parsed.models.map(copyCachedModel);
  } catch {
    return [];
  }
}

function isCacheDocument(value: unknown): value is CacheDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    !("models" in value)
  ) {
    return false;
  }
  if (value.version !== CACHE_VERSION || !Array.isArray(value.models)) return false;
  return value.models.every(isRegisteredModel);
}

function isRegisteredModel(value: unknown): value is RegisteredModel {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.provider === "string" &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.api === "string" &&
    typeof record.baseUrl === "string" &&
    validCachedLimit(record.contextWindow) &&
    validCachedLimit(record.maxTokens) &&
    Array.isArray(record.input) &&
    record.input.every((input) => input === "text" || input === "image") &&
    typeof record.reasoning === "boolean" &&
    typeof record.supportsTools === "boolean" &&
    typeof record.available === "boolean" &&
    (record.source === "bundled" || record.source === "custom")
  );
}

function validCachedLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function copyCachedModel(model: RegisteredModel): RegisteredModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    reasoning: model.reasoning,
    supportsTools: model.supportsTools,
    available: model.available,
    source: model.source,
  };
}

async function writeCacheAtomically(
  cachePath: string,
  models: readonly RegisteredModel[],
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const document: CacheDocument = { version: CACHE_VERSION, models };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await rename(temporaryPath, cachePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

function compareModels(left: RegisteredModel, right: RegisteredModel): number {
  return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
}
