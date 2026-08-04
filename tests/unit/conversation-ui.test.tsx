import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextAttributes, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { UiAuthController } from "../../src/ui/auth-controller.ts";
import { Root, paletteForTheme } from "../../src/ui/root.tsx";
import { UiStore } from "../../src/ui/state.ts";

test("theme palettes expose a high-contrast shell without changing the default", () => {
  expect(paletteForTheme("default").background).toBe("#0b0d10");
  expect(paletteForTheme("high-contrast")).toMatchObject({
    background: "#000000",
    text: "#ffffff",
    border: "#ffffff",
    accent: "#00ffff",
  });
});

test("conversation labels use User and Agent", async () => {
  const store = new UiStore("fixture");
  store.addMessage({ id: "user", role: "user", content: "Hello" });
  store.addMessage({ id: "agent", role: "assistant", content: "Hi" });
  const setup = await renderRoot(store);
  try {
    const frame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(frame).toContain("User");
    expect(frame).toContain("Agent");
    expect(frame).not.toContain("you");
    expect(frame).not.toContain("assistant");
  } finally {
    setup.renderer.destroy();
  }
});

test("streaming assistant markdown hides markers and applies emphasis styles", async () => {
  const store = new UiStore("fixture");
  store.addMessage({
    id: "markdown",
    role: "assistant",
    content: "",
    streaming: true,
  });
  const setup = await renderRoot(store);
  try {
    await setup.renderOnce();
    for (const chunk of ["This is ", "**bold**", ", *italic*, and `code`."]) {
      store.appendMessageText("markdown", chunk);
    }
    await Bun.sleep(500);

    let frame = setup.captureCharFrame();
    expect(frame).toContain("This is bold, italic, and code.");
    expect(frame).not.toContain("**bold**");
    expect(frame).not.toContain("*italic*");
    expect(frame).not.toContain("`code`");
    const boldSpan = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === "bold");
    expect(boldSpan).toBeDefined();
    expect((boldSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);

    store.replaceMessage("markdown", { streaming: false });
    await Bun.sleep(500);
    frame = setup.captureCharFrame();
    expect(frame).toContain("This is bold, italic, and code.");
    expect(frame).not.toContain("**bold**");
  } finally {
    setup.renderer.destroy();
  }
});

test("OAuth prompts render and submit inside the TUI", async () => {
  const store = new UiStore("fixture");
  const auth = new UiAuthController(store);
  const abort = new AbortController();
  const prompter = auth.begin("openai-codex", abort);
  if (!prompter.manualCode) throw new Error("manual code prompt is unavailable");
  const answer = prompter.manualCode();
  const setup = await renderRoot(store);
  try {
    await setup.waitForFrame((frame) => frame.includes("Sign in · openai-codex"));
    await setup.mockInput.typeText("callback-code");
    setup.mockInput.pressEnter();
    expect(await answer).toBe("callback-code");
    expect(store.snapshot.auth).toBeDefined();
  } finally {
    auth.close();
    auth.dispose();
    setup.renderer.destroy();
  }
});

test("first render focuses the multiline composer and accepts a large paste", async () => {
  const store = new UiStore("fixture");
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
    const frame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(frame).toContain("Brisk · fixture");
    expect(frame).toContain("> Send a message or /help · Ctrl+J for newline");
    expect(setup.renderer.currentFocusedEditor).not.toBeNull();
    const prompt = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
    await setup.mockInput.pasteBracketedText(prompt);
    setup.mockInput.pressEnter();
    await setup.waitFor(() => submissions.length === 1);
    expect(submissions).toEqual([prompt]);
  } finally {
    setup.renderer.destroy();
  }
});

test("composer expands for soft-wrapped sentences and caps its visible rows", async () => {
  const store = new UiStore("fixture");
  const setup = await renderRoot(store, 48, 20);
  try {
    await setup.renderOnce();
    const sentence = Array.from({ length: 24 }, (_, index) => `sentence-${index}.`).join(" ");
    await setup.mockInput.typeText(sentence);
    await setup.waitFor(() => {
      const editor = setup.renderer.currentFocusedEditor;
      return (
        editor !== null && editor.editorView.getTotalVirtualLineCount() > 1 && editor.height > 1
      );
    });
    const editor = setup.renderer.currentFocusedEditor;
    expect(editor?.editorView.getTotalVirtualLineCount()).toBeGreaterThan(6);
    expect(editor?.height).toBe(6);
  } finally {
    setup.renderer.destroy();
  }
});

test("Ctrl+C clears composer input and Ctrl+D exits", async () => {
  const store = new UiStore("fixture");
  store.update({ busy: true });
  let aborts = 0;
  let exits = 0;
  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={() => true}
        onAbort={() => (aborts += 1)}
        onExit={() => (exits += 1)}
      />
    ),
    { width: 48, height: 20, exitOnCtrlC: false },
  );
  try {
    await setup.renderOnce();
    await setup.mockInput.typeText("draft that should be cleared rather than aborting or exiting");
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.waitFor(() => setup.renderer.currentFocusedEditor?.plainText === "");
    expect(setup.renderer.currentFocusedEditor?.height).toBe(1);
    expect(aborts).toBe(0);
    expect(exits).toBe(0);

    setup.mockInput.pressKey("d", { ctrl: true });
    expect(exits).toBe(1);
    expect(aborts).toBe(0);
  } finally {
    setup.renderer.destroy();
  }
});

test("composer clears on send and preserves a newer draft when the request finishes", async () => {
  const store = new UiStore("fixture");
  const submissions: string[] = [];
  let resolveSubmission: ((accepted: boolean) => void) | undefined;
  const completion = new Promise<boolean>((resolve) => {
    resolveSubmission = resolve;
  });
  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={(value) => {
          submissions.push(value);
          return completion;
        }}
        onAbort={() => {}}
        onExit={() => {}}
      />
    ),
    { width: 90, height: 24 },
  );

  try {
    await setup.renderOnce();
    await setup.mockInput.typeText("first request");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => submissions.length === 1);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");

    await setup.mockInput.typeText("new draft while busy");
    resolveSubmission?.(true);
    await completion;
    await Bun.sleep(0);
    await setup.flush();

    expect(submissions).toEqual(["first request"]);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("new draft while busy");
  } finally {
    setup.renderer.destroy();
  }
});

test("slash command menu filters commands and lets the next Enter submit", async () => {
  const store = new UiStore("fixture");
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
    await setup.mockInput.typeText("/");
    await setup.waitForFrame((frame) => frame.includes("/help"));
    setup.mockInput.pressArrow("down");
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/model");
    expect(setup.renderer.currentFocusedEditor).not.toBeNull();
    expect(setup.captureCharFrame()).not.toContain("↑/↓ choose · Enter insert · Esc close");
    setup.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    expect(submissions).toEqual(["/model"]);
  } finally {
    setup.renderer.destroy();
  }
});

test("an exact slash command submits on the first Enter while its menu is visible", async () => {
  const store = new UiStore("fixture");
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
    await setup.mockInput.typeText("/model");
    await setup.waitForFrame((frame) => frame.includes("/model · select"));
    setup.mockInput.pressEnter();
    await setup.waitFor(() => submissions.length === 1);
    expect(submissions).toEqual(["/model"]);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
  } finally {
    setup.renderer.destroy();
  }
});

test("extension UI slots render and registered keybindings invoke without stealing focus", async () => {
  const store = new UiStore("fixture");
  store.setExtensionUi([
    { id: "header", slot: "header", text: "header contribution" },
    { id: "sidebar", slot: "sidebar", text: "sidebar contribution" },
    { id: "status", slot: "status", text: "status contribution" },
    { id: "composer", slot: "composer", text: "composer contribution" },
  ]);
  store.setExtensionKeybindings(["ctrl+x"]);
  const keys: string[] = [];
  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={() => true}
        onAbort={() => {}}
        onExit={() => {}}
        onKeybinding={(key) => keys.push(key)}
      />
    ),
    { width: 110, height: 28 },
  );
  try {
    const frame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(frame).toContain("header contribution");
    expect(frame).toContain("sidebar contribution");
    expect(frame).toContain("status contribution");
    expect(frame).toContain("composer contribution");
    expect(setup.renderer.currentFocusedEditor).not.toBeNull();
    setup.mockInput.pressKey("x", { ctrl: true });
    await setup.waitFor(() => keys.length === 1);
    expect(keys).toEqual(["ctrl+x"]);
    expect(setup.renderer.currentFocusedEditor).not.toBeNull();
  } finally {
    setup.renderer.destroy();
  }
});

test("showThinking config expands reasoning by default and Tab can collapse it", async () => {
  const store = new UiStore("fixture");
  store.update({ showThinking: true });
  store.addMessage({
    id: "thinking-config",
    role: "assistant",
    content: "answer",
    thinking: "configured reasoning detail",
  });
  const setup = await renderRoot(store);
  try {
    let frame = await setup.renderOnce().then(() => setup.captureCharFrame());
    expect(frame).toContain("thinking · expanded · Tab toggles");
    expect(frame).toContain("configured reasoning detail");
    setup.mockInput.pressTab();
    frame = await setup.waitForFrame((value) => value.includes("thinking · collapsed"));
    expect(frame).not.toContain("configured reasoning detail");
  } finally {
    setup.renderer.destroy();
  }
});

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

test("submission errors remain visible and preserve the composer draft", async () => {
  const store = new UiStore("fixture");
  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={() => {
          throw new Error(
            `local command failed api_key=BRISK_TEST_SECRET_VALUE ${"detail ".repeat(45)}expanded tail`,
          );
        }}
        onAbort={() => {}}
        onExit={() => {}}
      />
    ),
    { width: 90, height: 22 },
  );
  try {
    await setup.renderOnce();
    await setup.mockInput.typeText("keep this draft");
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame((value) => value.includes("local command failed"));
    expect(frame).toContain(
      "error · collapsed · Tab toggles · local command failed api_key=[REDACTED]",
    );
    expect(frame).not.toContain("BRISK_TEST_SECRET_VALUE");
    expect(frame).toContain("collapsed · Tab toggles");
    expect(frame).not.toContain("expanded tail");
    expect(frame).toContain("keep this draft");
    expect(store.snapshot.status).toBe("error");

    setup.mockInput.pressTab();
    const expanded = await setup.waitForFrame((value) => value.includes("expanded tail"));
    expect(expanded).toContain("expanded · Tab toggles");
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
