import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { ApprovalRequest } from "../../src/tools/approval.ts";
import { UiApprovalController } from "../../src/ui/approval-controller.ts";
import { Root } from "../../src/ui/root.tsx";
import { UiStore } from "../../src/ui/state.ts";

test("approval overlay renders details, traps keys, and resolves keyboard decisions", async () => {
  const store = new UiStore("fixture");
  const controller = new UiApprovalController(store);
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
    { width: 100, height: 30 },
  );

  try {
    await setup.renderOnce();
    const approveOnce = controller.requestApproval(request("first approval"));
    const approveSession = controller.requestApproval(request("second approval"));
    const deny = controller.requestApproval(request("third approval"));
    const escape = controller.requestApproval(request("fourth approval"));

    const frame = await setup.waitForFrame((candidate) => candidate.includes("first approval"));
    expect(frame).toContain("Approval required");
    expect(frame).toContain("bash");
    expect(frame).toContain("command · git status --short");
    expect(frame).toContain("targets · src/file.ts");
    expect(frame).toContain("risk · Runs a shell command.");
    expect(frame).toContain("old value");
    expect(frame).toContain("new value");
    expect(frame).toContain("[A] approve once");

    setup.mockInput.pressKey("a");
    await setup.waitFor(() => store.snapshot.approval?.summary === "second approval");
    setup.mockInput.pressKey("s");
    await setup.waitFor(() => store.snapshot.approval?.summary === "third approval");
    setup.mockInput.pressKey("d");
    await setup.waitFor(() => store.snapshot.approval?.summary === "fourth approval");
    setup.mockInput.pressEscape();
    await setup.waitFor(() => store.snapshot.approval === undefined);

    expect(await Promise.all([approveOnce, approveSession, deny, escape])).toEqual([
      "approve_once",
      "approve_session",
      "deny",
      "deny",
    ]);

    await setup.mockInput.typeText("x");
    setup.mockInput.pressEnter();
    await waitFor(() => submissions.length === 1);
    expect(submissions).toEqual(["x"]);
  } finally {
    controller.dispose();
    setup.renderer.destroy();
  }
});

function request(summary: string): ApprovalRequest {
  return {
    toolName: "bash",
    summary,
    command: "git status --short",
    diff: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old value\n+new value\n",
    targetPaths: ["src/file.ts"],
    riskDescription: "Runs a shell command.",
    equivalenceKey: `bash:${summary}`,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for UI condition");
}
