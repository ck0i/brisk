import { expect, test } from "bun:test";
import { ScrollBoxRenderable, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { Root } from "../../src/ui/root.tsx";
import { UiStore } from "../../src/ui/state.ts";

test("conversation disclosures expand thinking and tool diffs from the keyboard", async () => {
  const store = new UiStore("fixture");
  store.addMessage({
    id: "thinking",
    role: "assistant",
    content: "answer",
    thinking: "private reasoning detail",
  });
  const setup = await renderRoot(store);
  try {
    let frame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(frame).toContain("thinking · collapsed · Tab toggles");
    expect(frame).not.toContain("private reasoning detail");

    setup.mockInput.pressTab();
    frame = await setup.waitForFrame((value) => value.includes("thinking · expanded"));
    expect(frame).toContain("private reasoning detail");

    store.addMessage({
      id: "tool",
      role: "assistant",
      content: "",
      tools: [
        {
          id: "edit-1",
          name: "edit",
          status: "completed",
          summary: "Edit committed atomically",
          output:
            "Edit committed atomically\n\n--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-before_unique\n+after_unique\n",
          diff: "--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-before_unique\n+after_unique\n",
        },
      ],
    });
    frame = await setup.waitForFrame((value) => value.includes("edit · Edit committed"));
    expect(frame).toContain("collapsed");
    expect(frame).not.toContain("before_unique");

    setup.mockInput.pressTab();
    frame = await setup.waitForFrame((value) => value.includes("before_unique"));
    expect(frame).toContain("after_unique");
    expect(frame).toContain("expanded");
  } finally {
    setup.renderer.destroy();
  }
});

test("long conversations mount a bounded window and PageUp expands it", async () => {
  const store = new UiStore("fixture");
  for (let index = 0; index < 230; index += 1) {
    store.addMessage({
      id: `message-${index}`,
      role: "system",
      content: `history row ${index}`,
    });
  }
  const setup = await renderRoot(store, 80, 22);
  try {
    await setup.renderOnce();
    const scrollbox = findScrollBox(setup.renderer.root);
    expect(scrollbox).toBeInstanceOf(ScrollBoxRenderable);
    expect(scrollbox.getChildren().length).toBeLessThan(150);

    setup.mockInput.pressKey("\u001b[5~");
    await setup.flush();
    expect(scrollbox.getChildren().length).toBeGreaterThan(150);
    expect(scrollbox.getChildren().length).toBeLessThan(230);

    setup.mockInput.pressKey("\u001b[5~");
    await setup.flush();
    expect(scrollbox.getChildren().length).toBeGreaterThanOrEqual(230);
  } finally {
    setup.renderer.destroy();
  }
});

function findScrollBox(root: BaseRenderable): ScrollBoxRenderable {
  if (root instanceof ScrollBoxRenderable) return root;
  for (const child of root.getChildren()) {
    const found = findScrollBoxOrUndefined(child);
    if (found) return found;
  }
  throw new Error("Missing conversation scrollbox");
}

function findScrollBoxOrUndefined(root: BaseRenderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root;
  for (const child of root.getChildren()) {
    const found = findScrollBoxOrUndefined(child);
    if (found) return found;
  }
  return undefined;
}

async function renderRoot(store: UiStore, width = 100, height = 32) {
  return await testRender(
    () => <Root store={store} onSubmit={() => true} onAbort={() => {}} onExit={() => {}} />,
    { width, height },
  );
}
