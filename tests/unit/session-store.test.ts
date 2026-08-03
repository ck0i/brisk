import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InvalidSessionIdError,
  SessionClosedError,
  SessionStore,
  SessionWriteError,
  type CreateSessionOptions,
  type SessionStoreOptions,
} from "../../src/sessions/index.ts";

interface Layout {
  readonly root: string;
  readonly sessionsDir: string;
  readonly workspace: string;
}

describe("session store", () => {
  test("rejects unsafe transcript ids before filesystem access", () => {
    const store = testStore(join(tmpdir(), "unused-brisk-sessions"), "unsafe");
    expect(() => store.pathFor("../escape")).toThrow(InvalidSessionIdError);
  });

  test("appends incrementally and reloads finalized messages in exact order", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "order");
      const metadata = await store.create(createOptions(layout, "order"));
      const transcript = store.pathFor(metadata.id);
      const initialSize = (await stat(transcript)).size;

      await store.append(metadata.id, {
        type: "user_message",
        message: { role: "user", content: "question" },
      });
      const afterUserSize = (await stat(transcript)).size;
      await store.appendBatch(metadata.id, [
        { type: "assistant_start", responseId: "response-1", model: "model-a" },
        { type: "assistant_thinking", delta: "reasoning" },
        { type: "assistant_text", delta: "answer" },
        {
          type: "assistant_message",
          message: {
            role: "assistant",
            content: "answer",
            thinking: "reasoning",
            toolCalls: [],
            model: "model-a",
          },
        },
        {
          type: "tool_result",
          message: {
            role: "tool",
            toolCallId: "tool-1",
            name: "read",
            content: "result",
          },
        },
      ]);
      const finalSize = (await stat(transcript)).size;
      expect(initialSize).toBeLessThan(afterUserSize);
      expect(afterUserSize).toBeLessThan(finalSize);

      const loaded = await store.open(metadata.id);
      expect(loaded.entries.map((entry) => entry.type)).toEqual([
        "session_metadata",
        "user_message",
        "assistant_start",
        "assistant_thinking",
        "assistant_text",
        "assistant_message",
        "tool_result",
      ]);
      expect(loaded.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(loaded.messages).toEqual([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "answer",
          thinking: "reasoning",
          toolCalls: [],
          model: "model-a",
        },
        {
          role: "tool",
          toolCallId: "tool-1",
          name: "read",
          content: "result",
        },
      ]);
      expect(loaded.partialAssistant).toBeUndefined();
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent appends and flushes accepted writes before close", async () => {
    const layout = await createLayout();
    try {
      let syncCount = 0;
      const store = testStore(layout.sessionsDir, "concurrent", {
        fsyncPolicy: "flush",
        io: {
          async syncFile() {
            syncCount += 1;
          },
        },
      });
      const metadata = await store.create(createOptions(layout, "concurrent"));
      const appends = Array.from({ length: 30 }, (_, index) =>
        store.append(metadata.id, {
          type: "user_message",
          message: { role: "user", content: String(index) },
        }),
      );
      const flush = store.flush();
      await Promise.all(appends);
      await flush;
      expect(syncCount).toBe(1);
      await store.close();

      const reader = testStore(layout.sessionsDir, "reader");
      const loaded = await reader.open(metadata.id);
      expect(loaded.entries.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: 31 }, (_, index) => index + 1),
      );
      expect(loaded.messages.map((message) => message.content)).toEqual(
        Array.from({ length: 30 }, (_, index) => String(index)),
      );
      expect(syncCount).toBe(2);
      await expect(
        store.append(metadata.id, {
          type: "user_message",
          message: { role: "user", content: "late" },
        }),
      ).rejects.toBeInstanceOf(SessionClosedError);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("reports an interrupted streaming assistant without inventing a finalized message", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "partial");
      const metadata = await store.create(createOptions(layout, "partial"));
      await store.appendBatch(metadata.id, [
        { type: "user_message", message: { role: "user", content: "run" } },
        { type: "assistant_start", responseId: "response" },
        { type: "assistant_thinking", delta: "think" },
        { type: "assistant_text", delta: "par" },
        { type: "assistant_text", delta: "tial" },
        { type: "assistant_tool_call_start", index: 0, id: "call", name: "bash" },
        { type: "assistant_tool_call_delta", index: 0, delta: '{"cmd":' },
        { type: "cancellation", reason: "operator cancelled" },
      ]);

      const loaded = await store.open(metadata.id);
      expect(loaded.messages).toEqual([{ role: "user", content: "run" }]);
      expect(loaded.partialAssistant).toEqual({
        startSequence: 3,
        content: "partial",
        thinking: "think",
        toolCalls: [
          {
            index: 0,
            id: "call",
            name: "bash",
            arguments: '{"cmd":',
            complete: false,
          },
        ],
        reason: "cancelled",
        detail: "operator cancelled",
      });
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("preserves and ignores a truncated final line without rewriting the transcript", async () => {
    const layout = await createLayout();
    try {
      const writer = testStore(layout.sessionsDir, "truncate-writer");
      const metadata = await writer.create(createOptions(layout, "truncated"));
      const transcript = writer.pathFor(metadata.id);
      await appendFile(transcript, '{"schemaVersion":1,"sequence":2,"timestamp":"2026');
      const beforeOpen = await readFile(transcript, "utf8");

      const recoveryStore = testStore(layout.sessionsDir, "truncate-reader");
      const recovered = await recoveryStore.open(metadata.id);
      expect(await readFile(transcript, "utf8")).toBe(beforeOpen);
      expect(recovered.lastSequence).toBe(1);
      expect(recovered.diagnostics).toContainEqual(
        expect.objectContaining({ kind: "truncated_final_line", line: 2 }),
      );
      const diagnostic = recovered.diagnostics.find((item) => item.kind === "truncated_final_line");
      expect(diagnostic?.recoveryPath).toBeDefined();
      expect(await readFile(diagnostic?.recoveryPath ?? "", "utf8")).toBe(
        '{"schemaVersion":1,"sequence":2,"timestamp":"2026',
      );

      await recoveryStore.append(metadata.id, {
        type: "user_message",
        message: { role: "user", content: "resumed" },
      });
      const reloaded = await recoveryStore.open(metadata.id);
      expect(reloaded.messages).toEqual([{ role: "user", content: "resumed" }]);
      expect(reloaded.lastSequence).toBe(2);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("skips a malformed complete middle line and preserves unknown future entries", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "forward");
      const metadata = await store.create(createOptions(layout, "forward"));
      const transcript = store.pathFor(metadata.id);
      await appendFile(transcript, "not-json\n");
      await appendFile(
        transcript,
        `${JSON.stringify({
          schemaVersion: 2,
          sequence: 2,
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "future_entry",
          futurePayload: { nested: true },
        })}\n`,
      );
      await appendFile(
        transcript,
        `${JSON.stringify({
          schemaVersion: 1,
          sequence: 3,
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "user_message",
          message: { role: "user", content: "valid after malformed" },
          futureField: 42,
        })}\n`,
      );

      const loaded = await store.open(metadata.id);
      expect(loaded.entries.map((entry) => entry.type)).toEqual([
        "session_metadata",
        "unknown",
        "user_message",
      ]);
      expect(loaded.diagnostics).toContainEqual(
        expect.objectContaining({ kind: "malformed_line", line: 2 }),
      );
      const unknown = loaded.entries[1];
      expect(unknown?.type).toBe("unknown");
      if (unknown?.type === "unknown") {
        expect(unknown.originalType).toBe("future_entry");
        expect(unknown.rawEntry.futurePayload).toEqual({ nested: true });
      }
      expect(loaded.entries[2]?.rawEntry?.futureField).toBe(42);
      expect(loaded.messages).toEqual([{ role: "user", content: "valid after malformed" }]);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("restores model, usage, compaction, and child metadata from append-only entries", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "metadata");
      const metadata = await store.create(createOptions(layout, "metadata"));
      await store.appendBatch(metadata.id, [
        { type: "model_change", provider: "provider-b", model: "model-b" },
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            totalTokens: 15,
            cost: 0.25,
          },
        },
        { type: "compaction", compaction: { summary: "summary", compactedMessageCount: 4 } },
        {
          type: "child_session",
          child: {
            sessionId: "child-1",
            title: "child",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]);

      const loaded = await store.open(metadata.id);
      expect(loaded.metadata).toMatchObject({
        selectedProvider: "provider-b",
        selectedModel: "model-b",
        compactionCount: 1,
        usageTotals: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 15,
          cost: 0.25,
        },
        childRefs: [{ sessionId: "child-1", title: "child" }],
      });
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("round-trips explicit user images and extended compaction metadata", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "images");
      const metadata = await store.create(createOptions(layout, "images"));
      await store.appendBatch(metadata.id, [
        {
          type: "user_message",
          message: {
            role: "user",
            content: "inspect",
            images: [
              {
                type: "image",
                data: "AQID",
                mimeType: "image/png",
                detail: "original",
              },
            ],
            timestamp: 42,
          },
        },
        {
          type: "compaction",
          compaction: {
            summary: "archive",
            preserveData: { snapcompact: { frames: [] } },
            rawSource: "structured source",
            firstKeptIdentity: "brisk-1-12345678",
            tokensBefore: 100,
            textTokenEstimate: 20,
            compactedImageTokenEstimate: 5024,
            imageCount: 1,
            compactedMessageCount: 1,
            retainedMessageCount: 0,
          },
        },
      ]);

      const loaded = await store.open(metadata.id);
      expect(loaded.messages).toEqual([
        {
          role: "user",
          content: "inspect",
          images: [
            {
              type: "image",
              data: "AQID",
              mimeType: "image/png",
              detail: "original",
            },
          ],
          timestamp: 42,
        },
      ]);
      const compaction = loaded.entries.find((entry) => entry.type === "compaction");
      expect(compaction).toMatchObject({
        type: "compaction",
        compaction: {
          rawSource: "structured source",
          imageCount: 1,
          compactedImageTokenEstimate: 5024,
        },
      });
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("surfaces append failures and predictably poisons later writes", async () => {
    const layout = await createLayout();
    try {
      const store = testStore(layout.sessionsDir, "failure", {
        io: {
          async appendText() {
            throw new Error("disk full");
          },
        },
      });
      const metadata = await store.create(createOptions(layout, "failure"));
      const input = {
        type: "user_message" as const,
        message: { role: "user" as const, content: "not persisted" },
      };
      await expect(store.append(metadata.id, input)).rejects.toBeInstanceOf(SessionWriteError);
      await expect(store.append(metadata.id, input)).rejects.toThrow("disk full");

      const reader = testStore(layout.sessionsDir, "failure-reader");
      const loaded = await reader.open(metadata.id);
      expect(loaded.lastSequence).toBe(1);
      expect(loaded.messages).toEqual([]);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });
});

async function createLayout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "brisk-sessions-"));
  const sessionsDir = join(root, "sessions");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, sessionsDir, workspace };
}

function createOptions(layout: Layout, id: string): CreateSessionOptions {
  return {
    id,
    title: `session ${id}`,
    workspace: layout.workspace,
    selectedProvider: "provider-a",
    selectedModel: "model-a",
  };
}

function testStore(
  sessionsDir: string,
  seed: string,
  overrides: Omit<SessionStoreOptions, "sessionsDir" | "now" | "generateId"> = {},
): SessionStore {
  let tick = 0;
  return new SessionStore({
    sessionsDir,
    ...overrides,
    generateId: () => `${seed}-${tick++}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}
