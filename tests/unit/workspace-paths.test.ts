import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { WorkspacePaths } from "../../src/tools/workspace-paths.ts";

describe("WorkspacePaths", () => {
  test("canonicalizes the workspace and returns stable relative display paths", async () => {
    await withDirectories(async ({ workspace }) => {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "file.ts"), "text");
      const paths = new WorkspacePaths(workspace);

      expect(paths.root).toBe(await realpath(workspace));
      expect(paths.resolveRead("src/../src/file.ts")).toMatchObject({
        canonicalPath: path.join(await realpath(workspace), "src", "file.ts"),
        displayPath: "src/file.ts",
        insideWorkspace: true,
      });
      expect(paths.resolveWrite(path.join(workspace, "new", "file.ts")).displayPath).toBe(
        "new/file.ts",
      );
    });
  });

  test("rejects lexical and symlink escapes for writes", async () => {
    await withDirectories(async ({ workspace, outside }) => {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(workspace, "escape"));
      const paths = new WorkspacePaths(workspace);

      expect(() => paths.resolveWrite("../outside/secret.txt")).toThrow("escapes the workspace");
      expect(() => paths.resolveWrite("escape/secret.txt")).toThrow("through a symlink");
      expect(() => paths.resolveWrite(".", { operation: "delete" })).toThrow(
        "delete the workspace root",
      );
    });
  });

  test("allows authored absolute read and write paths outside the workspace", async () => {
    await withDirectories(async ({ workspace, outside }) => {
      const target = path.join(outside, "outside.txt");
      const created = path.join(outside, "created.txt");
      await writeFile(target, "outside");
      const paths = new WorkspacePaths(workspace);

      expect(paths.resolveRead(target)).toMatchObject({
        canonicalPath: await realpath(target),
        displayPath: await realpath(target),
        insideWorkspace: false,
      });
      expect(paths.resolveWrite(created)).toMatchObject({
        canonicalPath: created,
        displayPath: created,
        insideWorkspace: false,
      });
    });
  });
});

async function withDirectories(
  run: (directories: { workspace: string; outside: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "brisk-paths-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    await run({ workspace, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
