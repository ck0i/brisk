import { describe, expect, test } from "bun:test";

import { UiAuthController } from "../../src/ui/auth-controller.ts";
import { UiStore } from "../../src/ui/state.ts";

describe("UiAuthController", () => {
  test("resolves OAuth input without leaving the mounted UI", async () => {
    const store = new UiStore("fixture");
    const auth = new UiAuthController(store);
    const abort = new AbortController();
    const prompter = auth.begin("openai-codex", abort);

    const answer = prompter.prompt({ message: "Paste callback", allowEmpty: false });
    expect(store.snapshot.auth).toMatchObject({
      provider: "openai-codex",
      message: "Paste callback",
    });
    expect(store.decideAuth("https://localhost/callback?code=test")).toBe(true);
    expect(await answer).toBe("https://localhost/callback?code=test");

    auth.close();
    expect(store.snapshot.auth).toBeUndefined();
    auth.dispose();
  });

  test("cancels the OAuth signal when the UI is cancelled", async () => {
    const store = new UiStore("fixture");
    const auth = new UiAuthController(store);
    const abort = new AbortController();
    const prompter = auth.begin("anthropic", abort);
    if (!prompter.manualCode) throw new Error("manual code prompt is unavailable");
    const answer = prompter.manualCode();

    expect(store.decideAuth(undefined)).toBe(true);
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    expect(abort.signal.aborted).toBe(true);
    auth.dispose();
  });
});
