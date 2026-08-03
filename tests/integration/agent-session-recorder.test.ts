import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { AgentSessionRecorder } from "../../src/sessions/agent-recorder.ts";
import { SessionRepository } from "../../src/sessions/repository.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AgentSessionRecorder", () => {
  test("persists streamed events, finalized messages, usage, and resume history", async () => {
    const { repository, sessionId } = await makeRepository();
    const loop = new AgentLoop({
      provider: new FakeProvider([
        {
          id: "response-1",
          thinking: ["plan", " carefully"],
          text: ["hello", " session"],
          usage: { inputTokens: 9, outputTokens: 4, cost: 0.02 },
        },
      ]),
      model: "fake/session",
    });
    const recorder = new AgentSessionRecorder({ repository, sessionId, frameMs: 2 });
    recorder.attach(loop);

    await loop.submit("persist this");
    await recorder.dispose();

    const loaded = await repository.open(sessionId);
    expect(loaded.messages).toEqual(loop.messages);
    expect(loaded.metadata.usageTotals).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
      cost: 0.02,
    });
    expect(loaded.entries.map((entry) => entry.type)).toEqual([
      "session_metadata",
      "user_message",
      "assistant_start",
      "assistant_thinking",
      "assistant_thinking",
      "assistant_text",
      "assistant_text",
      "usage",
      "assistant_message",
    ]);
    expect(loaded.partialAssistant).toBeUndefined();
    await repository.close();
  });

  test("records an interrupted partial assistant without adding it to provider history", async () => {
    const { repository, sessionId } = await makeRepository();
    const recorder = new AgentSessionRecorder({ repository, sessionId, frameMs: 0 });
    recorder.record({ type: "response_start", id: "partial" });
    recorder.record({ type: "text_delta", delta: "unfinished" });
    recorder.record({ type: "cancelled" });
    await recorder.dispose();

    const loaded = await repository.open(sessionId);
    expect(loaded.messages).toEqual([]);
    expect(loaded.partialAssistant).toMatchObject({
      content: "unfinished",
      reason: "cancelled",
    });
    await repository.close();
  });
});

async function makeRepository(): Promise<{
  repository: SessionRepository;
  sessionId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "brisk-agent-recorder-"));
  temporaryDirectories.push(root);
  const repository = new SessionRepository({
    sessionsDir: join(root, "sessions"),
    sessionIndexPath: join(root, "session-index.json"),
  });
  const created = await repository.create({
    title: "Recorder fixture",
    workspace: root,
    selectedProvider: "fake",
    selectedModel: "session",
  });
  return { repository, sessionId: created.metadata.id };
}
