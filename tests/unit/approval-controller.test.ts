import { describe, expect, test } from "bun:test";

import type { ApprovalRequest } from "../../src/tools/approval.ts";
import { UiApprovalController } from "../../src/ui/approval-controller.ts";
import { UiStore } from "../../src/ui/state.ts";

describe("UiApprovalController", () => {
  test("publishes one request at a time and resolves concurrent requests FIFO", async () => {
    const store = new UiStore("fixture");
    const controller = new UiApprovalController(store);
    const shown: string[] = [];
    const unsubscribe = store.subscribe((snapshot) => {
      const summary = snapshot.approval?.summary;
      if (summary && shown.at(-1) !== summary) shown.push(summary);
    });

    const first = controller.requestApproval(request("first"));
    const second = controller.requestApproval(request("second"));
    const third = controller.requestApproval(request("third"));

    expect(store.snapshot.approval?.summary).toBe("first");
    expect(store.decideApproval("approve_once")).toBe(true);
    expect(await first).toBe("approve_once");
    expect(store.snapshot.approval?.summary).toBe("second");
    expect(store.decideApproval("approve_session")).toBe(true);
    expect(await second).toBe("approve_session");
    expect(store.snapshot.approval?.summary).toBe("third");
    expect(store.decideApproval("deny")).toBe(true);
    expect(await third).toBe("deny");
    expect(shown).toEqual(["first", "second", "third"]);
    expect(store.snapshot.approval).toBeUndefined();

    unsubscribe();
    controller.dispose();
  });

  test("denies aborted active and queued requests without disturbing FIFO order", async () => {
    const store = new UiStore("fixture");
    const controller = new UiApprovalController(store);
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();

    const active = controller.requestApproval(request("active"), activeAbort.signal);
    const queued = controller.requestApproval(request("queued"), queuedAbort.signal);
    const last = controller.requestApproval(request("last"));

    queuedAbort.abort();
    expect(await queued).toBe("deny");
    expect(store.snapshot.approval?.summary).toBe("active");

    activeAbort.abort();
    expect(await active).toBe("deny");
    expect(store.snapshot.approval?.summary).toBe("last");

    store.decideApproval("approve_once");
    expect(await last).toBe("approve_once");
    controller.dispose();
  });

  test("denies every unresolved request during teardown", async () => {
    const store = new UiStore("fixture");
    const controller = new UiApprovalController(store);
    const active = controller.requestApproval(request("active"));
    const queued = controller.requestApproval(request("queued"));

    controller.dispose();

    expect(await Promise.all([active, queued])).toEqual(["deny", "deny"]);
    expect(store.snapshot.approval).toBeUndefined();
    expect(await controller.requestApproval(request("late"))).toBe("deny");
    expect(store.decideApproval("approve_once")).toBe(false);
  });

  test("keeps only serializable approval data in the snapshot", () => {
    const store = new UiStore("fixture");
    const controller = new UiApprovalController(store);
    void controller.requestApproval(request("serializable"));

    const serialized = JSON.parse(JSON.stringify(store.snapshot)) as unknown;
    expect(serialized).toBeObject();
    expect(JSON.stringify(store.snapshot)).toContain("serializable");
    expect(JSON.stringify(store.snapshot)).not.toContain("resolve");

    controller.dispose();
  });
});

function request(summary: string): ApprovalRequest {
  return {
    toolName: "bash",
    summary,
    command: "git status --short",
    targetPaths: [],
    riskDescription: "Runs a shell command.",
    equivalenceKey: `bash:${summary}`,
  };
}
