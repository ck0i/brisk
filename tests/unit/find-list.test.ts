import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFiles } from "../../src/tools/find.ts";
import { listFiles } from "../../src/tools/list.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("findFiles", () => {
  test("matches patterns with stable paths and default ignores", async () => {
    const workspace = await createWorkspace();
    const result = await findFiles(workspace, { patterns: ["**/*.ts", "*.txt"] });
    expect(result).toEqual({
      paths: ["root.txt", "src/a.ts", "src/nested/b.ts"],
      truncated: false,
    });

    const hidden = await findFiles(workspace, { patterns: "*.ts", hidden: true });
    expect(hidden.paths).toContain(".secret.ts");
    expect(hidden.paths).not.toContain("ignored.ts");
    expect(hidden.paths.every((path) => !path.startsWith("./"))).toBe(true);
  });

  test("sorts before applying limits", async () => {
    const workspace = await createWorkspace();
    const result = await findFiles(workspace, {
      patterns: "**/*.ts",
      hidden: true,
      respectIgnore: false,
      limit: 2,
    });
    expect(result.paths).toEqual([".secret.ts", "ignored.ts"]);
    expect(result.truncated).toBe(true);
  });
});

describe("listFiles", () => {
  test("is shallow by default and expands only to requested depth", async () => {
    const workspace = await createWorkspace();
    const shallow = await listFiles(workspace);
    expect(shallow.entries).toEqual([
      { path: "root.txt", type: "file" },
      { path: "src", type: "directory" },
    ]);

    const deep = await listFiles(workspace, { depth: 2 });
    expect(deep.entries.map((entry) => entry.path)).toEqual([
      "root.txt",
      "src",
      "src/a.ts",
      "src/nested",
    ]);
    expect(deep.entries.some((entry) => entry.path === "src/nested/b.ts")).toBe(false);
  });

  test("supports hidden entries and stable limits", async () => {
    const workspace = await createWorkspace();
    const result = await listFiles(workspace, {
      hidden: true,
      respectIgnore: false,
      limit: 2,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([".gitignore", ".secret.ts"]);
    expect(result.truncated).toBe(true);
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = await temporaryDirectory();
  await mkdir(join(workspace, "src", "nested"), { recursive: true });
  await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(workspace, "dist"));
  await writeFile(join(workspace, ".gitignore"), "ignored.ts\n");
  await writeFile(join(workspace, ".secret.ts"), "secret\n");
  await writeFile(join(workspace, "ignored.ts"), "ignored\n");
  await writeFile(join(workspace, "root.txt"), "root\n");
  await writeFile(join(workspace, "src", "a.ts"), "a\n");
  await writeFile(join(workspace, "src", "nested", "b.ts"), "b\n");
  await writeFile(join(workspace, "node_modules", "pkg", "index.ts"), "generated\n");
  await writeFile(join(workspace, "dist", "bundle.js"), "generated\n");
  return workspace;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-find-list-test-"));
  temporaryDirectories.push(path);
  return path;
}
