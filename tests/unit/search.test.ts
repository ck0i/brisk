import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRipgrepArguments,
  createSearchTool,
  searchWorkspace,
  type SearchStreamEvent,
} from "../../src/tools/search.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("searchWorkspace", () => {
  test("builds a shell-free ripgrep argument array", () => {
    const arguments_ = buildRipgrepArguments(
      {
        pattern: "x; echo not-a-command",
        regex: false,
        globs: ["*.ts", "!*.test.ts"],
        hidden: true,
        respectIgnore: false,
        context: 2,
      },
      "src",
    );

    expect(arguments_).toContain("--fixed-strings");
    expect(arguments_).toContain("--hidden");
    expect(arguments_).toContain("--no-ignore");
    expect(arguments_).toContain("x; echo not-a-command");
    expect(arguments_.slice(-2)).toEqual(["--", "src"]);
    expect(arguments_.filter((argument) => argument === "--glob")).toHaveLength(22);
  });

  test("describes the directory-only path shape and single-file form", () => {
    const tool = createSearchTool(".");
    expect(tool.description).toContain(
      '`path` must be a directory. To search one file, pass its parent directory and use `globs: ["filename.rs"]`.',
    );
    expect(tool.inputSchema.properties?.path?.description).toBe(
      '`path` must be a directory. To search one file, pass its parent directory and use `globs: ["filename.rs"]`.',
    );
  });

  test("fallback supports regex, literal, globs, hidden files, ignores, context, and limits", async () => {
    const workspace = await createSearchWorkspace();
    const events: SearchStreamEvent[] = [];
    const literal = await searchWorkspace(
      workspace,
      { pattern: "code-[0-9]+", globs: ["*.ts"], hidden: true },
      { forceFallback: true, onOutput: (event) => void events.push(event) },
    );
    expect(literal.backend).toBe("fallback");
    expect(literal.fallbackReason).toContain("JavaScript regex semantics");
    expect(literal.matches).toHaveLength(0);
    expect(
      events.some((event) => event.stream === "stderr" && event.data.includes("fallback")),
    ).toBe(true);

    const regex = await searchWorkspace(
      workspace,
      {
        pattern: "code-[0-9]+",
        regex: true,
        globs: ["*.ts"],
        hidden: true,
        context: 1,
        limit: 1,
      },
      { forceFallback: true },
    );
    expect(regex.truncated).toBe(true);
    expect(regex.matches).toHaveLength(1);
    expect(regex.matches[0]).toMatchObject({
      path: ".hidden.ts",
      line: 1,
      column: 1,
      text: "code-7 hidden",
    });

    const visible = await searchWorkspace(
      workspace,
      { pattern: "needle", globs: ["*.ts"] },
      { forceFallback: true },
    );
    expect(visible.matches.map((match) => match.path)).toEqual(["src/visible.ts"]);
    expect(visible.matches[0]?.before).toEqual([]);
    expect(visible.matches.every((match) => !match.path.startsWith("./"))).toBe(true);
  });

  test("normalizes a regular-file path to a single-file fallback search", async () => {
    const workspace = await createSearchWorkspace();
    const selected = join(workspace, "src", "[selected].ts");
    await writeFile(selected, "needle selected\n");
    await writeFile(join(workspace, "src", "s.ts"), "needle sibling\n");

    const result = await searchWorkspace(
      workspace,
      { pattern: "needle", path: "src/[selected].ts" },
      { forceFallback: true },
    );

    expect(result.matches.map((match) => match.path)).toEqual(["src/[selected].ts"]);
  });

  test.skipIf(process.platform === "win32")(
    "returns a corrective error for a path that is neither a directory nor a regular file",
    async () => {
      const workspace = await temporaryDirectory();
      const socketPath = join(workspace, "search.sock");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      try {
        await expect(
          searchWorkspace(
            workspace,
            { pattern: "needle", path: socketPath },
            { forceFallback: true },
          ),
        ).rejects.toThrow(
          'search.path must be a directory. Did you mean path=".", globs=["search.sock"]?',
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  test("searches authored absolute path roots and returns absolute matches", async () => {
    const workspace = await createSearchWorkspace();
    const outside = await createSearchWorkspace();
    const result = await searchWorkspace(
      workspace,
      { pattern: "needle", path: outside, globs: ["*.ts"] },
      { forceFallback: true },
    );

    expect(result.matches.map((match) => match.path)).toEqual([join(outside, "src", "visible.ts")]);
  });

  test("fallback cancellation stops an active scan", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, "large.txt"), `${"match\n".repeat(5_000)}`);
    const controller = new AbortController();

    const search = searchWorkspace(
      workspace,
      { pattern: "match", limit: 10_000 },
      {
        forceFallback: true,
        signal: controller.signal,
        onOutput(event) {
          if (event.stream === "stdout")
            controller.abort(new DOMException("cancelled", "AbortError"));
        },
      },
    );
    await expect(search).rejects.toThrow("cancelled");
  });

  test.skipIf(Bun.which("rg") === null)("uses ripgrep for a real ignored-file search", async () => {
    const workspace = await createSearchWorkspace();
    const result = await searchWorkspace(workspace, { pattern: "needle", globs: ["*.ts"] });
    expect(result.backend).toBe("rg");
    expect(result.matches.map((match) => match.path)).toEqual(["src/visible.ts"]);
  });
  test.skipIf(Bun.which("rg") === null)("uses ripgrep for a regular-file path", async () => {
    const workspace = await createSearchWorkspace();
    const result = await searchWorkspace(workspace, {
      pattern: "needle",
      path: join(workspace, "src", "visible.ts"),
    });

    expect(result.backend).toBe("rg");
    expect(result.matches.map((match) => match.path)).toEqual(["src/visible.ts"]);
  });
});

async function createSearchWorkspace(): Promise<string> {
  const workspace = await temporaryDirectory();
  await mkdir(join(workspace, "src"));
  await mkdir(join(workspace, "node_modules"));
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(join(workspace, "ignored.txt"), "needle ignored\n");
  await writeFile(join(workspace, ".hidden.ts"), "code-7 hidden\n");
  await writeFile(join(workspace, "node_modules", "generated.ts"), "needle generated\n");
  await writeFile(join(workspace, "src", "visible.ts"), "before\nneedle code-42\nafter\n");
  await writeFile(join(workspace, "src", "other.js"), "needle javascript\n");
  return workspace;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "brisk-search-test-"));
  temporaryDirectories.push(path);
  return path;
}
