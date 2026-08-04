import { expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { Root } from "../../src/ui/root.tsx";
import { UiStore, type UiBtwDecision } from "../../src/ui/state.ts";

test("BTW overlay renders its private thread, submits follow-ups, and closes with Escape", async () => {
  const store = new UiStore("fixture");
  const decisions: UiBtwDecision[] = [];
  const removeHandler = store.setBtwDecisionHandler((_id, decision) => {
    decisions.push(decision);
    return true;
  });
  const setup = await testRender(
    () => <Root store={store} onSubmit={() => true} onAbort={() => {}} onExit={() => {}} />,
    { width: 100, height: 30 },
  );

  try {
    store.showBtw({
      id: "btw-test",
      model: "fake/model · off",
      status: "Ready for a follow-up",
      busy: false,
      messages: [
        { id: "question", role: "user", content: "What changed?" },
        { id: "answer", role: "assistant", content: "Only the side thread." },
      ],
      activeTools: [],
    });
    await setup.waitForFrame(
      (frame) => frame.includes("private side thread") && frame.includes("Only the side thread."),
    );

    const input = setup.renderer.currentFocusedEditor as InputRenderable | null;
    if (!input) throw new Error("Missing focused BTW input");
    input.value = "What next?";
    setup.mockInput.pressEnter();
    await setup.waitFor(() => decisions.length === 1);
    expect(decisions[0]).toEqual({ type: "ask", question: "What next?" });
    expect(input.value).toBe("");

    setup.mockInput.pressEscape();
    await setup.waitFor(() => decisions.length === 2);
    expect(decisions[1]).toEqual({ type: "close" });
  } finally {
    removeHandler();
    setup.renderer.destroy();
  }
});
