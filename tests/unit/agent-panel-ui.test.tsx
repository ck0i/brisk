import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { Root } from "../../src/ui/root.tsx";
import { UiStore, type UiAgentIndicator } from "../../src/ui/state.ts";

test("agent strip and panel navigate, cancel, resize, and restore composer focus", async () => {
  const store = new UiStore("fixture");
  const decisions: string[] = [];
  const submissions: string[] = [];
  store.setAgentDecisionHandler((id, decision) => decisions.push(`${id}:${decision}`));

  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={(value) => {
          submissions.push(value);
          return true;
        }}
        onAbort={() => {}}
        onExit={() => {}}
      />
    ),
    { width: 110, height: 26 },
  );

  try {
    const emptyFrame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(emptyFrame).not.toContain("agents ·");
    expect(emptyFrame).not.toContain("Agent detail");

    store.upsertAgent(agent("research", "running"));
    store.upsertAgent({
      ...agent("patch", "blocked"),
      summary: "awaiting parent decision",
      error: "write approval required",
    });

    const stripFrame = await setup.waitForFrame((frame) => frame.includes("agents ·"));
    expect(stripFrame).toContain("◐ research child [running · research · anthropic/claude-sonnet");
    expect(stripFrame).toContain("/agents");

    expect(store.openAgents()).toBe(true);
    const listFrame = await setup.waitForFrame((frame) => frame.includes("Agents · 2 children"));
    expect(listFrame).toContain("running · research · anthropic/claude-sonnet");
    expect(listFrame).toContain("in 1,200 out 340");
    expect(setup.renderer.currentFocusedEditor).toBeNull();

    setup.mockInput.pressArrow("down");
    await setup.waitFor(() => store.snapshot.agentPanel?.selectedAgentId === "patch");
    setup.mockInput.pressKey("c");
    expect(decisions).toEqual(["patch:cancel"]);
    setup.mockInput.pressEnter();

    await setup.waitFor(() => store.snapshot.agentPanel?.view === "detail");
    const detailFrame = await setup.waitForFrame((frame) => frame.includes("Agent detail"));
    expect(detailFrame).toContain("status · blocked");
    expect(detailFrame).toContain("mode · patch");
    expect(detailFrame).toContain("session · child-patch");
    expect(detailFrame).toContain("summary · awaiting parent decision");
    expect(detailFrame).toContain("error · write approval required");
    expect(detailFrame).not.toContain("assistant:");
    expect(decisions).toEqual(["patch:cancel", "patch:open"]);

    setup.resize(64, 16);
    await setup.flush();
    const resizedFrame = setup.captureCharFrame();
    expect(resizedFrame).toContain("Agent detail");
    expect(resizedFrame.split("\n").every((line) => line.length <= 64)).toBe(true);

    setup.mockInput.pressEscape();
    await waitFor(() => store.snapshot.agentPanel?.view === "list");
    setup.mockInput.pressEscape();
    await waitFor(() => store.snapshot.agentPanel === undefined);
    await waitFor(() => setup.renderer.currentFocusedEditor !== null);

    await setup.mockInput.typeText("x");
    setup.mockInput.pressEnter();
    await waitFor(() => submissions.length === 1);
    expect(submissions).toEqual(["x"]);

    store.removeAgent("research");
    store.removeAgent("patch");
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("agents ·");
  } finally {
    setup.renderer.destroy();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for agent panel condition");
}

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
    childSessionId: `child-${id}`,
  };
}
