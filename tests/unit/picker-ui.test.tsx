import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { UiPickerController } from "../../src/ui/picker-controller.ts";
import { Root } from "../../src/ui/root.tsx";
import { UiStore } from "../../src/ui/state.ts";

test("picker overlay navigates, skips disabled rows, selects, cancels, and restores input", async () => {
  const store = new UiStore("fixture");
  const controller = new UiPickerController(store);
  const submissions: string[] = [];
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
    { width: 90, height: 24 },
  );

  try {
    await setup.renderOnce();
    const first = controller.choose({
      title: "Select session",
      selectedId: "one",
      options: [
        { id: "one", label: "First", description: "recent" },
        { id: "two", label: "Disabled", disabled: true },
        { id: "three", label: "Third" },
      ],
    });
    const frame = await setup.waitForFrame((candidate) => candidate.includes("Select session"));
    expect(frame).toContain("First · recent");
    expect(frame).toContain("Disabled");

    setup.mockInput.pressArrow("down");
    await setup.waitFor(() => store.snapshot.picker?.selectedIndex === 2);
    setup.mockInput.pressEnter();
    expect(await first).toBe("three");

    const cancelled = controller.choose({
      title: "Select model",
      options: [{ id: "model", label: "provider/model" }],
    });
    await setup.waitFor(() => store.snapshot.picker?.title === "Select model");
    setup.mockInput.pressEscape();
    expect(await cancelled).toBeUndefined();

    await setup.mockInput.typeText("x");
    setup.mockInput.pressEnter();
    await waitFor(() => submissions.length === 1);
    expect(submissions).toEqual(["x"]);
  } finally {
    controller.dispose();
    setup.renderer.destroy();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for picker condition");
}
