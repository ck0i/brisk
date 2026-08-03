import { loadConfig, type LoadedConfig, type LoadConfigOptions } from "./load.ts";
import { configSchema, DEFAULT_CONFIG, type BriskConfig, type ConfigOverrides } from "./schema.ts";

export type ConfigSubscriber = (
  config: BriskConfig,
  diagnostics: LoadedConfig["diagnostics"],
) => void;

export class ConfigManager {
  readonly #options: Omit<LoadConfigOptions, "runtimeOverrides">;
  readonly #subscribers = new Set<ConfigSubscriber>();
  #runtimeOverrides: ConfigOverrides | undefined;
  #current: BriskConfig = configSchema.parse(DEFAULT_CONFIG);
  #diagnostics: LoadedConfig["diagnostics"] = [];

  constructor(options: Omit<LoadConfigOptions, "runtimeOverrides">) {
    this.#options = options;
  }

  static async create(
    options: Omit<LoadConfigOptions, "runtimeOverrides">,
  ): Promise<ConfigManager> {
    const manager = new ConfigManager(options);
    await manager.reload();
    return manager;
  }

  get current(): BriskConfig {
    return this.#current;
  }

  get diagnostics(): LoadedConfig["diagnostics"] {
    return this.#diagnostics;
  }

  subscribe(subscriber: ConfigSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async setRuntimeOverrides(overrides: ConfigOverrides | undefined): Promise<LoadedConfig> {
    const previous = this.#runtimeOverrides;
    this.#runtimeOverrides = overrides;
    try {
      return await this.reload();
    } catch (error) {
      this.#runtimeOverrides = previous;
      throw error;
    }
  }

  async reload(): Promise<LoadedConfig> {
    const loaded = await loadConfig({
      ...this.#options,
      ...(this.#runtimeOverrides === undefined ? {} : { runtimeOverrides: this.#runtimeOverrides }),
    });
    this.#current = loaded.config;
    this.#diagnostics = loaded.diagnostics;
    for (const subscriber of this.#subscribers) {
      subscriber(this.#current, this.#diagnostics);
    }
    return loaded;
  }
}
