import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runAuthCommand } from "../../src/cli/provider-commands.ts";
import { resolveConfigPaths, type ConfigPaths } from "../../src/config/paths.ts";
import { AuthService, BUILT_IN_BRISK_OAUTH_PROVIDERS } from "../../src/providers/auth-service.ts";

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

  const apiKeyLoginProviders = [
    { provider: "opencode-go", name: "OpenCode Go", origin: "https://opencode.ai/" },
    { provider: "commandcode", name: "Command Code", origin: "https://commandcode.ai/" },
  ];

  test.each(apiKeyLoginProviders)(
    "reports $name as an available login provider",
    async ({ provider, name }) => {
      const { paths, output, read } = await createHarness();

      await runAuthCommand({ name: "auth", action: "status", json: true }, paths, { output });

      const statuses: unknown = JSON.parse(read());
      if (!Array.isArray(statuses)) throw new Error("status output was not an array");
      expect(statuses).toContainEqual(
        expect.objectContaining({
          provider,
          name,
          configured: false,
          oauth: true,
          oauthAvailable: true,
        }),
      );
      expect<readonly string[]>(BUILT_IN_BRISK_OAUTH_PROVIDERS).toContain(provider);
    },
  );

  test.each(apiKeyLoginProviders)(
    "stores a pasted $name API key and logs out locally",
    async ({ provider, origin }) => {
      const { paths } = await createHarness();
      const secret = `brisk-test-${provider}-key`;
      const auth = await AuthService.initialize(paths.authPath);
      try {
        const opened: string[] = [];
        let promptMessage = "";
        await auth.login(provider, {
          openBrowser: (info) => {
            opened.push(info.url);
          },
          prompt: async (prompt) => {
            promptMessage = prompt.message;
            return secret;
          },
        });

        expect(opened).toHaveLength(1);
        expect(opened[0]).toStartWith(origin);
        expect(promptMessage).toContain("API key");
        expect(auth.hasAuth(provider)).toBe(true);
        expect(await auth.getApiKey(provider)).toBe(secret);

        await auth.logout(provider);
        expect(auth.hasAuth(provider)).toBe(false);
      } finally {
        auth.close();
      }
    },
  );
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
