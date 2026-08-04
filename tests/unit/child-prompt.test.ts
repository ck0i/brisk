import { describe, expect, test } from "bun:test";

import { buildChildRolePrompt } from "../../src/subagents/child-prompt.ts";

describe("child role prompt", () => {
  test("distinguishes inherited root requests from the direct child assignment", () => {
    const prompt = buildChildRolePrompt({ depth: 1, maxDepth: 1, mode: "research" });

    expect(prompt).toContain("You are a child agent");
    expect(prompt).toContain("Earlier conversation messages are an inherited parent checkpoint");
    expect(prompt).toContain("that delegation has already happened");
    expect(prompt).toContain("you are that successfully spawned subagent");
    expect(prompt).toContain("research mode");
  });

  test("describes nested delegation and isolated patch semantics when available", () => {
    const prompt = buildChildRolePrompt({ depth: 1, maxDepth: 2, mode: "patch" });

    expect(prompt).toContain("task tool is available");
    expect(prompt).toContain("genuinely independent nested work");
    expect(prompt).toContain("isolated in an overlay");
  });
});
