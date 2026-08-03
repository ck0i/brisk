import { describe, expect, test } from "bun:test";

import { UiStore } from "../../src/ui/state.ts";

describe("UiStore", () => {
  test("updates a streaming message incrementally", () => {
    const store = new UiStore("fixture");
    store.addMessage({ id: "a", role: "assistant", content: "", streaming: true });
    store.appendMessageText("a", "hello");
    store.appendMessageText("a", " world");
    store.replaceMessage("a", { streaming: false });

    expect(store.snapshot.messages).toEqual([
      { id: "a", role: "assistant", content: "hello world", streaming: false },
    ]);
  });

  test("notifies subscribers and keeps only explicit state", () => {
    const store = new UiStore("fixture", "safe");
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.update({ status: "loading" });
    unsubscribe();
    store.update({ status: "ready" });

    expect(calls).toBe(1);
    expect(store.snapshot.mode).toBe("safe");
  });
});
