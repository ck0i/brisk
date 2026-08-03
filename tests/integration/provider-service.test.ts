import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveConfigPaths } from "../../src/config/paths.ts";
import { configSchema } from "../../src/config/schema.ts";
import {
  ConfigCredentialResolver,
  ProviderService,
  customModelsFromConfig,
  splitModelSpecifier,
} from "../../src/providers/provider-service.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("ConfigCredentialResolver", () => {
  test("supports keyless and named-environment custom endpoints without exposing config secrets", async () => {
    const calls: string[] = [];
    const upstream = {
      async getApiKey(provider: string): Promise<string | undefined> {
        calls.push(`key:${provider}`);
        return "upstream-sentinel";
      },
      hasAuth(provider: string): boolean {
        calls.push(`auth:${provider}`);
        return provider === "anthropic";
      },
    };
    const providers = configSchema.parse({
      providers: {
        local: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000/v1",
          keyless: true,
          models: [modelFixture("local-model")],
        },
        gateway: {
          type: "openai-compatible",
          baseUrl: "https://gateway.invalid/v1",
          apiKeyEnv: "BRISK_TEST_GATEWAY_KEY",
          models: [modelFixture("gateway-model")],
        },
      },
    }).providers;
    const resolver = new ConfigCredentialResolver(upstream, providers, {
      BRISK_TEST_GATEWAY_KEY: "test-sentinel",
    });

    expect(await resolver.hasAuth("local")).toBe(true);
    expect(await resolver.getApiKey("local")).toBeUndefined();
    expect(await resolver.hasAuth("gateway")).toBe(true);
    expect(await resolver.getApiKey("gateway")).toBe("test-sentinel");
    expect(await resolver.hasAuth("anthropic")).toBe(true);
    expect(await resolver.getApiKey("anthropic")).toBe("upstream-sentinel");
    expect(calls).toEqual(["auth:anthropic", "key:anthropic"]);
  });
});

describe("ProviderService", () => {
  test("selects a configured keyless model and reuses one pi-ai transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-provider-service-"));
    temporaryDirectories.push(root);
    const paths = resolveConfigPaths({
      platform: "linux",
      homeDir: root,
      env: {
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
    });
    const config = configSchema.parse({
      defaultModel: "local/local-model",
      providers: {
        local: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000/v1",
          keyless: true,
          api: "openai-completions",
          models: [modelFixture("local-model")],
        },
      },
    });

    const service = await ProviderService.initialize({ paths, config, sessionId: "test-session" });
    try {
      const selected = await service.selectInitial();
      expect(selected?.record).toMatchObject({
        provider: "local",
        id: "local-model",
        available: true,
        source: "custom",
        contextWindow: 131_072,
        maxTokens: 16_384,
      });
      const transport = service.provider;
      if (!transport) throw new Error("provider transport was not initialized");
      expect(transport.model.provider).toBe("local");
      expect(service.select("local", "local-model").upstream).toBe(transport.model);
      expect(service.provider).toBe(transport);
      expect(await service.credentials.getApiKey("local")).toBeUndefined();
    } finally {
      service.close();
    }
  });

  test("converts config models and preserves ids containing slashes", () => {
    const providers = configSchema.parse({
      providers: {
        gateway: {
          type: "openai-compatible",
          baseUrl: "https://gateway.invalid/v1",
          keyless: true,
          models: [modelFixture("namespace/model")],
        },
      },
    }).providers;
    expect(customModelsFromConfig(providers)).toEqual([
      {
        provider: "gateway",
        id: "namespace/model",
        baseUrl: "https://gateway.invalid/v1",
        contextWindow: 131_072,
        maxTokens: 16_384,
        input: ["text"],
        supportsTools: true,
        keyless: true,
      },
    ]);
    expect(splitModelSpecifier("gateway/namespace/model")).toEqual({
      provider: "gateway",
      id: "namespace/model",
    });
    expect(splitModelSpecifier("invalid")).toBeUndefined();
  });
});

function modelFixture(id: string) {
  return {
    id,
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    input: ["text"] as const,
    toolCalling: true,
  };
}
