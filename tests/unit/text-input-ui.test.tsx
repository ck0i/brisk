import { expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { Root } from "../../src/ui/root.tsx";
import { UiStore } from "../../src/ui/state.ts";
import { UiTextInputController } from "../../src/ui/text-input-controller.ts";

test("text input overlay validates, submits, cancels, and restores composer focus", async () => {
  const store = new UiStore("fixture");
  const controller = new UiTextInputController(store);
  const setup = await testRender(
    () => <Root store={store} onSubmit={() => true} onAbort={() => {}} onExit={() => {}} />,
    { width: 90, height: 24 },
  );

  try {
    await setup.renderOnce();
    const value = controller.prompt({
      title: "Max subagents",
      message: "Enter a non-negative integer.",
      value: "3",
      validate: (candidate) => (/^\d+$/.test(candidate) ? undefined : "Integer required."),
    });
    await setup.waitForFrame((frame) => frame.includes("Max subagents"));
    const editor = setup.renderer.currentFocusedEditor as InputRenderable | null;
    if (!editor) throw new Error("Missing focused settings input");
    editor.value = "invalid";
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("Integer required."));
    editor.value = "5";
    setup.mockInput.pressEnter();
    expect(await value).toBe("5");

    const cancelled = controller.prompt({ title: "Depth", message: "Enter depth." });
    await setup.waitForFrame((frame) => frame.includes("Enter depth."));
    setup.mockInput.pressEscape();
    expect(await cancelled).toBeUndefined();
    await setup.waitFor(() => setup.renderer.currentFocusedEditor !== null);
  } finally {
    controller.dispose();
    setup.renderer.destroy();
  }
});
