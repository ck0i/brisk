import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runAuthCommand } from "../../src/cli/provider-commands.ts";
import { resolveConfigPaths } from "../../src/config/paths.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("provider CLI commands", () => {
  test("reports sanitized authentication status from a fresh real AuthStorage", async () => {
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

    await runAuthCommand({ name: "auth", action: "status", json: true }, paths, { output });

    const statuses: unknown = JSON.parse(text);
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
    expect(text).not.toContain("access");
    expect(text).not.toContain("refresh");
  });
});
