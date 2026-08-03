import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureUserPath,
  globalBinForPackageInstall,
  pathContains,
  posixProfiles,
  type PackageInstallContext,
} from "../../scripts/install-path.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("PATH installer", () => {
  test("detects Bun and npm global installs without treating local installs as global", () => {
    expect(
      globalBinForPackageInstall({
        platform: "linux",
        cwd: "/home/user/.bun/install/global/node_modules/brisk-ai",
        home: "/home/user",
        env: {},
      }),
    ).toBe("/home/user/.bun/bin");

    expect(
      globalBinForPackageInstall({
        platform: "win32",
        cwd: String.raw`C:\Users\user\AppData\Roaming\npm\node_modules\brisk-ai`,
        home: String.raw`C:\Users\user`,
        env: {
          npm_config_global: "true",
          npm_config_prefix: String.raw`C:\Users\user\AppData\Roaming\npm`,
          npm_config_user_agent: "npm/11.0.0 node/v24 win32 x64",
        },
      }),
    ).toBe(String.raw`C:\Users\user\AppData\Roaming\npm`);

    expect(
      globalBinForPackageInstall({
        platform: "linux",
        cwd: "/work/project/node_modules/brisk-ai",
        home: "/home/user",
        env: { npm_config_prefix: "/usr/local" },
      }),
    ).toBeUndefined();
  });

  test("updates Bash startup files once and preserves existing content", async () => {
    const home = await temporaryHome();
    await writeFile(join(home, ".profile"), "export EDITOR=vim\n", "utf8");
    const context = linuxContext(home, { SHELL: "/bin/bash", PATH: "/usr/local/bin:/usr/bin" });
    const binDirectory = join(home, ".bun", "bin");

    const first = await ensureUserPath(binDirectory, context);
    const second = await ensureUserPath(binDirectory, context);
    const profile = await readFile(join(home, ".profile"), "utf8");
    const bashrc = await readFile(join(home, ".bashrc"), "utf8");

    expect(first.status).toBe("updated");
    expect(second.status).toBe("unchanged");
    expect(profile).toStartWith("export EDITOR=vim\n");
    expect(profile.match(/# >>> brisk PATH >>>/g)).toHaveLength(1);
    expect(profile).toContain(`export PATH='${binDirectory}':"\${PATH}"`);
    expect(bashrc.match(/# >>> brisk PATH >>>/g)).toHaveLength(1);
  });

  test("selects native zsh and fish startup locations", async () => {
    const home = "/home/user";
    expect(posixProfiles("darwin", home, { SHELL: "/bin/zsh" }).map((entry) => entry.path)).toEqual(
      ["/home/user/.zprofile", "/home/user/.zshrc"],
    );
    expect(
      posixProfiles("linux", home, {
        SHELL: "/usr/bin/fish",
        XDG_CONFIG_HOME: "/home/user/config",
      }).map((entry) => entry.path),
    ).toEqual(["/home/user/config/fish/conf.d/brisk-path.fish"]);
  });

  test("uses the Windows user PATH writer and compares entries case-insensitively", async () => {
    const context: PackageInstallContext = {
      platform: "win32",
      cwd: String.raw`C:\package`,
      home: String.raw`C:\Users\user`,
      env: {},
    };
    const calls: string[] = [];
    const result = await ensureUserPath(
      String.raw`C:\Users\user\.bun\bin`,
      context,
      async (target) => {
        calls.push(target);
        return "updated";
      },
    );

    expect(result.status).toBe("updated");
    expect(result.locations).toEqual(["Windows user PATH"]);
    expect(calls).toEqual([String.raw`C:\Users\user\.bun\bin`]);
    expect(
      pathContains(
        "C:\\Windows;C:\\USERS\\USER\\.BUN\\BIN\\",
        String.raw`c:\users\user\.bun\bin`,
        "win32",
      ),
    ).toBeTrue();
  });
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brisk-install-path-"));
  temporaryRoots.push(root);
  return root;
}

function linuxContext(home: string, env: Readonly<NodeJS.ProcessEnv>): PackageInstallContext {
  return {
    platform: "linux",
    cwd: join(home, ".bun", "install", "global", "node_modules", "brisk-ai"),
    home,
    env,
  };
}
