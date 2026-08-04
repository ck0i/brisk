import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SESSION_FIRST_PROMPT_MAX_LENGTH,
  SESSION_INDEX_SCHEMA_VERSION,
  SessionIndex,
  SessionRepository,
  SessionStore,
  type CreateSessionOptions,
  type SessionIndexIO,
  sessionFirstPrompt,
  type SessionMetadata,
} from "../../src/sessions/index.ts";

interface Layout {
  readonly root: string;
  readonly sessionsDir: string;
  readonly sessionIndexPath: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

describe("session index and repository", () => {
  test("fast-loads the atomic cache and lists, filters, and sorts records", async () => {
    const layout = await createLayout();
    try {
      const records = [
        record("older-a", layout.workspaceA, "2026-01-01T00:00:01.000Z"),
        record("workspace-b", layout.workspaceB, "2026-01-01T00:00:03.000Z"),
        record("newer-a", layout.workspaceA, "2026-01-01T00:00:02.000Z"),
      ];
      await writeFile(
        layout.sessionIndexPath,
        `${JSON.stringify({
          schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
          updatedAt: "2026-01-01T00:00:04.000Z",
          sessions: records,
        })}\n`,
        { mode: 0o600 },
      );

      let scans = 0;
      const index = new SessionIndex({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
        io: {
          async listFiles() {
            scans += 1;
            throw new Error("cache load must not scan transcripts");
          },
        },
      });
      expect((await index.load()).map((item) => item.id)).toEqual([
        "workspace-b",
        "newer-a",
        "older-a",
      ]);
      expect((await index.list({ workspace: layout.workspaceA })).map((item) => item.id)).toEqual([
        "newer-a",
        "older-a",
      ]);
      expect((await index.get("newer-a"))?.title).toBe("newer-a");
      expect((await index.findLatestForWorkspace(layout.workspaceA))?.id).toBe("newer-a");
      expect(index.loadInfo?.source).toBe("cache");
      expect(scans).toBe(0);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("rebuilds a legacy cache so existing sessions gain first-prompt previews", async () => {
    const layout = await createLayout();
    try {
      const store = clockedStore(layout.sessionsDir);
      const metadata = await store.create(createOptions("legacy", layout.workspaceA));
      await store.append("legacy", {
        type: "user_message",
        message: { role: "user", content: "existing session prompt" },
      });
      await writeFile(
        layout.sessionIndexPath,
        `${JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-01-01T00:00:02.000Z",
          sessions: [metadata],
        })}\n`,
        { mode: 0o600 },
      );

      const index = new SessionIndex({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
      });
      expect((await index.load())[0]?.firstPrompt).toBe("existing session prompt");
      expect(index.loadInfo?.source).toBe("rebuild");
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("bounds and sanitizes prompt previews for a single picker line", () => {
    const escape = String.fromCharCode(27);
    const preview = sessionFirstPrompt(`  first\n${escape}second ${"x".repeat(100)}  `);
    expect(preview).toBeDefined();
    expect(preview).not.toContain("\n");
    expect(preview).not.toContain(escape);
    expect(Array.from(preview ?? "")).toHaveLength(SESSION_FIRST_PROMPT_MAX_LENGTH);
    expect(preview?.endsWith("…")).toBe(true);
  });

  test("rebuilds a corrupt cache from only matching transcripts with current metadata", async () => {
    const layout = await createLayout();
    try {
      const store = clockedStore(layout.sessionsDir);
      await store.create(createOptions("session-a", layout.workspaceA));
      await store.appendBatch("session-a", [
        {
          type: "user_message",
          message: { role: "user", content: "hidden control", internal: "goal-control" },
        },
        {
          type: "user_message",
          message: { role: "user", content: "  First prompt\nwith\tspacing  " },
        },
        { type: "user_message", message: { role: "user", content: "later prompt" } },
        { type: "model_change", provider: "provider-b", model: "model-b" },
        { type: "usage", usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } },
        { type: "compaction", compaction: { summary: "summary" } },
        { type: "child_session", child: { sessionId: "child-a", title: "child" } },
      ]);
      await store.create(createOptions("session-b", layout.workspaceB));
      await writeFile(join(layout.sessionsDir, "unrelated.txt"), "not a transcript");
      await writeFile(join(layout.sessionsDir, "unsafe.name.jsonl"), "ignored");
      await writeFile(layout.sessionIndexPath, "{corrupt", { mode: 0o600 });

      const index = new SessionIndex({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
      });
      const rebuilt = await index.load();
      expect(index.loadInfo?.source).toBe("rebuild");
      expect(rebuilt.map((item) => item.id).sort()).toEqual(["session-a", "session-b"]);
      expect(await index.get("session-a")).toMatchObject({
        selectedProvider: "provider-b",
        firstPrompt: "First prompt with spacing",
        selectedModel: "model-b",
        usageTotals: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        compactionCount: 1,
        childRefs: [{ sessionId: "child-a", title: "child" }],
      });
      expect((await index.findLatestForWorkspace(layout.workspaceA))?.id).toBe("session-a");

      const cache: unknown = JSON.parse(await readFile(layout.sessionIndexPath, "utf8"));
      expect(cache).toEqual(
        expect.objectContaining({
          schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
          sessions: expect.any(Array),
        }),
      );
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("upsert and remove update the cache and most-recent ordering", async () => {
    const layout = await createLayout();
    try {
      const index = new SessionIndex({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
      });
      await index.load();
      await index.upsert(record("first", layout.workspaceA, "2026-01-01T00:00:01.000Z"));
      await index.upsert(record("latest", layout.workspaceA, "2026-01-01T00:00:02.000Z"));
      expect((await index.findLatestForWorkspace(layout.workspaceA))?.id).toBe("latest");
      expect(await index.remove("latest")).toBe(true);
      expect(await index.remove("latest")).toBe(false);
      expect((await index.list()).map((item) => item.id)).toEqual(["first"]);

      const reloaded = new SessionIndex({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
      });
      expect((await reloaded.load()).map((item) => item.id)).toEqual(["first"]);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test("keeps transcript events when index writes fail and supports a later rebuild", async () => {
    const layout = await createLayout();
    try {
      let failRename = true;
      const indexIO: Partial<SessionIndexIO> = {
        async rename(from, to) {
          if (failRename) throw new Error("simulated index failure");
          await rename(from, to);
        },
      };
      const repository = new SessionRepository({
        sessionsDir: layout.sessionsDir,
        sessionIndexPath: layout.sessionIndexPath,
        indexIO,
        fsyncPolicy: "never",
      });
      const created = await repository.create(createOptions("repository", layout.workspaceA));
      expect(created.indexError?.message).toContain("simulated index failure");
      expect(repository.lastIndexError).toBe(created.indexError);

      const appended = await repository.append("repository", {
        type: "user_message",
        message: { role: "user", content: "durable event" },
      });
      expect(appended.entries).toHaveLength(1);
      expect(appended.indexError?.message).toContain("simulated index failure");
      expect((await repository.open("repository")).messages).toEqual([
        { role: "user", content: "durable event" },
      ]);

      expect((await repository.open("repository")).metadata.firstPrompt).toBe("durable event");
      failRename = false;
      const rebuilt = await repository.rebuildIndex();
      expect(rebuilt.map((item) => item.id)).toEqual(["repository"]);
      expect(rebuilt[0]?.firstPrompt).toBe("durable event");
      expect(repository.lastIndexError).toBeUndefined();
      expect((await repository.continueLatest(layout.workspaceA))?.metadata.id).toBe("repository");
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });
});

async function createLayout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "brisk-index-"));
  const sessionsDir = join(root, "sessions");
  const sessionIndexPath = join(root, "session-index.json");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  return { root, sessionsDir, sessionIndexPath, workspaceA, workspaceB };
}

function createOptions(id: string, workspace: string): CreateSessionOptions {
  return {
    id,
    title: id,
    workspace,
    selectedProvider: "provider-a",
    selectedModel: "model-a",
  };
}

function clockedStore(sessionsDir: string): SessionStore {
  let tick = 0;
  return new SessionStore({
    sessionsDir,
    fsyncPolicy: "never",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

function record(id: string, workspace: string, updatedAt: string): SessionMetadata {
  return {
    id,
    title: id,
    workspace,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    selectedProvider: "provider-a",
    selectedModel: "model-a",
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
    },
    compactionCount: 0,
    childRefs: [],
    transcriptFilename: `${id}.jsonl`,
    transcriptVersion: 1,
  };
}
