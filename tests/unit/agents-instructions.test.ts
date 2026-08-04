import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgentsInstructions } from "../../src/core/agents-instructions.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AGENTS.md discovery", () => {
  test("loads user defaults before repository instructions ordered from broad to specific", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-agents-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const config = join(root, "config");
    await Promise.all([
      mkdir(join(workspace, "src", "feature"), { recursive: true }),
      mkdir(join(workspace, "docs"), { recursive: true }),
      mkdir(join(workspace, "node_modules", "dependency"), { recursive: true }),
      mkdir(join(workspace, ".git", "objects"), { recursive: true }),
      mkdir(config, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(config, "AGENTS.md"), "user defaults"),
      writeFile(join(workspace, "AGENTS.md"), "repository root"),
      writeFile(join(workspace, "src", "AGENTS.md"), "source rules"),
      writeFile(join(workspace, "src", "feature", "AGENTS.md"), "feature rules"),
      writeFile(join(workspace, "docs", "AGENTS.md"), "documentation rules"),
      writeFile(join(workspace, "node_modules", "dependency", "AGENTS.md"), "dependency rules"),
      writeFile(join(workspace, ".git", "AGENTS.md"), "git internals"),
    ]);

    const prompts = await discoverAgentsInstructions({
      workspace,
      userAgentsPath: join(config, "AGENTS.md"),
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("User-level AGENTS.md instructions");
    expect(prompts[0]).toContain("user defaults");
    const repository = prompts[1] ?? "";
    expect(repository).toContain(
      "Repository instructions take precedence over user-level AGENTS.md instructions",
    );
    expect(repository).toContain('{"path":"AGENTS.md","scope":"entire workspace"}');
    expect(repository).toContain('{"path":"src/AGENTS.md","scope":"src/**"}');
    expect(repository).toContain('{"path":"src/feature/AGENTS.md","scope":"src/feature/**"}');
    expect(repository.indexOf("repository root")).toBeLessThan(repository.indexOf("source rules"));
    expect(repository.indexOf("source rules")).toBeLessThan(repository.indexOf("feature rules"));
    expect(repository).not.toContain("dependency rules");
    expect(repository).not.toContain("git internals");
  });

  test("skips repository subtrees that Windows refuses to scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-agents-denied-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const readable = join(workspace, "readable");
    const denied = join(workspace, "denied");
    await Promise.all([mkdir(readable, { recursive: true }), mkdir(denied, { recursive: true })]);
    await Promise.all([
      writeFile(join(workspace, "AGENTS.md"), "repository root"),
      writeFile(join(readable, "AGENTS.md"), "readable rules"),
    ]);

    const prompts = await discoverAgentsInstructions({
      workspace,
      userAgentsPath: join(root, "missing", "AGENTS.md"),
      io: {
        async readDirectory(path) {
          if (path === denied) throw filesystemError("EPERM", `Cannot scandir ${path}`);
          return await readdir(path, { withFileTypes: true });
        },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("repository root");
    expect(prompts[0]).toContain("readable rules");
  });

  test("does not hide unexpected repository scan failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-agents-io-error-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(
      discoverAgentsInstructions({
        workspace,
        userAgentsPath: join(root, "missing", "AGENTS.md"),
        io: {
          async readDirectory() {
            throw filesystemError("EIO", "repository storage failed");
          },
        },
      }),
    ).rejects.toThrow("repository storage failed");
  });

  test("returns no additional system blocks when no instruction files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-agents-empty-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    expect(
      await discoverAgentsInstructions({
        workspace,
        userAgentsPath: join(root, "missing", "AGENTS.md"),
      }),
    ).toEqual([]);
  });
});

function filesystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
