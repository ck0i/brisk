import { describe, expect, test } from "bun:test";

import { UiStore, type UiAgentIndicator } from "../../src/ui/state.ts";

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

  test("keeps agent identity order stable and manages panel navigation", () => {
    const store = new UiStore("fixture");
    const decisions: string[] = [];
    store.setAgentDecisionHandler((id, decision) => decisions.push(`${id}:${decision}`));

    store.upsertAgent(agent("research", "queued"));
    store.upsertAgent(agent("patch", "running"));
    store.upsertAgent({ ...agent("research", "completed"), summary: "indexed files" });

    expect(store.snapshot.agents.map(({ id, status }) => [id, status])).toEqual([
      ["research", "completed"],
      ["patch", "running"],
    ]);
    expect(store.openAgents()).toBe(true);
    expect(store.snapshot.agentPanel).toEqual({ view: "list", selectedAgentId: "research" });

    store.moveAgentSelection(1);
    expect(store.snapshot.agentPanel?.selectedAgentId).toBe("patch");
    expect(store.openSelectedAgent()).toBe(true);
    expect(store.snapshot.agentPanel).toEqual({ view: "detail", selectedAgentId: "patch" });
    expect(store.cancelSelectedAgent()).toBe(true);
    expect(decisions).toEqual(["patch:open", "patch:cancel"]);

    store.backAgentPanel();
    expect(store.snapshot.agentPanel).toEqual({ view: "list", selectedAgentId: "patch" });
    store.removeAgent("patch");
    expect(store.snapshot.agentPanel?.selectedAgentId).toBe("research");
    store.clearAgentSelection();
    expect(store.snapshot.agentPanel).toBeUndefined();
    store.removeAgent("research");
    expect(store.snapshot.agents).toEqual([]);
    expect(store.openAgents()).toBe(false);
  });
});

function agent(id: string, status: UiAgentIndicator["status"]): UiAgentIndicator {
  return {
    id,
    description: `${id} child`,
    provider: "anthropic",
    model: "claude-sonnet",
    mode: id === "patch" ? "patch" : "research",
    status,
    inputTokens: 1200,
    outputTokens: 340,
    childSessionId: `session-${id}`,
  };
}
