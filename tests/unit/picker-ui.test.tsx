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

test("searchable picker fuzzy-filters options and selects within the results", async () => {
  const store = new UiStore("fixture");
  const controller = new UiPickerController(store);
  const setup = await testRender(
    () => <Root store={store} onSubmit={() => true} onAbort={() => {}} onExit={() => {}} />,
    { width: 100, height: 24 },
  );

  try {
    await setup.renderOnce();
    const selected = controller.choose({
      title: "Select provider/model",
      searchable: true,
      searchPlaceholder: "Search models…",
      options: [
        { id: "openai/gpt-5", label: "openai/gpt-5" },
        { id: "cursor/composer-1", label: "cursor/composer-1" },
        { id: "cursor/composer-1-fast", label: "cursor/composer-1-fast" },
        { id: "cursor/sonnet-4", label: "cursor/sonnet-4" },
      ],
    });

    await setup.waitForFrame((frame) => frame.includes("Search models…"));
    await setup.mockInput.typeText("compo");
    await setup.waitFor(() => store.snapshot.picker?.query === "compo");
    const filtered = await setup.waitForFrame((frame) => frame.includes("2 matches"));
    expect(filtered).toContain("cursor/composer-1");
    expect(filtered).toContain("cursor/composer-1-fast");
    expect(filtered).not.toContain("openai/gpt-5");
    expect(filtered).not.toContain("cursor/sonnet-4");

    setup.mockInput.pressArrow("down");
    await setup.waitFor(() => store.snapshot.picker?.selectedIndex === 2);
    setup.mockInput.pressEnter();
    expect(await selected).toBe("cursor/composer-1-fast");
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
