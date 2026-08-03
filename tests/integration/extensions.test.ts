import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { ExtensionManager } from "../../src/extensions/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

describe("ExtensionManager", () => {
  test("discovers real TypeScript and JavaScript entries and exposes registered contributions", async () => {
    await withExtensionDirectories(async ({ root, global, project }) => {
      await writeExtension(
        global,
        "a.ts",
        `
let sessionStarts = 0;
export default (context) => {
  context.registerTool({
    name: "extension_echo",
    description: "echo a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    readOnly: true,
    parallelSafe: true,
    execute(input) { return { content: input.value }; },
  });
  context.registerSlashCommand({
    name: "echo",
    description: "echo arguments",
    execute(invocation) { return invocation.arguments; },
  });
  context.registerSlashCommand({
    name: "session-count",
    description: "show session starts",
    execute() { return String(sessionStarts); },
  });
  context.registerKeybinding({
    key: "ctrl+x",
    description: "extension key",
    execute() { return "key handled"; },
  });
  context.contributeUi({ id: "activity", slot: "status", text: "ready", priority: 5 });
  context.onLifecycle("session-start", () => { sessionStarts += 1; });
};
`,
      );
      await writeExtension(
        global,
        "b.mjs",
        `export default (context) => context.contributeUi({ id: "banner", slot: "header", text: "Brisk" });`,
      );
      await writeExtension(global, "ignored.txt", "not an extension");
      await mkdir(join(global, "nested"));
      await writeExtension(
        join(global, "nested"),
        "not-discovered.ts",
        `throw new Error("direct children only");`,
      );
      await writeExtension(
        project,
        "c.js",
        `export default (context) => context.registerSlashCommand({ name: "project", description: "project command", execute() { return context.extension.source; } });`,
      );

      const approvals: string[] = [];
      const manager = new ExtensionManager({
        globalDirectories: [global],
        projectDirectories: [project],
        approveProjectExtension(extension) {
          approvals.push(basename(extension.path));
          return true;
        },
      });

      const summary = await manager.load();
      expect(summary).toEqual({ discovered: 3, loaded: 3, denied: 0, failed: 0 });
      expect(manager.extensions.map((record) => basename(record.extension.path))).toEqual([
        "a.ts",
        "b.mjs",
        "c.js",
      ]);
      expect(manager.extensions.map((record) => record.extension.source)).toEqual([
        "global",
        "global",
        "project",
      ]);
      expect(approvals).toEqual(["c.js"]);
      expect(manager.slashCommands.map((command) => command.name)).toEqual([
        "echo",
        "session-count",
        "project",
      ]);
      expect(manager.keybindings.map((binding) => binding.key)).toEqual(["ctrl+x"]);
      expect(manager.uiContributions.map((contribution) => contribution.id)).toEqual([
        "activity",
        "banner",
      ]);
      expect(manager.uiContributions[0]?.extension.source).toBe("global");

      expect(await manager.invokeSlashCommand("/echo", "hello")).toEqual({
        found: true,
        ok: true,
        output: "hello",
      });
      expect(await manager.invokeSlashCommand("project", "")).toEqual({
        found: true,
        ok: true,
        output: "project",
      });
      expect(await manager.invokeKeybinding("ctrl+x")).toEqual({
        found: true,
        ok: true,
        output: "key handled",
      });

      expect(await manager.emitLifecycle("session-start", { sessionId: "session-1" })).toEqual({
        invoked: 1,
        failed: 0,
      });
      expect((await manager.invokeSlashCommand("session-count", "")).output).toBe("1");

      const registry = new ToolRegistry();
      const extensionTool = manager.tools[0];
      expect(extensionTool?.extension.path).toBe(join(global, "a.ts"));
      if (!extensionTool) throw new Error("missing extension tool");
      registry.register(extensionTool.definition);
      const [toolResult] = await registry.execute(
        [{ id: "echo-1", name: "extension_echo", arguments: '{"value":"tool output"}' }],
        new AbortController().signal,
      );
      expect(toolResult?.content).toBe("tool output");
      expect(manager.diagnostics).toEqual([]);

      await manager.dispose();
      expect((await manager.invokeSlashCommand("echo", "after dispose")).found).toBe(false);
      expect(manager.extensions.every((record) => record.state === "disposed")).toBe(true);
      expect(root.length).toBeGreaterThan(0);
    });
  });

  test("requires first-use project approval, caches decisions, and never imports denied entries", async () => {
    await withExtensionDirectories(async ({ global, project, root }) => {
      const deniedMarker = join(root, "denied-imported");
      await writeExtension(
        global,
        "global.ts",
        `export default (context) => context.registerSlashCommand({ name: "global", description: "global", execute() { return "ok"; } });`,
      );
      await writeExtension(
        project,
        "allowed.ts",
        `export default (context) => context.registerSlashCommand({ name: "allowed", description: "allowed", execute() { return "yes"; } });`,
      );
      await writeExtension(
        project,
        "denied.ts",
        `await Bun.write(${JSON.stringify(deniedMarker)}, "imported"); export default () => {};`,
      );

      const approvals: string[] = [];
      const manager = new ExtensionManager({
        globalDirectories: [global],
        projectDirectories: [project],
        async approveProjectExtension(extension, signal) {
          expect(signal.aborted).toBe(false);
          const name = basename(extension.path);
          approvals.push(name);
          return name === "allowed.ts";
        },
      });

      expect(await manager.load()).toEqual({ discovered: 3, loaded: 2, denied: 1, failed: 0 });
      expect(approvals).toEqual(["allowed.ts", "denied.ts"]);
      expect(await pathExists(deniedMarker)).toBe(false);
      expect((await manager.invokeSlashCommand("allowed", "")).ok).toBe(true);
      expect(
        manager.diagnostics.some((diagnostic) => diagnostic.code === "project-extension-denied"),
      ).toBe(true);

      await manager.reload();
      expect(approvals).toEqual(["allowed.ts", "denied.ts"]);
      expect(await pathExists(deniedMarker)).toBe(false);
      expect(
        manager.extensions.find((record) => basename(record.extension.path) === "denied.ts")?.state,
      ).toBe("denied");
      await manager.dispose();
    });
  });

  test("reload aborts and disposes the old generation, removes listeners, and busts import cache", async () => {
    await withExtensionDirectories(async ({ global, root }) => {
      const marker = join(root, "disposed.txt");
      const entry = join(global, "reload.ts");
      await writeFile(entry, reloadableExtension("v1", marker));

      const manager = new ExtensionManager({ globalDirectories: [global] });
      await manager.load();
      expect((await manager.invokeSlashCommand("version", "")).output).toBe("v1:0");
      expect(await manager.emitLifecycle("turn-start")).toEqual({ invoked: 1, failed: 0 });
      expect((await manager.invokeSlashCommand("version", "")).output).toBe("v1:1");

      await writeFile(entry, reloadableExtension("v2", marker));
      expect(await manager.reload()).toEqual({ discovered: 1, loaded: 1, denied: 0, failed: 0 });
      expect(await readFile(marker, "utf8")).toBe("v1:true");
      expect((await manager.invokeSlashCommand("version", "")).output).toBe("v2:0");
      expect(await manager.emitLifecycle("turn-start")).toEqual({ invoked: 1, failed: 0 });
      expect((await manager.invokeSlashCommand("version", "")).output).toBe("v2:1");

      await manager.dispose();
      expect(await readFile(marker, "utf8")).toBe("v2:true");
      expect(manager.tools).toEqual([]);
      expect(manager.slashCommands).toEqual([]);
      expect(manager.keybindings).toEqual([]);
      expect(manager.uiContributions).toEqual([]);
    });
  });

  test("isolates import, activation, duplicate, registration, command, and hook failures", async () => {
    await withExtensionDirectories(async ({ global }) => {
      await writeExtension(
        global,
        "00-healthy.ts",
        `
let survived = 0;
export default (context) => {
  context.registerSlashCommand({ name: "shared", description: "first wins", execute() { return "healthy"; } });
  context.registerSlashCommand({ name: "explode", description: "throws", execute() { throw new Error("command boom"); } });
  context.registerSlashCommand({ name: "survived", description: "hook count", execute() { return String(survived); } });
  context.onLifecycle("turn-end", () => { throw new Error("hook boom"); });
  context.onLifecycle("turn-end", () => { survived += 1; });
};
`,
      );
      await writeExtension(
        global,
        "01-duplicate.js",
        `export default (context) => context.registerSlashCommand({ name: "shared", description: "duplicate", execute() { return "wrong"; } });`,
      );
      await writeExtension(
        global,
        "02-activation-fail.ts",
        `export default (context) => { context.registerSlashCommand({ name: "leaked", description: "must roll back", execute() { return "bad"; } }); throw new Error("activation boom"); };`,
      );
      await writeExtension(global, "03-import-fail.mjs", `throw new Error("import boom");`);
      await writeExtension(
        global,
        "04-invalid.ts",
        `export default (context) => {
          context.registerSlashCommand({ name: "invalid", description: "invalid", extra: true, execute() {} });
          context.registerSlashCommand({ name: "after-invalid", description: "still loads", execute() { return "ok"; } });
        };`,
      );

      const manager = new ExtensionManager({ globalDirectories: [global] });
      expect(await manager.load()).toEqual({ discovered: 5, loaded: 3, denied: 0, failed: 2 });
      expect((await manager.invokeSlashCommand("shared", "")).output).toBe("healthy");
      expect(await manager.invokeSlashCommand("leaked", "")).toEqual({ found: false, ok: false });
      expect((await manager.invokeSlashCommand("after-invalid", "")).output).toBe("ok");

      expect(await manager.invokeSlashCommand("explode", "")).toEqual({ found: true, ok: false });
      expect(await manager.emitLifecycle("turn-end")).toEqual({ invoked: 2, failed: 1 });
      expect((await manager.invokeSlashCommand("survived", "")).output).toBe("1");

      const diagnostics = manager.diagnostics;
      expect(diagnostics.some((item) => item.code === "duplicate-extension-registration")).toBe(
        true,
      );
      expect(diagnostics.some((item) => item.code === "extension-activation-failed")).toBe(true);
      expect(diagnostics.some((item) => item.code === "extension-import-failed")).toBe(true);
      expect(diagnostics.some((item) => item.code === "invalid-command-registration")).toBe(true);
      expect(diagnostics.some((item) => item.code === "command-invocation-failed")).toBe(true);
      expect(diagnostics.some((item) => item.code === "lifecycle-hook-failed")).toBe(true);
      expect(
        diagnostics
          .filter((item) => item.code !== "invalid-lifecycle-invocation")
          .every((item) => item.extension !== undefined),
      ).toBe(true);
      expect(
        basename(
          diagnostics.find((item) => item.code === "duplicate-extension-registration")?.extension
            ?.path ?? "",
        ),
      ).toBe("01-duplicate.js");
      await manager.dispose();
    });
  });
});

async function withExtensionDirectories(
  action: (paths: {
    readonly root: string;
    readonly global: string;
    readonly project: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "brisk-extensions-"));
  const global = join(root, "global");
  const project = join(root, "project");
  await Promise.all([mkdir(global), mkdir(project)]);
  try {
    await action({ root, global, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeExtension(directory: string, name: string, content: string): Promise<void> {
  await writeFile(join(directory, name), content);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function reloadableExtension(version: string, marker: string): string {
  return `
let turns = 0;
export default (context) => {
  context.registerSlashCommand({
    name: "version",
    description: "current version",
    execute() { return ${JSON.stringify(version)} + ":" + turns; },
  });
  context.onLifecycle("turn-start", () => { turns += 1; });
  return async () => Bun.write(
    ${JSON.stringify(marker)},
    ${JSON.stringify(version)} + ":" + String(context.signal.aborted),
  );
};
`;
}
