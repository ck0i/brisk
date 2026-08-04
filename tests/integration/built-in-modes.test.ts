import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { BtwRuntime } from "../../src/runtime/btw-runtime.ts";
import { GoalRuntime } from "../../src/runtime/goal-runtime.ts";
import { LoopRuntime } from "../../src/runtime/loop-runtime.ts";
import { SessionRuntime } from "../../src/runtime/session-runtime.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { UiStore } from "../../src/ui/state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("first-class modes", () => {
  test("/loop repeats the captured prompt the requested total number of times", async () => {
    const provider = new FakeProvider([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const loop = new AgentLoop({ provider, model: "fake/model" });
    const notices: string[] = [];
    let status: string | undefined;
    const mode = new LoopRuntime({
      notify: (message) => notices.push(message),
      setStatus: (value) => {
        status = value;
      },
    });
    mode.attach(loop, async (prompt) => await loop.submit(prompt));

    mode.execute("3", true);
    mode.capturePrompt("repeat this exactly");
    await loop.submit("repeat this exactly");
    await waitFor(() => notices.some((message) => message === "Loop complete after 3 runs."));

    expect(provider.requests.map((request) => request.messages.at(-1)?.content)).toEqual([
      "repeat this exactly",
      "repeat this exactly",
      "repeat this exactly",
    ]);
    expect(status).toBeUndefined();
    mode.detach();
  });

  test("/goal persists its exact objective and pauses at the continuation limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-goal-mode-"));
    roots.push(root);
    const session = await SessionRuntime.initialize({
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
      selectedProvider: "fake",
      selectedModel: "model",
    });
    const provider = new FakeProvider([{ text: "kickoff" }, { text: "continuation" }]);
    const tools = new ToolRegistry();
    const notices: string[] = [];
    let status: string | undefined;
    const goal = new GoalRuntime({
      session,
      configuredMaxTurns: () => 1,
      notify: (message) => notices.push(message),
      setStatus: (value) => {
        status = value;
      },
    });
    tools.register(goal.tool);
    const loop = new AgentLoop({
      provider,
      tools,
      model: "fake/model",
      dynamicSystemPrompt: () => goal.dynamicSystemPrompt(),
      contextFilter: (messages) => goal.filterContext(messages),
      stopWhen: () => goal.consumeStopRequested(),
    });
    session.attach(loop);
    goal.attach(loop, async (prompt) => await loop.submitInternal(prompt, "goal-control"));

    const objective = "Implement every item, including  double spaces.";
    await goal.execute(objective);
    await waitFor(() => notices.some((message) => message.includes("1-turn continuation limit")));

    expect(goal.objective).toBe(objective);
    expect(status).toBe("goal paused");
    expect(notices.some((message) => message.includes("1-turn continuation limit"))).toBe(true);
    expect(provider.requests[0]?.systemPrompt.join("\n")).toContain(JSON.stringify(objective));
    expect(
      loop.messages.filter((message) => message.role === "user" && message.internal).length,
    ).toBe(2);
    expect(
      goal
        .filterContext(loop.messages)
        .filter((message) => message.role === "user" && message.internal).length,
    ).toBe(0);
    const latestState = [...session.current.entries]
      .reverse()
      .find((entry) => entry.type === "mode_state" && entry.key === "goal");
    expect(latestState?.type === "mode_state" ? latestState.value : undefined).toMatchObject({
      objective,
      status: "paused",
      continuationTurns: 1,
      pauseReason: "limit",
    });

    goal.detachAgent();
    await session.close();
    const resumed = await SessionRuntime.initialize({
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
      continueLast: true,
    });
    const restored = new GoalRuntime({
      session: resumed,
      configuredMaxTurns: () => undefined,
      notify: () => undefined,
      setStatus: () => undefined,
    });
    restored.restore();
    expect(restored.objective).toBe(objective);
    expect(restored.status).toBe("paused");
    await resumed.close();
  });

  test("the goal tool completes the objective and terminates the current tool chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "brisk-goal-complete-"));
    roots.push(root);
    const session = await SessionRuntime.initialize({
      sessionsDir: join(root, "sessions"),
      sessionIndexPath: join(root, "index.json"),
      artifactsDir: join(root, "artifacts"),
      workspace: root,
      selectedProvider: "fake",
      selectedModel: "model",
    });
    const provider = new FakeProvider([
      {
        toolCalls: [
          {
            id: "complete-goal",
            name: "goal",
            argumentChunks: ['{"op":"complete"}'],
          },
        ],
      },
    ]);
    const tools = new ToolRegistry();
    const notices: string[] = [];
    const goal = new GoalRuntime({
      session,
      configuredMaxTurns: () => undefined,
      notify: (message) => notices.push(message),
      setStatus: () => undefined,
    });
    tools.register(goal.tool);
    const loop = new AgentLoop({
      provider,
      tools,
      model: "fake/model",
      dynamicSystemPrompt: () => goal.dynamicSystemPrompt(),
      contextFilter: (messages) => goal.filterContext(messages),
      stopWhen: () => goal.consumeStopRequested(),
    });
    session.attach(loop);
    goal.attach(loop, async (prompt) => await loop.submitInternal(prompt, "goal-control"));

    await goal.execute("Finish the verified task");
    await waitFor(
      () => !loop.active && notices.includes("Goal completed. Automatic continuation stopped."),
    );

    expect(goal.objective).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
    expect(loop.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "goal",
      content: "Goal marked complete. Automatic continuation is stopped.",
    });
    const latestState = [...session.current.entries]
      .reverse()
      .find((entry) => entry.type === "mode_state" && entry.key === "goal");
    expect(latestState?.type === "mode_state" ? latestState.value : undefined).toMatchObject({
      status: "completed",
      reason: "model",
    });

    goal.detachAgent();
    await session.close();
  });

  test("/btw keeps a follow-up side thread out of the main conversation", async () => {
    const store = new UiStore("/workspace");
    const mainMessages = [
      { role: "user" as const, content: "main question" },
      { role: "assistant" as const, content: "main answer", toolCalls: [] },
    ];
    const provider = new FakeProvider([{ text: "side answer" }, { text: "follow-up answer" }]);
    const btw = new BtwRuntime({
      store,
      createProvider: () => ({ provider, model: "fake/model", label: "fake/model · off" }),
      createTools: async () => new ToolRegistry(),
      createContext: async () => mainMessages,
      getMainMessages: () => mainMessages,
      getLiveStatus: () => "Main agent state: running.",
      additionalSystemPrompt: () => ["workspace instructions"],
    });

    expect(await btw.start("what is happening?")).toBe(true);
    await waitFor(() => store.snapshot.btw?.busy === false);
    expect(store.snapshot.btw?.messages.map((message) => message.content)).toEqual([
      "what is happening?",
      "side answer",
    ]);
    expect(mainMessages).toHaveLength(2);

    expect(store.decideBtw({ type: "ask", question: "and now?" })).toBe(true);
    await waitFor(() => store.snapshot.btw?.busy === false);
    expect(store.snapshot.btw?.messages.at(-1)?.content).toBe("follow-up answer");
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("<side_question>\nand now?");

    expect(store.decideBtw({ type: "close" })).toBe(true);
    await waitFor(() => store.snapshot.btw === undefined);
    await btw.dispose();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for mode state");
    await Bun.sleep(5);
  }
}
