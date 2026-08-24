import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../src/core/agent-loop.ts";
import type { JsonValue } from "../../src/core/messages.ts";
import { FakeProvider } from "../../src/providers/fake-provider.ts";
import { AdvisorRuntime } from "../../src/runtime/advisor-runtime.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const emptySchema = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

describe("advisor delivery", () => {
  test("folds concerns raised during a tool at the next step boundary", async () => {
    let toolCompleted = false;
    const tools = new ToolRegistry().register({
      name: "slow_read",
      description: "read slowly",
      inputSchema: emptySchema,
      readOnly: true,
      parallelSafe: true,
      async execute() {
        await Bun.sleep(10);
        toolCompleted = true;
        return { content: "observed" };
      },
    });
    const provider = new FakeProvider([
      { toolCalls: [{ id: "read-1", name: "slow_read" }] },
      { text: "corrected after advice" },
    ]);
    const loop = new AgentLoop({ provider, model: "fake/primary", tools });
    loop.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        loop.deliverAdvice("Check the parsed result before continuing.", "concern");
      }
    });

    await loop.submit("inspect");

    expect(toolCompleted).toBe(true);
    expect(loop.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(loop.messages[3]).toMatchObject({
      role: "user",
      internal: "advisor",
      advisor: {
        severity: "concern",
        note: "Check the parsed result before continuing.",
      },
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ internal: "advisor" });
  });

  test("runs an isolated reviewer and exposes only advise tool output to the primary", async () => {
    const primary = new AgentLoop({
      provider: new FakeProvider([{ text: "implementation complete" }]),
      model: "fake/primary",
    });
    const advisorProvider = new FakeProvider([
      {
        toolCalls: [
          {
            id: "advise-1",
            name: "advise",
            arguments: {
              note: "The completion skipped the requested verification.",
              severity: "concern",
            },
          },
        ],
      },
    ]);
    const advisorTools = new ToolRegistry().register<JsonValue>({
      name: "inspect",
      description: "inspect read-only state",
      inputSchema: emptySchema,
      readOnly: true,
      parallelSafe: true,
      execute: () => ({ content: "ok" }),
    });
    const advisor = new AdvisorRuntime({
      primary,
      provider: advisorProvider,
      model: "fake/advisor",
      tools: advisorTools,
    });

    await primary.submit("implement it");
    await advisor.waitForIdle();

    expect(advisorProvider.requests).toHaveLength(1);
    expect(advisorProvider.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "inspect",
      "advise",
    ]);
    expect(advisorProvider.requests[0]?.systemPrompt.join("\n")).toContain("read-only reviewer");
    expect(advisorProvider.requests[0]?.messages[0]?.content).toContain("implementation complete");
    expect(primary.messages.at(-1)).toMatchObject({
      role: "user",
      internal: "advisor",
      advisor: {
        severity: "concern",
        note: "The completion skipped the requested verification.",
      },
    });
    advisor.dispose();
  });
  test("defers non-blocking in-progress advice until the step settles", async () => {
    const primaryTools = new ToolRegistry().register({
      name: "inspect",
      description: "inspect",
      inputSchema: emptySchema,
      readOnly: true,
      parallelSafe: true,
      execute: () => ({ content: "state" }),
    });
    const primary = new AgentLoop({
      provider: new FakeProvider([
        { toolCalls: [{ id: "inspect-1", name: "inspect" }] },
        { delayMs: 30, text: "step settled" },
      ]),
      model: "fake/primary",
      tools: primaryTools,
    });
    const advisor = new AdvisorRuntime({
      primary,
      provider: new FakeProvider([
        {
          toolCalls: [
            {
              id: "defer-1",
              name: "advise",
              arguments: { note: "Verify the edge case before handoff.", severity: "concern" },
            },
          ],
        },
        {},
      ]),
      model: "fake/advisor",
    });

    await primary.submit("work");
    await advisor.waitForIdle();

    expect(primary.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "step settled",
    });
    expect(primary.messages.at(-1)).toMatchObject({
      role: "user",
      internal: "advisor",
      advisor: { note: "Verify the edge case before handoff.", severity: "concern" },
    });
    advisor.dispose();
  });

  test("lets blockers interrupt a live model response and start a corrective turn", async () => {
    const provider = new FakeProvider([
      { delayMs: 50, text: "stale response" },
      { text: "reconsidered" },
    ]);
    const loop = new AgentLoop({ provider, model: "fake/primary" });

    const run = loop.submit("start");
    setTimeout(
      () => loop.deliverAdvice("This path contradicts the required contract.", "blocker"),
      5,
    );
    await run;
    await loop.waitForIdle();

    expect(provider.requestCount).toBe(2);
    expect(loop.messages).toHaveLength(3);
    expect(loop.messages[1]).toMatchObject({
      role: "user",
      internal: "advisor",
      advisor: { severity: "blocker" },
    });
    expect(loop.messages[2]).toMatchObject({ role: "assistant", content: "reconsidered" });
  });
});
