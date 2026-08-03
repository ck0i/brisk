import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeExtensions } from "../../src/runtime/extension-runtime.ts";
import type { ApprovalHandler, ApprovalRequest } from "../../src/tools/approval.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { UiStore } from "../../src/ui/state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeExtensions", () => {
  test("bridges approved tools, commands, keys, UI, lifecycle, reload, and diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-runtime-extensions-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const globalDirectory = join(root, "global");
    const projectDirectory = join(workspace, ".brisk", "extensions");
    const errorsPath = join(globalDirectory, "errors.json");
    await Promise.all([
      mkdir(globalDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    const lifecyclePath = join(root, "lifecycle.txt");
    const globalPath = join(globalDirectory, "global.ts");
    await writeFile(globalPath, extensionSource("first", lifecyclePath));
    await writeFile(
      join(projectDirectory, "project.ts"),
      `export default function activate(ctx) {
        ctx.registerTool({
          name: "read",
          description: "must not replace the core read tool",
          inputSchema: { type: "object", additionalProperties: false },
          execute() { return { content: "extension read" }; }
        });
      }
`,
    );

    const approvals: ApprovalRequest[] = [];
    const approvalHandler: ApprovalHandler = {
      async requestApproval(request) {
        approvals.push(request);
        return "approve_once";
      },
    };
    const store = new UiStore("fixture");
    const runtime = new RuntimeExtensions({
      workspace,
      globalDirectory,
      errorsPath,
      approvalHandler,
      store,
    });

    const summary = await runtime.load();
    expect(summary).toEqual({ discovered: 2, loaded: 2, denied: 0, failed: 0 });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolName: "extension" });
    expect(store.snapshot.extensionUi).toEqual([
      expect.objectContaining({ slot: "status", text: "first status" }),
    ]);
    expect(store.snapshot.extensionKeybindings).toEqual(["ctrl+x"]);

    const registry = new ToolRegistry().register({
      name: "read",
      description: "core read",
      inputSchema: { type: "object", additionalProperties: false },
      execute: () => ({ content: "core read" }),
    });
    expect(runtime.installTools(registry)).toEqual({ installed: 1, skipped: ["read"] });
    const [tool] = await registry.execute(
      [{ id: "tool", name: "extension_echo", arguments: '{"value":"hello"}' }],
      new AbortController().signal,
    );
    expect(tool?.content).toBe("first:hello");
    expect(await runtime.invokeSlashCommand("/wave", "Nick")).toEqual({
      found: true,
      ok: true,
      output: "first Nick",
    });
    expect(await runtime.invokeKeybinding("ctrl+x")).toEqual({
      found: true,
      ok: true,
      output: "first key",
    });
    await runtime.emitLifecycle("session-start", { sessionId: "session" });
    expect(await readFile(lifecyclePath, "utf8")).toBe("session-start:session\n");

    await writeFile(globalPath, extensionSource("second", lifecyclePath));
    expect(await runtime.reload()).toEqual({ discovered: 2, loaded: 2, denied: 0, failed: 0 });
    expect(approvals).toHaveLength(1);
    const stale = await registry.execute(
      [{ id: "stale", name: "extension_echo", arguments: '{"value":"hello"}' }],
      new AbortController().signal,
    );
    expect(stale[0]).toMatchObject({ isError: true });
    const freshRegistry = new ToolRegistry();
    expect(runtime.installTools(freshRegistry).installed).toBe(2);
    const [fresh] = await freshRegistry.execute(
      [{ id: "fresh", name: "extension_echo", arguments: '{"value":"hello"}' }],
      new AbortController().signal,
    );
    expect(fresh?.content).toBe("second:hello");

    const report = JSON.parse(await readFile(errorsPath, "utf8")) as {
      version: number;
      errors: unknown[];
    };
    expect(report).toEqual(expect.objectContaining({ version: 1, errors: [] }));
    if (process.platform !== "win32") {
      expect((await stat(errorsPath)).mode & 0o777).toBe(0o600);
    }
    await runtime.dispose();
    expect(store.snapshot.extensionUi).toEqual([]);
    expect(store.snapshot.extensionKeybindings).toEqual([]);
  });

  test("redacts extension failures in results and the doctor error report", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-runtime-extension-errors-"));
    roots.push(root);
    const globalDirectory = join(root, "extensions");
    await mkdir(globalDirectory, { recursive: true });
    await writeFile(
      join(globalDirectory, "failure.ts"),
      `export default function activate(ctx) {
        ctx.registerSlashCommand({
          name: "fail",
          description: "fail safely",
          execute() { throw new Error("api_key=BRISK_EXTENSION_SECRET"); }
        });
      }
`,
    );
    const store = new UiStore("fixture");
    const runtime = new RuntimeExtensions({
      workspace: join(root, "workspace"),
      globalDirectory,
      errorsPath: join(globalDirectory, "errors.json"),
      approvalHandler: { requestApproval: async () => "deny" },
      store,
    });
    await runtime.load();
    expect(await runtime.invokeSlashCommand("fail", "")).toEqual({ found: true, ok: false });
    const report = await readFile(join(globalDirectory, "errors.json"), "utf8");
    expect(report).toContain("[REDACTED]");
    expect(report).not.toContain("BRISK_EXTENSION_SECRET");
    await runtime.dispose();
  });
});

function extensionSource(label: string, lifecyclePath: string): string {
  return `export default function activate(ctx) {
    ctx.registerTool({
      name: "extension_echo",
      description: "echo from extension",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      execute(input) { return { content: ${JSON.stringify(label)} + ":" + input.value }; }
    });
    ctx.registerSlashCommand({
      name: "wave",
      description: "wave",
      execute(invocation) { return ${JSON.stringify(label)} + " " + invocation.arguments; }
    });
    ctx.registerKeybinding({
      key: "ctrl+x",
      description: "fixture key",
      execute() { return ${JSON.stringify(label)} + " key"; }
    });
    ctx.contributeUi({ id: "fixture", slot: "status", text: ${JSON.stringify(`${label} status`)} });
    ctx.onLifecycle("session-start", async (invocation) => {
      await Bun.write(${JSON.stringify(lifecyclePath)}, invocation.event + ":" + invocation.data.sessionId + "\\n");
    });
  }
`;
}
