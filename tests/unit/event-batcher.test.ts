import { describe, expect, test } from "bun:test";

import { EventBatcher } from "../../src/core/event-batcher.ts";

describe("EventBatcher", () => {
  test("flushes immediately after idle and coalesces events within a frame", async () => {
    const batches: string[][] = [];
    const batcher = new EventBatcher<string>((events) => batches.push([...events]), 12);

    batcher.push("first");
    expect(batches).toEqual([["first"]]);

    batcher.push("second");
    batcher.push("third");
    expect(batches).toHaveLength(1);
    await Bun.sleep(18);
    expect(batches).toEqual([["first"], ["second", "third"]]);

    await Bun.sleep(15);
    batcher.push("after-idle");
    expect(batches.at(-1)).toEqual(["after-idle"]);
  });

  test("supports explicit flush and discards pending events on cancel", () => {
    const batches: number[][] = [];
    const batcher = new EventBatcher<number>((events) => batches.push([...events]));

    batcher.push(1);
    batcher.push(2);
    batcher.flush();
    batcher.push(3);
    batcher.cancel();
    batcher.flush();

    expect(batches).toEqual([[1], [2]]);
    expect(batcher.size).toBe(0);
  });
});
