import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ModelRegistry,
  type CustomOpenAICompatibleModel,
  type RegisteredModel,
} from "../../src/providers/model-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const cachedModel: RegisteredModel = {
  provider: "cached-provider",
  id: "cached-model",
  name: "Cached model",
  api: "openai-completions",
  baseUrl: "https://cached.test/v1",
  contextWindow: 1000,
  maxTokens: 100,
  input: ["text"],
  reasoning: false,
  supportsTools: true,
  available: true,
  source: "custom",
};

const keylessCustom: CustomOpenAICompatibleModel = {
  provider: "local-test",
  id: "local-model",
  name: "Local model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  contextWindow: 8192,
  maxTokens: 1024,
  input: ["text", "image"],
  reasoning: true,
  supportsTools: false,
  keyless: true,
};

describe("ModelRegistry", () => {
  test("exposes validated cache before a delayed bundled/custom refresh", async () => {
    const cachePath = await makeCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        models: [{ ...cachedModel, apiKey: "BRISK_TEST_CACHE_EXTRA" }],
      }),
    );
    const gate = Promise.withResolvers<boolean>();
    const registry = await ModelRegistry.create({
      cachePath,
      auth: {
        hasAuth(provider) {
          return provider === "anthropic" ? gate.promise : false;
        },
      },
      customModels: [keylessCustom],
    });

    expect(registry.models).toEqual([cachedModel]);
    expect(JSON.stringify(registry.models)).not.toContain("BRISK_TEST_CACHE_EXTRA");
    expect(registry.select("cached-provider", "cached-model")).toEqual(cachedModel);

    gate.resolve(false);
    await registry.refreshingBundledAndCustom;

    expect(registry.select("cached-provider", "cached-model")).toBeUndefined();
    expect(registry.select("local-test", "local-model")).toMatchObject({
      available: true,
      source: "custom",
    });
  });

  test("tolerates a corrupt cache and refreshes bundled provider metadata", async () => {
    const cachePath = await makeCachePath();
    await writeFile(cachePath, "{not-json");
    const gate = Promise.withResolvers<boolean>();
    const registry = await ModelRegistry.create({
      cachePath,
      auth: {
        hasAuth(provider) {
          return provider === "anthropic" ? gate.promise : false;
        },
      },
    });

    expect(registry.models).toEqual([]);
    gate.resolve(true);
    await registry.refreshingBundledAndCustom;

    const anthropic = registry.models.filter((model) => model.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.every((model) => model.available && model.source === "bundled")).toBe(true);
    expect(registry.resolveUpstreamModel("anthropic", anthropic[0]?.id ?? "")).toBeDefined();
    const saved: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    expect(saved).toMatchObject({ version: 1 });
  });

  test("constructs an exact upstream model for a custom keyless endpoint", async () => {
    const cachePath = await makeCachePath();
    const registry = await ModelRegistry.create({
      cachePath,
      auth: { hasAuth: () => false },
      customModels: [keylessCustom],
    });
    await registry.refreshingBundledAndCustom;

    expect(registry.select("local-test", "local-model")).toEqual({
      provider: "local-test",
      id: "local-model",
      name: "Local model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindow: 8192,
      maxTokens: 1024,
      input: ["text", "image"],
      reasoning: true,
      supportsTools: false,
      available: true,
      source: "custom",
    });
    const upstream = registry.resolveUpstreamModel("local-test", "local-model");
    expect(upstream).toMatchObject({
      provider: "local-test",
      id: "local-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      reasoning: true,
      supportsTools: false,
    });
    expect(upstream?.compat).toBeDefined();
    expect(registry.lastRefreshError).toBeUndefined();
  });

  test("rejects malformed cache rows instead of partially trusting them", async () => {
    const cachePath = await makeCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({ version: 1, models: [{ ...cachedModel, available: "yes" }] }),
    );
    const gate = Promise.withResolvers<boolean>();
    const registry = await ModelRegistry.create({
      cachePath,
      auth: {
        hasAuth(provider) {
          return provider === "anthropic" ? gate.promise : false;
        },
      },
    });

    expect(registry.models).toEqual([]);
    gate.resolve(false);
    await registry.refreshingBundledAndCustom;
  });
});

async function makeCachePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brisk-model-test-"));
  temporaryDirectories.push(root);
  const cachePath = join(root, "models", "cache.json");
  await mkdir(dirname(cachePath), { recursive: true });
  return cachePath;
}
