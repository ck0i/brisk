import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue, Message } from "../../src/core/messages.ts";
import { CheckpointStore, withoutPendingToolTurn } from "../../src/subagents/checkpoint.ts";
import {
  parseCompleteTaskInput,
  parseTaskInput,
  parseTaskResult,
} from "../../src/subagents/result.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CheckpointStore", () => {
  test("removes incomplete delegating tool turns before a child branch", () => {
    const prefix: Message[] = [{ role: "user", content: "delegate" }];
    const assistant: Message = {
      role: "assistant",
      content: "delegating",
      toolCalls: [
        { id: "task-one", name: "task", arguments: '{"description":"one"}' },
        { id: "task-two", name: "task", arguments: '{"description":"two"}' },
      ],
    };
    const firstResult: Message = {
      role: "tool",
      toolCallId: "task-one",
      name: "task",
      content: "one complete",
    };
    const secondResult: Message = {
      role: "tool",
      toolCallId: "task-two",
      name: "task",
      content: "two complete",
    };

    expect(withoutPendingToolTurn([...prefix, assistant])).toEqual(prefix);
    expect(withoutPendingToolTurn([...prefix, assistant, firstResult])).toEqual(prefix);
    const complete = [...prefix, assistant, firstResult, secondResult];
    expect(withoutPendingToolTurn(complete)).toBe(complete);
  });

  test("hashes canonical content, freezes one snapshot, and shares object identity", async () => {
    const store = new CheckpointStore();
    const source: Message[] = [
      { role: "user", content: "prefix" },
      { role: "assistant", content: "answer", toolCalls: [] },
    ];
    const first = await store.capture(source);
    const reorderedKeys: Message[] = [
      { content: "prefix", role: "user" },
      { toolCalls: [], content: "answer", role: "assistant" },
    ];
    const second = await store.capture(reorderedKeys);

    expect(second).toBe(first);
    expect(second.messages).toBe(first.messages);
    expect(store.refCount(first.id)).toBe(2);
    source[0] = { role: "user", content: "mutated" };
    expect(first.messages[0]).toEqual({ role: "user", content: "prefix" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.messages)).toBe(true);
    expect(Object.isFrozen(first.messages[0])).toBe(true);
    expect(() => {
      (first.messages as Message[])[0] = { role: "user", content: "forbidden" };
    }).toThrow();
  });

  test("persists one private atomic document and evicts old unreferenced entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-checkpoints-"));
    temporaryPaths.push(root);
    const directory = join(root, "private");
    const store = new CheckpointStore({ directory, maxEntries: 1 });
    const first = await store.capture([{ role: "user", content: "one" }]);
    store.release(first.id);
    const duplicate = await store.capture([{ content: "one", role: "user" }]);

    expect(duplicate).toBe(first);
    expect(await readdir(directory)).toEqual([`${first.id}.json`]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, `${first.id}.json`))).mode & 0o777).toBe(0o600);
    const document: unknown = JSON.parse(
      await readFile(join(directory, `${first.id}.json`), "utf8"),
    );
    expect(document).toEqual({
      schemaVersion: 1,
      id: first.id,
      messages: [{ role: "user", content: "one" }],
    });

    store.release(first.id);
    const second = await store.capture([{ role: "user", content: "two" }]);
    store.release(second.id);
    expect(store.size).toBe(1);
    expect(store.get(first.id)).toBeUndefined();
  });
});

describe("subagent structured parsers", () => {
  test("parses the concise task shape strictly and defaults research mode", () => {
    expect(parseTaskInput({ description: " inspect " })).toEqual({
      description: "inspect",
      mode: "research",
    });
    expect(
      parseTaskInput({
        description: "patch it",
        mode: "patch",
        model: "fast",
        maxOutputTokens: 123,
      }),
    ).toEqual({
      description: "patch it",
      mode: "patch",
      model: "fast",
      maxOutputTokens: 123,
    });
    expect(() => parseTaskInput({ description: "x", extra: true })).toThrow("extra is not allowed");
    expect(() => parseTaskInput({ description: "x", mode: "other" })).toThrow();
    expect(() => parseTaskInput({ description: "x", maxOutputTokens: 0 })).toThrow();
  });

  test("validates complete and parent result structures", () => {
    expect(
      parseCompleteTaskInput({
        status: "blocked",
        summary: "needs input",
        blockers: ["missing file"],
      }),
    ).toEqual({ status: "blocked", summary: "needs input", blockers: ["missing file"] });

    const value: JsonValue = {
      status: "completed",
      summary: "done",
      patch: "diff",
      filesConsidered: ["a.ts"],
      testsSuggested: ["bun test"],
      childSessionId: "child-1",
    };
    expect(parseTaskResult(value)).toEqual({
      status: "completed",
      summary: "done",
      patch: "diff",
      filesConsidered: ["a.ts"],
      testsSuggested: ["bun test"],
      childSessionId: "child-1",
    });
    expect(() =>
      parseTaskResult({ status: "completed", summary: "done", childSessionId: "child", x: 1 }),
    ).toThrow("x is not allowed");
  });
});
