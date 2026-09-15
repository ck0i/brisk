import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runAuthCommand } from "../../src/cli/provider-commands.ts";
import { resolveConfigPaths, type ConfigPaths } from "../../src/config/paths.ts";
import { AuthService } from "../../src/providers/auth-service.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("provider CLI commands", () => {
  test("reports sanitized authentication status from a fresh real AuthStorage", async () => {
    const { paths, output, read } = await createHarness();

    await runAuthCommand({ name: "auth", action: "status", json: true }, paths, { output });

    const statuses: unknown = JSON.parse(read());
    expect(Array.isArray(statuses)).toBe(true);
    if (!Array.isArray(statuses)) throw new Error("status output was not an array");
    expect(statuses).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        configured: false,
        oauth: true,
        oauthAvailable: true,
      }),
    );
    expect(read()).not.toContain("access");
    expect(read()).not.toContain("refresh");
  });

  test("reports OpenCode Go as an available login provider", async () => {
    const { paths, output, read } = await createHarness();

    await runAuthCommand({ name: "auth", action: "status", json: true }, paths, { output });

    const statuses: unknown = JSON.parse(read());
    if (!Array.isArray(statuses)) throw new Error("status output was not an array");
    expect(statuses).toContainEqual(
      expect.objectContaining({
        provider: "opencode-go",
        name: "OpenCode Go",
        configured: false,
        oauth: true,
        oauthAvailable: true,
      }),
    );
  });

  test("stores a pasted OpenCode Go API key and logs out locally", async () => {
    const { paths } = await createHarness();
    const secret = "brisk-test-opencode-go-key";
    const auth = await AuthService.initialize(paths.authPath);
    try {
      const opened: string[] = [];
      let promptMessage = "";
      await auth.login("opencode-go", {
        openBrowser: (info) => {
          opened.push(info.url);
        },
        prompt: async (prompt) => {
          promptMessage = prompt.message;
          return secret;
        },
      });

      expect(opened).toHaveLength(1);
      expect(opened[0]).toStartWith("https://opencode.ai/");
      expect(promptMessage).toContain("API key");
      expect(auth.hasAuth("opencode-go")).toBe(true);
      expect(await auth.getApiKey("opencode-go")).toBe(secret);

      await auth.logout("opencode-go");
      expect(auth.hasAuth("opencode-go")).toBe(false);
    } finally {
      auth.close();
    }
  });
});

async function createHarness(): Promise<{
  readonly paths: ConfigPaths;
  readonly output: Writable;
  readonly read: () => string;
}> {
  const root = await mkdtemp(join(tmpdir(), "brisk-auth-command-"));
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
  let text = "";
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { paths, output, read: () => text };
}
