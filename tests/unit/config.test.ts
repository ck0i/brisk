import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigLoadError,
  ConfigManager,
  loadConfig,
  parseConfigText,
  projectConfigPath,
  resolveConfigPaths,
  type ConfigPaths,
} from "../../src/config/index.ts";

interface TestLayout {
  readonly root: string;
  readonly workspace: string;
  readonly paths: ConfigPaths;
}

describe("configuration", () => {
  test("parses JSONC and applies strict defaults", () => {
    const result = parseConfigText(
      `{
        // comments and trailing commas are supported
        "permissionMode": "safe",
        "ui": { "theme": "dark", },
      }`,
      "/config/global.jsonc",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual({ permissionMode: "safe", ui: { theme: "dark" } });
  });

  test("reports syntax and schema errors with source and exact JSON paths", () => {
    const syntax = parseConfigText(
      `{
        "compaction": { "thresholdPercent": , }
      }`,
      "/config/broken.jsonc",
    );
    expect(syntax.diagnostics[0]).toMatchObject({
      severity: "error",
      source: "/config/broken.jsonc",
      path: "$.compaction.thresholdPercent",
    });

    const schema = parseConfigText(
      `{ "providers": { "local-server": { "baseUrl": 42 } } }`,
      "/config/schema.jsonc",
    );
    expect(schema.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        source: "/config/schema.jsonc",
        path: '$.providers["local-server"].baseUrl',
      }),
    );
  });

  test("warns on and ignores unknown fields at every modeled level", () => {
    const result = parseConfigText(
      `{
        "futureTopLevel": true,
        "ui": { "showThinking": true, "futureUi": 1 },
        "providers": {
          "local": {
            "futureProvider": "ignored",
            "models": [{
              "id": "model",
              "contextWindow": 8192,
              "maxOutputTokens": 1024,
              "input": ["text"],
              "toolCalling": true,
              "futureModel": false
            }]
          }
        }
      }`,
      "/config/unknown.jsonc",
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "$.futureTopLevel",
      "$.ui.futureUi",
      "$.providers.local.futureProvider",
      "$.providers.local.models[0].futureModel",
    ]);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBeTrue();
    expect(result.value).toEqual({
      ui: { showThinking: true },
      providers: {
        local: {
          models: [
            {
              id: "model",
              contextWindow: 8192,
              maxOutputTokens: 1024,
              input: ["text"],
              toolCalling: true,
            },
          ],
        },
      },
    });
  });

  test("merges defaults, global, project, CLI, and runtime with arrays replacing", async () => {
    const layout = await createLayout();
    try {
      await writeGlobal(
        layout,
        `{
          "permissionMode": "safe",
          "maxSubagents": 4,
          "compaction": { "enabled": false, "thresholdPercent": 70 },
          "ui": { "theme": "global" },
          "providers": {
            "local": {
              "type": "openai-compatible",
              "baseUrl": "http://127.0.0.1:8080/v1",
              "keyless": true,
              "models": [{
                "id": "global-model",
                "contextWindow": 8192,
                "maxOutputTokens": 1024,
                "input": ["text"],
                "toolCalling": false
              }]
            }
          }
        }`,
      );
      await writeProject(
        layout,
        `{
          "maxSubagents": 5,
          "compaction": { "thresholdPercent": 75 },
          "ui": { "showThinking": true },
          "providers": {
            "local": {
              "models": [{
                "id": "project-model",
                "name": "Project model",
                "contextWindow": 32768,
                "maxOutputTokens": 4096,
                "input": ["text", "image"],
                "toolCalling": true
              }]
            }
          }
        }`,
      );

      const loaded = await loadConfig({
        paths: layout.paths,
        workspace: layout.workspace,
        cliOverrides: {
          maxSubagents: 6,
          compaction: { keepRecentTokens: 12_000 },
          ui: { theme: "cli" },
        },
        runtimeOverrides: {
          permissionMode: "yolo",
          maxSubagents: 7,
          ui: { theme: "runtime" },
        },
      });

      expect(loaded.config).toMatchObject({
        permissionMode: "yolo",
        maxSubagents: 7,
        maxSubagentDepth: 1,
        compaction: {
          enabled: false,
          thresholdPercent: 75,
          keepRecentTokens: 12_000,
        },
        ui: { theme: "runtime", showThinking: true },
      });
      expect(loaded.config.providers.local?.baseUrl).toBe("http://127.0.0.1:8080/v1");
      expect(loaded.config.providers.local?.models.map((model) => model.id)).toEqual([
        "project-model",
      ]);
    } finally {
      await destroyLayout(layout);
    }
  });

  test("accepts a keyless local OpenAI-compatible endpoint", async () => {
    const layout = await createLayout();
    try {
      await writeGlobal(
        layout,
        `{
          "providers": {
            "llama": {
              "type": "openai-compatible",
              "baseUrl": "http://localhost:8080/v1",
              "keyless": true,
              "api": "openai-completions",
              "models": [{
                "id": "local-model",
                "name": "Local model",
                "contextWindow": 131072,
                "maxOutputTokens": 16384,
                "input": ["text"],
                "toolCalling": true
              }]
            }
          }
        }`,
      );

      const loaded = await loadConfig({ paths: layout.paths });
      expect(loaded.config.providers.llama).toMatchObject({
        keyless: true,
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      });
    } finally {
      await destroyLayout(layout);
    }
  });

  test("rejects inline provider secrets at their exact path", async () => {
    const layout = await createLayout();
    try {
      await writeGlobal(
        layout,
        `{
          "providers": {
            "private": {
              "type": "openai-compatible",
              "baseUrl": "https://example.test/v1",
              "apiKey": "must-not-be-loaded",
              "models": []
            }
          }
        }`,
      );

      const error = await captureConfigError(loadConfig({ paths: layout.paths }));
      expect(error.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "error",
          source: layout.paths.globalConfigPath,
          path: "$.providers.private.apiKey",
          message: expect.stringContaining("Inline secrets"),
        }),
      );
    } finally {
      await destroyLayout(layout);
    }
  });

  test("ConfigManager retains the last valid value after a failed reload", async () => {
    const layout = await createLayout();
    try {
      await writeGlobal(layout, `{ "maxSubagents": 8 }`);
      const manager = await ConfigManager.create({ paths: layout.paths });
      const previous = manager.current;
      let notifications = 0;
      manager.subscribe(() => {
        notifications += 1;
      });

      await writeGlobal(layout, `{ "maxSubagents": "invalid" }`);
      await expect(manager.reload()).rejects.toBeInstanceOf(ConfigLoadError);

      expect(manager.current).toBe(previous);
      expect(manager.current.maxSubagents).toBe(8);
      expect(notifications).toBe(0);
    } finally {
      await destroyLayout(layout);
    }
  });
});

async function createLayout(): Promise<TestLayout> {
  const root = await mkdtemp(join(tmpdir(), "brisk-config-"));
  const workspace = join(root, "workspace");
  const paths = resolveConfigPaths({
    platform: "linux",
    homeDir: root,
    env: {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
  });
  await mkdir(workspace, { recursive: true });
  return { root, workspace, paths };
}

async function writeGlobal(layout: TestLayout, contents: string): Promise<void> {
  await mkdir(layout.paths.configRoot, { recursive: true });
  await Bun.write(layout.paths.globalConfigPath, contents);
}

async function writeProject(layout: TestLayout, contents: string): Promise<void> {
  const path = projectConfigPath(layout.workspace);
  await mkdir(join(layout.workspace, ".brisk"), { recursive: true });
  await Bun.write(path, contents);
}

async function destroyLayout(layout: TestLayout): Promise<void> {
  await rm(layout.root, { recursive: true, force: true });
}

async function captureConfigError(promise: Promise<unknown>): Promise<ConfigLoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigLoadError) return error;
    throw error;
  }
  throw new Error("Expected configuration loading to fail");
}
