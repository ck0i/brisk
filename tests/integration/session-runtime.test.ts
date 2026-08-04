import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { SessionRuntime } from "../../src/runtime/session-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("SessionRuntime", () => {
  test("creates, records, closes, and continues the latest workspace session", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-session-runtime-"));
    roots.push(root);
    const options = {
      sessionsDir: join(root, "data", "sessions"),
      sessionIndexPath: join(root, "data", "session-index.json"),
      artifactsDir: join(root, "data", "artifacts"),
      workspace: root,
      selectedProvider: "fake",
      selectedModel: "initial",
    } as const;
    const first = await SessionRuntime.initialize(options);
    const id = first.sessionId;
    const loop = new AgentLoop({
      provider: new FakeProvider([
        { text: "persisted", usage: { inputTokens: 3, outputTokens: 2 } },
      ]),
      model: "fake/initial",
    });
    first.attach(loop);
    await loop.submit("hello");
    await first.detach();
    expect(first.messages.map((message) => message.content)).toEqual(["hello", "persisted"]);
    await first.recordModelChange("fake", "changed");
    await first.close();

    const resumed = await SessionRuntime.initialize({ ...options, continueLast: true });
    expect(resumed.sessionId).toBe(id);
    expect(resumed.selectedModelSpecifier).toBe("fake/changed");
    expect(resumed.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:hello",
      "assistant:persisted",
    ]);
    expect(resumed.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(resumed.artifactDirectory).toBe(join(root, "data", "artifacts", id));
    await resumed.close();
  });

  test("remembers the last model when starting a fresh session", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-session-model-"));
    roots.push(root);
    const options = {
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
    } as const;
    const first = await SessionRuntime.initialize(options);
    await first.recordModelChange("openai-codex", "gpt-5.3-codex-spark");
    await first.close();

    const fresh = await SessionRuntime.initialize(options);
    expect(fresh.selectedModelSpecifier).toBe("openai-codex/gpt-5.3-codex-spark");
    await fresh.close();
  });

  test("creates and switches indexed sessions while enforcing workspace association", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-session-switch-"));
    roots.push(root);
    const options = {
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
    } as const;
    const runtime = await SessionRuntime.initialize(options);
    const firstId = runtime.sessionId;
    const second = await runtime.createNew("anthropic", "model");
    expect(second.metadata.id).not.toBe(firstId);
    const indexedIds = (await runtime.listWorkspace()).map((session) => session.id);
    expect(indexedIds).toHaveLength(2);
    expect(indexedIds).toEqual(expect.arrayContaining([second.metadata.id, firstId]));
    await runtime.open(firstId);
    expect(runtime.sessionId).toBe(firstId);
    await runtime.close();
  });
});
