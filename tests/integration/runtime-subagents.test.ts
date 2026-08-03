import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextManager } from "../../src/context/context-manager.ts";
import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { RuntimeSubagents } from "../../src/runtime/subagent-runtime.ts";
import { SessionRuntime } from "../../src/runtime/session-runtime.ts";
import { PermissionManager, type ApprovalHandler } from "../../src/tools/approval.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { UiStore } from "../../src/ui/state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const allow: ApprovalHandler = {
  requestApproval: async () => "approve_once",
};

describe("RuntimeSubagents", () => {
  test("registers a compact task result, persists child continuation, and updates UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-runtime-subagents-"));
    roots.push(root);
    const session = await SessionRuntime.initialize({
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
      selectedProvider: "fake",
      selectedModel: "parent",
    });
    const parentLoop = new AgentLoop({
      provider: new FakeProvider([{ text: "unused" }]),
      model: "fake/parent",
      initialMessages: [{ role: "user", content: "shared parent prefix" }],
    });
    const context = new ContextManager({
      model: {
        provider: "fake",
        api: "openai-completions",
        model: "fake/parent",
        contextWindow: 64_000,
        supportsImages: false,
      },
      initialMessages: parentLoop.messages,
    });
    const store = new UiStore("fixture");
    const permissions = new PermissionManager({
      mode: "write",
      workspace: root,
      handler: allow,
    });
    const runtime = RuntimeSubagents.create({
      workspace: root,
      checkpointDirectory: join(root, "checkpoints"),
      artifactsDirectory: join(root, "artifacts"),
      defaultModel: "fake/child",
      maxConcurrency: 3,
      maxDepth: 1,
      permissionMode: "write",
      approvalHandler: allow,
      permissions,
      fakeProvider: true,
      parentLoop,
      contextManager: context,
      session,
      store,
    });
    const registry = new ToolRegistry().register(runtime.taskTool);

    const [toolResult] = await registry.execute(
      [
        {
          id: "task-1",
          name: "task",
          arguments: JSON.stringify({ description: "Inspect parser", mode: "research" }),
        },
      ],
      new AbortController().signal,
    );

    expect(toolResult?.isError).not.toBe(true);
    const parsed = JSON.parse(toolResult?.content ?? "{}") as {
      childSessionId?: string;
      summary?: string;
    };
    expect(parsed.summary).toContain("Completed child task");
    expect(parsed.childSessionId).toBeString();
    const childId = parsed.childSessionId ?? "";
    expect(runtime.manager.getTranscript(childId)?.map((message) => message.content)).toEqual([
      "Inspect parser",
      "Completed child task in research mode.",
    ]);
    expect(runtime.manager.getCheckpoint(childId)?.messages).toEqual(parentLoop.messages);
    const child = await session.repository.open(childId);
    expect(child.messages.map((message) => message.content)).toEqual([
      "Inspect parser",
      "Completed child task in research mode.",
    ]);
    await session.flush();
    expect((await session.repository.open(session.sessionId)).metadata.childRefs).toContainEqual(
      expect.objectContaining({ sessionId: childId, title: "Inspect parser" }),
    );
    expect(store.snapshot.agents[0]).toMatchObject({
      childSessionId: childId,
      status: "completed",
      mode: "research",
      transcript: [
        { role: "user", content: "Inspect parser" },
        { role: "assistant", content: "Completed child task in research mode." },
      ],
    });
    runtime.dispose();
    await session.close();
  });

  test("patch children finalize an overlay without mutating the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-runtime-patch-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "original\n");
    const session = await SessionRuntime.initialize({
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
    });
    const parentLoop = new AgentLoop({
      provider: new FakeProvider([{ text: "unused" }]),
      model: "fake/parent",
    });
    const context = new ContextManager({
      model: {
        provider: "fake",
        api: "openai-completions",
        model: "fake/parent",
        contextWindow: 64_000,
        supportsImages: false,
      },
    });
    const store = new UiStore("fixture");
    const permissions = new PermissionManager({ mode: "write", workspace: root, handler: allow });
    const runtime = RuntimeSubagents.create({
      workspace: root,
      checkpointDirectory: join(root, "checkpoints"),
      artifactsDirectory: join(root, "artifacts"),
      defaultModel: "fake/child",
      maxConcurrency: 2,
      maxDepth: 1,
      permissionMode: "write",
      approvalHandler: allow,
      permissions,
      fakeProvider: true,
      parentLoop,
      contextManager: context,
      session,
      store,
    });
    const registry = new ToolRegistry().register(runtime.taskTool);
    await registry.execute(
      [
        {
          id: "patch",
          name: "task",
          arguments: JSON.stringify({ description: "Patch value", mode: "patch" }),
        },
      ],
      new AbortController().signal,
    );
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("original\n");
    runtime.dispose();
    await session.close();
  });
});
