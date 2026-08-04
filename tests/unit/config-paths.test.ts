import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensurePrivateDirectory,
  projectConfigPath,
  resolveConfigPaths,
} from "../../src/config/paths.ts";

describe("configuration paths", () => {
  test("uses Linux XDG paths and fallbacks", () => {
    const paths = resolveConfigPaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: {
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_CACHE_HOME: "/xdg/cache",
      },
    });

    expect(paths).toEqual({
      platform: "linux",
      configRoot: "/xdg/config/brisk",
      dataRoot: "/xdg/data/brisk",
      cacheRoot: "/xdg/cache/brisk",
      globalConfigPath: "/xdg/config/brisk/config.jsonc",
      userAgentsPath: "/xdg/config/brisk/AGENTS.md",
      sessionsDir: "/xdg/data/brisk/sessions",
      artifactsDir: "/xdg/data/brisk/artifacts",
      authPath: "/xdg/data/brisk/auth.db",
      modelCachePath: "/xdg/cache/brisk/models.json",
      sessionIndexPath: "/xdg/data/brisk/session-index.json",
      extensionsDir: "/xdg/config/brisk/extensions",
    });

    const fallbacks = resolveConfigPaths({
      platform: "linux",
      homeDir: "/home/tester",
      env: { XDG_CONFIG_HOME: "", XDG_DATA_HOME: "relative", XDG_CACHE_HOME: "" },
    });
    expect(fallbacks.configRoot).toBe("/home/tester/.config/brisk");
    expect(fallbacks.dataRoot).toBe("/home/tester/.local/share/brisk");
    expect(fallbacks.cacheRoot).toBe("/home/tester/.cache/brisk");
  });

  test("uses macOS Application Support and Caches", () => {
    const paths = resolveConfigPaths({ platform: "darwin", homeDir: "/Users/tester", env: {} });

    expect(paths.configRoot).toBe("/Users/tester/Library/Application Support/Brisk");
    expect(paths.dataRoot).toBe("/Users/tester/Library/Application Support/Brisk");
    expect(paths.cacheRoot).toBe("/Users/tester/Library/Caches/Brisk");
    expect(paths.globalConfigPath).toBe(
      "/Users/tester/Library/Application Support/Brisk/config.jsonc",
    );
    expect(paths.userAgentsPath).toBe("/Users/tester/Library/Application Support/Brisk/AGENTS.md");
  });

  test("uses Windows APPDATA and LOCALAPPDATA with win32 separators", () => {
    const paths = resolveConfigPaths({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        APPDATA: "R:\\Roaming",
        LOCALAPPDATA: "L:\\Local",
      },
    });

    expect(paths.configRoot).toBe("R:\\Roaming\\Brisk");
    expect(paths.dataRoot).toBe("R:\\Roaming\\Brisk");
    expect(paths.cacheRoot).toBe("L:\\Local\\Brisk\\Cache");
    expect(paths.modelCachePath).toBe("L:\\Local\\Brisk\\Cache\\models.json");
    expect(paths.userAgentsPath).toBe("R:\\Roaming\\Brisk\\AGENTS.md");
  });

  test("locates the workspace overlay", () => {
    expect(projectConfigPath(join("workspace", "repo"), "linux")).toBe(
      join("workspace", "repo", ".brisk", "config.jsonc"),
    );
    expect(projectConfigPath("C:\\workspace", "win32")).toBe("C:\\workspace\\.brisk\\config.jsonc");
  });

  test("creates private directories with mode 0700", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-config-paths-"));
    const directory = join(root, "nested", "private");
    try {
      await mkdir(root, { recursive: true });
      await ensurePrivateDirectory(directory, "linux");
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
